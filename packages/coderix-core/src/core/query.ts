/**
 * query.ts — AsyncGenerator-driven Agent Loop
 *
 * The core agent loop — an AsyncGenerator that yields messages
 * (stream_event / assistant / user / system / error / progress)
 * consumed by QueryEngine.submitMessage() via for-await.
 *
 * Adapted from Coderix for ink-chat-tui.
 */

import type {
  Message,
  AssistantMessage,
  UserMessage,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  StreamEvent,
  CompletionUsage,
  StopReason,
  QueryMessage,
  CompactMetadata,
  DeferredPermission,
} from './types.js';
import { AgentError, RiskLevel, PermissionMode } from './types.js';
import type { PlanModeState } from './types.js';
import type { ToolContext } from './types.js';
import { ToolRegistry } from './tool-registry.js';
import { PermissionEngine, extractRuleContent } from './permission.js';
import { SessionManager } from './session.js';
import { CheckpointManager } from './checkpoint.js';
import { CommandCategory } from '../tools/bash/command-classifier.js';
import type { ClassificationResult } from '../tools/bash/command-classifier.js';
import { tokenizeCommand, extractCommandTokens } from '../tools/bash/command-tokenizer.js';
import { classifyCommand } from '../tools/bash/command-classifier.js';
import type { SystemPrompt } from './system-prompt.js';
import type { SystemPromptAssembler } from './system-prompt.js';
import type { HookManager } from '../hooks/index.js';
import type { SubAgentRegistry } from './subagent-registry.js';
import type { AgentRegistry } from './agent-registry.js';
import { estimateTokens, tokenCountWithEstimation, estimateMessageTokens } from './token-budget.js';
import { ToolExecutionQueue } from './tool-queue.js';
import { sessionDir, writeSessionMeta } from './session-store.js';
import type { CoreState } from '../state/core-state.js';
import type { ToolRequestEvent } from '../state/observable.js';
import { applyToolResultLimits } from './tool-result-limiter.js';
import type { CompactionResult } from './compact/compact-types.js';
import {
  Compactor,
  calculateMessagesToKeepIndex,
  compactConversation,
  streamCompactConversation,
  trySessionMemoryCompact,
  consumeManualCompactRequest,
} from './compactor.js';
import { collectPostCompactAttachments } from './compact/post-compact-restore.js';
import { classifyError } from './error-recovery.js';
import { loadCodeAgentContext } from './context-loader.js';
import { listTasks } from '../tasks/store.js';
import { drainTaskNotifications, listTasks as listTrackedTasks } from '../tasks/task-tracker.js';
import { snipCompact, consumeSnipRequest, createSnipMarker } from './snip-compact.js';
import { generatePlanSlug, getPlanFilePath } from './plan-files.js';
import { getPlanModeAttachmentContent, incrementPlanModeTurn } from './plan-mode-attachment.js';
// Types
// ---------------------------------------------------------------------------

export interface QueryConfig {
  sessionId: string;
  cwd: string;
  messages: Message[];
  systemPrompt: SystemPrompt;
  toolRegistry: ToolRegistry;
  permissionEngine: PermissionEngine;
  sessionManager: SessionManager;
  checkpointManager: CheckpointManager;
  abortController: AbortController;
  maxTurns: number;
  maxBudgetUsd?: number;
  contextBudget: number;
  compactThreshold: number;
  /** Enable automatic context compaction. When false, only manual /compact works. */
  autoCompactEnabled?: boolean;
  /** Max concurrent tool executions (default: 32). */
  maxToolConcurrency?: number;
  callModel: (params: CallModelParams) => AsyncGenerator<StreamEvent | AssistantMessage>;
  /** Optional HookManager for lifecycle hook execution */
  hookManager?: HookManager;
  /** SubAgentRegistry for tracking spawned sub-agents */
  subAgentRegistry?: SubAgentRegistry;
  /** SystemPromptAssembler for assembling sub-agent prompts */
  systemPromptAssembler?: SystemPromptAssembler;
  /** AgentRegistry for looking up agent type definitions */
  agentRegistry?: AgentRegistry;
  /** Role determines tool access: 'worker' is a sub-agent with restricted orchestration tools */
  agentRole?: 'default' | 'worker';
  /** Read CoreState snapshot (engine-level fields). */
  getCoreState?: () => CoreState;
  /** Emit a tool request to the frontend (background tasks, agents). */
  emitToolRequest?: (req: ToolRequestEvent) => void;
  /** Track recently read files for post-compact restoration. */
  readFileTracker?: import('./read-file-tracker.js').ReadFileTracker;
  /** Clear transient caches after compaction. */
  clearCaches?: () => void;
  /** When true, pass cacheControl to the model call (fork sub-agents). */
  enableCacheControl?: boolean;
  /** Callback when the ToolExecutionQueue running count changes. */
  onToolQueueChange?: (count: number) => void;
}

export interface CallModelParams {
  system: string;
  messages: Message[];
  tools: unknown[];
  signal: AbortSignal;
  /** When true, annotate the system prompt with cache_control for Anthropic prompt caching. */
  cacheControl?: boolean;
  /** Optional thinking config override. Falls back to enabled(16000) if omitted. */
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createUserMessage(content: ContentBlock[]): UserMessage {
  return { role: 'user', content };
}

function createToolErrorResult(toolUseId: string, error: string): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: error,
    is_error: true,
  };
}

const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

/**
 * Check whether any task management tools were used in the most recent
 * assistant message. Used to decide whether to inject a task reminder.
 */
function recentlyUsedTaskTools(messages: Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.name && TASK_TOOL_NAMES.has(block.name)) {
        return true;
      }
    }
    // Only check the most recent assistant message
    break;
  }
  return false;
}

// ── Dynamic bash risk assessment ────────────────────────────────────

/**
 * Dynamically determine the riskLevel and isConcurrencySafe for a bash command
 * based on command classification. Read-only commands are SAFE and concurrency-safe;
 * code exec is DESTRUCTIVE; everything else keeps the static metadata.
 */
function resolveBashRiskLevel(
  toolName: string,
  input: Record<string, unknown>,
  staticRiskLevel: string,
  staticIsConcurrencySafe: boolean,
): { riskLevel: string; isConcurrencySafe: boolean; classification?: ClassificationResult } {
  if (toolName !== 'bash') {
    return { riskLevel: staticRiskLevel, isConcurrencySafe: staticIsConcurrencySafe };
  }

  const command = input.command as string | undefined;
  if (!command) {
    return { riskLevel: staticRiskLevel, isConcurrencySafe: staticIsConcurrencySafe };
  }

  const tokenizeResult = tokenizeCommand(command);
  const tokens = tokenizeResult.success ? extractCommandTokens(tokenizeResult.entries) : [];

  const classification = classifyCommand(command, tokens, { mode: 'default' });

  if (classification.category === CommandCategory.READ_ONLY) {
    return {
      riskLevel: RiskLevel.SAFE,
      isConcurrencySafe: true,
      classification,
    };
  }

  if (classification.category === CommandCategory.CODE_EXEC) {
    return {
      riskLevel: RiskLevel.DESTRUCTIVE,
      isConcurrencySafe: false,
      classification,
    };
  }

  if (classification.category === CommandCategory.DESTRUCTIVE) {
    return {
      riskLevel: RiskLevel.DESTRUCTIVE,
      isConcurrencySafe: false,
      classification,
    };
  }

  return { riskLevel: staticRiskLevel, isConcurrencySafe: staticIsConcurrencySafe, classification };
}

// ---------------------------------------------------------------------------
// executeSingleTool — run one tool with hooks, checkpoint, tracking
// ---------------------------------------------------------------------------

interface ExecuteSingleToolOpts {
  sessionId: string;
  cwd: string;
  toolRegistry: ToolRegistry;
  checkpointManager: CheckpointManager;
  sessionManager: SessionManager;
  hookManager?: HookManager;
  abortController: AbortController;
  callModel: (params: CallModelParams) => AsyncGenerator<StreamEvent | AssistantMessage>;
  subAgentRegistry?: SubAgentRegistry;
  systemPromptAssembler?: SystemPromptAssembler;
  agentRegistry?: AgentRegistry;
  /** Rendered system prompt for fork sub-agent inheritance. */
  systemPrompt?: SystemPrompt;
  setPermissionMode?: (mode: string) => void;
  getPermissionMode?: () => PermissionMode;
  planModeState?: PlanModeState | null;
  getCoreState?: () => CoreState;
  emitToolRequest?: (req: ToolRequestEvent) => void;
  readFileTracker?: import('./read-file-tracker.js').ReadFileTracker;
}

