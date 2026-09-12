/**
 * Coderix Desktop — Electron Main Process Entry Point
 */

import { app, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { createWindowManager } from './window-manager.js';
import type { WindowManager } from './window-manager.js';
import { createIpcBridge, getLastWorkspace } from './ipc-bridge.js';
import type { IpcBridge } from './ipc-bridge.js';
import { createFileWatcherManager } from './file-watcher.js';
import type { FileWatcherManager } from './file-watcher.js';
import { createTerminalManager } from './native-terminal.js';
import type { TerminalManager } from './native-terminal.js';
import { createTrayManager } from './tray-manager.js';
import type { TrayManager } from './tray-manager.js';
import { safeSend } from './safe-send.js';

// Direct imports from core package source — avoid @coderix/core bundle (pulls in node:sqlite)
import { QueryEngine } from '../../../../packages/coderix-core/src/core/query-engine.js';
import type { QueryEngineConfig } from '../../../../packages/coderix-core/src/core/query-engine.js';
import { SessionManager } from '../../../../packages/coderix-core/src/core/session.js';
import { ToolRegistry } from '../../../../packages/coderix-core/src/core/tool-registry.js';
import { createCallModel } from '../../../../packages/coderix-core/src/core/provider-adapter.js';
import { PermissionMode, loadSettings } from '../../../../packages/coderix-core/src/index.js';
import { loadConfig } from '../../../../packages/coderix-core/src/config.js';

// Tool schema + executor imports (avoid index.ts → renderers → React/ink)
import { schema as bashSchema } from '../../../../packages/coderix-core/src/tools/bash/schema.js';
import { execute as bashExec } from '../../../../packages/coderix-core/src/tools/bash/executor.js';
import { schema as readSchema } from '../../../../packages/coderix-core/src/tools/read/schema.js';
import { execute as readExec } from '../../../../packages/coderix-core/src/tools/read/executor.js';
import { schema as writeSchema } from '../../../../packages/coderix-core/src/tools/write/schema.js';
import { execute as writeExec } from '../../../../packages/coderix-core/src/tools/write/executor.js';
import { schema as updateSchema } from '../../../../packages/coderix-core/src/tools/update/schema.js';
import { execute as updateExec } from '../../../../packages/coderix-core/src/tools/update/executor.js';
import { schema as globSchema } from '../../../../packages/coderix-core/src/tools/glob/schema.js';
import { execute as globExec } from '../../../../packages/coderix-core/src/tools/glob/executor.js';
import { schema as grepSchema } from '../../../../packages/coderix-core/src/tools/grep/schema.js';
import { execute as grepExec } from '../../../../packages/coderix-core/src/tools/grep/executor.js';
import { schema as webFetchSchema } from '../../../../packages/coderix-core/src/tools/web-fetch/schema.js';
import { execute as webFetchExec } from '../../../../packages/coderix-core/src/tools/web-fetch/executor.js';
import { schema as webSearchSchema } from '../../../../packages/coderix-core/src/tools/web-search/schema.js';
import { execute as webSearchExec } from '../../../../packages/coderix-core/src/tools/web-search/executor.js';
import { schema as notebookEditSchema } from '../../../../packages/coderix-core/src/tools/notebook-edit/schema.js';
import { execute as notebookEditExec } from '../../../../packages/coderix-core/src/tools/notebook-edit/executor.js';
import { schema as listenSchema } from '../../../../packages/coderix-core/src/tools/listen/schema.js';
import { execute as listenExec } from '../../../../packages/coderix-core/src/tools/listen/executor.js';
import { schema as askUserSchema } from '../../../../packages/coderix-core/src/tools/ask-user-question/schema.js';
import { execute as askUserExec } from '../../../../packages/coderix-core/src/tools/ask-user-question/executor.js';
import { schema as enterPlanSchema } from '../../../../packages/coderix-core/src/tools/enter-plan-mode/schema.js';
import { execute as enterPlanExec } from '../../../../packages/coderix-core/src/tools/enter-plan-mode/executor.js';
import { schema as exitPlanSchema } from '../../../../packages/coderix-core/src/tools/exit-plan-mode/schema.js';
import { execute as exitPlanExec } from '../../../../packages/coderix-core/src/tools/exit-plan-mode/executor.js';
import { schema as taskOutputSchema } from '../../../../packages/coderix-core/src/tools/task-output/schema.js';
import { execute as taskOutputExec } from '../../../../packages/coderix-core/src/tools/task-output/executor.js';
import { schema as taskStopSchema } from '../../../../packages/coderix-core/src/tools/task-stop/schema.js';
import { execute as taskStopExec } from '../../../../packages/coderix-core/src/tools/task-stop/executor.js';
import { schema as enterWorktreeSchema } from '../../../../packages/coderix-core/src/tools/enter-worktree/schema.js';
import { execute as enterWorktreeExec } from '../../../../packages/coderix-core/src/tools/enter-worktree/executor.js';
import { schema as exitWorktreeSchema } from '../../../../packages/coderix-core/src/tools/exit-worktree/schema.js';
import { execute as exitWorktreeExec } from '../../../../packages/coderix-core/src/tools/exit-worktree/executor.js';

// ---------------------------------------------------------------------------
// Prevent multiple instances (single-instance lock)
// ---------------------------------------------------------------------------

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let windowManager: WindowManager | null = null;
let ipcBridge: IpcBridge | null = null;
let fileWatcher: FileWatcherManager | null = null;
let terminalManager: TerminalManager | null = null;
let trayManager: TrayManager | null = null;
let sessionManagerRef: SessionManager | null = null;
let activeWorkDir = process.cwd();
let activeModel = 'deepseek-v4-pro';

// ---------------------------------------------------------------------------
// Bootstrap sequence — create window FIRST before any heavy init
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  try {
    const initialConfig = loadConfig();
    // Restore the last-used workspace across restarts. `loadConfig().cwd` is
    // `process.cwd()` (the app's launch dir, e.g. `packages/coderix-desktop`),
    // which is never the project the user wants to reopen — fall back to it
    // only when there's no persisted workspace yet (first launch).
    activeWorkDir = getLastWorkspace() ?? initialConfig.cwd ?? process.cwd();
    activeModel = initialConfig.model;

    // Step 1: Create window manager
    windowManager = createWindowManager();

    // Step 2: Create SessionManager early so session IPC handlers work
    // before QueryEngine is initialized (renderer calls session:create on load)
    const sessionManager = new SessionManager();
    sessionManagerRef = sessionManager;

    // Restore the workspace from the most recently used session so a restart
    // reopens the project that session was working in (each session remembers
    // its own workspace), instead of the app's launch directory.
    try {
      const latest = sessionManager.list({ limit: 1 })[0];
      if (latest?.workDir && existsSync(latest.workDir)) {
        activeWorkDir = latest.workDir;
      }
    } catch {
      // No sessions yet — keep the global last-workspace / launch-dir fallback.
    }

    // Step 3: Create IPC bridge BEFORE window (renderer calls IPC on load)
    fileWatcher = createFileWatcherManager();
    terminalManager = createTerminalManager();
    ipcBridge = createIpcBridge({
      windowManager,
      fileWatcher,
      terminalManager,
      sessionManager,
      workDir: activeWorkDir,
      model: activeModel,
      reloadQueryEngine: (workDir) => initQueryEngine(workDir),
    });

    // Step 3: Create the window — this must happen before heavy init
    const mainWindow = windowManager.createMainWindow();
    if (!mainWindow) {
      throw new Error('Failed to create main window');
    }
    fileWatcher.setMainWindow(mainWindow);

    // Step 4: Set up system tray
    trayManager = createTrayManager();
    trayManager.create(() => windowManager?.getMainWindow() ?? null);

    // Step 5: Handle second-instance
    app.on('second-instance', () => {
      const win = windowManager?.getMainWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    });

    // Step 6: Handle open-file (macOS)
    app.on('open-file', (_event, filePath) => {
      safeSend(windowManager?.getMainWindow(), 'app:openFile', filePath);
    });

    console.log('[Coderix] Bootstrap complete');

    // Step 7: Defer QueryEngine init to avoid blocking renderer startup
    setTimeout(() => {
      initQueryEngine(activeWorkDir).catch((err) => {
        console.error('[Coderix] Failed to initialize query engine:', err);
      });
    }, 1000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Coderix] Bootstrap failed:', message);
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// QueryEngine initialization
// ---------------------------------------------------------------------------

async function initQueryEngine(workDir: string = activeWorkDir): Promise<void> {
  if (!ipcBridge) {
    throw new Error('IPC bridge not initialized');
  }

  activeWorkDir = workDir;
  const isReload = ipcBridge.queryEngine !== null;

  // Load config from ~/.coderix/settings.json
  const appConfig = loadConfig();
  const model = appConfig.model;
  const apiKey = appConfig.apiKey;
  const baseURL = appConfig.baseUrl;

  activeModel = model;
  console.log(`[Coderix] Config ${isReload ? 'reloaded' : 'loaded'}: model=${model}, baseURL=${baseURL}, apiKey=${apiKey.slice(0, 10)}...`);

  let callModel: QueryEngineConfig['callModel'];
  try {
    callModel = createCallModel(appConfig, model);
    console.log(`[Coderix] callModel initialized: model=${model}, baseURL=${baseURL}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Coderix] Failed to initialize Anthropic client:', message);
    callModel = (async function* (_params: unknown) {
      yield {
        type: 'message' as const,
        data: {
          type: 'assistant' as const,
          message: {
            content: `⚠️ **API 未配置**\n\n无法初始化模型客户端:\n\`\`\`\n${message}\n\`\`\`\n\n请在设置中配置 API Key。`,
            stop_reason: 'end_turn' as const,
            usage: { input_tokens: 0, output_tokens: 0 },
            model: 'system',
          },
        },
      } as unknown;
    }) as unknown as QueryEngineConfig['callModel'];
  }

  // Register built-in tools via direct schema+executor imports
  const toolRegistry = new ToolRegistry();
  const toolList: Array<{ schema: any; executor: any }> = [
    { schema: bashSchema, executor: bashExec },
    { schema: readSchema, executor: readExec },
    { schema: writeSchema, executor: writeExec },
    { schema: updateSchema, executor: updateExec },
    { schema: globSchema, executor: globExec },
    { schema: grepSchema, executor: grepExec },
    { schema: webFetchSchema, executor: webFetchExec },
    { schema: webSearchSchema, executor: webSearchExec },
    { schema: notebookEditSchema, executor: notebookEditExec },
    { schema: listenSchema, executor: listenExec },
    { schema: askUserSchema, executor: askUserExec },
    { schema: enterPlanSchema, executor: enterPlanExec },
    { schema: exitPlanSchema, executor: exitPlanExec },
    { schema: taskOutputSchema, executor: taskOutputExec },
    { schema: taskStopSchema, executor: taskStopExec },
    { schema: enterWorktreeSchema, executor: enterWorktreeExec },
    { schema: exitWorktreeSchema, executor: exitWorktreeExec },
  ];
  for (const t of toolList) {
    if (!t.schema || !t.executor) continue;
    const { name, description, input_schema } = t.schema;
    toolRegistry.register(
      { name, description, input_schema },
      async (input, ctx) => {
        const result = await t.executor(input, { cwd: ctx.cwd ?? activeWorkDir, allowMutation: true });
        return { content: String(result.content ?? ''), isError: result.isError ?? false };
      },
    );
  }
  console.log(`[Coderix] Registered ${toolRegistry.names.length} tools: ${toolRegistry.names.join(', ')}`);

  const config: QueryEngineConfig = {
    cwd: activeWorkDir,
    model,
    customSystemPrompt: undefined,
    sessionManager: sessionManagerRef!,
    toolRegistry: isReload ? undefined! : toolRegistry,
    callModel,
  };

  // Set the engine BEFORE re-initializing the QueryEngine so that an engine
  // switch (e.g. coderix → claude-code) takes effect even if the in-process
  // QueryEngine re-init below throws for any reason.
  ipcBridge.setEngine(appConfig.engine ?? 'coderix');

  await ipcBridge.initEngine(config);
  const settings = loadSettings();
  const permMode: PermissionMode = (settings.default_permission_mode as PermissionMode)
    ?? PermissionMode.ASK;
  if (ipcBridge.queryEngine) {
    ipcBridge.queryEngine.setPermissionMode(permMode);
    console.log(`[Coderix] Permission mode set to: ${permMode}`);
  }
  console.log('[Coderix] QueryEngine initialized');
}

// ---------------------------------------------------------------------------
// App lifecycle events
// ---------------------------------------------------------------------------

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (windowManager) {
    const existingWindow = windowManager.getMainWindow();
    if (existingWindow && !existingWindow.isDestroyed()) {
      existingWindow.show();
      existingWindow.focus();
    } else {
      windowManager.createMainWindow();
    }
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

app.on('before-quit', () => {
  console.log('[Coderix] Shutting down...');
  windowManager?.saveWindowState();
  ipcBridge?.destroy();
  fileWatcher?.destroy();
  terminalManager?.destroyAll();
  trayManager?.destroy();
  console.log('[Coderix] Shutdown complete');
});

// ---------------------------------------------------------------------------
// Unhandled error handling
// ---------------------------------------------------------------------------

process.on('uncaughtException', (error) => {
  console.error('[Coderix] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Coderix] Unhandled rejection:', reason);
});
