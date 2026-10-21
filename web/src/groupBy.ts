// View preferences: Group sessions by (docs/design-system.md, 3: Repo list, and 4: View preferences),
// W42. The snapshot lists each session in the group it started in (W39). The page groups it again
// for the viewer's choice, so switching is instant and never asks the server.
//
// - Main repo, the default (Phil, 2026-10-21): a session started in a root itself that worked in
//   repos is listed under one of them, its main repo: the one with the most changes, ties broken by
//   tool calls, then the newest touch, then the path. The repo may be under another root, and so in
//   that root's tab. A root-started session that worked in no repo stays in the root's own group,
//   and every other session stays where it started. Each session is in one group, so counts add up,
//   as in W39.
// - Where it started: the snapshot's groups as they are (W39).
// - Every repo it worked in: W34's listing. Each session is under the group it started in and under
//   every repo it worked in, except that the root's own group holds only the root-started sessions
//   that worked in no repo. A group counts its distinct sessions, so the groups' counts can add up to
//   more than All sessions'.
//
// Whatever the mode, each session has one home group: the one its row names in Needs you and All
// sessions, and the one a ?session= link selects. That's the group it's listed under in Main repo
// and Where it started; in Every repo it worked in, the group it started in, or, for a root-started
// session that worked in repos, its main repo.
//
// "Started in a root itself" is a session in a root's own group that is a directory, as W34 had it:
// a root that is itself a repo is a repo like any other, and its sessions stay put. A repo that only
// moved sessions list has no group in the snapshot, so one is built from the WorkedIn: its key, label
// and root, kind 'git'.
//
// The choice is kept in localStorage as pitwall.group-by.v1, holding the mode alone: "main-repo",
// "where-started" or "every-repo". Missing, throwing or any other value gives Main repo, as
// groupState.ts falls back.

import { useCallback, useState } from 'react';
import type { SessionGroup, SessionSummary, WorkedIn } from '../../src/shared/protocol.js';
import { browserStorage, type StorageSource } from './groupState.js';
import { compareSessions, groupId, isRootGroup } from './sessions.js';

export type GroupBy = 'main-repo' | 'where-started' | 'every-repo';

export const GROUP_BY_KEY = 'pitwall.group-by.v1';

export const DEFAULT_GROUP_BY: GroupBy = 'main-repo';

/** The modes in the menu's order, the default first. */
export const GROUP_BY_MODES: readonly GroupBy[] = ['main-repo', 'where-started', 'every-repo'];

export const GROUP_BY_LABELS: Readonly<Record<GroupBy, string>> = {
  'main-repo': 'Main repo',
  'where-started': 'Where it started',
  'every-repo': 'Every repo it worked in',
};

/** Each mode's one plain line in the menu, under its label. */
export const GROUP_BY_DESCRIPTIONS: Readonly<Record<GroupBy, string>> = {
  'main-repo': 'A session started in a root goes under the repo it changed most.',
  'where-started': 'Each session stays under the repo or directory it started in.',
  'every-repo': 'A session shows under every repo it worked in, so counts can overlap.',
};

/** The radio group's name, which the menu shows above the modes. */
export const GROUP_BY_TITLE = 'Group sessions by';

export function isGroupBy(value: unknown): value is GroupBy {
  return typeof value === 'string' && (GROUP_BY_MODES as readonly string[]).includes(value);
}

/** The stored mode, or Main repo when there's none, it can't be read, or it isn't one of the three. */
export function readGroupBy(storage: StorageSource = browserStorage): GroupBy {
  try {
    const stored = storage()?.getItem(GROUP_BY_KEY);
    return isGroupBy(stored) ? stored : DEFAULT_GROUP_BY;
  } catch {
    return DEFAULT_GROUP_BY;
  }
}

export function writeGroupBy(mode: GroupBy, storage: StorageSource = browserStorage): void {
  try {
    storage()?.setItem(GROUP_BY_KEY, mode);
  } catch {
    // Blocked or full: the mode lasts until the page reloads.
  }
}

/** The mode, read once, and a setter that stores each choice. */
export function useGroupBy(storage: StorageSource = browserStorage): [GroupBy, (mode: GroupBy) => void] {
  const [mode, setMode] = useState(() => readGroupBy(storage));
  const choose = useCallback(
    (next: GroupBy) => {
      setMode(next);
      writeGroupBy(next, storage);
    },
    [storage],
  );
  return [mode, choose];
}

