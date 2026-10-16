// Turning validated rows and transcript fields into the contract's sessions and groups.

import type { SessionGroup, SessionSummary } from '../shared/protocol.js';
import type { AgentRow } from './agents.js';
import { groupLabel, type GroupKey } from './grouping.js';
import type { TranscriptInfo } from './transcripts.js';

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
  const summary: SessionSummary = {
    sessionId: row.sessionId,
    name: row.name,
    kind: row.kind,
    cwd: row.cwd,
    alive: row.pid !== undefined,
    startedAt: row.startedAt,
    stale,
    transcript: transcript.transcript,
  };
  if (extras.cwdMissing === true) summary.cwdMissing = true;
  if (row.shortId !== undefined) summary.shortId = row.shortId;
  if (row.pid !== undefined) summary.pid = row.pid;
  if (row.status !== undefined) summary.status = row.status;
  if (row.state !== undefined) summary.state = row.state;
  if (row.waitingFor !== undefined) summary.waitingFor = row.waitingFor;
  if (transcript.lastActivityAt !== undefined) summary.lastActivityAt = transcript.lastActivityAt;
  if (transcript.lastAssistantText !== undefined) summary.lastAssistantText = transcript.lastAssistantText;
  if (transcript.lastUserPrompt !== undefined) summary.lastUserPrompt = transcript.lastUserPrompt;
  if (transcript.askedYou !== undefined && turnIsOver(row, stale)) summary.askedYou = transcript.askedYou;
  return summary;
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

/**
 * Stale sessions last; otherwise waiting or blocked, then asked you, then
 * busy, then most recently active first.
 */
export function compareSessions(a: SessionSummary, b: SessionSummary): number {
  return (
    Number(a.stale) - Number(b.stale) ||
    statusRank(a) - statusRank(b) ||
    activityMs(b) - activityMs(a) ||
    compareText(a.sessionId, b.sessionId)
  );
}

/** Most recently active group first. */
export function compareGroups(a: SessionGroup, b: SessionGroup): number {
  return newestActivity(b) - newestActivity(a) || compareText(a.root, b.root) || compareText(a.key, b.key);
}

function newestActivity(group: SessionGroup): number {
  let newest = 0;
  for (const session of group.sessions) newest = Math.max(newest, activityMs(session));
  return newest;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface PlacedSession {
  /** The root the session belongs to. */
  root: string;
  group: GroupKey;
  summary: SessionSummary;
}

/**
 * Groups sessions by root and group key, labels each group, and sorts the
 * sessions in each group and the groups themselves.
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
