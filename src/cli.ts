#!/usr/bin/env node

// The `pitwall` command: parse the roots, start the indexer and the server,
// print the URL and open the browser.
//
// The browser is opened through a launch file (D7, src/server/launch.ts), never
// with the token URL on a command line, because `ps` shows every process's
// arguments to every user. The token is printed to stdout, the user's own
// terminal, and passed in from `npm run dev` through the environment, which
// other users can't read.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startIndexer } from './index/index.js';
import { createRelayManager, DEFAULT_PORT, PortInUseError, startServer } from './server/index.js';
import { LaunchDirError, pitwallHome, prepareLaunchDir, removeWhenUsed, writeLaunchFile } from './server/launch.js';
import { DEFAULT_POLL_INTERVAL_MS } from './shared/protocol.js';

/** The shortest and longest poll interval `--interval` accepts, in seconds. */
export const INTERVAL_MIN_SECONDS = 1;
export const INTERVAL_MAX_SECONDS = 300;

export const USAGE = `Usage: pitwall [root...] [--port <n>] [--interval <seconds>] [--no-open]

Lists the Claude Code sessions running under each root, in a local web UI.
The roots default to the current directory.

Options:
  --port <n>            Port on 127.0.0.1. Default ${DEFAULT_PORT}, or a free port if
                        ${DEFAULT_PORT} is busy. 0 always picks a free port.
  --interval <seconds>  How often to poll claude agents, in whole seconds
                        from ${INTERVAL_MIN_SECONDS} to ${INTERVAL_MAX_SECONDS}. Default ${DEFAULT_POLL_INTERVAL_MS / 1000}.
  --no-open             Don't open the browser.
  -h, --help            Show this help.
  -v, --version         Show the version.

The browser is opened through a launch file in ~/.pitwall (mode 0600, in a
0700 directory), so the token never appears in a command line. The file is
deleted once the page connects, after 60 seconds, or on exit, whichever is first.

Environment:
  PITWALL_TOKEN        Use this token instead of a random one. At least 32
                       characters from A-Z, a-z, 0-9, "-" and "_". Reusing
                       it keeps one token alive across runs: any page or
                       script that ever saw it can drive every later run
                       that uses it. Leave it unset to get a new token on
                       every run.
  PITWALL_NO_OPEN      Set to 1 to skip opening the browser.
  PITWALL_HOME         Where launch files go, instead of ~/.pitwall.
  PITWALL_OPEN_MARKER  A file path. Open the browser only if it doesn't exist
                       yet, then create it. npm run dev sets it, so the browser
                       opens once per dev run, not on every restart.`;

/** A problem with the command line or environment. Printed with a `pitwall:` prefix, exit 1. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/** Printed with a `pitwall:` prefix, exit 1, when the directory pitwall was started in has been deleted. */
export const CWD_GONE_MESSAGE = 'the current directory no longer exists. cd to one that does and run pitwall again.';

/**
 * The current directory, or undefined when it no longer exists. A shell can
 * stay in a directory after it has been deleted, and process.cwd() then fails
 * with ENOENT from uv_cwd. Any other failure is thrown as it was.
 */
export function currentDirectory(readCwd: () => string = () => process.cwd()): string | undefined {
  try {
    return readCwd();
  } catch (error) {
    const { code, syscall } = (typeof error === 'object' && error !== null ? error : {}) as NodeJS.ErrnoException;
    if (code === 'ENOENT' && syscall === 'uv_cwd') return undefined;
    throw error;
  }
}

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | {
      kind: 'run';
      /** As given, not yet resolved. Empty means the current directory. */
      roots: string[];
      /** Undefined means the default port, with fallback. */
      port?: number;
      /** From `--interval <seconds>`. Undefined means the indexer's default. */
      intervalMs?: number;
      open: boolean;
    };

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: 'string' },
        interval: { type: 'string' },
        'no-open': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { kind: 'help' };
  if (values.version) return { kind: 'version' };

  return {
    kind: 'run',
    roots: positionals,
    ...(values.port === undefined ? {} : { port: parsePort(values.port) }),
    ...(values.interval === undefined ? {} : { intervalMs: parseInterval(values.interval) * 1000 }),
    open: !values['no-open'] && env.PITWALL_NO_OPEN !== '1',
  };
}

function parsePort(raw: string): number {
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 0 && port <= 65535)) {
    throw new UsageError(`--port must be a whole number from 0 to 65535, not "${raw}"`);
  }
  return port;
}