function getRunningSummary(subAgentRegistry?: SubAgentRegistry): string {
  const runningAgents = subAgentRegistry
    ? subAgentRegistry.list().filter(a => a.status === 'running').length
    : 0;
  const runningBash = listTrackedTasks().filter(
    t => t.type === 'bash' && t.status === 'running',
  ).length;

  if (runningAgents > 0 && runningBash > 0) return 'sub-agent and bash still running';
  if (runningAgents > 0) return 'sub-agent still running';
  if (runningBash > 0) return 'bash still running';
  return 'still running';
}

async function executeSingleTool(
  toolBlock: ToolUseBlock,
  opts: ExecuteSingleToolOpts,
): Promise<ToolResultBlock> {
  const { sessionId, cwd, toolRegistry, checkpointManager, sessionManager, hookManager, abortController, callModel, subAgentRegistry, systemPromptAssembler, agentRegistry, systemPrompt, setPermissionMode, getPermissionMode, planModeState, getCoreState, emitToolRequest, readFileTracker } = opts;
  const toolDef = toolRegistry.get(toolBlock.name)?.definition;

  // PreToolUse hook
  if (hookManager) {
    const { blocked, reason } = await hookManager.onPreToolUse(
      sessionId,
      cwd,
      toolBlock.name,
      toolBlock.input,
    );
    if (blocked) {
      const msg = reason ?? 'Blocked by PreToolUse hook';
      return createToolErrorResult(toolBlock.id, msg);
    }
  }

  // Git checkpoint before destructive operations
  if (toolDef?.riskLevel === 'destructive') {
    await checkpointManager.create({ sessionId, cwd, description: `Pre-${toolBlock.name}` });
  }

  const toolCtx: ToolContext = {
    sessionId,
    cwd,
    signal: abortController.signal,
    toolUseId: toolBlock.id,
    setPermissionMode,
    getPermissionMode,
    planModeState: planModeState ?? undefined,
    getCoreState,
    emitToolRequest,
    readFileTracker,
    agentSpawn: subAgentRegistry && systemPromptAssembler && agentRegistry ? {
      callModel,
      toolRegistry,
      sessionManager,
      subAgentRegistry,
      hookManager,
      systemPromptAssembler,
      agentRegistry,
      renderedSystemPrompt: systemPrompt,
    } : undefined,
  };
  const toolStartTime = Date.now();

  try {
    const execResult = await toolRegistry.execute(toolBlock.name, toolBlock.input, toolCtx);
    const resultBlock: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: toolBlock.id,
      content: execResult.content,
      is_error: execResult.isError,
      duration: execResult.duration,
      metadata: execResult.metadata,
    };
    sessionManager.trackTool(toolBlock.name);

    if ((toolBlock.name === 'Write' || toolBlock.name === 'Update') && toolBlock.input) {
      const input = toolBlock.input as Record<string, unknown>;
      if (typeof input.file_path === 'string') {
        sessionManager.trackModifiedFile(input.file_path);
      }
    }

    hookManager?.onNotification(
      sessionId, cwd,
      resultBlock.is_error ? 'warn' : 'info',
      `Tool ${toolBlock.name} ${resultBlock.is_error ? 'failed' : 'completed'}`,
      { toolName: toolBlock.name, isError: resultBlock.is_error, toolUseId: toolBlock.id },
    ).catch(() => {});

    if (hookManager) {
      const durationMs = Date.now() - toolStartTime;
      hookManager
        .onPostToolUse(
          sessionId, cwd, toolBlock.name, toolBlock.input,
          { output: execResult.content, success: !resultBlock.is_error },
          !resultBlock.is_error, durationMs,
        )
        .catch(() => {});
    }

    return resultBlock;
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);

    if (hookManager) {
      const errObj = error instanceof Error ? error : new Error(errMsg);
      hookManager.onPostToolUseFailure(
        sessionId, cwd, toolBlock.name, toolBlock.input, errObj,
      ).catch(() => {});
      const durationMs = Date.now() - toolStartTime;
      hookManager
        .onPostToolUse(
          sessionId, cwd, toolBlock.name, toolBlock.input,
          { output: errMsg, success: false }, false, durationMs,
        )
        .catch(() => {});
    }

    return createToolErrorResult(toolBlock.id, errMsg);
  }
}

// ---------------------------------------------------------------------------
// query() — Main Agent Loop
// ---------------------------------------------------------------------------

/**
 * Return a window of the most recent messages that fit within `maxTokens`.
 * Walks backward from the end, accumulating estimated per-message tokens.
 * If the full array fits, it is returned as-is (no copy).
 */
function windowMessages(messages: Message[], maxTokens: number): Message[] {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(messages[i]!);
    if (acc > maxTokens) {
      return messages.slice(i + 1);
    }
  }
  return messages;
}

