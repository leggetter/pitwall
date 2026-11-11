// Not for me (W188): a pull request you're not taking on, such as a review you won't do. Phil,
// 2026-11-11: "Have we a feature planned to dismiss a session or PR request (a conversation)? For
// example, PR reviews that I'm not going to take on." A dismissed PR leaves Needs you and every count
// it feeds (prNeedsAttention()), and the web UI lists it in a muted Dismissed section, not hidden.
//
// It comes back when something new happens: its stateHash (src/prs/parse.ts, stateHashOf()) is no
// longer the one it was dismissed with. That's a new review request of you, a re-request included, a
// new mention of you, or on your own PR a new review, a changes request or CI going red. A refresh
// with nothing new gives the same hash. Then the dismissal is dropped, and the PR carries
// `dismissalEnded` for PR_DISMISSAL_ENDED_SHOWN_MS, so its row can say why it's back. A PR with no
// stateHash, one whose inputs couldn't be read, can't be dismissed, and a dismissal of it ends.
//
// Sessions have snooze (W154) and flag (W153) instead; this is for PRs alone, and never acts on
// GitHub: declining the review there is a later item.
//
//   POST PR_DISMISS_PATH     body: PrDismissRequest as JSON              answers: PrDismissResult
//     200  { ok: true, dismissed }
//     400  the body isn't a PrDismissRequest
//     404  the PR isn't in the list
//     409  it has no stateHash, or `seen` isn't its stateHash now: something new since the page showed it
//     413  the body is over PR_DISMISS_BODY_MAX_BYTES
//     415  the body isn't `Content-Type: application/json`
//
//   POST PR_UNDISMISS_PATH   body: PrUndismissRequest as JSON            answers: PrDismissResult
//     200  { ok: true }: the dismissal is gone, if there was one, and any end still shown
//     400, 413, 415  as above
//
// Both are POSTs, so the /api/* middleware in server.ts has already required the apiKey and this
// server's Origin. Nothing is sent to GitHub or to a session. The supervisor sees `dismissed` in
// list_prs and has no tool to dismiss (D4: it acts only after your click).
//
// Kept in $PITWALL_HOME/pr-dismissals.json, 0600, written whole by rename, after reading the file
// again and merging it, so a second pitwall on the same home doesn't lose this one's: each PR's key,
// `owner/name#number`, when it was dismissed and the hash; the ends still shown, key and time. Never a
// title, body or login. Read back as untrusted: opened without following a link or blocking on a
// FIFO, a regular file of this user's, not writable by group or others, at most
// PR_DISMISSAL_FILE_MAX_BYTES; each record checked field by field, read by own property only, and
// made again from its checked fields. At most PR_DISMISSALS_HELD_MAX of each; one older than
// PR_DISMISSAL_MAX_AGE_MS goes, and so does one whose PR a complete list no longer has, closed,
// merged or no longer yours. Writing fails soft: the dismissal holds in memory for this run.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isRecord } from '../index/guards.js';
import type { PrSource } from '../prs/index.js';
import {
  GITHUB_OWNER_PATTERN,
  GITHUB_REPO_NAME_PATTERN,
  PR_DISMISS_PATH,
  PR_DISMISSAL_ENDED_SHOWN_MS,
  PR_RELATIONS,
  PR_STATE_HASH_PATTERN,
  PR_UNDISMISS_PATH,
  PRS_LIST_MAX,
  PRS_SHOWN_DAYS,
  type PrDismissal,
  type PrDismissResult,
  type PullRequestList,
  type PullRequestSummary,
} from '../shared/protocol.js';
import { ensureLaunchDir } from './launch.js';

