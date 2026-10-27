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

/**
 * Why a session needs you, judged from its context rather than from Claude
 * Code's state alone (spike 007; Phil, 2026-10-27). The first reason that
 * holds, in this order:
 * - 'prompt': Claude Code is showing a prompt: status 'waiting', and
 *   waitingFor says which.
 * - 'claude-code': a background job's own line on what it needs, in `text`,
 *   from the job's `state.json`. Not its start placeholder, "send a prompt to
 *   start", which a resumed session shows though it asked nothing.
 * - 'asked': its last turn ended by asking you something (askedYou).
 * - 'restarted': you resumed it, or confirmed a restart of it, in this run of
 *   pitwall, and no prompt has been sent to it since.
 * - 'blocked': Claude Code says it's blocked, and pitwall couldn't read why:
 *   the job's `state.json` was missing, unreadable, malformed or another
 *   session's, or the row has no short id to find it by. Kept so that a
 *   question is never hidden.
 */
export interface NeedsYou {
  reason: 'prompt' | 'claude-code' | 'asked' | 'restarted' | 'blocked';
  /** For 'claude-code' only: Claude Code's line, as plain text, at most 200 characters. */
  text?: string;
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
   * - 'pitwall': a title pitwall generated from the session's recent turns (M5).
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
   * finished. Also true for an interactive session that has ended (`ended`).
   * Never true together with `stale`.
   */
  finished: boolean;
  /**
   * True for an interactive session that has ended (W66, spike 006): its
   * process has exited, as when its terminal closed or the machine restarted,
   * so `claude agents --all` no longer lists it, and pitwall found it from its
   * transcript. Always with kind 'interactive', alive false and finished true,
   * and never with shortId, pid, status, state or waitingFor.
   *
   * - `cwd` is the directory it started in, whose project folder holds its
   *   transcript, not where a later `cd` left it.
   * - `name` is the newest name set with `--name`; otherwise the directory's
   *   basename and the session id's first 8 characters, such as
   *   `pitwall-5e66fcb3`, because Claude Code's default name for an unnamed
   *   session isn't recorded anywhere pitwall can read.
   * - `startedAt` and `lastActivityAt` are its first and newest entries' times.
   *
   * Listed while lastActivityAt is at most ENDED_LISTED_DAYS old, at most
   * ENDED_LISTED_MAX of them, newest first. The web UI shows those from the
   * last ENDED_SHOWN_DAYS, and the rest behind Show older (Phil, 2026-10-27).
   * Resume one with resumePath(): it keeps its sessionId, and is listed again
   * as a background session.
   */
  ended?: true;
  /**
   * Set when the session has finished its turn and its newest assistant message
   * looks like it asked the user something, with no user prompt since. A
   * heuristic over the transcript, not something Claude Code reports. The
   * turn's end is read from the transcript (spike 007, finding 4), not from
   * Claude Code's status, which a plugin's monitor or a restart can keep at
   * busy. Never while a prompt is on screen, or on a stale session.
   */
  askedYou?: AskedYou;
  /**
   * Set when the session needs you, with the reason (NeedsYou). The index sets
   * it on every snapshot, pitwall's first included, so after a restart Needs
   * you reflects each session's context: `state: 'blocked'` alone no longer
   * counts when pitwall could read the job's file. Never set on a stale or
   * finished session. Needs you, its count and the sort's first rank are
   * exactly the sessions that have it.
   */
  needsYou?: NeedsYou;
  /** ISO 8601 timestamp of the newest transcript entry, when the transcript was readable. */
  lastActivityAt?: string;
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
  /**
   * How many of the session's sub-agents are running (SubagentState
   * 'running'), when at least one is, for the row's "· 2 sub-agents running"
   * (W76; coordinator's call, Phil, 2026-10-27: "You'll know"). Only while the
   * session's process is alive. The session view's Sub-agents tab lists them
   * through subagentsPath().
   */
  subagentsRunning?: number;
  /**
   * The repos under a configured root that this session worked in, other than
   * the one it started in, newest touch first (W34, spike 004). A repo counts
   * when the session changed it, or when at least 5% of its tool calls,
   * sub-agents' included, touched it. It's shown in the session view only: a
   * session is listed under the group it started in and nowhere else (W39,
   * Phil, 2026-10-21), so a repo here may have no group in IndexSnapshot.groups.
   * The web UI may still show the session under one of these repos, by the
   * viewer's Group sessions by (W42), set in Preferences (W59).
   * Absent until the session's transcripts have been scanned, when they can't
   * be read, and when no repo passes the rule.
   */
  workedIn?: WorkedIn[];
}

