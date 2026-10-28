// Starting, stopping and removing background sessions (W12), and resuming an
// ended interactive session in the background (W67): the API calls, through
// the app's ApiClient (api.ts), which sends the apiKey, never the token, and
// the checks the "New session" dialog makes before it sends one.
// The server (src/server/actions.ts) is the authority on every check.

import { useEffect, useState } from 'react';
import {
  removePath,
  resumePath,
  SPAWN_PATH,
  stopPath,
  type IndexSnapshot,
  type SessionSummary,
  type SpawnRequest,
} from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { couldNot, shortenHome, tryAgainIn } from './format.js';

// The server's rules, repeated so the dialog can say what's wrong before sending.

/** Letters, digits, space, `.`, `_` and `-`, at most 64. Not starting with `-` or a space, nor ending with a space. */
export const NAME_PATTERN = /^[A-Za-z0-9._](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9._-])?$/;
/** A short model alias: letters, digits, `-` and `.`, at most 40, not starting with `-`. */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$/;
export const MAX_PROMPT_LENGTH = 16_384;

/** A session the server started. It shows up in the list on a later poll. */
export interface StartedSession {
  shortId: string;
  name: string;
}

export type SpawnOutcome =
  | ({ kind: 'started' } & StartedSession)
  /** The server or Claude Code refused. `hint` is a command for the user to run, such as the one that trusts a workspace. */
  | { kind: 'refused'; error: string; hint?: string }
  /** The connection was refused (WebSocket 4401). The app is already showing that the token was rejected. */
  | { kind: 'unauthorized' }
  /** No answer pitwall understands: a network error, or a response that isn't a SpawnResult. */
  | { kind: 'failed'; error: string };

/** Starts a session with POST SPAWN_PATH. Never rejects. */
export async function spawnSession(api: ApiClient, request: SpawnRequest): Promise<SpawnOutcome> {
  const result = await api.post(SPAWN_PATH, request);
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  const body = asRecord(result.body);
  if (result.kind === 'ok') {
    if (body?.ok === true && typeof body.shortId === 'string' && typeof body.name === 'string') {
      return { kind: 'started', shortId: body.shortId, name: body.name };
    }
    return { kind: 'failed', error: "pitwall's answer didn't say which session started." };
  }
  if (body?.ok === false && typeof body.error === 'string') {
    return typeof body.hint === 'string' && body.hint !== ''
      ? { kind: 'refused', error: body.error, hint: body.hint }
      : { kind: 'refused', error: body.error };
  }
  return { kind: 'failed', error: couldNot('start the session', result.status) };
}

export type SessionAction = 'stop' | 'remove';

export type ActionOutcome =
  | { kind: 'done' }
  /** The server or Claude Code refused, with why: for example, `claude rm` kept a worktree with unpushed commits. */
  | { kind: 'refused'; error: string }
  | { kind: 'unauthorized' }
  /** No answer pitwall understands. `status` is the HTTP status, when the server answered. */
  | { kind: 'failed'; error: string; status?: number };

/** Stops or removes a background session with POST stopPath() or removePath(). Never rejects. */
export async function sessionAction(api: ApiClient, sessionId: string, action: SessionAction): Promise<ActionOutcome> {
  const result = await api.post(action === 'stop' ? stopPath(sessionId) : removePath(sessionId), {});
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  const body = asRecord(result.body);
  if (result.kind === 'ok' && body?.ok === true) return { kind: 'done' };
  if (result.kind === 'failed' && body?.ok === false && typeof body.error === 'string') return { kind: 'refused', error: body.error };
  const failed: ActionOutcome = { kind: 'failed', error: couldNot(`${action} the session`, result.status) };
  return result.status === undefined ? failed : { ...failed, status: result.status };
}

export type ResumeOutcome =
  /** Claude Code resumed it in the background, under its own session id (spike 006). */
  | { kind: 'resumed' }
  /**
   * Claude Code started a copy under a new id instead, `copyShortId`, because the session was open in
   * another Claude Code process after all (spike 006, finding 5). The copy is a background session.
   */
  | { kind: 'copied'; error: string; copyShortId: string }
  /** The server or Claude Code refused, with why. `hint` is a command for the user to run, such as the one that trusts a workspace. */
  | { kind: 'refused'; error: string; hint?: string }
  | { kind: 'unauthorized' }
  /** No answer pitwall understands. `status` is the HTTP status, when the server answered. */
  | { kind: 'failed'; error: string; status?: number };

/**
 * Resumes an ended interactive session in the background with POST resumePath() (W67), sent as Stop
 * and Remove are. Never rejects.
 */
