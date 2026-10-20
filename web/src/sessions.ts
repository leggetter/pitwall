// What the screen derives from a session: whether it needs Phil, which status
// pill it gets, and whether it passes the filters.

import type { SessionGroup, SessionKind, SessionSummary } from '../../src/shared/protocol.js';
import { shortenHome } from './format.js';

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
 * The filter chips (docs/design-system.md, Filter chips): Interactive and Background, one for each
 * kind of session. Chips of one kind combine as OR, so with both on, or neither, every kind shows.
 */
export type FilterChip = SessionKind;

/** The chips in their order on screen. */
export const FILTER_CHIPS: readonly FilterChip[] = ['interactive', 'background'];

export interface Filters {
  /** Matched case-insensitively against session names, titles and cwds, and their groups' labels. */
  text: string;
  /** The chips that are on. */
  chips: ReadonlySet<FilterChip>;
}

/** No text and no chips: everything shows. */
export const NO_FILTERS: Filters = { text: '', chips: new Set() };

/** Whether the field has text or a chip is on, which is when "Clear filters" shows. */
export function filtering(filters: Filters): boolean {
  return filters.text !== '' || filters.chips.size > 0;
}

/** The text to match, as the filter and the highlight use it: trimmed and lower case. */
export function filterNeedle(text: string): string {
  return text.trim().toLowerCase();
}

/** Whether a session passes the chips that are on: any of them, or all sessions when none is. */
export function matchesChips(session: SessionSummary, chips: ReadonlySet<FilterChip>): boolean {
  return chips.size === 0 || chips.has(session.kind);
}

// The repo list (docs/design-system.md, 3: Repo list).

/** The root's own directory, which the index labels with its last segment. */
export function isRootGroup(group: Pick<SessionGroup, 'root' | 'key'>): boolean {
  return group.key.replace(/\/+$/, '') === group.root.replace(/\/+$/, '');
}

/**
 * A group's label on screen. The root's own directory shows its path (`~/git`), so it doesn't read as
 * a repo called "git".
 */
export function groupLabel(group: Pick<SessionGroup, 'root' | 'key' | 'label'>): string {
  return isRootGroup(group) ? shortenHome(group.root) : group.label;
}

/** Whether every one of a group's sessions has finished: its label is muted in the repo list. */
export function allFinished(group: Pick<SessionGroup, 'sessions'>): boolean {
  return group.sessions.length > 0 && group.sessions.every((session) => session.finished);
}

/** Case-insensitive, with numbers compared as numbers: repo-2 before repo-10. */
const LABEL_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** The groups under one root, in the repo list's order. */
export interface RootGroups {
  root: string;
  groups: SessionGroup[];
}

/**
 * The repo list's groups: root by root, in the order pitwall was given them, and within each root the
 * root's own directory first, then the rest alphanumerically by label (Phil, 2026-10-20), so the
 * column never moves as sessions change. The index's own order (by activity) is left alone.
 */
export function repoListGroups(groups: readonly SessionGroup[], roots: readonly string[]): RootGroups[] {
  const byRoot = new Map<string, SessionGroup[]>(roots.map((root) => [root, []]));
  for (const group of groups) {
    const list = byRoot.get(group.root);
    if (list) list.push(group);
    else byRoot.set(group.root, [group]);
  }
  const order = (a: SessionGroup, b: SessionGroup) =>
    Number(isRootGroup(b)) - Number(isRootGroup(a)) ||
    LABEL_ORDER.compare(groupLabel(a), groupLabel(b)) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return [...byRoot].filter(([, list]) => list.length > 0).map(([root, list]) => ({ root, groups: list.sort(order) }));
}

// The session list (docs/design-system.md, 3: Session list).

/** What the session list shows: a view of every group, or one group. */
export type Scope = { kind: 'needs-you' } | { kind: 'all' } | { kind: 'group'; group: SessionGroup };

/** A session, with the group it's listed under. */
export interface Listed {
  session: SessionSummary;
  group: SessionGroup;
}

/**
 * The index's own order within a group (src/index/summaries.ts, compareSessions), for the views that
 * list sessions from several groups: waiting or blocked first, then asked you, then busy, then most
 * recently active. Stale sessions after those, and finished sessions last, by activity alone.
 */
export function compareSessions(a: SessionSummary, b: SessionSummary): number {
  const bucket = (session: SessionSummary) => (session.finished ? 2 : session.stale ? 1 : 0);
  const rank = (session: SessionSummary) => {
    if (session.status === 'waiting' || (session.state === 'blocked' && !session.stale)) return 0;
    if (session.askedYou !== undefined) return 1;
    if (session.status === 'busy') return 2;
    return 3;
  };
  const activity = (session: SessionSummary) => {
    const ms = Date.parse(session.lastActivityAt ?? session.startedAt);
    return Number.isFinite(ms) ? ms : 0;
  };
  const ba = bucket(a);
  const bb = bucket(b);
  if (ba !== bb) return ba - bb;
  return (
    (ba === 2 ? 0 : rank(a) - rank(b)) ||
    activity(b) - activity(a) ||
    (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
  );
}

/**
 * The scope's sessions, split into the rows and the Finished section. A group keeps the index's
 * order. Needs you is every session that needs you, from every group, with no Finished section;
 * All sessions is every session, finished ones in one section at the end.
 */
export function listScope(groups: readonly SessionGroup[], scope: Scope): { current: Listed[]; finished: Listed[] } {
  const listed = (scope.kind === 'group' ? [scope.group] : groups).flatMap((group) => group.sessions.map((session) => ({ session, group })));
  const sorted = scope.kind === 'group' ? listed : listed.sort((a, b) => compareSessions(a.session, b.session));
  if (scope.kind === 'needs-you') return { current: sorted.filter(({ session }) => needsAttention(session)), finished: [] };
  return { current: sorted.filter(({ session }) => !session.finished), finished: sorted.filter(({ session }) => session.finished) };
}

/** The listed sessions that pass the filters, in the order given. A group whose label matches lets all its sessions through. */
export function filterListed(listed: readonly Listed[], filters: Filters): Listed[] {
  const needle = filterNeedle(filters.text);
  return listed.filter(({ session, group }) => {
    if (!matchesChips(session, filters.chips)) return false;
    if (needle === '') return true;
    return (
      groupLabel(group).toLowerCase().includes(needle) ||
      session.name.toLowerCase().includes(needle) ||
      (session.title?.toLowerCase().includes(needle) ?? false) ||
      session.cwd.toLowerCase().includes(needle)
    );
  });
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
 * What the session list says when the filters hide every session in the selection
 * (docs/design-system.md, Empty states). `selection` is its name on screen: a group's label, or
 * "Needs you" or "All sessions".
 */
export function noMatchText(filters: Filters, selection: string): { title: string; sentence: string } {
  const text = filters.text.trim();
  const chips = filters.chips.size > 0;
  const sentence =
    text === '' ? `Nothing in ${selection} matches these filters.` : `Nothing in ${selection} matches "${text}"${chips ? ' with these filters' : ''}.`;
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
