// Spawn, stop and remove (W12): the HTTP routes that start a background
// session with `claude --bg`, and stop or remove one with `claude stop` and
// `claude rm`. And resume (W66): bring an ended interactive session back as a
// background session with `claude --resume <id> --bg`.
//
// All four are POSTs, so the /api/* middleware in server.ts has already
// required the apiKey (never the raw token) and this server's Origin. Then:
//
//   POST SPAWN_PATH               body: SpawnRequest as JSON           answers: SpawnResult
//     201  started: { ok: true, shortId, name }
//     400  the body isn't a valid SpawnRequest, `cwd` isn't a directory at or under a root, or the
//          prompt is just the name of a claude subcommand, which `claude --bg` could run instead
//     413  the body is over 128 KiB
//     415  the body isn't `Content-Type: application/json`
//     422  Claude Code says the workspace isn't trusted. `hint` is the command that trusts it,
//          for the user to run. pitwall never grants trust itself
//     429  another spawn is still running, or too many in the last minute. Retry-After is set
//     502  Claude Code failed or refused, with its first error line, or wasn't found
//     503  no snapshot yet, so the roots aren't known
//     504  `claude --bg` didn't finish in time. The session may still appear
//
//   POST stopPath(id), removePath(id)                                  answers: ActionResult
//     200  done: { ok: true }
//     400, 404, 503  from resolveSession(): not a safe id, not listed, no snapshot yet
//     409  not a background session with a valid short id, or Claude Code refused, with
//          its message: `claude rm` keeps a worktree that has unpushed commits and says so
//     429  4 stop, remove, resume and open commands are already running (CommandSlots, shared
//          with open in an editor, editors.ts). Retry-After is set
//     502, 504  as for spawn
//
//   POST resumePath(id)           no body                              answers: ResumeResult
//     200  resumed: { ok: true, shortId }, the id `claude attach` takes. It waits for a prompt,
//          and needs you until you send one (Indexer.noteRestart, NeedsYou's 'restarted', W69)
//     400, 404, 503  from resolveSession()
//     409  not an ended session (SessionSummary.ended), or its id isn't a UUID; a resume of it is
//          already running; a fresh `claude agents` lists its session id in any row, as when its
//          terminal is open again (spike 006, finding 5); then, checked after that listing,
//          immediately before the run, its directory has gone, or no longer resolves to a directory
//          under a root (W81); or Claude Code started a copy instead, with `copyShortId`, which
//          pitwall leaves for the user
//     422  Claude Code says the workspace isn't trusted, with `hint`, as for spawn
//     429  as for stop and remove, whose limit it shares
//     502  the fresh `claude agents` failed, so nothing was resumed; or Claude Code failed,
//          with its first error line, or reported no id
//     504  `claude --resume` didn't finish in time. The session may still appear
//
// Every command is built from validated values only: the realpath of `cwd`,
// and for stop and remove the `shortId` of the session resolveSession()
// returned, never the raw route parameter. `claude rm` never gets
// `--discard-unpushed` or `--force-remove-worktree`. Resume runs in the
// realpath of the resolved session's own `cwd`, checked immediately before it
// starts, never a directory the request names, with `PWD` set to that `cwd`,
// its `sessionId`, a UUID, and no prompt, so no message text is on the command
// line.
import { realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createAgentsSource, listedSessionIds, type AgentsSource } from '../index/agents.js';
import type { Indexer } from '../index/index.js';
import { matchRoot } from '../index/roots.js';
import { isSessionUuid } from '../index/transcripts.js';
import {
  removePath,
  resumePath,
  SPAWN_PATH,
  stopPath,
  type ActionResult,
  type ResumeResult,
  type SpawnResult,
} from '../shared/protocol.js';
import { isClaudeCommand } from './claudeCommands.js';
import { childEnvironment, runCommand, type CommandResult, type RunCommand } from './command.js';
import type { RecentSpawns } from './recentSpawns.js';
import { resolveSession } from './sessions.js';

