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

/**
 * Why the index thinks a session asked the user something.
 * - 'open-questions': the message has an "Open questions" section whose content isn't "None".
 * - 'question': the message's last non-empty line ends with a question mark.
 */
export interface AskedYou {
  reason: 'open-questions' | 'question';
  /** The question itself, as plain text, at most 200 characters. */
  excerpt: string;
}

export interface SessionSummary {
  /** Full session UUID, usable with `claude --resume`. */
  sessionId: string;
  /** Short id for `claude attach` / `claude logs`. Background sessions only. */
  shortId?: string;
  /** Display name: the set name, or Claude Code's default such as `website-98`. */
  name: string;
  /**
   * A short description of what the session is about, shown after the name, as
   * in `website-98 · Standard Webhooks destination auth review`. Omitted when
   * there's none, or when it equals `name`, as with background sessions, whose
   * name is already the generated title.
   */
  title?: string;
  /**
   * Where `title` came from.
   * - 'claude-code': the title Claude Code generated from the session's first
   *   prompt. It isn't updated as the session moves on.
   * - 'pitwall': a title pitwall generated from the session's recent turns (M4).
   */
  titleSource?: 'claude-code' | 'pitwall';
  kind: SessionKind;
  /**
   * Absolute working directory, as `claude agents` reports it, not its realpath.
   * Root matching and grouping use the realpath.
   */
  cwd: string;
  /** True when the working directory no longer exists, for example after a worktree was removed. */
  cwdMissing?: boolean;
  pid?: number;
  /** True while the session's process is running (a pid is present). */
  alive: boolean;
  status?: ProcessStatus;
  state?: BackgroundState;
  waitingFor?: WaitingFor;
  /** ISO 8601. */
  startedAt: string;
  /**
   * True for a background session that is blocked and has had no activity for
   * more than 7 days, whether or not its process is still running. Activity is
   * lastActivityAt, or startedAt when the transcript is unavailable. These are
   * usually waiting on a question that's moot.
   */
  stale: boolean;
  /**
   * True for a background session that has finished: no live process, and
   * state 'done', 'stopped' or 'failed'. Plain `claude agents --json` leaves
   * these out; pitwall lists with `--all` and shows them muted, last in their
   * group. A 'done' session whose process is still alive is idle, not
   * finished. Never true together with `stale`.
   */
  finished: boolean;
  /**
   * Set when the session has finished its turn and its newest assistant message
   * looks like it asked the user something, with no user prompt since. A
   * heuristic over the transcript, not something Claude Code reports.
   */
  askedYou?: AskedYou;
  /** ISO 8601 timestamp of the newest transcript entry, when the transcript was readable. */
  lastActivityAt?: string;
  /**
   * The newest assistant text, with markdown syntax stripped to plain text, then
   * trimmed and truncated to 500 characters.
   */
  lastAssistantText?: string;
  /**
   * The newest prompt typed by the user, truncated to 300 characters. Messages
   * from other sessions (cross-session messages) are never counted as prompts.
   */
  lastUserPrompt?: string;
  transcript: TranscriptStatus;
  /**
   * The latest message pitwall relayed to this session (W11, D8), and the
   * session's reply when one came back through the relay.
   */
  relay?: RelayExchange;
}

/** One relayed message and its outcome, shown on the target session's row. */
export interface RelayExchange {
  /** ISO 8601. */
  sentAt: string;
  status: RelayStatus;
  /** The target's reply, as plain text, at most 2 KiB, when it sent one back. */
  reply?: { at: string; text: string };
}

export interface SessionGroup {
  /** Absolute path: the repo's top-level directory for git, otherwise the session's cwd. */
  key: string;
  /**
   * `key` relative to the configured root it sits under, or the root's basename
   * for the root itself. When the key is outside the root (a worktree under the
   * root whose main repo isn't), the key with the home directory shortened to `~`.
   */
  label: string;
  kind: 'git' | 'directory';
  /** The configured root this group sits under. */
  root: string;
  /**
   * Sorted: sessions that need the user first (status 'waiting', or a background
   * job that is blocked and not stale), then askedYou, then busy, then by
   * lastActivityAt descending (startedAt when there's none). Stale sessions
   * next, and finished sessions (`finished`) last. Finished sessions are
   * sorted by activity alone, so an askedYou doesn't lift one.
   */
  sessions: SessionSummary[];
}

export type SourceHealth = { ok: true } | { ok: false; error: string };

export interface IndexSnapshot {
  /** ISO 8601. */
  generatedAt: string;
  /** The absolute, real-path roots pitwall was started with. */
  roots: string[];
  /**
   * Sorted by the newest activity (lastActivityAt, or startedAt when there's
   * none) among each group's unfinished sessions, descending. Groups whose
   * sessions have all finished come after every other group, sorted the same
   * way by their finished sessions.
   */
  groups: SessionGroup[];
  /** Whether `claude agents --json --all` succeeded on the latest poll. */
  source: SourceHealth;
}