/** The file's name in pitwall's home. */
export const PR_DISMISSAL_FILE_NAME = 'pr-dismissals.json';
/** The most dismissals held, and ends shown: as many as the list can hold, so any PR listed can be. Past it the oldest goes. */
export const PR_DISMISSALS_HELD_MAX = PRS_LIST_MAX;
/** A record is at most about 300 bytes, with a 201-character key; 1,200 of them fit. */
export const PR_DISMISSAL_FILE_MAX_BYTES = 512 * 1024;
/** A request is a few hundred bytes. */
export const PR_DISMISS_BODY_MAX_BYTES = 4 * 1024;
/** A dismissal older than this goes, whatever its PR: as long as the web UI lists a PR no session owns. */
export const PR_DISMISSAL_MAX_AGE_MS = PRS_SHOWN_DAYS * 24 * 60 * 60 * 1000;

/** A PR's key in the store: lowercase `owner/name#number`. */
const KEY = new RegExp(`^(${GITHUB_OWNER_PATTERN})/(${GITHUB_REPO_NAME_PATTERN})#([1-9][0-9]{0,9})$`);
const HASH = new RegExp(`^${PR_STATE_HASH_PATTERN}$`);
const REPO = new RegExp(`^(${GITHUB_OWNER_PATTERN})/(${GITHUB_REPO_NAME_PATTERN})$`);
/** GitHub's own times, and ours: UTC, with or without fractions of a second. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** Whether `key` is a PR's key as the store keeps it: lowercase `owner/name#number`, never `.` or `..` as the name. */
export function isPrDismissalKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length > 212 || key !== key.toLowerCase()) return false;
  const match = KEY.exec(key);
  return match !== null && match[2] !== '.' && match[2] !== '..';
}

/** A PR's key in the store, from the list's lowercase repo and its number. */
export const prDismissalKey = (pr: Pick<PullRequestSummary, 'repo' | 'number'>): string => `${pr.repo}#${pr.number}`;

interface StoredDismissal {
  key: string;
  at: string;
  hash: string;
}

interface StoredEnd {
  key: string;
  at: string;
}

const ms = (iso: string): number => Date.parse(iso);
const isTime = (value: unknown): value is string => typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value));
/** A field of a parsed record, only when it's the record's own: never one from its prototype. */
const own = (record: Record<string, unknown>, name: string): unknown => (Object.hasOwn(record, name) ? record[name] : undefined);

export interface PrDismissalStoreOptions {
  /** pitwall's home. Without one, dismissals are held in memory only. */
  home?: string;
  now?: () => Date;
}

/** The dismissals held, their file, and the PR list's decoration. */
export class PrDismissalStore {
  readonly #file: string | undefined;
  readonly #home: string | undefined;
  readonly #now: () => Date;
  /** By key, oldest first. */
  #dismissals = new Map<string, { at: string; hash: string }>();
  #ended = new Map<string, { at: string }>();
  /** What this run took away, and when, so a merge with the file doesn't bring it back. */
  readonly #removed = new Map<string, number>();
  readonly #listeners = new Set<() => void>();
  #version = 0;

