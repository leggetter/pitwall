// Sessions and pull requests as one list of work (M4 redesign, W106; docs/design-system.md, 4: Pull
// requests). Phil, 2026-10-29: "a session now becomes a little more than just a Claude session. It
// becomes an active piece of work": a Claude session, an open PR, or both. The UI keeps the word
// "sessions". All pure, so it's easy to test.
//
// - Which session owns a PR: prOwner() (src/shared/protocol.ts), over every session in the snapshot,
//   finished and ended ones included, whatever the window or the root tab. A session's row carries
//   the open PRs it owns, wherever the session is listed: the session decides where its PRs show,
//   never the PR's repo.
// - A PR no session owns is a row of its own, placed by the server (PullRequestSummary.place):
//   'cloned' under the group whose key is the place's, which the page builds when no session is
//   listed there; 'not-cloned' under a group of its own, `owner/name`, under the root that claims the
//   owner, marked as not cloned; 'unclaimed', or no place at all, isn't listed, only counted, so the
//   Pull requests view can say how many are hidden.
// - A PR row last updated more than PRS_SHOWN_DAYS ago is left out too, so a long-forgotten PR
//   doesn't sit in Needs you. The Pull requests view's Show older lists them among its own rows
//   (olderPrRows()), and only there: they never count in Needs you or anywhere else. A PR a session
//   owns is never left out: its session is the work.
// - Finished: a finished session that owns an open PR isn't finished work, so it stays in the main
//   list, not in Finished, until the PR closes, and older ended ones like it stay in the window.
// - Needs you: a session's row needs you when the session does (needsAttention()) or when a PR it
//   owns needs attention (prNeedsAttention()); a PR row when its PR does. Both count wherever Needs
//   you counts. A mark of Not needed now (W88) is for what the session needs, never for its PRs.

import { prNeedsAttention, prOwner, type PullRequestRelation, type PullRequestSummary, type SessionGroup, type SessionSummary } from '../../src/shared/protocol.js';
import { plainText } from './format.js';
import type { NotNeeded } from './notNeeded.js';
import { comparePrs, filterPrs, isOlderPr, prKey, prUpdatedMs } from './prs.js';
import {
  activityMs,
  compareLabels,
  filterNeedle,
  groupId,
  groupLabel,
  listedOnce,
  needsAttention,
  sessionOrder,
  sessionsIn,
  type Filters,
  type Listed,
  type Scope,
  type SortOrder,
} from './sessions.js';

/**
 * A group as the page lists it (W106): its sessions, as Group sessions by has them, and the open PRs
 * no session owns that the server placed there, as rows of their own.
 */
export interface ListGroup extends SessionGroup {
  /** The PR rows under it: open PRs no session owns, most urgent first (comparePrs()). */
  prs?: readonly PullRequestSummary[];
  /**
   * A repo with no clone under the root, which claims its owner (PullRequestPlace 'not-cloned'): its
   * key is notClonedKey(), never a path, and it's listed only while it has PR rows.
   */
  notCloned?: true;
}

/** A not-cloned repo's group key: `github.com/<owner>/<name>`, never a path, so it can't be any group's real key. */
export const notClonedKey = (repo: string): string => `github.com/${repo}`;

/** Whether a group key is a not-cloned repo's (notClonedKey()), as a selection's ?repo= can name one. */
export const isNotClonedKey = (key: string): boolean => key.startsWith('github.com/');

/** A PR no session owns, and where it's listed. */
export interface PlacedPr {
  pr: PullRequestSummary;
  root: string;
  key: string;
  label: string;
  cloned: boolean;
}

/** What the page knows of sessions and PRs together (composeWork()). */
export interface Work {
  /** Each owned open PR's owning session, by prKey(). */
  ownerOf: ReadonlyMap<string, SessionSummary>;
  /** The open PRs each session owns, by session id, most urgent first (comparePrs()). Only sessions that own one. */
  owned: ReadonlyMap<string, readonly PullRequestSummary[]>;
  /** The open PRs no session owns that a root claims, each with where it's listed. */
  placed: readonly PlacedPr[];
  /** The open PRs no session owns and no root claims ('unclaimed', or no place): counted, never listed. */
  hidden: readonly PullRequestSummary[];
  /** The PRs that would be rows but are older than PRS_SHOWN_DAYS: left out, but for the Pull requests view's Show older. */
  older: readonly PlacedPr[];
}

