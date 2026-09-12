/**
 * Coderix Desktop — Preload Script
 *
 * Exposes a safe, typed API to the renderer process via contextBridge.
 * All IPC communication is channeled through ipcRenderer.invoke / ipcRenderer.on.
 *
 * Security: contextIsolation=true, nodeIntegration=false.
 * The renderer NEVER has direct access to Node.js or Electron APIs.
 */

import { contextBridge, ipcRenderer } from 'electron';

// ---------------------------------------------------------------------------
// Channel name constants — MUST stay in sync with ipc-bridge.ts
// ---------------------------------------------------------------------------

const CH = {
  // Request / Response (ipcRenderer.invoke)
  QUERY_SUBMIT: 'query:submit',
  QUERY_INTERRUPT: 'query:interrupt',
  SESSION_LIST: 'session:list',
  SESSION_GET: 'session:get',
  SESSION_LOAD: 'session:load',
  SESSION_FORK: 'session:fork',
  SESSION_DELETE: 'session:delete',
  PERMISSION_APPROVE: 'permission:approve',
  PERMISSION_APPROVE_SESSION: 'permission:approveSession',
  PERMISSION_APPROVE_ALWAYS: 'permission:approveAlways',
  PERMISSION_DENY: 'permission:deny',
  PERMISSION_SET_MODE: 'permission:setMode',
  FS_READ_FILE: 'fs:readFile',
  FS_WRITE_FILE: 'fs:writeFile',
  FS_LIST_DIR: 'fs:listDir',
  FS_WATCH: 'fs:watch',
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_DESTROY: 'terminal:destroy',
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_GET_MODEL_LIST: 'config:getModelList',
  CONFIG_TEST_CONNECTION: 'config:testConnection',
  APP_VERSION: 'app:version',
  APP_CHECK_UPDATE: 'app:checkUpdate',
  APP_QUIT: 'app:quit',

  // Push channels (main → renderer via ipcRenderer.on)
  STREAM_BLOCK_START: 'stream:blockStart',
  STREAM_BLOCK_DELTA: 'stream:blockDelta',
  STREAM_BLOCK_STOP: 'stream:blockStop',
  STREAM_TOOL_STATE: 'stream:toolState',
  STREAM_TOOL_RESULT: 'stream:toolResult',
  STREAM_DONE: 'stream:done',
  STREAM_ERROR: 'stream:error',
  STATE_PERMISSION_REQ: 'state:permissionReq',
  STATE_QUESTION_REQ: 'state:questionReq',
  STATE_TOKEN_USAGE: 'state:tokenUsage',
  STATE_COST_UPDATE: 'state:costUpdate',
  STATE_COMPACT: 'state:compact',
  FS_FILE_CHANGED: 'fs:fileChanged',
  WINDOW_FOCUS: 'window:focus',
  APP_UPDATE_AVAILABLE: 'app:updateAvailable',

  // Git
  GIT_STATUS: 'git:status',
  GIT_DIFF: 'git:diff',
  GIT_LOG: 'git:log',
  GIT_SHOW: 'git:show',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_COMMIT: 'git:commit',
  GIT_PUSH: 'git:push',
  GIT_PULL: 'git:pull',
  GIT_FETCH: 'git:fetch',
  GIT_DISCARD: 'git:discard',
  GIT_BRANCH_LIST: 'git:branch-list',
  GIT_CHECKOUT: 'git:checkout',
  GIT_BRANCH_DELETE: 'git:branch-delete',
  GIT_STASH_LIST: 'git:stash-list',
  GIT_STASH_SAVE: 'git:stash-save',
  GIT_STASH_POP: 'git:stash-pop',
  GIT_STASH_DROP: 'git:stash-drop',
  GIT_COMMIT_AMEND: 'git:commit-amend',
  GIT_STAGE_HUNK: 'git:stage-hunk',
  GIT_REVERT_HUNK: 'git:revert-hunk',
  GIT_SHOW_FILE: 'git:show-file',
  GIT_COMMIT_BODY: 'git:commit-body',
} as const;

// ---------------------------------------------------------------------------
// Stream event types (for onStreamEvent callback)
// ---------------------------------------------------------------------------

