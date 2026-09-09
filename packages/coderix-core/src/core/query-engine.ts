/**
 * QueryEngine — Session lifecycle manager
 *
 * Consumes the query() AsyncGenerator, manages session state,
 * and provides the main entry point for user interaction.
 *
 * Adapted from Coderix for ink-chat-tui.
 */

import type {
  Session,
  AssistantMessage,
  Message,
  UserMessage,
  QueryMessage,
  StreamEvent,
  DeferredPermission,
  ContentBlock,
} from './types.js';
import type { DeferredQuestion } from './types.js';
import { PermissionMode, AgentError } from './types.js';
import { query, runCompaction, type QueryConfig, type CallModelParams } from './query.js';
import { ToolRegistry } from './tool-registry.js';
import { PermissionEngine, extractRuleContent } from './permission.js';
import type { PermissionRule, PermissionRuleSource } from './permission-rules.js';
import { SystemPromptAssembler, type SystemPrompt } from './system-prompt.js';
import { SessionManager } from './session.js';
import { CheckpointManager } from './checkpoint.js';
import type { HookManager } from '../hooks/index.js';
import type { SubAgentRegistry } from './subagent-registry.js';
import type { AgentRegistry } from './agent-registry.js';
import { getTeamLeaderStaticDeclaration, getTeamStatusBlock } from '../teams/team-prompt.js';
import { drainUnreadMessages } from '../teams/team-mailbox.js';
import { execute as executeSendMessage } from '../teams/tools/team-message/executor.js';
import { filterToolsForResumedAgent, GLOBAL_DISALLOWED_FOR_SUBAGENTS } from '../agents/tool-filtering.js';
import {
  findAgentOnDisk,
  saveAgentTranscript,
  writeAgentMetadata,
} from '../agents/agent-persistence.js';
import { sessionDir as getSessionDir, sessionJsonlPath } from './session-store.js';
import type { CoderSettings, ModelItem, ModelEntry } from '../config.js';
import { loadSettings, saveSettings } from '../config.js';
import type { ToolResult } from '../tools/types.js';
import type { EventBus } from '../state/observable.js';
import type { CoreState } from '../state/core-state.js';
import {
  loadMemoryConfig,
} from '../memory/config.js';
import { truncateToTokenLimit, countTokens } from './token-counter.js';
import { tokenCountWithEstimation } from './token-budget.js';
import type { MemoryConfig } from '../memory/types.js';
import {
  executeExtractMemories,
  initExtractMemories as initMemoryExtraction,
  drainPendingExtraction as drainMemoryExtraction,
} from '../memory/extract-memories.js';
import {
  findRelevantMemories,
  formatRecalledMemories,
  RelevanceCache,
} from '../memory/recall.js';
import { ReadFileTracker } from './read-file-tracker.js';
import { MessageQueue } from './message-queue.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryEngineConfig {
  cwd: string;
  toolRegistry: ToolRegistry;
  sessionManager: SessionManager;
  maxTurns?: number;
  maxBudgetUsd?: number;
  contextBudget?: number;
  /** User-configured max context window (effective budget). Takes priority over model-derived budget. */
  maxContext?: number;
  compactThreshold?: number;
  customSystemPrompt?: string;
  appendSystemPrompt?: string;
  model?: string;
  /** Max concurrent tool executions (default: 32). */
  maxToolConcurrency?: number;
  callModel: (params: CallModelParams) => AsyncGenerator<StreamEvent | AssistantMessage>;
  /** Optional HookManager for lifecycle hook execution */
  hookManager?: HookManager;
  /** SubAgentRegistry for tracking spawned sub-agents */
  subAgentRegistry?: SubAgentRegistry;
  /** SystemPromptAssembler for assembling worker prompts */
  systemPromptAssembler?: SystemPromptAssembler;
  /** AgentRegistry for agent type definitions */
  agentRegistry?: AgentRegistry;
  /** CoderSettings for engine configuration */
  settings?: CoderSettings;
  /** Active team name (when running in a team) */
  teamName?: string;
  /** EventBus for decoupled frontend communication.
   *  Engine events are emitted to both AsyncGenerator AND
   *  eventBus.engineEvents Observable. */
  eventBus?: EventBus;
  /** Enable brief/concise mode to reduce response verbosity. */
  briefMode?: boolean;
  /** Enable automatic context compaction. When false, only manual /compact works. */
  autoCompactEnabled?: boolean;
}

export interface QueryEngineEvent {
  type: 'message' | 'error' | 'cost' | 'compact' | 'compact_boundary' | 'compact_summary' | 'compact_progress' | 'done' | 'permission_required' | 'question_required' | 'queued';
  data?: unknown;
  deferred?: DeferredPermission | DeferredQuestion;
}

// ---------------------------------------------------------------------------
// QueryEngine
// ---------------------------------------------------------------------------

export class QueryEngine {
  private config: QueryEngineConfig;
  private permissionEngine: PermissionEngine;
  private abortController: AbortController | null = null;
  private checkpointManager: CheckpointManager;
  private systemPrompt: SystemPrompt | null = null;
  private memoryConfig: MemoryConfig;
  private relevanceCache = new RelevanceCache();
  private readFileTracker = new ReadFileTracker();
  private isActive = false;
  private messageQueue = new MessageQueue();
  private runningToolCount = 0;