/**
 * WebSocket protocol version. Version 2 (M2) replaced M1's raw-token auth with
 * challenge-response, so the raw token never travels over the socket. Version
 * 3 binds the proof to the page's origin, so a page on another origin, such as
 * a server squatting on the port, can't pass a challenge on to a real pitwall
 * page and use its proof.
 */
export const PROTOCOL_VERSION = 3;

/**
 * Server → client WebSocket messages.
 * - 'challenge': the first message on every connection. `nonce` is 32 random
 *   bytes, base64url, never reused.
 * - 'authenticated': sent after a valid `auth` proof. `apiKey` authorizes HTTP
 *   API calls. It's random per server process, so it stops working when the
 *   process exits, and a server squatting on the port never sees the token.
 * - 'snapshot': sent right after 'authenticated', and again whenever anything
 *   other than generatedAt changed.
 * - 'heartbeat': sent after every poll that didn't change the snapshot, so the
 *   UI can show the index is alive without receiving the whole snapshot again.
 */
export type ServerMessage =
  | { type: 'challenge'; version: number; nonce: string }
  | { type: 'authenticated'; apiKey: string }
  | { type: 'snapshot'; snapshot: IndexSnapshot }
  | { type: 'heartbeat'; generatedAt: string; source: SourceHealth }
  | { type: 'error'; error: string };

/**
 * The full newest assistant message of one session, fetched on demand when the
 * user expands a row. Same plain-text treatment as lastAssistantText, without
 * the 500-character limit.
 */
export interface LastMessage {
  sessionId: string;
  /** Markdown syntax stripped to plain text. At most 64 KiB of source text. */
  text: string;
  /** True when the source message was longer than the 64 KiB the index keeps. */
  truncated: boolean;
  /** ISO 8601 timestamp of the message, when known. */
  at?: string;
}

/**
 * Client → server WebSocket messages. The client's first message must be
 * `auth`, within 5 seconds of the challenge, or the server closes the
 * connection with code 4401.
 *
 * `proof` is base64url(HMAC-SHA256(key = the token as UTF-8, message = the
 * challenge's nonce, a line feed, then the page's origin, all as UTF-8)). The
 * origin is `location.origin`, such as `http://127.0.0.1:4517`; the server uses
 * the one origin it allows. The browser computes the proof with WebCrypto.
 * The server compares it in constant time, and accepts each nonce only once.
 */
export type ClientMessage = { type: 'auth'; proof: string };

/**
 * WebSocket close code for a missing or wrong proof, an expired challenge, or
 * a protocol version the server doesn't speak.
 */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/** WebSocket path served by the pitwall server. */
export const WS_PATH = '/ws';

/**
 * HTTP API authorization, for every path under /api/: `Authorization: Bearer
 * <apiKey>`, from the 'authenticated' message. The raw token is also accepted,
 * for scripts such as curl, but the web UI never sends it.
 */

/** HTTP path that returns the latest IndexSnapshot as JSON. */
export const SNAPSHOT_PATH = '/api/snapshot';

/**
 * HTTP path that returns one session's LastMessage as JSON. Only sessions in
 * the current snapshot (under the roots) are served: any other id gets 404.
 */
// For clients. A server building a route pattern from this must decode it,
// because the id is URL-encoded (`:sessionId` becomes `%3AsessionId`).
export function lastMessagePath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/last-message`;
}

/** Default poll interval for the index, in milliseconds. `pitwall --interval <seconds>` overrides it. */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/** What a conversation entry is. */
export type ConversationEntryKind =
  /** A prompt the user typed. */
  | 'user'
  /** Assistant text, without thinking blocks. */
  | 'assistant'
  /** One tool call and its result, collapsed into a single entry. */
  | 'tool'
  /** A message from another Claude session. */
  | 'cross-session'
  /** Anything else worth showing: a compaction summary, a task notification, a command's output. */
  | 'notice';

export interface ConversationEntry {
  kind: ConversationEntryKind;
  /** ISO 8601, when known. */
  at?: string;
  /**
   * Plain text, with markdown syntax stripped. For 'tool', a one-line summary
   * of the call, such as `Bash: npm test` or `Edit: src/cli.ts`. At most 8 KiB.
   */
  text: string;
  /** For 'tool': the tool's name. */
  toolName?: string;
  /** For 'tool': whether the result was an error. */
  toolError?: boolean;
  /** For 'cross-session': the sender's name, as the receiving session saw it. */
  from?: string;
  /** True when `text` was cut to the limit. */
  truncated?: boolean;
}

/**
 * One page of a session's conversation, read from the end of the transcript
 * backwards. Read-only, and served only for sessions in the current snapshot.
 */
export interface ConversationPage {
  sessionId: string;
  /** Oldest first within the page. At most 50 entries. */
  entries: ConversationEntry[];
  /**
   * Opaque. Pass it as `before` to get the previous, older page. Absent when
   * the page reaches the start of the transcript.
   */
  before?: string;
}

/**
 * HTTP path that returns a ConversationPage as JSON: the newest page, or the
 * page before the `before` cursor. A cursor for a file that was rotated or
 * rewritten gets 410, and the client should reload the newest page. Same rules as lastMessagePath(): only
 * sessions in the current snapshot, and a server building a route pattern
 * from this must decode it.
 */
/** The status a conversation request gets for a cursor made for another version of the transcript. */
export const CONVERSATION_STALE_STATUS = 410;

export function conversationPath(sessionId: string, before?: string): string {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/conversation`;
  return before === undefined ? path : `${path}?before=${encodeURIComponent(before)}`;
}

