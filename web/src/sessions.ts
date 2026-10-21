// What the screen derives from a session: whether it needs Phil, which status
// badge it gets, where it sorts, and whether it passes the filters.

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

/**
 * How a badge looks (docs/design-system.md, 4: Badges): solid is for "needs you" only, everything
 * else is subtle, in a tone, or outline.
 */
export type BadgeLook = 'solid-warning' | 'subtle-warning' | 'subtle-info' | 'subtle-neutral' | 'subtle-success' | 'subtle-danger' | 'outline';

/** The session states the badges tell apart, as in the Badges table. */
export type SessionStatus =
  | 'waiting'
  | 'blocked'
  | 'asked'
  | 'blocked-stale'
  | 'failed'
  | 'done'
  | 'stopped'
  | 'not-running'
  | 'busy'
  | 'working'
  | 'idle'
  | 'unknown';

export interface StatusBadge {
  status: SessionStatus;
  /** The visible text, in sentence case, such as "Waiting: permission prompt". */
  label: string;
  look: BadgeLook;
  /** An 8 px status dot before the label: busy and working. */
  dot?: boolean;
}

/**
 * Waiting first, then blocked (unless stale), then asked you, then the
 * session's state or status. A finished session shows its state (done,
 * stopped or failed) even when it asked something; its row shows that
 * separately, as an outline badge.
 */
export function statusBadge(session: SessionSummary): StatusBadge {
  const reason = session.waitingFor ? `: ${session.waitingFor}` : '';
  if (session.status === 'waiting') return { status: 'waiting', label: `Waiting${reason}`, look: 'solid-warning' };
  if (session.state === 'blocked' && !session.stale) return { status: 'blocked', label: `Blocked${reason}`, look: 'solid-warning' };
  if (session.askedYou && !session.stale && !session.finished) return { status: 'asked', label: 'Asked you', look: 'subtle-warning' };
  // A stale blocked job keeps its "Blocked" text but loses the attention styling.
  if (session.state === 'blocked') return { status: 'blocked-stale', label: `Blocked${reason}`, look: 'outline' };
  if (session.state === 'failed') return { status: 'failed', label: 'Failed', look: 'subtle-danger' };
  if (session.state === 'done') return { status: 'done', label: 'Done', look: 'subtle-success' };
  if (session.state === 'stopped') return { status: 'stopped', label: 'Stopped', look: 'subtle-neutral' };
  if (!session.alive) return { status: 'not-running', label: 'Not running', look: 'outline' };
  if (session.status === 'busy') return { status: 'busy', label: 'Busy', look: 'subtle-info', dot: true };
  if (session.status === 'idle') return { status: 'idle', label: 'Idle', look: 'subtle-neutral' };
  if (session.state === 'working') return { status: 'working', label: 'Working', look: 'subtle-info', dot: true };
  return { status: 'unknown', label: 'Unknown', look: 'subtle-neutral' };
}

/**
 * The status badge a row shows, or undefined for an idle session (Phil, 2026-10-20): the list stays
 * quiet, and "Idle" is in the session view. Whether a session needs you never depends on this; it
 * comes from needsAttention().
 */
export function rowStatusBadge(session: SessionSummary): StatusBadge | undefined {
  const badge = statusBadge(session);
  return badge.status === 'idle' ? undefined : badge;
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
  /**
   * Matched case-insensitively against session names, titles and cwds, their groups' labels, and the
   * labels of the repos they worked in.
   */
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
  /** The group it's listed under: the one it started in, its only one (W39). */
  group: SessionGroup;
}

// Each session in one group (W39, Phil, 2026-10-21): a session is listed only under the group it
// started in, so a group's count is the sessions started there, and the groups' counts under a root
// add up to that root's sessions. The repos it worked in (SessionSummary.workedIn) are named in the
// session view and matched by the filter, and a repo that sessions only worked in has no group.

/** Every session in the groups, in the groups' order. Each is in exactly one group, so each is here once. */
export function sessionsIn(groups: readonly SessionGroup[]): SessionSummary[] {
  return groups.flatMap((group) => group.sessions);
}

/** The group a session is listed under, which is the one it started in, or undefined when the snapshot no longer lists it. */
export function startGroup(groups: readonly SessionGroup[], session: SessionSummary): SessionGroup | undefined {
  return groups.find((group) => group.sessions.some((listed) => listed.sessionId === session.sessionId));
}

/**
 * Where a session started, as the repo list labels it: its group's label, the root's own directory
 * as its path. For one the snapshot no longer lists, its working directory, with home as ~.
 */
export function startLabel(groups: readonly SessionGroup[], session: SessionSummary): string {
  const start = startGroup(groups, session);
  return start ? groupLabel(start) : shortenHome(session.cwd);
}

/**
 * The repos a session worked in beyond where it started, newest touch first, for the session view:
 * each by its label, whether or not it has a group. A repo that is itself one of the roots shows the
 * root's path, as the repo list shows a root's own directory.
 */
export function workedInLabels(session: SessionSummary, roots: readonly string[]): string[] {
  return (session.workedIn ?? []).map((repo) => {
    const root = roots.find((candidate) => isRootGroup({ root: candidate, key: repo.key }));
    return root === undefined ? repo.label : groupLabel({ root, key: repo.key, label: repo.label });
  });
}