  constructor(options: PrDismissalStoreOptions = {}) {
    this.#home = options.home === undefined ? undefined : path.resolve(options.home);
    this.#file = this.#home === undefined ? undefined : path.join(this.#home, PR_DISMISSAL_FILE_NAME);
    this.#now = options.now ?? (() => new Date());
    const stored = this.#file === undefined ? { dismissals: [], ended: [] } : readPrDismissalFile(this.#file, this.#now());
    for (const { key, at, hash } of stored.dismissals) this.#dismissals.set(key, { at, hash });
    for (const { key, at } of stored.ended) if (!this.#dismissals.has(key)) this.#ended.set(key, { at });
    this.#prune(this.#now().getTime());
  }

  /** Dismisses the PR `key` in the state `hash`. Replaces a dismissal it had. */
  dismiss(key: string, hash: string): PrDismissal {
    const at = this.#now().toISOString();
    this.#dismissals.delete(key);
    this.#dismissals.set(key, { at, hash });
    this.#ended.delete(key);
    this.#removed.delete(key);
    this.#prune(this.#now().getTime());
    this.#saved();
    return { at };
  }

  /** Takes `key`'s dismissal off, and any end still shown. False when it had neither. */
  undismiss(key: string): boolean {
    const had = this.#dismissals.delete(key);
    const shown = this.#ended.delete(key);
    if (!had && !shown) return false;
    this.#forget(key);
    this.#saved();
    return true;
  }

  /** The dismissal of `key`, for tests and the routes. */
  get(key: string): { at: string; hash: string } | undefined {
    const held = this.#dismissals.get(key);
    return held === undefined ? undefined : { ...held };
  }

  /** How many dismissals are held. */
  size(): number {
    return this.#dismissals.size;
  }

  /**
   * `list` with `dismissed` on each PR dismissed in the state it's in now, and `dismissalEnded` on each
   * whose dismissal ended in the last PR_DISMISSAL_ENDED_SHOWN_MS. A dismissal whose PR is listed with
   * another stateHash, or none, ends here. One whose PR isn't listed stays, unless the list is
   * complete (every search worked and none was cut at PRS_MAX): then the PR has closed or isn't yours
   * any more, and it goes. A copy when any PR changed.
   */
  decorate(list: PullRequestList): PullRequestList {
    const now = this.#now().getTime();
    let dirty = this.#prune(now);
    if (this.#dismissals.size === 0 && this.#ended.size === 0) {
      if (dirty) this.#write();
      return list;
    }
    let changed = false;
    const listed = new Set<string>();
    const prs = list.prs.map((pr) => {
      const key = prDismissalKey(pr);
      listed.add(key);
      const held = this.#dismissals.get(key);
      if (held !== undefined) {
        if (pr.stateHash !== undefined && pr.stateHash === held.hash) {
          changed = true;
          return { ...pr, dismissed: { at: held.at } };
        }
        // Something new: it's back, and says so.
        this.#dismissals.delete(key);
        this.#forget(key);
        this.#ended.set(key, { at: new Date(now).toISOString() });
        dirty = true;
      }
      const end = this.#ended.get(key);
      if (end === undefined) return pr;
      changed = true;
      return { ...pr, dismissalEnded: { at: end.at } };
    });
    if (isComplete(list)) {
      for (const key of [...this.#dismissals.keys(), ...this.#ended.keys()]) {
        if (listed.has(key)) continue;
        this.#dismissals.delete(key);
        this.#ended.delete(key);
        this.#forget(key);
        dirty = true;
      }
    }
    if (dirty) {
      this.#cap();
      this.#write();
    }
    return changed ? { ...list, prs } : list;
  }

  /** Changes whenever decorate() could answer differently for the same list. */
  version(): number {
    return this.#version;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Drops the dismissals older than PR_DISMISSAL_MAX_AGE_MS and the ends shown long enough. True when one went. */
  #prune(now: number): boolean {
    let dropped = false;
    for (const [key, held] of this.#dismissals) {
      if (ms(held.at) + PR_DISMISSAL_MAX_AGE_MS <= now) {
        this.#dismissals.delete(key);
        this.#forget(key);
        dropped = true;
      }
    }
    for (const [key, end] of this.#ended) {
      if (ms(end.at) + PR_DISMISSAL_ENDED_SHOWN_MS <= now) {
        this.#ended.delete(key);
        dropped = true;
      }
    }
    return this.#cap() || dropped;
  }

  /** Past PR_DISMISSALS_HELD_MAX, the oldest go. True when one went. */
  #cap(): boolean {
    let dropped = false;
    while (this.#dismissals.size > PR_DISMISSALS_HELD_MAX) {
      const key = this.#dismissals.keys().next().value!;
      this.#dismissals.delete(key);
      this.#forget(key);
      dropped = true;
    }
    while (this.#ended.size > PR_DISMISSALS_HELD_MAX) {
      this.#ended.delete(this.#ended.keys().next().value!);
      dropped = true;
    }
    while (this.#removed.size > PR_DISMISSALS_HELD_MAX) this.#removed.delete(this.#removed.keys().next().value!);
    return dropped;
  }

  /** Remembers that this run took `key`'s dismissal away now, so the file's copy of it, as old or older, isn't merged back. */
  #forget(key: string): void {
    this.#removed.delete(key);
    this.#removed.set(key, this.#now().getTime());
  }

  /** After a change of yours: written, and every view told. */
  #saved(): void {
    this.#write();
    this.#changed();
  }

