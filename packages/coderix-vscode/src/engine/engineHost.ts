/**
 * EngineHost — Direct QueryEngine integration (Phase 5)
 *
 * Replaces the sidecar subprocess model (VSCodeGatewayClient / AcpClient)
 * with a direct import of @coderix/core.  The QueryEngine runs in-process
 * inside the VS Code extension host, eliminating:
 *   - JSON-RPC serialization overhead
 *   - Subprocess management
 *   - Stdio line-buffer parsing
 *
 * Messages are mapped through the existing bridge layer:
 *   QueryEngineEvent → bridgeQueryToGateway() → gatewayToWebview()
 * so the webview protocol remains unchanged.
 */

import type { WebviewOutboundMessage } from '../types/webviewProtocol';
import { bridgeQueryToGateway, createBridgeState, resolveApproval, gatewayToWebview } from '../bridge/index.js';
import type { BridgeState, GatewayEvent } from '../bridge/index.js';

type MessageSender = (msg: WebviewOutboundMessage) => void;

export class EngineHost {
  private send: MessageSender;
  private engine: any = null;
  private sessionManager: any = null;
  private sessionId = '';
  private bridgeState: BridgeState;
  private model = '';
  private sessionTitleSet = false;
  private activeDeferred: any = null;

  constructor(send: MessageSender) {
    this.send = send;
    this.bridgeState = createBridgeState('');
  }

  private sendGatewayEvent(ev: GatewayEvent): void {
    for (const wm of gatewayToWebview(ev, this.sessionId)) {
      this.send(wm);
    }
  }

  private async ensureEngine(): Promise<void> {
    if (this.engine) return;

    const { workspace } = await import('vscode');
    const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const config = workspace.getConfiguration('coder');

    // ── Load @coderix/core dynamically ──────────────────────────────
    const {
      QueryEngine,
      SessionManager,
      ToolRegistry,
      SystemPromptAssembler,
      SubAgentRegistry,
      PermissionMode,
      loadConfig,
      loadSettings,
      getMaxToolConcurrency,
      plugins,
      buildAgentRegistry,
    } = await import('@coderix/core');

    // ── API client & callModel ──────────────────────────────────────
    const appConfig = loadConfig();
    const { createCallModel } = await import('@coderix/core');
    const callModel = createCallModel(appConfig, config.get<string>('model') || appConfig.model);

    // ── Session manager ─────────────────────────────────────────────
    this.sessionManager = new SessionManager();
    const session = this.sessionManager.create({
      cwd,
      model: config.get<string>('model') || appConfig.model,
    });
    this.sessionId = session.id;
    this.model = session.model;

    const { setTaskListId } = await import('@coderix/core');
    setTaskListId(session.id);

    // ── Tool registry ───────────────────────────────────────────────
    const { McpManager } = await import('@coderix/core');
    let mcpPlugins: any[] = [];
    try {
      const mcpManager = new McpManager(cwd);
      await mcpManager.initialize();
      mcpPlugins = [
        ...mcpManager.getToolPlugins(),
        ...mcpManager.getResourcePlugins(),
      ];
    } catch {
      // MCP is optional — don't block startup
    }

    const { RiskLevel } = await import('@coderix/core');
    const toolRegistry = new ToolRegistry();
    const allPlugins = [...plugins, ...mcpPlugins];

    for (const plugin of allPlugins) {
      const schema = plugin.schema as unknown as Record<string, unknown>;
      const inputSchema = schema.input_schema as Record<string, unknown>;
      const meta = schema._meta as { riskLevel?: string; isConcurrencySafe?: boolean } | undefined;
      const riskLevel =
        meta?.riskLevel === 'safe'
          ? RiskLevel.SAFE
          : meta?.riskLevel === 'destructive'
            ? RiskLevel.DESTRUCTIVE
            : RiskLevel.MUTATION;

      toolRegistry.register(
        {
          name: plugin.name,
          description: (schema.description as string) ?? plugin.name,
          input_schema: inputSchema,
          riskLevel,
          isConcurrencySafe: meta?.isConcurrencySafe ?? false,
        },
        async (input: Record<string, unknown>, ctx: any) => {
          try {
            const r = await plugin.executor(input, {
              cwd: ctx.cwd ?? cwd,
              allowMutation: true,
              maxOutput: 50_000,
              bashTimeout: ctx.timeoutMs ?? 30_000,
              agentSpawn: ctx.agentSpawn,
              sessionId: this.sessionId,
              setPermissionMode: ctx.setPermissionMode,
              getCoreState: ctx.getCoreState,
              emitToolRequest: ctx.emitToolRequest,
              toolUseId: ctx.toolUseId,
            });
            return { content: r.content, isError: r.isError, duration: r.duration, metadata: r.metadata };
          } catch (err) {
            return { content: `Tool error: ${(err as Error).message}`, isError: true };
          }
        },
      );
    }

    // ── Agents ──────────────────────────────────────────────────────
    const subAgentRegistry = new SubAgentRegistry();
    const { setSubAgentRegistry } = await import('@coderix/core');
    setSubAgentRegistry(subAgentRegistry);

    const { registry: agentRegistry } = await buildAgentRegistry(cwd);

    // ── Settings ────────────────────────────────────────────────────
    const settings = loadSettings();

    // ── Create engine ───────────────────────────────────────────────
    this.engine = new QueryEngine({
      cwd,
      toolRegistry,
      sessionManager: this.sessionManager,
      callModel,
      model: this.model,
      maxToolConcurrency: getMaxToolConcurrency(settings),
      subAgentRegistry,
      systemPromptAssembler: new SystemPromptAssembler(),
      agentRegistry,
      settings,
    });

    await this.engine.init();

    // Set initial permission mode from VS Code config
    const permMode = config.get<string>('permissionMode') ?? 'ask';
    this.engine.setPermissionMode(
      permMode === 'auto'
        ? PermissionMode.AUTO
        : permMode === 'plan'
          ? PermissionMode.PLAN
          : PermissionMode.ASK,
    );

    // Send ready status
    this.send({ type: 'statusUpdate', status: 'ready', message: `Ready — ${this.model}`, sessionId: this.sessionId });
    this.send({
      type: 'configUpdate',
      config: { model: this.model, provider: appConfig.provider ?? '', permissionMode: permMode as 'plan' | 'ask' | 'auto' },
    });
  }

