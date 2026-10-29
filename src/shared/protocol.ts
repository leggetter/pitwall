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
  /** Display name: the set name, or Claude Code's default such as `demo-app-3f`. */
  name: string;
  /**
   * A short description of what the session is about, shown after the name, as
   * in `demo-app-3f · Fix the flaky export test`. Omitted when
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
  /**
   * The pull requests this session opened, pushed to, was linked to by Claude
   * Code (W105) or was given in a prompt, and the ones Claude named in its
   * replies, from its transcript and its sub-agents' (M4, W94). Newest first,
   * one per kind and PR (or pushed branch), at most PR_LINKS_STRONG_MAX strong
   * links and PR_LINKS_MAX mentioned ones. The index doesn't know which PRs are open
   * or whose they are, and keeps them all; the server sends only those that match
   * a PR in the current PullRequestList (prLinkMatches()), and the snapshot again
   * when the list changes that (D14, W105), so none is sent before the first fetch
   * or with `--no-prs`. Absent until the session's transcripts have been scanned,
   * when they can't be read, and when none is left.
   */
  prLinks?: PrLink[];
}

/**
 * How a session is linked to a pull request (M4; coordinator's call,
 * 2026-10-28). In Phil's transcripts from the 30 days to 2026-10-28, 22
 * sessions named at least one of his 50 open PRs, and one named 13, mostly in
 * tool output such as `gh pr list`, so a URL anywhere in a transcript isn't a
 * link.
 *
 * - 'opened': the session created it. Its URL is in the result of a `gh pr
 *   create`, or of a GitHub MCP server's create-pull-request tool.
 * - 'pushed': the session pushed a branch, by `git push`'s output, which
 *   names the repo and the branch. It matches the PR whose head is that branch
 *   in that repo.
 * - 'linked': Claude Code linked the session to it itself, with a `pr-link`
 *   transcript entry (M4 redesign, W104). The entry is internal, read behind
 *   the transcript adapter; what makes one is documented (agent view, "Pull
 *   request status"): `gh pr create`, a `gh` edit, comment, close or ready on
 *   it, and a push or `gh pr checkout` that Claude Code matches to it. A
 *   sub-agent's link is written in its parent's transcript. Claude Code
 *   writes the current PR's entry again and again, so `lastAt` is the newest.
 * - 'prompted': its URL is in a prompt you typed. Messages from other
 *   sessions don't count, as for SessionSummary.lastUserPrompt.
 * - 'mentioned': its URL is in Claude's own text in a reply. Tool input and
 *   output never count.
 *
 * All but 'mentioned' are strong (prLinkIsStrong()): only those can make a
 * session a PR's owner (prOwner()). The PR view lists 'mentioned' ones apart,
 * as "Mentioned in".
 */
export type PrLinkKind = 'opened' | 'pushed' | 'linked' | 'prompted' | 'mentioned';

/** One link from a session to a pull request (SessionSummary.prLinks). */
export interface PrLink {
  kind: PrLinkKind;
  /**
   * Lowercase `owner/name`. For 'pushed', the repo pushed to, compared with
   * PullRequestSummary.head; otherwise compared with PullRequestSummary.repo.
   */
  repo: string;
  /** The PR's number. Every kind but 'pushed'. */
  number?: number;
  /** The branch pushed, as the remote names it, without `refs/heads/`. 'pushed' only. */
  branch?: string;
  /** ISO 8601: the newest time the session did it. */
  lastAt: string;
}

/**
 * The most 'mentioned' links one session carries (SessionSummary.prLinks), newest first. Strong
 * links have their own, higher cap, PR_LINKS_STRONG_MAX: with one cap of 20 for all of them, 10 of
 * Phil's sessions lost older strong links, and only 187 of 324 real pairs were kept (2026-10-29).
 */
export const PR_LINKS_MAX = 20;

/** The most strong links one session carries (prLinkIsStrong()), newest first. */
export const PR_LINKS_STRONG_MAX = 200;

