#!/usr/bin/env node
/**
 * Coderix — CLI Entry Point
 *
 * Flags: --help, --version, --model, --setup, --print, --gateway
 *        --desktop [--desktop-port <port>]
 *        --chrome-mcp [--chrome-mcp-port <port>]
 *        --computer-use-mcp
 * Dynamic imports keep TUI deps (react/ink) out of gateway/print modes.
 */

import { loadConfig, loadSettings, getMaxToolConcurrency } from './config.js';
import type { ToolDefinition, ToolContext, ToolExecutionResult, QueryMessage, StreamEvent, PermissionMode } from '@coderix/core';

// ── CLI args ──────────────────────────────────────────────────────────

interface CliArgs {
  help: boolean;
  version: boolean;
  model?: string;
  setup: boolean;
  print?: string;
  query?: string;
  gateway: boolean;
  desktop: boolean;
  desktopPort?: number;
  acp: boolean;
  acpPort?: number;
  chromeMcp: boolean;
  chromeMcpPort?: number;
  computerUseMcp: boolean;
  sdk: boolean;
  resume?: string;       // undefined=not passed, ''=flag without value, string=session ID
  continueFlag: boolean; // -c / --continue
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    version: false,
    setup: false,
    gateway: false,
    desktop: false,
    acp: false,
    chromeMcp: false,
    computerUseMcp: false,
    sdk: false,
    continueFlag: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case '--help': case '-h': args.help = true; break;
      case '--version': case '-V': args.version = true; break;
      case '--model': case '-m': args.model = argv[i + 1]; if (args.model && !args.model.startsWith('-')) i++; else args.model = ''; break;
      case '--setup': case 'setup': args.setup = true; break;
      case '--gateway': case '-g': args.gateway = true; break;
      case '--desktop': case '-d': args.desktop = true; break;
      case '--desktop-port': args.desktopPort = parseInt(argv[i + 1]!, 10); if (!isNaN(args.desktopPort)) i++; break;
      case '--acp': args.acp = true; break;
      case '--acp-port': args.acpPort = parseInt(argv[i + 1]!, 10); if (!isNaN(args.acpPort)) i++; break;
      case '--print': case '-p': args.print = argv[i + 1] ?? ''; if (args.print) i++; break;
      case '--chrome-mcp': args.chromeMcp = true; break;
      case '--chrome-mcp-port': args.chromeMcpPort = parseInt(argv[i + 1]!, 10); if (!isNaN(args.chromeMcpPort)) i++; break;
      case '--computer-use-mcp': args.computerUseMcp = true; break;
      case '--sdk': args.sdk = true; break;
      case '--resume': case '-r': {
        const nextArg = argv[i + 1];
        if (nextArg && !nextArg.startsWith('-')) {
          args.resume = nextArg;
          i++;
        } else {
          args.resume = '';
        }
        break;
      }
      case '--continue': case '-c': args.continueFlag = true; break;
      default: if (!arg.startsWith('-') && !args.query) positional.push(arg); break;
    }
  }
  if (positional.length > 0) args.query = positional.join(' ');
  return args;
}

// ── Tool registry (shared) ──────────────────────────────────────────

async function buildToolRegistry(mcpPlugins?: any[]): Promise<any> {
  const { ToolRegistry } = await import('@coderix/core');
  const { plugins } = await import('@coderix/core');
  const { RiskLevel } = await import('@coderix/core');
  const registry = new ToolRegistry();

  // Collect all plugins: built-in + MCP
  const allPlugins = [...plugins, ...(mcpPlugins ?? [])];

  for (const plugin of allPlugins) {
    if (plugin.isEnabled && !plugin.isEnabled()) continue;
    const schema = plugin.schema as unknown as Record<string, unknown>;
    const inputSchema = schema.input_schema as Record<string, unknown>;
    const meta = schema._meta as { riskLevel?: string; isConcurrencySafe?: boolean } | undefined;
    const riskLevel = meta?.riskLevel === 'safe' ? RiskLevel.SAFE : meta?.riskLevel === 'destructive' ? RiskLevel.DESTRUCTIVE : RiskLevel.MUTATION;
    registry.register({ name: plugin.name, description: (schema.description as string) ?? plugin.name, input_schema: inputSchema, riskLevel, isConcurrencySafe: meta?.isConcurrencySafe ?? false },
      async (input: Record<string, unknown>, ctx: any) => {
        try {
          const r = await plugin.executor(input, {
            cwd: ctx.cwd ?? process.cwd(),
            allowMutation: true,
            maxOutput: 50_000,
            bashTimeout: ctx.timeoutMs ?? 30_000,
            agentSpawn: ctx.agentSpawn,
            sessionId: ctx.sessionId,
            getAppState: ctx.getAppState,
            setAppState: ctx.setAppState,
            setPermissionMode: ctx.setPermissionMode,
            getPermissionMode: ctx.getPermissionMode,
            planModeState: ctx.planModeState,
            readFileTracker: ctx.readFileTracker,
            toolUseId: ctx.toolUseId,
          });
          return { content: r.content, isError: r.isError, duration: r.duration, metadata: r.metadata };
        }
        catch (err) { return { content: `Tool error: ${(err as Error).message}`, isError: true }; }
      });
  }
  return registry;
}

