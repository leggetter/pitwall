// Turning validated rows and transcript fields into the contract's sessions and groups.

import type { BackgroundState, SessionGroup, SessionKind, SessionSummary } from '../shared/protocol.js';
import type { AgentRow } from './agents.js';
import { groupLabel, type GroupKey } from './grouping.js';
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
 * Whether a session has finished its turn, so a question in its last message
 * is waiting on the user: not busy, not waiting on a prompt, not a background
 * job that is working or blocked, and not stale.
 */
function turnIsOver(row: AgentRow, stale: boolean): boolean {
  return (
    row.status !== 'busy' && row.status !== 'waiting' && row.state !== 'working' && row.state !== 'blocked' && !stale
  );
}

export interface SummaryExtras {
  /** The working directory no longer exists. */
  cwdMissing?: boolean;
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
    finished: isFinished({ kind: row.kind, alive, pid: row.pid, state: row.state }),
    transcript: transcript.transcript,
  };
  if (extras.cwdMissing === true) summary.cwdMissing = true;
  if (row.shortId !== undefined) summary.shortId = row.shortId;
  if (row.pid !== undefined) summary.pid = row.pid;
  if (row.status !== undefined) summary.status = row.status;
  if (row.state !== undefined) summary.state = row.state;
  if (row.waitingFor !== undefined) summary.waitingFor = row.waitingFor;
  if (transcript.lastActivityAt !== undefined) summary.lastActivityAt = transcript.lastActivityAt;
  if (transcript.lastUserPrompt !== undefined) summary.lastUserPrompt = transcript.lastUserPrompt;
  if (transcript.askedYou !== undefined && turnIsOver(row, stale)) summary.askedYou = transcript.askedYou;
  if (transcript.aiTitle !== undefined && !sameTitle(transcript.aiTitle, row.name)) {
    summary.title = transcript.aiTitle;
    summary.titleSource = 'claude-code';
  }
  return summary;
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
 * doesn't restart anything.
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

/**
 * Claude Code reports a live blocked background job as `state: 'blocked'`
 * with `status: 'idle'`, so the state is checked as well as the status.
 */
function statusRank(session: SessionSummary): number {
  if (session.status === 'waiting' || (session.state === 'blocked' && !session.stale)) return 0;
  if (session.askedYou !== undefined) return 1;
  if (session.status === 'busy') return 2;
  return 3;
}

/** 0 for most sessions, 1 for stale ones, 2 for finished ones. A session is never both. */
function bucket(session: SessionSummary): number {
  if (session.finished) return 2;
  return session.stale ? 1 : 0;
}

/**
 * Waiting or blocked first, then asked you, then busy, then most recently
 * active first. Stale sessions after those, and finished sessions last.
 * Finished sessions are ordered by activity alone: an askedYou on one is
 * shown, but doesn't lift it above the others.
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
  /** The group of the directory it started in. */
  group: GroupKey;
  summary: SessionSummary;
  /** The repos it worked in beyond its start (workedIn.ts), each with the root its group sits under. */
  workedIn?: readonly { key: string; root: string }[];
}

/**
 * The groups each session is listed under (SessionGroup's comments):
 * - a repo lists the sessions started in it and every session whose workedIn names it;
 * - a directory below a root that isn't in a repo lists every session started in it, as a repo
 *   does, so one that also worked in repos shows in both;
 * - a root's own group lists only the sessions started in the root itself with no workedIn: one
 *   that worked in repos is listed under those repos only.
 * A group with no sessions is left out. Labels each group, and sorts the sessions in each group and
 * the groups themselves.
 */
export function buildGroups(sessions: readonly PlacedSession[], home: string): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  const add = (root: string, key: string, kind: GroupKey['kind'], summary: SessionSummary) => {
    const id = `${root}\0${key}`;
    let entry = groups.get(id);
    if (entry === undefined) {
      entry = { key, label: groupLabel(key, root, home), kind, root, sessions: [] };
      groups.set(id, entry);
    }
    // Each session once in a group, whatever lists it there twice.
    if (!entry.sessions.includes(summary)) entry.sessions.push(summary);
  };
  for (const { root, group, summary, workedIn = [] } of sessions) {
    const rootItself = group.kind === 'directory' && group.key === root;
    if (!(rootItself && workedIn.length > 0)) add(root, group.key, group.kind, summary);
    for (const repo of workedIn) add(repo.root, repo.key, 'git', summary);
  }
  const result = [...groups.values()];
  for (const group of result) group.sessions.sort(compareSessions);
  return result.sort(compareGroups);
}