export const NO_WORK: Work = { ownerOf: new Map(), owned: new Map(), placed: [], hidden: [], older: [] };

export interface WorkOptions {
  /** "Now" for the PR rows' window: the list's own fetchedAt (listNow()). A `now` that isn't a time hides nothing. */
  now?: number;
}

/**
 * Which session owns each open PR, and where each PR no session owns is listed (see the top of this
 * file). `sessions` is every session in the snapshot, each once, finished and ended ones included.
 */
export function composeWork(sessions: readonly SessionSummary[], prs: readonly PullRequestSummary[], { now = Number.NaN }: WorkOptions = {}): Work {
  if (prs.length === 0) return NO_WORK;
  const ownerOf = new Map<string, SessionSummary>();
  const owned = new Map<string, PullRequestSummary[]>();
  const placed: PlacedPr[] = [];
  const hidden: PullRequestSummary[] = [];
  const older: PlacedPr[] = [];
  // Only sessions with a strong link can own one, and few have any: the rest are left out of each search.
  const linked = sessions.filter((session) => session.prLinks !== undefined && session.prLinks.some((link) => link.kind !== 'mentioned'));
  for (const pr of [...prs].sort(comparePrs)) {
    const owner = prOwner(pr, linked);
    if (owner) {
      ownerOf.set(prKey(pr), owner);
      owned.set(owner.sessionId, [...(owned.get(owner.sessionId) ?? []), pr]);
      continue;
    }
    const place = pr.place;
    if (place === undefined || place.kind === 'unclaimed') {
      hidden.push(pr);
      continue;
    }
    const at: PlacedPr =
      place.kind === 'cloned'
        ? { pr, root: place.root, key: place.key, label: place.label, cloned: true }
        : { pr, root: place.root, key: notClonedKey(pr.repo), label: pr.repoLabel, cloned: false };
    (isOlderPr(pr, now) ? older : placed).push(at);
  }
  return { ownerOf, owned, placed, hidden, older };
}

/** The ids of the sessions that own an open PR, which stay out of Finished and in the window. */
export function ownerIds(work: Work): ReadonlySet<string> {
  return new Set(work.owned.keys());
}

/** Whether a session owns an open PR. */
export function ownsPr(session: Pick<SessionSummary, 'sessionId'>, work: Work): boolean {
  return (work.owned.get(session.sessionId)?.length ?? 0) > 0;
}

/** Finished work: a finished session that owns no open PR. One that owns one is listed with the rest, showing it ended. */
export function isDone(session: SessionSummary, work: Work): boolean {
  return session.finished && !ownsPr(session, work);
}

/** The most urgent open PR a session owns that needs attention, or undefined: its row's line 2 says why (prReason()). */
export function prNeeding(session: Pick<SessionSummary, 'sessionId'>, work: Work): PullRequestSummary | undefined {
  return work.owned.get(session.sessionId)?.find(prNeedsAttention);
}

/**
 * Whether a session's row needs you (W106): the session does (needsAttention(), without what's marked
 * not needed now), or a PR it owns needs attention, whatever the session's state, ended included.
 */
export function sessionNeedsYou(session: SessionSummary, notNeeded: NotNeeded | undefined, work: Work): boolean {
  return needsAttention(session, notNeeded) || prNeeding(session, work) !== undefined;
}

/**
 * The groups with each placed PR under its group (W106): a cloned PR under the group with its root and
 * key, built after the others when none is listed there; a not-cloned one under its repo's own group.
 * New objects for the groups that change, so the snapshot's are never touched.
 */
