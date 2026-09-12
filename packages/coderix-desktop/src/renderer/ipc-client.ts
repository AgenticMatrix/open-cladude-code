/**
 * Coderix Desktop — IPC Client (Adaptation Layer)
 *
 * Bridges the preload's nested `window.coderixAPI.*` to the flat functional
 * API used by stores and components. Handles type mapping between the
 * preload's event shapes and the renderer's TypeScript types.
 *
 * Architecture:
 *   Preload (window.coderixAPI.xxx.yyy)  ←→  ipc-client.ts  ←→  Stores / Components
 *                    ↑                              ↑                      ↑
 *           contextBridge API               Adaptation layer         submitQuery(), etc.
 */

import type { StreamBlock, PermissionRequest, TokenUsage, SessionInfo } from './types.js';

export interface QuestionRequest {
  toolUseId: string;
  toolName: string;
  questions: Array<{
    header: string;
    question: string;
    options?: Array<{ label: string; description: string }>;
    multiSelect?: boolean;
  }>;
}

// ---------------------------------------------------------------------------
// Safety: Preload API Guard
// ---------------------------------------------------------------------------

/**
 * The `window.coderixAPI` object is injected by the preload script via
 * `contextBridge.exposeInMainWorld`. In development mode, there is a race
 * condition between React's initial render and the preload script loading.
 *
 * If the API is not yet available, all calls MUST fail gracefully instead
 * of throwing a TypeError that crashes the renderer.
 */
function getAPI(): NonNullable<typeof window.coderixAPI> {
  if (!window.coderixAPI) {
    throw new Error(
      '[IPC] window.coderixAPI is not available — the preload script has not loaded yet. ' +
        'This is expected during the initial render frame in development mode.',
    );
  }
  return window.coderixAPI;
}

/** No-op unsubscribe for when the preload API is unavailable. */
const NOOP_UNSUB = (): void => {};

// ---------------------------------------------------------------------------
// Timeout Configuration
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

