// The directory list behind New session's "Another directory under a root…" field (W70): one GET of
// DIRECTORIES_PATH per opening of the dialog, then the options narrowed in the page as you type, so
// typing makes no requests. The server walks the roots (src/server/directories.ts); the spawn still
// checks the directory it gets, so the list only helps to type one.
//
// - Options: the open root tab's directories (W38), or every root's without tabs, each read as the
//   root shortened with shortenHome(), then `/` and the path under it: `~/code/outpost`.
// - Matching: case-insensitive. Every whitespace-separated term must appear in the path under the
//   root, or, when the text starts with `~` or `/`, in the whole shortened path; one that starts with
//   `/` may match the absolute path instead, so a pasted path finds its option.
// - Ranking, on the last term, from its last `/`: the last segment equal to it, then the last segment
//   starting with it, then any segment starting with it, then the rest; ties go to the shallower,
//   then alphabetically. At most MAX_SHOWN are shown.
// - The value: an accepted option sends its absolute path, root plus `/` plus the path. Typed text
//   works as before: an absolute path as it is, and a `~/` path whose start is a root's shortened
//   form maps to that root.

import { DIRECTORIES_PATH, type DirectoryList } from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { shortenHome } from './format.js';
import { directoryProblem, rootOf } from './spawn.js';

/** How many options the list shows at once. */
export const MAX_SHOWN = 50;

/** C0 and C1 controls, DEL and the bidi controls: the server leaves them out; so does the page. */
const UNLISTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

export interface DirectoryOption {
  /** Absolute: the root, `/`, then `rel`. What the request sends. */
  path: string;
  /** The root shortened with shortenHome(), `/`, then `rel`: what the option reads as, and the field shows once it's chosen. */
  label: string;
  /** Relative to its root, `/`-separated. */
  rel: string;
  root: string;
  repo: boolean;
  /** Levels below the root: 1 for its own folders. */
  depth: number;
  /** For matching: lower-cased. */
  search: { rel: string; label: string; path: string; segments: string[] };
}

/** The roots' directories as the server listed them, and whether any root it offers stopped early. */
export interface DirectoryOptions {
  options: DirectoryOption[];
  truncated: boolean;
}

/** A DirectoryList, if `body` is one; entries that aren't a clean relative path are dropped. Undefined otherwise. */
export function parseDirectoryList(body: unknown): DirectoryList | undefined {
  if (!isRecord(body) || !Array.isArray(body.roots)) return undefined;
  const roots: DirectoryList['roots'] = [];
  for (const item of body.roots) {
    if (!isRecord(item) || typeof item.root !== 'string' || !item.root.startsWith('/') || !Array.isArray(item.dirs) || typeof item.truncated !== 'boolean') return undefined;
    const dirs: DirectoryList['roots'][number]['dirs'] = [];
    for (const entry of item.dirs) {
      if (!isRecord(entry) || typeof entry.path !== 'string' || !isCleanRelative(entry.path)) continue;
      dirs.push(entry.repo === true ? { path: entry.path, repo: true } : { path: entry.path });
    }
    roots.push({ root: item.root, dirs, truncated: item.truncated });
  }
  return { roots };
}

