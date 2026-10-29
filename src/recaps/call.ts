// One recap call's process: `claude -p` with the input on stdin, no shell, a timeout, and a cap on
// what it may print. Tests pass a fake spawner, so no test runs `claude` (src/test/noClaude.ts).
import { spawn as spawnProcess } from 'node:child_process';

/** What the engine needs from a recap call's process. */
export interface RecapChild {
  readonly pid: number | undefined;
  /** Writes the input to its stdin and closes it. */
  send(input: string): void;
  /** Signals it, unless it has already exited. */
  kill(signal: NodeJS.Signals): void;
}

/** What the process reports. `exit` is called once, after `error` when it couldn't start. */
export interface RecapChildEvents {
  stdout(chunk: string): void;
  error(message: string): void;
  exit(code: number | null, signal: NodeJS.Signals | null): void;
}

/** Starts a recap call's process, without a shell. Tests pass a fake that answers as `claude -p` does. */
export type RecapSpawner = (file: string, args: string[], options: { cwd: string; env: Record<string, string> }, events: RecapChildEvents) => RecapChild;

/** How a call's process ended. */
export type CallOutcome =
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null; stdout: string }
  /** It couldn't start: `notFound` when the program wasn't found. */
  | { kind: 'spawn-error'; notFound: boolean }
  | { kind: 'timeout' }
  | { kind: 'too-large' }
  | { kind: 'stopped' };

/** The most a call may print. Its answer is one JSON object of about 2 KB (spike 010). */
export const MAX_STDOUT_CHARS = 1024 * 1024;

export interface CallOptions {
  claudeBin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  input: string;
  timeoutMs: number;
  spawn: RecapSpawner;
  /** Called with the child's pid as soon as it's known, before anything is written to it, so pitwall can hide it. */
  onPid(pid: number): void;
  /** Resolves when pitwall is closing: the call is stopped. */
  stopped: Promise<void>;
}

/** Runs one call. Never rejects. */
export function runRecapCall(options: CallOptions): Promise<CallOutcome> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let outcome: CallOutcome | undefined;
    let spawnError: { notFound: boolean } | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let child: RecapChild | undefined;
    const settle = (result: CallOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(result);
    };
    /** Stops the child, with SIGKILL if SIGTERM didn't do it in 2 seconds, and remembers why. */
    const stop = (why: CallOutcome) => {
      if (settled || outcome !== undefined) return;
      outcome = why;
      child?.kill('SIGTERM');
      killTimer = setTimeout(() => {
        child?.kill('SIGKILL');
        // A child that ignores both is left; pitwall stops waiting for it.
        settle(why);
      }, 2000);
    };
    const timer = setTimeout(() => stop({ kind: 'timeout' }), options.timeoutMs);
    void options.stopped.then(() => stop({ kind: 'stopped' }));
    try {
      child = options.spawn(options.claudeBin, options.args, { cwd: options.cwd, env: options.env }, {
        stdout(chunk) {
          if (outcome !== undefined) return;
          stdout += chunk;
          if (stdout.length > MAX_STDOUT_CHARS) {
            stdout = '';
            stop({ kind: 'too-large' });
          }
        },
        error(message) {
          spawnError = { notFound: message === 'not-found' };
        },
        exit(code, signal) {
          if (spawnError !== undefined && outcome === undefined) return settle({ kind: 'spawn-error', notFound: spawnError.notFound });
          settle(outcome ?? { kind: 'exit', code, signal, stdout });
        },
      });
    } catch {
      settle({ kind: 'spawn-error', notFound: false });
      return;
    }
    if (child.pid !== undefined) options.onPid(child.pid);
    if (!settled) child.send(options.input);
  });
}

/** The real RecapSpawner: a child process with piped stdio and no shell. stderr is read and dropped: it's never shown. */
export const spawnRecapChild: RecapSpawner = (file, args, options, events) => {
  const child = spawnProcess(file, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  let exited = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => events.stdout(chunk));
  child.stderr.on('data', () => undefined);
  // Writing after it exits raises EPIPE here; the exit is reported below.
  child.stdin.on('error', () => undefined);
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    events.exit(code, signal);
  };
  child.on('error', (error: NodeJS.ErrnoException) => {
    events.error(error.code === 'ENOENT' ? 'not-found' : 'spawn');
    // A process that never started emits no exit.
    if (child.pid === undefined) exit(null, null);
  });
  child.on('close', exit);
  return {
    get pid() {
      return child.pid;
    },
    send(input) {
      if (!child.stdin.destroyed && child.stdin.writable) child.stdin.end(input);
    },
    kill(signal) {
      if (!exited && child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
  };
};
