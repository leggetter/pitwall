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

function refuse(api: string): never {
  const message =
    `pitwall tests: ${api}() would run claude without PITWALL_LIVE=1. ` +
    'Pass a fake runner or spawner, or put the test behind PITWALL_LIVE like the live checks.';
  state.refusals.push(message);
  throw new Error(message);
}

function guarded(api: string, original: AnyFunction, runsClaude: (args: unknown[]) => boolean): AnyFunction {
  return function (this: unknown, ...args: unknown[]) {
    if (!isLive() && runsClaude(args)) refuse(api);
    return original.apply(this, args);
  };
}

function install(): void {
  const target = childProcess as unknown as Record<string, AnyFunction>;
  const apis: [string, (args: unknown[]) => boolean][] = [
    ['spawn', fileRunsClaude],
    ['spawnSync', fileRunsClaude],
    ['execFile', fileRunsClaude],
    ['execFileSync', fileRunsClaude],
    ['exec', commandRunsClaude],
    ['execSync', commandRunsClaude],
  ];
  for (const [api, runsClaude] of apis) {
    const original = target[api] as AnyFunction & { [promisify.custom]?: AnyFunction };
    const wrapped = guarded(api, original, runsClaude) as AnyFunction & { [promisify.custom]?: AnyFunction };
    // exec and execFile resolve to { stdout, stderr } when promisified, through their own custom form.
    const custom = original[promisify.custom];
    if (custom !== undefined) wrapped[promisify.custom] = guarded(api, custom, runsClaude);
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