  constructor(config: QueryEngineConfig) {
    this.config = {
      maxTurns: 500,
      contextBudget: 180_000,
      compactThreshold: 0.85,
      model: 'deepseek-v4-pro',
      ...config,
    };

    // Derive contextBudget from the model's actual context window
    // when no explicit budget was set.  Falls back to the hardcoded
    // 180_000 default when model_list has no max_context info.
    if (
      config.contextBudget === undefined &&
      config.settings?.model_list &&
      config.model
    ) {
      const budget = resolveModelMaxContext(
        config.model,
        config.settings.model_list,
      );
      if (budget) {
        this.config.contextBudget = budget;
      }
    }

    // If a user-configured maxContext is set, use it as the context budget
    // (it represents the effective context window the model actually uses).
    if (config.maxContext && config.maxContext > 0) {
      this.config.contextBudget = config.maxContext;
    }

    // Load permission rules from settings
    const permissionRules: PermissionRule[] = (config.settings?.permissions?.allow ?? [])
      .map((entry) => ({
        toolName: entry.toolName,
        ruleContent: entry.ruleContent,
        behavior: entry.behavior,
        source: 'userSettings' as PermissionRuleSource,
        description: entry.description,
      }));

    this.permissionEngine = new PermissionEngine(config.cwd, permissionRules);
    this.checkpointManager = new CheckpointManager();
    this.memoryConfig = loadMemoryConfig(config.settings?.memory);
    initMemoryExtraction();
  }

  async init(): Promise<void> {
    const assembler = this.config.systemPromptAssembler ?? new SystemPromptAssembler();

    // If teams exist on disk, inject static team declarations into system prompt.
    // Dynamic worker list is injected per-turn in submitMessage() to stay cache-friendly.
    let appendPrompt = this.config.appendSystemPrompt;
    const activeSessionId = this.config.sessionManager.getActive()?.id;
    if (activeSessionId) {
      const sd = getSessionDir(activeSessionId);
      const { listTeams, loadTeamConfig } = await import('../teams/team-store.js');
      const activeTeams = this.config.teamName
        ? [this.config.teamName]
        : await listTeams(sd).catch(() => []);
      for (const teamName of activeTeams) {
        const teamConfig = await loadTeamConfig(sd, teamName);
        if (teamConfig) {
          const staticDecl = getTeamLeaderStaticDeclaration(teamName, teamConfig.description);
          appendPrompt = appendPrompt ? `${appendPrompt}\n\n${staticDecl}` : staticDecl;
        }
      }
    }

    this.systemPrompt = await assembler.assemble({
      cwd: this.config.cwd,
      permissionMode: this.permissionEngine.getMode(),
      customPrompt: this.config.customSystemPrompt,
      appendPrompt,
      model: this.config.model,
      memorySettings: this.config.settings?.memory,
      briefMode: this.config.briefMode ?? false,
      agentRegistry: this.config.agentRegistry,
    });

    // Persist system prompt to session directory for debugging / auditing
    this.config.sessionManager.writeSystemPrompt(this.systemPrompt.prompt);

    // Setup hook (non-blockable, fires on first init)
    if (this.config.hookManager) {
      const session = this.config.sessionManager.getActive();
      if (session && session.messages.length === 0) {
        this.config.hookManager.onSetup(
          session.id,
          this.config.cwd,
          true,
          this.config.model,
          undefined,
        ).catch(() => {});
      }
    }
  }

  /**
   * Toggle brief mode on/off at runtime. Forces system prompt rebuild
   * so the directive is injected (or removed) on the next turn.
   */
  setBriefMode(enabled: boolean): void {
    if (this.config.briefMode === enabled) return;
    this.config.briefMode = enabled;
    this.systemPrompt = null; // force reassembly on next submitMessage
  }

  /**
   * Clear transient caches after compaction. Prevents stale state
   * from polluting new conversation turns.
   */
  clearCaches(): void {
    this.relevanceCache.clear();
    this.readFileTracker.clear();
  }

  async *submitMessage(userInput: string): AsyncGenerator<QueryEngineEvent> {
    const eventBus = this.config.eventBus;

    const emitEarly = (event: QueryEngineEvent): void => {
      if (eventBus) {
        try { eventBus.engineEvents.next(event); } catch { /* best-effort */ }
      }
    };

    // Decision tree: if already active, enqueue or abort based on running tools
    if (this.isActive) {
      const hasBlocking = this.hasBlockingToolsRunning();
      if (hasBlocking) {
        this.messageQueue.enqueue(userInput);
        const event: QueryEngineEvent = {
          type: 'queued',
          data: { position: this.messageQueue.length },
        };
        emitEarly(event);
        yield event;
        return;
      }
      // All running tools are cancel-safe — abort and proceed
      if (this.abortController) {
        this.abortController.abort();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    this.isActive = true;

    const session = this.config.sessionManager.getActive();
    this.abortController = new AbortController();

    // Handle orphaned tool_use blocks from prior interrupted turn
    const lastMsg = session.messages.length > 0
      ? session.messages[session.messages.length - 1]
      : null;
    const MISSING_RESULT_PROMPT =
      'A new user message arrived while tools were executing. ' +
      'The pending tool use results are unavailable.';

    if (lastMsg && lastMsg.role === 'assistant' && Array.isArray(lastMsg.content)) {
      const toolUseBlocks = lastMsg.content.filter((b) => b.type === 'tool_use');
      if (toolUseBlocks.length > 0) {
        const errorResults: ContentBlock[] = toolUseBlocks.map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.id!,
          content: MISSING_RESULT_PROMPT,
          is_error: true,
        }));
        this.config.sessionManager.addMessage({
          role: 'user',
          content: errorResults,
        });
      }
    }