export interface ActionOptions {
  /** Default: runCommand. Tests pass a fake, so they never run `claude`. */
  run?: RunCommand;
  /** Path or name of the claude binary. Default 'claude'. */
  claudeBin?: string;
  /** The environment children start from, before childEnvironment() scrubs it. Default process.env, read per call. */
  env?: NodeJS.ProcessEnv;
  /** The server's token. Any variable whose value contains it is left out of a child's environment. */
  token?: string;
  /** Records each short id a spawn or a resume reports, so attach knows the session is starting (attach.ts). */
  spawned?: Pick<RecentSpawns, 'add'>;
  /**
   * Records each session id a resume brought back, so attach knows a session the snapshot still
   * shows as ended is starting (attach.ts). Keyed by session id, since an ended session has no short id.
   */
  resumed?: Pick<RecentSpawns, 'add'>;
  /**
   * The fresh `claude agents --json --all` a resume reads first. Default createAgentsSource(), the
   * index's own source, which runs it through the scrubbed environment. Tests pass a fake.
   */
  agents?: Pick<AgentsSource, 'list'>;
  /** Milliseconds since the epoch, for the rate limit and the time of a resume (Indexer.noteRestart). Default Date.now. */
  now?: () => number;
  /** Default 30 seconds, for each of `claude --bg`, `claude stop`, `claude rm` and `claude --resume`. */
  timeoutMs?: number;
  /** Spawns allowed to run at once. Default 1. */
  maxConcurrentSpawns?: number;
  /** Spawns allowed per window. Default 5 a minute. */
  spawnRate?: { max: number; windowMs: number };
  /** Stop, remove and resume commands allowed to run at once, together. Default 4. */
  maxConcurrentCommands?: number;
  /**
   * The slots those commands take, shared with open in an editor (editors.ts). The server makes one
   * for both. Default: new ones, `maxConcurrentCommands` of them.
   */
  slots?: CommandSlots;
}

export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CONCURRENT_SPAWNS = 1;
export const DEFAULT_SPAWN_RATE = { max: 5, windowMs: 60_000 } as const;
export const DEFAULT_MAX_CONCURRENT_COMMANDS = 4;

/** The largest spawn body accepted. A 16,384-character prompt is at most about 96 KiB of JSON. */
export const MAX_SPAWN_BODY_BYTES = 128 * 1024;
export const MAX_PROMPT_LENGTH = 16_384;
export const MAX_CWD_LENGTH = 4096;

/**
 * The contract's name characters (letters, digits, space, `.`, `_`, `-`), at
 * most 64. It can't start with `-` or a space, so it never reads as an
 * option, and can't end with a space.
 */
export const NAME_PATTERN = /^[A-Za-z0-9._](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9._-])?$/;

/** A short model alias such as `sonnet` or `claude-haiku-4-5`: letters, digits, `-` and `.`, at most 40, not starting with `-`. */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$/;

/**
 * A short id that's safe to pass to `claude stop` and `claude rm`. The same
 * rule as the web UI's attach command: it can't start with `-`.
 */
export const SHORT_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/** C0 controls and DEL. Never in a cwd: they'd make the hint's command read differently from what it runs. */
const CONTROL = /[\u0000-\u001f\u007f]/;

// Terminal escapes, then the remaining controls except tab and newline.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]/g;
const CONTROLS_BUT_NEWLINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** A request to start a session that passed every check. `cwd` is the realpath. */
export interface ValidSpawn {
  cwd: string;
  prompt: string;
  name?: string;
  model?: string;
}

export type SpawnValidation = { ok: true; spawn: ValidSpawn } | { ok: false; error: string };

/**
 * Checks a parsed body against the SpawnRequest rules. `roots` are the
 * snapshot's real-path roots. The directory is checked through its realpath,
 * so a symlink under a root that points outside it is refused.
 */
