import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  /** Kill the process and reject after this many milliseconds. */
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Reject when stdout grows past this many bytes. Default 16 MiB. */
  maxStdoutBytes?: number;
}

/**
 * Runs a program without a shell and resolves with its stdout, or rejects with
 * a `RunError`. Injected into the agents source and the git grouping so tests
 * can replace it.
 */
export type RunFile = (file: string, args: readonly string[], options: RunOptions) => Promise<string>;

export type RunErrorReason = 'not-found' | 'timeout' | 'exit' | 'signal' | 'too-large' | 'spawn';

export class RunError extends Error {
  constructor(
    readonly reason: RunErrorReason,
    message: string,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = 'RunError';
  }
}

const DEFAULT_MAX_STDOUT = 16 * 1024 * 1024;

/**
 * The real `RunFile`. Equivalent to `execFile` without a shell, except that
 * stdin and stderr are `ignore`d at the file-descriptor level rather than
 * piped and discarded:
 *
 * - `claude agents --json` can start Claude Code's background service and
 *   print `Starting background service…` on stderr. If that long-lived service
 *   inherited a stderr pipe, `execFile` would wait for the pipe to close and
 *   the poll would never finish, even after the timeout killed the direct child.
 * - stdin is closed so a child that reads it sees EOF instead of waiting.
 *
 * On timeout the child gets SIGTERM (SIGKILL 2 seconds later if it's still
 * running) and the promise rejects straight away, without waiting for stdout
 * to close.
 */
export const runFile: RunFile = (file, args, options) =>
  new Promise<string>((resolve, reject) => {
    const maxBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
    let settled = false;
    const chunks: Buffer[] = [];
    let bytes = 0;

    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      windowsHide: true,
    });

    const finish = (error: RunError | undefined, stdout?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          // Don't leave a process behind on every poll if it ignores SIGTERM.
          const force = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          }, 2000);
          force.unref();
          child.once('exit', () => clearTimeout(force));
        }
        child.stdout?.destroy();
        reject(error);
      } else {
        resolve(stdout ?? '');
      }
    };

    const timer = setTimeout(() => {
      finish(new RunError('timeout', `timed out after ${formatSeconds(options.timeoutMs)}`));
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        finish(new RunError('too-large', `printed more than ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') finish(new RunError('not-found', `${file} was not found`));
      else finish(new RunError('spawn', oneLine(err.message)));
    });

    child.on('close', (code, signal) => {
      if (code === 0) finish(undefined, Buffer.concat(chunks).toString('utf8'));
      else if (code !== null) finish(new RunError('exit', `exited with code ${code}`, code));
      else finish(new RunError('signal', `was killed by ${signal ?? 'a signal'}`));
    });
  });

function formatSeconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

/** Collapses whitespace and caps the length, for one-line error messages. */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