// ── MCP initialization ─────────────────────────────────────────────────

async function initMcpAndGetPlugins(cwd: string): Promise<any[]> {
  try {
    const { McpManager } = await import('@coderix/core');
    const manager = new McpManager(cwd);
    await manager.initialize();
    const plugins = manager.getToolPlugins();
    const resourcePlugins = manager.getResourcePlugins();
    if (plugins.length > 0) {
      process.stderr.write(`[MCP] Loaded ${plugins.length} tool(s) from ${manager.getConnectedServerNames().length} server(s)\n`);
      const failed = manager.getFailedServerNames();
      if (failed.length > 0) {
        process.stderr.write(`[MCP] Warning: ${failed.length} server(s) failed to connect: ${failed.join(', ')}\n`);
      }
    }
    return [...plugins, ...resourcePlugins];
  } catch (err) {
    // MCP is optional — don't block startup on errors
    process.stderr.write(`[MCP] Initialization failed: ${(err as Error).message}\n`);
    return [];
  }
}

// ── Print mode ──────────────────────────────────────────────────────

async function runPrintMode(queryText: string): Promise<void> {
  let config; try { config = loadConfig(); } catch (err) { process.stderr.write(`Config error: ${(err as Error).message}\n`); process.exit(1); }
  const { createCallModel } = await import('@coderix/core');
  const callModel = createCallModel(config, config.model);
  const { SessionManager } = await import('@coderix/core');
  const sm = new SessionManager(); sm.create({ cwd: process.cwd(), model: config.model });
  const { setTaskListId } = await import('@coderix/core');
  setTaskListId(sm.getActive().id);
  const { SubAgentRegistry } = await import('@coderix/core');
  const { SystemPromptAssembler } = await import('@coderix/core');
  const { QueryEngine } = await import('@coderix/core');
  const { PermissionMode } = await import('@coderix/core');
  const { buildAgentRegistry } = await import('@coderix/core');
  const { registry: agentRegistry } = await buildAgentRegistry(process.cwd());
  const settings = loadSettings();
  const mcpPlugins = await initMcpAndGetPlugins(process.cwd());
  const engine = new QueryEngine({ cwd: process.cwd(), toolRegistry: await buildToolRegistry(mcpPlugins), sessionManager: sm, callModel, model: config.model, maxToolConcurrency: getMaxToolConcurrency(settings), subAgentRegistry: new SubAgentRegistry(), systemPromptAssembler: new SystemPromptAssembler(), agentRegistry, settings, maxContext: config.maxContext, briefMode: config.briefMode, autoCompactEnabled: config.autoCompactEnabled, compactThreshold: config.compactThreshold });
  await engine.init(); engine.setPermissionMode(PermissionMode.AUTO);
  let fullText = '';
  for await (const event of engine.submitMessage(queryText)) {
    if (event.type === 'message') {
      const msg = event.data as QueryMessage;
      if (msg.type === 'stream_event') { const se = msg.event as StreamEvent; if (se.type === 'content_block_delta' && se.delta?.type === 'text_delta') { fullText += se.delta.text!; process.stdout.write(se.delta.text!); } }
      else if (msg.type === 'assistant') { const blocks = msg.message?.content as any; if (blocks) for (const b of blocks) { if (b.type === 'text') { const t = b.text ?? b.content ?? ''; if (!fullText.includes(t)) { fullText += t; process.stdout.write(t); } } } }
    } else if (event.type === 'error') { process.stderr.write(`\n${(event.data as any)?.message ?? 'Error'}\n`); process.exit(1); }
  }
  if (fullText) process.stdout.write('\n'); process.exit(0);
}