  async submitPrompt(text: string): Promise<void> {
    try {
      await this.ensureEngine();
    } catch (err: any) {
      this.send({ type: 'errorMessage', message: `Engine init failed: ${err.message}` });
      return;
    }

    this.bridgeState = createBridgeState(this.sessionId);
    this.bridgeState.model = this.model;

    // Set session title from first message only
    if (!this.sessionTitleSet) {
      const title = text.length > 50 ? text.slice(0, 50) + '...' : text;
      this.send({ type: 'sessionSwitched', sessionId: this.sessionId, title });
      this.sessionTitleSet = true;
      // Persist title to session
      if (this.sessionManager) {
        const s = this.sessionManager.get(this.sessionId);
        if (s) {
          s.title = title;
          this.sessionManager.saveSession(s);
        }
      }
    }

    try {
      for await (const event of this.engine.submitMessage(text)) {
        switch (event.type) {
          case 'message': {
            const msg = event.data as any;
            // Route through existing bridge to produce GatewayEvent[]
            const gatewayEvents = bridgeQueryToGateway(msg, this.bridgeState);
            for (const ge of gatewayEvents) {
              this.sendGatewayEvent(ge);
            }
            break;
          }
          case 'done': {
            const data = event.data as any;
            if (data?.sessionId) {
              this.sessionId = data.sessionId;
            }
            // Forward usage collected during the turn
            const usage = this.bridgeState.usage;
            if (usage.inputTokens > 0 || usage.outputTokens > 0) {
              this.send({
                type: 'usageUpdate',
                usage: {
                  calls: 1,
                  input: usage.inputTokens,
                  output: usage.outputTokens,
                  cache: usage.cacheCreationInputTokens + usage.cacheReadInputTokens,
                  total: usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens,
                  cost_usd: usage.totalCost,
                },
                contextWindow: data?.contextWindow,
                sessionId: this.sessionId,
              });
            }
            break;
          }
          case 'cost': {
            const data = event.data as any;
            this.send({
              type: 'usageUpdate',
              usage: {
                calls: this.bridgeState.usage.inputTokens > 0 ? 1 : 0,
                input: this.bridgeState.usage.inputTokens,
                output: this.bridgeState.usage.outputTokens,
                cache: this.bridgeState.usage.cacheCreationInputTokens + this.bridgeState.usage.cacheReadInputTokens,
                total: this.bridgeState.usage.totalCost > 0
                  ? (this.bridgeState.usage.inputTokens + this.bridgeState.usage.outputTokens)
                  : (data?.inputTokens ?? 0) + (data?.outputTokens ?? 0),
                cost_usd: data?.totalCost ?? this.bridgeState.usage.totalCost,
              },
              contextWindow: data?.contextWindow,
              sessionId: this.sessionId,
            });
            break;
          }
          case 'compact': {
            const data = event.data as any;
            this.send({
              type: 'usageUpdate',
              usage: {
                calls: 0,
                input: data?.metadata?.beforeTokens ?? this.bridgeState.usage.inputTokens,
                output: this.bridgeState.usage.outputTokens,
                cache: 0,
                total: data?.metadata?.afterTokens ?? (this.bridgeState.usage.inputTokens + this.bridgeState.usage.outputTokens),
              },
              contextWindow: data?.metadata?.contextWindow,
              sessionId: this.sessionId,
            });
            break;
          }
          case 'question_required': {
            const deferred = (event as any).deferred as any;
            if (deferred) {
              this.send({
                type: 'questionRequest',
                requestId: deferred.toolUseId,
                toolName: deferred.toolName,
                questions: deferred.questions,
              } as any);
              // Wait for user response via resolveQuestion
              this.activeDeferred = deferred;
              await deferred.promise;
              this.activeDeferred = null;
            }
            break;
          }
          case 'error': {
            const data = event.data as any;
            this.send({ type: 'errorMessage', message: data?.message ?? 'Unknown error' });
            this.send({ type: 'statusUpdate', status: 'error', message: data?.message ?? 'Error', sessionId: this.sessionId });
            break;
          }
        }
      }

      this.send({ type: 'statusUpdate', status: 'ready', sessionId: this.sessionId });
    } catch (err: any) {
      this.send({ type: 'errorMessage', message: err.message || String(err) });
      this.send({ type: 'statusUpdate', status: 'error', message: 'Error', sessionId: this.sessionId });
    }
  }

