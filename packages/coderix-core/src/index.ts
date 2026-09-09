/**
 * @coderix/core — Public API
 *
 * Framework-agnostic engine for AI coding assistants.
 * Consumers: @coderix/cli, @coderix/desktop, @coderix/vscode.
 */

// ── Engine ─────────────────────────────────────────────────────────
export { QueryEngine } from './core/query-engine.js';
export type { QueryEngineConfig, QueryEngineEvent } from './core/query-engine.js';
export { query } from './core/query.js';
export type { QueryConfig, CallModelParams } from './core/query.js';
export { ToolRegistry } from './core/tool-registry.js';
export { PermissionEngine, extractRuleContent } from './core/permission.js';
export type { PermissionRule, PermissionRuleSource, PermissionBehavior } from './core/permission-rules.js';
export { SystemPromptAssembler } from './core/system-prompt.js';
export type { SystemPrompt } from './core/system-prompt.js';
export { SessionManager } from './core/session.js';
export {
  sessionDir,
  sessionJsonlPath,
  sessionSystemPromptPath,
  sessionMetaPath,
  subAgentJsonlPath,
  appendEntry,
  appendEntrySync,
  readEntries,
  readEntriesSync,
  rewriteEntries,
  entriesToMessages,
  readTailMetadata,
  readSessionMeta,
  writeSessionMeta,
  generateSessionTitle,
  isAutoTitle,
  refineSessionTitle,
  createEntryBatcher,
  migrateLegacySession,
  needsMigration,
} from './core/session-store.js';
export type { EntryBatcher } from './core/session-store.js';
export type { SessionMeta } from './core/session-store.js';
export { CheckpointManager } from './core/checkpoint.js';
export { SubAgentRegistry } from './core/subagent-registry.js';
export type { SubAgentRecord } from './core/subagent-registry.js';
export { AgentRegistry } from './core/agent-registry.js';
export { createCallModelFromClient } from './core/provider-adapter.js';
export { Compactor, requestManualCompact } from './core/compactor.js';
export { snipCompact, createSnipMarker, SNIP_MARKER, requestSnip, consumeSnipRequest } from './core/snip-compact.js';
export { TokenBudget } from './core/token-budget.js';
export { ToolExecutionQueue } from './core/tool-queue.js';
export { MessageQueue } from './core/message-queue.js';
export type { QueuedMessage } from './core/message-queue.js';

// ── Core types ─────────────────────────────────────────────────────
export type {
  ContentBlock, Message, TextBlock, ToolUseBlock, ToolResultBlock,
  AssistantMessage, UserMessage, StreamEvent,
  ContentBlockStartEvent, ContentBlockDeltaEvent, ContentBlockStopEvent,
  MessageStartEvent, MessageDeltaEvent, MessageStopEvent,
  StopReason, CompletionUsage, QueryMessage,
  DeferredPermission, DeferredQuestion, AgentError,
  AgentDefinition, BaseAgentDefinition, BuiltInAgentDefinition,
  CustomAgentDefinition, PluginAgentDefinition, AgentDefinitionsResult,
  AgentSpawnContext, ToolContext, ToolDefinition, ToolExecutionResult,
  Session, SessionSummary, SessionFilter, SessionStatus, SessionMetadata,
  TokenUsageSummary, SettingSource, AgentToolFilter,
  SessionEntry, TranscriptEntry, JsonlEntryBase, JsonlEntryType,
  UserEntry, AssistantEntry, SystemEntry,
  TitleEntry, AgentMetadataEntry, SummaryEntry,
  isTranscriptEntry,
} from './core/types.js';
export { PermissionMode, RiskLevel, SETTING_SOURCE_PRIORITY } from './core/types.js';

// ── Agents ─────────────────────────────────────────────────────────
export { buildAgentRegistry } from './agents/registry.js';
export { getSubAgentRegistry, setSubAgentRegistry } from './agents/agent-spawn/registry-ref.js';
export {
  readAgentMetadata,
  getAgentTranscript,
  getAgentTranscriptSync,
  saveAgentTranscript,
  writeAgentMetadata,
  writeAgentSystemPrompt,
  readTeamAgentMetadata,
  getTeamAgentTranscript,
  saveTeamAgentTranscript,
  writeTeamAgentMetadata,
  writeTeamAgentSystemPrompt,
  agentDir,
  agentTranscriptPath,
  agentMetaPath,
  agentSystemPromptPath,
  teamAgentDir,
  teamAgentTranscriptPath,
  teamAgentMetaPath,
  teamAgentSystemPromptPath,
  findAgentOnDisk,
} from './agents/agent-persistence.js';
export type { AgentMetadata, TeamAgentMetadata, DiskAgentInfo } from './agents/agent-persistence.js';

// ── Skills ─────────────────────────────────────────────────────────
export { getSkillRegistry } from './skills/index.js';

// ── Provider ───────────────────────────────────────────────────────
export { ProviderRouter } from './provider/router.js';
export type { SearchResult } from './tools/web-search/search-service.js';

// ── Tools ──────────────────────────────────────────────────────────
export {
  getAnthropicTools, getToolMeta, getToolRiskLevel,
  executeTool, hasExecutor, plugins,
} from './tools/registry.js';
export type {
  ToolPlugin, ToolMeta, ToolSchema, ToolExecutor,
  ToolResult, ExecutorOptions,
} from './tools/types.js';

