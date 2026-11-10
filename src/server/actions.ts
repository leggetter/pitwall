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
//     400  the body isn't a valid SpawnRequest, `cwd` isn't a directory at or under a root, the
//          name is one of pitwall's own, `pitwall-supervisor`, `pitwall-relay`, `pitwall-recap` or `pitwall-usage`,
//          ignoring case (W120), the
//          prompt is just the name of a claude subcommand, which `claude --bg` could run instead,
//          or `attachments` has more than ATTACHMENTS_MAX_PER_SESSION, the same id twice, or an id
//          that's unknown, already used, expired, being used by a spawn that's starting, or whose
//          file has gone (attachments.ts). Then nothing starts
//     413  the body is over 128 KiB
//     415  the body isn't `Content-Type: application/json`
//     422  Claude Code says the workspace isn't trusted. `hint` is the command that trusts it,
//          for the user to run. pitwall never grants trust itself. A directory whose path has a
//          `'` or `\` gets no `hint`, and `error` is still Claude Code's line alone (W87, shellQuote())
//     429  another spawn is still running, or too many sessions started in the last minute, new and
//          resumed together (SpawnLimiter). Retry-After is set
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
//     409  not an ended session (SessionSummary.ended) or a background session that isn't running
//          (W107), or its id isn't a UUID; a resume of it is already running; for an ended one, a
//          fresh `claude agents` lists its session id in any row, as when its terminal is open again
//          (spike 006, finding 5), and for a background one, it lists a process for it, an
//          interactive row with its id, or no row of its own; then, checked after that listing,
//          immediately before the run, its directory has gone, or no longer resolves to a directory
//          under a root (W81); or Claude Code started a copy instead, with `copyShortId`, which
//          pitwall leaves for the user
//     422  Claude Code says the workspace isn't trusted, with `hint`, as for spawn
//     429  as for stop and remove, whose limit it shares; or, since it starts a long-lived session,
//          past spawn's limit of sessions started in the last minute, which it shares (W81)
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
// line. The supervisor's resume_session (W127) runs the same code, createResumeRunner(),
// after your approval, with its message as the last argument after `--`, as
// spawn's first prompt is (spike 011).
//
// Attachments (W79, spike 008): spawn appends one `@<path>` line per file to
// the first prompt, after a blank line, and passes `--add-dir=<its folder>` for
// each, always in the `=` form, since `--add-dir` takes several values and
// would take the prompt as one (finding 4). The paths are the realpaths
// AttachmentStore kept for the ids, never anything the request names. The
// prompt's 16,384-character limit is the user's own text: the `@` lines are
// pitwall's, at most ATTACHMENTS_MAX_PER_SESSION of them, each at most
// STORED_PATH_MAX characters, so a prompt the dialog accepted is never
// refused for them. The ids are claimed before `claude --bg` runs, and marked
// used when it reports the new session, and also when the outcome is unknown:
// it timed out, was killed by a signal, or exited 0 without a session id, so a
// session may have started and may refer to the files. They're given back only
// when nothing started: claude wasn't found or couldn't be run, or it exited
// with an error.
import { realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createAgentsSource, listedSessionIds, sessionPids, type AgentsSource } from '../index/agents.js';
import { hasUnsafeCharacters } from '../index/guards.js';
import type { Indexer } from '../index/index.js';
import { matchRoot } from '../index/roots.js';
import { isSessionUuid } from '../index/transcripts.js';
import {
  ATTACHMENTS_MAX_PER_SESSION,
  isEffortLevel,
  isWorkModel,
  removePath,
  resumePath,
  SPAWN_PATH,
  SPAWN_PROMPT_MAX,
  stopPath,
  type ActionResult,
  type ResumeResult,
  type SessionLaunch,
  type SessionSummary,
  type SpawnResult,
  type WorkChoice,
  type WorkProfile,
  WORK_DEFAULT,
} from '../shared/protocol.js';
import { UNKNOWN_ATTACHMENT_ERROR, type AttachmentFile, type AttachmentStore } from './attachments.js';
import { OWN_NAMES } from '../supervisor/supervisorGateHook.mjs';
import { isClaudeCommand } from './claudeCommands.js';
import { childEnvironment, runCommand, type CommandResult, type RunCommand } from './command.js';
import type { RecentSpawns } from './recentSpawns.js';
import { resolveSession } from './sessions.js';
import { launchWork, type SessionLaunches } from './sessionLaunches.js';
import { withSkill } from './profiles.js';
import { EFFORT_PROBLEM, mergeChoices, modelProblem, withEffort, workArgs, type WorkStore } from './work.js';

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
  /** Sessions started per window, spawns and resumes together (W81). Default 5 a minute. */
  spawnRate?: { max: number; windowMs: number };
  /** Stop, remove and resume commands allowed to run at once, together. Default 4. */
  maxConcurrentCommands?: number;
  /**
   * The slots those commands take, shared with open in an editor (editors.ts). The server makes one
   * for both. Default: new ones, `maxConcurrentCommands` of them.
   */
  slots?: CommandSlots;
  /** The uploads spawn's `attachments` name (W79). The server passes its store. Without one, every id is unknown. */
  attachments?: SpawnAttachments;
  /**
   * What starts a session that passed every check, with spawn's limits. The server makes one for the
   * spawn route and the supervisor's spawn_session (W115), so they share them. Default: a new one.
   */
  spawner?: SpawnRunner;
  /**
   * What resumes a listed session, with resume's checks and limits. The server makes one for the
   * resume route and the supervisor's resume_session (W127), so they share them. Default: a new one.
   */
  resumer?: ResumeRunner;
  /**
   * The model and effort for sessions and their sub-agents (W119): what spawn uses when the request
   * names none, and what resume uses, except for a session started with a profile, which resumes on
   * what it used (`launches`). Default: none, so no flags, as before W119. With
   * `profile`, spawn's request may name a work profile (W155); without it, any profile is unknown.
   */
  work?: Pick<WorkStore, 'choice'> & Partial<Pick<WorkStore, 'profile'>>;
  /**
   * Every short id and session id this pitwall started or resumed, for its run (W119's review): a
   * resume takes the defaults for sessions only for one of these, since #114 leaves sessions pitwall
   * didn't start alone. The server makes one for spawn, spawn_session and resume. Default: none, so
   * no resume takes the defaults.
   */
  started?: Pick<Set<string>, 'add' | 'has'>;
  /**
   * The settings each session pitwall started with a profile used (W155; Phil, 2026-11-09), kept on
   * disk: spawn records them, and resume reuses them for that session, over the defaults for sessions.
   * Default: none, so resume is as before.
   */
  launches?: Pick<SessionLaunches, 'record' | 'lookup' | 'resumed'>;
}