  #changed(): void {
    this.#version += 1;
    for (const listener of [...this.#listeners]) listener();
  }

  /**
   * The file, read again and merged, then written whole by rename. The merge keeps, for each key, the
   * newer of the file's record and this run's, and leaves out what this run took away since the
   * file's was made. What the merge brought in shows from the next decorate(). Fails soft.
   */
  #write(): void {
    if (this.#file === undefined || this.#home === undefined) return;
    const now = this.#now();
    const disk = readPrDismissalFile(this.#file, now);
    const removedSince = (key: string, at: string) => {
      const removed = this.#removed.get(key);
      return removed !== undefined && removed >= ms(at);
    };
    let merged = false;
    for (const { key, at, hash } of disk.dismissals) {
      if (removedSince(key, at)) continue;
      const mine = this.#dismissals.get(key);
      if (mine !== undefined && ms(mine.at) >= ms(at)) continue;
      if (mine === undefined && (this.#ended.get(key)?.at ?? '') >= at) continue;
      this.#dismissals.set(key, { at, hash });
      this.#ended.delete(key);
      merged = true;
    }
    for (const { key, at } of disk.ended) {
      if (this.#dismissals.has(key) || removedSince(key, at)) continue;
      const mine = this.#ended.get(key);
      if (mine !== undefined && ms(mine.at) >= ms(at)) continue;
      this.#ended.set(key, { at });
      merged = true;
    }
    if (merged) {
      // Oldest first again, so the cap still drops the oldest.
      this.#dismissals = new Map([...this.#dismissals].sort((a, b) => ms(a[1].at) - ms(b[1].at)));
      this.#ended = new Map([...this.#ended].sort((a, b) => ms(a[1].at) - ms(b[1].at)));
      this.#prune(now.getTime());
      // The next decorate() shows them; not told from here, which can be inside one.
      this.#version += 1;
    }
    const body = {
      v: 1,
      dismissals: [...this.#dismissals].map(([key, held]) => ({ key, at: held.at, hash: held.hash })),
      ended: [...this.#ended].map(([key, end]) => ({ key, at: end.at })),
    };
    const temporary = `${this.#file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      ensureLaunchDir(this.#home);
      writeFileSync(temporary, `${JSON.stringify(body)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.#file);
    } catch {
      try {
        unlinkSync(temporary);
      } catch {
        // Never written.
      }
    }
  }
}

/** Whether `list` has every open PR of yours: every search worked in its latest try, and none was cut at PRS_MAX. */
function isComplete(list: PullRequestList): boolean {
  if (!list.source.ok || list.fetchedAt === undefined || list.truncated === true || list.searches === undefined) return false;
  return PR_RELATIONS.every((relation) => {
    const search = list.searches?.[relation];
    return search !== undefined && search.fetchedAt !== undefined && search.failed === undefined;
  });
}

/**
 * The dismissals and ends in the file at `file` that check out; none when there's no file or it can't
 * be trusted: not a regular file of this user's, a link, a FIFO, writable by group or others, or over
 * PR_DISMISSAL_FILE_MAX_BYTES. Each record is read by own property only and made again from its
 * checked fields: a key by pattern, a time as ISO 8601 no later than `now`, a hash of 16 hex digits.
 * A key twice keeps the later. Oldest first.
 */
export function readPrDismissalFile(file: string, now: Date = new Date()): { dismissals: StoredDismissal[]; ended: StoredEnd[] } {
  const none = { dismissals: [], ended: [] };
  const nowMs = now.getTime();
  let fd: number | undefined;
  let value: unknown;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || stat.size > PR_DISMISSAL_FILE_MAX_BYTES) return none;
    // Never more than fstat said, whatever the file grows to while it's read.
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read);
      if (count === 0) break;
      read += count;
    }
    value = JSON.parse(buffer.subarray(0, read).toString('utf8'));
  } catch {
    return none;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!isRecord(value) || own(value, 'v') !== 1) return none;
  const timeOf = (raw: unknown): string | undefined => {
    if (!isTime(raw)) return undefined;
    return ms(raw) > nowMs ? now.toISOString() : new Date(ms(raw)).toISOString();
  };
  const dismissals = new Map<string, StoredDismissal>();
  const rawDismissals = own(value, 'dismissals');
  for (const entry of Array.isArray(rawDismissals) ? (rawDismissals as unknown[]).slice(0, PR_DISMISSALS_HELD_MAX * 2) : []) {
    if (!isRecord(entry)) continue;
    const key = own(entry, 'key');
    const hash = own(entry, 'hash');
    const at = timeOf(own(entry, 'at'));
    if (!isPrDismissalKey(key) || typeof hash !== 'string' || !HASH.test(hash) || at === undefined) continue;
    const before = dismissals.get(key);
    if (before !== undefined && ms(before.at) >= ms(at)) continue;
    dismissals.delete(key);
    dismissals.set(key, { key, at, hash });
  }
  const ended = new Map<string, StoredEnd>();
  const rawEnded = own(value, 'ended');
  for (const entry of Array.isArray(rawEnded) ? (rawEnded as unknown[]).slice(0, PR_DISMISSALS_HELD_MAX * 2) : []) {
    if (!isRecord(entry)) continue;
    const key = own(entry, 'key');
    const at = timeOf(own(entry, 'at'));
    if (!isPrDismissalKey(key) || at === undefined) continue;
    const before = ended.get(key);
    if (before !== undefined && ms(before.at) >= ms(at)) continue;
    ended.delete(key);
    ended.set(key, { key, at });
  }
  const oldestFirst = <T extends { at: string }>(records: Iterable<T>) => [...records].sort((a, b) => ms(a.at) - ms(b.at)).slice(-PR_DISMISSALS_HELD_MAX);
  return { dismissals: oldestFirst(dismissals.values()), ended: oldestFirst(ended.values()) };
}

/**
 * `source` with each PR's `dismissed` and `dismissalEnded`. latest() keeps one object until the inner
 * list or the store changes, so the 'prs' message is serialised once per change (websocket.ts), and
 * listeners hear of a change of either.
 */
export function withDismissals(source: PrSource, store: PrDismissalStore): PrSource {
  let cached: { inner: PullRequestList; version: number; list: PullRequestList } | undefined;
  const listeners = new Set<(list: PullRequestList) => void>();
  const latest = (): PullRequestList => {
    const inner = source.latest();
    if (cached !== undefined && cached.inner === inner && cached.version === store.version()) return cached.list;
    let list: PullRequestList;
    try {
      list = store.decorate(inner);
    } catch {
      // A decoration that fails leaves the list as it is: nothing dismissed.
      list = inner;
    }
    cached = { inner, version: store.version(), list };
    return list;
  };
  const tell = () => {
    const list = latest();
    for (const listener of [...listeners]) {
      try {
        listener(list);
      } catch {
        // One listener's failure, such as a socket that closed, mustn't stop the others.
      }
    }
  };
  const unsubscribes = [source.subscribe(() => tell()), store.subscribe(() => tell())];
  const wrapped: PrSource = {
    latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: () => source.refresh(),
    start: () => source.start(),
    stop() {
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      listeners.clear();
      source.stop();
    },
  };
  if (source.rediscover !== undefined) wrapped.rediscover = () => source.rediscover?.();
  return wrapped;
}

/** The PR a request names, or why it isn't one. `withSeen` for a dismissal, which says the hash it saw. */
export function validatePrDismissRequest(body: unknown, withSeen: boolean): { ok: true; repo: string; number: number; seen?: string } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: 'The body must be a JSON object.' };
  const allowed = withSeen ? ['repo', 'number', 'seen'] : ['repo', 'number'];
  for (const key of Object.keys(body)) if (!allowed.includes(key)) return { ok: false, error: 'The body has a field pitwall doesn’t know.' };
  const repo = own(body, 'repo');
  const number = own(body, 'number');
  if (typeof repo !== 'string' || repo.length > 201 || repo !== repo.toLowerCase()) return { ok: false, error: 'Name the pull request’s repo as owner/name.' };
  const match = REPO.exec(repo);
  if (match === null || match[2] === '.' || match[2] === '..') return { ok: false, error: 'Name the pull request’s repo as owner/name.' };
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || number > 9_999_999_999) return { ok: false, error: 'Give the pull request’s number.' };
  if (!withSeen) return { ok: true, repo, number };
  const seen = own(body, 'seen');
  if (typeof seen !== 'string' || !HASH.test(seen)) return { ok: false, error: 'Say which state of the pull request you saw.' };
  return { ok: true, repo, number, seen };
}