export async function* query(config: QueryConfig): AsyncGenerator<QueryMessage> {
  const {
    sessionId,
    cwd,
    toolRegistry,
    permissionEngine,
    sessionManager,
    checkpointManager,
    abortController,
    maxTurns,
    maxBudgetUsd,
    contextBudget,
    compactThreshold,
    autoCompactEnabled,
    maxToolConcurrency = 32,
    callModel,
    hookManager,
    agentRegistry,
    agentRole,
    getCoreState,
    emitToolRequest,
    readFileTracker,
    clearCaches,
  } = config;

  let messages = [...config.messages];
  let systemPrompt = config.systemPrompt;
  let turnCount = 0;
  let totalCost = 0;

  // ── Task reminder throttle ──────────────────────────────────────
  // Only inject task reminders every N turns to avoid spamming.
  const TASK_REMINDER_INTERVAL = 10;
  let turnsSinceTaskReminder = TASK_REMINDER_INTERVAL; // Start ready

  // ── Plan mode state (lives across turns while in plan mode) ──
  // Wrapped in an object so TypeScript doesn't narrow the let binding
  // to `never` when only reassigned inside callbacks.
  const pm = { current: null as PlanModeState | null };

  // Circuit breaker: stop auto-compact after N consecutive failures.
  // Resets on success. Manual /compact always bypasses.
  const compactFailures = { count: 0 };
  const MAX_AUTOCOMPACT_FAILURES = 3;

  // Prevent infinite reactive-compact loops (only one per turn)
  let thisTurnDidReactiveCompact = false;

  while (true) {
    // ── Per-turn reset ──────────────────────────────────────────────
    thisTurnDidReactiveCompact = false;

    // ── Manual /compact check ──────────────────────────────────────
    if (consumeManualCompactRequest()) {
      messages = yield* runCompaction(
        messages,
        tokenCountWithEstimation(messages),
        contextBudget,
        { sessionId, cwd, hookManager, callModel, systemPrompt, permissionMode: permissionEngine.getMode(), planModeState: pm.current, readFileTracker, clearCaches },
        abortController.signal,
        { count: 0 },
      );
    }

    // === Exit conditions ===
    if (turnCount >= maxTurns) {
      hookManager?.onNotification(
        sessionId, cwd, 'warn',
        `Exceeded maximum of ${maxTurns} turns`,
        { turnCount, maxTurns },
      ).catch(() => {});
      yield {
        type: 'system',
        subtype: 'error',
        error: new AgentError(`Exceeded maximum of ${maxTurns} turns`, 'MAX_TURNS'),
      };
      return;
    }

    if (maxBudgetUsd && totalCost >= maxBudgetUsd) {
      hookManager?.onNotification(
        sessionId, cwd, 'warn',
        `Budget exceeded at $${totalCost.toFixed(2)}`,
        { totalCost, maxBudgetUsd },
      ).catch(() => {});
      yield {
        type: 'system',
        subtype: 'error',
        error: new AgentError(`Budget exceeded at $${totalCost.toFixed(2)}`, 'BUDGET'),
      };
      return;
    }

    if (abortController.signal.aborted) {
      return;
    }

    // === Snip Compact: inject pending marker, then trim ===
    if (consumeSnipRequest()) {
      messages.push(createSnipMarker());
      sessionManager.replaceMessages(messages);
    }
    {
      const { messages: snipped, snippedCount } = snipCompact(messages);
      if (snippedCount > 0) {
        const beforeTokens = tokenCountWithEstimation(messages);
        messages = snipped;
        sessionManager.replaceMessages(messages);
        yield {
          type: 'system',
          subtype: 'compact_boundary',
          compactMetadata: {
            beforeTokens,
            afterTokens: tokenCountWithEstimation(messages),
            strategy: 'snip',
          },
        };
        hookManager?.onNotification(
          sessionId, cwd, 'info',
          `Snip-compacted: dropped ${snippedCount} messages`,
          { snippedCount },
        ).catch(() => {});
      }
    }

    // === Get tool definitions for LLM ===
    const toolDefinitions = toolRegistry.getDefinitions()
      .map((def) => ({
        name: def.name,
        description: def.description,
        input_schema: def.input_schema,
      }));

    // === Stream call to LLM ===
    const assistantMessages: AssistantMessage[] = [];
    let stopReason: StopReason = 'end_turn';
    let usage: CompletionUsage = { input_tokens: 0, output_tokens: 0 };

    // Streaming tool execution: tools are enqueued as soon as their
    // input JSON is complete (content_block_stop), not after the full
    // message.  A bounded pool limits concurrent executions.
    interface BuildingBlock {
      id: string;
      name: string;
      inputJson: string;
    }
    let buildingBlock: BuildingBlock | null = null;
    const orderedBlocks: ToolUseBlock[] = [];
    const queue = new ToolExecutionQueue(maxToolConcurrency, abortController.signal);
    queue.onChange = config.onToolQueueChange ?? undefined;
    const execOpts: ExecuteSingleToolOpts = {
      sessionId,
      cwd,
      toolRegistry,
      checkpointManager,
      sessionManager,
      hookManager,
      abortController,
      callModel,
      subAgentRegistry: config.subAgentRegistry,
      systemPromptAssembler: config.systemPromptAssembler,
      agentRegistry: config.agentRegistry,
      systemPrompt: config.systemPrompt,
      setPermissionMode: (mode: string) => {
        const previousMode = permissionEngine.getMode();
        const newMode = mode as PermissionMode;

        if (newMode === PermissionMode.PLAN && previousMode !== PermissionMode.PLAN) {
          // Entering plan mode — save pre-plan state
          const slug = generatePlanSlug();
          const planFilePath = getPlanFilePath(slug);
          pm.current = {
            prePlanMode: previousMode,
            planFilePath,
            planFileSlug: slug,
            turnCount: 0,
            hasExitedPlanMode: false,
            needsExitAttachment: false,
          };
        } else if (newMode !== PermissionMode.PLAN && previousMode === PermissionMode.PLAN) {
          // Exiting plan mode — mark for exit attachment
          if (pm.current) {
            pm.current.hasExitedPlanMode = true;
            pm.current.needsExitAttachment = true;
          }
        }

        permissionEngine.setMode(newMode);
      },
      getPermissionMode: () => permissionEngine.getMode(),
      planModeState: pm.current,
      getCoreState: config.getCoreState,
      emitToolRequest: config.emitToolRequest,
      readFileTracker: config.readFileTracker,
    };

    try {
      let systemText = systemPrompt.prompt;

      // ── Plan mode attachment injection ──────────────────────────
      const planAttachment = getPlanModeAttachmentContent(pm.current);
      if (planAttachment) {
        systemText = planAttachment + '\n\n' + systemText;
      }

      // ── Plan mode exit notification (one-shot) ──────────────────
      if (
        pm.current?.needsExitAttachment &&
        permissionEngine.getMode() !== PermissionMode.PLAN
      ) {
        const planRef = pm.current.planFilePath
          ? ` The plan file is located at ${pm.current.planFilePath} if you need to reference it.`
          : '';
        const exitChoice = pm.current.exitChoice === 'manual-approve'
          ? 'manual-approve'
          : 'auto-accept';
        if (exitChoice === 'manual-approve') {
          systemText =
            `<system-reminder>\n## Exited Plan Mode\n\nYou have exited plan mode. The user wants to manually approve each change. You may proceed with implementation, but each tool call will require approval.${planRef}\n</system-reminder>\n\n` +
            systemText;
        } else {
          systemText =
            `<system-reminder>\n## Exited Plan Mode\n\nYou have exited plan mode. The user chose auto-accept. You may now make edits, run tools, and take actions freely.${planRef}\n</system-reminder>\n\n` +
            systemText;
        }
        pm.current.needsExitAttachment = false;
      }

      // ── Plan revision prompt (one-shot, for option 3) ──────────
      if (pm.current?.needsRevisionPrompt) {
        const planRef = pm.current.planFilePath
          ? ` The plan file is at ${pm.current.planFilePath}.`
          : '';
        systemText =
          `<system-reminder>\n## Plan Revision Requested\n\nThe user wants changes to the plan. You are still in plan mode. Ask the user what they would like to change using the AskUserQuestion tool (free-text mode with no options so they can type feedback). After receiving their feedback, revise the plan file and call ExitPlanMode again.${planRef}\n</system-reminder>\n\n` +
          systemText;
        pm.current.needsRevisionPrompt = false;
      }

      // ── Task status reminder ──────────────────────────────────────
      // When there are active tasks but the agent hasn't used task
      // management tools recently, inject a reminder to update task
      // statuses. Throttled to at most once per TASK_REMINDER_INTERVAL
      // turns to avoid spamming.
      if (agentRole !== 'worker') {
        try {
          const usedTaskTools = recentlyUsedTaskTools(messages);
          if (usedTaskTools) {
            // Agent is actively managing tasks — reset the counter
            turnsSinceTaskReminder = 0;
          }

          if (turnsSinceTaskReminder >= TASK_REMINDER_INTERVAL) {
            const activeTasks = (await listTasks()).filter(
              t => t.status === 'pending' || t.status === 'in_progress',
            );
            if (activeTasks.length > 0 && !usedTaskTools) {
              const taskLines = activeTasks.slice(0, 8).map(
                t => `- #${t.id} [${t.status}] ${t.subject}`,
              );
              const overflow = activeTasks.length > 8
                ? `\n... and ${activeTasks.length - 8} more tasks`
                : '';
              const reminder =
                '<system-reminder>\n' +
                '## Task Status Reminder\n\n' +
                'You have active tasks. Use TaskUpdate to mark them in_progress before\n' +
                'starting work, and completed as soon as you finish. Do not batch updates.\n\n' +
                taskLines.join('\n') + overflow + '\n' +
                '</system-reminder>';
              systemText = reminder + '\n\n' + systemText;
              turnsSinceTaskReminder = 0;
            }
          }
        } catch {
          // Task store might not be available — silently skip
        }
      }

      // === PreMessage hook (blockable) ===
      if (hookManager) {
        const messageSummaries = messages.slice(-10).map((m) => ({
          role: m.role,
          summary: typeof m.content === 'string'
            ? m.content.slice(0, 200)
            : Array.isArray(m.content)
              ? m.content
                  .map((b) =>
                    b.type === 'text'
                      ? (b.text ?? '').slice(0, 100)
                      : `[${b.type}]`,
                  )
                  .join('; ')
              : '',
        }));
        const preMessageResult = await hookManager.onPreMessage(
          sessionId,
          cwd,
          messageSummaries,
          systemText,
          'unknown',
          turnCount,
        );
        if (preMessageResult.blocked) {
          yield {
            type: 'system',
            subtype: 'error',
            error: new AgentError(
              preMessageResult.blockReason ?? 'API call blocked by PreMessage hook',
              'HOOK_BLOCKED',
            ),
          };
          return;
        }
        if (preMessageResult.modifiedSystemPrompt) {
          systemText = preMessageResult.modifiedSystemPrompt;
        }
        if (preMessageResult.injectContext) {
          systemText = `${preMessageResult.injectContext}\n\n${systemText}`;
        }
      }

      // Persist current context length so session resume can pre-populate
      // the context bar instead of showing 0 after reload.
      const preCallTokens = tokenCountWithEstimation(messages);
      const dir = sessionDir(config.sessionId);
      writeSessionMeta(dir, { contextLength: preCallTokens }).catch(() => {});

      // Window messages to the context budget to avoid sending the full
      // session history over the wire on every API call.
      const apiMessages = windowMessages(messages, contextBudget);

      for await (const event of callModel({
        system: systemText,
        messages: apiMessages,
        tools: toolDefinitions,
        signal: abortController.signal,
        cacheControl: config.enableCacheControl,
      })) {
        // ── Stream events ──────────────────────────────────────────
        if ('type' in event) {
          // Always yield stream events to the TUI first
          yield { type: 'stream_event', event: event as StreamEvent };

          // Track building tool_use blocks from the stream
          if (event.type === 'content_block_start') {
            const cb = (event as { type: 'content_block_start'; content_block: ContentBlock }).content_block;
            if (cb.type === 'tool_use' && cb.id && cb.name) {
              buildingBlock = { id: cb.id, name: cb.name, inputJson: '' };
            }
          }

          if (event.type === 'content_block_delta' && buildingBlock) {
            const delta = (event as { type: 'content_block_delta'; delta: { type: string; partial_json?: string } }).delta;
            if (delta.type === 'input_json_delta' && delta.partial_json) {
              buildingBlock.inputJson += delta.partial_json;
            }
          }

          if (event.type === 'content_block_stop' && buildingBlock) {
            // Tool block input is complete — parse, check permission, enqueue
            const toolBlock: ToolUseBlock = {
              type: 'tool_use',
              id: buildingBlock.id,
              name: buildingBlock.name,
              input: (() => {
                try { return JSON.parse(buildingBlock.inputJson) as Record<string, unknown>; }
                catch { return {}; }
              })(),
            };
            orderedBlocks.push(toolBlock);

            // ── ask-user-question: block and wait for user input ──
            if (toolBlock.name === 'AskUserQuestion') {
              const qInput = toolBlock.input as Record<string, unknown>;
              const questions = (qInput?.questions as Array<{
                question: string; header: string;
                options?: Array<{ label: string; description: string }>;
                multiSelect?: boolean;
              }>) ?? [];

              if (questions.length > 0) {
                let resolve!: (answers: Record<string, string | string[]>) => void;
                const promise = new Promise<Record<string, string | string[]>>((r) => { resolve = r; });
                const deferred = {
                  toolName: toolBlock.name, toolUseId: toolBlock.id,
                  questions,
                  resolve, promise,
                };

                yield {
                  type: 'system', subtype: 'question_required',
                  deferred,
                } as any;

                const answers = await promise;
                // Merge answers into input so executor can return them
                toolBlock.input = { ...toolBlock.input, answers };
              }
              // Fall through to normal execution — executor returns the answers
            }

            // ── exit-plan-mode: show confirmation prompt ──
            if (toolBlock.name === 'ExitPlanMode') {
              const planState = pm.current;
              const planFilePath = planState?.planFilePath ?? '';

              // Always show confirmation — plan file may not exist yet
              // (Write tool hasn't executed). Renderer reads from disk independently.
              toolBlock.input = {
                ...toolBlock.input,
                _planFilePath: planFilePath,
              };

              const questions = [{
                question: 'Coderix has written up a plan and is ready to execute. Would you like to proceed?',
                header: 'Proceed?',
                options: [
                  { label: 'Yes, auto-accept edits', description: 'Proceed with implementation without asking for each change' },
                  { label: 'Yes, manually approve edits', description: 'Proceed but ask before each tool call' },
                  { label: 'Tell Coderix what to change', description: 'User wants modifications to the plan' },
                ],
              }];

              let resolve!: (answers: Record<string, string | string[]>) => void;
              const promise = new Promise<Record<string, string | string[]>>((r) => { resolve = r; });
              const deferred = {
                toolName: toolBlock.name, toolUseId: toolBlock.id,
                questions, resolve, promise,
              };

              yield {
                type: 'system', subtype: 'question_required',
                deferred,
              } as any;

              const answers = await promise;

              // Apply permission mode based on answer
              const answer = answers['Proceed?'] as string;
              let choice: string;
              if (answer === 'Yes, auto-accept edits') {
                execOpts.setPermissionMode?.('auto');
                choice = 'auto-accept';
              } else if (answer === 'Yes, manually approve edits') {
                execOpts.setPermissionMode?.('ask');
                choice = 'manual-approve';
              } else {
                // Stay in plan mode — user wants revisions
                choice = 'request-changes';
              }
              if (planState) {
                planState.exitChoice = choice;
                if (choice === 'request-changes') {
                  planState.needsRevisionPrompt = true;
                }
              }

              // Merge answers and choice so executor can include them
              toolBlock.input = { ...toolBlock.input, _exitAnswers: answers, _exitChoice: choice };
              // Fall through to normal execution
            }

            // Permission check + enqueue (may yield for ASK mode)
            if (!abortController.signal.aborted) {
              const toolDef = toolRegistry.get(toolBlock.name)?.definition;
              const staticRiskLevel = (toolDef?.riskLevel ?? RiskLevel.MUTATION) as RiskLevel;
              const staticConcurrencySafe = toolDef?.isConcurrencySafe ?? false;

              // Dynamic risk assessment for bash commands
              const dynamic = resolveBashRiskLevel(
                toolBlock.name,
                toolBlock.input as Record<string, unknown>,
                staticRiskLevel,
                staticConcurrencySafe,
              );
              const effectiveRiskLevel = dynamic.riskLevel as RiskLevel;
              const effectiveConcurrencySafe = dynamic.isConcurrencySafe;

              // Inject dynamic classification into tool input for the executor
              if (dynamic.classification) {
                toolBlock.input = {
                  ...toolBlock.input,
                  _classification: dynamic.classification,
                };
              }

              // Extract command content for content-aware permission rules
              const cmdContent = extractRuleContent(
                toolBlock.name,
                toolBlock.input as Record<string, unknown>,
              );

              // ExitPlanMode is always auto-approved (handled above)
              const permissionResult = toolBlock.name === 'ExitPlanMode'
                ? { allowed: true, behavior: 'approve' as const }
                : await permissionEngine.check(
                    {
                      toolName: toolBlock.name,
                      input: toolBlock.input,
                      riskLevel: effectiveRiskLevel,
                    },
                    toolDef,
                    cmdContent,
                  );

              // PermissionRequest hook (skip for ExitPlanMode — already confirmed)
              if (hookManager && permissionResult.behavior !== 'approve' && toolBlock.name !== 'ExitPlanMode') {
                const riskLevelStr = effectiveRiskLevel;
                const { permissionOverride } = await hookManager.onPermissionRequest(
                  sessionId, cwd, toolBlock.name, toolBlock.input,
                  String(riskLevelStr), permissionResult.behavior,
                );
                if (permissionOverride === 'auto-approve') {
                  permissionResult.allowed = true;
                  permissionResult.behavior = 'approve';
                } else if (permissionOverride === 'auto-deny') {
                  permissionResult.allowed = false;
                  permissionResult.behavior = 'deny';
                  permissionResult.reason = { type: 'hook', mode: 'auto-denied' };
                }
              }

              // deny
              if (!permissionResult.allowed && permissionResult.behavior === 'deny') {
                const reason = permissionResult.prompt
                  ?? (typeof permissionResult.reason === 'string'
                    ? permissionResult.reason
                    : permissionResult.reason?.mode)
                  ?? 'Denied';
                queue.storeError(toolBlock, reason);
                hookManager?.onPermissionDenied(
                  sessionId, cwd, toolBlock.name, toolBlock.input, reason,
                ).catch(() => {});
              } else if (permissionResult.behavior === 'ask_user') {
                // ASK — yield permission_required, await user response
                const toolInput = toolBlock.input as Record<string, unknown>;
                const command = [toolBlock.name, ...Object.entries(toolInput ?? {}).map(([k, v]) => `${k}=${String(v)}`)].join(' ');
                const description =
                  permissionResult.prompt ??
                  toolDef?.description ??
                  `Execute ${toolBlock.name}`;

                yield {
                  type: 'system', subtype: 'progress',
                  data: {
                    toolName: toolBlock.name, toolUseId: toolBlock.id,
                    status: 'started', message: 'Waiting for approval...',
                  },
                };

                let resolve!: (allowed: boolean) => void;
                const promise = new Promise<boolean>((res) => { resolve = res; });
                const deferred: DeferredPermission = {
                  toolName: toolBlock.name, command, description,
                  toolUseId: toolBlock.id,
                  toolInput: toolBlock.input as Record<string, unknown>,
                  resolve, promise,
                };
                yield { type: 'system', subtype: 'permission_required', deferred };

                const allowed = await new Promise<boolean>((res) => {
                  promise.then((v) => res(v));
                  const onAbort = () => { res(false); };
                  abortController.signal.addEventListener('abort', onAbort, { once: true });
                });

                if (!allowed) {
                  queue.storeError(toolBlock, 'User denied permission');
                  hookManager?.onPermissionDenied(
                    sessionId, cwd, toolBlock.name, toolBlock.input,
                    'User denied permission',
                  ).catch(() => {});
                } else {
                  queue.enqueue(toolBlock, (b) => executeSingleTool(b, execOpts));
                }
              } else {
                // approve — enqueue immediately
                queue.enqueue(toolBlock, (b) => executeSingleTool(b, execOpts));
              }
            } else {
              queue.storeError(toolBlock, 'Interrupted by user');
            }

            buildingBlock = null;
          }

          if (event.type === 'message_stop') {
            const msg = (event as unknown as { type: 'message_stop'; message: AssistantMessage }).message;
            if (msg) {
              assistantMessages.push(msg);
              stopReason = msg.stopReason;
              usage = msg.usage;
            }
          }

          if (event.type === 'message_delta') {
            const delta = (event as { type: 'message_delta'; delta: { stop_reason: StopReason | null } }).delta;
            if (delta.stop_reason) stopReason = delta.stop_reason;
          }
        }

        // ── Direct AssistantMessage (non-streaming fallback) ──────
        if (!('type' in event) && 'role' in event && (event as AssistantMessage).role === 'assistant') {
          const msg = event as AssistantMessage;
          assistantMessages.push(msg);
          stopReason = msg.stopReason ?? stopReason;
          usage = msg.usage ?? usage;

          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'tool_use') {
                const toolBlock = block as ToolUseBlock;
                orderedBlocks.push(toolBlock);

                // ── ask-user-question: block and wait for user input ──
                if (toolBlock.name === 'AskUserQuestion') {
                  const qInput = toolBlock.input as Record<string, unknown>;
                  const questions = (qInput?.questions as Array<{
                    question: string; header: string;
                    options?: Array<{ label: string; description: string }>;
                    multiSelect?: boolean;
                  }>) ?? [];

                  if (questions.length > 0) {
                    let resolve!: (answers: Record<string, string | string[]>) => void;
                    const promise = new Promise<Record<string, string | string[]>>((r) => { resolve = r; });
                    const deferred = {
                      toolName: toolBlock.name, toolUseId: toolBlock.id,
                      questions,
                      resolve, promise,
                    };

                    yield {
                      type: 'system', subtype: 'question_required',
                      deferred,
                    } as any;

                    const answers = await promise;
                    toolBlock.input = { ...toolBlock.input, answers };
                  }
                }

                // ── exit-plan-mode: show confirmation prompt ──
                if (toolBlock.name === 'ExitPlanMode') {
                  const planState = pm.current;
                  const planFilePath = planState?.planFilePath ?? '';

                  toolBlock.input = {
                    ...toolBlock.input,
                    _planFilePath: planFilePath,
                  };

                  const questions = [{
                    question: 'Coderix has written up a plan and is ready to execute. Would you like to proceed?',
                    header: 'Proceed?',
                    options: [
                      { label: 'Yes, auto-accept edits', description: 'Proceed with implementation without asking for each change' },
                      { label: 'Yes, manually approve edits', description: 'Proceed but ask before each tool call' },
                      { label: 'Tell Coderix what to change', description: 'User wants modifications to the plan' },
                    ],
                  }];

                  let resolve!: (answers: Record<string, string | string[]>) => void;
                  const promise = new Promise<Record<string, string | string[]>>((r) => { resolve = r; });
                  const deferred = {
                    toolName: toolBlock.name, toolUseId: toolBlock.id,
                    questions, resolve, promise,
                  };

                  yield {
                    type: 'system', subtype: 'question_required',
                    deferred,
                  } as any;

                  const answers = await promise;

                  const answer = answers['Proceed?'] as string;
                  let choice: string;
                  if (answer === 'Yes, auto-accept edits') {
                    execOpts.setPermissionMode?.('auto');
                    choice = 'auto-accept';
                  } else if (answer === 'Yes, manually approve edits') {
                    execOpts.setPermissionMode?.('ask');
                    choice = 'manual-approve';
                  } else {
                    choice = 'request-changes';
                  }
                  if (planState) {
                    planState.exitChoice = choice;
                    if (choice === 'request-changes') {
                      planState.needsRevisionPrompt = true;
                    }
                  }

                  toolBlock.input = { ...toolBlock.input, _exitAnswers: answers, _exitChoice: choice };
                }

                // Permission check + enqueue (same logic as streaming path above)
                if (!abortController.signal.aborted) {
                  const toolDef = toolRegistry.get(toolBlock.name)?.definition;
                  const staticRiskLevel = (toolDef?.riskLevel ?? RiskLevel.MUTATION) as RiskLevel;
                  const staticConcurrencySafe = toolDef?.isConcurrencySafe ?? false;

                  // Dynamic risk assessment for bash commands
                  const dynamic = resolveBashRiskLevel(
                    toolBlock.name,
                    toolBlock.input as Record<string, unknown>,
                    staticRiskLevel,
                    staticConcurrencySafe,
                  );
                  const effectiveRiskLevel = dynamic.riskLevel as RiskLevel;

                  // Inject dynamic classification into tool input for the executor
                  if (dynamic.classification) {
                    toolBlock.input = {
                      ...toolBlock.input,
                      _classification: dynamic.classification,
                    };
                  }

                  // Extract command content for content-aware permission rules
                  const cmdContent2 = extractRuleContent(
                    toolBlock.name,
                    toolBlock.input as Record<string, unknown>,
                  );

                  // ExitPlanMode is always auto-approved (handled above)
                  const permissionResult = toolBlock.name === 'ExitPlanMode'
                    ? { allowed: true, behavior: 'approve' as const }
                    : await permissionEngine.check(
                        {
                          toolName: toolBlock.name,
                          input: toolBlock.input,
                          riskLevel: effectiveRiskLevel,
                        },
                        toolDef,
                        cmdContent2,
                      );

                  if (hookManager && permissionResult.behavior !== 'approve' && toolBlock.name !== 'ExitPlanMode') {
                    const riskLevelStr = effectiveRiskLevel;
                    const { permissionOverride } = await hookManager.onPermissionRequest(
                      sessionId, cwd, toolBlock.name, toolBlock.input,
                      String(riskLevelStr), permissionResult.behavior,
                    );
                    if (permissionOverride === 'auto-approve') {
                      permissionResult.allowed = true;
                      permissionResult.behavior = 'approve';
                    } else if (permissionOverride === 'auto-deny') {
                      permissionResult.allowed = false;
                      permissionResult.behavior = 'deny';
                      permissionResult.reason = { type: 'hook', mode: 'auto-denied' };
                    }
                  }

                  if (!permissionResult.allowed && permissionResult.behavior === 'deny') {
                    const reason = typeof permissionResult.reason === 'string'
                      ? permissionResult.reason
                      : permissionResult.reason?.mode ?? 'Denied';
                    queue.storeError(toolBlock, reason);
                    hookManager?.onPermissionDenied(
                      sessionId, cwd, toolBlock.name, toolBlock.input, reason,
                    ).catch(() => {});
                  } else if (permissionResult.behavior === 'ask_user') {
                    const toolInput = toolBlock.input as Record<string, unknown>;
                    const command = [toolBlock.name, ...Object.entries(toolInput ?? {}).map(([k, v]) => `${k}=${String(v)}`)].join(' ');
                    const description =
                      permissionResult.prompt ??
                      toolDef?.description ??
                      `Execute ${toolBlock.name}`;

                    yield { type: 'system', subtype: 'progress', data: { toolName: toolBlock.name, toolUseId: toolBlock.id, status: 'started', message: 'Waiting for approval...' } };

                    let resolve!: (allowed: boolean) => void;
                    const promise = new Promise<boolean>((res) => { resolve = res; });
                    const deferred: DeferredPermission = {
                      toolName: toolBlock.name, command, description,
                      toolUseId: toolBlock.id,
                      toolInput: toolBlock.input as Record<string, unknown>,
                      resolve, promise,
                    };
                    yield { type: 'system', subtype: 'permission_required', deferred };

                    const allowed = await new Promise<boolean>((res) => {
                      promise.then((v) => res(v));
                      const onAbort = () => { res(false); };
                      abortController.signal.addEventListener('abort', onAbort, { once: true });
                    });

                    if (!allowed) {
                      queue.storeError(toolBlock, 'User denied permission');
                      hookManager?.onPermissionDenied(sessionId, cwd, toolBlock.name, toolBlock.input, 'User denied permission').catch(() => {});
                    } else {
                      queue.enqueue(toolBlock, (b) => executeSingleTool(b, execOpts));
                    }
                  } else {
                    queue.enqueue(toolBlock, (b) => executeSingleTool(b, execOpts));
                  }
                } else {
                  queue.storeError(toolBlock, 'Interrupted by user');
                }
              }
            }
          }
        }

        // Drain progress events after each event so TUI timers start promptly
        for (const pe of queue.drainProgress()) {
          yield { type: 'system', subtype: 'progress', data: pe };
        }
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));

      // ── Reactive Compact: context_too_large → compact + retry ──
      const classified = classifyError(err);
      if (classified.category === 'context_too_large' && !thisTurnDidReactiveCompact) {
        thisTurnDidReactiveCompact = true;
        hookManager?.onNotification(
          sessionId, cwd, 'warn',
          'Context too large — compacting and retrying...',
          { tokens: tokenCountWithEstimation(messages) },
        ).catch(() => {});

        messages = yield* runCompaction(
          messages,
          tokenCountWithEstimation(messages),
          contextBudget,
          { sessionId, cwd, hookManager, callModel, systemPrompt, permissionMode: permissionEngine.getMode(), planModeState: pm.current, readFileTracker, clearCaches },
          abortController.signal,
          compactFailures,
        );
        sessionManager.replaceMessages(messages);
        continue; // Retry the API call with compacted messages
      }

      const errMsg = err.message;
      for (const block of orderedBlocks) {
        const errorMsg = createUserMessage([createToolErrorResult(block.id, errMsg)]);
        messages.push(errorMsg);
        yield { type: 'user', message: errorMsg };
      }

      hookManager?.onStopFailure(sessionId, cwd, { message: errMsg, code: (error as { code?: string })?.code, status: (error as { status?: number })?.status }, turnCount).catch(() => {});

      yield {
        type: 'system',
        subtype: 'error',
        error: new AgentError(errMsg, 'API_ERROR', true),
      };
      return;
    }

    // Emit assistant messages
    for (const msg of assistantMessages) {
      yield { type: 'assistant', message: msg };
    }

    // Track cost
    totalCost += usage.totalCost ?? 0;
    if (usage.totalCost) {
      yield { type: 'stream_event', event: { type: 'cost_update', totalCost } };
    }

    sessionManager.updateUsage({
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
    });
    if (usage.totalCost) sessionManager.addCost(usage.totalCost);

    // Yield cumulative session token usage so sub-agents can forward
    // per-turn tokens to the TUI for real-time cost accumulation.
    const sessionUsage = sessionManager.getActive()?.tokenUsage;
    if (sessionUsage) {
      yield {
        type: 'system', subtype: 'progress',
        data: { tokenUsage: { ...sessionUsage } },
      };
    }

    // === Stop hook (end-of-turn) ===
    if (hookManager) {
      const recentMessages = messages.slice(-5).map((m) => ({
        role: m.role,
        summary: typeof m.content === 'string'
          ? m.content.slice(0, 200)
          : Array.isArray(m.content)
            ? m.content
                .map((b) =>
                  b.type === 'text'
                    ? (b.text ?? '').slice(0, 100)
                    : `[${b.type}]`,
                )
                .join('; ')
            : '',
      }));
      const { shouldStop } = await hookManager.onStop(
        sessionId,
        cwd,
        turnCount,
        recentMessages,
      );
      if (shouldStop) {
        hookManager.onNotification(
          sessionId, cwd, 'info',
          'Stop requested by hook',
          { turnCount },
        ).catch(() => {});
        yield {
          type: 'system',
          subtype: 'error',
          error: new AgentError('Stop requested by hook', 'HOOK_STOP'),
        };
        return;
      }
    }

    // === stop_reason is not tool_use → done ===
    if (stopReason !== 'tool_use' || orderedBlocks.length === 0) {
      return;
    }

    // === Wait for all queued tools to settle, draining progress as each completes ===
    // Poll the queue so the TUI receives completion progress events and stops
    // tool timers promptly, rather than waiting until every tool is done.
    const POLL_INTERVAL = 200;
    while (queue.runningCount > 0 || queue.pendingCount > 0) {
      for (const pe of queue.drainProgress()) {
        yield { type: 'system', subtype: 'progress', data: pe };
      }
      // Yield completed tool results immediately so the TUI can update
      // tool_use block states (stop timers, show results) without waiting
      // for all parallel tools to settle.
      for (const cr of queue.drainCompletedResults()) {
        yield {
          type: 'system',
          subtype: 'tool_completed',
          data: {
            toolUseId: cr.tool_use_id,
            duration: cr.duration,
            content: cr.content,
            isError: cr.is_error,
            metadata: cr.metadata,
          },
        };
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }

    // Drain any final progress events
    for (const pe of queue.drainProgress()) {
      yield { type: 'system', subtype: 'progress', data: pe };
    }

    // Assemble results in original parse order
    let toolResults: ToolResultBlock[] = orderedBlocks.map((block) =>
      queue.getResult(block.id) ?? createToolErrorResult(block.id, 'Tool execution skipped'),
    );

    // Apply per-result and per-message size limits
    toolResults = await applyToolResultLimits(
      toolResults,
      orderedBlocks.map((b) => b.name),
    );

    // === Auto-retry Listen when timed out with background tasks still running ===
    // Avoids wasted LLM round-trips where the model would just call Listen again.
    const MAX_AUTO_LISTEN_RETRIES = 10;
    const AUTO_LISTEN_DURATION_INCREMENT = 5;

    interface ListenAttempt {
      attempt: number;
      duration: number;
      actualDuration: number;
      wokeEarly: boolean;
      runningSummary: string;
    }

    const autoRetryNotifications: string[] = [];

    if (
      orderedBlocks.length === 1 &&
      orderedBlocks[0].name === 'Listen' &&
      toolResults.length === 1 &&
      !toolResults[0].is_error
    ) {
      const listenBlock = orderedBlocks[0];
      const firstResult = toolResults[0];
      const firstMeta = firstResult.metadata as Record<string, unknown> | undefined;
      const firstWokeEarly = firstMeta?.wokeEarly as boolean | undefined;
      const originalDuration = (listenBlock.input.duration as number) || 30;
      const reason = listenBlock.input.reason as string | undefined;

      if (!firstWokeEarly) {
        const attempts: ListenAttempt[] = [];
        let totalDuration = 0;
        let currentDuration = originalDuration;
        const reasonSuffix = reason ? ` ${reason}` : '';

        // Build incremental result content from current attempts list.
        // Each call produces a snapshot covering all attempts so far, so
        // the TUI can re-render the full list after every retry.
        const buildIncrementalResult = (): ToolResultBlock => {
          const attemptLines = attempts
            .map((a) => {
              const statusText = a.wokeEarly
                ? `completed${reasonSuffix}`
                : `timed out, ${a.runningSummary}`;
              return `  Attempt ${a.attempt}: ${a.actualDuration.toFixed(1)}s (${statusText})`;
            })
            .join('\n');
          const content =
            `Listened for ${totalDuration.toFixed(1)}s total over ${attempts.length} attempts:\n${attemptLines}`;
          return {
            ...firstResult,
            content,
            duration: Math.round(totalDuration * 1000),
            metadata: {
              ...firstMeta,
              attempts,
              totalDuration,
              retryCount: attempts.length - 1,
            },
          };
        };

        // Push an attempt snapshot to the TUI immediately so each row
        // appears as soon as that attempt finishes, not at the very end.
        async function* yieldAttemptSnapshot(willRetry: boolean): AsyncGenerator<QueryMessage> {
          const snapshot = buildIncrementalResult();
          yield {
            type: 'system',
            subtype: 'tool_completed',
            data: {
              toolUseId: listenBlock.id,
              duration: snapshot.duration,
              content: snapshot.content,
              isError: false,
              metadata: snapshot.metadata,
            },
          };
          // If another retry is coming, flip state back to executing so
          // the timer keeps running and the renderer stays in active mode.
          if (willRetry) {
            yield {
              type: 'system',
              subtype: 'progress',
              data: {
                toolName: 'Listen',
                toolUseId: listenBlock.id,
                status: 'running',
                message: `Auto-retry ${attempts.length + 1}/${MAX_AUTO_LISTEN_RETRIES + 1}...`,
              },
            };
          }
        }

        for (let attemptNum = 1; attemptNum <= MAX_AUTO_LISTEN_RETRIES + 1; attemptNum++) {
          if (attemptNum > 1) {
            const registry = config.subAgentRegistry;
            const hasRunningSubAgents = registry
              ? registry.list().filter(a => a.status === 'running').length > 0
              : false;
            const hasRunningBash = listTrackedTasks().filter(
              t => t.type === 'bash' && t.status === 'running',
            ).length > 0;

            if (!hasRunningSubAgents && !hasRunningBash) break;

            // Drain notifications — buffer them for injection later
            if (registry) {
              autoRetryNotifications.push(...registry.drainNotifications());
            }
            autoRetryNotifications.push(...drainTaskNotifications());

            if (autoRetryNotifications.length > 0) break;

            const syntheticBlock: ToolUseBlock = {
              type: 'tool_use',
              id: listenBlock.id,
              name: 'Listen',
              input: { duration: currentDuration, reason },
            };
            const retryResult = await executeSingleTool(syntheticBlock, execOpts);
            const retryMeta = retryResult.metadata as Record<string, unknown> | undefined;
            const retryWokeEarly = (retryMeta?.wokeEarly as boolean) || false;
            const retryActual = (retryMeta?.actualDuration as number) || currentDuration;

            totalDuration += retryActual;
            const runningSummary = getRunningSummary(config.subAgentRegistry);
            attempts.push({
              attempt: attemptNum,
              duration: currentDuration,
              actualDuration: retryActual,
              wokeEarly: retryWokeEarly,
              runningSummary,
            });

            const willRetry = !retryWokeEarly && attemptNum <= MAX_AUTO_LISTEN_RETRIES;
            yield* yieldAttemptSnapshot(willRetry);

            if (retryWokeEarly) break;

            currentDuration += AUTO_LISTEN_DURATION_INCREMENT;
          } else {
            // First attempt — reuse the already-executed result
            const firstActual = (firstMeta?.actualDuration as number) || originalDuration;
            totalDuration += firstActual;
            const runningSummary = getRunningSummary(config.subAgentRegistry);
            attempts.push({
              attempt: 1,
              duration: originalDuration,
              actualDuration: firstActual,
              wokeEarly: false,
              runningSummary,
            });

            // Yield first-attempt snapshot so the TUI shows it immediately
            const willRetry = attemptNum <= MAX_AUTO_LISTEN_RETRIES;
            yield* yieldAttemptSnapshot(willRetry);
          }
        }

        // Final aggregated result for message injection
        if (attempts.length > 1) {
          toolResults[0] = buildIncrementalResult();
        }
      }
    }

    // === PostToolBatch hook (non-blockable) ===
    if (hookManager && toolResults.length > 0) {
      const batchResults = toolResults.map((tr, i) => {
        const toolBlock = orderedBlocks[i];
        return {
          toolName: toolBlock?.name ?? 'unknown',
          success: !tr.is_error,
          durationMs: 0,
          summary: typeof tr.content === 'string' ? tr.content.slice(0, 200) : JSON.stringify(tr.content).slice(0, 200),
        };
      });
      hookManager.onPostToolBatch(sessionId, cwd, batchResults).catch(() => {});
    }

    // === Inject assistant + tool results in correct API order ===
    for (const am of assistantMessages) {
      messages.push(am);
    }

    const userMsg = createUserMessage(toolResults);
    messages.push(userMsg);
    yield { type: 'user', message: userMsg };

    // === Inject completed background agent + bash task results ===
    // Placed AFTER tool_use/tool_result pair to avoid breaking the API
    // requirement that tool_use blocks must have tool_result blocks in
    // the immediately following message.
    let notificationJustDrained = false;
    const allNotifications: string[] = [];
    // Workers don't need background notifications — those are for the
    // main agent only. A worker seeing another worker's
    // completion is noise that clutters its transcript.
    if (config.subAgentRegistry && agentRole !== 'worker') {
      allNotifications.push(...config.subAgentRegistry.drainNotifications());
    }
    allNotifications.push(...drainTaskNotifications());
    // Include notifications buffered during auto-retry
    if (autoRetryNotifications.length > 0) {
      allNotifications.push(...autoRetryNotifications);
    }

    // Drain team messages (mid-turn injection).
    // Team messages arrive during the LLM's tool-use loop (e.g. after Listen),
    // so they must be drained here, not just in submitMessage().
    // Always attempt — listTeams is a cheap readdir when no teams exist.
    const teamMsgBlocks: ContentBlock[] = [];
    try {
      const sDir = sessionDir(sessionId);
      const { listTeams } = await import('../teams/team-store.js');
      const { drainUnreadMessages: drainTeamMsgs } = await import('../teams/team-mailbox.js');
      const teamNames = await listTeams(sDir);
      for (const teamName of teamNames) {
        const msgs = await drainTeamMsgs(sDir, teamName, 'leader');
        if (msgs.length > 0) {
          const msgsText = msgs.map(m =>
            `[${m.from} → ${m.to}]: ${m.text}`
          ).join('\n');
          teamMsgBlocks.push({
            type: 'text' as const,
            text: '[Team messages]\n' + msgsText,
          });
        }
      }
    } catch { /* best-effort */ }

    // Inject team messages as a separate user message so they appear
    // distinctly from background notifications.
    if (teamMsgBlocks.length > 0) {
      const teamMsg = {
        role: 'user' as const,
        content: teamMsgBlocks,
      };
      messages.push(teamMsg);
      yield { type: 'user' as const, message: teamMsg };
      notificationJustDrained = true;
    }

    if (allNotifications.length > 0) {
      notificationJustDrained = true;
      const resultMsg = {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: '<background-agent-notifications>\n' + allNotifications.join('\n\n') + '\n</background-agent-notifications>',
          },
        ],
      };
      messages.push(resultMsg);
      yield { type: 'user' as const, message: resultMsg };
    }

    turnCount++;
    turnsSinceTaskReminder++;

    // ── Increment plan mode turn counter ───────────────────────
    if (pm.current && permissionEngine.getMode() === PermissionMode.PLAN) {
      incrementPlanModeTurn(pm.current);
    }

    // === Context compaction check ===
    const currentTokens = tokenCountWithEstimation(messages);
    if (autoCompactEnabled !== false && currentTokens / contextBudget > compactThreshold) {
      messages = yield* runCompaction(
        messages,
        currentTokens,
        contextBudget,
        {
          sessionId,
          cwd,
          hookManager,
          callModel,
          systemPrompt,
          permissionMode: permissionEngine.getMode(),
          planModeState: pm.current,
          readFileTracker,
          clearCaches,
        },
        abortController.signal,
        compactFailures,
      );
      // Sync compacted messages back to session so pre-compaction
      // tool results are released for GC.
      sessionManager.replaceMessages(messages);
    }
  }
}

