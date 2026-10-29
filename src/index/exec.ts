import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export interface RunOptions {
  cwd?: string;
  /** Kill the process and reject after this many milliseconds. */
  timeoutMs: number;
  /** What the child's environment is made from, before childEnvironment() scrubs it. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Reject when stdout grows past this many bytes. Default 16 MiB. */
  maxStdoutBytes?: number;
  /**
   * POSIX: start the child in a session and process group of its own (spawn's `detached`, which calls
   * setsid), so it has no controlling terminal and nothing it starts can prompt in the one pitwall
   * runs in, as ssh would for a passphrase; and a failure, the timeout's included, signals the whole
   * group, so what it started, such as gh's `git clone`, stops with it (W107). Ignored on Windows.
   */
  processGroup?: boolean;
  /**
   * Stops the child, with `processGroup` its whole group, with SIGTERM, then SIGKILL 2 s later to
   * whatever of it is still there, and rejects with reason 'aborted' once it has exited and, with
   * `processGroup`, nothing in its group is left, or 2.5 s after the SIGTERM at most, so a caller can
   * then remove what it wrote: a clone when the server closes (W107, W108's finding). Already
   * aborted, nothing runs.
   */
  signal?: AbortSignal;
}

/**
 * Runs a program without a shell and resolves with its stdout, or rejects with
 * a `RunError`. Injected into the agents source and the git grouping so tests
 * can replace it.
 */
export type RunFile = (file: string, args: readonly string[], options: RunOptions) => Promise<string>;