/** True for the kinds that say a session worked on the PR (PrLinkKind). */
export function prLinkIsStrong(link: PrLink): boolean {
  return link.kind !== 'mentioned';
}

/**
 * How strongly a link makes its session a PR's owner (prOwner()): 2 for 'opened', 'pushed' and
 * 'linked', which say the session acted on it; 1 for 'prompted', which owns only when no session
 * acted on it; 0 for 'mentioned', which never owns.
 */
export function prLinkRank(link: PrLink): 0 | 1 | 2 {
  if (link.kind === 'mentioned') return 0;
  return link.kind === 'prompted' ? 1 : 2;
}

/**
 * The session that owns `pr` (M4 redesign, W104; Phil, 2026-10-29: "if a session has worked on a
 * pull request, the pull request should not be shown and should effectively be part of an agent
 * session"). Of the sessions with a link that matches it (prLinkMatches()), the one whose best
 * matching link has the highest prLinkRank(), then the newest `lastAt`, then the smallest
 * sessionId, so the answer is stable. So another session acting on the PR later takes it over.
 * Undefined when no session has a strong link to it. An ended session keeps its PR: the PR's work
 * isn't finished while it's open, so that session stays out of Finished (Phil, 2026-10-29).
 */
export function prOwner<T extends { sessionId: string; prLinks?: PrLink[] | undefined }>(
  pr: PullRequestSummary,
  sessions: readonly T[],
): T | undefined {
  let best: { session: T; rank: number; at: number } | undefined;
  for (const session of sessions) {
    for (const link of session.prLinks ?? []) {
      const rank = prLinkRank(link);
      if (rank === 0 || !prLinkMatches(link, pr)) continue;
      const parsed = Date.parse(link.lastAt);
      const at = Number.isFinite(parsed) ? parsed : 0;
      const better =
        best === undefined ||
        rank > best.rank ||
        (rank === best.rank && (at > best.at || (at === best.at && session.sessionId < best.session.sessionId)));
      if (better) best = { session, rank, at };
    }
  }
  return best?.session;
}

/** True when `link` points at `pr`: by repo and number, or for 'pushed', by the PR's head. */
export function prLinkMatches(link: PrLink, pr: PullRequestSummary): boolean {
  if (link.kind === 'pushed') {
    return pr.head !== undefined && link.repo === pr.head.repo && link.branch === pr.head.branch;
  }
  return link.repo === pr.repo && link.number === pr.number;
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
 * - 'prs' (M4): your open pull requests, sent right after the first
 *   'snapshot', and again whenever anything in the list changes, `refreshing`
 *   included. Its own poller sends it, never the session poll.
 */
export type ServerMessage =
  | { type: 'challenge'; version: number; nonce: string }
  | { type: 'authenticated'; apiKey: string }
  | { type: 'snapshot'; snapshot: IndexSnapshot }
  | { type: 'heartbeat'; generatedAt: string; source: SourceHealth }
  | { type: 'prs'; prs: PullRequestList }
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
  /**
   * True on an entry written while a turn ran, so it never began one (W102):
   * what arrived mid-turn, a prompt typed while Claude worked, a message from
   * another session or a sub-agent, or a task notification (W99's
   * `queued_command` attachments); a compaction summary; and Claude Code's own
   * API error notice. The web UI's working line counts a turn's time from the
   * newest 'user', 'cross-session' or 'notice' entry without it, before
   * Claude's entries since.
   */
  midTurn?: true;
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
  /**
   * On the newest page only (W102): true when Claude Code's mark that a turn
   * ended, a `turn_duration` system entry (spike 007, finding 4), is newer than
   * every entry that runs a turn: any of Claude's lines, a thinking block's
   * alone included, a tool's result or a prompt, or a message from another
   * session or a task notification, which Claude Code starts a turn for; false
   * when one of those is newer, as always for an older Claude Code, which
   * writes no such mark. Absent when the page has neither, as for an empty
   * transcript, and on a sub-agent's page, whose entries are all its own. The
   * index's rule for its own turn's end (W69) is the same, but leaves a
   * message or a task notification out, so a question asked stays in Needs
   * you. The web UI hides its working line when it's true, whatever Claude
   * Code's status says, which a plugin's monitor can keep at busy (spike 007,
   * finding 6).
   */
  turnEnded?: boolean;
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
 *
 * In a sub-agent's page, a 'user' entry is what started or messaged it: the
 * session, or the sub-agent named by `startedBy`, never the user's own
 * prompt. The UI labels it so, for example "From the session".
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
  /**
   * Optional files for the first prompt (W79, spike 008): ids from
   * AttachmentResult, at most ATTACHMENTS_MAX_PER_SESSION, each used once.
   * The server appends one `@<absolute path>` line per file to the prompt,
   * after a blank line, which Claude Code turns into attachments, and passes
   * `--add-dir=<its folder>` for each, always in the `=` form, since
   * `--add-dir` takes several values and would swallow the prompt. An
   * unknown, expired or already-used id gets 400, and nothing starts.
   */
  attachments?: string[];
}