export interface PrDismissalRouteSources {
  /** The list the page sees, with places and dismissals. */
  prs: Pick<PrSource, 'latest'>;
  store: PrDismissalStore;
}

/** Adds Not for me's routes. Call it after the /api/* checks and before the /api/* catch-all. */
export function registerPrDismissals(app: Hono, sources: PrDismissalRouteSources): void {
  const answer = (c: Context, result: PrDismissResult, status: 200 | 400 | 404 | 409 | 413 | 415) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };
  const limit = bodyLimit({ maxSize: PR_DISMISS_BODY_MAX_BYTES, onError: (c) => answer(c, { ok: false, error: 'The request is too large.' }, 413) });
  /** The body as JSON, or the answer that says why not. */
  const bodyOf = async (c: Context): Promise<{ ok: true; body: unknown } | { ok: false; status: 400 | 415; error: string }> => {
    const type = c.req.header('content-type') ?? '';
    if (!/^application\/json\s*(;|$)/i.test(type)) return { ok: false, status: 415, error: 'Send the request as application/json.' };
    try {
      return { ok: true, body: await c.req.json() };
    } catch {
      return { ok: false, status: 400, error: "The body isn't valid JSON." };
    }
  };

  app.post(PR_DISMISS_PATH, limit, async (c) => {
    const read = await bodyOf(c);
    if (!read.ok) return answer(c, { ok: false, error: read.error }, read.status);
    const request = validatePrDismissRequest(read.body, true);
    if (!request.ok) return answer(c, { ok: false, error: request.error }, 400);
    const pr = sources.prs.latest().prs.find((each) => each.repo === request.repo && each.number === request.number);
    if (pr === undefined) return answer(c, { ok: false, error: "That pull request isn't among your open pull requests." }, 404);
    if (pr.stateHash === undefined) return answer(c, { ok: false, error: "pitwall can't tell when something new happens on it, so it can't be dismissed." }, 409);
    if (pr.stateHash !== request.seen) return answer(c, { ok: false, error: 'Something new happened on it since the page showed it. Look again before you dismiss it.' }, 409);
    const dismissed = sources.store.dismiss(prDismissalKey(pr), pr.stateHash);
    return answer(c, { ok: true, dismissed }, 200);
  });

  app.post(PR_UNDISMISS_PATH, limit, async (c) => {
    const read = await bodyOf(c);
    if (!read.ok) return answer(c, { ok: false, error: read.error }, read.status);
    const request = validatePrDismissRequest(read.body, false);
    if (!request.ok) return answer(c, { ok: false, error: request.error }, 400);
    sources.store.undismiss(`${request.repo}#${request.number}`);
    return answer(c, { ok: true }, 200);
  });
}