export function withPrRows(groups: readonly SessionGroup[], work: Work): ListGroup[] {
  if (work.placed.length === 0) return [...groups];
  const listed: ListGroup[] = [...groups];
  const at = new Map(listed.map((group, index) => [groupId(group), index]));
  const rows = new Map<number, PullRequestSummary[]>();
  for (const { pr, root, key, label, cloned } of work.placed) {
    const id = groupId({ root, key });
    let index = at.get(id);
    if (index === undefined) {
      index = listed.length;
      at.set(id, index);
      listed.push({ key, label, kind: 'git', root, sessions: [], ...(cloned ? {} : { notCloned: true as const }) });
    }
    rows.set(index, [...(rows.get(index) ?? []), pr]);
  }
  for (const [index, prs] of rows) {
    const group = listed[index] as ListGroup;
    listed[index] = { ...group, prs: [...(group.prs ?? []), ...prs].sort(comparePrs) };
  }
  return listed;
}

/** Every PR row in the groups, each once, with the first group that lists it. */
export function prRowsIn(groups: readonly ListGroup[]): ListedPr[] {
  const seen = new Set<string>();
  const rows: ListedPr[] = [];
  for (const group of groups) {
    for (const pr of group.prs ?? []) {
      if (seen.has(prKey(pr))) continue;
      seen.add(prKey(pr));
      rows.push({ pr, group });
    }
  }
  return rows;
}

/** How many rows the groups list: each session once, and each PR row. */
export function countRows(groups: readonly ListGroup[]): number {
  return sessionsIn(groups).length + prRowsIn(groups).length;
}

/**
 * How many of the groups' rows need you, each session and PR row once (W106): what Needs you, its
 * badges, the root tabs' and the page title count.
 */
export function countNeeds(groups: readonly ListGroup[], notNeeded: NotNeeded | undefined, work: Work): number {
  const sessions = sessionsIn(groups).filter((session) => sessionNeedsYou(session, notNeeded, work)).length;
  return sessions + prRowsIn(groups).filter(({ pr }) => prNeedsAttention(pr)).length;
}

/** The rows with an open PR, and those that need you through one: the Pull requests item's count and badge (W106). */
export function prRowCounts(groups: readonly ListGroup[], work: Work): { count: number; attention: number } {
  const sessions = sessionsIn(groups).filter((session) => ownsPr(session, work));
  const rows = prRowsIn(groups);
  return {
    count: sessions.length + rows.length,
    attention: sessions.filter((session) => prNeeding(session, work) !== undefined).length + rows.filter(({ pr }) => prNeedsAttention(pr)).length,
  };
}

/** Whether all of a group's work is finished: its label is muted in the repo list. Never while it has a PR row, or a session that owns an open PR. */
export function allDone(group: ListGroup, work: Work): boolean {
  return (group.prs?.length ?? 0) === 0 && group.sessions.length > 0 && group.sessions.every((session) => isDone(session, work));
}

// The list (docs/design-system.md, 3: Session list), with PR rows among the sessions' (W106).

/** A PR row: an open PR no session owns, with the group it's listed under. */
export interface ListedPr {
  pr: PullRequestSummary;
  group: ListGroup;
  /** Older than PRS_SHOWN_DAYS, listed by the Pull requests view's Show older: it never needs you. */
  older?: true;
}

/**
 * The older PR rows the Pull requests view's Show older lists, under the root tab's `root` when
 * there's one, each under its group as the groups have it, or one built for it that the repo list
 * never shows. They're the view's alone: they never need you, and nothing else counts them.
 */
export function olderPrRows(groups: readonly ListGroup[], work: Work, root?: string): ListedPr[] {
  return work.older
    .filter((each) => root === undefined || each.root === root)
    .map(({ pr, root: at, key, label, cloned }) => ({
      pr,
      group: groups.find((group) => groupId(group) === groupId({ root: at, key })) ?? { key, label, kind: 'git', root: at, sessions: [], ...(cloned ? {} : { notCloned: true as const }) },
      older: true as const,
    }));
}

/** A row of the session list: a session's, or a PR's. */
export type ListRow = Listed | ListedPr;