export type SpawnResult =
  | { ok: true; shortId: string; name: string }
  /**
   * `hint` is a command for the user to run, such as the one that trusts a
   * workspace. None for a directory whose path has a `'` or `\`, which shells
   * don't all read the same way inside single quotes; `error` is then Claude
   * Code's line alone, and the page says why there's no command (W87).
   */
  | { ok: false; error: string; hint?: string };

/** Start a new background session with `claude --bg`. */
export const SPAWN_PATH = '/api/sessions';

/**
 * Upload one file for New session's first prompt (W79, spike 008), answered
 * with an AttachmentResult. POST, the file's bytes as the body, its media type
 * as `Content-Type` (one of ATTACHMENT_TYPES), and its name, URL-encoded, in
 * `X-Pitwall-Filename`. The same apiKey, `Host` and `Origin` checks as every
 * other POST.
 *
 * The server keeps it in a folder of its own, `~/.pitwall/attachments/<id>/`
 * (folders 0700, files 0600), under a safe stored name (letters, digits, `.`,
 * `-` and `_`, since an `@` mention ends at a space), never inside a
 * session's directory. An upload never used is removed after an hour; a used
 * one 7 days after its session started, or sooner, oldest first, once used
 * uploads pass 500 MiB in all, because Claude Code keeps an attachment's
 * content in the transcript.
 *
 * - 201 with the Attachment.
 * - 400 for an empty file, or a name that's empty, longer than 200
 *   characters, or has a path separator, control or bidi character; 413 past
 *   ATTACHMENT_MAX_BYTES, from `Content-Length` or while streaming; 415 for a
 *   type not in ATTACHMENT_TYPES, one its first bytes contradict, or any
 *   `Content-Encoding`; 429 past ATTACHMENTS_MAX_PENDING unused uploads,
 *   counting those still arriving. 408 when an upload sends nothing for 30
 *   seconds, or takes more than 2 minutes in all, and nothing is kept.
 * - 503 when attachments are unavailable: no pitwall home folder, a home path
 *   with characters an `@` mention can't carry (anything but letters, digits,
 *   `.`, `_`, `/` and `-`), or Windows. 500 when the file couldn't be written.
 */
export const ATTACHMENTS_PATH = '/api/attachments';

/**
 * DELETE: remove an upload no spawn has used yet, as when it's removed from
 * the dialog or the dialog closes, freeing its place among
 * ATTACHMENTS_MAX_PENDING. 204 when removed; 404 for an unknown id; 409 for
 * one a spawn has used, which the server removes on its own schedule. The
 * same apiKey, `Host` and `Origin` checks as every other state-changing
 * request.
 */
