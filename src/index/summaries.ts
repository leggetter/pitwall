// Turning validated rows and transcript fields into the contract's sessions and groups.

import type { BackgroundState, NeedsYou, SessionGroup, SessionKind, SessionSummary } from '../shared/protocol.js';
import type { AgentRow } from './agents.js';
import { groupLabel, type GroupKey } from './grouping.js';
import type { JobNeeds } from './jobs.js';
import { titleText, type TranscriptInfo } from './transcripts.js';

export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A background session that is blocked and has had no activity for more than
 * 7 days, whether or not its process is still running. Activity is the newest
 * transcript entry, or the start time when there's none.
 */
export function isStale(row: AgentRow, lastActivityAt: string | undefined, nowMs: number): boolean {
  if (row.kind !== 'background' || row.state !== 'blocked') return false;
  const activity = Date.parse(lastActivityAt ?? row.startedAt);
  return Number.isFinite(activity) && nowMs - activity > STALE_AFTER_MS;
}

/**
 * Whether a session has finished its turn by Claude Code's status alone: not
 * busy, not waiting on a prompt, not a background job that is working or
 * blocked, and not stale. The rule before W69, kept for a transcript with no
 * `turn_duration` entries, as from an older Claude Code.
 */
function turnIsOver(row: AgentRow, stale: boolean): boolean {
  return (
    row.status !== 'busy' && row.status !== 'waiting' && row.state !== 'working' && row.state !== 'blocked' && !stale
  );
}

/**
 * Whether a question in the session's last message is waiting on the user (SessionSummary.askedYou):
 * never while a prompt is on screen or on a stale session; otherwise when the transcript says the
 * turn has ended (spike 007, finding 4), whatever Claude Code's status, which a plugin's monitor or
 * a restart can keep at busy (finding 6). A transcript that marks no turn's end goes by turnIsOver().
 */
function askedHolds(row: AgentRow, transcript: TranscriptInfo, stale: boolean): boolean {
  if (stale || row.status === 'waiting') return false;
  return transcript.turnEnded ?? turnIsOver(row, stale);
}

export interface SummaryExtras {
  /** The working directory no longer exists. */
  cwdMissing?: boolean;
  /**
   * An interactive session that has ended, found from its transcript (ended.ts) rather than listed
   * by `claude agents`: SessionSummary.ended, and finished, so the sort, the Finished section and
   * Needs you treat it as they treat a finished background session.
   */
  ended?: boolean;
  /**
   * What the background job's `state.json` says it needs (jobs.ts). Undefined when it wasn't read,
   * as for an interactive session or a job with no short id, which NeedsYou's 'blocked' treats as
   * 'unknown'.
   */
  job?: JobNeeds;
  /**
   * Milliseconds since the epoch: when you resumed the session, or confirmed a restart of it, in
   * this run of pitwall (Indexer.noteRestart). For NeedsYou's 'restarted'.
   */
  restartedAtMs?: number;
}

export function toSessionSummary(
  row: AgentRow,
  transcript: TranscriptInfo,
  nowMs: number,
  extras: SummaryExtras = {},
): SessionSummary {
  const stale = isStale(row, transcript.lastActivityAt, nowMs);
  const alive = row.pid !== undefined;
  const summary: SessionSummary = {
    sessionId: row.sessionId,
    name: row.name,
    kind: row.kind,
    cwd: row.cwd,
    alive,
    startedAt: row.startedAt,
    stale,
    finished: extras.ended === true || isFinished({ kind: row.kind, alive, pid: row.pid, state: row.state }),
    transcript: transcript.transcript,
  };
  if (extras.ended === true) summary.ended = true;
  if (extras.cwdMissing === true) summary.cwdMissing = true;
  if (row.shortId !== undefined) summary.shortId = row.shortId;
  if (row.pid !== undefined) summary.pid = row.pid;
  if (row.status !== undefined) summary.status = row.status;
  if (row.state !== undefined) summary.state = row.state;
  if (row.waitingFor !== undefined) summary.waitingFor = row.waitingFor;
  if (transcript.lastActivityAt !== undefined) summary.lastActivityAt = transcript.lastActivityAt;
  if (transcript.lastUserPrompt !== undefined) summary.lastUserPrompt = transcript.lastUserPrompt;
  if (transcript.askedYou !== undefined && askedHolds(row, transcript, stale)) summary.askedYou = transcript.askedYou;
  if (transcript.aiTitle !== undefined && !sameTitle(transcript.aiTitle, row.name)) {
    summary.title = transcript.aiTitle;
    summary.titleSource = 'claude-code';
  }
  const needsYou = needsYouOf(row, summary, transcript, extras);
  if (needsYou !== undefined) summary.needsYou = needsYou;
  return summary;
}

/**
 * Why the session needs you (NeedsYou), the first reason that holds, in the contract's order; never
 * on a stale or finished session (spike 007's recommendation).
 * 1. 'prompt': Claude Code shows a prompt, status 'waiting'.
 * 2. 'claude-code': the job's `state.json` has a `needs` line that isn't the start placeholder.
 * 3. 'asked': askedYou is set, so the last turn ended asking you something.
 * 4. 'restarted': you resumed it, or confirmed its restart, in this run of pitwall, its process is
 *    running, and the transcript has no prompt newer than that (restartHolds()). A restart that
 *    didn't wake it, as when `claude attach` exits at once, leaves no process, so no reason.
 * 5. 'blocked': Claude Code says it's blocked, and the job's file couldn't be used, or wasn't read.
 * So `state: 'blocked'` alone no longer counts when the job's file was read and asks nothing.
 */