/** What spawn needs from the AttachmentStore. */
export type SpawnAttachments = Pick<AttachmentStore, 'lookup' | 'claim' | 'release' | 'markUsed'>;

export const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_CONCURRENT_SPAWNS = 1;
export const DEFAULT_SPAWN_RATE = { max: 5, windowMs: 60_000 } as const;
export const DEFAULT_MAX_CONCURRENT_COMMANDS = 4;

/** The largest spawn body accepted. A 16,384-character prompt is at most about 96 KiB of JSON. */
export const MAX_SPAWN_BODY_BYTES = 128 * 1024;
export const MAX_PROMPT_LENGTH = SPAWN_PROMPT_MAX;
export const MAX_CWD_LENGTH = 4096;

/**
 * The contract's name characters (letters, digits, space, `.`, `_`, `-`), at
 * most 64. It can't start with `-` or a space, so it never reads as an
 * option, and can't end with a space.
 */
export const NAME_PATTERN = /^[A-Za-z0-9._](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9._-])?$/;


/**
 * A short id that's safe to pass to `claude stop` and `claude rm`. The same
 * rule as the web UI's attach command: it can't start with `-`.
 */
export const SHORT_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

// Terminal escapes, then the remaining controls except tab and newline.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]/g;
const CONTROLS_BUT_NEWLINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** A request to start a session that passed every check. `cwd` is the realpath. */
export interface ValidSpawn {
  cwd: string;
  /** The user's own prompt, without the `@` lines spawnPrompt() adds. */
  prompt: string;
  name?: string;
  /** isWorkModel(), or WORK_DEFAULT for no `--model` whatever the defaults say (W119). */
  model?: string;
  /** isEffortLevel(), or WORK_DEFAULT for no `--effort`. */
  effort?: WorkChoice['effort'];
  /**
   * CLAUDE_CODE_SUBAGENT_MODEL for the session's sub-agents: the request's, else the profile's (W155),
   * else the defaults' (W119); WORK_DEFAULT for none.
   */
  subagentModel?: string;
  /** The work profile's name (W155), as the server's own profiles spell it. */
  profile?: string;
  /** The request's own model, effort or sub-agents' model isn't the profile's (New session's Customized, W155). */
  custom?: true;
  /** The profile's skill (W155), SKILL_NAME_PATTERN, from the server's profile, never the request: the prompt starts `/<skill> `. */
  skill?: string;
  /** The kept files for SpawnRequest.attachments, in its order. Absent for none. */
  attachments?: readonly AttachmentFile[];
}

export type SpawnValidation = { ok: true; spawn: ValidSpawn } | { ok: false; error: string };

/**
 * Checks a parsed body against the SpawnRequest rules. `roots` are the
 * snapshot's real-path roots. The directory is checked through its realpath,
 * so a symlink under a root that points outside it is refused. `attachments`
 * looks up SpawnRequest.attachments' ids; without it, any id is unknown.
 */