    // === UserPromptSubmit hook (blockable) ===
    let effectiveInput = userInput;
    if (this.config.hookManager) {
      const result = await this.config.hookManager.onUserPromptSubmit(
        session.id,
        this.config.cwd,
        userInput,
        { model: this.config.model, provider: undefined },
      );
      if (result.blocked) {
        const event: QueryEngineEvent = {
          type: 'error',
          data: new AgentError(
            result.blockReason ?? 'Prompt blocked by UserPromptSubmit hook',
            'HOOK_BLOCKED',
          ),
        };
        emitEarly(event);
        yield event;
        return;
      }
      if (result.augmentedPrompt) {
        effectiveInput = result.augmentedPrompt;
      }

      // UserPromptExpansion hook (blockable)
      const expansionResult = await this.config.hookManager.onUserPromptExpansion(
        session.id,
        this.config.cwd,
        userInput,
        effectiveInput,
      );
      if (expansionResult.blocked) {
        const event: QueryEngineEvent = {
          type: 'error',
          data: new AgentError(
            expansionResult.blockReason ?? 'Prompt blocked by UserPromptExpansion hook',
            'HOOK_BLOCKED',
          ),
        };
        emitEarly(event);
        yield event;
        return;
      }
      if (expansionResult.expandedPromptOverride) {
        effectiveInput = expansionResult.expandedPromptOverride;
      }
    }

    const userMessage: UserMessage = { role: 'user', content: effectiveInput };

    // Inject completed background agent results as system context
    if (this.config.subAgentRegistry) {
      const notifications = this.config.subAgentRegistry.drainNotifications();
      if (notifications.length > 0) {
        const contextBlock: ContentBlock = {
          type: 'text',
          text: '<background-agent-notifications>\n' + notifications.join('\n\n') + '\n</background-agent-notifications>',
        };
        this.config.sessionManager.addMessage({
          role: 'user',
          content: [contextBlock],
        });
      }
    }

    // Drain team messages (inject unread messages as context).
    // Always attempt — listTeams is a cheap readdir when no teams exist.
    if (this.config.settings) {
      const activeSessionId = this.config.sessionManager.getActive()?.id;
      if (activeSessionId) {
        const sd = getSessionDir(activeSessionId);
        const { listTeams } = await import('../teams/team-store.js');
        const activeTeams = this.config.teamName
          ? [this.config.teamName]
          : await listTeams(sd).catch(() => []);
        const leaderName = 'leader';

        for (const teamName of activeTeams) {
          const teamMsgs = await drainUnreadMessages(sd, teamName, leaderName);
          if (teamMsgs.length > 0) {
            const msgsText = teamMsgs.map(m =>
              `[${m.from} → ${m.to}]: ${m.text}`
            ).join('\n');
            const contextBlock: ContentBlock = {
              type: 'text',
              text: '[Team messages]\n' + msgsText,
            };
            this.config.sessionManager.addMessage({
              role: 'user',
              content: [contextBlock],
            });
          }

          // Inject dynamic team status (worker list with statuses) at conversation tail.
          // This stays cache-friendly because it's always the newest user message.
          const statusBlock = await getTeamStatusBlock(sd, teamName);
          if (statusBlock) {
            this.config.sessionManager.addMessage({
              role: 'user',
              content: [{ type: 'text', text: '[Team status]\n' + statusBlock }],
            });
          }
        }
      }
    }

    this.config.sessionManager.addMessage(userMessage);

    // Memory recall: search for relevant memories and inject as system context
    if (this.memoryConfig.enabled && this.memoryConfig.recallEnabled) {
      const ac = new AbortController();
      try {
        const recalled = await findRelevantMemories(
          effectiveInput,
          this.config.cwd,
          this.memoryConfig,
          this.relevanceCache.getSurfaced(),
          ac.signal,
        );
        if (recalled.length > 0) {
          const contextText = formatRecalledMemories(recalled);
          const contextBlock: ContentBlock = {
            type: 'text',
            text: contextText,
          };
          this.config.sessionManager.addMessage({
            role: 'user',
            content: [contextBlock],
          });
          this.relevanceCache.markSurfaced(recalled.map(r => r.path));
        }
      } catch {
        // Recall is best-effort — don't break the query on errors
      }
    }

    if (!this.systemPrompt) {
      await this.init();
    }

