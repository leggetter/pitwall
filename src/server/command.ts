// Runs the `claude` commands behind spawn, stop and remove (W12).
//
// Like runFile (src/index/exec.ts) it never uses a shell, closes stdin and has
// a timeout. Unlike runFile it keeps stderr and the exit code, because that's
// where Claude Code says why it refused: `Workspace not trusted. ...`, or why
// `claude rm` kept a worktree.
//
// It resolves when the direct child exits, after a short wait for what it
// wrote, rather than when its pipes close. `claude --bg` can start Claude
// Code's background service, and a long-lived process that inherited the
// pipes would otherwise hold the request open (see runFile's comment). The
// service seen on Claude Code v2.1.301 points its stdio at /dev/null and a log
// file, so this is a guard, not a fix for something observed.
import { spawn } from 'node:child_process';

export interface CommandOptions {
  /** The working directory. Spawn uses the validated session directory; stop and remove use the temp directory. */
  cwd: string;
  /** The child's whole environment. Build it with childEnvironment(). */
  env: NodeJS.ProcessEnv;
  /** Kill the child and resolve with a 'timeout' failure after this many milliseconds. */
  timeoutMs: number;
}

export type CommandResult =
  /** The child exited with a code. `stdout` and `stderr` are each cut at MAX_OUTPUT_BYTES. */
  | { kind: 'exited'; code: number; stdout: string; stderr: string }
  /** It never ran, ran too long, or was killed by a signal. `message` is one line, for the UI. */
  | { kind: 'failed'; reason: 'not-found' | 'timeout' | 'signal' | 'spawn'; message: string };

/** Runs a program without a shell. Never rejects. Injected so tests never run `claude`. */
export type RunCommand = (file: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

/** How much of each stream is kept. Claude Code's answers are a line or a few. */
export const MAX_OUTPUT_BYTES = 64 * 1024;

/** How long to wait, after the child exits, for what it wrote to arrive. */
const DRAIN_MS = 500;

/** How long a child gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2000;

/**
 * The environment for a child: `env` without anything pitwall-specific.
 *
 * - `PITWALL_*`: the token (the CLI already deletes `PITWALL_TOKEN`, and this
 *   doesn't rely on that), the launch marker and anything added later. A
 *   session pitwall starts must not be able to drive pitwall.
 * - `npm_*` and `INIT_CWD`: set when pitwall runs through `npm start` or
 *   `npm run dev`. `npm_config_*` would otherwise act as npm configuration
 *   for every npm command the new session runs, in someone else's repo.
 */
export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^pitwall_/i.test(key) || /^npm_/i.test(key) || key === 'INIT_CWD') continue;
    result[key] = value;
  }
  return result;
}

/** The real RunCommand. */
export const runCommand: RunCommand = (file, args, options) =>
  new Promise<CommandResult>((resolve) => {
    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const stdout = collector();
    const stderr = collector();

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      // Thrown synchronously for arguments Node refuses, such as a NUL byte.
      resolve({ kind: 'failed', reason: 'spawn', message: oneLine((error as Error).message) });
      return;
    }

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(result);
    };

    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== null) finish({ kind: 'exited', code, stdout: stdout.text(), stderr: stderr.text() });
      else finish({ kind: 'failed', reason: 'signal', message: `was killed by ${signal ?? 'a signal'}` });
    };

    const timer = setTimeout(() => {
      terminate(child);
      finish({ kind: 'failed', reason: 'timeout', message: `didn't finish within ${formatSeconds(options.timeoutMs)}` });
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdout.add(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.add(chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') finish({ kind: 'failed', reason: 'not-found', message: `${file} was not found` });
      else finish({ kind: 'failed', reason: 'spawn', message: oneLine(error.message) });
    });

    // 'close' comes once the pipes have closed too, which is the usual case.
    child.on('close', exited);
    // If something the child started still holds a pipe, don't wait for it.
    child.on('exit', (code, signal) => {
      drainTimer = setTimeout(() => exited(code, signal), DRAIN_MS);
    });
  });

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, KILL_GRACE_MS);
  force.unref();
  child.once('exit', () => clearTimeout(force));
}

/** Keeps the first MAX_OUTPUT_BYTES of a stream and drops the rest. */
function collector() {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    add(chunk: Buffer) {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      const kept = chunk.subarray(0, MAX_OUTPUT_BYTES - bytes);
      chunks.push(kept);
      bytes += kept.length;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function formatSeconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}
