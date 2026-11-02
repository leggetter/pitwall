// Roots as tabs (docs/design-system.md, 3: Header, and 4: Tabs), W38. With two or more roots, the
// header's root path becomes a tab per root, in the order pitwall was given them, and the open tab
// narrows the repo list, the session list, the filter, `j` and `k`, and the New session dialog's
// directories to its root. With one root there are no tabs, and nothing here applies.
//
// Which root a group is under is the server's call, never the page's: a group's SessionGroup.root,
// which the index chose with src/index/roots.ts's matchRoot(), the longest configured root that holds
// the directory, or a worked-in repo's WorkedIn.root for a group the page built (W42). So with one
// root inside another, a session under the inner one is in the inner root's tab alone, as the index
// lists it. A tab's sessions are those its groups list, as the chosen grouping has them (groupBy.ts),
// so Needs you, All sessions and their counts are its own, each session once. In Main repo a
// root-started session can move to a repo under another root, and so to that root's tab; in Every
// repo it worked in, a session can be in more than one tab.
//
// The open tab is the selection's root, in the URL (selection.ts): ?view=all&root=<root>, as
// ?repo=<key>&root=<root> already was with several roots. It's kept in localStorage as
// pitwall.root-tab.v1, holding the root's path alone, for a URL with no selection, such as the one
// the CLI opens. Storage can be missing or throw, in a private window or with site data blocked, as
// in groupState.ts: then the first root is the open tab, and nothing throws. A root pitwall no longer
// watches is ignored, the same way.

import type { IndexSnapshot, SessionGroup } from '../../src/shared/protocol.js';
import { browserStorage, type StorageSource } from './groupState.js';
import type { NotNeeded } from './notNeeded.js';
import { countNeeds, NO_WORK, type Work } from './work.js';

export const ROOT_TAB_KEY = 'pitwall.root-tab.v1';

/** The stored open tab: a root's path, or undefined when there's none, it can't be read, or it's empty. */
export function readStoredTab(storage: StorageSource = browserStorage): string | undefined {
  try {
    const stored = storage()?.getItem(ROOT_TAB_KEY);
    return typeof stored === 'string' && stored !== '' ? stored : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredTab(root: string, storage: StorageSource = browserStorage): void {
  try {
    storage()?.setItem(ROOT_TAB_KEY, root);
  } catch {
    // Blocked or full: the URL still says which tab is open.
  }
}

/** Whether pitwall watches more than one root, so the header shows a tab for each. */
export function hasTabs(roots: readonly string[]): boolean {
  return roots.length > 1;
}

/** What a selection says about its tab: its root, and for a group its key. A structural type, so this module doesn't import selection.ts. */
type Rooted = { root?: string | undefined; repo?: string | undefined };

/**
 * The tab a selection opens, with two or more roots: its root, when pitwall watches it; else, for a
 * group named without one, the root of the first group with its key, as findGroup() picks it; else
 * the stored tab, when pitwall watches it; else the first root. Undefined with one root.
 */
export function selectionTab(selection: Rooted, snapshot: Pick<IndexSnapshot, 'roots' | 'groups'>, stored: string | undefined): string | undefined {
  const { roots, groups } = snapshot;
  if (!hasTabs(roots)) return undefined;
  if (selection.root !== undefined && roots.includes(selection.root)) return selection.root;
  if (selection.repo !== undefined) {
    const group = groups.find((candidate) => candidate.key === selection.repo && roots.includes(candidate.root));
    if (group) return group.root;
  }
  if (stored !== undefined && roots.includes(stored)) return stored;
  return roots[0];
}

/** The groups a tab lists: those the index put under its root, or the server placed a PR under (W106). Every group, with no tab. */
export function tabGroups<T extends SessionGroup>(groups: readonly T[], tab: string | undefined): readonly T[] {
  return tab === undefined ? groups : groups.filter((group) => group.root === tab);
}

/**
 * How many of a root's rows need you, each session counted once, though in Every repo it worked in it
 * may be in several of the root's groups: an inactive tab's badge. Not what's marked not needed now
 * (W88). With `work` (W106), a session that needs you through a PR it owns, and a PR row that needs you.
 */
export function tabAttention(groups: readonly SessionGroup[], root: string, notNeeded?: NotNeeded, work: Work = NO_WORK): number {
  return countNeeds(tabGroups(groups, root), notNeeded, work);
}