/** Whole seconds from 1 to 300. */
function parseInterval(raw: string): number {
  const seconds = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  if (!(seconds >= INTERVAL_MIN_SECONDS && seconds <= INTERVAL_MAX_SECONDS)) {
    throw new UsageError(
      `--interval must be a whole number of seconds from ${INTERVAL_MIN_SECONDS} to ${INTERVAL_MAX_SECONDS}, not "${raw}"`,
    );
  }
  return seconds;
}

/**
 * Resolves the roots against `cwd` to absolute paths, defaulting to `cwd`
 * itself. Throws UsageError for one that isn't a directory. `cwd` comes from
 * currentDirectory(), so the CLI never reads the directory unchecked.
 */
export function resolveRoots(roots: string[], cwd: string): string[] {
  const absolute = (roots.length > 0 ? roots : [cwd]).map((root) => resolve(cwd, root));
  for (const root of absolute) {
    let isDirectory = false;
    try {
      isDirectory = statSync(root).isDirectory();
    } catch {
      throw new UsageError(`root does not exist: ${root}`);
    }
    if (!isDirectory) throw new UsageError(`root is not a directory: ${root}`);
  }
  return absolute;
}

/** PITWALL_TOKEN when set and valid, otherwise 32 random bytes as base64url. */
export function resolveToken(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PITWALL_TOKEN;
  if (fromEnv === undefined) return randomBytes(32).toString('base64url');
  if (fromEnv.length < 32) throw new UsageError('PITWALL_TOKEN must be at least 32 characters');
  // The token goes into a URL fragment, an Authorization header and, on
  // Windows, a `cmd /c start` command line, so keep it to URL-safe characters.
  if (!/^[A-Za-z0-9_-]+$/.test(fromEnv)) {
    throw new UsageError('PITWALL_TOKEN may only contain A-Z, a-z, 0-9, "-" and "_"');
  }
  return fromEnv;
}

/**
 * Deletes from `env` every variable whose value contains `token`:
 * PITWALL_TOKEN, and any copy of it, such as an `Authorization` header a
 * wrapper exported. Returns the names it deleted.
 */
export function removeTokenVariables(env: NodeJS.ProcessEnv, token: string): string[] {
  const removed: string[] = [];
  if (token === '') return removed;
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !value.includes(token)) continue;
    delete env[name];
    removed.push(name);
  }
  return removed;
}

/**
 * `<dir of cli.js>/web` when it exists: the built dist/cli.js next to dist/web.
 * Otherwise `<repo>/dist/web`, for `tsx src/cli.ts`.
 */
export function resolveWebRoot(cliFile: string = fileURLToPath(import.meta.url)): string {
  const here = dirname(cliFile);
  const sibling = join(here, 'web');
  return existsSync(sibling) ? sibling : resolve(here, '..', 'dist', 'web');
}

/**
 * The command that opens a file in the default browser. pitwall passes the
 * launch file's path, never a URL with the token in it: the command's
 * arguments are visible to every user through `ps`.
 */
export function browserCommand(file: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === 'darwin') return ['open', [file]];
  // The empty argument is start's window title; without it, a quoted path would become the title.
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', file]];
  return ['xdg-open', [file]];
}

/** Opens the file with execFile, so no shell parses it. A failure is reported, not fatal. */
export function openBrowser(file: string): void {
  const [command, args] = browserCommand(file);
  const child = execFile(command, args, (error) => {
    if (error) console.error(`pitwall: couldn't open a browser (${error.message}). Open the URL above instead.`);
  });
  child.unref();
}

/**
 * Claims the right to open the browser for this dev run: creates `marker`
 * if it doesn't exist yet, atomically, and says whether this call created it.
 */
export function claimOpenMarker(marker: string): boolean {
  try {
    closeSync(openSync(marker, 'wx', 0o600));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      console.error(`pitwall: couldn't create ${marker} (${(error as Error).message}), so not opening a browser.`);
    }
    return false;
  }
}

function readVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

export interface MainOptions {
  /** Reads the current directory. Default process.cwd(). Tests pass one that throws. */
  cwd?: () => string;
}