/** One repo a session worked in, beyond its start (SessionSummary.workedIn). */
export interface WorkedIn {
  /** The repo's top-level directory: the SessionGroup.key its group has when it has one. */
  key: string;
  /** The repo's label, as its group's SessionGroup.label is or would be. */
  label: string;
  /**
   * The configured root the repo's group sits under, or would: SessionGroup.root. The web UI groups
   * the snapshot by the viewer's choice (W42, Group sessions by in Preferences), and needs it to place a session
   * under a repo that has no group in the snapshot.
   */
  root: string;
  /** Tool calls that touched the repo, sub-agents' included. */
  calls: number;
  /** Edits and writes in the repo, commits and pushes there, and PRs created or merged for it. */
  changes: number;
  /** ISO 8601: the newest call that touched the repo. */
  lastAt: string;
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
  /** Absolute path: the repo's top-level directory for git, otherwise the directory: sessions' cwd, or the configured root for its own group. */
  key: string;
  /**
   * `key` relative to the configured root it sits under, or the root's basename
   * for the root itself. When the key is outside the root (a worktree under the
   * root whose main repo isn't), the key with the home directory shortened to `~`.
   */
  label: string;
  /**
   * 'git' for a repo. 'directory' for a directory in no repo: a directory
   * below a root, or a root itself. Every group lists the sessions started in
   * it, and only those (W39).
   */
  kind: 'git' | 'directory';
  /** The configured root this group sits under. */
  root: string;
  /**
   * The sessions started in the group, each once. A session is in exactly one
   * group: the one it started in (W39, Phil, 2026-10-21: "The problem is
   * duplication"). A group with no sessions is left out, the root's own group
   * included.
   *
   * Sorted: sessions that need the user first (`needsYou`, whatever the
   * reason), then busy, then the rest, each by lastActivityAt descending
   * (startedAt when there's none). Stale sessions next, and finished sessions
   * (`finished`) last. Finished sessions are sorted by activity alone, so an
   * askedYou doesn't lift one.
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
  /**
   * Set once pitwall's relay has tried to do something nobody asked for in
   * this run: a SendMessage with no pending request, which usually means
   * another session messaged the relay, or one for your message that didn't
   * match it and that pitwall's gate may not have stopped. Absent until the
   * first one.
   */
  relayAlert?: RelayAlert;
  /**
   * Set once pitwall has stopped using its relay for the rest of this run,
   * because its gate let through, or didn't check, a SendMessage call (D8).
   * Messaging works again only after pitwall restarts. Absent while the relay
   * can be used. Not every relayAlert with `blocked: false` sets it: some only
   * restart the relay.
   */
  relayOff?: RelayOff;
}

/** Why pitwall stopped using its relay for this run (D8). */
export interface RelayOff {
  /** ISO 8601: when pitwall stopped using it. */
  since: string;
  /** Why, in pitwall's words, such as "its gate didn't check a SendMessage call." Never any message text. */
  reason: string;
}