export const isPrRow = (row: ListRow): row is ListedPr => 'pr' in row;

/** A row's identity on the page: its session's id, or `pr:` and its PR's key, which no session id starts with. */
export const rowKey = (row: ListRow): string => (isPrRow(row) ? prRowKey(prKey(row.pr)) : row.session.sessionId);

/** A PR row's identity, from its PR's key. */
export const prRowKey = (key: string): string => `pr:${key}`;

/** What the session list shows (sessions.ts' Scope), and the Pull requests view (W106): every row with an open PR. */
export type WorkScope = Exclude<Scope, { kind: 'group' }> | { kind: 'group'; group: ListGroup } | { kind: 'prs' };

/** Whether a row needs you (sessionNeedsYou(), prNeedsAttention()). */
export function rowNeedsYou(row: ListRow, notNeeded: NotNeeded | undefined, work: Work): boolean {
  if (isPrRow(row)) return row.older !== true && prNeedsAttention(row.pr);
  return sessionNeedsYou(row.session, notNeeded, work);
}

/** A row's activity: its session's, or when its PR was last updated. */
const rowActivity = (row: ListRow): number => (isPrRow(row) ? prUpdatedMs(row.pr) : activityMs(row.session));

/** What Name sorts a row by: its session's name, or its PR's title. */
const rowName = (row: ListRow): string => (isPrRow(row) ? plainText(row.pr.title) : row.session.name);

