import { spawn } from 'node:child_process';
import path from 'node:path';

export interface RunOptions {
  cwd?: string;
  /** Kill the process and reject after this many milliseconds. */
  timeoutMs: number;
  /** What the child's environment is made from, before childEnvironment() scrubs it. Default process.env. */
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
 * Prefixes of variables a child never gets, compared without regard to case.
 *
 * - `PITWALL_`: the token (the CLI already deletes `PITWALL_TOKEN`, and this
 *   doesn't rely on that), the launch marker and anything added later. A
 *   session pitwall starts must not be able to drive pitwall.
 * - `npm_`: set when pitwall runs through `npm start` or `npm run dev`.
 *   `npm_config_*` would otherwise act as npm configuration for every npm
 *   command the new session runs, in someone else's repo.
 * - `CLAUDE_CODE_MESSAGING_`: the inbox credentials of the Claude Code session
 *   pitwall runs inside, if it does (W10).
 */
const DROPPED_PREFIXES = ['PITWALL_', 'NPM_', 'CLAUDE_CODE_MESSAGING_'] as const;

/**
 * Variables a child never gets, by exact name, compared without regard to
 * case. When pitwall runs inside a Claude Code session, as it does under an
 * agent, that session's identity would otherwise reach every process pitwall
 * starts. `CLAUDE_CODE_CHILD_SESSION` marks a nested session, which Claude
 * Code leaves out of `--resume`, `--continue`, history and `claude agents`, so
 * a session pitwall spawned could go missing from pitwall's own list.
 */
const DROPPED_NAMES: ReadonlySet<string> = new Set([
  // npm's, as for `npm_*` above.
  'INIT_CWD',
  // The identity of the Claude Code session pitwall runs inside.
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_JOB_DIR',
  'AI_AGENT',
  // That session's trace context, so a child doesn't join its trace.
  'TRACEPARENT',
  'TRACESTATE',
]);

// Kept, because they're the user's own configuration rather than a session's
// identity, and nothing above matches them: ANTHROPIC_*, CLAUDE_CODE_USE_*,
// CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_EFFORT_LEVEL and
// CLAUDE_CODE_SAFE_MODE. `claude --safe-mode` sets CLAUDE_CODE_SAFE_MODE in
// the session it starts, so pitwall run from such a session passes it on.
// That's deliberate (coordinator's decision, 2026-10-19): it's also how a
// user turns their customizations off, and passing it on fails safe, because
// a child then runs with fewer customizations (hooks, MCP servers,
// CLAUDE.md), never more.

/**
 * PATH with only its absolute directories, in their order, or undefined when
 * none is left (W96's finding, W98). An empty entry (`a::b`, or a leading or
 * trailing `:`), a relative one (`.`, `bin`, a `~/bin` no shell expanded) and
 * an empty PATH all make a bare command, such as `claude`, `gh` or `git`,
 * resolve in the child's working directory: Node's spawn and node-pty's execvp
 * search PATH as the shell does. pitwall runs gh from the temp directory,
 * which on Linux every local user can write to, so another user could plant
 * `/tmp/gh` there. A PATH with nothing left is left out rather than set
 * empty: without one, the child searches the system's default, `/usr/bin:/bin`
 * on macOS, never the working directory.
 */
export function absoluteSearchPath(value: string): string | undefined {
  const kept = value.split(path.delimiter).filter((entry) => path.isAbsolute(entry));
  return kept.length > 0 ? kept.join(path.delimiter) : undefined;
}

/**
 * The environment for every process pitwall starts: the index's `claude
 * agents`, `git` and `ps` (runFile, below), the PR poller's `gh`
 * (prs/fetch.ts, through runFile), End session's `/bin/ps`
 * (server/processes.ts), spawn, stop, remove and resume (server/actions.ts),
 * the attach PTY (server/attach.ts), the relay and its `claude --version`
 * (server/relay.ts), the editors (server/editors.ts) and the CLI's browser
 * opener (cli.ts). It's `env` without the variables named above, and, when
 * `token` is given, without any variable whose value contains it, so a child
 * can neither drive pitwall nor pass for the Claude Code session pitwall runs
 * inside; and with PATH cut to its absolute directories (absoluteSearchPath()),
 * so no bare command is found in the child's working directory. The CLI also
 * deletes token-valued variables from process.env when it starts, so a caller
 * with no token to pass, such as runFile or the relay, is covered too.
 * server/command.ts re-exports it.
 */
export function childEnvironment(env: NodeJS.ProcessEnv, token?: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (DROPPED_PREFIXES.some((prefix) => upper.startsWith(prefix)) || DROPPED_NAMES.has(upper)) continue;
    // An empty token would match every value.
    if (token !== undefined && token !== '' && value.includes(token)) continue;
    // The search path: `PATH` exactly, as libuv and execvp read it, but any case on Windows, whose names have none.
    if (process.platform === 'win32' ? upper === 'PATH' : name === 'PATH') {
      const searchPath = absoluteSearchPath(value);
      if (searchPath !== undefined) result[name] = searchPath;
      continue;
    }
    result[name] = value;
  }
  return result;
}

/**
 * The real `RunFile`. Equivalent to `execFile` without a shell, with the
 * environment scrubbed by childEnvironment(), except that stdin and stderr
 * are `ignore`d at the file-descriptor level rather than piped and discarded:
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
      // Without the identity of a Claude Code session pitwall may run inside.
      env: childEnvironment(options.env ?? process.env),
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