export async function main(argv: string[] = process.argv.slice(2), options: MainOptions = {}): Promise<number> {
  let command: CliCommand;
  let roots: string[];
  let token: string;
  // Where the launch file goes, when this run opens the browser.
  let launchDir: string | undefined;
  const marker = process.env.PITWALL_OPEN_MARKER || undefined;
  try {
    command = parseCliArgs(argv);
    if (command.kind === 'help') {
      console.log(USAGE);
      return 0;
    }
    if (command.kind === 'version') {
      console.log(readVersion());
      return 0;
    }
    // Before anything reads the directory, starts a child process or opens the
    // browser, and even when every root is absolute: a shell can stay in a
    // directory that has been deleted. Then process.cwd() throws, a relative
    // PITWALL_HOME or CLAUDE_CONFIG_DIR can't be resolved, and git and the
    // browser opener, which set no cwd of their own, would start in it.
    // --help and --version don't need the directory, so they still work.
    const cwd = currentDirectory(options.cwd);
    if (cwd === undefined) {
      console.error(`pitwall: ${CWD_GONE_MESSAGE}`);
      return 1;
    }
    roots = resolveRoots(command.roots, cwd);
    token = resolveToken();
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`pitwall: ${error.message}\nRun pitwall --help for usage.`);
    return 1;
  }
  // Under npm run dev, a restart finds the marker the first run created, and
  // doesn't open another tab.
  if (command.open && !(marker !== undefined && existsSync(marker))) {
    launchDir = pitwallHome();
    try {
      // Before anything listens: an unsafe directory stops pitwall here.
      prepareLaunchDir(launchDir);
    } catch (error) {
      if (!(error instanceof LaunchDirError)) throw error;
      console.error(`pitwall: ${error.message}`);
      return 1;
    }
  }
  // Keep the token out of child processes, before anything that starts one
  // exists: the indexer runs `claude`, and the sessions, PTYs and relay pitwall
  // starts mustn't be able to drive it. childEnvironment() (server/command.ts)
  // scrubs again for every child; this also covers the indexer, which doesn't
  // use it, and the relay, which has no token to pass it.
  removeTokenVariables(process.env, token);
  delete process.env.PITWALL_OPEN_MARKER;

  const intervalMs = command.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  // The relay (D8) starts on the first message. The index leaves its own session out, and shows its exchanges.
  const relay = createRelayManager();
  const indexer = startIndexer({
    roots,
    intervalMs,
    exclude: (row) => relay.isRelay(row),
    relayExchange: (sessionId) => relay.exchange(sessionId),
    relayAlert: () => relay.alert(),
  });
  // Set once the launch file is written. The first page to authenticate has
  // read it, so it's deleted then, rather than left holding the token.
  let launchFileUsed: (() => void) | undefined;
  let server;
  try {
    server = await startServer({
      indexer,
      token,
      relay,
      onAuthenticated: () => launchFileUsed?.(),
      webRoot: resolveWebRoot(),
      ...(command.port === undefined ? {} : { port: command.port }),
    });
  } catch (error) {
    indexer.stop();
    if (error instanceof PortInUseError) {
      console.error(
        `pitwall: port ${error.port} on 127.0.0.1 is already in use. Pick another with --port <n>, or use --port 0 for a free one.`,
      );
    } else {
      console.error(`pitwall: couldn't start the server: ${(error as Error).message}`);
    }
    return 1;
  }

  // Before anything is printed or opened: a signal that arrived with no
  // handler yet would kill the process outright, skipping the exit hook that
  // deletes the launch file. SIGHUP comes when the terminal closes.
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    // tsx watch and terminals can deliver the same signal twice; the second is ignored.
    setTimeout(() => process.exit(1), 3000).unref();
    server
      .close()
      .then(
        () => 0,
        (error: unknown) => {
          console.error(`pitwall: error while closing the server: ${(error as Error).message}`);
          return 1;
        },
      )
      .then((code) => {
        indexer.stop();
        process.exit(code);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);

  const url = `${server.url}/#token=${token}`;
  if (command.port === undefined && server.port !== DEFAULT_PORT) {
    console.log(`pitwall: port ${DEFAULT_PORT} is busy, so using ${server.port}.`);
  }
  console.log(`pitwall is running at ${url}`);
  console.log(`Watching ${roots.length === 1 ? 'root' : 'roots'}: ${roots.join(', ')}, polling every ${intervalMs / 1000}s`);
  // Only now that this process's own server is listening, so the browser is
  // never sent to whatever else holds the port.
  if (launchDir !== undefined && (marker === undefined || claimOpenMarker(marker))) {
    launchFileUsed = openThroughLaunchFile(launchDir, server.port, url);
  }
  return 0;
}

/**
 * Writes the launch file and opens it. The file is deleted when the returned
 * function is called, 60 seconds after it was written, or when this process
 * exits, whichever comes first. A failure is reported, not fatal.
 */
function openThroughLaunchFile(dir: string, port: number, url: string): (() => void) | undefined {
  let file: string;
  try {
    file = writeLaunchFile(dir, port, url);
  } catch (error) {
    console.error(`pitwall: couldn't write the launch file in ${dir} (${(error as Error).message}). Open the URL above instead.`);
    return undefined;
  }
  const used = removeWhenUsed(file);
  openBrowser(file);
  return used;
}

/** True when this file is the program being run, not a module imported by tests or scripts/dev.ts. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error('pitwall:', error);
      process.exitCode = 1;
    },
  );
}