export function attachmentPath(id: string): string {
  return `${ATTACHMENTS_PATH}/${encodeURIComponent(id)}`;
}

/**
 * The media types an attachment can have: images, PDF and plain text. Any
 * text file, such as source code, configuration or a log, goes as
 * `text/plain` whatever type the browser gives it (`text/x-python`, none, or
 * `video/mp2t` for a `.ts` file), and the server keeps its extension and
 * checks that it's UTF-8 with no NUL.
 */
export const ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
] as const;

export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/** The largest file an attachment can be: 10 MiB. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** The most attachments one new session's first prompt can carry. */
export const ATTACHMENTS_MAX_PER_SESSION = 10;

/** The most uploads the server holds that no spawn has used yet. */
export const ATTACHMENTS_MAX_PENDING = 30;

export interface Attachment {
  /** The server's id for it, a UUID. */
  id: string;
  /** The name as uploaded, cleaned, for display. */
  name: string;
  type: AttachmentType;
  /** In bytes. */
  size: number;
}

export type AttachmentResult = { ok: true; attachment: Attachment } | { ok: false; error: string };

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
 * included. More than 4 stop, remove, resume, open or end commands at once get
 * 429 with `Retry-After`, and so do opens in an editor past 10 a minute (W87).
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
 *   trusts a workspace, none for a path with a `'` or `\`, as for spawn
 *   (W87). `copyShortId` is set when Claude Code started a copy
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
 * It runs in the directory's real path as checked just before it starts, and
 * only for a session id that is a UUID (W73, W81).
 *
 * - 404 when the snapshot doesn't list the session, and 409 when it isn't
 *   ended or its id isn't a UUID, when its directory no longer exists or
 *   now resolves elsewhere,
 *   when a resume of it is already running, or when a fresh
 *   `claude agents --json` lists its session id in any row, as when its
 *   terminal is open again.
 * - 429 with `Retry-After` past 4 stop, remove, resume or open commands at
 *   once, and, since it starts a long-lived session, past spawn's limit of
 *   sessions started in the last minute, which it shares (W81).
 */
export function resumePath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/resume`;
}

/**
 * Body of a POST to endSessionPath() (W90). `whileWorking` is true only after
 * the user confirmed the stronger warning, which names what's running from a
 * 409's `working`; otherwise the body is `{}`.
 */
export interface EndSessionRequest {
  whileWorking?: true;
}

/** What ending a session would stop, as the server found it just before (spike 005). */
export interface EndSessionWorking {
  /**
   * 'running': its transcript says a turn hasn't ended (W69's rule), as while
   * a reply is written or a tool runs, or Claude Code shows a prompt; the
   * reply is lost and the tool is killed. 'unknown': its transcript can't
   * say. Absent when its turn has ended.
   */
  turn?: 'running' | 'unknown';
  /**
   * How many of its sub-agents are running, by a scan just then, when any are; they're killed with
   * it. 'unknown' when pitwall couldn't read them, which counts as working too.
   */
  subagents?: number | 'unknown';
}

export type EndSessionResult =
  /**
   * Signalled. `ended` is whether its process had exited within
   * END_SESSION_WAIT_MS; when not, it may still be finishing.
   */
  | { ok: true; ended: boolean }
  /** Nothing was signalled. `working` comes with a 409 for a working session sent without `whileWorking`. */
  | { ok: false; error: string; working?: EndSessionWorking };

/** How long the server waits for an ended session's process to exit before it answers. */
export const END_SESSION_WAIT_MS = 5000;