function lastAtMs(repo: WorkedIn): number {
  const ms = Date.parse(repo.lastAt);
  return Number.isFinite(ms) ? ms : 0;
}

/** Most changes first, then most tool calls, then the newest touch, then the path, then the root. */
function compareMain(a: WorkedIn, b: WorkedIn): number {
  return (
    b.changes - a.changes ||
    b.calls - a.calls ||
    lastAtMs(b) - lastAtMs(a) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
    (a.root < b.root ? -1 : a.root > b.root ? 1 : 0)
  );
}

/** A session's main repo: the one it changed most, ties broken by tool calls, then the newest touch, then the path. */
export function mainRepo(workedIn: readonly WorkedIn[]): WorkedIn | undefined {
  let best: WorkedIn | undefined;
  for (const repo of workedIn) if (best === undefined || compareMain(repo, best) < 0) best = repo;
  return best;
}

/** A root's own directory, as opposed to a root that is itself a repo: its sessions are the ones Main repo moves. */
export function isRootStart(group: Pick<SessionGroup, 'root' | 'key' | 'kind'>): boolean {
  return group.kind === 'directory' && isRootGroup(group);
}

export interface Grouped {
  /**
   * The groups for the mode, each listing its sessions once, in the index's order (compareSessions).
   * The snapshot's groups keep their order, and groups built for repos with none follow them. A
   * group with no sessions is left out, the root's own included.
   */
  groups: SessionGroup[];
  /** Each session's home group, by session id: one of the groups that list it (see the top of this file). */
  home: ReadonlyMap<string, SessionGroup>;
}

/** The groups for a mode, from the snapshot's, which list each session where it started (W39). */
export function groupSessions(startGroups: SessionGroup[], mode: GroupBy): Grouped {
  if (mode === 'where-started') {
    const home = new Map<string, SessionGroup>();
    for (const group of startGroups) for (const session of group.sessions) if (!home.has(session.sessionId)) home.set(session.sessionId, group);
    return { groups: startGroups, home };
  }
  // Each snapshot group, emptied, in its order; then a group for each repo that only moved sessions list.
  const byId = new Map<string, SessionGroup>();
  const order: SessionGroup[] = [];
  for (const group of startGroups) {
    const copy: SessionGroup = { ...group, sessions: [] };
    byId.set(groupId(group), copy);
    order.push(copy);
  }
  const repoGroup = (repo: WorkedIn): SessionGroup => {
    const id = groupId(repo);
    let group = byId.get(id);
    if (group === undefined) {
      group = { key: repo.key, label: repo.label, kind: 'git', root: repo.root, sessions: [] };
      byId.set(id, group);
      order.push(group);
    }
    return group;
  };
  const add = (group: SessionGroup, session: SessionSummary) => {
    if (!group.sessions.includes(session)) group.sessions.push(session);
  };
  const home = new Map<string, SessionGroup>();
  for (const start of startGroups) {
    const listed = byId.get(groupId(start)) as SessionGroup;
    for (const session of start.sessions) {
      if (home.has(session.sessionId)) continue;
      const worked = session.workedIn ?? [];
      const main = isRootStart(start) ? mainRepo(worked) : undefined;
      const homeGroup = main === undefined ? listed : repoGroup(main);
      home.set(session.sessionId, homeGroup);
      if (mode === 'main-repo') {
        add(homeGroup, session);
        continue;
      }
      // Every repo it worked in: the root's own group keeps only the sessions that worked in no repo.
      if (main === undefined) add(listed, session);
      for (const repo of worked) add(repoGroup(repo), session);
    }
  }
  for (const group of order) group.sessions.sort(compareSessions);
  return { groups: order.filter((group) => group.sessions.length > 0), home };
}

/**
 * The id (groupId) of every group a session could be listed under in any mode: the snapshot's, and
 * every repo a session worked in. pitwall.finished.v1 keeps these, so a switch doesn't forget a
 * Finished section's state.
 */
export function everyGroupId(startGroups: readonly SessionGroup[]): Set<string> {
  const ids = new Set<string>();
  for (const group of startGroups) {
    ids.add(groupId(group));
    for (const session of group.sessions) for (const repo of session.workedIn ?? []) ids.add(groupId(repo));
  }
  return ids;
}

/** How a mode reads after "grouped by", in a sentence: "grouped by where it started". */
export function groupByPhrase(mode: GroupBy): string {
  const label = GROUP_BY_LABELS[mode];
  return label.charAt(0).toLowerCase() + label.slice(1);
}
