// What the screen derives from a session: whether it needs Phil, which status
// pill it gets, and whether it passes the filters.

import type { SessionGroup, SessionSummary } from '../../src/shared/protocol.js';

/**
 * A session that is waiting on Phil, a background session blocked on him, or
 * one that ended its turn by asking him something. Never a stale or finished
 * one: a finished session's question still shows on its row, muted, but it
 * isn't counted anywhere.
 */
export function needsAttention(session: SessionSummary): boolean {
  if (session.stale || session.finished) return false;
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
  if (session.askedYou && !session.stale && !session.finished) return { label: 'asked you', tone: 'asked' };
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

/**
 * The toolbar's filter chips (docs/design-system.md, Filter chips). Two kinds: the state chips, Needs
 * you and Finished, and the kind chips, Interactive and Background. Chips of one kind combine as OR,
 * the two kinds as AND, and a kind with no chip on lets everything through.
 */
export type FilterChip = 'needsYou' | 'interactive' | 'background' | 'finished';

/** The chips in the toolbar's order. */
export const FILTER_CHIPS: readonly FilterChip[] = ['needsYou', 'interactive', 'background', 'finished'];

/** Which chips are state chips and which are kind chips. */
export const CHIP_KINDS: Readonly<Record<'state' | 'kind', readonly FilterChip[]>> = {
  state: ['needsYou', 'finished'],
  kind: ['interactive', 'background'],
};

export interface Filters {
  /** Matched case-insensitively against session names and titles, group labels and cwds. */
  text: string;
  /** The chips that are on. */
  chips: ReadonlySet<FilterChip>;
}

/** No text and no chips: everything shows. */
export const NO_FILTERS: Filters = { text: '', chips: new Set() };

/** Whether any chip is on or the field has text, which is when "Clear filters" shows. */
export function filtering(filters: Filters): boolean {
  return filters.chips.size > 0 || filters.text !== '';
}

/** The text to match, as filterGroups and the highlight use it: trimmed and lower case. */
export function filterNeedle(text: string): string {
  return text.trim().toLowerCase();
}

/** Whether a session passes one chip. */
export function matchesChip(session: SessionSummary, chip: FilterChip): boolean {
  switch (chip) {
    case 'needsYou':
      return needsAttention(session);
    case 'finished':
      return session.finished;
    case 'interactive':
      return session.kind === 'interactive';
    case 'background':
      return session.kind === 'background';
  }
}

/** Whether a session passes the chips that are on: one chip or more of each kind that has any on. */
export function matchesChips(session: SessionSummary, chips: ReadonlySet<FilterChip>): boolean {
  return Object.values(CHIP_KINDS).every((kind) => {
    const on = kind.filter((chip) => chips.has(chip));
    return on.length === 0 || on.some((chip) => matchesChip(session, chip));
  });
}

export interface VisibleGroup {
  group: SessionGroup;
  /** The group's sessions that pass the filters, in the order given. */
  sessions: SessionSummary[];
}

/** Applies the filters, keeping the given order and dropping groups with nothing left to show. */
export function filterGroups(groups: readonly SessionGroup[], filters: Filters): VisibleGroup[] {
  const needle = filterNeedle(filters.text);
  const visible: VisibleGroup[] = [];
  for (const group of groups) {
    const labelMatches = needle !== '' && group.label.toLowerCase().includes(needle);
    const sessions = group.sessions.filter((session) => {
      if (!matchesChips(session, filters.chips)) return false;
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

/**
 * A group's sessions split by `finished` into the ones listed normally and the
 * finished ones, each in the order given.
 */
export function splitFinished(sessions: readonly SessionSummary[]): { current: SessionSummary[]; finished: SessionSummary[] } {
  const current: SessionSummary[] = [];
  const finished: SessionSummary[] = [];
  for (const session of sessions) (session.finished ? finished : current).push(session);
  return { current, finished };
}

export function countAttention(sessions: readonly SessionSummary[]): number {
  return sessions.reduce((count, session) => count + (needsAttention(session) ? 1 : 0), 0);
}

/** "1 needs you", "3 need you". */
export function needYou(count: number): string {
  return `${count} ${count === 1 ? 'needs' : 'need'} you`;
}

/**
 * What the list says when the filters hide every session (docs/design-system.md, 5 and Empty states).
 * Needs you on its own, with nothing needing you, is the calm case; anything else didn't match.
 */
export function noMatchText(filters: Filters, attention: number): { title: string; sentence: string } {
  const text = filters.text.trim();
  if (text === '' && attention === 0 && filters.chips.size === 1 && filters.chips.has('needsYou')) {
    return { title: 'Nothing needs you right now', sentence: 'Sessions that are waiting for you, or asked you something, show here.' };
  }
  if (text === '') return { title: 'No sessions match', sentence: 'Nothing matches these filters.' };
  const sentence = filters.chips.size > 0 ? `Nothing matches "${text}" with these filters.` : `Nothing matches "${text}".`;
  return { title: 'No sessions match', sentence };
}

/** "1 session", "12 sessions". */
export function sessionCount(count: number): string {
  return `${count} ${count === 1 ? 'session' : 'sessions'}`;
}

/**
 * Where `needle` (from filterNeedle) occurs in `text`, case-insensitively, as [start, end) ranges
 * that don't overlap, for the filter's highlight. None for an empty needle.
 */
export function matchRanges(text: string, needle: string): [number, number][] {
  if (needle === '') return [];
  const haystack = text.toLowerCase();
  // Lower-casing can change a string's length (İ becomes i̇), and then the indexes wouldn't line up.
  if (haystack.length !== text.length) return [];
  const ranges: [number, number][] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    ranges.push([at, at + needle.length]);
  }
  return ranges;
}