/**
 * End a running interactive session (W90, spike 005): pitwall sends its
 * Claude Code process SIGTERM, never SIGKILL, so its terminal returns to the
 * shell, its SessionEnd hooks run, and its transcript is kept; it's then
 * listed as ended, and can be resumed. POST an EndSessionRequest. The pid is
 * always the one a fresh `claude agents --json --all` gives, checked again
 * just before the signal, never one the request names.
 *
 * - 400 for a malformed body. 404 when the snapshot doesn't list the session.
 * - 409, and nothing signalled, when: it isn't interactive, running, and
 *   listed afresh with the snapshot's pid; any other row names that pid, or
 *   any row another pid for it; its id isn't a UUID; it's a relay, this
 *   pitwall's or one named `pitwall-relay`; its process isn't `claude`, or
 *   started after the session did, or isn't the same process just before the
 *   signal; pitwall runs under it or started it; an end of it is already
 *   running; or, without `whileWorking`, it's working, with `working`.
 * - 429 with `Retry-After`, sharing stop, remove, resume and open's 4 at once,
 *   and past 5 ends a minute.
 * - 502 when pitwall couldn't check it: `claude agents` or `ps` failed.
 */
export function endSessionPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/end`;
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
 * - 429 with `Retry-After`, sharing stop, remove and resume's limit, and
 *   past 10 opens a minute, of any session in either editor (W87).
 * - 502 when the editor failed to start, and 504 when it didn't return within
 *   10 seconds.
 */
export function openInEditorPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/open`;
}

// ---------------------------------------------------------------------------
// M4: your open pull requests. Read-only and separate from the session index:
// its own poller runs its three searches (W101), one `gh api graphql` call
// each, every PRS_POLL_INTERVAL_MS, with no shell, so GitHub's token stays
// inside gh. PR titles from private repos are as sensitive as session data.
// ---------------------------------------------------------------------------

/**
 * A GitHub owner, as a regular expression's source, to put inside a larger pattern: letters,
 * digits, `-`, and `_` for an Enterprise Managed User's `name_shortcode`, starting with a letter or
 * digit, at most 100 characters. W93's reader (src/prs/parse.ts) and the web UI (web/src/prs.ts,
 * openPr.ts) use this one pattern, so an owner one keeps the other never drops. Case is GitHub's;
 * PullRequestSummary.repo and PrLink.repo are the lowercase form.
 */
export const GITHUB_OWNER_PATTERN = '[A-Za-z0-9][A-Za-z0-9_-]{0,99}';

/**
 * A GitHub repo name, as a regular expression's source: letters, digits, `.`, `-` and `_`, at most
 * 100 characters. It also matches `.` and `..`, which GitHub never names a repo and every user of it
 * refuses on its own. Neither pattern can hold a `/`, `?`, `#`, `@`, `%` or space, so `owner/name`
 * can't step outside a PR's own path in a URL.
 */
export const GITHUB_REPO_NAME_PATTERN = '[A-Za-z0-9._-]{1,100}';

/**
 * The latest commit's status check rollup: SUCCESS is 'passing'; FAILURE and
 * ERROR are 'failing'; PENDING and EXPECTED are 'pending'; 'none' when the
 * commit has no checks.
 */
export type PullRequestChecks = 'passing' | 'failing' | 'pending' | 'none';

/** GitHub's reviewDecision. */
export type PullRequestReview = 'approved' | 'changes-requested' | 'review-required';

/**
 * How a pull request is yours (W101; Phil, 2026-10-29: "cover cases where I've been requested or
 * probably tagged, because not everybody follows the request process"). Each is one of the fetch's
 * searches, open PRs only, in repos that aren't archived:
 *
 * - 'authored': you opened it (`author:@me`).
 * - 'review-requested': your review is requested, of you or of a team you're on
 *   (`review-requested:@me -author:@me`; GitHub's docs say it includes a team's requests). They also
 *   say a requested person leaves the results once they've reviewed, so a PR asked of you leaves
 *   the next fetch's list. For a team's, that isn't documented; likely, the team's request is met by
 *   a member's review on its behalf (PullRequestReview.onBehalfOf). pitwall also leaves out one
 *   whose own requests no longer name you or a team, as GitHub's search index lags behind a review.
 * - 'mentioned': it @-mentions you (`mentions:@me`), and you didn't open it (`-author:@me`) and
 *   aren't asked to review it.
 *
 * A PR that more than one search finds is listed once, as the first of PR_RELATIONS that found it.
 */
