/**
 * Team type definitions.
 *
 * A Team is a persistent coordination wrapper around Sub-agents.
 * Team members have **identity** (human-readable names, mailboxes)
 * while still using the existing SubAgentRegistry / Agent tool
 * infrastructure for execution.
 */

// ---------------------------------------------------------------------------
// Team Member
// ---------------------------------------------------------------------------

export interface TeamMember {
  /** SubAgentRegistry ID (e.g. "sub-abc12345"), assigned at spawn time. */
  agentId: string;
  /** Human-readable display name (e.g. "researcher", "tester"). */
  name: string;
  /** Agent type: 'explore' | 'plan' | 'general-purpose'. */
  agentType: string;
  /** Optional model override. */
  model?: string;
  /** TUI display color. */
  color?: string;
  /** Current lifecycle status. */
  status: 'pending' | 'running' | 'done' | 'error' | 'stopped';
  /** Brief description of assigned task. */
  task?: string;
  /** Team name this member belongs to (undefined for solo agents). */
  teamName?: string;
  /** Unix timestamp (ms) when the member joined the team. */
  joinedAt: number;
  /** Unix timestamp (ms) when the member finished (done/error/stopped). */
  finishedAt?: number;
}

// ---------------------------------------------------------------------------
// Team Config
// ---------------------------------------------------------------------------

export interface TeamConfig {
  /** Team identifier, used as directory name (sanitized). */
  name: string;
  /** Human-readable purpose of this team. */
  description: string;
  /** Unix timestamp (ms) when the team was created. */
  createdAt: number;
  /** The lead agent's session ID. */
  leadSessionId?: string;
  /** Team member roster. */
  members: TeamMember[];
}

// ---------------------------------------------------------------------------
// Team Message (mailbox)
// ---------------------------------------------------------------------------

export interface TeamMessage {
  /** Sender name. */
  from: string;
  /** Recipient name, or '*' for broadcast. */
  to: string;
  /** Message content. */
  text: string;
  /** Unix timestamp (ms). */
  timestamp: number;
  /** Whether the recipient has read this message. */
  read: boolean;
}

// ---------------------------------------------------------------------------
// Team Status (aggregate view)
// ---------------------------------------------------------------------------

export interface TeamStatus {
  config: TeamConfig;
  activeCount: number;
  completedCount: number;
  errorCount: number;
  unreadMessages: number;
}
