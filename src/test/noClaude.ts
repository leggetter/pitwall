// Refuses to run `claude` in a test without PITWALL_LIVE=1, so a plain
// `npm test` never starts Claude Code, whatever is on PATH (W31). Loaded
// before every server test file (vitest.config.ts).
//
// It wraps child_process's spawn, spawnSync, execFile, execFileSync, exec and
// execSync, and node-pty's spawn, for test code and the code under test alike.
// A call that would run `claude` throws, and the test that made it fails even
// when the code under test catches the error. That covers a test file's
// module level too: the file fails to load. With PITWALL_LIVE=1, as the live
// checks run, everything goes through as before.
//
// It can't see a process that a child process starts in turn: a test that
// runs a script which spawns claude must sit behind PITWALL_LIVE itself, as
// relay.live.test.ts does.
//
// It also refuses to open an editor (W72), with or without PITWALL_LIVE: no
// test, live or not, opens VS Code or Cursor. That's `code`, `cursor` or
// `code-insiders` by any path; macOS's `open` with a flag group that has `a` or
// `b` (`-a`, `-b`, `-na`, `-ga`), which names an app, as server/editors.ts runs
// it; `open` or `xdg-open` with a `vscode:`, `vscode-insiders:` or `cursor:` URL;
// and any of those behind `env`, after its options and assignments. A plain
// `open <file>`, the CLI's way to open the browser, still goes through.
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach } from 'vitest';

// The wrapped functions take anything.
type AnyFunction = (...args: any[]) => any;

/** Shared through globalThis, so a second copy of this module neither wraps twice nor keeps its own list. */
interface GuardState {
  installed: boolean;
  refusals: string[];
}

const STATE = Symbol.for('pitwall.noClaude');
const state: GuardState = ((globalThis as Record<symbol, GuardState | undefined>)[STATE] ??= { installed: false, refusals: [] });

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
/** `claude` as a command in a shell command line: on its own, or as the last part of a path. */
const CLAUDE_IN_COMMAND = /(?:^|[\s;&|()`'"/])claude(?=$|[\s;&|()`'"])/;
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

function isLive(): boolean {
  return process.env.PITWALL_LIVE === '1';
}

function isClaude(file: unknown): boolean {
  return typeof file === 'string' && path.basename(file) === 'claude';
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

/** For spawn, spawnSync, execFile and execFileSync: `(file, args?, options?)`. */
function fileRunsClaude([file, second, third]: unknown[]): boolean {
  if (typeof file !== 'string') return false;
  const args = Array.isArray(second) ? second.filter((arg): arg is string => typeof arg === 'string') : [];
  const options = Array.isArray(second) ? third : second;
  if (isRecord(options) && options.shell) return CLAUDE_IN_COMMAND.test([file, ...args].join(' '));
  if (isClaude(file)) return true;
  return SHELLS.has(path.basename(file)) && args.some((arg) => CLAUDE_IN_COMMAND.test(arg));
}

/** For exec and execSync: `(command, options?)`, always through a shell. */
function commandRunsClaude([command]: unknown[]): boolean {
  return typeof command === 'string' && CLAUDE_IN_COMMAND.test(command);
}

function refuse(api: string, what: 'claude' | 'editor'): never {
  const message =
    what === 'claude'
      ? `pitwall tests: ${api}() would run claude without PITWALL_LIVE=1. ` +
        'Pass a fake runner or spawner, or put the test behind PITWALL_LIVE like the live checks.'
      : `pitwall tests: ${api}() would open an editor. Pass a fake runFile and the editors found (ServerInternals.editors).`;
  state.refusals.push(message);
  throw new Error(message);
}

function guarded(
  api: string,
  original: AnyFunction,
  runsClaude: (args: unknown[]) => boolean,
  opensAnEditor: (args: unknown[]) => boolean = () => false,
): AnyFunction {
  return function (this: unknown, ...args: unknown[]) {
    if (!isLive() && runsClaude(args)) refuse(api, 'claude');
    if (opensAnEditor(args)) refuse(api, 'editor');
    return original.apply(this, args);
  };
}

function install(): void {
  const target = childProcess as unknown as Record<string, AnyFunction>;
  const apis: [string, (args: unknown[]) => boolean, (args: unknown[]) => boolean][] = [
    ['spawn', fileRunsClaude, fileOpensEditor],
    ['spawnSync', fileRunsClaude, fileOpensEditor],
    ['execFile', fileRunsClaude, fileOpensEditor],
    ['execFileSync', fileRunsClaude, fileOpensEditor],
    ['exec', commandRunsClaude, commandOpensEditor],
    ['execSync', commandRunsClaude, commandOpensEditor],
  ];
  for (const [api, runsClaude, opensAnEditor] of apis) {
    const original = target[api] as AnyFunction & { [promisify.custom]?: AnyFunction };
    const wrapped = guarded(api, original, runsClaude, opensAnEditor) as AnyFunction & { [promisify.custom]?: AnyFunction };
    // exec and execFile resolve to { stdout, stderr } when promisified, through their own custom form.
    const custom = original[promisify.custom];
    if (custom !== undefined) wrapped[promisify.custom] = guarded(api, custom, runsClaude, opensAnEditor);
    target[api] = wrapped;
  }
  // So `import { spawn } from 'node:child_process'` sees the wrapped functions too.
  syncBuiltinESMExports();

  try {
    const pty = createRequire(import.meta.url)('node-pty') as { spawn: AnyFunction };
    pty.spawn = guarded('node-pty spawn', pty.spawn, ([file]) => isClaude(file));
  } catch {
    // Without node-pty, nothing can start a PTY through it either.
  }
}

if (!state.installed) {
  install();
  state.installed = true;
}

/** Fails the test that made a refused call, even when the code under test caught the error. */
export function failOnRefusals(): void {
  const refused = takeRefusals();
  if (refused.length > 0) throw new Error(refused.join('\n'));
}

afterEach(failOnRefusals);
afterAll(failOnRefusals);
