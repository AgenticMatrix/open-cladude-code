/**
 * Tool allow/deny lists for sub-agent tool filtering.
 *
 * Three-layer filtering:
 *   Layer 1: GLOBAL_DISALLOWED_FOR_SUBAGENTS — always stripped from all sub-agents
 *   Layer 2: AgentDefinition.disallowedTools — agent-specific deny list
 *   Layer 3: AgentDefinition.tools — agent-specific allow list ('*' = all remaining)
 */

import type { ToolDefinition, AgentDefinition } from '../core/types.js';

/** Always removed from sub-agent tool sets. Enforces depth-limit=1 and
 *  prevents sub-agents from interacting with the user or spawning more agents. */
export const GLOBAL_DISALLOWED_FOR_SUBAGENTS = new Set([
  'Agent',
  'SendMessage',
  'TaskStop',
  'TaskGet',
  'TaskOutput',
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterPlanMode',
  'cron-create',
  'cron-delete',
  'cron-list',
  'EnterWorktree',
  'ExitWorktree',
  'workflow',
  'TeamCreate',
  'TeamDelete',
  'TeamAgent',
]);

/** backward-compat alias */
export const ALL_AGENT_DISALLOWED_TOOLS = GLOBAL_DISALLOWED_FOR_SUBAGENTS;

export type SubagentType = 'explore' | 'plan' | 'general-purpose' | 'verification' | 'coderix-guide' | 'statusline-setup' | 'worker';

/** Apply agent-specific tool filtering to a list of ToolDefinitions. */
export function filterToolsForAgent(
  parentTools: ToolDefinition[],
  agentDef: AgentDefinition,
): ToolDefinition[] {
  // Layer 1: Remove globally disallowed tools
  let filtered = parentTools.filter(
    t => !GLOBAL_DISALLOWED_FOR_SUBAGENTS.has(t.name),
  );

  // Layer 2: Apply agent-specific disallowedTools
  if (agentDef.disallowedTools && agentDef.disallowedTools.length > 0) {
    const disallowed = new Set(agentDef.disallowedTools);
    filtered = filtered.filter(t => !disallowed.has(t.name));
  }

  // Layer 3: Apply whitelist (skip if undefined or the sentinel '*')
  if (agentDef.tools && agentDef.tools !== '*') {
    const allowed = new Set(agentDef.tools);
    filtered = filtered.filter(t => allowed.has(t.name));
  }

  return filtered;
}

/** Filter tools for a resumed agent. Skips the global disallowed layer
 *  (already applied during the initial spawn) and only applies agent-specific
 *  filtering. This preserves the agent's original effective toolset. */
export function filterToolsForResumedAgent(
  parentTools: ToolDefinition[],
  agentDef: AgentDefinition,
): ToolDefinition[] {
  let filtered = parentTools;

  // Apply agent-specific disallowedTools (skip global — already filtered)
  if (agentDef.disallowedTools && agentDef.disallowedTools.length > 0) {
    const disallowed = new Set(agentDef.disallowedTools);
    filtered = filtered.filter(t => !disallowed.has(t.name));
  }

  // Apply whitelist (skip if undefined or the sentinel '*')
  if (agentDef.tools && agentDef.tools !== '*') {
    const allowed = new Set(agentDef.tools);
    filtered = filtered.filter(t => allowed.has(t.name));
  }

  return filtered;
}