function needsYouOf(row: AgentRow, summary: SessionSummary, transcript: TranscriptInfo, extras: SummaryExtras): NeedsYou | undefined {
  if (summary.stale || summary.finished) return undefined;
  if (row.status === 'waiting') return { reason: 'prompt' };
  if (extras.job?.kind === 'needs') return { reason: 'claude-code', text: extras.job.text };
  if (summary.askedYou !== undefined) return { reason: 'asked' };
  if (extras.restartedAtMs !== undefined && row.pid !== undefined && restartHolds(extras.restartedAtMs, transcript)) return { reason: 'restarted' };
  if (row.state === 'blocked' && (extras.job === undefined || extras.job.kind === 'unknown')) return { reason: 'blocked' };
  return undefined;
}

/**
 * Whether a restart at `atMs` still waits for your prompt: the transcript has no prompt newer than
 * it. A prompt with no timestamp can't be placed, so it doesn't end the wait.
 */
export function restartHolds(atMs: number, transcript: Pick<TranscriptInfo, 'lastPromptMs'>): boolean {
  return transcript.lastPromptMs === undefined || transcript.lastPromptMs <= atMs;
}

/**
 * Whether Claude Code's title says nothing the name doesn't: empty, or the
 * same text ignoring case and spacing. A background session's name is usually
 * its generated title already, so showing both would repeat it.
 */
function sameTitle(title: string, name: string): boolean {
  const shown = titleText(title).toLowerCase();
  return shown === '' || shown === titleText(name).toLowerCase();
}

const FINISHED_STATES: readonly BackgroundState[] = ['done', 'stopped', 'failed'];

/**
 * The rule behind `SessionSummary.finished`: a background session with no
 * live process, and state 'done', 'stopped' or 'failed'. Plain
 * `claude agents --json` leaves these out; `--all` lists them. A 'done'
 * session whose process is still alive is idle, not finished: attaching to it
 * doesn't restart anything. An ended interactive session is finished too, but
 * toSessionSummary sets that from SummaryExtras.ended, not from this rule.
 */
export function isFinished(session: {
  kind: SessionKind;
  alive: boolean;
  pid?: number | undefined;
  state?: BackgroundState | undefined;
}): boolean {
  return (
    session.kind === 'background' &&
    (!session.alive || session.pid === undefined) &&
    session.state !== undefined &&
    FINISHED_STATES.includes(session.state)
  );
}

/**
 * When a session was last active, for sorting: its newest transcript entry,
 * or its start time when the transcript had none.
 */
export function activityMs(session: SessionSummary): number {
  const ms = Date.parse(session.lastActivityAt ?? session.startedAt);
  return Number.isFinite(ms) ? ms : 0;
}

/** Needs you first (SessionSummary.needsYou, whatever the reason), then busy, then the rest. */
function statusRank(session: SessionSummary): number {
  if (session.needsYou !== undefined) return 0;
  if (session.status === 'busy') return 1;
  return 2;
}

/** 0 for most sessions, 1 for stale ones, 2 for finished ones. A session is never both. */
function bucket(session: SessionSummary): number {
  if (session.finished) return 2;
  return session.stale ? 1 : 0;
}

/**
 * Needs you first, then busy, then most recently active first. Stale sessions
 * after those, and finished sessions last. Finished sessions are ordered by
 * activity alone: an askedYou on one is shown, but doesn't lift it above the
 * others.
 */
export function compareSessions(a: SessionSummary, b: SessionSummary): number {
  const ba = bucket(a);
  const bb = bucket(b);
  if (ba !== bb) return ba - bb;
  return (
    (ba === 2 ? 0 : statusRank(a) - statusRank(b)) ||
    activityMs(b) - activityMs(a) ||
    compareText(a.sessionId, b.sessionId)
  );
}

/**
 * Most recently active group first, going by the group's unfinished sessions,
 * so a session that has finished doesn't lift its group. Groups whose
 * sessions have all finished come after every other group, newest first.
 */
export function compareGroups(a: SessionGroup, b: SessionGroup): number {
  const ra = groupRank(a);
  const rb = groupRank(b);
  return (
    Number(ra.finishedOnly) - Number(rb.finishedOnly) ||
    rb.newest - ra.newest ||
    compareText(a.root, b.root) ||
    compareText(a.key, b.key)
  );
}

function groupRank(group: SessionGroup): { finishedOnly: boolean; newest: number } {
  let newest = 0;
  let newestFinished = 0;
  let unfinished = false;
  for (const session of group.sessions) {
    if (session.finished) {
      newestFinished = Math.max(newestFinished, activityMs(session));
    } else {
      unfinished = true;
      newest = Math.max(newest, activityMs(session));
    }
  }
  return unfinished ? { finishedOnly: false, newest } : { finishedOnly: true, newest: newestFinished };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface PlacedSession {
  /** The root the session belongs to. */
  root: string;
  /** The group of the directory it started in: the one group it's listed under. */
  group: GroupKey;
  summary: SessionSummary;
}

/**
 * The groups, each listing the sessions started in it and only those (SessionGroup's comments,
 * W39): a repo, its worktrees and subdirectories included; a directory below a root that's in no
 * repo; or a root's own directory. A session is in exactly one group, whatever its workedIn names,
 * so a repo that sessions only worked in has no group. A group with no sessions is left out. Labels
 * each group, and sorts the sessions in each group and the groups themselves.
 */
export function buildGroups(sessions: readonly PlacedSession[], home: string): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const { root, group, summary } of sessions) {
    const id = `${root}\0${group.key}`;
    let entry = groups.get(id);
    if (entry === undefined) {
      entry = { key: group.key, label: groupLabel(group.key, root, home), kind: group.kind, root, sessions: [] };
      groups.set(id, entry);
    }
    entry.sessions.push(summary);
  }
  const result = [...groups.values()];
  for (const group of result) group.sessions.sort(compareSessions);
  return result.sort(compareGroups);
}
