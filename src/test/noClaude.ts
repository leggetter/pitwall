// Refuses to run `claude` in a test without PITWALL_LIVE=1, so a plain
// `npm test` never starts Claude Code, whatever is on PATH (W31). Loaded
// before every server test file (vitest.config.ts).
//
// It refuses `gh` the same way (M4, W93), so no test reaches GitHub with the
// user's own login: the PR poller runs `gh api graphql`, and a test that left
// the real runFile in place would run it.
//
// It wraps child_process's spawn, spawnSync, execFile, execFileSync, exec and
// execSync, and node-pty's spawn, for test code and the code under test alike.
// A call that would run `claude` or `gh` throws, and the test that made it
// fails even when the code under test catches the error. That covers a test
// file's module level too: the file fails to load. With PITWALL_LIVE=1, as the
// live checks run, everything goes through as before.
//
// It can't see a process that a child process starts in turn: a test that
// runs a script which spawns claude must sit behind PITWALL_LIVE itself, as
// relay.live.test.ts does.
//
// For gh there's a second layer, which can (W93's review). Without
// PITWALL_LIVE=1, a gh that refuses goes first on this process's PATH, so any
// process a test starts, at any depth, that runs `gh` by name finds it, unless
// the test deliberately puts its own fake first, as cli.test.ts does for the
// CLI it runs. It writes down each call and exits 1, and the test, or the file,
// fails if it was reached. For a gh found some other way, by an absolute path
// or on a PATH that leaves the stand-in out, GH_CONFIG_DIR points at an empty
// folder, and GH_TOKEN and GH_ENTERPRISE_TOKEN hold a placeholder that is no
// login, with GITHUB_TOKEN and GITHUB_ENTERPRISE_TOKEN removed. The empty folder
// alone isn't enough (W96, W98): with no hosts in its config, gh 2.100 still
// falls back to a token in the macOS keychain, the item `gh:github.com` with an
// empty account, as W96 found on a Mac that has one. A token in the
// environment wins over the config and the keychain (gh's
// internal/config/config.go, AuthConfig.ActiveToken()), so that gh asks
// GitHub, if it asks at all, with the placeholder, and is refused.
//
// It also refuses to open an editor (W72), with or without PITWALL_LIVE: no
// test, live or not, opens VS Code or Cursor. That's `code`, `cursor` or
// `code-insiders` by any path; macOS's `open` with a flag group that has `a` or
// `b` (`-a`, `-b`, `-na`, `-ga`), which names an app, as server/editors.ts runs
// it; `open` or `xdg-open` with a `vscode:`, `vscode-insiders:` or `cursor:` URL;
// and any of those behind `env`, after its options and assignments. A plain
// `open <file>`, the CLI's way to open the browser, still goes through.
//
// And it refuses process.kill() with any signal but 0, to any pid but those of
// the children the wrapped APIs started and that are still running, without
// PITWALL_LIVE (W90, and its review): End session's default signaller is
// process.kill, so a test that left it in place would signal whatever real
// process had the made-up pid. Every other signal counts, not only the ones
// that end a session: '', null, false and NaN all send SIGTERM, and SIGQUIT,
// SIGUSR1 and most others end a process too. A test that must clean up a
// process its own child started, which the wrapper never saw, names it with
// allowSignalsTo(). The test's own pid isn't one of its children, so it's
// refused too. Signal 0 only asks whether a process is there.
import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach } from 'vitest';

// The wrapped functions take anything.
type AnyFunction = (...args: any[]) => any;

/** Shared through globalThis, so a second copy of this module neither wraps twice nor keeps its own list. */
interface GuardState {
  installed: boolean;
  refusals: string[];
  /** The pids of the children the wrapped APIs started, while they run: the only ones a test may signal. */
  spawned: Set<number>;
  /** Pids a test said it may signal (allowSignalsTo()), such as a process its own child started. */
  allowed: Set<number>;
  /** The refusing gh first on PATH: its folder, and the file it writes each call to. Absent with PITWALL_LIVE=1. */
  ghStandIn?: { bin: string; calls: string };
}