async function invokeWithTimeout<T>(
  channel: string,
  fn: () => Promise<unknown>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`IPC call "${channel}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    ),
  );
  const result = await Promise.race([fn(), timeout]);
  return result as T;
}

// ===========================================================================
//  Query & Streaming
// ===========================================================================

/** Submit a user query to the AI engine. */
export async function submitQuery(query: string, sessionId?: string): Promise<unknown> {
  return invokeWithTimeout('query:submit', () =>
    getAPI().query.submit(query, sessionId),
  );
}

/** Interrupt the active query in the main process. */
export async function interruptQuery(): Promise<unknown> {
  return invokeWithTimeout('query:interrupt', () =>
    getAPI().query.interrupt(),
  );
}

/**
 * Subscribe to streaming content blocks.
 *
 * The preload emits raw stream events (blockStart / blockDelta / blockStop /
 * toolState / toolResult) via `onStreamEvent`. This function accumulates them
 * into `StreamBlock` objects and emits each update via the callback.
 *
 * Returns an unsubscribe function.
 */
export function onStreamBlock(callback: (block: StreamBlock) => void): () => void {
  // Guard: preload may not have loaded yet during initial React mount
  if (!window.coderixAPI) {
    console.error('[IPC] window.coderixAPI is not available — preload may not have loaded');
    return NOOP_UNSUB;
  }

  // Internal map: stream index → partially built StreamBlock
  const blockMap = new Map<number, StreamBlock>();

  const unsub = window.coderixAPI.onStreamEvent((event: any) => {
    switch (event.type) {
      // ── Block Start ──────────────────────────────────────────
      case 'blockStart': {
        const cb = event.content_block as {
          type?: string;
          name?: string;
          id?: string;
          tool_use_id?: string;
          input?: Record<string, unknown>;
        };
        const rendererType = mapBlockType(cb.type);

        const block: StreamBlock = {
          type: rendererType,
          state: 'pending',
        };

        if (cb.type === 'tool_use') {
          block.toolName = cb.name;
          block.toolId = cb.id;
          if (cb.input && Object.keys(cb.input).length > 0) {
            block.toolInput = cb.input;
          }
        } else if (cb.type === 'tool_result') {
          block.toolId = cb.tool_use_id;
        }

        blockMap.set(event.index, block);
        // Emit initial block (stores need the ID for tool_use correlation)
        callback({ ...block });
        break;
      }

      // ── Block Delta ──────────────────────────────────────────
      case 'blockDelta': {
        const existing = blockMap.get(event.index);
        if (!existing) break;

        const delta = event.delta as {
          text?: string;
          partial_json?: string;
          thinking?: string;
        };

        // Accumulate text content
        if (delta.text !== undefined) {
          existing.content = (existing.content ?? '') + delta.text;
        } else if (delta.thinking !== undefined) {
          existing.content = (existing.content ?? '') + delta.thinking;
        } else if (delta.partial_json !== undefined) {
          // For tool_use, accumulate partial JSON as input string
          const prev = (existing.toolInput as { __raw?: string })?.__raw ?? '';
          existing.toolInput = { __raw: prev + delta.partial_json };
        }

        callback({ ...existing });
        break;
      }

      // ── Block Stop ───────────────────────────────────────────
      case 'blockStop': {
        const existing = blockMap.get(event.index);
        if (!existing) break;

        existing.state = 'done';

        // Parse accumulated input_json_delta into the real tool input object
        if (existing.type === 'tool_use') {
          const raw = (existing.toolInput as { __raw?: string } | undefined)?.__raw;
          if (raw) {
            try {
              existing.toolInput = JSON.parse(raw);
            } catch {
              // Malformed JSON — keep as-is
            }
          }
        }

        callback({ ...existing });
        blockMap.delete(event.index);
        break;
      }

      // ── Tool State (from execution lifecycle) ────────────────
      case 'toolState': {
        const stateMap: Record<string, StreamBlock['state']> = {
          pending: 'pending',
          executing: 'executing',
          done: 'done',
          error: 'error',
        };

        // Find the tool_use block by toolUseId
        for (const [, block] of blockMap) {
          if (block.toolId === event.toolUseId) {
            block.state = stateMap[event.state] ?? 'pending';
            if (event.toolName) block.toolName = event.toolName;
            callback({ ...block });
            break;
          }
        }
        break;
      }

      // ── Tool Result ──────────────────────────────────────────
      case 'toolResult': {
        const resultBlock: StreamBlock = {
          type: 'tool_result',
          toolId: event.toolUseId,
          content:
            typeof event.result === 'string'
              ? event.result
              : JSON.stringify(event.result),
          state: 'done',
          toolMetadata: (event as any).metadata as Record<string, unknown> | undefined,
        };
        callback(resultBlock);
        break;
      }

      // done / error are handled by separate callbacks below
      default:
        break;
    }
  });

  return unsub;
}

/**
 * Map Anthropic content block types to renderer StreamBlock types.
 */
function mapBlockType(
  anthropicType: string | undefined,
): StreamBlock['type'] {
  switch (anthropicType) {
    case 'text':
      return 'text';
    case 'tool_use':
      return 'tool_use';
    case 'tool_result':
      return 'tool_result';
    case 'thinking':
      return 'thinking';
    case 'system':
    case 'server_tool_use':
    case 'web_search_tool_use':
      return 'system';
    default:
      return 'text';
  }
}

/**
 * Subscribe to stream completion.
 * Filters `onStreamEvent` for `{ type: 'done' }` events.
 * The callback receives the turn's stop reason (e.g. 'end_turn' or 'tool_use')
 * so callers can distinguish a terminal turn from an intermediate tool turn.
 * Returns an unsubscribe function.
 */
export function onStreamDone(callback: (stopReason?: string) => void): () => void {
  if (!window.coderixAPI) {
    console.error('[IPC] window.coderixAPI is not available — preload may not have loaded');
    return NOOP_UNSUB;
  }
  return window.coderixAPI.onStreamEvent((event: any) => {
    if (event.type === 'done') {
      callback(event.stopReason as string | undefined);
    }
  });
}

/**
 * Subscribe to stream errors.
 * Filters `onStreamEvent` for `{ type: 'error' }` events.
 * Returns an unsubscribe function.
 */
export function onStreamError(callback: (error: string, code?: string) => void): () => void {
  if (!window.coderixAPI) {
    console.error('[IPC] window.coderixAPI is not available — preload may not have loaded');
    return NOOP_UNSUB;
  }
  return window.coderixAPI.onStreamEvent((event: any) => {
    if (event.type === 'error') {
      callback(event.message, event.code);
    }
  });
}

// ===========================================================================
//  Session Management
// ===========================================================================

/** List all sessions. */
export async function listSessions(): Promise<SessionInfo[]> {
  return invokeWithTimeout<SessionInfo[]>('session:list', () =>
    getAPI().session.list(),
  );
}

/** Get a single session summary by ID. */
export async function getSession(id: string): Promise<SessionInfo | null> {
  return invokeWithTimeout<SessionInfo | null>('session:get', () =>
    getAPI().session.get(id),
  );
}

/** Fork an existing session into a new one. */
export async function forkSession(id: string): Promise<unknown> {
  return invokeWithTimeout('session:fork', () => getAPI().session.fork(id));
}

/** Delete a session permanently. */
export async function deleteSession(id: string): Promise<unknown> {
  return invokeWithTimeout('session:delete', () =>
    getAPI().session.delete(id),
  );
}

/** Bind the active session to a model (per-session model switch). */
export async function setSessionModel(model: string): Promise<unknown> {
  return invokeWithTimeout('session:setModel', () =>
    getAPI().session.setModel(model),
  );
}

// ===========================================================================
//  Permissions
// ===========================================================================

/**
 * Approve a pending permission request (one-time).
 * @param toolUseId — matches the `toolUseId` field from the permission request event
 */
export async function approvePermission(toolUseId: string): Promise<unknown> {
  return invokeWithTimeout('permission:approve', () =>
    getAPI().permission.approve(toolUseId),
  );
}

/**
 * Approve a pending permission request for the current session.
 * @param toolUseId — matches the `toolUseId` field from the permission request event
 */
export async function approvePermissionSession(toolUseId: string): Promise<unknown> {
  return invokeWithTimeout('permission:approveSession', () =>
    getAPI().permission.approveSession(toolUseId),
  );
}

/**
 * Approve a pending permission request and persist it (always allow).
 * @param toolUseId — matches the `toolUseId` field from the permission request event
 */
export async function approvePermissionAlways(toolUseId: string): Promise<unknown> {
  return invokeWithTimeout('permission:approveAlways', () =>
    getAPI().permission.approveAlways(toolUseId),
  );
}

/**
 * Deny a pending permission request.
 * @param toolUseId — matches the `toolUseId` field from the permission request event
 */
export async function denyPermission(toolUseId: string): Promise<unknown> {
  return invokeWithTimeout('permission:deny', () =>
    getAPI().permission.deny(toolUseId),
  );
}

// ===========================================================================
//  Question (AskUserQuestion)
// ===========================================================================

/** Answer a pending question from the engine. */
export async function answerQuestion(
  toolUseId: string,
  answers: Record<string, string | string[]>,
): Promise<unknown> {
  return invokeWithTimeout('question:answer', () =>
    getAPI().question.answer(toolUseId, answers),
  );
}

/**
 * Subscribe to permission requests.
 *
 * The preload emits: `{ toolUseId, toolName, toolInput, riskLevel, description }`
 * The renderer expects: `{ id, toolName, toolInput, message? }`
 *
 * This adapter renames: toolUseId → id, description → message.
 *
 * Returns an unsubscribe function.
 */
export function onPermissionRequest(
  callback: (req: PermissionRequest) => void,
): () => void {
  if (!window.coderixAPI) {
    console.error('[IPC] window.coderixAPI is not available — preload may not have loaded');
    return NOOP_UNSUB;
  }
  return window.coderixAPI.onPermissionRequest((preloadReq: any) => {
    callback({
      id: preloadReq.toolUseId,
      toolName: preloadReq.toolName,
      toolInput: preloadReq.toolInput as Record<string, unknown>,
      message: preloadReq.description,
    });
  });
}

// ===========================================================================
//  Config
// ===========================================================================

/** Get the full config object. */
export async function getConfig(): Promise<Record<string, unknown>> {
  return invokeWithTimeout<Record<string, unknown>>('config:get', () =>
    getAPI().config.get(),
  );
}

/** Set a specific config key. */
export async function setConfig(key: string, value: unknown): Promise<unknown> {
  return invokeWithTimeout('config:set', () =>
    getAPI().config.set(key, value),
  );
}

/** Result of probing a provider's baseUrl + apiKey (test connection). */
export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  models?: string[];
  protocol?: 'anthropic' | 'openai';
}

/** Probe a provider endpoint: reachability, auth, and detected model ids. */
export async function testConnection(baseUrl: string, apiKey?: string): Promise<ConnectionTestResult> {
  return invokeWithTimeout<ConnectionTestResult>('config:testConnection', () =>
    getAPI().config.testConnection(baseUrl, apiKey),
  );
}

/** Get the current project directory. */
export async function getProjectDirectory(): Promise<{ path: string }> {
  return invokeWithTimeout('project:get', () =>
    getAPI().project.get(),
  );
}

/** Open a folder picker and update the active project directory. */
export async function selectProjectDirectory(): Promise<{ canceled: boolean; path: string }> {
  return invokeWithTimeout('project:select', () =>
    getAPI().project.select(),
  );
}

/** List recent project directories (most recent first). */
export async function listProjectDirectories(): Promise<{ paths: string[] }> {
  return invokeWithTimeout('project:list', () =>
    getAPI().project.list(),
  );
}

/** Switch the active project directory to an existing path. */
export async function setProjectDirectory(path: string): Promise<{ canceled: boolean; path: string }> {
  return invokeWithTimeout('project:set', () =>
    getAPI().project.set(path),
  );
}

// ===========================================================================
//  App Lifecycle
// ===========================================================================

/** Get the current app version string. */
export async function getAppVersion(): Promise<string> {
  return invokeWithTimeout<string>('app:version', () =>
    getAPI().app.getVersion(),
  );
}

/** Gracefully quit the application. */
export function quitApp(): void {
  if (!window.coderixAPI) {
    console.error('[IPC] window.coderixAPI is not available — cannot quit');
    return;
  }
  window.coderixAPI.app.quit();
}

// ===========================================================================
//  Token Usage
// ===========================================================================

/**
 * Subscribe to real-time token usage updates.
 *
 * The preload emits `onStateChange` with `{ type: 'tokenUsage', data: {...} }`
 * where data contains: `{ inputTokens, outputTokens, cacheReadInputTokens,
 * cacheCreationInputTokens, totalCost }`.
 *
 * This adapter maps it to the renderer's `TokenUsage` shape:
 * `{ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost }`.
 *
 * Returns an unsubscribe function.
 */
export function onTokenUsage(callback: (stats: TokenUsage) => void): () => void {
  if (!window.coderixAPI) {
    console.error('[IPC] window.coderixAPI is not available — preload may not have loaded');
    return NOOP_UNSUB;
  }
  return window.coderixAPI.onStateChange((change: any) => {
    if (change.type !== 'tokenUsage') return;

    const raw = change.data as {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      totalCost?: number;
    };

    callback({
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      cacheReadTokens: raw.cacheReadInputTokens,
      cacheWriteTokens: raw.cacheCreationInputTokens,
      cost: raw.totalCost,
    });
  });
}