    const getCoreState = (): CoreState => ({
      sessionId: session.id,
      permissionMode: this.permissionEngine.getMode() as 'plan' | 'ask' | 'auto',
      model: this.config.model ?? 'unknown',
      config: {
        cwd: this.config.cwd,
        model: this.config.model ?? 'unknown',
        baseUrl: '',
        apiKey: '',
        inputPrice: 0,
        outputPrice: 0,
        cacheReadPrice: 0,
        maxContext: this.config.contextBudget ?? 180_000,
        briefMode: this.config.briefMode ?? false,
        autoCompactEnabled: this.config.autoCompactEnabled ?? true,
        compactThreshold: this.config.compactThreshold ?? 0.85,
      },
    });

    // Trim session.messages to prevent unbounded growth.
    // The query loop compacts its local copy independently, so the session
    // only needs to retain enough messages to reconstruct context on resume.
    const trimBudget = Math.floor((this.config.contextBudget ?? 180_000) / 2);
    this.config.sessionManager.trimMessages(trimBudget);
    // Resolve autoCompactEnabled: config key + env var override
    const autoCompactEnabled = (() => {
      if (process.env.DISABLE_COMPACT || process.env.DISABLE_AUTO_COMPACT) {
        return false;
      }
      return this.config.autoCompactEnabled ?? true;
    })();

    // Resolve compactThreshold: env var > settings > default (0.85)
    const resolvedCompactThreshold = (() => {
      const envOverride = process.env.CODERRX_AUTOCOMPACT_PCT_OVERRIDE;
      if (envOverride) {
        const pct = parseFloat(envOverride);
        if (!isNaN(pct) && pct > 0 && pct <= 100) {
          return pct / 100;
        }
      }
      return this.config.compactThreshold!;
    })();

    const queryConfig: QueryConfig = {
      sessionId: session.id,
      cwd: this.config.cwd,
      messages: session.messages,
      systemPrompt: this.systemPrompt!,
      toolRegistry: this.config.toolRegistry,
      permissionEngine: this.permissionEngine,
      sessionManager: this.config.sessionManager,
      checkpointManager: this.checkpointManager,
      abortController: this.abortController,
      maxTurns: this.config.maxTurns!,
      maxBudgetUsd: this.config.maxBudgetUsd,
      contextBudget: this.config.contextBudget!,
      compactThreshold: resolvedCompactThreshold,
      autoCompactEnabled,
      maxToolConcurrency: this.config.maxToolConcurrency,
      callModel: this.config.callModel,
      hookManager: this.config.hookManager,
      subAgentRegistry: this.config.subAgentRegistry,
      systemPromptAssembler: this.config.systemPromptAssembler,
      agentRegistry: this.config.agentRegistry,
      getCoreState,
      emitToolRequest: eventBus
        ? (req) => eventBus.toolRequests.next(req)
        : undefined,
      onToolQueueChange: (count) => { this.runningToolCount = count; },
    };

    // Dual-write helper: yields the event AND emits to EventBus (if configured)
    const emit = (event: QueryEngineEvent): void => {
      if (eventBus) {
        try { eventBus.engineEvents.next(event); } catch { /* best-effort */ }
      }
    };