const STATE = Symbol.for('pitwall.noClaude');
const state: GuardState = ((globalThis as Record<symbol, GuardState | undefined>)[STATE] ??= { installed: false, refusals: [], spawned: new Set(), allowed: new Set() });
state.spawned ??= new Set();
state.allowed ??= new Set();

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
/** The programs a test may run only with PITWALL_LIVE=1. */
type LiveOnly = 'claude' | 'gh';
const LIVE_ONLY: ReadonlySet<string> = new Set<LiveOnly>(['claude', 'gh']);
/** `claude` or `gh` as a command in a shell command line: on its own, or as the last part of a path. */
const LIVE_ONLY_IN_COMMAND = /(?:^|[\s;&|()`'"/])(claude|gh)(?=$|[\s;&|()`'"])/;
/** The editors' commands (W72). */
const EDITORS = new Set(['code', 'cursor', 'code-insiders']);
/** A short-flag group of `open`'s that names an app: `-a`, `-b`, or one with either in it, such as `-na`. Not `--args`. */
const APP_FLAGS = /^-[A-Za-z]*[ab][A-Za-z]*$/;
/** A URL an editor registers for, which `open` or `xdg-open` hands to it. */
const EDITOR_URL = /^(?:vscode|vscode-insiders|cursor):/i;
/** In a shell command line: an editor's command, `open` with a flag group that names an app, or an editor's URL. */
const EDITOR_IN_COMMAND =
  /(?:(?:^|[\s;&|()`'"/])(?:code|cursor|code-insiders|open\s+(?:\S+\s+)*-[A-Za-z]*[ab][A-Za-z]*)(?=$|[\s;&|()`'"]))|(?:(?:^|[\s;&|()`'"=])(?:vscode|vscode-insiders|cursor):)/i;
/** env's options that take a value as the next argument. */
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-P', '-C', '--chdir']);

/** The refusals since the last call, which the guard's own tests use. */
export function takeRefusals(): string[] {
  return state.refusals.splice(0);
}

/**
 * Lets a test signal `pid`, which the wrapper didn't see started, such as a process its own child
 * started: say so where the test cleans it up. For this test file's worker, until it ends.
 */
export function allowSignalsTo(pid: number): void {
  state.allowed.add(pid);
}

/** Notes a child the wrapped APIs started, and forgets it once it has exited, so a reused pid is never taken for it. */
function remember(result: unknown): void {
  // promisify(exec) and promisify(execFile) return a promise with the child as `child`.
  const child = isRecord(result) && isRecord(result.child) && typeof result.then === 'function' ? result.child : result;
  if (!isRecord(child) || typeof child.pid !== 'number') return;
  const pid = child.pid;
  if (typeof child.once === 'function') {
    state.spawned.add(pid);
    (child.once as (event: string, listener: () => void) => void).call(child, 'exit', () => state.spawned.delete(pid));
  } else if (typeof child.onExit === 'function') {
    // node-pty's IPty.
    state.spawned.add(pid);
    (child.onExit as (listener: () => void) => void).call(child, () => state.spawned.delete(pid));
  }
}

function isLive(): boolean {
  return process.env.PITWALL_LIVE === '1';
}

/** `claude` or `gh`, by any path, when `file` is one. */
function liveOnly(file: unknown): LiveOnly | undefined {
  if (typeof file !== 'string') return undefined;
  const name = path.basename(file);
  return LIVE_ONLY.has(name) ? (name as LiveOnly) : undefined;
}

/** The first live-only program named as a command in a shell command line. */
function liveOnlyInCommand(command: string): LiveOnly | undefined {
  return LIVE_ONLY_IN_COMMAND.exec(command)?.[1] as LiveOnly | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether running `file` with `args`, without a shell, opens an editor: its command; `open` with a
 * flag group that names an app; `open` or `xdg-open` with an editor's URL; or any of those behind env.
 */
function opensEditor(file: string, args: readonly string[], depth = 0): boolean {
  const name = path.basename(file);
  if (EDITORS.has(name)) return true;
  if ((name === 'open' || name === 'xdg-open') && args.some((arg) => EDITOR_URL.test(arg))) return true;
  if (name === 'open' && args.some((arg) => APP_FLAGS.test(arg))) return true;
  return name === 'env' && depth < 4 && envOpensEditor(args, depth + 1);
}

/** Whether env, with these arguments, runs something that opens an editor: the command after its options and NAME=value assignments. */
function envOpensEditor(args: readonly string[], depth: number): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--') return i + 1 < args.length && opensEditor(args[i + 1] as string, args.slice(i + 2), depth);
    // -S splits its string into words, which env then reads as more of its own arguments.
    if (arg === '-S' || arg === '--split-string') return envOpensEditor([...(args[i + 1] ?? '').split(/\s+/).filter(Boolean), ...args.slice(i + 2)], depth);
    if (arg.startsWith('-S')) return envOpensEditor([...arg.slice(2).split(/\s+/).filter(Boolean), ...args.slice(i + 1)], depth);
    if (arg.startsWith('--split-string=')) return envOpensEditor([...arg.slice(15).split(/\s+/).filter(Boolean), ...args.slice(i + 1)], depth);
    if (ENV_VALUE_OPTIONS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-') || /^[^=]+=/.test(arg)) continue;
    return opensEditor(arg, args.slice(i + 1), depth);
  }
  return false;
}

/** For spawn, spawnSync, execFile and execFileSync: `(file, args?, options?)`. Any time, PITWALL_LIVE or not. */
function fileOpensEditor([file, second, third]: unknown[]): boolean {
  if (typeof file !== 'string') return false;
  const args = Array.isArray(second) ? second.filter((arg): arg is string => typeof arg === 'string') : [];
  const options = Array.isArray(second) ? third : second;
  if (isRecord(options) && options.shell) return EDITOR_IN_COMMAND.test([file, ...args].join(' '));
  if (opensEditor(file, args)) return true;
  return SHELLS.has(path.basename(file)) && args.some((arg) => EDITOR_IN_COMMAND.test(arg));
}

/** For exec and execSync. */
function commandOpensEditor([command]: unknown[]): boolean {
  return typeof command === 'string' && EDITOR_IN_COMMAND.test(command);
}

/** For spawn, spawnSync, execFile and execFileSync: `(file, args?, options?)`. Which live-only program it runs, if one. */
function fileRunsLiveOnly([file, second, third]: unknown[]): LiveOnly | undefined {
  if (typeof file !== 'string') return undefined;
  const args = Array.isArray(second) ? second.filter((arg): arg is string => typeof arg === 'string') : [];
  const options = Array.isArray(second) ? third : second;
  if (isRecord(options) && options.shell) return liveOnlyInCommand([file, ...args].join(' '));
  const direct = liveOnly(file);
  if (direct !== undefined) return direct;
  if (!SHELLS.has(path.basename(file))) return undefined;
  for (const arg of args) {
    const found = liveOnlyInCommand(arg);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** For exec and execSync: `(command, options?)`, always through a shell. */
function commandRunsLiveOnly([command]: unknown[]): LiveOnly | undefined {
  return typeof command === 'string' ? liveOnlyInCommand(command) : undefined;
}

const REFUSALS: Readonly<Record<LiveOnly | 'editor' | 'signal', (api: string) => string>> = {
  claude: (api) =>
    `pitwall tests: ${api}() would run claude without PITWALL_LIVE=1. ` +
    'Pass a fake runner or spawner, or put the test behind PITWALL_LIVE like the live checks.',
  gh: (api) =>
    `pitwall tests: ${api}() would run gh without PITWALL_LIVE=1. ` +
    "Pass a fake fetch or runFile (createPrPoller()'s options), or leave ServerOptions.prs out, which is off.",
  editor: (api) => `pitwall tests: ${api}() would open an editor. Pass a fake runFile and the editors found (ServerInternals.editors).`,
  signal: (api) =>
    `pitwall tests: ${api}() would signal a process this test didn't start without PITWALL_LIVE=1. Pass a fake signaller (ServerInternals.end), or name a process your child started with allowSignalsTo().`,
};

function refuse(api: string, what: LiveOnly | 'editor' | 'signal'): never {
  const message = REFUSALS[what](api);
  state.refusals.push(message);
  throw new Error(message);
}

function guarded(
  api: string,
  original: AnyFunction,
  runsLiveOnly: (args: unknown[]) => LiveOnly | undefined,
  opensAnEditor: (args: unknown[]) => boolean = () => false,
  remembers = false,
): AnyFunction {
  return function (this: unknown, ...args: unknown[]) {
    if (!isLive()) {
      const program = runsLiveOnly(args);
      if (program !== undefined) refuse(api, program);
    }
    if (opensAnEditor(args)) refuse(api, 'editor');
    const result = original.apply(this, args);
    // A running child, which a test may signal: not spawnSync's or execSync's, which have exited by now.
    if (remembers) remember(result);
    return result;
  };
}

function install(): void {
  const target = childProcess as unknown as Record<string, AnyFunction>;
  const apis: [string, (args: unknown[]) => LiveOnly | undefined, (args: unknown[]) => boolean][] = [
    ['spawn', fileRunsLiveOnly, fileOpensEditor],
    ['spawnSync', fileRunsLiveOnly, fileOpensEditor],
    ['execFile', fileRunsLiveOnly, fileOpensEditor],
    ['execFileSync', fileRunsLiveOnly, fileOpensEditor],
    ['exec', commandRunsLiveOnly, commandOpensEditor],
    ['execSync', commandRunsLiveOnly, commandOpensEditor],
  ];
  for (const [api, runsLiveOnly, opensAnEditor] of apis) {
    const original = target[api] as AnyFunction & { [promisify.custom]?: AnyFunction };
    const remembers = api === 'spawn' || api === 'execFile' || api === 'exec';
    const wrapped = guarded(api, original, runsLiveOnly, opensAnEditor, remembers) as AnyFunction & { [promisify.custom]?: AnyFunction };
    // exec and execFile resolve to { stdout, stderr } when promisified, through their own custom form.
    const custom = original[promisify.custom];
    if (custom !== undefined) wrapped[promisify.custom] = guarded(api, custom, runsLiveOnly, opensAnEditor, remembers);
    target[api] = wrapped;
  }
  // So `import { spawn } from 'node:child_process'` sees the wrapped functions too.
  syncBuiltinESMExports();

  // End session's signal (W90): only signal 0, or a child the wrapped APIs started and that's still running.
  const kill = process.kill.bind(process);
  process.kill = function (pid: number, signal?: string | number) {
    if (!isLive() && signal !== 0 && !state.spawned.has(pid) && !state.allowed.has(pid)) refuse('process.kill', 'signal');
    return kill(pid, signal);
  } as typeof process.kill;

  try {
    const pty = createRequire(import.meta.url)('node-pty') as { spawn: AnyFunction };
    pty.spawn = guarded('node-pty spawn', pty.spawn, ([file]) => liveOnly(file), undefined, true);
  } catch {
    // Without node-pty, nothing can start a PTY through it either.
  }
}

/** Variables that would give gh a login without its config folder. */
const GH_TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const;

/**
 * What GH_TOKEN and GH_ENTERPRISE_TOKEN hold without PITWALL_LIVE=1: not a token GitHub knows.
 * go-gh, which gh reads its token through, takes GH_TOKEN, then GITHUB_TOKEN, for github.com,
 * `*.ghe.com` and `github.localhost`, and GH_ENTERPRISE_TOKEN, then GITHUB_ENTERPRISE_TOKEN, only for
 * any other host, an Enterprise Server's; either pair before its config and the keychain. So a gh
 * run some other way than through the stand-in has no login for any host.
 */
export const GH_NO_LOGIN = 'pitwall-test-no-login';

/** A single-quoted shell word, for a path written into the stand-in. */
function shellQuoted(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The second layer for gh: a refusing gh first on PATH, an empty GH_CONFIG_DIR, and GH_NO_LOGIN
 * as the only token in the environment, for every process this test process starts. The folder is
 * removed when the process exits.
 */
function installGhStandIn(): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-gh-guard-'));
  const bin = path.join(dir, 'bin');
  const config = path.join(dir, 'gh-config');
  const calls = path.join(dir, 'gh-calls');
  mkdirSync(bin);
  mkdirSync(config);
  writeFileSync(calls, '');
  writeFileSync(
    path.join(bin, 'gh'),
    [
      '#!/bin/sh',
      "# pitwall's test guard (src/test/noClaude.ts): a process a test started ran gh without PITWALL_LIVE=1.",
      `printf 'gh %s %s (pid %s, parent %s)\\n' "$1" "$2" "$$" "$PPID" >> ${shellQuoted(calls)}`,
      "echo 'pitwall tests: gh was run without PITWALL_LIVE=1. Put a fake gh first on its PATH, as cli.test.ts does.' >&2",
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  process.env.GH_CONFIG_DIR = config;
  for (const name of GH_TOKEN_VARIABLES) delete process.env[name];
  // Not only removed: without one, gh would use a login from the macOS keychain.
  process.env.GH_TOKEN = GH_NO_LOGIN;
  process.env.GH_ENTERPRISE_TOKEN = GH_NO_LOGIN;
  state.ghStandIn = { bin, calls };
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
}

if (!state.installed) {
  install();
  if (!isLive()) installGhStandIn();
  state.installed = true;
}

/** Where the refusing gh is, for the guard's own tests. Undefined with PITWALL_LIVE=1. */
export function ghStandIn(): { bin: string; calls: string } | undefined {
  return state.ghStandIn;
}

/** The calls the refusing gh has written down since the last call, which the guard's own tests use. */
export function takeGhCalls(): string[] {
  const standIn = state.ghStandIn;
  if (standIn === undefined) return [];
  let text = '';
  try {
    text = readFileSync(standIn.calls, 'utf8');
    writeFileSync(standIn.calls, '');
  } catch {
    // Removed at exit.
  }
  return text.split('\n').filter(Boolean);
}

/** Fails the test, or the file, in which a process a test started reached the refusing gh. */
export function failOnGhCalls(): void {
  const calls = takeGhCalls();
  if (calls.length > 0) {
    throw new Error(
      `pitwall tests: a process a test started ran gh without PITWALL_LIVE=1, ${calls.length} ${calls.length === 1 ? 'time' : 'times'}. ` +
        `Put a fake gh first on its PATH, as cli.test.ts does.\n${calls.join('\n')}`,
    );
  }
}

/** Fails the test that made a refused call, even when the code under test caught the error. */
export function failOnRefusals(): void {
  const refused = takeRefusals();
  if (refused.length > 0) throw new Error(refused.join('\n'));
}

afterEach(failOnRefusals);
afterAll(failOnRefusals);
afterEach(failOnGhCalls);
afterAll(failOnGhCalls);
