// The directory list (W70): GET DIRECTORIES_PATH, for the New session dialog's "Another directory
// under a root…" field, which narrows the list as you type, in the page. Typing makes no requests.
//
// A GET, so the /api/* middleware in server.ts has already checked Host, Origin and the token or the
// apiKey. Then:
//
//   GET DIRECTORIES_PATH          no query                             answers: DirectoryList
//     200  each root of the latest snapshot, in its order, with the directories under it
//     503  no snapshot yet, so the roots aren't known
//
// The walk, per root, breadth-first to DIRECTORY_DEPTH levels below it:
//
// - It lists directories only. `readdir` with `withFileTypes` reports a symlink as a symlink, never
//   as what it points to, so a symlink is neither listed nor followed, and nothing listed is outside
//   its root.
// - It skips a name that starts with `.`, `node_modules`, and a name with a C0 or C1 control, DEL, a
//   bidi control (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), or U+FFFD, which is
//   what a name that isn't valid UTF-8 reads as, so it couldn't be typed back. Nothing inside a
//   skipped folder is read.
// - A folder it can't read is left out, silently, with nothing inside it. A root it can't read lists
//   none.
// - An entry with a `.git` entry of its own, a folder or a file (a worktree's), is `repo: true`.
// - It stops a root at DIRECTORY_MAX entries or after 2 seconds, with `truncated: true`. A read that
//   hangs, as on a network mount, is given up on at the deadline.
//
// A result is reused for 30 seconds, and requests while a walk runs share it. The list only helps to
// type a directory: a spawn checks its `cwd` as before (actions.ts).
import type { Dirent } from 'node:fs';
import { readdir as fsReaddir } from 'node:fs/promises';
import path from 'node:path';
import type { Hono } from 'hono';
import type { Indexer } from '../index/index.js';
import {
  DIRECTORIES_PATH,
  DIRECTORY_DEPTH,
  DIRECTORY_MAX,
  type DirectoryEntry,
  type DirectoryList,
} from '../shared/protocol.js';

/** How long one root's walk may take. */
export const DIRECTORY_WALK_MS = 2000;
/** How long a result is reused. */
export const DIRECTORY_CACHE_MS = 30_000;
/** Directory reads at once, per root. */
export const DIRECTORY_READS = 16;

/** C0 and C1 controls, DEL, the bidi controls, and U+FFFD, which an undecodable name reads as. */
const UNLISTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufffd]/;

/** Whether a folder with this name is listed, and walked into. */
export function isListable(name: string): boolean {
  return name !== '' && !name.startsWith('.') && name !== 'node_modules' && !UNLISTABLE.test(name);
}

export type ReadDirectory = (dir: string) => Promise<Dirent[]>;

const defaultReaddir: ReadDirectory = (dir) => fsReaddir(dir, { withFileTypes: true });

export interface DirectoryOptions {
  /** Levels below a root. Default DIRECTORY_DEPTH. */
  depth?: number;
  /** Entries per root. Default DIRECTORY_MAX. */
  max?: number;
  /** Milliseconds per root. Default DIRECTORY_WALK_MS. */
  timeLimitMs?: number;
  /** Milliseconds a result is reused. Default DIRECTORY_CACHE_MS. */
  cacheMs?: number;
  /** Reads at once, per root. Default DIRECTORY_READS. */
  concurrency?: number;
  /** Milliseconds since the epoch, for the cache. Default Date.now. */
  now?: () => number;
  /** Default `readdir` with `withFileTypes`. Tests wrap it, to count, slow or fail reads. */
  readdir?: ReadDirectory;
}

/** Never a real result: what a read that missed the deadline resolves to. */
const EXPIRED = Symbol('expired');

type Read = { kind: 'ok'; children: string[]; repo: boolean } | { kind: 'unreadable' } | { kind: 'expired' };

/** A directory found under the root: listed, unless reading it fails. */
interface Node {
  rel: string;
  depth: number;
  repo: boolean;
  unreadable: boolean;
}

