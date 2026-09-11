/**
 * sdk/types.ts — Coderix SDK message & option types.
 *
 * Faithful mirror of Anthropic's claude-code-sdk public surface
 * (`@anthropic-ai/claude-code` / `@anthropic-ai/claude-agent-sdk`).
 * Field names intentionally match so the API is a near drop-in.
 *
 * Underlying message payloads reuse @coderix/core types
 * (AssistantMessage / UserMessage / StreamEvent), which are already
 * Anthropic-Messages-API shaped.
 */

import type {
  AssistantMessage,
  UserMessage,
  StreamEvent,
  CompletionUsage,
} from '../core/types.js';

// ── Permission mode ──────────────────────────────────────────────────

/** claude-code-sdk permission mode names. */
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions';

// ── System prompt ────────────────────────────────────────────────────

export type SystemPromptConfig =
  | { type: 'preset'; preset: string; append?: string }
  | { type: 'override'; content: string };

// ── MCP servers ──────────────────────────────────────────────────────

export type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> };

// ── canUseTool / permission callbacks ────────────────────────────────

export interface PermissionRule {
  toolName: string;
  ruleContent?: string;
  behavior: 'allow' | 'deny';
  mode?: PermissionMode;
  description?: string;
}

export interface PermissionUpdate {
  type: 'addRules';
  rules: PermissionRule[];
}

export interface PermissionResultAllow {
  behavior: 'allow';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: PermissionUpdate[];
}

export interface PermissionResultDeny {
  behavior: 'deny';
  message: string;
  interrupt?: boolean;
  updatedPermissions?: PermissionUpdate[];
}

export interface PermissionResultAsk {
  behavior: 'ask';
}

export type PermissionResult =
  | PermissionResultAllow
  | PermissionResultDeny
  | PermissionResultAsk
  | undefined;

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[] },
) => Promise<PermissionResult>;

// ── Hooks (mirrored names; v1 wiring is partial — see README) ────────

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStop'
  | 'PreCompact'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Notification'
  | 'onUserPromptSubmit';

export type HookCallback = (...args: unknown[]) => Promise<void> | void;

// ── SDK messages ─────────────────────────────────────────────────────

export interface SDKSystemMessage {
  type: 'system';
  subtype: 'init' | 'compact_boundary';
  session_id: string;
  uuid: string;
  // init-only fields
  cwd?: string;
  tools?: string[];
  mcp_servers?: string[];
  model?: string;
  permissionMode?: PermissionMode;
}

export interface SDKAssistantMessage {
  type: 'assistant';
  message: AssistantMessage;
  session_id: string;
  uuid: string;
  parent_tool_use_id?: string | null;
}

export interface SDKUserMessage {
  type: 'user';
  message: UserMessage;
  session_id: string;
  uuid: string;
  parent_tool_use_id?: string | null;
}

export interface SDKResultUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  totalCost?: number;
}

export type SDKResultSubtype =
  | 'success'
  | 'error_max_turns'
  | 'error_during_execution';

export interface SDKResultMessage {
  type: 'result';
  subtype: SDKResultSubtype;
  is_error: boolean;
  result: string;
  session_id: string;
  uuid: string;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage: SDKResultUsage;
}

export interface SDKPartialAssistantMessage {
  type: 'stream_event';
  event: StreamEvent;
  session_id: string;
  uuid: string;
  parent_tool_use_id?: string | null;
}

export type SDKMessage =
  | SDKSystemMessage
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKPartialAssistantMessage;

/** SDK-shaped user message accepted as streaming input (AsyncIterable prompt). */
export interface SDKInputMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id?: string | null;
  session_id?: string;
}

// ── Options ──────────────────────────────────────────────────────────

export interface Options {
  abortController?: AbortController;
  allowedTools?: string[];
  /** Override the endpoint from ~/.coderix/settings.json (per-agent model binding). */
  baseUrl?: string;
  /** Override the auth token from ~/.coderix/settings.json (per-agent model binding). */
  apiKey?: string;
  appendSystemPrompt?: string;
  canUseTool?: CanUseTool;
  cwd?: string;
  disallowedTools?: string[];
  env?: Record<string, string>;
  fallbackModel?: string;
  forkSession?: boolean;
  hooks?: Partial<Record<HookEvent, HookCallback[]>>;
  includePartialMessages?: boolean;
  maxThinkingTokens?: number;
  maxTurns?: number;
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
  outputFormat?: 'text' | 'json' | 'stream-json';
  pathToCoderixExecutable?: string;
  permissionMode?: PermissionMode;
  resume?: string;
  settingSources?: Array<'user' | 'project' | 'local' | 'enterprise'>;
  stderr?: (data: string) => void;
  systemPrompt?: string | SystemPromptConfig;
}

/** Arguments passed to `query()`. */
export interface QueryArguments {
  prompt: string | AsyncIterable<SDKInputMessage>;
  options?: Options;
}

/** A query is an async generator of SDK messages. */
export type Query = AsyncGenerator<SDKMessage, void, void>;

/** Raw stream event consumed by the mapper's partial-message path. */
export type { CompletionUsage };