export async function validateSpawnRequest(body: unknown, roots: readonly string[]): Promise<SpawnValidation> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return invalid('The body must be a JSON object.');
  const { cwd, prompt, name, model } = body as Record<string, unknown>;

  if (typeof prompt !== 'string' || prompt.trim() === '') return invalid('The first prompt is required.');
  if (prompt.length > MAX_PROMPT_LENGTH) return invalid(`The first prompt can be at most ${MAX_PROMPT_LENGTH} characters.`);
  if (prompt.includes('\u0000')) return invalid('The first prompt contains a NUL character.');
  // `claude --bg -- update` could run `claude update` rather than start a session (claudeCommands.ts).
  if (isClaudeCommand(prompt)) {
    return invalid(
      `The first prompt can't be just "${prompt.trim().toLowerCase()}": that's the name of a claude command, which claude --bg could run instead of starting a session. Add a few words.`,
    );
  }

  if (name !== undefined && (typeof name !== 'string' || !NAME_PATTERN.test(name))) {
    return invalid('The name can have letters, digits, spaces, ".", "_" and "-", at most 64, and must start with a letter, digit, "." or "_".');
  }
  if (model !== undefined && (typeof model !== 'string' || !MODEL_PATTERN.test(model))) {
    return invalid('The model must be a short alias such as sonnet, opus or haiku: letters, digits, "-" and ".", at most 40.');
  }

  const dir = await checkDirectory(cwd, roots);
  if (!dir.ok) return dir;

  const spawn: ValidSpawn = { cwd: dir.path, prompt };
  if (name !== undefined) spawn.name = name as string;
  if (model !== undefined) spawn.model = model as string;
  return { ok: true, spawn };
}

/**
 * Whether `cwd` is still a directory under one of `roots`, through its realpath, so a symlink that now
 * points outside them is refused. Spawn, resume and open in an editor all check with it, and run in
 * the `path` it returns, never in `cwd` itself; resume and open check a listed session's own directory
 * afresh, immediately before they run, since it may have gone, or changed, since the poll.
 */
export async function checkDirectory(cwd: unknown, roots: readonly string[]): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (typeof cwd !== 'string' || cwd === '') return invalid('The directory is required.');
  if (cwd.length > MAX_CWD_LENGTH) return invalid('The directory path is too long.');
  if (CONTROL.test(cwd)) return invalid('The directory path contains control characters.');
  if (!path.isAbsolute(cwd)) return invalid('The directory must be an absolute path.');
  let real: string;
  try {
    real = await realpath(cwd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return invalid(code === 'ENOENT' || code === 'ENOTDIR' ? `${cwd} doesn't exist.` : `${cwd} can't be read.`);
  }
  if (matchRoot(real, roots) === undefined) {
    return invalid(`${cwd} isn't under ${roots.length === 1 ? 'the root' : 'any of the roots'}: ${roots.join(', ')}.`);
  }
  try {
    if (!(await stat(real)).isDirectory()) return invalid(`${cwd} isn't a directory.`);
  } catch {
    return invalid(`${cwd} can't be read.`);
  }
  return { ok: true, path: real };
}

