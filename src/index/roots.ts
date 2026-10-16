// Which configured root, if any, a session belongs to.

import { realpath as fsRealpath } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from './guards.js';

export type Realpath = (p: string) => Promise<string>;

/**
 * Resolves the configured roots with realpath, keeping their order and
 * dropping duplicates. A root that can't be resolved (it doesn't exist, or
 * can't be read) is kept as its absolute path, so it still matches sessions
 * once it exists.
 */
export async function resolveRoots(roots: readonly string[], realpath: Realpath = fsRealpath): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    const real = await realpathOr(path.resolve(root), realpath);
    if (!resolved.includes(real)) resolved.push(real);
  }
  return resolved;
}

/** A session's cwd for matching: its realpath when it still exists, as given otherwise. */
export async function resolveCwd(cwd: string, realpath: Realpath = fsRealpath): Promise<string> {
  return (await inspectCwd(cwd, realpath)).path;
}

export interface CwdInfo {
  /** The realpath, or the cwd as given when it can't be resolved. */
  path: string;
  /** True when the directory no longer exists: realpath failed with ENOENT. */
  missing: boolean;
}

/** `resolveCwd`, and whether the directory has gone. Any other failure, such as EACCES, isn't counted as missing. */
export async function inspectCwd(cwd: string, realpath: Realpath = fsRealpath): Promise<CwdInfo> {
  try {
    return { path: await realpath(cwd), missing: false };
  } catch (err) {
    return { path: cwd, missing: isRecord(err) && err.code === 'ENOENT' };
  }
}

/**
 * The root `dir` sits in: the root itself or an ancestor of `dir`. With nested
 * roots the longest one wins. Undefined when `dir` is outside every root.
 */
export function matchRoot(dir: string, roots: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const root of roots) {
    if (isWithin(root, dir) && (best === undefined || root.length > best.length)) best = root;
  }
  return best;
}

/**
 * True when `child` is `parent` or below it. Uses `path.relative`, not a
 * string prefix, so `/a/b` does not contain `/a/bc`.
 */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

async function realpathOr(p: string, realpath: Realpath): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}
