/**
 * engine-builder.ts — assemble a full QueryEngine from SDK Options.
 *
 * Replicates the bootstrap sequence the CLI already uses
 * (see packages/coderix-cli/src/cli/main.tsx `runPrintMode` and
 *  packages/coderix-cli/src/gateway/server.ts `startGateway`),
 * but parameterized by the claude-code-sdk-shaped `Options`.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  loadConfig,
  loadSettings,
  getMaxToolConcurrency,
  createCallModelFromClient,
  SessionManager,
  ToolRegistry,
  QueryEngine,
  SubAgentRegistry,
  SystemPromptAssembler,
  buildAgentRegistry,
  McpManager,
  connectToServer,
  discoverTools,
  plugins,
  RiskLevel,
  setTaskListId,
  toCorePermissionMode,
} from '@coderix/core';
import type {
  AppConfig,
  CoderSettings,
  ToolPlugin,
  ToolContext,
  ScopedServerConfig,
  SdkOptions as Options,
  SystemPromptConfig,
} from '@coderix/core';

export interface BuiltEngine {
  engine: QueryEngine;
  sessionManager: SessionManager;
  toolRegistry: ToolRegistry;
  config: AppConfig;
  model: string;
  settings: CoderSettings;
  cwd: string;
  mcpServerNames: string[];
  /** Close programmatic MCP connections + shut the engine down. */
  dispose: () => Promise<void>;
}

// ── Tool-name aliases (mirror core's TOOL_ALIASES for PascalCase input) ──

const TOOL_ALIASES: Record<string, string> = {
  task: 'agent',
  edit: 'update',
  'team-create': 'teamcreate',
  'team-message': 'sendmessage',
};

function normalizeToolName(name: string): string {
  const lower = name.toLowerCase();
  return TOOL_ALIASES[lower] ?? lower;
}

function toolAllowed(name: string, options: Options): boolean {
  const normalized = normalizeToolName(name);
  if (options.allowedTools && options.allowedTools.length > 0) {
    if (!options.allowedTools.map(normalizeToolName).includes(normalized)) return false;
  }
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    if (options.disallowedTools.map(normalizeToolName).includes(normalized)) return false;
  }
  return true;
}

// ── Tool registry ──────────────────────────────────────────────────────

function registerPlugin(registry: ToolRegistry, plugin: ToolPlugin): void {
  if (plugin.isEnabled && !plugin.isEnabled()) return;
  const schema = plugin.schema as unknown as Record<string, unknown>;
  const inputSchema = schema.input_schema as Record<string, unknown>;
  const meta = schema._meta as { riskLevel?: string; isConcurrencySafe?: boolean } | undefined;
  const riskLevel =
    meta?.riskLevel === 'safe' ? RiskLevel.SAFE :
    meta?.riskLevel === 'destructive' ? RiskLevel.DESTRUCTIVE :
    RiskLevel.MUTATION;

  registry.register(
    {
      name: plugin.name,
      description: (schema.description as string) ?? plugin.name,
      input_schema: inputSchema,
      riskLevel,
      isConcurrencySafe: meta?.isConcurrencySafe ?? false,
    },
    async (input: Record<string, unknown>, ctx: ToolContext) => {
      try {
        const executorOptions = {
          cwd: ctx.cwd ?? process.cwd(),
          allowMutation: true,
          maxOutput: 50_000,
          bashTimeout: ctx.timeoutMs ?? 30_000,
          agentSpawn: ctx.agentSpawn,
          sessionId: ctx.sessionId,
          setPermissionMode: ctx.setPermissionMode,
          getPermissionMode: ctx.getPermissionMode,
          planModeState: ctx.planModeState,
          getCoreState: ctx.getCoreState,
          emitToolRequest: ctx.emitToolRequest,
          toolUseId: ctx.toolUseId,
          readFileTracker: ctx.readFileTracker,
        };
        const r = await plugin.executor(input, executorOptions);
        return { content: r.content, isError: r.isError, duration: r.duration, metadata: r.metadata };
      } catch (err) {
        return { content: `Tool error: ${(err as Error).message}`, isError: true };
      }
    },
  );
}

