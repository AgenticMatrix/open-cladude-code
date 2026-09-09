/**
 * Team system-prompt helpers.
 *
 * Provides the static team-leader declaration and the per-turn dynamic team
 * status block injected into the leader's system prompt when a team is active.
 */

import { loadTeamConfig } from './team-store.js';
import { getUnreadCount } from './team-mailbox.js';
import type { TeamConfig } from './types.js';

// ---------------------------------------------------------------------------
// Static team leader declaration (for system prompt — cache-friendly)
// ---------------------------------------------------------------------------

export function getTeamLeaderStaticDeclaration(
  teamName: string,
  description: string,
): string {
  return [
    `# Active Team: ${teamName}`,
    `Description: ${description}`,
    '',
    'You are the team leader. Use TeamAgent(name, team_name) to spawn workers.',
    'TeamAgent always runs in the foreground — it blocks until the worker completes. Do NOT use background mode for team workers.',
    '',
    'IMPORTANT — SendMessage addressing:',
    '- Workers are addressed by agent name (e.g. "alice"). Agent IDs also work as fallback.',
    '- SendMessage(agent_name: "<name>", team_name: "<team>", text: "...") — use the agent name from the worker list below',
    '- SendMessage(agent_name: "*", team_name: "<team>", text: "...") — broadcast to all workers',
    '- SendMessage(agent_name: "leader", team_name: "<team>", text: "...") — workers use this to reach you',
    '- Stopped workers are auto-resumed when you send them a message — no separate resume step needed',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Dynamic team status block (per-turn injection — always at conversation tail)
// ---------------------------------------------------------------------------

export async function getTeamStatusBlock(
  sessionDir: string,
  teamName: string,
): Promise<string | null> {
  const config = await loadTeamConfig(sessionDir, teamName);
  if (!config) return null;

  const lines: string[] = [];

  if (config.members.length > 0) {
    lines.push('Current team workers:');
    for (const m of config.members) {
      const unread = await getUnreadCount(sessionDir, config.name, m.name).catch(() => 0);
      const unreadNote = unread > 0 ? ` (${unread} unread)` : '';
      lines.push(`- ${m.name} [${m.agentType}] [${m.status}]${unreadNote}${m.task ? ` — ${m.task}` : ''}`);
    }
  } else {
    lines.push('No workers yet. Use TeamAgent(name, team_name) to spawn one.');
  }

  return lines.join('\n');
}