export async function resumeSession(api: ApiClient, sessionId: string): Promise<ResumeOutcome> {
  const result = await api.post(resumePath(sessionId), {});
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  const body = asRecord(result.body);
  // Its short id isn't needed: the snapshot lists the session under its own id once it's running.
  if (result.kind === 'ok' && body?.ok === true) return { kind: 'resumed' };
  if (result.kind === 'failed' && body?.ok === false && typeof body.error === 'string') {
    if (typeof body.copyShortId === 'string' && body.copyShortId !== '') return { kind: 'copied', error: body.error, copyShortId: body.copyShortId };
    return typeof body.hint === 'string' && body.hint !== '' ? { kind: 'refused', error: body.error, hint: body.hint } : { kind: 'refused', error: body.error };
  }
  // A 429 with no reason of its own still says when to try again.
  const failed: ResumeOutcome = { kind: 'failed', error: `${couldNot('resume the session', result.status)}${tryAgainIn(result.kind === 'failed' ? result.retryAfter : undefined)}` };
  return result.status === undefined ? failed : { ...failed, status: result.status };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}


export interface DirectoryChoice {
  /** Absolute, as the snapshot has it: a real path. */
  path: string;
  /** For the picker: the path with the home directory shortened. */
  label: string;
}

/**
 * The directories a new session can start in without typing one: each
 * group's directory under a root, most recently active first, then the roots.
 * A group outside every root (a worktree whose main repo isn't under one)
 * is left out, since the server would refuse it. With a root tab open (W38),
 * the tab's groups' directories alone, then its root.
 */
export function directoryChoices(snapshot: Pick<IndexSnapshot, 'roots' | 'groups'>, tab?: string): DirectoryChoice[] {
  const roots = tab === undefined ? snapshot.roots : [tab];
  const paths: string[] = [];
  for (const group of snapshot.groups) {
    if ((tab === undefined || group.root === tab) && isUnderRoot(group.key, roots) && !paths.includes(group.key)) paths.push(group.key);
  }
  for (const root of roots) if (!paths.includes(root)) paths.push(root);
  return paths.map((path) => ({ path, label: shortenHome(path) }));
}

function isWithin(root: string, dir: string): boolean {
  const clean = dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
  return clean === root || clean.startsWith(root.endsWith('/') ? root : `${root}/`);
}

function isUnderRoot(dir: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithin(root, dir));
}

/**
 * The root a directory is under as the index places it (src/index/roots.ts, matchRoot): the longest
 * root that holds it, so with one root inside another the inner one. Undefined when none does. On the
 * path as typed; a path through a symlink is left to the server.
 */
export function rootOf(dir: string, roots: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const root of roots) if (isWithin(root, dir) && (best === undefined || root.length > best.length)) best = root;
  return best;
}

/**
 * What's wrong with a typed directory, if anything. A path through a symlink is left to the server.
 * With a root tab open (W38), the directory must be in that tab: under its root, and not under
 * another root inside it, whose tab the session would be listed in.
 */
export function directoryProblem(dir: string, roots: readonly string[], tab?: string): string | undefined {
  if (dir.trim() === '') return 'Choose a directory.';
  if (!dir.startsWith('/')) return 'Use an absolute path, starting with /.';
  if (/[\u0000-\u001f\u007f]/.test(dir)) return 'The path has control characters in it.';
  if (tab !== undefined) {
    const root = rootOf(dir, roots);
    if (root === tab) return undefined;
    const other = root === undefined ? '' : ` ${shortenHome(root)} has its own tab.`;
    return `Use a directory under ${shortenHome(tab)}.${other}`;
  }
  if (!isUnderRoot(dir, roots)) return `Use a directory under ${roots.map(shortenHome).join(' or ')}.`;
  return undefined;
}

export function nameProblem(name: string): string | undefined {
  if (name === '' || NAME_PATTERN.test(name)) return undefined;
  if (name.length > 64) return 'At most 64 characters.';
  return 'Letters, digits, spaces, ".", "_" and "-" only, starting with a letter, digit, "." or "_", and not ending with a space.';
}

export function modelProblem(model: string): string | undefined {
  if (model === '' || MODEL_PATTERN.test(model)) return undefined;
  return 'A short alias such as sonnet: letters, digits, "-" and ".", at most 40.';
}

export function promptProblem(prompt: string): string | undefined {
  if (prompt.trim() === '') return 'Write the first prompt.';
  if (prompt.length > MAX_PROMPT_LENGTH) return `At most ${MAX_PROMPT_LENGTH.toLocaleString('en')} characters.`;
  return undefined;
}

/**
 * Remembers a session that was just started, and opens it with `open` once
 * it shows up in `sessions`, which happens on a later poll.
 */
export function useOpenWhenListed(sessions: readonly SessionSummary[], open: (session: SessionSummary) => void) {
  const [waiting, setWaiting] = useState<StartedSession>();
  useEffect(() => {
    if (!waiting) return;
    const found = sessions.find((session) => session.kind === 'background' && session.shortId === waiting.shortId);
    if (!found) return;
    setWaiting(undefined);
    open(found);
  }, [waiting, sessions, open]);
  return { waiting, wait: setWaiting, dismiss: () => setWaiting(undefined) };
}
