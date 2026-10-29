// Which repo headings in the PR list are collapsed (M4, W95; docs/design-system.md, 4: Pull requests).
// Each starts expanded, and one collapsed or expanded again is remembered in localStorage, so the list
// looks the same after a reload or a browser restart. One key, pitwall.pr-repos.v1, holding a small
// versioned JSON value:
//
//   {"v":1,"collapsed":["a1b2c3d4e5f60718"]}
//
// - collapsed: each collapsed repo's 64-bit FNV-1a hash (fnv1a64() in notNeeded.ts) of its lowercase
//   `owner/name`, oldest first, never the name itself: a private repo's name is as sensitive as a PR's
//   title, which stays out of storage, as session content does (D14). A hash says which heading it is,
//   and nothing a reader of the storage could use. At most PR_REPOS_CAP, the oldest dropped.
//
// Never pruned because a repo has no open PRs: it may have some again later. Storage can be missing
// or throw, in a private window or with site data blocked, as in groupState.ts: then every heading
// starts expanded, collapsing still works for the page's life, and nothing throws. A value that isn't
// this shape collapses nothing; an entry in it that isn't a hash is skipped.

import { useCallback, useState } from 'react';
import { browserStorage, type StorageSource } from './groupState.js';
import { fnv1a64 } from './notNeeded.js';

export const PR_REPOS_KEY = 'pitwall.pr-repos.v1';

/** The most collapsed repos kept: more than the 12 repos of Phil's 33 recent PRs on 2026-10-28, many times over. */
export const PR_REPOS_CAP = 100;

const HASH = /^[0-9a-f]{16}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The hash a collapsed repo is kept as. */
export const repoHash = (repo: string): string => fnv1a64(repo);

/** The collapsed repos' hashes, oldest first: none when nothing is stored, storage is missing or throws, or the value isn't version 1's shape. */
export function readCollapsedRepos(storage: StorageSource = browserStorage): string[] {
  try {
    const raw = storage()?.getItem(PR_REPOS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.collapsed)) return [];
    const hashes = [...new Set(parsed.collapsed.filter((entry): entry is string => typeof entry === 'string' && HASH.test(entry)))];
    return hashes.slice(Math.max(0, hashes.length - PR_REPOS_CAP));
  } catch {
    return [];
  }
}

/** Stores the collapsed repos' hashes, at most PR_REPOS_CAP, the newest kept. A failure to write is ignored. */
export function writeCollapsedRepos(hashes: readonly string[], storage: StorageSource = browserStorage): void {
  const kept = hashes.slice(Math.max(0, hashes.length - PR_REPOS_CAP));
  try {
    storage()?.setItem(PR_REPOS_KEY, JSON.stringify({ v: 1, collapsed: kept }));
  } catch {
    // Blocked or full: the state lasts until the page reloads.
  }
}

export interface PrRepos {
  /** Whether a repo's heading is collapsed, by its lowercase `owner/name`. */
  isCollapsed: (repo: string) => boolean;
  /** Collapses an expanded heading, or expands a collapsed one, and remembers it. */
  toggle: (repo: string) => void;
}

/** The collapsed repo headings, read once from storage, and a way to toggle one. */
export function usePrRepos(storage: StorageSource = browserStorage): PrRepos {
  const [hashes, setHashes] = useState<readonly string[]>(() => readCollapsedRepos(storage));
  const isCollapsed = useCallback((repo: string) => hashes.includes(repoHash(repo)), [hashes]);
  const toggle = useCallback(
    (repo: string) => {
      setHashes((current) => {
        const hash = repoHash(repo);
        const next = current.includes(hash) ? current.filter((each) => each !== hash) : [...current, hash];
        writeCollapsedRepos(next, storage);
        return next.slice(Math.max(0, next.length - PR_REPOS_CAP));
      });
    },
    [storage],
  );
  return { isCollapsed, toggle };
}