// ---------------------------------------------------------------------------
// Compaction (extracted from the main loop for clarity)
// ---------------------------------------------------------------------------

export async function* runCompaction(
  messages: Message[],
  currentTokens: number,
  contextBudget: number,
  ctx: {
    sessionId: string;
    cwd: string;
    hookManager?: HookManager;
    callModel: (params: CallModelParams) => AsyncGenerator<StreamEvent | AssistantMessage>;
    systemPrompt: SystemPrompt;
    permissionMode: PermissionMode;
    planModeState: PlanModeState | null;
    readFileTracker?: import('./read-file-tracker.js').ReadFileTracker;
    clearCaches?: () => void;
    transcriptPath?: string;
  },
  signal: AbortSignal,
  compactFailures: { count: number },
  trigger: 'manual' | 'auto' = 'auto',
): AsyncGenerator<QueryMessage, Message[]> {
  const { sessionId, cwd, hookManager, callModel, systemPrompt, permissionMode, planModeState: pmState, readFileTracker, clearCaches, transcriptPath } = ctx;
  const MAX_AUTOCOMPACT_FAILURES = 3;
  const preCompactMessageCount = messages.length;

  // ── PreCompact hook ──────────────────────────────────────────────
  let injectContext = '';
  let hookCustomInstructions = '';
  if (hookManager) {
    try {
      const result = await hookManager.onPreCompact(
        sessionId,
        cwd,
        messages.length,
        currentTokens,
        contextBudget,
        trigger,
      );
      injectContext = result.injectContext;
      // Consume overrideStrategy as additional custom instructions
      hookCustomInstructions = result.overrideStrategy ?? '';
    } catch {
      // Hook failures are non-fatal during compaction
    }
  }

  if (injectContext) {
    const compactCtxMsg: Message = {
      role: 'system',
      content: `[PreCompact hook context]\n${injectContext}`,
    };
    messages.push(compactCtxMsg);
  }

  // ── Step 1: Micro Compact (time-based, zero API cost) ───────────
  // For manual /compact, run micro-compact but always continue to LLM.
  const compactor = new Compactor({
    estimateTokens,
    summarizeEnabled: false,
  });

  const lastUserInteractionTime = Date.now() - (messages.length * 30_000);

  const mcResult = await compactor.microcompact(messages, lastUserInteractionTime);
  const hasMicroCompact = mcResult.strategy !== 'none';

  if (hasMicroCompact && mcResult.savedTokens > 0) {
    messages = mcResult.messages;

    const afterMCTokens = tokenCountWithEstimation(messages);
    // Auto compact: exit early if microcompact brought us under threshold
    if (trigger === 'auto' && afterMCTokens / contextBudget <= 0.6) {
      const compactMeta: CompactMetadata = {
        beforeTokens: currentTokens,
        afterTokens: afterMCTokens,
        strategy: 'time_based',
      };
      yield {
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: compactMeta,
      };

      hookManager?.onNotification(
        sessionId,
        cwd,
        'info',
        `Micro-compacted: ${currentTokens} → ${afterMCTokens} tokens (${mcResult.strategy}, ${mcResult.removedCount} results cleared)`,
        {
          beforeTokens: currentTokens,
          afterTokens: afterMCTokens,
          strategy: mcResult.strategy,
        },
      ).catch(() => {});

      hookManager?.onPostCompact(
        sessionId,
        cwd,
        messages.length,
        messages.length,
        currentTokens - afterMCTokens,
        mcResult.strategy,
        currentTokens,
        afterMCTokens,
      ).catch(() => {});

      clearCaches?.();
      return messages;
    }
  }

  // ── Step 2: Session Memory Compact (zero API cost) ─────────────
  if (hasMicroCompact) {
    messages = mcResult.messages;
  }

  const smCompact = await trySessionMemoryCompact(cwd);
  if (smCompact) {
    const smSummary: Message = {
      role: 'user',
      content: smCompact.summaryContent,
    };

    const keepIndex = calculateMessagesToKeepIndex(messages);
    const keptMessages = keepIndex > 0 ? messages.slice(keepIndex) : messages;

    messages = [smSummary, ...keptMessages];

    const afterTokens = tokenCountWithEstimation(messages);
    // Auto compact: exit early if SM compact brought us under threshold
    if (trigger === 'auto' && afterTokens / contextBudget <= 0.7) {
      yield {
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: {
          beforeTokens: currentTokens,
          afterTokens,
          strategy: 'summarize',
          summaryText: smCompact.summaryContent,
        },
      };
      hookManager?.onNotification(
        sessionId, cwd, 'info',
        `Session-memory compacted: ${currentTokens} → ${afterTokens} tokens`,
        { beforeTokens: currentTokens, afterTokens },
      ).catch(() => {});
      compactFailures.count = 0;

      hookManager?.onPostCompact(
        sessionId,
        cwd,
        messages.length,
        messages.length,
        currentTokens - afterTokens,
        'summarize',
        currentTokens,
        afterTokens,
      ).catch(() => {});

      clearCaches?.();
      return messages;
    }
  }

  // ── Step 3: LLM Summarization Compact ───────────────────────────
  // Manual /compact always reaches here — the LLM is actually called.
  // Auto compact: skip if circuit breaker is tripped.
  if (trigger === 'manual' || compactFailures.count < MAX_AUTOCOMPACT_FAILURES) {
    const llmSignal = signal.aborted ? new AbortController().signal : signal;
    if (!llmSignal.aborted) {
      // Yield progress event so the TUI shows "Compacting conversation..."
      yield {
        type: 'system',
        subtype: 'compact_progress',
        data: {
          status: 'started',
          step: 'llm_summarize',
          message: 'Compacting conversation…',
        },
      };

      try {
        // Use streaming version so we can yield real-time text deltas
        const streamGen = streamCompactConversation(messages, callModel, {
          signal: llmSignal,
          preCompactTokens: currentTokens,
          model: 'auto',
          customInstructions: hookCustomInstructions || undefined,
          transcriptPath,
        });

        let accumulatedText = '';
        let streamResult = await streamGen.next();
        while (!streamResult.done) {
          accumulatedText += streamResult.value.text;
          yield {
            type: 'system',
            subtype: 'compact_progress',
            data: {
              status: 'streaming',
              step: 'llm_summarize',
              textDelta: accumulatedText,
            },
          };
          streamResult = await streamGen.next();
        }

        const llmResult: CompactionResult = streamResult.value;

        // Yield streaming-complete progress
        yield {
          type: 'system',
          subtype: 'compact_progress',
          data: {
            status: 'completed',
            step: 'llm_summarize',
            message: 'Summarization complete.',
          },
        };

        messages = [
          llmResult.boundaryMarker,
          ...llmResult.summaryMessages,
          ...(llmResult.messagesToKeep ?? []),
        ];

        // ── Post-compact restoration ─────────────────────────────
        if (readFileTracker) {
          const restoreMessages = collectPostCompactAttachments({
            readFileTracker,
            preservedMessages: llmResult.messagesToKeep,
            planModeState: pmState,
          });
          messages.push(...restoreMessages);
        }

        clearCaches?.();

        const afterTokens = tokenCountWithEstimation(messages);
        yield {
          type: 'system',
          subtype: 'compact_boundary',
          compactMetadata: {
            beforeTokens: currentTokens,
            afterTokens,
            strategy: 'summarize',
            summaryText: llmResult.summaryMessages[0]?.content as string ?? '',
          },
        };
        hookManager?.onNotification(
          sessionId, cwd, 'info',
          `LLM-compacted: ${currentTokens} → ${afterTokens} tokens (summarize)`,
          { beforeTokens: currentTokens, afterTokens },
        ).catch(() => {});
        compactFailures.count = 0;

        hookManager?.onPostCompact(
          sessionId,
          cwd,
          messages.length,
          messages.length,
          currentTokens - afterTokens,
          'summarize',
          currentTokens,
          afterTokens,
        ).catch(() => {});

        return messages;
      } catch (err) {
        compactFailures.count++;
        const errMsg = err instanceof Error ? err.message : String(err);
        hookManager?.onNotification(
          sessionId, cwd, 'warn',
          `LLM compaction failed: ${errMsg}`,
        ).catch(() => {});
        // Yield error so the TUI can show it
        yield {
          type: 'system',
          subtype: 'error',
          error: new AgentError(
            `LLM compaction failed: ${errMsg}`,
            'COMPACT_FAILED',
            true,
            err instanceof Error ? err : undefined,
          ),
        };
        if (compactFailures.count >= MAX_AUTOCOMPACT_FAILURES) {
          hookManager?.onNotification(
            sessionId, cwd, 'warn',
            `Auto-compact failed ${compactFailures.count} times — circuit breaker tripped. Use /compact to retry manually.`,
            { compactFailures: compactFailures.count },
          ).catch(() => {});
        }
      }
    }
  }

  // ── Step 4: Token-aware truncation (last resort) ─────────────────
  const prevCount = messages.length;
  const keepIndex = calculateMessagesToKeepIndex(messages);
  if (keepIndex > 0) {
    messages = messages.slice(keepIndex);
  }
  const droppedCount = prevCount - messages.length;

  const afterTokens = tokenCountWithEstimation(messages);

  const strategy: CompactMetadata['strategy'] = hasMicroCompact
    ? 'time_based'
    : 'token_snip';

  yield {
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: { beforeTokens: currentTokens, afterTokens, strategy },
  };

  hookManager?.onNotification(
    sessionId, cwd, 'info',
    `Context compacted: ${currentTokens} → ${afterTokens} tokens (${strategy}${droppedCount > 0 ? `, dropped ${droppedCount} messages` : ''})`,
    { beforeTokens: currentTokens, afterTokens, strategy, droppedMessages: droppedCount },
  ).catch(() => {});

  // ── PostCompact hook ──────────────────────────────────────────
  hookManager?.onPostCompact(
    sessionId,
    cwd,
    preCompactMessageCount,
    messages.length,
    currentTokens - afterTokens,
    strategy,
    currentTokens,
    afterTokens,
  ).catch(() => {});

  clearCaches?.();

  return messages;
}