  async interrupt(): Promise<void> {
    try {
      this.engine?.interrupt();
    } catch {
      // best-effort
    }
  }

  async createSession(_silent?: boolean): Promise<void> {
    await this.ensureEngine();
    this.sessionTitleSet = false;
    const session = this.sessionManager?.create({
      cwd: this.engine?.config?.cwd ?? process.cwd(),
      model: this.model,
    });
    if (session) {
      this.sessionId = session.id;
      this.send({ type: 'sessionHistory', messages: [], sessionId: session.id });
      this.send({ type: 'sessionSwitched', sessionId: session.id, title: session.title || 'Untitled' });
      this.listSessions();
    }
  }

  async resumeSession(id: string): Promise<void> {
    await this.ensureEngine();
    this.sessionTitleSet = true; // resumed session already has a title
    try {
      const session = this.sessionManager?.resume(id);
      if (session) {
        this.sessionId = id;
        const messages = (session.messages ?? []).map((m: any) => ({
          role: m.role,
          text: typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('')
              : String(m.content ?? ''),
        }));
        this.send({ type: 'sessionHistory', messages, sessionId: id });
        this.send({ type: 'sessionSwitched', sessionId: id, title: session.title || 'Untitled' });
        this.send({ type: 'statusUpdate', status: 'ready', message: 'Session resumed', sessionId: id });
      }
    } catch (err: any) {
      this.send({ type: 'errorMessage', message: err.message });
    }
  }

  listSessions(): void {
    try {
      const sessions = this.sessionManager?.list() ?? [];
      this.send({
        type: 'sessionList',
        sessions: sessions.map((s: any) => ({
          id: s.id,
          title: s.title,
          messageCount: s.turnCount ?? s.messageCount,
          startedAt: s.createdAt ?? s.updatedAt,
        })),
      });
    } catch {
      // best-effort
    }
  }

  handleApproval(requestId: string, allowed: boolean): void {
    const toolName = resolveApproval(this.bridgeState, requestId, allowed);
    if (toolName) {
      this.sendGatewayEvent({
        type: 'status.update',
        payload: { text: `${allowed ? 'Approved' : 'Denied'} ${toolName}` },
        session_id: this.sessionId,
      } as GatewayEvent);
    }
  }

  resolveQuestion(_requestId: string, answers: Record<string, string>): void {
    if (this.activeDeferred) {
      this.activeDeferred.resolve(answers);
      this.activeDeferred = null;
    }
  }

  setPermissionMode(mode: 'plan' | 'ask' | 'auto'): void {
    if (!this.engine) return;
    const { PermissionMode } = require('@coderix/core');
    const permMode = mode === 'auto' ? PermissionMode.AUTO : mode === 'plan' ? PermissionMode.PLAN : PermissionMode.ASK;
    this.engine.setPermissionMode(permMode);
    this.send({ type: 'configUpdate', config: { model: this.model, provider: '', permissionMode: mode } });
  }

  dispose(): void {
    this.engine = null;
    this.sessionManager = null;
  }
}