/** When a session was last active, or started, in ms; 0 when neither parses. */
function activityMs(session: SessionSummary): number {
  const ms = Date.parse(session.lastActivityAt ?? session.startedAt);
  return Number.isFinite(ms) ? ms : 0;
}

function compareIds(a: SessionSummary, b: SessionSummary): number {
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/**
 * The index's own order (src/index/summaries.ts, compareSessions), which is the Urgency sort: waiting
 * or blocked first, then asked you, then busy, then most recently active. Stale sessions after those,
 * and finished sessions last, by activity alone.
 */
export function compareSessions(a: SessionSummary, b: SessionSummary): number {
  const bucket = (session: SessionSummary) => (session.finished ? 2 : session.stale ? 1 : 0);
  const rank = (session: SessionSummary) => {
    if (session.status === 'waiting' || (session.state === 'blocked' && !session.stale)) return 0;
    if (session.askedYou !== undefined) return 1;
    if (session.status === 'busy') return 2;
    return 3;
  };
  const ba = bucket(a);
  const bb = bucket(b);
  if (ba !== bb) return ba - bb;
  return (ba === 2 ? 0 : rank(a) - rank(b)) || activityMs(b) - activityMs(a) || compareIds(a, b);
}

// The Sort setting (docs/design-system.md, 3: Session list), Phil, 2026-10-20.

export type SortOrder = 'urgency' | 'recent' | 'name';

/** The orders in the select's order, Urgency first: it's the default. */
export const SORT_ORDERS: readonly SortOrder[] = ['urgency', 'recent', 'name'];

export const SORT_LABELS: Readonly<Record<SortOrder, string>> = { urgency: 'Urgency', recent: 'Recent', name: 'Name' };

/** Most recently active first. */
export function compareRecent(a: SessionSummary, b: SessionSummary): number {
  return activityMs(b) - activityMs(a) || compareIds(a, b);
}

/** Alphanumerically by name, as the repo list sorts its groups, so it never moves as sessions change. */
export function compareNames(a: SessionSummary, b: SessionSummary): number {
  return LABEL_ORDER.compare(a.name, b.name) || compareIds(a, b);
}

/**
 * How an order sorts a selection's unfinished sessions, and its finished ones. Finished sessions
 * follow the setting too, except that Urgency orders them by activity alone: none of them needs you.
 */
export function sessionOrder(order: SortOrder, finished: boolean): (a: SessionSummary, b: SessionSummary) => number {
  if (order === 'name') return compareNames;
  if (order === 'recent' || finished) return compareRecent;
  return compareSessions;
}

/**
 * The scope's sessions, split into the rows and the Finished section, each in `order`. Needs you is
 * every session that needs you, from every group, with no Finished section; All sessions is every
 * session, finished ones in one section at the end. The index's order is Urgency, so it's sorted here.
 */
export function listScope(
  groups: readonly SessionGroup[],
  scope: Scope,
  order: SortOrder = 'urgency',
): { current: Listed[]; finished: Listed[] } {
  const listed: Listed[] =
    scope.kind === 'group'
      ? scope.group.sessions.map((session) => ({ session, group: scope.group }))
      : // Each session under the one group it's in, which its row names.
        groups.flatMap((group) => group.sessions.map((session) => ({ session, group })));
  const sorted = (items: Listed[], finished: boolean) => {
    const compare = sessionOrder(order, finished);
    return items.sort((a, b) => compare(a.session, b.session));
  };
  if (scope.kind === 'needs-you') return { current: sorted(listed.filter(({ session }) => needsAttention(session)), false), finished: [] };
  return {
    current: sorted(listed.filter(({ session }) => !session.finished), false),
    finished: sorted(listed.filter(({ session }) => session.finished), true),
  };
}

/**
 * The order to show `next` in, while the reader is in the list (docs/design-system.md, 3: Session
 * list): the ids already on screen keep their order, the ones that have gone leave it, and new ones
 * go in after the row they follow in `next`, or first when they follow none that's shown.
 */
export function holdOrder(shown: readonly string[], next: readonly string[]): string[] {
  const wanted = new Set(next);
  const held = shown.filter((id) => wanted.has(id));
  const kept = new Set(held);
  let after: string | undefined;
  for (const id of next) {
    if (!kept.has(id)) {
      held.splice(after === undefined ? 0 : held.indexOf(after) + 1, 0, id);
      kept.add(id);
    }
    after = id;
  }
  return held;
}

/**
 * The listed sessions that pass the filters, in the order given. The text matches a session's name,
 * title and cwd, its group's label, and the label of every repo it worked in (W39), so typing a
 * repo's name in All sessions finds each session that started there or worked there.
 */
export function filterListed(listed: readonly Listed[], filters: Filters): Listed[] {
  const needle = filterNeedle(filters.text);
  return listed.filter(({ session, group }) => {
    if (!matchesChips(session, filters.chips)) return false;
    if (needle === '') return true;
    return (
      groupLabel(group).toLowerCase().includes(needle) ||
      (session.workedIn?.some((repo) => repo.label.toLowerCase().includes(needle)) ?? false) ||
      session.name.toLowerCase().includes(needle) ||
      (session.title?.toLowerCase().includes(needle) ?? false) ||
      session.cwd.toLowerCase().includes(needle)
    );
  });
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
