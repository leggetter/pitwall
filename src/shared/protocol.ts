// The M1 contract: the data the index produces, and the messages the server and
// the web UI exchange. The index, server and UI are built in parallel against
// this file, so change it deliberately and in its own commit.

/** Where a session runs. Matches `kind` in `claude agents --json`. */
export type SessionKind = 'interactive' | 'background';

/** Whether the session's process is working. Present only while the process is alive. */
export type ProcessStatus = 'busy' | 'waiting' | 'idle';

/** A background session's lifecycle state. Interactive sessions don't have one. */
export type BackgroundState = 'working' | 'blocked' | 'done' | 'failed' | 'stopped';

/**
 * What a waiting session needs. The documented values are listed; any other
 * string is passed through so a new Claude Code value doesn't break the UI.
 */
export type WaitingFor =
  | 'permission prompt'
  | 'input needed'
  | 'sandbox request'
  | 'worker request'
  | 'dialog open'
  | (string & {});

/** How much of a session's transcript the index could read. */
export type TranscriptStatus = 'ok' | 'missing' | 'unreadable';

export interface SessionSummary {
  /** Full session UUID, usable with `claude --resume`. */
  sessionId: string;
  /** Short id for `claude attach` / `claude logs`. Background sessions only. */
  shortId?: string;
  /** Display name: the set name, or Claude Code's default such as `website-98`. */
  name: string;
  kind: SessionKind;
  /** Absolute working directory. */
  cwd: string;
  pid?: number;
  /** True while the session's process is running (a pid is present). */
  alive: boolean;
  status?: ProcessStatus;
  state?: BackgroundState;
  waitingFor?: WaitingFor;
  /** ISO 8601. */
  startedAt: string;
  /**
   * True for a background session that is blocked, has no process, and started
   * more than 7 days ago. These are usually waiting on a question that's moot.
   */
  stale: boolean;
  /** ISO 8601 timestamp of the newest transcript entry, when the transcript was readable. */
  lastActivityAt?: string;
  /** The newest assistant text, trimmed and truncated to 500 characters. */
  lastAssistantText?: string;
  /**
   * The newest prompt typed by the user, truncated to 300 characters. Messages
   * from other sessions (cross-session messages) are never counted as prompts.
   */
  lastUserPrompt?: string;
  transcript: TranscriptStatus;
}

export interface SessionGroup {
  /** Absolute path: the repo's top-level directory for git, otherwise the session's cwd. */
  key: string;
  /** `key` relative to the configured root it sits under, or the root's basename for the root itself. */
  label: string;
  kind: 'git' | 'directory';
  /** The configured root this group sits under. */
  root: string;
  /** Sorted: waiting first, then busy, then by lastActivityAt descending. */
  sessions: SessionSummary[];
}

export type SourceHealth = { ok: true } | { ok: false; error: string };

export interface IndexSnapshot {
  /** ISO 8601. */
  generatedAt: string;
  /** The absolute, real-path roots pitwall was started with. */
  roots: string[];
  /** Sorted by the newest lastActivityAt among each group's sessions, descending. */
  groups: SessionGroup[];
  /** Whether `claude agents --json` succeeded on the latest poll. */
  source: SourceHealth;
}

/** Server → client WebSocket messages. */
export type ServerMessage =
  | { type: 'snapshot'; snapshot: IndexSnapshot }
  | { type: 'error'; error: string };

/**
 * Client → server WebSocket messages. The first message on a connection must
 * be `auth`, within 5 seconds, or the server closes it with code 4401.
 */
export type ClientMessage = { type: 'auth'; token: string };

/** WebSocket close code for a missing or wrong token. */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/** WebSocket path served by the pitwall server. */
export const WS_PATH = '/ws';

/** HTTP path that returns the latest IndexSnapshot as JSON. Requires `Authorization: Bearer <token>`. */
export const SNAPSHOT_PATH = '/api/snapshot';