function invalid(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** The arguments for `claude`. `--` ends the options, so a prompt that starts with `-` stays a prompt. */
export function spawnArgs(spawn: ValidSpawn): string[] {
  const args = ['--bg'];
  if (spawn.name !== undefined) args.push('--name', spawn.name);
  if (spawn.model !== undefined) args.push('--model', spawn.model);
  args.push('--', spawn.prompt);
  return args;
}

/**
 * The id and name from `claude --bg`'s output: its line
 * `backgrounded · <id> · <name>`, or `backgrounded · <id> (<state>)` from
 * `claude --resume <id> --bg`, which has no name. Undefined when there's no
 * such line, or the id isn't one that's safe to act on.
 */
export function parseBackgrounded(stdout: string): { shortId: string; name?: string } | undefined {
  for (const line of cleanText(stdout).split('\n')) {
    // A resume prints a state in brackets instead of a name: `backgrounded · 5e66fcb3 (idle — send a prompt to start)`.
    const match = /^\s*backgrounded\s+·\s+(\S+)(?:\s+·\s+(.*?)|\s+\(.*\))?\s*$/.exec(line);
    if (!match) continue;
    const shortId = match[1] as string;
    if (!SHORT_ID_PATTERN.test(shortId)) return undefined;
    const name = match[2];
    return name ? { shortId, name } : { shortId };
  }
  return undefined;
}

/**
 * The copy's short id from Claude Code's note when `claude --resume <id> --bg`
 * found the session open in another Claude Code process (spike 006, finding
 * 5): `note: session <id> is open in another Claude Code process, so this
 * started a copy as <copy>. The original conversation is unchanged.` It still
 * exits 0. `found` without `shortId` when there's a note but its id isn't one
 * that's safe to act on. Undefined when there's no note.
 */
export function parseCopyNote(output: string): { found: true; shortId?: string } | undefined {
  const match = /\bstarted a copy as ([^\s.,;:]+)/.exec(cleanText(output));
  if (!match) return undefined;
  const shortId = match[1] as string;
  return SHORT_ID_PATTERN.test(shortId) ? { found: true, shortId } : { found: true };
}

/** The arguments for resuming an ended session in the background, with no prompt. */
export function resumeArgs(sessionId: string): string[] {
  return ['--resume', sessionId, '--bg'];
}

/**
 * A POSIX shell word for `value`: as it is when it has only characters no
 * shell treats specially, otherwise in single quotes, with each `'` closed,
 * escaped and reopened.
 */
export function shellQuote(value: string): string {
  if (value !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command that trusts a workspace, for the user to run themselves: `cd <dir> && claude`. */
export function trustHint(dir: string): string {
  return `cd ${shellQuote(dir)} && claude`;
}

/** Claude Code's output as text: terminal escapes and controls other than tab and newline removed, trimmed. */
function cleanText(text: string): string {
  return text.replace(ESCAPES, '').replace(/\r\n?/g, '\n').replace(CONTROLS_BUT_NEWLINES, '').trim();
}

/** Claude Code's `Workspace not trusted. ...` line, at most 500 characters, when that's what it said. */
function untrustedLine(message: string): string | undefined {
  return cleanText(message)
    .split('\n')
    .find((line) => line.includes('Workspace not trusted'))
    ?.trim()
    .slice(0, 500);
}

/** The first non-empty line, at most 500 characters. */
export function firstLine(text: string): string | undefined {
  const line = cleanText(text)
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '');
  return line === undefined ? undefined : line.slice(0, 500);
}

/** A whole message, such as why `claude rm` kept a worktree, at most 2,000 characters. */
export function wholeMessage(text: string): string | undefined {
  const message = cleanText(text);
  return message === '' ? undefined : message.slice(0, 2000);
}

/** What Claude Code said: stderr, where it reports errors, or stdout when stderr is empty. */
function said(result: Extract<CommandResult, { kind: 'exited' }>): string {
  return result.stderr.trim() !== '' ? result.stderr : result.stdout;
}

/**
 * Counts spawns, so a stuck UI can't fork-bomb sessions: at most `max`
 * running at once, and `rate.max` started per `rate.windowMs`.
 */
export class SpawnLimiter {
  private running = 0;
  private started: number[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly rate: { max: number; windowMs: number },
    private readonly now: () => number,
  ) {}

  /**
   * Takes a slot, or says how many seconds to wait. Synchronous, so two
   * requests can't both pass between the check and the take.
   */
  acquire(): { ok: true; release: () => void } | { ok: false; error: string; retryAfterSeconds: number } {
    const now = this.now();
    this.started = this.started.filter((at) => now - at < this.rate.windowMs);
    if (this.running >= this.maxConcurrent) {
      return { ok: false, error: 'Another session is still starting. Try again in a moment.', retryAfterSeconds: 1 };
    }
    if (this.started.length >= this.rate.max) {
      const oldest = this.started[0] as number;
      const seconds = Math.max(1, Math.ceil((oldest + this.rate.windowMs - now) / 1000));
      return {
        ok: false,
        error: `pitwall starts at most ${this.rate.max} sessions every ${Math.round(this.rate.windowMs / 1000)} seconds. Try again in ${seconds}s.`,
        retryAfterSeconds: seconds,
      };
    }
    this.running += 1;
    this.started.push(now);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.running -= 1;
      },
    };
  }
}

/**
 * The stop, remove, resume and open commands running now, at most `max` together, so a stuck UI can't
 * pile them up. Open in an editor (editors.ts) takes a slot from the same CommandSlots, so the limit is
 * one for all four.
 */
export class CommandSlots {
  #running = 0;

