// Turning validated rows and transcript fields into the contract's sessions and groups.

import type { SessionGroup, SessionSummary } from '../shared/protocol.js';
import type { AgentRow } from './agents.js';
import { groupLabel, type GroupKey } from './grouping.js';
import type { TranscriptInfo } from './transcripts.js';

export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** A background session that is blocked, has no process, and started more than 7 days ago. */
export function isStale(row: AgentRow, nowMs: number): boolean {
  return (
    row.kind === 'background' &&
    row.state === 'blocked' &&
    row.pid === undefined &&
    nowMs - Date.parse(row.startedAt) > STALE_AFTER_MS
  );
}

export function toSessionSummary(row: AgentRow, transcript: TranscriptInfo, nowMs: number): SessionSummary {
  const summary: SessionSummary = {
    sessionId: row.sessionId,
    name: row.name,
    kind: row.kind,
    cwd: row.cwd,
    alive: row.pid !== undefined,
    startedAt: row.startedAt,
    stale: isStale(row, nowMs),
    transcript: transcript.transcript,
  };
  if (row.shortId !== undefined) summary.shortId = row.shortId;
  if (row.pid !== undefined) summary.pid = row.pid;
  if (row.status !== undefined) summary.status = row.status;
  if (row.state !== undefined) summary.state = row.state;
  if (row.waitingFor !== undefined) summary.waitingFor = row.waitingFor;
  if (transcript.lastActivityAt !== undefined) summary.lastActivityAt = transcript.lastActivityAt;
  if (transcript.lastAssistantText !== undefined) summary.lastAssistantText = transcript.lastAssistantText;
  if (transcript.lastUserPrompt !== undefined) summary.lastUserPrompt = transcript.lastUserPrompt;
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

function statusRank(session: SessionSummary): number {
  if (session.status === 'waiting') return 0;
  if (session.status === 'busy') return 1;
  return 2;
}

/** Stale sessions last; otherwise waiting, then busy, then most recently active first. */
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