    try {
      for await (const msg of query(queryConfig)) {
        switch (msg.type) {
          case 'stream_event': {
            const event = { type: 'message' as const, data: msg };
            emit(event);
            yield event;
            break;
          }
          case 'assistant': {
            this.config.sessionManager.addMessage(msg.message);
            const event = { type: 'message' as const, data: msg };
            emit(event);
            yield event;
            break;
          }
          case 'user': {
            this.config.sessionManager.addMessage(msg.message);
            const event = { type: 'message' as const, data: msg };
            emit(event);
            yield event;
            break;
          }
          case 'system':
            if (msg.subtype === 'compact_boundary') {
              const event = { type: 'compact' as const, data: msg.compactMetadata };
              emit(event);
              yield event;
            } else if (msg.subtype === 'compact_progress') {
              const event = { type: 'compact_progress' as const, data: msg.data };
              emit(event);
              yield event;
            } else if (msg.subtype === 'error') {
              const event = { type: 'error' as const, data: msg.error };
              emit(event);
              yield event;
            } else if (msg.subtype === 'progress' || msg.subtype === 'tool_completed') {
              const event = { type: 'message' as const, data: msg };
              emit(event);
              yield event;
            } else if (msg.subtype === 'permission_required') {
              const event = { type: 'permission_required' as const, data: msg.deferred, deferred: msg.deferred };
              emit(event);
              yield event;
            } else if (msg.subtype === 'question_required') {
              const event = { type: 'question_required' as const, data: msg.deferred, deferred: msg.deferred };
              emit(event);
              yield event;
            }
            break;
        }
      }
      const doneEvent: QueryEngineEvent = { type: 'done', data: { sessionId: session.id } };
      emit(doneEvent);
      yield doneEvent;

      // Memory extraction: fire-and-forget background extraction
      if (this.memoryConfig.enabled && this.memoryConfig.autoExtract) {
        executeExtractMemories(
          session.messages,
          this.config.cwd,
          this.memoryConfig,
          null, // callModel — wired in Phase 5 (integration)
        );
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const errorEvent: QueryEngineEvent = { type: 'error', data: { message: errMsg } };
      emit(errorEvent);
      yield errorEvent;
      throw error;
    } finally {
      this.isActive = false;
      this.config.sessionManager.saveSession(session);
      this.messageQueue.drainNext();
    }
  }

  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Run context compaction immediately without adding a user message.
   * Yields compact-boundary events through the AsyncGenerator for
   * direct consumption by the TUI bridge.
   *
   * Sets runningToolCount=1 to block concurrent submitMessage calls
   * while compaction is in progress (they will be enqueued).
   *
   * Used by the /compact slash command for on-demand compaction.
   */
  async *compact(): AsyncGenerator<QueryEngineEvent> {
    const session = this.config.sessionManager.getActive();
    if (!session || session.messages.length === 0) {
      yield { type: 'error', data: { message: 'No active session or session has no messages to compact.' } };
      return;
    }

    if (!this.systemPrompt) {
      await this.init();
    }

    if (this.isActive) {
      // Interrupt any active turn so we can compact cleanly
      this.interrupt();
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Block new submissions while compaction runs
    this.isActive = true;
    this.runningToolCount = 1;

    // Trim session messages before compacting (same as submitMessage)
    const trimBudget = this.config.contextBudget ?? 180_000;
    this.config.sessionManager.trimMessages(trimBudget);

    const messages = [...session.messages];
    const currentTokens = tokenCountWithEstimation(messages);

    // Pre-compute the transcript archive path for the compact summary
    const sessionDir = getSessionDir(session.id);
    const transcriptPath = `${sessionDir}/history_transcript/transcript-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;

    const abortController = new AbortController();

    try {
      const gen = runCompaction(
        messages,
        currentTokens,
        this.config.contextBudget!,
        {
          sessionId: session.id,
          cwd: this.config.cwd,
          hookManager: this.config.hookManager,
          callModel: this.config.callModel,
          systemPrompt: this.systemPrompt!,
          permissionMode: this.permissionEngine.getMode(),
          planModeState: null,
          readFileTracker: this.readFileTracker,
          clearCaches: () => this.clearCaches(),
          transcriptPath,
        },
        abortController.signal,
        { count: 0 },
        'manual',
      );

      let compactMeta: { beforeTokens: number; afterTokens: number; strategy: string; summaryText?: string } | null = null;

      let result = await gen.next();
      while (!result.done) {
        const msg = result.value;
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          compactMeta = msg.compactMetadata as { beforeTokens: number; afterTokens: number; strategy: string; summaryText?: string };
          yield { type: 'compact_boundary', data: compactMeta };
        } else if (msg.type === 'system' && msg.subtype === 'compact_progress') {
          yield { type: 'compact_progress', data: msg.data };
        } else if (msg.type === 'system' && msg.subtype === 'error') {
          yield { type: 'error', data: { message: msg.error.message } };
        } else if (msg.type === 'user') {
          this.config.sessionManager.addMessage(msg.message);
        } else if (msg.type === 'assistant') {
          this.config.sessionManager.addMessage(msg.message);
        }
        result = await gen.next();
      }

      // The return value is the compacted messages array
      const compactedMessages: Message[] = result.value;
      // Replace session messages with compacted result
      this.config.sessionManager.replaceMessages(compactedMessages);

      if (compactMeta?.summaryText) {
        yield { type: 'compact_summary', data: { content: compactMeta.summaryText } };
      }

      this.clearCaches();
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      yield { type: 'error', data: { message: `Compaction failed: ${errMsg}` } };
    } finally {
      this.runningToolCount = 0;
      this.isActive = false;
      this.config.sessionManager.saveSession(session);
      // Drain any messages queued during compaction
      this.messageQueue.drainNext();
    }
  }

  /** Subscribe to queue drain events. Returns unsubscribe function.
   *  When a queued message is ready to process (current turn completed),
   *  the callback is invoked with the message text. */
  onQueueDrain(callback: (message: string) => void): () => void {
    return this.messageQueue.onDrain(callback);
  }

  /** Check whether any running tool has interruptBehavior: 'block'.
   *  If tools are running but we don't know which, be conservative and block. */
  private hasBlockingToolsRunning(): boolean {
    return this.runningToolCount > 0;
  }

  /** Send a follow-up message to a completed/stopped sub-agent, resuming its execution. */
  async sendSubAgentMessage(agentId: string, message: string): Promise<ToolResult> {
    const { subAgentRegistry, toolRegistry, sessionManager, callModel, hookManager, systemPromptAssembler, agentRegistry } = this.config;
    if (!subAgentRegistry || !systemPromptAssembler || !agentRegistry) {
      return { content: 'Sub-agent infrastructure not available.', isError: true };
    }

    return executeSendMessage(
      { agent_id: agentId, message },
      {
        sessionId: sessionManager.getActive().id,
        cwd: this.config.cwd,
        allowMutation: true,
        maxOutput: 200_000,
        bashTimeout: 120_000,
        agentSpawn: {
          callModel,
          toolRegistry,
          sessionManager,
          subAgentRegistry,
          hookManager,
          systemPromptAssembler,
          agentRegistry,
        },
      },
    );
  }

  /**
   * Streaming version of sendSubAgentMessage.
   * Yields QueryEngineEvents as the sub-agent runs, so the TUI can render
   * messages in real-time. Updates the registry transcript on completion.
   */
  async *sendSubAgentMessageStreaming(
    agentId: string,
    message: string,
  ): AsyncGenerator<QueryEngineEvent> {
    const { subAgentRegistry, toolRegistry, callModel, hookManager, systemPromptAssembler, agentRegistry } = this.config;
    const parentSessionId = this.config.sessionManager.getActive()?.id;
    const parentSessionDir = parentSessionId ? getSessionDir(parentSessionId) : undefined;
    if (!subAgentRegistry || !systemPromptAssembler || !agentRegistry) {
      yield { type: 'error', data: { message: 'Sub-agent infrastructure not available.' } };
      return;
    }

    // ── Resolve agent (with disk fallback) ──────────────────────────
    let agent = subAgentRegistry.get(agentId);
    let diskInfo: Awaited<ReturnType<typeof findAgentOnDisk>> = null;

    if (!agent) {
      if (!parentSessionDir) {
        yield {
          type: 'error',
          data: { message: `Agent '${agentId}' not found in registry and no session directory available for disk fallback.` },
        };
        return;
      }
      diskInfo = await findAgentOnDisk(agentId, parentSessionDir);

      if (!diskInfo) {
        yield {
          type: 'error',
          data: { message: `Agent '${agentId}' not found in registry or on disk.` },
        };
        return;
      }

      const diskAbortController = new AbortController();
      subAgentRegistry.register({
        id: agentId,
        name: diskInfo.teamName
          ? `${diskInfo.meta.agentType}-${agentId}`
          : `${diskInfo.meta.agentType}-${agentId}`,
        agentType: (diskInfo.meta.agentType as any) || 'general-purpose',
        status: 'stopped',
        prompt: diskInfo.meta.description ?? '',
        createdAt: diskInfo.meta.createdAt,
        turnCount: diskInfo.transcript.filter((m: any) => m.role === 'assistant').length,
        messageCount: diskInfo.transcript.length,
        toolCount: 0,
        abortController: diskAbortController,
        notified: true,
        transcript: diskInfo.transcript,
      });

      agent = subAgentRegistry.get(agentId);
      if (!agent) {
        yield { type: 'error', data: { message: `Failed to re-register agent '${agentId}' from disk.` } };
        return;
      }
    }

    if (agent.status === 'running') {
      yield {
        type: 'error',
        data: { message: `Cannot message running agent '${agentId}'. Wait for it to complete.` },
      };
      return;
    }

    const transcript = agent.transcript ?? [];
    const agentType = agent.agentType;
    const agentDef = agentRegistry.get(agentType);

    // ── Build resumed messages ──────────────────────────────────────
    const resumedMessages: any[] = [
      ...trimTranscriptForResume(transcript),
      { role: 'user', content: message },
    ];

    // ── Build sub-agent tooling ─────────────────────────────────────
    const parentDefs = toolRegistry.getDefinitions();
    const filteredDefs = agentDef
      ? filterToolsForResumedAgent(parentDefs, agentDef)
      : parentDefs.filter(t => !GLOBAL_DISALLOWED_FOR_SUBAGENTS.has(t.name));
    const subToolRegistry = new ToolRegistry();
    for (const def of filteredDefs) {
      const registration = toolRegistry.get(def.name);
      if (registration) {
        subToolRegistry.register(def, registration.execute);
      }
    }

    const subPermissionEngine = new PermissionEngine(process.cwd());
    subPermissionEngine.setMode(PermissionMode.AUTO);

    const subSessionManager = new SessionManager(true);
    subSessionManager.create({
      title: `Sub-agent: ${agentType} (resumed)`,
      cwd: process.cwd(),
      parentSessionId: this.config.sessionManager.getActive()?.id,
    });

    const subCheckpointManager = new CheckpointManager();

    // ── Build system prompt ─────────────────────────────────────────
    let systemPromptText: string;
    if (diskInfo?.systemPrompt) {
      systemPromptText = diskInfo.systemPrompt;
    } else if (agentDef) {
      try {
        const workerPrompt = await systemPromptAssembler.assemble({
          cwd: process.cwd(),
          permissionMode: 'auto',
          agentRole: 'worker',
        });
        const envPart = workerPrompt.parts.find(p => p.name === 'env_info');
        const permPart = workerPrompt.parts.find(p => p.name === 'permission_mode');
        const extra = [envPart?.content, permPart?.content].filter(Boolean).join('\n\n');
        systemPromptText = extra
          ? agentDef.getSystemPrompt() + '\n\n' + extra
          : agentDef.getSystemPrompt();
      } catch {
        systemPromptText = agentDef.getSystemPrompt();
      }
    } else {
      systemPromptText = [
        'You are a sub-agent worker spawned by Coderix to complete a specific task.',
        'Complete the task efficiently using the tools available to you.',
        'You CANNOT spawn additional sub-agents.',
        'Do not ask the user questions — you operate autonomously.',
      ].join('\n');
    }

    const workerPrompt: SystemPrompt = {
      prompt: systemPromptText,
      parts: [{ name: `agent-${agentType}`, content: systemPromptText, priority: 0 }],
    };

    const subAbortController = new AbortController();
    subAgentRegistry.update(agentId, {
      status: 'running',
      abortController: subAbortController,
    });

    // Update team config status so TeamPanel shows the resumed agent
    if (diskInfo?.teamName && parentSessionDir) {
      const { updateMemberInTeam } = await import('../utils/swarm/teamHelpers.js');
      updateMemberInTeam(parentSessionDir, diskInfo.teamName, agentId, { status: 'running' }).catch(() => {});
    }

    // ── Run the query loop ──────────────────────────────────────────
    let assistantTurnCount = 0;
    let toolCount = 0;
    const newTranscript: any[] = [];

    try {
      const generator = query({
        sessionId: subSessionManager.getActive().id,
        cwd: process.cwd(),
        messages: resumedMessages,
        systemPrompt: workerPrompt,
        toolRegistry: subToolRegistry,
        permissionEngine: subPermissionEngine,
        sessionManager: subSessionManager,
        checkpointManager: subCheckpointManager,
        abortController: subAbortController,
        maxTurns: agentDef?.maxTurns ?? 200,
        contextBudget: agentDef?.contextBudget ?? 120_000,
        compactThreshold: 0.85,
        autoCompactEnabled: this.config.autoCompactEnabled ?? true,
        callModel: this.config.callModel,
        hookManager,
      });

      for await (const msg of generator) {
        if (subAbortController.signal.aborted) break;

        switch (msg.type) {
          case 'stream_event': {
            yield { type: 'message', data: msg };
            break;
          }
          case 'assistant': {
            assistantTurnCount++;
            newTranscript.push(msg.message);
            const blocks = Array.isArray(msg.message.content) ? msg.message.content : [];
            toolCount += blocks.filter((b: any) => b.type === 'tool_use').length;
            yield { type: 'message', data: msg };
            break;
          }
          case 'user': {
            newTranscript.push(msg.message);
            yield { type: 'message', data: msg };
            break;
          }
          case 'system': {
            if (msg.subtype === 'progress') {
              const usage = subSessionManager.getActive().tokenUsage;
              subAgentRegistry.update(agentId, {
                turnCount: agent.turnCount + assistantTurnCount,
                messageCount: transcript.length + newTranscript.length,
                toolCount: agent.toolCount + toolCount,
                tokenUsage: {
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  cacheCreationInputTokens: usage.cacheCreationInputTokens,
                  cacheReadInputTokens: usage.cacheReadInputTokens,
                  totalTokens: usage.totalTokens,
                },
              });
            }
            if (msg.subtype === 'permission_required') {
              yield { type: 'permission_required', deferred: msg.deferred };
            } else if (msg.subtype === 'question_required') {
              yield { type: 'question_required', deferred: msg.deferred };
            } else if (msg.subtype === 'error') {
              yield { type: 'error', data: { message: msg.error.message } };
            } else {
              yield { type: 'message', data: msg };
            }
            break;
          }
        }
      }

      // ── Finalize ──────────────────────────────────────────────────
      const finalStatus = subAbortController.signal.aborted ? 'stopped' : 'done';
      const cumulativeTranscript = [...transcript, ...newTranscript];
      const finalUsage = subSessionManager.getActive().tokenUsage;
      subAgentRegistry.update(agentId, {
        status: finalStatus,
        finishedAt: Date.now(),
        turnCount: agent.turnCount + assistantTurnCount,
        messageCount: cumulativeTranscript.length,
        toolCount: agent.toolCount + toolCount,
        transcript: cumulativeTranscript,
        tokenUsage: {
          inputTokens: finalUsage.inputTokens,
          outputTokens: finalUsage.outputTokens,
          cacheCreationInputTokens: finalUsage.cacheCreationInputTokens,
          cacheReadInputTokens: finalUsage.cacheReadInputTokens,
          totalTokens: finalUsage.totalTokens,
        },
      });

      if (parentSessionDir) {
        saveAgentTranscript(agentId, cumulativeTranscript, parentSessionDir).catch(() => {});
        writeAgentMetadata(agentId, {
          agentType,
          worktreePath: undefined,
          description: agent.prompt,
          createdAt: agent.createdAt,
          finishedAt: Date.now(),
        }, parentSessionDir).catch(() => {});
        if (diskInfo?.teamName) {
          const { updateMemberInTeam } = await import('../utils/swarm/teamHelpers.js');
          updateMemberInTeam(parentSessionDir, diskInfo.teamName, agentId, {
            status: finalStatus,
            finishedAt: Date.now(),
          }).catch(() => {});
        }
      }

      yield {
        type: 'done',
        data: { sessionId: subSessionManager.getActive().id, agentId },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorUsage = subSessionManager.getActive().tokenUsage;
      subAgentRegistry.update(agentId, {
        status: 'error',
        finishedAt: Date.now(),
        turnCount: agent.turnCount + assistantTurnCount,
        error: errorMsg,
        tokenUsage: {
          inputTokens: errorUsage.inputTokens,
          outputTokens: errorUsage.outputTokens,
          cacheCreationInputTokens: errorUsage.cacheCreationInputTokens,
          cacheReadInputTokens: errorUsage.cacheReadInputTokens,
          totalTokens: errorUsage.totalTokens,
        },
      });
      if (diskInfo?.teamName && parentSessionDir) {
        const { updateMemberInTeam } = await import('../utils/swarm/teamHelpers.js');
        updateMemberInTeam(parentSessionDir, diskInfo.teamName, agentId, {
          status: 'error',
          finishedAt: Date.now(),
        }).catch(() => {});
      }
      yield { type: 'error', data: { message: errorMsg } };
    }
  }

  async resume(sessionId: string): Promise<Session> {
    const session = this.config.sessionManager.resume(sessionId);
    this.permissionEngine.setCwd(session.cwd);
    this.checkpointManager.loadFromDisk(sessionId);
    return session;
  }

  fork(fromTurn?: number): Session {
    const session = this.config.sessionManager.getActive();
    return this.config.sessionManager.fork({ sessionId: session.id, fromTurn, cwd: this.config.cwd });
  }

  rewind(toTurn: number): Session {
    const session = this.config.sessionManager.getActive();
    return this.config.sessionManager.rewind(session.id, toTurn);
  }

  getPermissionEngine(): PermissionEngine {
    return this.permissionEngine;
  }

  getSessionManager(): SessionManager {
    return this.config.sessionManager;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionEngine.setMode(mode);

    // ConfigChange hook (non-blockable)
    if (this.config.hookManager) {
      try {
        const session = this.config.sessionManager.getActive();
        if (session) {
          this.config.hookManager.onConfigChange(
            session.id,
            this.config.cwd,
            ['permissionMode'],
            { permissionMode: mode },
            undefined,
          ).catch(() => {});
        }
      } catch {
        // Non-blockable: session may not be active yet
      }
    }
  }

  /**
   * Add a permission rule for the current session (in-memory, not persisted).
   * Rule content is extracted from the tool input for content-aware matching.
   */
  addPermissionRule(
    toolName: string,
    ruleContent: string | undefined,
    behavior: PermissionRule['behavior'],
  ): void {
    this.permissionEngine.addPermissionRule({
      toolName,
      ruleContent,
      behavior,
      source: 'session',
    });
  }

  /**
   * Persist a permission rule to ~/.coderix/settings.json so it survives
   * across sessions. Also adds it as a session rule for immediate effect.
   */
  persistPermissionRule(
    toolName: string,
    ruleContent: string | undefined,
    behavior: PermissionRule['behavior'],
  ): void {
    // Add session rule for immediate effect
    this.addPermissionRule(toolName, ruleContent, behavior);

    // Persist to settings.json
    const settings = loadSettings();
    const allow = settings.permissions?.allow ?? [];
    // Avoid duplicates
    const exists = allow.some(
      (r) => r.toolName === toolName && r.ruleContent === ruleContent,
    );
    if (!exists) {
      settings.permissions = {
        ...settings.permissions,
        allow: [
          ...allow,
          { toolName, ruleContent, behavior },
        ],
      };
      saveSettings(settings);
    }
  }

  async shutdown(): Promise<void> {
    this.interrupt();
    const session = this.config.sessionManager.getActive();
    this.config.sessionManager.saveSession(session);
    // Drain pending memory extraction before shutdown
    await drainMemoryExtraction(30_000);
  }

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const modelName = (m: string | ModelItem): string =>
  typeof m === 'string' ? m : m.name;

const modelMaxContext = (m: string | ModelItem): number | undefined =>
  typeof m === 'string' ? undefined : m.price?.max_context;

/**
 * Look up a model's max context window from settings.model_list.
 *
 * Resolution order matches Coderix's model resolution:
 *   1. Find the model by exact name in any entry's model list
 *   2. If not found, use the first model in the first entry
 *   3. If nothing works, return undefined
 */
/** Trim large tool outputs in historical messages to prevent context bloat
 *  across repeated sub-agent resumes. Caps tool_result content at a limit so
 *  the model still sees all the context without O(N) duplication of giant
 *  outputs from prior turns. */
function trimTranscriptForResume(messages: any[]): any[] {
  const MAX_TOOL_OUTPUT_TOKENS = 2000;
  return messages.map((msg) => {
    if (msg.role !== 'user') return msg;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const hasLargeOutput = content.some(
      (b: any) => b.type === 'tool_result' && typeof b.content === 'string'
        && countTokens(b.content) > MAX_TOOL_OUTPUT_TOKENS,
    );
    if (!hasLargeOutput) return msg;
    return {
      ...msg,
      content: content.map((b: any) => {
        if (b.type !== 'tool_result' || typeof b.content !== 'string'
            || countTokens(b.content) <= MAX_TOOL_OUTPUT_TOKENS) return b;
        const trimmed = truncateToTokenLimit(b.content, MAX_TOOL_OUTPUT_TOKENS);
        const originalTokens = countTokens(b.content);
        return {
          ...b,
          content: trimmed
            + `\n... [trimmed ${originalTokens - countTokens(trimmed)} tokens]`,
        };
      }),
    };
  });
}

function resolveModelMaxContext(
  model: string,
  modelList: ModelEntry[],
): number | undefined {
  for (const entry of modelList) {
    const found = entry.model.find((m) => modelName(m) === model);
    if (found) {
      return modelMaxContext(found);
    }
  }
  // Fallback: first model of first entry
  if (modelList.length > 0) {
    const first = modelList[0]!.model[0];
    if (first) return modelMaxContext(first);
  }
  return undefined;
}