  constructor(readonly max: number = DEFAULT_MAX_CONCURRENT_COMMANDS) {}

  /** What a refused request says, with 429 and `Retry-After: 1`. */
  get busyError(): string {
    return `pitwall is already running ${this.max} stop, remove, resume or open commands. Try again in a moment.`;
  }

  /** Takes a slot, and returns what gives it back, or undefined when all are taken. Synchronous, so two requests can't both take the last. */
  acquire(): (() => void) | undefined {
    if (this.#running >= this.max) return undefined;
    this.#running += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#running -= 1;
    };
  }
}

/** The stop route as a Hono pattern. stopPath() encodes its argument, so the pattern is decoded back. */
const STOP_ROUTE = decodeURIComponent(stopPath(':sessionId'));
const REMOVE_ROUTE = decodeURIComponent(removePath(':sessionId'));
const RESUME_ROUTE = decodeURIComponent(resumePath(':sessionId'));

/** What resolveSession()'s refusals say, by status. */
export const LOOKUP_ERRORS = {
  400: 'That is not a valid session id.',
  404: "That session isn't in pitwall's list.",
  503: "pitwall hasn't listed the sessions yet. Try again in a moment.",
} as const;

/**
 * Adds the spawn, stop, remove and resume routes. Call it after the /api/*
 * checks and before the /api/* catch-all, as ServerInternals.routes does.
 */