interface StreamBlockStart {
  type: 'blockStart';
  index: number;
  content_block: unknown;
}

interface StreamBlockDelta {
  type: 'blockDelta';
  index: number;
  delta: unknown;
}

interface StreamBlockStop {
  type: 'blockStop';
  index: number;
}

interface StreamToolState {
  type: 'toolState';
  toolUseId: string;
  toolName: string;
  state: string;
}

interface StreamToolResult {
  type: 'toolResult';
  toolUseId: string;
  result: unknown;
  metadata?: Record<string, unknown>;
}

interface StreamDone {
  type: 'done';
  stopReason: string;
  usage?: unknown;
  model?: string;
}

interface StreamError {
  type: 'error';
  message: string;
  code: string;
}

type StreamEventData =
  | StreamBlockStart
  | StreamBlockDelta
  | StreamBlockStop
  | StreamToolState
  | StreamToolResult
  | StreamDone
  | StreamError;

// ---------------------------------------------------------------------------
// Permission request type
// ---------------------------------------------------------------------------

interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  command: string;
  description: string;
}

// ---------------------------------------------------------------------------
// State change type
// ---------------------------------------------------------------------------

interface StateChange {
  type: 'tokenUsage' | 'costUpdate' | 'compact' | 'fileChanged' | 'focus' | 'updateAvailable';
  data: unknown;
}

// ---------------------------------------------------------------------------
// Helper: create an event listener with unsubscribe
// ---------------------------------------------------------------------------

function createEventListener(
  channels: readonly string[],
  callback: (event: StreamEventData) => void,
): () => void {
  const handlers: Array<{ channel: string; handler: (...args: unknown[]) => void }> = [];

  for (const channel of channels) {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
      const data = args[0] as Record<string, unknown>;

      switch (channel) {
        case CH.STREAM_BLOCK_START:
          callback({
            type: 'blockStart',
            index: (data?.index as number) ?? 0,
            content_block: data?.content_block,
          });
          break;
        case CH.STREAM_BLOCK_DELTA:
          callback({
            type: 'blockDelta',
            index: (data?.index as number) ?? 0,
            delta: data?.delta,
          });
          break;
        case CH.STREAM_BLOCK_STOP:
          callback({
            type: 'blockStop',
            index: (data?.index as number) ?? 0,
          });
          break;
        case CH.STREAM_TOOL_STATE:
          callback({
            type: 'toolState',
            toolUseId: (data?.toolUseId as string) ?? '',
            toolName: (data?.toolName as string) ?? '',
            state: (data?.state as string) ?? '',
          });
          break;
        case CH.STREAM_TOOL_RESULT:
          callback({
            type: 'toolResult',
            toolUseId: (data?.toolUseId as string) ?? '',
            result: data?.result,
          });
          break;
        case CH.STREAM_DONE:
          callback({
            type: 'done',
            stopReason: (data?.stopReason as string) ?? 'end_turn',
            usage: data?.usage,
            model: (data?.model as string | undefined),
          });
          break;
        case CH.STREAM_ERROR:
          callback({
            type: 'error',
            message: (data?.message as string) ?? 'Unknown error',
            code: (data?.code as string) ?? 'UNKNOWN',
          });
          break;
      }
    };

    ipcRenderer.on(channel, handler as (...args: unknown[]) => void);
    handlers.push({ channel, handler: handler as (...args: unknown[]) => void });
  }

  // Return unsubscribe function
  return () => {
    for (const { channel, handler } of handlers) {
      ipcRenderer.removeListener(channel, handler);
    }
  };
}

// ---------------------------------------------------------------------------
// The exposed API
// ---------------------------------------------------------------------------