// ---------------------------------------------------------------------------
// Post-compact context restoration
// ---------------------------------------------------------------------------

/**
 * Build file restoration messages after LLM compaction.
 * Re-injects recently read files (up to 5, capped per-file) so the model
 * retains awareness of codebase files it was working with.
 */
function buildFileRestoreContext(
  tracker: import('./read-file-tracker.js').ReadFileTracker,
): Message[] {
  const MAX_RESTORE_FILES = 5;
  const MAX_CHARS_PER_FILE = 20_000;
  const MAX_TOTAL_CHARS = 200_000;

  const recent = tracker.getRecent(MAX_RESTORE_FILES);
  if (recent.length === 0) return [];

  let totalChars = 0;
  const parts: string[] = [];

  for (const entry of recent) {
    const capped = entry.content.length > MAX_CHARS_PER_FILE
      ? entry.content.slice(0, MAX_CHARS_PER_FILE) + '\n... (truncated)'
      : entry.content;
    const available = MAX_TOTAL_CHARS - totalChars;
    if (available <= 0) break;
    const toInclude = capped.length > available ? capped.slice(0, available) : capped;
    parts.push(`## ${entry.path}\n\`\`\`\n${toInclude}\n\`\`\``);
    totalChars += toInclude.length;
  }

  if (parts.length === 0) return [];

  return [{
    role: 'system',
    content: `[Post-compact file restoration — recently read files]\n\n${parts.join('\n\n')}`,
  }];
}