/** The latest thing the relay tried that nobody asked for (W11, D8). */
export interface RelayAlert {
  /** ISO 8601, of the latest one. */
  at: string;
  /** What the relay tried, in pitwall's words. Never any message text. */
  detail: string;
  /** How many since pitwall started. */
  count: number;
  /**
   * True when pitwall's gate denied it before it ran, so nothing was sent.
   * False when pitwall saw it only afterwards, so it may have been sent.
   */
  blocked: boolean;
  /**
   * What the latest one was (W43, W52). 'unrequested': a SendMessage call with
   * no request of pitwall's behind it, which usually means another session
   * messaged the relay. 'changed': the call for one of your messages didn't
   * match it, such as another recipient, an option or field pitwall didn't
   * ask for, or text the relay changed. 'repeated': a second call for one of
   * your messages in the same turn, after pitwall's gate had blocked the
   * first. A call the gate blocked that differs from your message only in its
   * text raises no alert: pitwall tries it once more, on a new relay, and that
   * message's own result says the first copy was blocked and where it
   * differed. The relay's model drops or changes text in long copies, so an
   * alert there would be routine (W52's live check: 447 characters dropped
   * from a 6,000-character message). Any other blocked difference, such as
   * another recipient, `notify_when_idle` or a field pitwall doesn't check,
   * raises a blocked 'changed' alert and isn't tried again (W48's F3, W52).
   */
  cause: 'unrequested' | 'changed' | 'repeated';
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
  /**
   * A message this session sent to pitwall's relay with SendMessage, in full,
   * in place of that tool call: usually its reply to a message from pitwall
   * (W46). A call is to pitwall when its `to` is the relay's name, or a `uds:`
   * address that a cross-session message from the relay's name came from
   * earlier in the same transcript, on any page. A call whose result was an
   * error, or that has no `message` text, stays a 'tool' entry.
   */
  | 'to-pitwall'
  /**
   * A question Claude Code asked in its dialog (the AskUserQuestion tool), with
   * its options and the answers, in place of that tool call (W49). Claude Code
   * seems to write the call to the transcript only once it's answered, so an
   * open dialog has no entry. A call whose result was an error, such as a
   * dismissed dialog, keeps its questions, has no answers and sets
   * `toolError`. A call whose input isn't the shape below stays a 'tool' entry.
   */
  | 'question'
  /** Anything else worth showing: a compaction summary, a task notification, a command's output. */
  | 'notice';

/** One question in a 'question' entry (W49). Every string is plain text, never markdown or HTML. */
export interface AskedQuestion {
  /** The question, as asked. At most 2 Ki code units. */
  question: string;
  /** Its short label, when it has one. At most 256 code units. */
  header?: string;
  /** The choices offered, in order, at most 8. Each label at most 256 code units, each description at most 1 Ki. */
  options: Array<{ label: string; description?: string }>;
  /** True when more than one option could be chosen. */
  multiSelect?: boolean;
  /**
   * The answer as Claude Code recorded it, once answered: an option's label,
   * several labels for a multi-select, or text typed in place of an option.
   * At most 2 Ki code units.
   */
  answer?: string;
  /** Notes typed with the answer, when there are any. At most 2 Ki code units. */
  notes?: string;
}

export interface ConversationEntry {
  kind: ConversationEntryKind;
  /** ISO 8601, when known. */
  at?: string;
  /**
   * At most 32 Ki UTF-16 code units, as `String.length` counts them, by kind
   * (W36, Phil, 2026-10-21):
   * - 'assistant', 'cross-session' and 'to-pitwall': the markdown as written,
   *   with `markdown` set. A client renders it as text and its own elements,
   *   never as HTML. For 'to-pitwall' it's the SendMessage call's `message`.
   * - 'user': the prompt as typed, with nothing stripped.
   * - 'tool': a one-line summary of the call, such as `Bash: npm test` or
   *   `Edit: src/cli.ts`.
   * - 'notice': plain text.
   * - 'question': the first question, as a one-line summary; `questions` has
   *   them all (W49).
   * A page carries at most 256 Ki code units of its entries' text in full, newest
   * entries first. Entries past that are cut to 512 and marked `truncated`.
   */
  text: string;
  /** True when `text` is markdown: set on 'assistant', 'cross-session' and 'to-pitwall' entries. */
  markdown?: true;
  /** For 'tool': the tool's name. */
  toolName?: string;
  /** For 'tool' and 'question': whether the result was an error. */
  toolError?: boolean;
  /** For 'cross-session': the sender's name, as the receiving session saw it. */
  from?: string;
  /**
   * The session's sub-agent this entry is about (W76): on a 'cross-session'
   * entry its report or message came from, and on a 'tool' entry the Agent
   * call that started it or the SendMessage call sent to it. The UI labels the
   * entry by its description rather than its id, and links to it in the
   * Sub-agents tab.
   */
  subagent?: { agentId: string; description: string };
  /**
   * For 'question': the questions asked, in order, at most 8 (W49). Their text
   * counts toward the page's budget, and past it each string is cut to 512 and
   * the entry marked `truncated`.
   */
  questions?: AskedQuestion[];
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

/** The status a conversation request gets for a cursor made for another version of the transcript. */
export const CONVERSATION_STALE_STATUS = 410;

/**
 * HTTP path that returns a ConversationPage as JSON: the newest page, or the
 * page before the `before` cursor. A cursor for a file that was rotated or
 * rewritten gets 410, and the client should reload the newest page. More than
 * 4 reads at once get 429 with `Retry-After`. Only sessions in the current
 * snapshot (under the roots) are served: any other id gets 404.
 */
// For clients. A server building a route pattern from this must decode it,
// because the id is URL-encoded (`:sessionId` becomes `%3AsessionId`).
export function conversationPath(sessionId: string, before?: string): string {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/conversation`;
  return before === undefined ? path : `${path}?before=${encodeURIComponent(before)}`;
}

// ---------------------------------------------------------------------------
// Sub-agents (W76, W77; Phil, 2026-10-23: "How are sub-agents from a session
// shown in pitwall?", and 2026-10-27). Read-only, from the session's
// transcript folder: each sub-agent has a transcript and a meta file beside
// the session's own, and the session's transcript records when one starts and
// how it ends. Internal formats, behind the transcript adapter, failing soft.
// ---------------------------------------------------------------------------

/**
 * Where a sub-agent is.
 * - 'running': started, with no end recorded, while the session's process is
 *   alive.
 * - 'done', 'failed' and 'stopped': how it ended, from its task
 *   notification's status (completed; failed; killed or stopped), or, for one
 *   the session waited for, from its tool call's result (an error is
 *   'failed').
 * - 'unknown': no end recorded, and the session's process isn't alive, so it
 *   isn't running either.
 */
export type SubagentState = 'running' | 'done' | 'failed' | 'stopped' | 'unknown';

export interface SubagentSummary {
  /** Claude Code's id for it, such as `a7bfea4102a9f1853`: letters and digits only. */
  agentId: string;
  /**
   * The description it was started with, as plain text with control and bidi
   * characters removed, at most 200 characters. "Sub-agent" when there's none.
   */
  description: string;
  /** Its type, such as `general-purpose` or `Explore`, when recorded. */
  agentType?: string;
  /** True when the session went on while it ran, false when it waited for it. Absent when not recorded. */
  background?: boolean;
  state: SubagentState;
  /** The agentId of the sub-agent that started this one, when the session itself didn't. */
  startedBy?: string;
  /** ISO 8601: its first and newest transcript entries, when readable. */
  startedAt?: string;
  lastActivityAt?: string;
  /** How many tool calls its transcript records. */
  toolCalls: number;
}

/** The most sub-agents a SubagentList carries. */
export const SUBAGENTS_MAX = 200;

export interface SubagentList {
  sessionId: string;
  /** Running ones first, then the newest started first. At most SUBAGENTS_MAX. */
  subagents: SubagentSummary[];
  /** True when the session had more than SUBAGENTS_MAX, and the oldest were left out. */
  truncated: boolean;
}

/**
 * GET: the SubagentList of a session in the current snapshot. An unlisted
 * session gets 404, and one with no sub-agents an empty list. Shares the
 * conversation reads' limit: more than 4 reads at once get 429 with
 * `Retry-After`.
 */
export function subagentsPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/subagents`;
}

/**
 * GET: a ConversationPage of one sub-agent's transcript, newest page first,
 * with `before` cursors, exactly as conversationPath() pages a session's. The
 * page's `sessionId` is the session's. 404 unless the session is listed and
 * the agent is one of its sub-agents; 410 for a stale cursor; the same limit
 * as conversationPath().
 */
export function subagentConversationPath(sessionId: string, agentId: string, before?: string): string {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}/conversation`;
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
   * ambiguous, the relay couldn't start, or pitwall's gate denied the relay's
   * SendMessage call because it didn't match the request, on the first try
   * and on pitwall's one retry (W43). Then `detail` says where the call first
   * differed, by line and character code, never with the text.
   */
  | 'failed'
  /**
   * The relay called SendMessage, but pitwall couldn't confirm what happened,
   * for example because the relay stopped before the tool's result arrived. It
   * may have reached the session: check its conversation before sending again.
   */
  | 'uncertain';

/**
 * Body of a POST to relayPath(). `text` is 1 to 8,192 characters, sent
 * verbatim except that spaces that look like a space, such as a no-break
 * space, become a plain space, and a CRLF line break becomes LF (W43): the
 * relay's model tends to write those as plain ones, and its gate then blocks
 * the copy.
 */
export interface RelayRequest {
  text: string;
}

export interface RelayResult {
  status: RelayStatus;
  /**
   * A short explanation, for example why it was refused or failed. On
   * 'delivered' after pitwall's one retry, it says the gate blocked the
   * relay's first copy and the second went through (W52). Never message text.
   */
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
  /**
   * The first prompt, 1 to 16,384 characters. Not just the name of a
   * `claude` command, such as `update` or `purge`, which `claude --bg` would
   * run as that command: that gets 400.
   */
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

/**
 * The directories under the roots, for the New session dialog's "Another
 * directory under a root…" field, which narrows them as you type (Phil,
 * 2026-10-27). GET, no query, answered with a DirectoryList. The same token,
 * Host and Origin checks as every other route.
 *
 * The server walks each root to DIRECTORY_DEPTH levels below it, and lists
 * directories only: never a file or a symlink, and never a folder whose name
 * starts with `.`, is `node_modules`, or has a control or bidi control
 * character, nor anything inside one. It stops a root at DIRECTORY_MAX entries
 * or after 2 seconds, and says so with `truncated`. A result is reused for 30
 * seconds, and requests during a walk share it. A root it can't read lists
 * none. A spawn still checks its `cwd` as before: the list only helps to type it.
 */
export const DIRECTORIES_PATH = '/api/directories';

/** How many levels below a root the directory list goes. */
export const DIRECTORY_DEPTH = 3;

/** The most directories listed under one root. */
export const DIRECTORY_MAX = 5000;

export interface DirectoryEntry {
  /** Relative to its root, `/`-separated, with no leading or trailing slash. */
  path: string;
  /** Set when the directory has a `.git` entry: a repo's top level or a worktree. */
  repo?: true;
}

export interface DirectoryList {
  roots: Array<{
    /** The root, as IndexSnapshot.roots lists it. */
    root: string;
    /** Shallower first, then by path, compared by UTF-16 code unit. */
    dirs: DirectoryEntry[];
    /** True when the walk stopped early, at DIRECTORY_MAX entries or the time limit. */
    truncated: boolean;
  }>;
}

/**
 * Result of stop, remove and open in an editor. Stop and remove apply to
 * background sessions only; others get 409, ended interactive sessions
 * included. More than 4 stop, remove, resume or open commands at once get 429
 * with `Retry-After`.
 */
export type ActionResult = { ok: true } | { ok: false; error: string };

/** Stop a background session with `claude stop`. Its conversation is kept. */
export function stopPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/stop`;
}

/** Remove a background session with `claude rm`. Claude Code keeps a worktree that has unpushed commits. */
export function removePath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/remove`;
}

/** How long an ended interactive session stays listed, by its newest entry (SessionSummary.ended). */
export const ENDED_LISTED_DAYS = 30;

/** The most ended interactive sessions a snapshot lists, newest first. */
export const ENDED_LISTED_MAX = 100;

/** How far back the web UI shows ended sessions before Show older (Phil, 2026-10-27). */
export const ENDED_SHOWN_DAYS = 7;

/**
 * The result of resuming an ended interactive session.
 *
 * - ok: Claude Code resumed it in the background under its own session id,
 *   with no prompt, so it waits for one. `shortId` is the id `claude attach`
 *   takes.
 * - not ok: `hint` is a command for the user to run, such as the one that
 *   trusts a workspace. `copyShortId` is set when Claude Code started a copy
 *   under a new id instead, because the session was open in another Claude
 *   Code process after all (spike 006, finding 5); the copy is a background
 *   session with no name.
 */
export type ResumeResult =
  | { ok: true; shortId: string }
  | { ok: false; error: string; hint?: string; copyShortId?: string };

/**
 * Resume an ended interactive session (SessionSummary.ended) in the
 * background: `claude --resume <sessionId> --bg`, with no prompt, in the
 * session's own `cwd`, never a directory the request names. POST, no body.
 *
 * - 404 when the snapshot doesn't list the session, and 409 when it isn't
 *   ended, when its directory no longer exists, when a resume of it is
 *   already running, or when a fresh `claude agents --json` lists it, as when
 *   its terminal is open again.
 * - 429 with `Retry-After` past 4 stop, remove or resume commands at once.
 */
export function resumePath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/resume`;
}