// ── Teams ──────────────────────────────────────────────────────────
export { getTeamLeaderStaticDeclaration, getTeamStatusBlock } from './teams/team-prompt.js';
export { drainUnreadMessages } from './teams/team-mailbox.js';
export { loadTeamConfig, listTeams } from './teams/team-store.js';
export { execute as executeSendMessage } from './teams/tools/team-message/executor.js';
export type { TeamConfig, TeamMember } from './teams/types.js';

// ── Swarm / Team worker infrastructure ─────────────────────────────
export {
  writeToMailbox,
  readUnreadMessages,
  markMessagesAsRead,
  clearMailbox,
  deleteTeamMailboxes,
  createIdleNotification,
  isIdleNotification,
  isPermissionRequest,
  isPermissionResponse,
  isShutdownRequest,
  isShutdownApproved,
  isShutdownRejected,
  isStructuredProtocolMessage,
  getLastPeerDmSummary,
  waitForPermissionResponse,
} from './utils/swarm/teammateMailbox.js';
export type { TeammateMessage, IdleNotificationMessage } from './utils/swarm/teammateMailbox.js';
export { computeInitialTeamContext, initializeTeammateContextFromSession } from './utils/swarm/reconnection.js';
export type { TeamContextState } from './utils/swarm/reconnection.js';
export { getTeammateStatuses } from './utils/swarm/teamDiscovery.js';
export type { TeammateStatus, TeamSummary } from './utils/swarm/teamDiscovery.js';
export { isAgentSwarmsEnabled } from './utils/swarm/agentSwarmsEnabled.js';
export {
  sendPermissionResponseViaMailbox,
  sendPermissionRequestViaMailbox,
} from './utils/swarm/permissionSync.js';

// ── Tasks ──────────────────────────────────────────────────────────
export type { TrackedTask } from './tasks/task-tracker.js';
export { getTask } from './tasks/store.js';
export { getTaskListId, setTaskListId, listTasks, getAgentStatuses } from './tasks/store.js';
export type { Task } from './tasks/schema.js';

// ── Memory ─────────────────────────────────────────────────────────
export { loadMemoryConfig } from './memory/config.js';
export type { MemoryConfig, MemorySettings } from './memory/types.js';
export { findRelevantMemories, formatRecalledMemories } from './memory/recall.js';
export { executeExtractMemories, initExtractMemories, drainPendingExtraction } from './memory/extract-memories.js';
export { scanMemoryFiles, parseMemoryFile } from './memory/frontmatter.js';
export { loadIndex, cleanStaleEntries } from './memory/memory-index.js';
export { getMemoryDir } from './memory/memory-directory.js';

// ── Hooks ──────────────────────────────────────────────────────────
export type { HookManager } from './hooks/index.js';

// ── MCP ────────────────────────────────────────────────────────────
export { McpManager, discoverTools } from './mcp/index.js';
export {
  loadMcpConfigs, projectConfigPath, userConfigPath,
  addMcpConfig, removeMcpConfig, getMcpConfig,
  disableServer, enableServer, isServerDisabled,
} from './mcp/config-loader.js';
export { startMcpServer } from './mcp/mcp-server.js';
export type { ServerConfig, ScopedServerConfig } from './mcp/types.js';
export { StdioServerConfigSchema, HttpServerConfigSchema } from './mcp/types.js';
export { connectToServer } from './mcp/connection.js';
export { runChromeMcpServer } from './mcp/builtin/chrome-mcp/index.js';
export { runComputerUseMcpServer } from './mcp/builtin/computer-use-mcp/index.js';

// ── Config ─────────────────────────────────────────────────────────
export { loadSettings, saveSettings, loadConfig, inferProvider, getMaxToolConcurrency } from './config.js';
export type {
  CoderSettings, AppConfig, ModelItem, ModelEntry, ModelPrice,
  WebSearchConfig, WebBridgeConfig, PermissionRuleEntry, AgentEngine,
} from './config.js';

// ── Platform utilities ─────────────────────────────────────────────
export { IS_WINDOWS, IS_MACOS, onShutdownSignal } from './utils/platform.js';
export { detectShell } from './utils/shell-detect.js';
export type { ShellInfo, ShellType } from './utils/shell-detect.js';
export { toPosixPath, toWindowsPath } from './utils/windows-paths.js';

// ── SDK (shared message schema for @coderix/sdk & CLI --sdk) ────────
export {
  mapEngineEventToSdkMessage,
  buildInitMessage,
  buildResultMessage,
  toCorePermissionMode,
  fromCorePermissionMode,
} from './sdk/index.js';
export type {
  PermissionMode as SdkPermissionMode,
  SystemPromptConfig,
  McpServerConfig,
  PermissionRule as SdkPermissionRule,
  PermissionUpdate,
  PermissionResult,
  CanUseTool,
  HookEvent as SdkHookEvent,
  HookCallback as SdkHookCallback,
  SDKSystemMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKResultUsage,
  SDKPartialAssistantMessage,
  SDKMessage,
  SDKInputMessage,
  Options as SdkOptions,
  QueryArguments,
  Query,
} from './sdk/index.js';

// ── State primitives ───────────────────────────────────────────────
export { createStore } from './state/store.js';
export type { Store } from './state/store.js';
export type { CoreState, CoreConfig } from './state/core-state.js';
export { createSubject, createEventBus } from './state/observable.js';
export type { Observer, Observable, Subject, EngineEvent, ToolRequestEvent, EventBus } from './state/observable.js';