// ── Session table (for --resume without TTY) ────────────────────────

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${days}d ago`;
}

function displayWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x2E80 && cp <= 0xA4CF || cp >= 0xAC00 && cp <= 0xD7A3 ||
        cp >= 0xF900 && cp <= 0xFAFF || cp >= 0xFE30 && cp <= 0xFE6F ||
        cp >= 0xFF01 && cp <= 0xFF60 || cp >= 0x20000 && cp <= 0x3FFFD ||
        cp >= 0x1F000 && cp <= 0x1FAFF) { width += 2; }
    else { width += 1; }
  }
  return width;
}

function padDisplayEnd(str: string, targetWidth: number): string {
  const dw = displayWidth(str);
  if (dw >= targetWidth) return str;
  return str + ' '.repeat(targetWidth - dw);
}

function truncateDisplay(str: string, maxWidth: number): string {
  if (displayWidth(str) <= maxWidth) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (displayWidth(str.slice(0, mid) + '...') <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return str.slice(0, lo) + '...';
}

function printSessionTable(sessions: Array<{ id: string; title: string; turnCount: number; model: string; updatedAt: Date; lastUserPreview?: string; workDir?: string }>): void {
  if (sessions.length === 0) {
    console.log('No previous sessions found.');
    return;
  }
  console.log('Recent sessions:\n');
  for (let i = 0; i < Math.min(sessions.length, 20); i++) {
    const s = sessions[i]!;
    const isAuto = /^Session [0-9a-f]{8}$/.test(s.title);
    const title = isAuto
      ? (s.lastUserPreview ?? '--')
      : truncateDisplay(s.title, 36);
    const empty = s.turnCount === 0 ? ' (empty)' : '';
    const turns = s.turnCount > 0 ? `${s.turnCount} turns` : '';
    const time = formatRelativeTime(s.updatedAt);
    const wd = shortWorkDir(s.workDir);
    console.log(
      `  ${String(i + 1).padEnd(3)} ${padDisplayEnd(title + empty, 36)}  ${turns.padEnd(10)} ${time.padEnd(14)} ${s.id.slice(0, 8)}     ${wd}`,
    );
  }
  console.log('\n  --resume <id>  resume a session');
  console.log('  --resume last  resume the most recent session\n');
}

function shortWorkDir(workDir?: string): string {
  if (!workDir) return '--';
  const home = process.env.HOME ?? '';
  let shortened = workDir;
  if (home && workDir.startsWith(home)) {
    shortened = '~' + workDir.slice(home.length);
  }
  if (shortened.length <= 50) return shortened;
  return '...' + shortened.slice(-47);
}

// ── Sub-agent restore ────────────────────────────────────────────────

interface RestoredAgent {
  agentId: string;
  agentType: string;
  messages: any[];
}

async function restoreSubAgents(
  subAgentIds: string[],
  subAgentRegistry: any,
  sessionDir: string,
): Promise<RestoredAgent[]> {
  const { findAgentOnDisk } = await import('@coderix/core');
  const restored: RestoredAgent[] = [];
  for (const agentId of subAgentIds) {
    try {
      const diskInfo = await findAgentOnDisk(agentId, sessionDir);
      if (!diskInfo) {
        process.stderr.write(`[restore] agent ${agentId.slice(0,8)}: NOT FOUND on disk\n`);
        continue;
      }
      const meta = diskInfo.meta;
      const transcript = diskInfo.transcript;
      subAgentRegistry.register({
        id: agentId,
        name: `${meta.agentType}-${agentId.slice(0, 8)}`,
        agentType: meta.agentType,
        status: 'done',
        prompt: meta.description ?? '',
        description: meta.displayDescription,
        createdAt: meta.createdAt,
        finishedAt: meta.finishedAt,
        turnCount: transcript?.filter((m: any) => m.role === 'assistant').length ?? 0,
        messageCount: transcript?.length ?? 0,
        toolCount: 0,
        abortController: new AbortController(),
        notified: true,
        transcript: transcript ?? [],
      });
      if (transcript && transcript.length > 0) {
        restored.push({
          agentId,
          agentType: meta.agentType,
          messages: transcript,
        });
      }
      process.stderr.write(`[restore] agent ${agentId.slice(0,8)}: registered (${meta.agentType}, ${transcript?.length ?? 0} msgs)\n`);
    } catch (e) {
      process.stderr.write(`[restore] agent ${agentId.slice(0,8)}: ERROR ${(e as Error).message}\n`);
      // Agent data missing or corrupted — skip
    }
  }
  return restored;
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cliArgs = parseCliArgs(process.argv.slice(2));

  // ── MCP subcommand (before help/version to allow `coderix mcp --help`) ─
  if (process.argv[2] === 'mcp') {
    const { handleMcpCli } = await import('./mcp-cli.js');
    await handleMcpCli(process.argv.slice(3));
    return;
  }

  // ── Built-in MCP server modes (subprocess entry points) ────────────
  if (cliArgs.chromeMcp) {
    const { runChromeMcpServer } = await import('@coderix/core');
    await runChromeMcpServer(cliArgs.chromeMcpPort);
    return;
  }

  if (cliArgs.computerUseMcp) {
    if (process.platform !== 'darwin') {
      console.error('Error: --computer-use-mcp is only supported on macOS.');
      process.exit(1);
    }
    const { runComputerUseMcpServer } = await import('@coderix/core');
    await runComputerUseMcpServer();
    return;
  }

  if (cliArgs.help) { console.log(`Usage: coderix [options] [query]\n\nOptions:\n  --help, -h            Show help\n  --version, -V         Print version\n  --model, -m [name]    Select model\n  --setup               Setup wizard\n  --print, -p <query>   One-shot query\n  --resume, -r [id]     Resume a session by ID, or open interactive picker\n  --continue, -c        Resume the most recent conversation\n  --gateway, -g         JSON-RPC gateway mode (stdin/stdout)\n  --desktop, -d         WebSocket gateway mode (for desktop app)\n  --desktop-port <port> WebSocket port for desktop mode (default 9754)\n  --chrome-mcp          Start Chrome MCP server (stdin/stdout)\n  --chrome-mcp-port <n> CDP port for Chrome (default 9222)\n  --computer-use-mcp    Start Computer Use MCP server (macOS)\n  --sdk                 SDK stream-json mode (stdin/stdout, for SDK clients)\n\nSubcommands:\n  mcp                   Manage MCP servers\n`); process.exit(0); }

  if (cliArgs.version) { const { readFileSync } = await import('node:fs'); const { join, dirname } = await import('node:path'); const { fileURLToPath } = await import('node:url'); const { detectShell } = await import('@coderix/core'); const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf-8')) as { version: string }; const shell = detectShell(); console.log(`coderix ${pkg.version}\nnode ${process.version}\n${process.platform} ${process.arch}\nshell ${shell.path} (${shell.type})`); process.exit(0); }

  if (cliArgs.model !== undefined || process.argv.includes('--model') || process.argv.includes('-m')) {
    const { handleModelFlag } = await import('./model-picker.js');
    const keep = setInterval(() => {}, 60000);
    try { await handleModelFlag(cliArgs.model || undefined); } finally { clearInterval(keep); }
    return;
  }

  if (cliArgs.setup || process.argv.includes('setup') || process.argv.includes('--setup')) {
    const { handleSetupFlag } = await import('./model-picker.js');
    const keep = setInterval(() => {}, 60000);
    try { await handleSetupFlag(); } finally { clearInterval(keep); }
  }

  const printQuery = cliArgs.print ?? cliArgs.query;
  if (printQuery) { await runPrintMode(printQuery); return; }

  // ── Gateway mode ──────────────────────────────────────────────
  if (cliArgs.gateway) { const { startGateway } = await import('../gateway/server.js'); await startGateway(); return; }

  // ── Desktop mode (WebSocket gateway for Tauri app) ────────────
  if (cliArgs.desktop) {
    const { startDesktopGateway } = await import('../gateway/desktop.js');
    const port = cliArgs.desktopPort ?? 9754;
    await startDesktopGateway({ port, cwd: process.cwd() });
    return;
  }

  if (cliArgs.acp) { const { startAcpServer } = await import('../acp/server.js'); await startAcpServer(cliArgs.acpPort); return; }

  // ── SDK mode (stream-json subprocess protocol) ──────────────
  if (cliArgs.sdk) { const { startSdkServer } = await import('../sdk/server.js'); await startSdkServer(); return; }

  // ── TUI mode ──────────────────────────────────────────────────
  let config; try { config = loadConfig(); } catch (err) { process.stderr.write(`Config error: ${(err as Error).message}\n`); process.exit(1); }
  const { createCallModel } = await import('@coderix/core');
  const callModel = createCallModel(config, config.model);
  const { SessionManager } = await import('@coderix/core');
  const sm = new SessionManager();
  let initialMessages: any[] | null = null;
  let initialTokenUsage: any = undefined;
  let showSessionPicker = false;
  let hasPreloadedSession = false;

  // ── Clean up incomplete sessions before resume ─────────────────
  if (cliArgs.continueFlag || cliArgs.resume !== undefined) {
    sm.cleanupIncompleteSessions();
  }

  // ── Handle --resume / --continue ──────────────────────────────
  if (cliArgs.continueFlag || cliArgs.resume !== undefined) {
    if (cliArgs.continueFlag) {
      try {
        const session = sm.continueLatest();
        if (session && session.messages.length > 0) {
          const { convertTranscriptToMessages: convert } = await import('../tui/hooks/useChatReducer.js');
          initialMessages = convert(session.messages);
          initialTokenUsage = {
            inputTokens: session.tokenUsage.inputTokens,
            outputTokens: session.tokenUsage.outputTokens,
            cacheCreationInputTokens: session.tokenUsage.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens: session.tokenUsage.cacheReadInputTokens ?? 0,
          };
          hasPreloadedSession = true;
        }
      } catch { /* no sessions exist, fall through to create new */ }
    } else if (cliArgs.resume === '') {
      // --resume without value
      if (!process.stdout.isTTY) {
        printSessionTable(sm.list());
        process.exit(0);
      }
      showSessionPicker = true;
    } else if (cliArgs.resume === 'last') {
      try {
        const list = sm.list();
        const last = list.find((s) => s.turnCount > 0);
        if (last) {
          sm.resume(last.id);
          const session = sm.getActive()!;
          if (session.messages.length > 0) {
            const { convertTranscriptToMessages: convert } = await import('../tui/hooks/useChatReducer.js');
            initialMessages = convert(session.messages);
            initialTokenUsage = {
            inputTokens: session.tokenUsage.inputTokens,
            outputTokens: session.tokenUsage.outputTokens,
            cacheCreationInputTokens: session.tokenUsage.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens: session.tokenUsage.cacheReadInputTokens ?? 0,
          };
            hasPreloadedSession = true;
          }
        }
      } catch { /* fall through */ }
    } else {
      try {
        sm.resume(cliArgs.resume!);
        const session = sm.getActive()!;
        if (session.messages.length > 0) {
          const { convertTranscriptToMessages: convert } = await import('../tui/hooks/useChatReducer.js');
          initialMessages = convert(session.messages);
          initialTokenUsage = {
            inputTokens: session.tokenUsage.inputTokens,
            outputTokens: session.tokenUsage.outputTokens,
            cacheCreationInputTokens: session.tokenUsage.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens: session.tokenUsage.cacheReadInputTokens ?? 0,
          };
          hasPreloadedSession = true;
        }
      } catch (e) {
        process.stderr.write(`Error: Session not found: ${cliArgs.resume}\n`);
        process.exit(1);
      }
    }
  }

  // Only create a new session if no session was loaded via resume
  if (!hasPreloadedSession) {
    sm.create({ cwd: process.cwd(), model: config.model });
  }
  const { setTaskListId } = await import('@coderix/core');
  setTaskListId(sm.getActive().id);

  // ── Create unified AppState store ──────────────────────────────────
  const { SubAgentRegistry } = await import('@coderix/core');
  const { SystemPromptAssembler } = await import('@coderix/core');
  const { QueryEngine } = await import('@coderix/core');
  const { buildAgentRegistry: buildAgentReg } = await import('@coderix/core');
  const { PermissionMode } = await import('@coderix/core');
  const subAgentRegistry = new SubAgentRegistry();
  const { setSubAgentRegistry } = await import('@coderix/core');
  setSubAgentRegistry(subAgentRegistry);
  const { registry: agentRegistry } = await buildAgentReg(process.cwd());

  // Restore sub-agents from disk for resumed sessions
  const activeSession = sm.getActive();
  if (activeSession?.metadata.subAgentIds?.length) {
    const { sessionDir: getSessionDir } = await import('@coderix/core');
    const sDir = getSessionDir(activeSession.id);
    const restoredAgents = await restoreSubAgents(activeSession.metadata.subAgentIds, subAgentRegistry, sDir);

    // Inject sub-agent transcripts into the main conversation view
    if (restoredAgents.length > 0 && initialMessages) {
      const { convertTranscriptToMessages: convert } = await import('../tui/hooks/useChatReducer.js');
      const enriched: any[] = [];
      for (const msg of initialMessages) {
        enriched.push(msg);
      }
      for (const agent of restoredAgents) {
        // Start boundary marker
        enriched.push({
          id: Date.now() + Math.random(),
          role: 'system' as const,
          content: `--- Sub-agent: ${agent.agentType} (${agent.agentId.slice(0, 8)}) ---`,
          blocks: [{
            type: 'subagent_boundary',
            agentId: agent.agentId,
            agentType: agent.agentType,
            boundary: 'start',
          }],
          timestamp: Date.now(),
        });
        // Agent messages
        const converted = convert(agent.messages);
        for (const am of converted) {
          enriched.push(am);
        }
        // End boundary marker
        enriched.push({
          id: Date.now() + Math.random(),
          role: 'system' as const,
          content: `--- End sub-agent: ${agent.agentType} ---`,
          blocks: [{
            type: 'subagent_boundary',
            agentId: agent.agentId,
            agentType: agent.agentType,
            boundary: 'end',
          }],
          timestamp: Date.now(),
        });
      }
      initialMessages = enriched;
    }
  }

  const settings = loadSettings();
  const mcpPluginsTui = await initMcpAndGetPlugins(process.cwd());
  // ── Create EventBus for core→UI communication ─────────────────────
  const { createEventBus } = await import('@coderix/core');
  const eventBus = createEventBus();

  const engine = new QueryEngine({ cwd: process.cwd(), toolRegistry: await buildToolRegistry(mcpPluginsTui), sessionManager: sm, callModel, model: config.model, maxToolConcurrency: getMaxToolConcurrency(settings), subAgentRegistry, systemPromptAssembler: new SystemPromptAssembler(), agentRegistry, settings, eventBus, maxContext: config.maxContext, briefMode: config.briefMode, autoCompactEnabled: config.autoCompactEnabled, compactThreshold: config.compactThreshold });
  await engine.init();
  engine.setPermissionMode((settings.default_permission_mode as PermissionMode) || 'ask');

  // ── Create unified AppState store ──────────────────────────────────
  const { createStore } = await import('@coderix/core');
  const { getDefaultAppState } = await import('../state/AppState.js');
  const { createInitialState } = await import('../tui/hooks/useChatReducer.js');
  const appStore = createStore(getDefaultAppState(
    config,
    createInitialState(config.model, config.inputPrice, config.outputPrice, config.cacheReadPrice),
    sm.getActive().id,
  ));

  // Wire EventBus → AppState sync for background tasks and agents
  const { createCoreEventBridge } = await import('../state/core-event-bridge.js');
  const bridge = createCoreEventBridge(eventBus, appStore);

  // Wire SubAgentRegistry → EventBus → AppState (Phase 4)
  // Must be after createCoreEventBridge so the bridge is subscribed
  // before setEmitter re-emits agent_register for restored agents.
  subAgentRegistry.setEmitter((req) => {
    eventBus.toolRequests.next(req);
  });

  // ── Persistence bridge (Phase 3) ──────────────────────────────────
  const { attachPersistence } = await import('../state/persistence-bridge.js');
  attachPersistence(appStore);

  const { renderSync } = await import('@coderix/ink');
  const { App } = await import('../tui/components/App.js');
  const { AppStateProvider } = await import('../state/AppStateContext.js');
  const { waitUntilExit, unmount } = renderSync(
    <AppStateProvider store={appStore}>
      <App config={config} engine={engine} store={appStore} sessionManager={sm} initialMessages={initialMessages} initialTokenUsage={initialTokenUsage} showSessionPicker={showSessionPicker} onExit={() => unmount()} />
    </AppStateProvider>,
    { exitOnCtrlC: false, patchConsole: true },
  );
  await waitUntilExit();
  // Belt-and-suspenders: restore terminal after Ink has fully torn down
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch { /* best-effort */ }
  // Let the process exit naturally so tsx watch can detect it cleanly
}

main().catch((err) => { process.stderr.write(`Error: ${(err as Error).message}\n`); process.exit(1); });