export type PullRequestRelation = 'authored' | 'review-requested' | 'mentioned';

/** The relations, in the order that decides which one a PR found by several searches is. */
export const PR_RELATIONS: readonly PullRequestRelation[] = ['authored', 'review-requested', 'mentioned'];

/**
 * How your review was requested (PullRequestSummary.reviewRequest), from the PR's review requests:
 *
 * - 'direct': of you, by name, as `user-review-requested:@me` finds.
 * - 'team': not of you by name, so of a team you're on. `team` is its `org/slug`
 *   (GITHUB_OWNER_PATTERN, a slash, then GITHUB_REPO_NAME_PATTERN), when exactly one team was asked;
 *   with several, pitwall can't tell which one you're on, so it names none.
 */
export type PullRequestReviewRequest = { via: 'direct' } | { via: 'team'; team?: string };

/**
 * GitHub's mergeable. 'unknown' while GitHub is still working it out, as it
 * often is just after a push: 13 of Phil's 50 open PRs on 2026-10-28.
 */
export type PullRequestMergeable = 'clean' | 'conflicts' | 'unknown';

export interface PullRequestSummary {
  /**
   * `https://github.com/<owner>/<name>/pull/<number>`. The server leaves out a
   * PR whose URL isn't exactly that, for its own repo and number, so the web
   * UI can link it as it is.
   */
  url: string;
  /** Lowercase `owner/name`: what PrLink.repo is compared with. */
  repo: string;
  /** `owner/name` as GitHub spells it, for display. */
  repoLabel: string;
  number: number;
  /**
   * Plain text, with control and bidi control characters removed, at most
   * PR_TITLE_MAX characters. Shown in `<bdi>`, never as Markdown.
   */
  title: string;
  draft: boolean;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
  /**
   * The head branch, and the repo it's in as lowercase `owner/name`: a fork's,
   * for a PR from a fork. What a 'pushed' PrLink is compared with. Absent when
   * that repo no longer exists, and when the branch's name is empty, over 255
   * characters, or has a control or bidi control character, so a branch is
   * always one pitwall can compare and show as it is.
   */
  head?: { repo: string; branch: string };
  checks: PullRequestChecks;
  /**
   * When `checks` is 'failing': the failing checks' names, plain text, at most
   * PR_FAILING_CHECKS_MAX. A check run fails with conclusion FAILURE,
   * TIMED_OUT, CANCELLED, ACTION_REQUIRED or STARTUP_FAILURE, and a status
   * context with state FAILURE or ERROR.
   */
  failingChecks?: string[];
  /** When more checks failed than failingChecks lists: how many failed in all. */
  failingCount?: number;
  /** Absent when GitHub reports no decision, as in a repo that requires no reviews. */
  review?: PullRequestReview;
  mergeable: PullRequestMergeable;
  /** How it's yours (W101): you opened it, your review is requested, or it mentions you. */
  relation: PullRequestRelation;
  /**
   * For relation 'review-requested': of you by name, or of a team you're on. Absent when the PR's
   * review requests don't say, as when none of them could be read.
   */
  reviewRequest?: PullRequestReviewRequest;
  /**
   * Where the PR is listed when no session owns it (prOwner()), from the server, which knows every
   * repo under the roots and the config file (M4 redesign, W104). Absent from a server that
   * doesn't place PRs, which the web UI treats as 'unclaimed'.
   */
  place?: PullRequestPlace;
}