const coderixAPI = {
  // ── Query ────────────────────────────────────────────────────────────

  query: {
    /**
     * Submit a user query to the AI engine.
     * @param query - The user's input message
     * @param sessionId - Optional session ID to route the query to
     */
    submit(query: string, sessionId?: string): Promise<{ status: string }> {
      return ipcRenderer.invoke(CH.QUERY_SUBMIT, { query, sessionId });
    },

    /**
     * Interrupt the currently running query.
     */
    interrupt(): Promise<{ status: string }> {
      return ipcRenderer.invoke(CH.QUERY_INTERRUPT);
    },
  },

  // ── Session ──────────────────────────────────────────────────────────

  session: {
    /** Create a new session. */
    create(opts?: { title?: string }): Promise<{ id: string; title: string; turnCount: number }> {
      return ipcRenderer.invoke('session:create', opts ?? {});
    },

    /** List all sessions. */
    list(): Promise<unknown[]> {
      return ipcRenderer.invoke(CH.SESSION_LIST);
    },

    /** Get a single session summary by ID. */
    get(sessionId: string): Promise<unknown> {
      return ipcRenderer.invoke(CH.SESSION_GET, sessionId);
    },

    /** Load a session by ID and set it as active. */
    load(sessionId: string): Promise<unknown> {
      return ipcRenderer.invoke(CH.SESSION_LOAD, sessionId);
    },

    /** Fork a session from an existing one. */
    fork(sessionId: string): Promise<unknown> {
      return ipcRenderer.invoke(CH.SESSION_FORK, sessionId);
    },

    /** Delete a session by ID. */
    delete(sessionId: string): Promise<{ status: string }> {
      return ipcRenderer.invoke(CH.SESSION_DELETE, sessionId);
    },
  },

  // ── Permission ───────────────────────────────────────────────────────

  permission: {
    /** Approve a permission request once. */
    approve(toolUseId: string): Promise<{ status: string }> {
      return ipcRenderer.invoke(CH.PERMISSION_APPROVE, toolUseId);
    },

    /** Approve for the current session. */
    approveSession(toolUseId: string): Promise<{ status: string }> {
      return ipcRenderer.invoke(CH.PERMISSION_APPROVE_SESSION, toolUseId);
    },

    /** Approve and persist (always allow). */
    approveAlways(toolUseId: string): Promise<{ status: string }> {
      return ipcRenderer.invoke(CH.PERMISSION_APPROVE_ALWAYS, toolUseId);
    },

    /** Deny a permission request. */
    deny(toolUseId: string): Promise<{ status: string }> {
      return ipcRenderer.invoke(CH.PERMISSION_DENY, toolUseId);
    },

    /** Set the global permission mode. */
    setMode(mode: 'auto' | 'ask' | 'plan'): Promise<{ mode: string }> {
      return ipcRenderer.invoke(CH.PERMISSION_SET_MODE, mode);
    },
  },

  // ── Question (AskUserQuestion) ─────────────────────────────────────

  question: {
    /** Answer a pending question from the engine. */
    answer(toolUseId: string, answers: Record<string, string | string[]>): Promise<{ status: string }> {
      return ipcRenderer.invoke('question:answer', { toolUseId, answers });
    },
  },

  // ── File System ──────────────────────────────────────────────────────

  fs: {
    /** Read a file's content. */
    readFile(filePath: string): Promise<{ content: string; path: string }> {
      return ipcRenderer.invoke(CH.FS_READ_FILE, filePath);
    },

    /** Write content to a file. */
    writeFile(path: string, content: string): Promise<{ status: string; path: string }> {
      return ipcRenderer.invoke(CH.FS_WRITE_FILE, { path, content });
    },

    /** List directory contents. */
    listDir(dirPath: string): Promise<{ path: string; entries: unknown[] }> {
      return ipcRenderer.invoke(CH.FS_LIST_DIR, dirPath);
    },

    /** Start watching a path for changes. Returns watcher ID. */
    watch(watchPath: string): Promise<{ watcherId: string; path: string }> {
      return ipcRenderer.invoke(CH.FS_WATCH, watchPath);
    },
  },

  // ── Terminal ─────────────────────────────────────────────────────────

  terminal: {
    /** Create a new terminal session. Returns terminal ID. */
    create(opts?: { cwd?: string; rows?: number; cols?: number }): Promise<{ terminalId: string }> {
      return ipcRenderer.invoke(CH.TERMINAL_CREATE, opts ?? {});
    },

    /** Write data to a terminal session. */
    write(sessionId: string, data: string): void {
      ipcRenderer.send(CH.TERMINAL_WRITE, { sessionId, data });
    },

    /** Resize a terminal session. */
    resize(sessionId: string, rows: number, cols: number): void {
      ipcRenderer.send(CH.TERMINAL_RESIZE, { sessionId, rows, cols });
    },

    /** Destroy a terminal session. */
    destroy(sessionId: string): void {
      ipcRenderer.send(CH.TERMINAL_DESTROY, { sessionId });
    },

    /**
     * Listen for terminal data events from a specific session.
     * Returns an unsubscribe function.
     */
    onData(sessionId: string, callback: (data: string) => void): () => void {
      const channel = `terminal:${sessionId}:data`;
      const handler = (_event: Electron.IpcRendererEvent, data: string) => {
        callback(data);
      };
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },

    /**
     * Listen for terminal exit events from a specific session.
     * Returns an unsubscribe function.
     */
    onExit(sessionId: string, callback: (exitCode: number) => void): () => void {
      const channel = `terminal:${sessionId}:exit`;
      const handler = (_event: Electron.IpcRendererEvent, exitCode: number) => {
        callback(exitCode);
      };
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },

  // ── Config ───────────────────────────────────────────────────────────

  config: {
    /** Get the current configuration. */
    get(): Promise<unknown> {
      return ipcRenderer.invoke(CH.CONFIG_GET);
    },

    /** Set a configuration value. */
    set(key: string, value: unknown): Promise<{ key: string; value: unknown; status: string }> {
      return ipcRenderer.invoke(CH.CONFIG_SET, { key, value });
    },

    /** Get the list of available AI models. */
    getModelList(): Promise<unknown[]> {
      return ipcRenderer.invoke(CH.CONFIG_GET_MODEL_LIST);
    },

    /** Probe a provider's baseUrl + apiKey and list its detected models. */
    testConnection(baseUrl: string, apiKey?: string): Promise<unknown> {
      return ipcRenderer.invoke(CH.CONFIG_TEST_CONNECTION, { baseUrl, apiKey });
    },

    /** Hot-reload QueryEngine with updated config (after model/API key change). */
    reload(): Promise<{ status: string }> {
      return ipcRenderer.invoke('config:reload');
    },
  },

  // ── Project ──────────────────────────────────────────────────────────

  project: {
    /** Get the current project directory. */
    get(): Promise<{ path: string }> {
      return ipcRenderer.invoke('project:get');
    },

    /** List recent project directories (most recent first). */
    list(): Promise<{ paths: string[] }> {
      return ipcRenderer.invoke('project:list');
    },

    /** Switch the active project directory to an existing path. */
    set(path: string): Promise<{ canceled: boolean; path: string }> {
      return ipcRenderer.invoke('project:set', path);
    },

    /** Select a new project directory. */
    select(): Promise<{ canceled: boolean; path: string }> {
      return ipcRenderer.invoke('project:select');
    },
  },

  // ── App ──────────────────────────────────────────────────────────────

  // ── Git ─────────────────────────────────────────────────────────────

  git: {
    /** Get git status: branch + changed files + commits with graph. */
    status(): Promise<{ branch: string; files: Array<{ file: string; type: string; code: string }>; commits: Array<{ hash: string; message: string; graph: string; refs: string }>; ahead: number; behind: number }> {
      return ipcRenderer.invoke(CH.GIT_STATUS);
    },
    /** Get diff for a working-tree or staged file. */
    diff(file: string, staged?: boolean): Promise<{ diff: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_DIFF, { file, staged });
    },
    /** Get commit history (currently unused in renderer). */
    log(maxCount?: number): Promise<{ commits: Array<{ hash: string; message: string; graph: string; refs: string }> }> {
      return ipcRenderer.invoke(CH.GIT_LOG, { maxCount });
    },
    /** Show a commit's details: full diff + changed files. */
    show(hash: string): Promise<{
      diff: string;
      files: Array<{ file: string; type: string }>;
      author: string;
      date: string;
      filesChanged: number;
      insertions: number;
      deletions: number;
      error?: string;
    }> {
      return ipcRenderer.invoke(CH.GIT_SHOW, { hash });
    },
    /** Get the full commit message body. */
    commitBody(hash: string): Promise<{ body: string }> {
      return ipcRenderer.invoke(CH.GIT_COMMIT_BODY, { hash });
    },
    /** Show a single file's content + diff from a specific commit. */
    showFile(hash: string, file: string): Promise<{ diff: string; content: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_SHOW_FILE, { hash, file });
    },
    /** Stage file(s). */
    stage(file?: string, all?: boolean): Promise<{ status: string }> {
      return ipcRenderer.invoke(CH.GIT_STAGE, { file, all });
    },
    /** Unstage file(s). */
    unstage(file?: string, all?: boolean): Promise<{ status: string }> {
      return ipcRenderer.invoke(CH.GIT_UNSTAGE, { file, all });
    },
    /** Create a commit with the given message. */
    commit(message: string): Promise<{ status: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_COMMIT, { message });
    },
    /** Push to remote. */
    push(opts?: { remote?: string; branch?: string; setUpstream?: boolean; force?: boolean; tags?: boolean }): Promise<{ status: string; output?: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_PUSH, opts);
    },
    /** Pull from remote. */
    pull(opts?: { remote?: string; branch?: string; rebase?: boolean }): Promise<{ status: string; output?: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_PULL, opts);
    },
    /** Fetch from remote. */
    fetch(opts?: { remote?: string; prune?: boolean; all?: boolean }): Promise<{ status: string; output?: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_FETCH, opts);
    },
    /** Discard changes to a file (irreversible). */
    discard(file: string): Promise<{ status: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_DISCARD, { file });
    },
    /** List all branches. */
    branchList(): Promise<{ branches: Array<{ name: string; hash: string; upstream: string; current: boolean }> }> {
      return ipcRenderer.invoke(CH.GIT_BRANCH_LIST);
    },
    /** Switch to a branch (or create and switch). */
    checkout(opts: { branch: string; create?: boolean; base?: string }): Promise<{ status: string; output?: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_CHECKOUT, opts);
    },
    /** Delete a branch. */
    branchDelete(branch: string, force?: boolean): Promise<{ status: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_BRANCH_DELETE, { branch, force });
    },
    /** List stashes. */
    stashList(): Promise<{ stashes: Array<{ ref: string; message: string; date: string }> }> {
      return ipcRenderer.invoke(CH.GIT_STASH_LIST);
    },
    /** Save changes to stash. */
    stashSave(opts?: { message?: string; includeUntracked?: boolean }): Promise<{ status: string; output?: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_STASH_SAVE, opts);
    },
    /** Pop latest stash (or specific ref). */
    stashPop(ref?: string): Promise<{ status: string; output?: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_STASH_POP, { ref });
    },
    /** Drop a stash. */
    stashDrop(ref?: string): Promise<{ status: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_STASH_DROP, { ref });
    },
    /** Amend the last commit. */
    commitAmend(message?: string): Promise<{ status: string; output?: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_COMMIT_AMEND, { message });
    },
    /** Stage a specific hunk via git apply --cached. */
    stageHunk(file: string, hunk: string): Promise<{ status: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_STAGE_HUNK, { file, hunk });
    },
    /** Revert a specific hunk via git apply --reverse. */
    revertHunk(file: string, hunk: string): Promise<{ status: string; error?: string }> {
      return ipcRenderer.invoke(CH.GIT_REVERT_HUNK, { file, hunk });
    },
  },

  app: {
    /** Get the application version. */
    getVersion(): Promise<string> {
      return ipcRenderer.invoke(CH.APP_VERSION);
    },

    /** Check for available updates. */
    checkUpdate(): Promise<{ updateAvailable: boolean; currentVersion?: string; version?: string; skipped?: boolean; reason?: string; error?: string }> {
      return ipcRenderer.invoke(CH.APP_CHECK_UPDATE);
    },

    /** Quit the application. */
    quit(): void {
      ipcRenderer.send(CH.APP_QUIT);
    },
  },

  // ── Event Subscriptions ──────────────────────────────────────────────

  /**
   * Subscribe to all stream events.
   * Returns an unsubscribe function.
   *
   * Events emitted:
   *   - { type: 'blockStart', index, content_block }
   *   - { type: 'blockDelta', index, delta }
   *   - { type: 'blockStop', index }
   *   - { type: 'toolState', toolUseId, toolName, state }
   *   - { type: 'toolResult', toolUseId, result }
   *   - { type: 'done', stopReason, usage?, model? }
   *   - { type: 'error', message, code }
   */
  onStreamEvent(callback: (event: StreamEventData) => void): () => void {
    return createEventListener(
      [
        CH.STREAM_BLOCK_START,
        CH.STREAM_BLOCK_DELTA,
        CH.STREAM_BLOCK_STOP,
        CH.STREAM_TOOL_STATE,
        CH.STREAM_TOOL_RESULT,
        CH.STREAM_DONE,
        CH.STREAM_ERROR,
      ],
      callback,
    );
  },

  /**
   * Subscribe to permission requests.
   * Returns an unsubscribe function.
   */
  onPermissionRequest(callback: (req: PermissionRequest) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: PermissionRequest) => {
      callback(data);
    };
    ipcRenderer.on(CH.STATE_PERMISSION_REQ, handler);
    return () => ipcRenderer.removeListener(CH.STATE_PERMISSION_REQ, handler);
  },

  /**
   * Subscribe to app state changes.
   * Returns an unsubscribe function.
   *
   * Events emitted:
   *   - { type: 'tokenUsage', data: { inputTokens, outputTokens, ... } }
   *   - { type: 'costUpdate', data: { totalCost, currency } }
   *   - { type: 'compact', data: unknown }
   *   - { type: 'fileChanged', data: FileChangeEvent }
   *   - { type: 'focus', data: { focused: boolean } }
   *   - { type: 'updateAvailable', data: unknown }
   */
  onStateChange(callback: (change: StateChange) => void): () => void {
    const stateChannels = [
      { channel: CH.STATE_TOKEN_USAGE, type: 'tokenUsage' as const },
      { channel: CH.STATE_COST_UPDATE, type: 'costUpdate' as const },
      { channel: CH.STATE_COMPACT, type: 'compact' as const },
      { channel: CH.FS_FILE_CHANGED, type: 'fileChanged' as const },
      { channel: CH.WINDOW_FOCUS, type: 'focus' as const },
      { channel: CH.APP_UPDATE_AVAILABLE, type: 'updateAvailable' as const },
    ];

    const handlers: Array<{ channel: string; handler: (...args: unknown[]) => void }> = [];

    for (const { channel, type } of stateChannels) {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
        callback({ type, data });
      };
      ipcRenderer.on(channel, handler as (...args: unknown[]) => void);
      handlers.push({ channel, handler: handler as (...args: unknown[]) => void });
    }

    return () => {
      for (const { channel, handler } of handlers) {
        ipcRenderer.removeListener(channel, handler);
      }
    };
  },

  /**
   * Subscribe to question requests from the engine.
   * Returns an unsubscribe function.
   */
  onQuestionRequest(
    callback: (req: { toolUseId: string; toolName: string; questions: Array<{ header: string; question: string; options?: Array<{ label: string; description: string }>; multiSelect?: boolean }> }) => void,
  ): () => void {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: { toolUseId: string; toolName: string; questions: Array<{ header: string; question: string; options?: Array<{ label: string; description: string }>; multiSelect?: boolean }> },
    ) => {
      callback(data);
    };
    ipcRenderer.on(CH.STATE_QUESTION_REQ, handler);
    return () => ipcRenderer.removeListener(CH.STATE_QUESTION_REQ, handler);
  },
};

// ---------------------------------------------------------------------------
// Expose to renderer
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld('coderixAPI', coderixAPI);

// ---------------------------------------------------------------------------
// Type augmentation for the renderer
// ---------------------------------------------------------------------------

// This type is declared here for reference; the actual .d.ts should be in
// src/renderer/types/ or src/preload/types.ts
export type CoderixAPI = typeof coderixAPI;