// ---------------------------------------------------------------------------
// M2 input paths (W10-W12). Every HTTP route below is state-changing: POST,
// with the apiKey and an allowed Origin (W8's rule). Every route that names a
// session resolves it with resolveSession(), and builds commands from the
// resolved summary, never from the raw parameter. Each answers JSON.
// ---------------------------------------------------------------------------

/** What SendMessage reported for a relayed message (W11, D8). */
export type RelayStatus =
  /** In the target's inbox. Its Claude reads it at its next tool round, or starts a turn if idle. */
  | 'delivered'
  /**
   * Held by the target, undelivered: it bypasses permission prompts and waits
   * for the user's approval in its own terminal, or its settings hold
   * cross-session messages.
   */
  | 'held'
  /** Refused by the target's inbound settings. */
  | 'refused'
  /**
   * Not sent: no live session answers to the target's name, the name is
   * ambiguous, or the relay couldn't start.
   */
  | 'failed';

/** Body of a POST to relayPath(). `text` is 1 to 8,192 characters, sent verbatim. */
export interface RelayRequest {
  text: string;
}

export interface RelayResult {
  status: RelayStatus;
  /** A short explanation, for example why it was refused or failed. */
  detail?: string;
}

/** Relay a message to an interactive session, through pitwall's headless relay session (D8). */
export function relayPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/relay`;
}

/** Body of a POST to SPAWN_PATH (W12). */
export interface SpawnRequest {
  /** An absolute directory at or under one of the roots. */
  cwd: string;
  /** The first prompt, 1 to 16,384 characters. */
  prompt: string;
  /** Optional display name: letters, digits, space, `.`, `_` and `-`, at most 64 characters. */
  name?: string;
  /** Optional model alias, such as `sonnet` or `haiku`. */
  model?: string;
}

export type SpawnResult =
  | { ok: true; shortId: string; name: string }
  /** `hint` is a command for the user to run, such as the one that trusts a workspace. */
  | { ok: false; error: string; hint?: string };

/** Start a new background session with `claude --bg`. */
export const SPAWN_PATH = '/api/sessions';

/** Result of stop and remove. Both apply to background sessions only; others get 409. */
export type ActionResult = { ok: true } | { ok: false; error: string };

/** Stop a background session with `claude stop`. Its conversation is kept. */
export function stopPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/stop`;
}

/** Remove a background session with `claude rm`. Claude Code keeps a worktree that has unpushed commits. */
export function removePath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/remove`;
}

// ---------------------------------------------------------------------------
// Attach (W10, D3, D9): a WebSocket per attached background session, carrying
// a PTY running `claude attach <shortId>`.
// ---------------------------------------------------------------------------

/** WebSocket path for attaching. Same Host and Origin checks as WS_PATH. */
export const ATTACH_PATH = '/attach';

/** At most this many attached sessions at once (D9). */
export const MAX_ATTACHED = 4;

/** Close code when MAX_ATTACHED are already open. */
export const WS_CLOSE_TOO_MANY = 4429;

/**
 * Client → server on an attach socket. The handshake is the same as on
 * WS_PATH: the server sends `challenge`, and the client's first message is
 * `auth` with a proof. Then `open`, then any number of `input` and `resize`.
 * `restart` must be true to attach to a session that isn't running, after the
 * user confirmed (D9).
 */
export type AttachClientMessage =
  | { type: 'auth'; proof: string }
  | { type: 'open'; sessionId: string; cols: number; rows: number; restart?: boolean }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

/**
 * Server → client on an attach socket, as JSON text frames. PTY output is sent
 * as binary frames, so it's never parsed as a message.
 * - 'ready': the proof was valid; send `open`.
 * - 'needs-restart': the session isn't running, so attaching would restart
 *   it. Ask the user, then send `open` again with `restart: true`.
 * - 'attached': output follows as binary frames.
 * - 'exit': `claude attach` ended. Closing the socket detaches; the session
 *   keeps running.
 */
export type AttachServerMessage =
  | { type: 'challenge'; version: number; nonce: string }
  | { type: 'ready' }
  | { type: 'needs-restart' }
  | { type: 'attached' }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; error: string };