export async function validateSpawnRequest(
  body: unknown,
  roots: readonly string[],
  attachments?: Pick<SpawnAttachments, 'lookup'>,
  profiles?: (name: string) => WorkProfile | undefined,
): Promise<SpawnValidation> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return invalid('The body must be a JSON object.');
  const { cwd, prompt, name, model, effort, subagentModel, profile: profileName, attachments: ids } = body as Record<string, unknown>;

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
  // pitwall hides and refuses to message sessions by these names, so a new one can't take one (W120, W116's F3).
  if (typeof name === 'string' && OWN_NAMES.has(name.trim().toLowerCase())) return invalid(`The name ${name} is pitwall's own. Choose another.`);
  if (model !== undefined && model !== WORK_DEFAULT && !isWorkModel(model)) return invalid(`The model ${modelProblem('session')}.`);
  if (effort !== undefined && effort !== WORK_DEFAULT && !isEffortLevel(effort)) return invalid(`The effort ${EFFORT_PROBLEM}.`);
  // The sub-agents' model, as W119 checks one for sub-agents (W155; Phil, 2026-11-09). Not quoted back.
  if (subagentModel !== undefined && subagentModel !== WORK_DEFAULT && !isWorkModel(subagentModel, 'subagents')) {
    return invalid(`The sub-agents' model ${modelProblem('subagents')}.`);
  }
  // The profile by its exact name, from the server's own (W155): its skill comes from there, never
  // from the request. Not quoted back: it could be any text.
  let profile: WorkProfile | undefined;
  if (profileName !== undefined) {
    profile = typeof profileName === 'string' && profileName.length <= 64 ? profiles?.(profileName) : undefined;
    if (profile === undefined) return invalid("That profile isn't one pitwall has. Reopen New session to see the profiles now.");
  }
  if (ids !== undefined) {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return invalid('The attachments must be a list of attachment ids.');
    if (ids.length > ATTACHMENTS_MAX_PER_SESSION) return invalid(`A new session can have at most ${ATTACHMENTS_MAX_PER_SESSION} attachments.`);
    if (new Set(ids).size !== ids.length) return invalid('Each attachment can be used once.');
  }

  const dir = await checkDirectory(cwd, roots);
  if (!dir.ok) return dir;

  const spawn: ValidSpawn = { cwd: dir.path, prompt };
  if (name !== undefined) spawn.name = name as string;
  // The request's own model, effort and sub-agents' model, else the profile's; withSessionWork() fills
  // the rest from the defaults.
  const chosenModel = (model as string | undefined) ?? profile?.model;
  const chosenEffort = (effort as WorkChoice['effort'] | undefined) ?? profile?.effort;
  const chosenSubagents = (subagentModel as string | undefined) ?? profile?.subagentModel;
  if (chosenModel !== undefined) spawn.model = chosenModel;
  if (chosenEffort !== undefined) spawn.effort = chosenEffort;
  if (chosenSubagents !== undefined) spawn.subagentModel = chosenSubagents;
  if (profile !== undefined) {
    spawn.profile = profile.name;
    const differs = (sent: unknown, own: string | undefined) => sent !== undefined && sent !== own;
    if (differs(model, profile.model) || differs(effort, profile.effort) || differs(subagentModel, profile.subagentModel)) spawn.custom = true;
    if (profile.skill !== undefined) spawn.skill = profile.skill;
  }
  if (ids !== undefined && ids.length > 0) {
    const found = attachments ? await attachments.lookup(ids as string[]) : { ok: false as const, error: UNKNOWN_ATTACHMENT_ERROR };
    if (!found.ok) return invalid(found.error);
    spawn.attachments = found.files;
  }
  return { ok: true, spawn };
}

/**
 * Whether `cwd` is still a directory under one of `roots`, through its realpath, so a symlink that now
 * points outside them is refused. Spawn, resume and open in an editor all check with it, and run in
 * the `path` it returns, never in `cwd` itself; resume and open check a listed session's own directory
 * afresh, immediately before they run, since it may have gone, or changed, since the poll.
 *
 * Neither `cwd` nor its realpath may have a control or bidi character (hasUnsafeCharacters()): a
 * directory with one would read differently, in an error or in the trust hint's command, from the
 * one it names.
 */