function isCleanRelative(rel: string): boolean {
  if (rel === '' || UNLISTABLE.test(rel)) return false;
  return rel.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** GETs the list. Undefined when it couldn't be had: a failure, a refusal, or an answer that isn't one. */
export async function fetchDirectories(api: ApiClient, signal?: AbortSignal): Promise<DirectoryList | undefined> {
  const result = await api.get(DIRECTORIES_PATH, signal ? { signal } : {});
  return result.kind === 'ok' ? parseDirectoryList(result.body) : undefined;
}

function join(root: string, rel: string): string {
  return root.endsWith('/') ? `${root}${rel}` : `${root}/${rel}`;
}

/**
 * The options to offer: with a root tab open (W38), that root's directories alone, otherwise every
 * root's. A directory is offered under the root the index would place it in, the longest that holds
 * it (rootOf), so with one root inside another, the outer root's walk doesn't offer the inner root's
 * directories, which belong to its own tab.
 */
export function directoryOptions(list: DirectoryList, roots: readonly string[], tab?: string): DirectoryOptions {
  const options: DirectoryOption[] = [];
  let truncated = false;
  for (const { root, dirs, truncated: cut } of list.roots) {
    if (!roots.includes(root) || (tab !== undefined && root !== tab)) continue;
    truncated ||= cut;
    const short = shortenHome(root);
    for (const { path: rel, repo } of dirs) {
      const path = join(root, rel);
      if (rootOf(path, roots) !== root) continue;
      const label = join(short, rel);
      const lower = rel.toLowerCase();
      options.push({
        path,
        label,
        rel,
        root,
        repo: repo === true,
        depth: rel.split('/').length,
        search: { rel: lower, label: label.toLowerCase(), path: path.toLowerCase(), segments: lower.split('/') },
      });
    }
  }
  return { options, truncated };
}

export interface DirectoryMatches {
  /** The best MAX_SHOWN, in order. */
  shown: DirectoryOption[];
  /** How many matched in all. */
  total: number;
}

/** The options that match `text`, ranked, as the module comment says. */
export function matchDirectories(options: readonly DirectoryOption[], text: string, limit = MAX_SHOWN): DirectoryMatches {
  const query = text.trim().toLowerCase();
  const terms = query.split(/\s+/).filter((term) => term !== '');
  const pathLike = query.startsWith('~') || query.startsWith('/');
  const last = terms[terms.length - 1] ?? '';
  const key = last.slice(last.lastIndexOf('/') + 1);

  const ranked: Array<{ option: DirectoryOption; rank: number }> = [];
  for (const option of options) {
    const { search } = option;
    const haystack = pathLike ? search.label : search.rel;
    const matches = terms.every((term) => haystack.includes(term)) || (query.startsWith('/') && terms.every((term) => search.path.includes(term)));
    if (matches) ranked.push({ option, rank: rank(search.segments, key) });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.option.depth - b.option.depth || compareLabels(a.option, b.option));
  return { shown: ranked.slice(0, limit).map((each) => each.option), total: ranked.length };
}

function rank(segments: readonly string[], key: string): number {
  if (key === '') return 3;
  const lastSegment = segments[segments.length - 1] ?? '';
  if (lastSegment === key) return 0;
  if (lastSegment.startsWith(key)) return 1;
  if (segments.some((segment) => segment.startsWith(key))) return 2;
  return 3;
}

/** Alphabetical, ignoring case, then by code unit, so the order is always the same. */
function compareLabels(a: DirectoryOption, b: DirectoryOption): number {
  const x = a.search.label;
  const y = b.search.label;
  if (x !== y) return x < y ? -1 : 1;
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

/**
 * A typed directory as the request sends it: an absolute path as it is; a `~` path whose start is a
 * root's shortened form (shortenHome) under that root, the longest such root winning; anything else
 * as typed, for typedDirectoryProblem() to explain. Trimmed.
 */
export function resolveTypedDirectory(text: string, roots: readonly string[]): string {
  const value = text.trim();
  if (!value.startsWith('~')) return value;
  let best: { root: string; short: string } | undefined;
  for (const root of roots) {
    const short = shortenHome(root);
    if (!short.startsWith('~')) continue;
    const prefix = short.endsWith('/') ? short : `${short}/`;
    if ((value === short || value.startsWith(prefix)) && (best === undefined || short.length > best.short.length)) best = { root, short };
  }
  return best ? `${best.root}${value.slice(best.short.length)}` : value;
}

/**
 * What's wrong with a typed directory, if anything: directoryProblem() on what it resolves to, with
 * the W38 rule for the open tab, or why it couldn't be resolved. `roots` are the snapshot's.
 */
export function typedDirectoryProblem(text: string, resolved: string, roots: readonly string[], tab?: string): string | undefined {
  const value = text.trim();
  if (value === '') return 'Choose a directory.';
  if (resolved.startsWith('/')) return directoryProblem(resolved, roots, tab);
  if (value.startsWith('~')) return `Use a directory under ${(tab === undefined ? roots : [tab]).map(shortenHome).join(' or ')}.`;
  return 'Use an absolute path, or one that starts with ~/.';
}

/** "1 directory", "12 directories". */
export function directoryCount(count: number): string {
  return `${count.toLocaleString('en')} ${count === 1 ? 'directory' : 'directories'}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