/**
 * Where a PR with no owning session is listed (PullRequestSummary.place):
 *
 * - 'cloned': a git repo under a root has a GitHub remote, any of its remotes, for the PR's repo,
 *   or failing that for its head's repo (a fork's clone). `key` is that repo's top-level directory,
 *   the SessionGroup.key its group has or would have, and `label` its label as SessionGroup.label
 *   is or would be. With several clones: the one whose directory is named like the repo, then
 *   the one whose `origin` points at it, then the one under the first root given, then the first
 *   by path.
 * - 'not-cloned': no clone, and `root` claims the repo's owner (RootOwners). The web UI lists the
 *   repo under that root as not cloned, `owner/name`, with its PRs.
 * - 'unclaimed': no root claims it. Not listed, but counted, so the UI can say how many are hidden
 *   and how to show them.
 */
export type PullRequestPlace =
  | { kind: 'cloned'; root: string; key: string; label: string }
  | { kind: 'not-cloned'; root: string }
  | { kind: 'unclaimed' };

/**
 * Which GitHub owners (orgs or users) a root claims, for PRs in repos no root has a clone of
 * (PullRequestPlace 'not-cloned'). Owners are lowercase. An owner is claimed (Phil, 2026-10-29:
 * each owner goes to the root with the most clones from it, and the config file overrides that;
 * the rule as set in W105's review), ties always by the order the roots were given:
 *
 * 1. By the root whose configured list (`github.owners`) names it.
 * 2. Otherwise, by the root with the most clones whose remotes point at it, counting every root's,
 *    unless that root's config is 'none' or a list that doesn't name it: then by the next root by
 *    clones that would claim it, one with no config or with 'all'.
 * 3. Otherwise, by the first root configured 'all'. None claims it otherwise.
 *
 * `owners` is the config file's value for a root it configures (source 'config'): a list, 'all' or
 * 'none'. For any other root (source 'clones'), the owners step 2 gives it. An owner step 2 gives a
 * root configured 'all' is in no list, and step 3 reaches it, since the config file allows one root
 * with 'all' (W103, D24).
 */
export interface RootOwners {
  /** An absolute, real-path root, as IndexSnapshot.roots has it. */
  root: string;
  owners: string[] | 'all' | 'none';
  source: 'config' | 'clones';
}

/**
 * True for a PR that needs you, which the Pull requests item counts:
 *
 * - One you opened with failing checks, merge conflicts or changes requested, drafts included.
 * - One whose review is requested of you, or of a team you're on (W101): it waits on you until the
 *   request is met, when the next fetch drops it (PullRequestRelation).
 *
 * One that only mentions you never does, and neither do another author's failing checks or
 * conflicts: they're theirs to fix.
 */
export function prNeedsAttention(pr: PullRequestSummary): boolean {
  if (pr.relation === 'review-requested') return true;
  if (pr.relation !== 'authored') return false;
  return pr.checks === 'failing' || pr.mergeable === 'conflicts' || pr.review === 'changes-requested';
}

/**
 * Whether the latest fetch worked. On a failure the reason says why, and
 * `error` says it in pitwall's words, never gh's output:
 *
 * - 'off': pitwall was started with `--no-prs`, and never runs gh.
 * - 'gh-missing': there's no `gh` on PATH.
 * - 'gh-auth': gh isn't logged in to github.com (gh's exit code 4).
 * - 'error': anything else, such as a timeout, no network or a response
 *   pitwall can't read.
 */
export type PullRequestSource =
  | { ok: true }
  | { ok: false; reason: 'off' | 'gh-missing' | 'gh-auth' | 'error'; error: string };

/**
 * One search's part of the list (W101; PullRequestList.searches). Each search is its own call, so
 * one can fail while the others work; its PRs are then the last it found, from `fetchedAt`.
 */
export interface PullRequestSearchState {
  /** ISO 8601: when this search last worked. Absent until it has. */
  fetchedAt?: string;
  /** Set when its latest try failed: why, in pitwall's words, never gh's output. */
  failed?: { reason: 'gh-missing' | 'gh-auth' | 'error'; error: string };
}