export type RunErrorReason = 'not-found' | 'timeout' | 'exit' | 'signal' | 'too-large' | 'spawn' | 'aborted';

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
 * What a child's PATH is when none of its entries is absolute: what libuv
 * searches on macOS with no PATH at all (`_PATH_DEFPATH`), the same two
 * directories glibc's execvp searches, `/bin` first. Set rather than left out,
 * since a bash or sh further down would pick its own default, and bash's ends
 * in `.` (W98's review).
 */
export const DEFAULT_SEARCH_PATH = '/usr/bin:/bin';

/**
 * PATH with only its absolute directories, in their order, or undefined when
 * none is left (W96's finding, W98). A POSIX protection: an empty entry
 * (`a::b`, or a leading or trailing `:`), a relative one (`.`, `bin`) and an
 * empty PATH all make a bare command, such as `claude`, `gh` or `git`, resolve
 * in the child's working directory, since Node's spawn and node-pty's execvp
 * search PATH as the shell does. pitwall runs gh from the temp directory,
 * which on Linux every local user can write to, so another user could plant
 * `/tmp/gh` there. Windows' own lookup searches the working directory first
 * whatever PATH says, and pitwall hasn't been run there, so childEnvironment()
 * leaves PATH alone on Windows.
 *
 * An entry that is `~`, or starts with `~/`, is the home directory and the
 * rest, kept in its place, as bash reads `~` and `~/` in its own command
 * search: a literal `~/.dotnet/tools`, which the .NET SDK's
 * `/etc/paths.d/dotnet-cli-tools` puts on a Mac's PATH, keeps working in the
 * sessions pitwall starts (coordinator, 2026-10-29). Node and execvp never
 * expand it, so unexpanded it would mean `<cwd>/~/.dotnet/tools`. The home
 * directory is `home`, else os.homedir(). Dropped like any other relative
 * entry: `~user/...`, which isn't expanded; a `~` entry when the home
 * directory isn't absolute or can't be found; and one whose home directory
 * has a `:` in it, which would read as two entries.
 */
export function absoluteSearchPath(value: string, home?: string): string | undefined {
  let homeDir = home;
  const expanded = (entry: string): string | undefined => {
    if (entry !== '~' && !entry.startsWith('~/')) return entry;
    homeDir ??= homeDirectory();
    if (!path.posix.isAbsolute(homeDir)) return undefined;
    const result = entry === '~' ? homeDir : homeDir.replace(/\/+$/, '') + entry.slice(1);
    return result.includes(path.posix.delimiter) ? undefined : result;
  };
  const kept: string[] = [];
  for (const entry of value.split(path.posix.delimiter)) {
    const dir = expanded(entry);
    if (dir !== undefined && path.posix.isAbsolute(dir)) kept.push(dir);
  }
  return kept.length > 0 ? kept.join(path.posix.delimiter) : undefined;
}

/**
 * The PATH a child gets for `value`: absoluteSearchPath(), or DEFAULT_SEARCH_PATH when no entry is
 * left. childEnvironment() gives every child this, and editors.ts searches it for an editor's command.
 */
export function childSearchPath(value: string, home?: string): string {
  return absoluteSearchPath(value, home) ?? DEFAULT_SEARCH_PATH;
}

/** os.homedir(), or '' when it can't say: it throws when there's no HOME and no user database entry. */
function homeDirectory(): string {
  try {
    return os.homedir();
  } catch {
    return '';
  }
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
 * inside; and, on macOS, Linux and the other Unixes, with PATH cut to its
 * absolute directories, a leading `~` expanded with the environment's own HOME
 * when that's absolute (childSearchPath()), so no bare command is found in the
 * child's working directory. A PATH that isn't there stays out. The CLI also
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
    // The search path, `PATH` exactly as libuv and execvp read it: a POSIX protection (absoluteSearchPath()).
    if (name === 'PATH' && process.platform !== 'win32') {
      const home = env.HOME !== undefined && path.posix.isAbsolute(env.HOME) ? env.HOME : undefined;
      result[name] = childSearchPath(value, home);
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
 * to close. With `processGroup` both go to its whole group, and the SIGKILL
 * goes while anything in the group is left, not only while the child runs:
 * gh exits on the SIGTERM, but a git it started may ignore it (W108's finding).
 */
export const runFile: RunFile = (file, args, options) =>
  new Promise<string>((resolve, reject) => {
    const maxBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
    const group = options.processGroup === true && process.platform !== 'win32';
    let settled = false;
    const chunks: Buffer[] = [];
    let bytes = 0;
    if (options.signal?.aborted) {
      reject(new RunError('aborted', 'was stopped before it started'));
      return;
    }
    /** Set once the caller has aborted: whatever happens next, the run rejects with it. */
    let aborted: RunError | undefined;

    const child = spawn(file, args, {
      cwd: options.cwd,
      // Without the identity of a Claude Code session pitwall may run inside.
      env: childEnvironment(options.env ?? process.env),
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      windowsHide: true,
      detached: group,
    });

    /** Signals the child, or with `processGroup` its whole group, which may outlive it. */
    const send = (name: NodeJS.Signals) => {
      if (group && child.pid !== undefined) {
        try {
          process.kill(-child.pid, name);
        } catch {
          // The group has gone.
        }
        return;
      }
      child.kill(name);
    };

    const running = () => child.exitCode === null && child.signalCode === null;

    /**
     * With `processGroup`, whether anything is left in the child's group, gh or a git it started,
     * by `kill(-pid, 0)`. The group's id is the child's pid, which POSIX never reuses while the
     * group lasts, so a group that's still there is this one. Only asked within 2.5 s of the
     * SIGTERM, so a group that ended and a new one under the same pid, which takes the pid space
     * wrapping round and a new process making itself a group leader, isn't a real risk.
     */
    const groupLeft = () => {
      if (!group || child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        // ESRCH: the group has gone. EPERM: what's left isn't this user's to signal anyway.
        return false;
      }
    };
    /** What a signal would still reach: the child while it runs, and with `processGroup` anything left in its group. */
    const anyLeft = () => running() || groupLeft();

    let stopping = false;
    /**
     * SIGTERM now, to the child or its whole group, and SIGKILL 2 s later to whatever of it is still
     * there, so nothing is left behind on every poll by a process that ignores SIGTERM. Once.
     */
    const stop = () => {
      if (stopping || !anyLeft()) return;
      stopping = true;
      send('SIGTERM');
      const force = setTimeout(() => {
        if (anyLeft()) send('SIGKILL');
      }, 2000);
      force.unref();
      // Without a group only the child is signalled, so its exit ends the need. With one, what it
      // started can outlive it: gh exits on the SIGTERM while its git ignores it (W108's finding).
      if (!group) child.once('exit', () => clearTimeout(force));
    };

    const finish = (result: RunError | undefined, stdout?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      // Aborted, it says so, whatever the child did as it stopped.
      const error = aborted ?? result;
      if (error) {
        stop();
        child.stdout?.destroy();
        reject(error);
      } else {
        resolve(stdout ?? '');
      }
    };

    /**
     * What the child does, which settles the run, unless the caller has aborted it and something is
     * left in its group: then abort() settles it, once the group has gone.
     */
    const settleBy = (result: RunError | undefined, stdout?: string) => {
      if (aborted && groupLeft()) return;
      finish(result, stdout);
    };

    const timer = setTimeout(() => {
      finish(new RunError('timeout', `timed out after ${formatSeconds(options.timeoutMs)}`));
    }, options.timeoutMs);

    // Stopped by the caller: SIGTERM now, SIGKILL 2 s later, and the rejection once the child has
    // exited and, with a group, nothing in it is left, or 2.5 s after the SIGTERM at most.
    function abort() {
      if (settled || aborted) return;
      aborted = new RunError('aborted', 'was stopped');
      clearTimeout(timer);
      if (!anyLeft()) {
        finish(aborted);
        return;
      }
      stop();
      const giveUp = setTimeout(() => finish(aborted), 2500);
      giveUp.unref();
      const whenGone = () => {
        if (settled) return;
        if (groupLeft()) {
          setTimeout(whenGone, 50).unref();
          return;
        }
        clearTimeout(giveUp);
        finish(aborted);
      };
      if (running()) child.once('exit', whenGone);
      else whenGone();
    }
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        settleBy(new RunError('too-large', `printed more than ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') settleBy(new RunError('not-found', `${file} was not found`));
      else settleBy(new RunError('spawn', oneLine(err.message)));
    });

    child.on('close', (code, signal) => {
      if (code === 0) settleBy(undefined, Buffer.concat(chunks).toString('utf8'));
      else if (code !== null) settleBy(new RunError('exit', `exited with code ${code}`, code));
      else settleBy(new RunError('signal', `was killed by ${signal ?? 'a signal'}`));
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
