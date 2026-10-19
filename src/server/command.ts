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
// That's deliberate (Phil, 2026-10-19): it's also how a user turns their
// customizations off, and passing it on fails safe, because a child then runs
// with fewer customizations (hooks, MCP servers, CLAUDE.md), never more.

/**
 * The environment for every process pitwall starts: spawn, stop and remove
 * (actions.ts), the attach PTY (attach.ts) and the relay (relay.ts). It's `env`
 * without the variables named above, and, when `token` is given, without any
 * variable whose value contains it, so a child can neither drive pitwall nor
 * pass for the Claude Code session pitwall runs inside. The CLI also deletes
 * token-valued variables from process.env when it starts, so a caller with no
 * token to pass, such as the relay, is covered too.
 */
export function childEnvironment(env: NodeJS.ProcessEnv, token?: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (DROPPED_PREFIXES.some((prefix) => upper.startsWith(prefix)) || DROPPED_NAMES.has(upper)) continue;
    // An empty token would match every value.
    if (token !== undefined && token !== '' && value.includes(token)) continue;
    result[name] = value;
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