/**
 * An editor pitwall's server can open a session's directory in (Phil,
 * 2026-10-23: "open in editor such as code or cursor", option A: the server
 * opens it, since a browser can't tell what's installed).
 */
export type EditorId = 'vscode' | 'cursor';

export interface Editor {
  id: EditorId;
  /** As shown, such as "VS Code" or "Cursor". */
  label: string;
}

/**
 * The editors found on this machine, answered with an EditorList. GET, no
 * query. The server looks once, at startup: on macOS for each editor's app
 * bundle in /Applications or ~/Applications, opened with /usr/bin/open -a;
 * elsewhere for its command on PATH (`code`, `cursor`), resolved to an
 * absolute path then. An empty list means none was found, and the web UI
 * offers nothing.
 */
export const EDITORS_PATH = '/api/editors';

export interface EditorList {
  editors: Editor[];
}

/** Body of a POST to openInEditorPath(). */
export interface OpenInEditorRequest {
  editor: EditorId;
}

/**
 * Open a listed session's own `cwd` in an editor from EditorList, answered
 * with an ActionResult. POST with an OpenInEditorRequest. The directory is
 * always the snapshot's, never one the request names; the editor runs with no
 * shell and a scrubbed environment.
 *
 * - 400 for a malformed body or an editor that isn't in EditorList.
 * - 404 when the snapshot doesn't list the session; 409 when its directory
 *   no longer exists (`cwdMissing`).
 * - 429 with `Retry-After`, sharing stop, remove and resume's limit.
 * - 502 when the editor failed to start, and 504 when it didn't return within
 *   10 seconds.
 */
export function openInEditorPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/open`;
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
 * - 'needs-restart': attaching would restart the session, because it has
 *   finished, or its process has exited. The server decides on `open`, from a
 *   fresh `claude agents --json --all` read when the snapshot's process isn't
 *   alive. Ask the user, then send `open` again with `restart: true`.
 * - 'attached': output follows as binary frames.
 * - 'exit': `claude attach` ended. Closing the socket detaches; the session
 *   keeps running.
 * - 'error': followed by a close. A session that is still starting, with no
 *   process yet and started or spawned moments ago, closes with 1013 (try
 *   again later).
 *
 * A socket beyond 32 pending handshakes, on WS_PATH and ATTACH_PATH
 * together, is closed with 1013 before any challenge.
 */
export type AttachServerMessage =
  | { type: 'challenge'; version: number; nonce: string }
  | { type: 'ready' }
  | { type: 'needs-restart' }
  | { type: 'attached' }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; error: string };