const compareKeys = (a: ListRow, b: ListRow) => {
  const ka = rowKey(a);
  const kb = rowKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/**
 * How the rows of a list sort, sessions and PRs together, as sessionOrder() sorts sessions alone:
 * Urgency, the rows that need you first, whatever the reason, a PR's included, then busy sessions,
 * then the most recently active, a PR row by its update, with stale sessions after those, unless a
 * PR one owns needs you, which puts it with the rows that need you; Recent by
 * activity alone; Name by a session's name or a PR's title. A list with no PR rows and no owned PRs
 * sorts exactly as sessionOrder() does.
 */
export function rowOrder(order: SortOrder, notNeeded: NotNeeded | undefined, work: Work): (a: ListRow, b: ListRow) => number {
  if (order === 'name') return (a, b) => compareLabels(rowName(a), rowName(b)) || compareKeys(a, b);
  if (order === 'recent') return (a, b) => rowActivity(b) - rowActivity(a) || compareKeys(a, b);
  // A row that needs you is with the rest, whatever its session's state: a stale job whose PR's CI
  // fails needs you through the PR, so it sorts with the rows that need you, not after the calm ones.
  const bucket = (row: ListRow) => {
    if (isPrRow(row) || rowNeedsYou(row, notNeeded, work)) return 0;
    return isDone(row.session, work) ? 2 : row.session.stale ? 1 : 0;
  };
  const rank = (row: ListRow) => {
    if (rowNeedsYou(row, notNeeded, work)) return 0;
    return !isPrRow(row) && row.session.status === 'busy' ? 1 : 2;
  };
  return (a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    return (ba === 2 ? 0 : rank(a) - rank(b)) || rowActivity(b) - rowActivity(a) || compareKeys(a, b);
  };
}

/**
 * The scope's rows, split into the main list and the Finished section, each in `order` (listScope()
 * in sessions.ts, with PR rows and owned PRs, W106):
 * - a group: its sessions and its PR rows, then its finished sessions that own no open PR;
 * - All sessions: every session once, under its home group, and every PR row, then one Finished section;
 * - Needs you: every row that needs you, a session for itself or a PR it owns, and a PR row for its
 *   PR, with no Finished section;
 * - Starred: the starred sessions, as All sessions lists them; PR rows can't be starred;
 * - Pull requests: every row with an open PR, the sessions that own one and the PR rows, with no
 *   Finished section, since a session that owns an open PR is never finished work. Always by
 *   Urgency, as W95's list was: it has no Sort.
 */
export function listWork(
  groups: readonly ListGroup[],
  scope: WorkScope,
  order: SortOrder,
  home: ReadonlyMap<string, SessionGroup> | undefined,
  notNeeded: NotNeeded | undefined,
  work: Work,
): { current: ListRow[]; finished: Listed[] } {
  const sessions: Listed[] = scope.kind === 'group' ? scope.group.sessions.map((session) => ({ session, group: scope.group })) : listedOnce(groups, home);
  const prs: ListedPr[] = scope.kind === 'group' ? (scope.group.prs ?? []).map((pr) => ({ pr, group: scope.group })) : prRowsIn(groups);
  const sorted = (rows: ListRow[], by: SortOrder = order) => rows.sort(rowOrder(by, notNeeded, work));
  const done = (rows: Listed[]) => {
    const compare = sessionOrder(order, true, notNeeded);
    return rows.filter(({ session }) => isDone(session, work)).sort((a, b) => compare(a.session, b.session));
  };
  switch (scope.kind) {
    case 'needs-you':
      return { current: sorted([...sessions, ...prs].filter((row) => rowNeedsYou(row, notNeeded, work))), finished: [] };
    case 'prs':
      return { current: sorted([...sessions.filter(({ session }) => ownsPr(session, work)), ...prs], 'urgency'), finished: [] };
    case 'starred': {
      const starred = sessions.filter(({ session }) => scope.ids.has(session.sessionId));
      return { current: sorted(starred.filter(({ session }) => !isDone(session, work))), finished: done(starred) };
    }
    default:
      return { current: sorted([...sessions.filter(({ session }) => !isDone(session, work)), ...prs]), finished: done(sessions) };
  }
}

/** Whether a PR row's PR, or one of a session's owned PRs, is one of the relations on (W101's chips, in the Pull requests view). */
export function matchesRelations(row: ListRow, relations: ReadonlySet<PullRequestRelation>, work: Work): boolean {
  if (relations.size === 0) return true;
  if (isPrRow(row)) return relations.has(row.pr.relation);
  return (work.owned.get(row.session.sessionId) ?? []).some((pr) => relations.has(pr.relation));
}

/**
 * The rows that pass the filters, in the order given (filterListed() in sessions.ts, with PR rows):
 * - The chips: a kind chip keeps the sessions of its kind, and no PR row, which is no session of
 *   either kind; Has PR keeps the rows with an open PR, the sessions that own one and every PR row.
 * - The text: a session as filterListed() matches it, or by a PR it owns (its title, repo, "#128" or
 *   branch); a PR row by its group's label, title, repo, number or branch.
 */
export function filterRows<T extends ListRow>(rows: readonly T[], filters: Filters, work: Work): T[] {
  const needle = filterNeedle(filters.text);
  const kinds = filters.chips.size - (filters.chips.has('has-pr') ? 1 : 0);
  const byText = (prs: readonly PullRequestSummary[]) => needle !== '' && filterPrs(prs, needle).length > 0;
  return rows.filter((row) => {
    if (isPrRow(row)) {
      if (kinds > 0) return false;
      return needle === '' || groupLabel(row.group).toLowerCase().includes(needle) || byText([row.pr]);
    }
    const { session, group } = row;
    const owned = work.owned.get(session.sessionId) ?? [];
    if (filters.chips.has('has-pr') && owned.length === 0) return false;
    if (kinds > 0 && !filters.chips.has(session.kind)) return false;
    if (needle === '') return true;
    return (
      groupLabel(group).toLowerCase().includes(needle) ||
      (session.workedIn?.some((repo) => repo.label.toLowerCase().includes(needle)) ?? false) ||
      session.name.toLowerCase().includes(needle) ||
      (session.title?.toLowerCase().includes(needle) ?? false) ||
      session.cwd.toLowerCase().includes(needle) ||
      byText(owned)
    );
  });
}

/** The owners of the hidden PRs, each once, in the order first seen: what the Pull requests view's line names. */
export function hiddenOwners(work: Work): string[] {
  return [...new Set(work.hidden.map((pr) => pr.repoLabel.split('/')[0] ?? pr.repoLabel))];
}