/** Shallower first, then by path, compared by UTF-16 code unit, as DirectoryList says. */
export function compareEntries(a: DirectoryEntry, b: DirectoryEntry): number {
  const depth = segments(a.path) - segments(b.path);
  if (depth !== 0) return depth;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function segments(rel: string): number {
  let count = 1;
  for (const char of rel) if (char === '/') count += 1;
  return count;
}

/** Walks one root, as the module comment says. Never rejects. */
export async function walkRoot(root: string, options: DirectoryOptions = {}): Promise<DirectoryList['roots'][number]> {
  const depth = options.depth ?? DIRECTORY_DEPTH;
  const max = options.max ?? DIRECTORY_MAX;
  const concurrency = Math.max(1, options.concurrency ?? DIRECTORY_READS);
  const readdir = options.readdir ?? defaultReaddir;

  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(EXPIRED);
    }, options.timeLimitMs ?? DIRECTORY_WALK_MS);
    timer.unref?.();
  });

  const read = async (rel: string, wantChildren: boolean): Promise<Read> => {
    if (expired) return { kind: 'expired' };
    let entries: Dirent[] | typeof EXPIRED;
    try {
      entries = await Promise.race([readdir(rel === '' ? root : path.join(root, rel)), deadline]);
    } catch {
      return { kind: 'unreadable' };
    }
    if (entries === EXPIRED) return { kind: 'expired' };
    let repo = false;
    const children: string[] = [];
    for (const entry of entries) {
      if (entry.name === '.git') repo = true;
      // A symlink's Dirent says symlink, whatever it points to, so it's never a directory here.
      if (wantChildren && entry.isDirectory() && isListable(entry.name)) children.push(entry.name);
    }
    children.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { kind: 'ok', children, repo };
  };

  const listed: Node[] = [];
  let truncated = false;
  try {
    const top = await read('', depth > 0);
    if (top.kind === 'expired') return { root, dirs: [], truncated: true };
    if (top.kind === 'unreadable') return { root, dirs: [], truncated: false };

    // The level being read, and what it found.
    let frontier: Node[] = [];
    const add = (parent: string, children: string[], level: number): boolean => {
      for (const name of children) {
        if (listed.length >= max) {
          truncated = true;
          return false;
        }
        const node: Node = { rel: parent === '' ? name : `${parent}/${name}`, depth: level, repo: false, unreadable: false };
        listed.push(node);
        frontier.push(node);
      }
      return true;
    };
    add('', top.children, 1);

    while (frontier.length > 0) {
      const level = frontier;
      frontier = [];
      // Each one is read to see that it can be, and whether it's a repo; its folders are wanted only
      // above the last level, and while there's room for them.
      const wantChildren = !truncated && (level[0]?.depth ?? depth) < depth;
      const reads = await mapLimit(level, concurrency, (node) => read(node.rel, wantChildren));
      for (let i = 0; i < level.length; i += 1) {
        const node = level[i] as Node;
        const result = reads[i] as Read;
        if (result.kind === 'expired') {
          truncated = true;
          continue;
        }
        if (result.kind === 'unreadable') {
          node.unreadable = true;
          continue;
        }
        node.repo = result.repo;
        if (wantChildren && !truncated) add(node.rel, result.children, node.depth + 1);
      }
      if (expired) {
        truncated = true;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const dirs = listed
    .filter((node) => !node.unreadable)
    .map((node): DirectoryEntry => (node.repo ? { path: node.rel, repo: true } : { path: node.rel }))
    .sort(compareEntries);
  return { root, dirs, truncated };
}

/** Runs `fn` on each item, at most `limit` at once, with the results in the items' order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface DirectoryLister {
  /** The roots' directories: a result under 30 seconds old for the same roots, the walk running now, or a new walk. */
  list(roots: readonly string[]): Promise<DirectoryList>;
}

/** Walks the roots, together, and keeps the result for `cacheMs`. Concurrent calls share a walk. */
export function createDirectoryLister(options: DirectoryOptions = {}): DirectoryLister {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? DIRECTORY_CACHE_MS;
  let cached: { key: string; promise: Promise<DirectoryList>; doneAt?: number } | undefined;

  return {
    list(roots) {
      const key = JSON.stringify(roots);
      if (cached && cached.key === key && (cached.doneAt === undefined || now() - cached.doneAt < cacheMs)) return cached.promise;
      const entry: NonNullable<typeof cached> = {
        key,
        promise: Promise.all(roots.map((root) => walkRoot(root, options))).then((walked) => ({ roots: walked })),
      };
      cached = entry;
      entry.promise.then(
        () => {
          entry.doneAt = now();
        },
        () => {
          // walkRoot never rejects; if it somehow did, the next request walks again.
          if (cached === entry) cached = undefined;
        },
      );
      return entry.promise;
    },
  };
}

/**
 * Adds GET DIRECTORIES_PATH. Call it after the /api/* checks and before the /api/* catch-all, as
 * ServerInternals.routes does.
 */
export function registerDirectories(app: Hono, indexer: Pick<Indexer, 'latest'>, options: DirectoryOptions = {}): void {
  const lister = createDirectoryLister(options);
  app.get(DIRECTORIES_PATH, async (c) => {
    c.header('Cache-Control', 'no-store');
    const snapshot = indexer.latest();
    if (!snapshot) return c.body(null, 503);
    return c.json(await lister.list(snapshot.roots));
  });
}
