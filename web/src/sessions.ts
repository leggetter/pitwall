// What the screen derives from a session: whether it needs Phil, which status
// pill it gets, and whether it passes the filters.

import type { SessionGroup, SessionSummary } from '../../src/shared/protocol.js';

/** A session that is waiting on Phil, or a background session blocked on him, and isn't stale. */
export function needsAttention(session: SessionSummary): boolean {
  if (session.stale) return false;
  return session.status === 'waiting' || session.state === 'blocked';
}

export type PillTone = 'attention' | 'busy' | 'idle' | 'done' | 'failed' | 'stopped' | 'offline';

export interface StatusPill {
  /** The visible text, such as "waiting: permission prompt". */
  label: string;
  tone: PillTone;
}

export function statusPill(session: SessionSummary): StatusPill {
  const reason = session.waitingFor ? `: ${session.waitingFor}` : '';
  if (session.status === 'waiting') return { label: `waiting${reason}`, tone: 'attention' };
  // A stale blocked job keeps its "blocked" text but loses the attention styling.
  if (session.state === 'blocked') return { label: `blocked${reason}`, tone: session.stale ? 'offline' : 'attention' };
  if (session.state === 'failed') return { label: 'failed', tone: 'failed' };
  if (session.state === 'done') return { label: 'done', tone: 'done' };
  if (session.state === 'stopped') return { label: 'stopped', tone: 'stopped' };
  if (!session.alive) return { label: 'not running', tone: 'offline' };
  if (session.status === 'busy') return { label: 'busy', tone: 'busy' };
  if (session.status === 'idle') return { label: 'idle', tone: 'idle' };
  if (session.state === 'working') return { label: 'working', tone: 'busy' };
  return { label: 'unknown', tone: 'idle' };
}

/**
 * The `claude attach` command for a background session, or undefined. The
 * short id is checked against a conservative pattern, because the command goes
 * to the clipboard and from there into a shell.
 */
export function attachCommand(session: SessionSummary): string | undefined {
  if (session.kind !== 'background' || !session.shortId) return undefined;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(session.shortId)) return undefined;
  return `claude attach ${session.shortId}`;
}

export interface Filters {
  /** Matched case-insensitively against session names, group labels and cwds. */
  text: string;
  attentionOnly: boolean;
}

export interface VisibleGroup {
  group: SessionGroup;
  /** The group's sessions that pass the filters, in the order given. */
  sessions: SessionSummary[];
}

/** Applies the filters, keeping the given order and dropping groups with nothing left to show. */
export function filterGroups(groups: readonly SessionGroup[], filters: Filters): VisibleGroup[] {
  const needle = filters.text.trim().toLowerCase();
  const visible: VisibleGroup[] = [];
  for (const group of groups) {
    const labelMatches = needle !== '' && group.label.toLowerCase().includes(needle);
    const sessions = group.sessions.filter((session) => {
      if (filters.attentionOnly && !needsAttention(session)) return false;
      if (needle === '' || labelMatches) return true;
      return session.name.toLowerCase().includes(needle) || session.cwd.toLowerCase().includes(needle);
    });
    if (sessions.length > 0) visible.push({ group, sessions });
  }
  return visible;
}

export function countAttention(sessions: readonly SessionSummary[]): number {
  return sessions.reduce((count, session) => count + (needsAttention(session) ? 1 : 0), 0);
}

/** "1 needs you", "3 need you". */
export function needYou(count: number): string {
  return `${count} ${count === 1 ? 'needs' : 'need'} you`;
}