async function buildToolRegistry(options: Options, cwd: string): Promise<{ registry: ToolRegistry; mcpServerNames: string[]; cleanup: Array<() => Promise<void>> }> {
  const registry = new ToolRegistry();
  const mcpServerNames: string[] = [];
  const cleanup: Array<() => Promise<void>> = [];

  // 1. Built-in plugins
  for (const plugin of plugins) {
    if (!toolAllowed(plugin.name, options)) continue;
    registerPlugin(registry, plugin);
  }

  // 2. MCP: programmatic servers (options.mcpServers) take precedence.
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    for (const [name, cfg] of Object.entries(options.mcpServers)) {
      const scoped = { ...cfg, scope: 'local' } as ScopedServerConfig;
      const conn = await connectToServer(name, scoped, cwd);
      if (conn.type === 'connected') {
        mcpServerNames.push(name);
        cleanup.push(conn.cleanup);
        const mcpPlugins = await discoverTools(conn);
        for (const p of mcpPlugins) {
          if (!toolAllowed(p.name, options)) continue;
          registerPlugin(registry, p);
        }
      } else if (conn.type === 'failed') {
        options.stderr?.(`[MCP] Failed to connect to "${name}": ${conn.error ?? 'unknown error'}\n`);
      }
    }
  } else {
    // 3. Disk-configured MCP servers (via McpManager)
    try {
      const manager = new McpManager(cwd);
      await manager.initialize();
      mcpServerNames.push(...manager.getConnectedServerNames());
      const mcpPlugins = [...manager.getToolPlugins(), ...manager.getResourcePlugins()];
      for (const p of mcpPlugins) {
        if (!toolAllowed(p.name, options)) continue;
        registerPlugin(registry, p);
      }
    } catch (err) {
      options.stderr?.(`[MCP] Initialization failed: ${(err as Error).message}\n`);
    }
  }

  return { registry, mcpServerNames, cleanup };
}

// ── System prompt ──────────────────────────────────────────────────────

function resolveSystemPrompt(sp: string | SystemPromptConfig | undefined): string | undefined {
  if (!sp) return undefined;
  if (typeof sp === 'string') return sp;
  if (sp.type === 'override') return sp.content;
  // 'preset' → use the engine's default system prompt (v1).
  return undefined;
}

// ── Bootstrap ──────────────────────────────────────────────────────────

export async function buildEngine(options: Options = {}): Promise<BuiltEngine> {
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig();
  const model = options.model ?? config.model;
  const settings = loadSettings();

  // Per-agent model binding: options.baseUrl/apiKey (injected by agentstation)
  // override the global ~/.coderix/settings.json endpoint/auth.
  const baseUrl = options.baseUrl ?? config.baseUrl;
  const apiKey = options.apiKey ?? config.apiKey;

  const client = new Anthropic({ baseURL: baseUrl, apiKey });
  const callModel = createCallModelFromClient(client, model);

  const sessionManager = new SessionManager();
  if (options.resume) {
    try {
      sessionManager.resume(options.resume);
    } catch {
      sessionManager.create({ cwd, model });
    }
  } else {
    sessionManager.create({ cwd, model });
  }
  setTaskListId(sessionManager.getActive()?.id ?? '');

  const { registry, mcpServerNames, cleanup } = await buildToolRegistry(options, cwd);

  const subAgentRegistry = new SubAgentRegistry();
  const systemPromptAssembler = new SystemPromptAssembler();
  const { registry: agentRegistry } = await buildAgentRegistry(cwd);

  const engine = new QueryEngine({
    cwd,
    toolRegistry: registry,
    sessionManager,
    callModel,
    model,
    maxToolConcurrency: getMaxToolConcurrency(settings),
    subAgentRegistry,
    systemPromptAssembler,
    agentRegistry,
    settings,
    maxContext: config.maxContext || undefined,
    briefMode: config.briefMode,
    autoCompactEnabled: config.autoCompactEnabled,
    compactThreshold: config.compactThreshold,
    maxTurns: options.maxTurns,
    customSystemPrompt: resolveSystemPrompt(options.systemPrompt),
    appendSystemPrompt: options.appendSystemPrompt,
  });

  await engine.init();
  engine.setPermissionMode(toCorePermissionMode(options.permissionMode));

  return {
    engine,
    sessionManager,
    toolRegistry: registry,
    config,
    model,
    settings,
    cwd,
    mcpServerNames,
    dispose: async () => {
      await Promise.allSettled(cleanup.map((fn) => fn()));
      await engine.shutdown();
    },
  };
}