/** Your open pull requests: GET PRS_PATH, and the 'prs' WebSocket message. */
export interface PullRequestList {
  /** ISO 8601: when the newest fetch in which any search worked finished. Absent until one has. */
  fetchedAt?: string;
  /**
   * Whether the latest fetch worked: ok when any of its searches did, so a list exists, even if
   * another failed, which `searches` says. Not ok, with why, only when every one failed.
   */
  source: PullRequestSource;
  /**
   * Each search's part (W101), by relation, once a fetch has finished: when it last worked and
   * whether its latest try failed. Absent before the first fetch and with `--no-prs`.
   */
  searches?: Partial<Record<PullRequestRelation, PullRequestSearchState>>;
  /** True while a fetch is running. */
  refreshing: boolean;
  /**
   * Your open PRs on github.com, in repos that aren't archived: those you
   * opened, those whose review is requested of you, and those that mention
   * you (PullRequestRelation), each once, newest updatedAt first. At most
   * PRS_MAX from each search, so at most PRS_LIST_MAX. After a search fails,
   * its last good PRs stay, from its own fetchedAt in `searches`. Empty before the first
   * fetch that worked. The web UI shows those updated in the last
   * PRS_SHOWN_DAYS, and the rest behind Show older.
   */
  prs: PullRequestSummary[];
  /** True when GitHub found more than PRS_MAX for any one search, and the rest of it were left out. */
  truncated?: true;
  /** Which owners each root claims (RootOwners), so the UI can explain where a PR is and why one is hidden. */
  roots?: RootOwners[];
}

/** GET: the latest PullRequestList, with the same authorization as SNAPSHOT_PATH. */
export const PRS_PATH = '/api/prs';

/**
 * POST, no body: fetch your open PRs now, answered with an ActionResult. It
 * needs what every state-changing request needs: the apiKey, pitwall's
 * Origin and its exact Host. ok when a fetch started or one was already
 * running; the list arrives as a 'prs' message.
 *
 * - 409 when pull requests are off (`--no-prs`).
 * - 429 with `Retry-After` when the latest fetch started less than
 *   PRS_REFRESH_MIN_MS ago.
 */
export const PRS_REFRESH_PATH = '/api/prs/refresh';

/** How often the PR poller fetches: 3 minutes. Never tied to the session poll. */
export const PRS_POLL_INTERVAL_MS = 3 * 60 * 1000;

/**
 * The shortest gap between the starts of two fetches that a refresh may cause: a minute (W100;
 * Phil, 2026-10-29: "Every 15 seconds seems a bit excessive"). A fetch took about 8.5 s on
 * 2026-10-28.
 */
export const PRS_REFRESH_MIN_MS = 60 * 1000;

/**
 * A pass of a search that takes longer, all its pages, fails with reason 'error'; a second pass,
 * when the first's pages repeated or missed a PR, has its own (src/prs/fetch.ts). GitHub itself ends a single
 * request after 10 s. Since W105 a page holds 25 PRs: on 2026-10-29 the author search's 55 took
 * three pages, 3.7, 4.8 and 2.9 s, 11.4 s in all, so the 8 pages of PRS_MAX would take about 36 s,
 * more than the 30 s this was for one or two pages of 100.
 */
export const PRS_FETCH_TIMEOUT_MS = 60 * 1000;

/** The most PRs one search keeps: 8 pages of 25 since W105 (src/prs/fetch.ts, PRS_PAGE_SIZE). */
export const PRS_MAX = 200;

/** The most PRs a list holds: PRS_MAX from each of the searches (PR_RELATIONS). */
export const PRS_LIST_MAX = PRS_MAX * PR_RELATIONS.length;

/** The web UI lists PRs updated in this many days, and the rest behind Show older. */
export const PRS_SHOWN_DAYS = 90;

/** The longest PR title kept, in characters. */
export const PR_TITLE_MAX = 300;

/** The most failing checks' names kept per PR. */
export const PR_FAILING_CHECKS_MAX = 5;

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
