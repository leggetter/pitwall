// What the screen derives from a session: whether it needs Phil, which status
// pill it gets, and whether it passes the filters.

import type { SessionGroup, SessionSummary } from '../../src/shared/protocol.js';

/**
 * A background session that has finished, as the contract defines it for
 * `SessionGroup.sessions`: no live process, and state 'done', 'stopped' or
 * 'failed'. The index sorts these last in each group; the screen mutes them.
 * A 'done' session whose process is still alive is idle, so it isn't one.
 */
export function isFinished(session: SessionSummary): boolean {
  return (
    session.kind === 'background' &&
    (!session.alive || session.pid === undefined) &&
    (session.state === 'done' || session.state === 'stopped' || session.state === 'failed')
  );
}

/**
 * A session that is waiting on Phil, a background session blocked on him, or
 * one that ended its turn by asking him something. Never a stale or finished
 * one: a finished session's question still shows on its row, muted, but it
 * isn't counted anywhere.
 */
export function needsAttention(session: SessionSummary): boolean {
  if (session.stale || isFinished(session)) return false;
  return session.status === 'waiting' || session.state === 'blocked' || session.askedYou !== undefined;
}

export type PillTone = 'attention' | 'asked' | 'busy' | 'idle' | 'done' | 'failed' | 'stopped' | 'offline';

export interface StatusPill {
  /** The visible text, such as "waiting: permission prompt". */
  label: string;
  tone: PillTone;
}

/**
 * Waiting first, then blocked (unless stale), then asked you, then the
 * session's state or status. A finished session shows its state (done,
 * stopped or failed) even when it asked something; its row shows that
 * separately, muted.
 */
export function statusPill(session: SessionSummary): StatusPill {
  const reason = session.waitingFor ? `: ${session.waitingFor}` : '';
  if (session.status === 'waiting') return { label: `waiting${reason}`, tone: 'attention' };
  if (session.state === 'blocked' && !session.stale) return { label: `blocked${reason}`, tone: 'attention' };
  if (session.askedYou && !session.stale && !isFinished(session)) return { label: 'asked you', tone: 'asked' };
  // A stale blocked job keeps its "blocked" text but loses the attention styling.
  if (session.state === 'blocked') return { label: `blocked${reason}`, tone: 'offline' };
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
 * to the clipboard and from there into a shell. It can't start with `-`, which
 * `claude` would read as an option, such as `-h`.
 */
export function attachCommand(session: SessionSummary): string | undefined {
  if (session.kind !== 'background' || !session.shortId) return undefined;
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(session.shortId)) return undefined;
  return `claude attach ${session.shortId}`;
}

/**
 * A group's identity on the screen: its root and its key. The key alone isn't
 * unique: a worktree under one root whose main repo is under another gives two
 * groups with the same key, one under each root.
 */
export function groupId(group: Pick<SessionGroup, 'root' | 'key'>): string {
  // Paths can't contain NUL, so the two parts can't run together ambiguously.
  return `${group.root}\0${group.key}`;
}

export interface Filters {
  /** Matched case-insensitively against session names and titles, group labels and cwds. */
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
      return (
        session.name.toLowerCase().includes(needle) ||
        (session.title?.toLowerCase().includes(needle) ?? false) ||
        session.cwd.toLowerCase().includes(needle)
      );
    });
    if (sessions.length > 0) visible.push({ group, sessions });
  }
  return visible;
}

/** A group's sessions split into the ones listed normally and the finished ones, each in the order given. */
export function splitFinished(sessions: readonly SessionSummary[]): { current: SessionSummary[]; finished: SessionSummary[] } {
  const current: SessionSummary[] = [];
  const finished: SessionSummary[] = [];
  for (const session of sessions) (isFinished(session) ? finished : current).push(session);
  return { current, finished };
}

export function countAttention(sessions: readonly SessionSummary[]): number {
  return sessions.reduce((count, session) => count + (needsAttention(session) ? 1 : 0), 0);
}

/** "1 needs you", "3 need you". */
export function needYou(count: number): string {
  return `${count} ${count === 1 ? 'needs' : 'need'} you`;
}