export async function checkDirectory(cwd: unknown, roots: readonly string[]): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (typeof cwd !== 'string' || cwd === '') return invalid('The directory is required.');
  if (cwd.length > MAX_CWD_LENGTH) return invalid('The directory path is too long.');
  if (hasUnsafeCharacters(cwd)) return invalid('The directory path contains control characters or bidi controls.');
  if (!path.isAbsolute(cwd)) return invalid('The directory must be an absolute path.');
  let real: string;
  try {
    real = await realpath(cwd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return invalid(code === 'ENOENT' || code === 'ENOTDIR' ? `${cwd} doesn't exist.` : `${cwd} can't be read.`);
  }
  if (hasUnsafeCharacters(real)) return invalid(`${cwd} leads to a path with control characters or bidi controls.`);
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

/**
 * The arguments for `claude`. `--` ends the options, so a prompt that starts with `-` stays a prompt,
 * and the prompt is always the last argument. Each attachment's folder is `--add-dir=<dir>`, one
 * argument, never `--add-dir <dir>`, which would take the prompt as another directory (spike 008).
 */
export function spawnArgs(spawn: ValidSpawn): string[] {
  const args = ['--bg'];
  if (spawn.name !== undefined) args.push('--name', spawn.name);
  args.push(...workArgs({ ...(spawn.model === undefined ? {} : { model: spawn.model }), ...(spawn.effort === undefined ? {} : { effort: spawn.effort }) }));
  for (const file of spawn.attachments ?? []) args.push(`--add-dir=${file.dir}`);
  args.push('--', spawnPrompt(spawn));
  return args;
}

/**
 * The first prompt as `claude --bg` gets it: the profile's skill, `/<skill> `, when it has one (W155),
 * the user's, then, after a blank line, an `@<path>` line per attachment.
 */
export function spawnPrompt(spawn: Pick<ValidSpawn, 'prompt' | 'attachments' | 'skill'>): string {
  const prompt = withSkill(spawn.prompt, spawn.skill);
  const files = spawn.attachments ?? [];
  if (files.length === 0) return prompt;
  return `${prompt}\n\n${files.map((file) => `@${file.file}`).join('\n')}`;
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

/**
 * The arguments for resuming a session in the background: with no prompt, from the resume route; or
 * with the supervisor's message, after your approval (W127), as the last argument after `--`, so a
 * message that starts with `-` stays a message. Claude Code runs it as the resumed session's next
 * turn, under the same session id (spike 011).
 */
export function resumeArgs(sessionId: string, choice: WorkChoice = {}, prompt?: string): string[] {
  return ['--resume', sessionId, '--bg', ...workArgs(choice), ...(prompt === undefined ? [] : ['--', prompt])];
}

/**
 * `value` as one shell word that POSIX shells, such as zsh and bash, and fish read as written, or
 * undefined when there's none: as it is when it has only characters no shell treats specially,
 * otherwise in single quotes. A value with a `'` or `\` has none (W87). Inside single quotes POSIX
 * shells take every character as it is, but fish reads `\'` as a quote and `\\` as one backslash, so
 * POSIX's `'\''` for a `'` would end fish's word early and run the rest of the path as a command
 * there. Nor does one with a control or bidi character (hasUnsafeCharacters()), which checkDirectory()
 * already refuses. The web UI's resume command follows the same rule (shellWord() in web/src/sessions.ts).
 */
export function shellQuote(value: string): string | undefined {
  if (hasUnsafeCharacters(value)) return undefined;
  if (value !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  if (/['\\]/.test(value)) return undefined;
  return `'${value}'`;
}

/**
 * The command that trusts a workspace, for the user to run themselves: `cd <dir> && claude`, or
 * undefined when shellQuote() has no word for `dir`.
 */
export function trustHint(dir: string): string | undefined {
  const word = shellQuote(dir);
  return word === undefined ? undefined : `cd ${word} && claude`;
}

/**
 * Spawn and resume's 422 for a workspace Claude Code doesn't trust: its line as `error`, with the
 * command that trusts `dir` as `hint`, or with none when trustHint() has none. `error` stays Claude
 * Code's line alone: the page says in its own words why there's no command (W87).
 */
export function untrustedResult(line: string, dir: string): { ok: false; error: string; hint?: string } {
  const hint = trustHint(dir);
  return hint === undefined ? { ok: false, error: line } : { ok: false, error: line, hint };
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

/** Why a start was refused, with how many seconds to wait, for 429 and `Retry-After`. */
export type LimitRefusal = { ok: false; error: string; retryAfterSeconds: number };

/**
 * At most `rate.max` of something in any `rate.windowMs`, as a sliding window: the sessions pitwall
 * starts (SpawnLimiter, W81), and the directories it opens in an editor (editors.ts, W87).
 */
export class RateWindow {
  #at: number[] = [];

  constructor(
    readonly rate: { max: number; windowMs: number },
    private readonly now: () => number,
  ) {}

  /**
   * Counts one now, or, when `rate.max` were counted in the window, says how many whole seconds until
   * the oldest leaves it, at least 1. Synchronous, so two requests can't both pass between the check
   * and the count.
   */
  take(): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.now();
    this.#at = this.#at.filter((at) => now - at < this.rate.windowMs);
    if (this.#at.length >= this.rate.max) {
      const oldest = this.#at[0] as number;
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.rate.windowMs - now) / 1000)) };
    }
    this.#at.push(now);
    return { ok: true };
  }
}

/**
 * Counts the long-lived sessions pitwall starts, so a stuck UI can't fork-bomb them: at most `max`
 * spawns running at once, and `rate.max` sessions started per `rate.windowMs`, spawns and resumes
 * together (W81).
 */
export class SpawnLimiter {
  private running = 0;
  readonly #started: RateWindow;

  constructor(
    private readonly maxConcurrent: number,
    private readonly rate: { max: number; windowMs: number },
    now: () => number,
  ) {
    this.#started = new RateWindow(rate, now);
  }

  /**
   * Takes a spawn's slot, and counts it as a start, or says how many seconds to wait. Synchronous,
   * so two requests can't both pass between the check and the take.
   */
  acquire(): { ok: true; release: () => void } | LimitRefusal {
    if (this.running >= this.maxConcurrent) {
      return { ok: false, error: 'Another session is still starting. Try again in a moment.', retryAfterSeconds: 1 };
    }
    const start = this.countStart();
    if (!start.ok) return start;
    this.running += 1;
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

  /**
   * Counts a resume as a start, or says how many seconds to wait. Only the per-window limit applies:
   * a resume runs alongside spawns, under the stop, remove, resume and open commands' own limit
   * (CommandSlots). Synchronous, as acquire() is.
   */
  countStart(): { ok: true } | LimitRefusal {
    const taken = this.#started.take();
    if (taken.ok) return taken;
    const seconds = taken.retryAfterSeconds;
    return {
      ok: false,
      error: `pitwall starts at most ${this.rate.max} sessions every ${Math.round(this.rate.windowMs / 1000)} seconds, new and resumed together. Try again in ${seconds}s.`,
      retryAfterSeconds: seconds,
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

/** A start's answer: the SpawnResult, its status, and for 429 how many seconds to wait. */
export interface SpawnOutcome {
  status: 201 | 400 | 422 | 429 | 502 | 504;
  result: SpawnResult;
  retryAfterSeconds?: number;
}

/**
 * Starts sessions that passed every check (validateSpawnRequest()) with `claude --bg`, under spawn's
 * limits: the spawn route's, and the supervisor's spawn_session's after your approval (W115), which
 * share one SpawnLimiter.
 */
export interface SpawnRunner {
  start(spawn: ValidSpawn): Promise<SpawnOutcome>;
  /** The limit on sessions started, which resume counts against too. */
  readonly limiter: SpawnLimiter;
}

/**
 * `spawn` with the defaults for sessions where it names no model or effort, field by field, and the
 * sub-agents' model from the defaults (W119) where neither the request nor its profile names one (W155). The same object
 * without `work`.
 */
export function withSessionWork(spawn: ValidSpawn, work: Pick<WorkStore, 'choice'> | undefined): ValidSpawn {
  if (work === undefined) return spawn;
  const session = mergeChoices({ ...(spawn.model === undefined ? {} : { model: spawn.model }), ...(spawn.effort === undefined ? {} : { effort: spawn.effort }) }, work.choice('session'));
  if (spawn.subagentModel !== undefined) return { ...spawn, ...(session.model === undefined ? {} : { model: session.model }), ...(session.effort === undefined ? {} : { effort: session.effort }) };
  const subagents = work.choice('subagents').model;
  return {
    ...spawn,
    ...(session.model === undefined ? {} : { model: session.model }),
    ...(session.effort === undefined ? {} : { effort: session.effort }),
    ...(subagents === undefined || subagents === WORK_DEFAULT ? {} : { subagentModel: subagents }),
  };
}

/**
 * What a spawn with a profile used, as SessionLaunch keeps it (W155): each of the model, effort and
 * sub-agents' model, WORK_DEFAULT where it passed none, so a resume passes none either.
 */
export function launchOf(spawn: ValidSpawn): SessionLaunch {
  return {
    ...(spawn.profile === undefined ? {} : { profile: spawn.profile }),
    ...(spawn.custom === true ? { custom: true as const } : {}),
    model: spawn.model ?? WORK_DEFAULT,
    effort: spawn.effort ?? WORK_DEFAULT,
    subagentModel: spawn.subagentModel ?? WORK_DEFAULT,
  };
}

export function createSpawnRunner(options: Omit<ActionOptions, 'spawner'> = {}): SpawnRunner {
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
  const attachments = options.attachments;

  async function start(request: ValidSpawn): Promise<SpawnOutcome> {
    // The model and effort the request names, else the defaults for sessions, and the defaults for
    // their sub-agents (W119): for New session's dialog and the supervisor's spawn_session alike.
    const spawn = withSessionWork(request, options.work);
    // Checked again and taken, then the slot, with nothing that waits between: two spawns can't
    // both use one attachment, and one that can't be used doesn't count toward the rate limit.
    const ids = spawn.attachments?.map((file) => file.id) ?? [];
    if (ids.length > 0) {
      const claim = attachments?.claim(ids) ?? { ok: false as const, error: UNKNOWN_ATTACHMENT_ERROR };
      if (!claim.ok) return { status: 400, result: { ok: false, error: claim.error } };
    }
    const slot = limiter.acquire();
    if (!slot.ok) {
      if (ids.length > 0) attachments?.release(ids);
      return { status: 429, result: { ok: false, error: slot.error }, retryAfterSeconds: slot.retryAfterSeconds };
    }
    // Whether a session may have the files: used unless nothing started for certain.
    let settled: 'used' | 'released' = 'used';
    try {
      let result: CommandResult;
      try {
        // PWD is the directory it runs in, as for resume: a new session records where it started.
        // CLAUDE_CODE_SUBAGENT_MODEL for its sub-agents, and no inherited CLAUDE_CODE_EFFORT_LEVEL over its --effort (W119).
        // A profile's sub-agents' model is a default only: never CLAUDE_CODE_SUBAGENT_MODEL_FORCE (W155).
        const childEnv = withEffort(env(), spawn, spawn.subagentModel === undefined ? {} : { model: spawn.subagentModel });
        result = await run(claudeBin, spawnArgs(spawn), { cwd: spawn.cwd, env: { ...childEnv, PWD: spawn.cwd }, timeoutMs });
      } finally {
        slot.release();
      }

      if (result.kind === 'failed') {
        if (result.reason === 'timeout') {
          return { status: 504, result: { ok: false, error: `claude --bg ${result.message}. The session may still appear in the list.` } };
        }
        // Killed by a signal, it may have started a session first.
        if (result.reason !== 'signal') settled = 'released';
        return { status: 502, result: { ok: false, error: `Couldn't run claude: ${result.message}.` } };
      }
      if (result.code !== 0) {
        settled = 'released';
        const message = said(result);
        const untrusted = untrustedLine(message);
        if (untrusted !== undefined) return { status: 422, result: untrustedResult(untrusted, spawn.cwd) };
        return { status: 502, result: { ok: false, error: firstLine(message) ?? `claude --bg exited with code ${result.code}.` } };
      }
      const started = parseBackgrounded(result.stdout);
      if (!started) {
        const line = firstLine(result.stdout);
        return { status: 502, result: { ok: false, error: `Claude Code didn't report the new session's id${line ? `: ${line}` : '.'} It may still appear in the list.` } };
      }
      options.spawned?.add(started.shortId);
      options.started?.add(started.shortId);
      // With a profile, what it used, for a resume (W155). Never the skill: it runs once, as the first prompt's prefix.
      if (spawn.profile !== undefined) options.launches?.record(started.shortId, launchOf(spawn));
      return { status: 201, result: { ok: true, shortId: started.shortId, name: started.name ?? spawn.name ?? started.shortId } };
    } finally {
      if (ids.length > 0) {
        if (settled === 'used') await attachments?.markUsed(ids);
        else attachments?.release(ids);
      }
    }
  }

  return { start, limiter };
}

/** What resume answers, with its status, for the route and for the supervisor's resume_session (W127). */
export interface ResumeOutcome {
  status: 200 | 409 | 422 | 429 | 502 | 504;
  result: ResumeResult;
  retryAfterSeconds?: number;
  /**
   * Why it wasn't resumed, when that's that it's running: the fresh `claude agents` lists it, so a
   * resume would start a copy. The supervisor's resume_session says to message it instead (W127).
   */
  running?: true;
  /**
   * When the resume may have happened though it didn't answer ok (#131's review): 'copy', Claude Code
   * started a copy but its id wasn't one pitwall would act on; 'unknown', claude timed out or didn't
   * report an id. A prompt given may have gone, so the supervisor mustn't say it wasn't sent.
   */
  uncertain?: 'copy' | 'unknown';
}

/**
 * Brings a listed session back with `claude --resume <id> --bg`, after the checks the resume route
 * makes (W66, W81, W107): the route's, and the supervisor's resume_session's after your approval
 * (W127), which share one runner, so one resume of a session runs at a time, under the same command
 * slots and spawn's per-minute limit. With `prompt`, it's the resumed session's next turn, as the
 * last argument after `--` (spike 011): on its command line, as spawn's first prompt is. With
 * `launch`, a work profile's model, effort and sub-agents' model, as the supervisor's resume card showed
 * them and you approved (W156), in place of what it started with or the defaults, and kept for its
 * next resume; never the profile's skill.
 */
export interface ResumeRunner {
  resume(session: SessionSummary, prompt?: string, launch?: SessionLaunch): Promise<ResumeOutcome>;
}

/**
 * Why a listed session can't be resumed at all, or undefined when it can be tried: an interactive
 * session that has ended, or a background one that isn't running (W107), with a UUID for an id, since
 * `claude --resume` takes a name too, and a directory that still exists. The resume route and the
 * supervisor's resume_session (W127) both check with it, before the fresh listing.
 */
export function resumeProblem(session: SessionSummary): string | undefined {
  if (!isResumable(session) || !isSessionUuid(session.sessionId)) {
    return "Only an interactive session that has ended, or a background session that isn't running, can be resumed from pitwall.";
  }
  if (session.cwdMissing === true) return `It started in ${session.cwd}, which no longer exists, and Claude Code resumes a session only from where it started.`;
  return undefined;
}

/** A background session that isn't running, stopped or finished (W107): no process, not alive. */
function isStoppedJob(session: SessionSummary): boolean {
  return session.kind === 'background' && !session.alive && session.pid === undefined;
}

/** An ended interactive session, or a stopped background one. */
function isResumable(session: SessionSummary): boolean {
  return session.ended === true || isStoppedJob(session);
}

export function createResumeRunner(
  indexer: Pick<Indexer, 'latest' | 'pollSoon' | 'noteRestart'>,
  options: Omit<ActionOptions, 'resumer' | 'slots'> & { slots: CommandSlots; limiter: Pick<SpawnLimiter, 'countStart'> },
): ResumeRunner {
  const run = options.run ?? runCommand;
  const now = options.now ?? Date.now;
  const claudeBin = options.claudeBin ?? 'claude';
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const env = () => childEnvironment(options.env ?? process.env, options.token);
  const sessionWork = () => ({ session: options.work?.choice('session') ?? {}, subagents: options.work?.choice('subagents') ?? {} });
  const { slots, limiter } = options;
  const agents = options.agents ?? createAgentsSource({ claudeBin });
  // Session ids being resumed now: a second resume of one waits for the first's answer.
  const resuming = new Set<string>();

  async function resume(session: SessionSummary, prompt?: string, launch?: SessionLaunch): Promise<ResumeOutcome> {
    const answer = (result: ResumeResult, status: ResumeOutcome['status'], extra: Partial<ResumeOutcome> = {}): ResumeOutcome => ({ status, result, ...extra });
    // From the resolved summary, never a route parameter or a tool's input. A UUID only: `claude --resume` takes a name too.
    const { sessionId, cwd } = session;
    // A background session that isn't running, stopped or finished, comes back the same way, under
    // its own short id: Claude Code "woke session <id> with its saved options" (W107, checked live).
    const stoppedJob = isStoppedJob(session);
    const problem = resumeProblem(session);
    if (problem !== undefined) return answer({ ok: false, error: problem }, 409);
    // Whoever calls with a prompt, never a blank one or just a claude command's name, which
    // `claude --resume <id> --bg -- purge` could run instead (W129, the re-review's M1; claudeCommands.ts).
    if (prompt !== undefined && (prompt.trim() === '' || isClaudeCommand(prompt))) {
      return answer({ ok: false, error: "The message can't be blank or just the name of a claude command, which claude --resume could run instead." }, 422);
    }
    // A profile you approved on the supervisor's card (W156), with every field the card showed, checked
    // again here as a launch record is.
    const approved = launch === undefined ? undefined : launchWork(launch);
    if (launch !== undefined && approved === undefined) return answer({ ok: false, error: "The profile's settings didn't pass pitwall's checks, so it didn't resume the session." }, 422);
    if (resuming.has(sessionId)) return answer({ ok: false, error: 'pitwall is already resuming this session.' }, 409);
    const release = slots.acquire();
    if (!release) return answer({ ok: false, error: slots.busyError }, 429, { retryAfterSeconds: 1 });
    resuming.add(sessionId);
    try {
      // A session that's open in a terminal again gets an unnamed copy, and Claude Code still exits 0
      // (spike 006, finding 5), so it's checked first, and nothing runs when the check can't be made.
      // Its session id in any row counts, one parseAgentRows() skipped included (W81).
      const listing = await agents.list();
      if (!listing.ok) {
        return answer({ ok: false, error: `pitwall couldn't check that the session isn't running again, so it didn't resume it: ${listing.error}.` }, 502);
      }
      if (stoppedJob) {
        // Its own row is listed, as a background job's always is: it must still be one, with no process.
        const rows = listing.rows.filter((row) => row.sessionId === sessionId);
        if (sessionPids(listing, sessionId).size > 0 || rows.some((row) => row.kind !== 'background')) {
          indexer.pollSoon();
          return answer({ ok: false, error: "It's running again, so pitwall didn't resume it." }, 409, { running: true });
        }
        if (rows.length === 0) {
          indexer.pollSoon();
          return answer({ ok: false, error: 'Claude Code no longer lists it as a background session, so pitwall didn’t resume it.' }, 409);
        }
      } else if (listedSessionIds(listing).has(sessionId)) {
        indexer.pollSoon();
        return answer(
          { ok: false, error: "It's running again, in a terminal or in the background, so pitwall didn't resume it: that would start a copy." },
          409,
          { running: true },
        );
      }

      // Afresh, as spawn checks its directory, and only now, after the listing, which can take 10 s:
      // it may have gone, or been swapped for a symlink that leads elsewhere, since the poll (W73, W81).
      // Nothing that can wait comes between this check and the run.
      const dir = await checkDirectory(cwd, indexer.latest()?.roots ?? []);
      if (!dir.ok) return answer({ ok: false, error: dir.error }, 409);

      // It starts a long-lived session, so it counts toward spawn's per-minute limit, which it shares.
      const start = limiter.countStart();
      if (!start.ok) return answer({ ok: false, error: start.error }, 429, { retryAfterSeconds: start.retryAfterSeconds });

      // It runs in the realpath just checked, never the snapshot's path, so a symlink swapped after
      // the check can't move it. PWD is the snapshot's `cwd`, not pitwall's own, which
      // childEnvironment() passes on: Claude Code finds the session in the project folder of the
      // directory it started in, and a CLI that prefers PWD to the real cwd, to keep a symlinked path,
      // would otherwise look in pitwall's, or, given the realpath, in the realpath's, which isn't the
      // one a session started through a symlink is in. The check just resolved that `cwd` to
      // `dir.path`, so the two name the same directory; one that no longer resolves to a directory
      // under a root was refused with 409 above, rather than run with PWD set to the realpath.
      // The defaults for sessions and their sub-agents (W119), only for a session this pitwall started
      // or resumed (W119's review, #114's scope): one started elsewhere keeps the model and effort it
      // was started with, so no flags. Claude Code takes `--model` and `--effort` on a resume too.
      // A session pitwall started with a work profile resumes on what it used, kept on disk, checked
      // again as it's read: the profile's model, effort and sub-agents' model, never its skill (W155;
      // Phil, 2026-11-09). A field that didn't pass is the defaults'.
      // A profile you approved on the supervisor's card (W156) takes the place of both (approved, above).
      const kept = approved ?? options.launches?.lookup(session);
      const ours = kept !== undefined || options.started?.has(sessionId) === true || (session.shortId !== undefined && options.started?.has(session.shortId) === true);
      const defaults = ours ? sessionWork() : { session: {}, subagents: {} };
      const work = kept === undefined ? defaults : { session: mergeChoices(kept.session, defaults.session), subagents: mergeChoices(kept.subagents, defaults.subagents) };
      const result = await run(claudeBin, resumeArgs(sessionId, work.session, prompt), { cwd: dir.path, env: { ...withEffort(env(), work.session, work.subagents), PWD: cwd }, timeoutMs });
      if (result.kind === 'failed') {
        if (result.reason === 'timeout') {
          indexer.pollSoon();
          return answer({ ok: false, error: `claude --resume ${result.message}. The session may still appear in the list.` }, 504, { uncertain: 'unknown' });
        }
        return answer({ ok: false, error: `Couldn't run claude: ${result.message}.` }, 502);
      }
      if (result.code !== 0) {
        const message = said(result);
        const untrusted = untrustedLine(message);
        // The path PWD named, which checkDirectory() found free of control and bidi characters.
        if (untrusted !== undefined) return answer(untrustedResult(untrusted, cwd), 422);
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
        return answer(copied, 409, copy.shortId === undefined ? { uncertain: 'copy' } : {});
      }
      const resumed = parseBackgrounded(result.stdout);
      if (!resumed) {
        indexer.pollSoon();
        const line = firstLine(result.stdout);
        return answer(
          { ok: false, error: `Claude Code didn't report the resumed session's id${line ? `: ${line}` : '.'} It may still appear in the list.` },
          502,
          { uncertain: 'unknown' },
        );
      }
      options.spawned?.add(resumed.shortId);
      options.resumed?.add(sessionId);
      options.started?.add(sessionId);
      options.started?.add(resumed.shortId);
      if (kept !== undefined) options.launches?.resumed(session, resumed.shortId, approved?.launch);
      // You asked for it back, so it needs your prompt until you send one (NeedsYou's 'restarted', W69).
      // Polls soon. With a prompt it has one, its next turn, so it doesn't (W127).
      if (prompt === undefined) indexer.noteRestart(sessionId, now());
      else indexer.pollSoon();
      return answer({ ok: true, shortId: resumed.shortId }, 200);
    } finally {
      release();
      resuming.delete(sessionId);
    }
  }

  return { resume };
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
  const claudeBin = options.claudeBin ?? 'claude';
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const env = () => childEnvironment(options.env ?? process.env, options.token);
  // New sessions, from New session's dialog here and from the supervisor's spawn_session (W115): one limit for both.
  const spawner = options.spawner ?? createSpawnRunner(options);
  const limiter = spawner.limiter;

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

      const profiles = options.work?.profile;
      const validation = await validateSpawnRequest(body, snapshot.roots, options.attachments, profiles === undefined ? undefined : (name) => profiles(name));
      if (!validation.ok) return spawnResult(c, { ok: false, error: validation.error }, 400);
      const started = await spawner.start(validation.spawn);
      if (started.retryAfterSeconds !== undefined) c.header('Retry-After', String(started.retryAfterSeconds));
      return spawnResult(c, started.result, started.status);
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

  // Resume (W66, W107), and the supervisor's resume_session after your approval (W127): one runner.
  const resumer = options.resumer ?? createResumeRunner(indexer, { ...options, slots, limiter });

  app.post(RESUME_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store');
    const lookup = resolveSession(indexer, c.req.param('sessionId'));
    if (!lookup.ok) return c.json({ ok: false, error: LOOKUP_ERRORS[lookup.status] } satisfies ResumeResult, lookup.status);
    const outcome = await resumer.resume(lookup.session);
    if (outcome.retryAfterSeconds !== undefined) c.header('Retry-After', String(outcome.retryAfterSeconds));
    return c.json(outcome.result, outcome.status);
  });
}