export function registerActions(app: Hono, indexer: Pick<Indexer, 'latest' | 'pollSoon' | 'noteRestart'>, options: ActionOptions = {}): void {
  const run = options.run ?? runCommand;
  const now = options.now ?? Date.now;
  const claudeBin = options.claudeBin ?? 'claude';
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const env = () => childEnvironment(options.env ?? process.env, options.token);
  const limiter = new SpawnLimiter(
    options.maxConcurrentSpawns ?? DEFAULT_MAX_CONCURRENT_SPAWNS,
    options.spawnRate ?? DEFAULT_SPAWN_RATE,
    now,
  );

  const spawnResult = (c: Context, result: SpawnResult, status: 201 | 400 | 413 | 415 | 422 | 429 | 502 | 503 | 504) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };

  app.post(
    SPAWN_PATH,
    bodyLimit({
      maxSize: MAX_SPAWN_BODY_BYTES,
      onError: (c) => spawnResult(c, { ok: false, error: 'The request is too large.' }, 413),
    }),
    async (c) => {
      const type = c.req.header('content-type') ?? '';
      if (!/^application\/json\s*(;|$)/i.test(type)) {
        return spawnResult(c, { ok: false, error: 'Send the request as application/json.' }, 415);
      }
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return spawnResult(c, { ok: false, error: "The body isn't valid JSON." }, 400);
      }
      const snapshot = indexer.latest();
      if (!snapshot) return spawnResult(c, { ok: false, error: LOOKUP_ERRORS[503] }, 503);

      const validation = await validateSpawnRequest(body, snapshot.roots);
      if (!validation.ok) return spawnResult(c, { ok: false, error: validation.error }, 400);
      const { spawn } = validation;

      const slot = limiter.acquire();
      if (!slot.ok) {
        c.header('Retry-After', String(slot.retryAfterSeconds));
        return spawnResult(c, { ok: false, error: slot.error }, 429);
      }
      let result: CommandResult;
      try {
        // PWD is the directory it runs in, as for resume: a new session records where it started.
        result = await run(claudeBin, spawnArgs(spawn), { cwd: spawn.cwd, env: { ...env(), PWD: spawn.cwd }, timeoutMs });
      } finally {
        slot.release();
      }

      if (result.kind === 'failed') {
        if (result.reason === 'timeout') {
          return spawnResult(c, { ok: false, error: `claude --bg ${result.message}. The session may still appear in the list.` }, 504);
        }
        return spawnResult(c, { ok: false, error: `Couldn't run claude: ${result.message}.` }, 502);
      }
      if (result.code !== 0) {
        const message = said(result);
        const untrusted = untrustedLine(message);
        if (untrusted !== undefined) return spawnResult(c, { ok: false, error: untrusted, hint: trustHint(spawn.cwd) }, 422);
        return spawnResult(c, { ok: false, error: firstLine(message) ?? `claude --bg exited with code ${result.code}.` }, 502);
      }
      const started = parseBackgrounded(result.stdout);
      if (!started) {
        const line = firstLine(result.stdout);
        return spawnResult(
          c,
          { ok: false, error: `Claude Code didn't report the new session's id${line ? `: ${line}` : '.'} It may still appear in the list.` },
          502,
        );
      }
      options.spawned?.add(started.shortId);
      return spawnResult(c, { ok: true, shortId: started.shortId, name: started.name ?? spawn.name ?? started.shortId }, 201);
    },
  );

  // Stop, remove and resume commands running now, and open in an editor's (editors.ts).
  const slots = options.slots ?? new CommandSlots(options.maxConcurrentCommands ?? DEFAULT_MAX_CONCURRENT_COMMANDS);
  const busy = (c: Context) => {
    c.header('Retry-After', '1');
    return { ok: false as const, error: slots.busyError };
  };

  const act = async (c: Context, verb: 'stop' | 'rm') => {
    c.header('Cache-Control', 'no-store');
    const answer = (result: ActionResult, status: 200 | 400 | 404 | 409 | 429 | 502 | 503 | 504) => c.json(result, status);
    const lookup = resolveSession(indexer, c.req.param('sessionId'));
    if (!lookup.ok) return answer({ ok: false, error: LOOKUP_ERRORS[lookup.status] }, lookup.status);
    const { session } = lookup;
    if (session.kind !== 'background') {
      return answer({ ok: false, error: 'Only background sessions can be stopped or removed from pitwall.' }, 409);
    }
    // From the resolved summary, never the route parameter.
    const shortId = session.shortId;
    if (shortId === undefined || !SHORT_ID_PATTERN.test(shortId)) {
      return answer({ ok: false, error: "This session has no short id that's safe to act on." }, 409);
    }
    const release = slots.acquire();
    if (!release) return answer(busy(c), 429);
    let result: CommandResult;
    try {
      result = await run(claudeBin, [verb, shortId], { cwd: os.tmpdir(), env: env(), timeoutMs });
    } finally {
      release();
    }
    if (result.kind === 'failed') {
      if (result.reason === 'timeout') return answer({ ok: false, error: `claude ${verb} ${result.message}.` }, 504);
      return answer({ ok: false, error: `Couldn't run claude: ${result.message}.` }, 502);
    }
    if (result.code !== 0) {
      return answer({ ok: false, error: wholeMessage(said(result)) ?? `claude ${verb} exited with code ${result.code}.` }, 409);
    }
    return answer({ ok: true }, 200);
  };

  app.post(STOP_ROUTE, (c) => act(c, 'stop'));
  app.post(REMOVE_ROUTE, (c) => act(c, 'rm'));

  const agents = options.agents ?? createAgentsSource({ claudeBin });
  // Session ids being resumed now: a second resume of one waits for the first's answer.
  const resuming = new Set<string>();

  app.post(RESUME_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store');
    const answer = (result: ResumeResult, status: 200 | 400 | 404 | 409 | 422 | 429 | 502 | 503 | 504) => c.json(result, status);
    const lookup = resolveSession(indexer, c.req.param('sessionId'));
    if (!lookup.ok) return answer({ ok: false, error: LOOKUP_ERRORS[lookup.status] }, lookup.status);
    const { session } = lookup;
    // From the resolved summary, never the route parameter. A UUID only: `claude --resume` takes a name too.
    const { sessionId, cwd } = session;
    if (session.ended !== true || !isSessionUuid(sessionId)) {
      return answer({ ok: false, error: 'Only an interactive session that has ended can be resumed from pitwall.' }, 409);
    }
    if (session.cwdMissing === true) {
      return answer({ ok: false, error: `It started in ${cwd}, which no longer exists, and Claude Code resumes a session only from where it started.` }, 409);
    }
    if (resuming.has(sessionId)) return answer({ ok: false, error: 'pitwall is already resuming this session.' }, 409);
    const release = slots.acquire();
    if (!release) return answer(busy(c), 429);
    resuming.add(sessionId);
    try {
      // A session that's open in a terminal again gets an unnamed copy, and Claude Code still exits 0
      // (spike 006, finding 5), so it's checked first, and nothing runs when the check can't be made.
      // Its session id in any row counts, one parseAgentRows() skipped included (W81).
      const listing = await agents.list();
      if (!listing.ok) {
        return answer({ ok: false, error: `pitwall couldn't check that the session isn't running again, so it didn't resume it: ${listing.error}.` }, 502);
      }
      if (listedSessionIds(listing).has(sessionId)) {
        indexer.pollSoon();
        return answer(
          { ok: false, error: "It's running again, in a terminal or in the background, so pitwall didn't resume it: that would start a copy." },
          409,
        );
      }

      // Afresh, as spawn checks its directory, and only now, after the listing, which can take 10 s:
      // it may have gone, or been swapped for a symlink that leads elsewhere, since the poll (W73, W81).
      // Nothing that can wait comes between this check and the run.
      const dir = await checkDirectory(cwd, indexer.latest()?.roots ?? []);
      if (!dir.ok) return answer({ ok: false, error: dir.error }, 409);

      // It runs in the realpath just checked, never the snapshot's path, so a symlink swapped after
      // the check can't move it. PWD is the snapshot's `cwd`, not pitwall's own, which
      // childEnvironment() passes on: Claude Code finds the session in the project folder of the
      // directory it started in, and a CLI that prefers PWD to the real cwd, to keep a symlinked path,
      // would otherwise look in pitwall's, or, given the realpath, in the realpath's, which isn't the
      // one a session started through a symlink is in. The check just resolved that `cwd` to
      // `dir.path`, so the two name the same directory; one that no longer resolves to a directory
      // under a root was refused with 409 above, rather than run with PWD set to the realpath.
      const result = await run(claudeBin, resumeArgs(sessionId), { cwd: dir.path, env: { ...env(), PWD: cwd }, timeoutMs });
      if (result.kind === 'failed') {
        if (result.reason === 'timeout') {
          indexer.pollSoon();
          return answer({ ok: false, error: `claude --resume ${result.message}. The session may still appear in the list.` }, 504);
        }
        return answer({ ok: false, error: `Couldn't run claude: ${result.message}.` }, 502);
      }
      if (result.code !== 0) {
        const message = said(result);
        const untrusted = untrustedLine(message);
        if (untrusted !== undefined) return answer({ ok: false, error: untrusted, hint: trustHint(cwd) }, 422);
        return answer({ ok: false, error: firstLine(message) ?? `claude --resume exited with code ${result.code}.` }, 502);
      }

      // Exit 0 either way: the copy's note says it wasn't this session that resumed.
      const copy = parseCopyNote(`${result.stdout}\n${result.stderr}`);
      if (copy !== undefined) {
        indexer.pollSoon();
        const copied: ResumeResult = {
          ok: false,
          error: `It was open in another Claude Code process after all, so Claude Code started a copy${copy.shortId === undefined ? '' : ` as ${copy.shortId}`} instead. The copy is listed as a background session with no name, which you can stop and remove.`,
        };
        // Left alone: it's the user's to stop and remove. Attach treats it as starting, as a spawn.
        if (copy.shortId !== undefined) {
          copied.copyShortId = copy.shortId;
          options.spawned?.add(copy.shortId);
        }
        return answer(copied, 409);
      }
      const resumed = parseBackgrounded(result.stdout);
      if (!resumed) {
        indexer.pollSoon();
        const line = firstLine(result.stdout);
        return answer(
          { ok: false, error: `Claude Code didn't report the resumed session's id${line ? `: ${line}` : '.'} It may still appear in the list.` },
          502,
        );
      }
      options.spawned?.add(resumed.shortId);
      options.resumed?.add(sessionId);
      // You asked for it back, so it needs your prompt until you send one (NeedsYou's 'restarted', W69). Polls soon.
      indexer.noteRestart(sessionId, now());
      return answer({ ok: true, shortId: resumed.shortId }, 200);
    } finally {
      release();
      resuming.delete(sessionId);
    }
  });
}
