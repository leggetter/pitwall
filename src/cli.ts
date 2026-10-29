#!/usr/bin/env node

// The `pitwall` command: parse the arguments and read the config file
// (src/config.ts, W103), start the indexer and the server, print the URL and
// open the browser.
//
// The browser is opened through a launch file (D7, src/server/launch.ts), never
// with the token URL on a command line, because `ps` shows every process's
// arguments to every user. A token that dies with the run is printed to
// stdout, the user's own terminal, with the URL. A fixed one (PITWALL_TOKEN)
// never is (W51): it stays valid for every later run, so a copy in scrollback,
// a log or an agent's transcript would outlive the run. The token is passed in
// from `npm run dev` through the environment, which other users can't read.
//
// PITWALL_TOKEN comes from the environment only. The CLI never loads a .env,
// from the current directory or anywhere else: pitwall runs inside other
// people's repos, and one of those repos' .env would then pick the token,
// fixed and known to whoever wrote it. `npm run dev` reads the pitwall repo's
// own .env, found from its own location (scripts/dev.ts).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig, ownersByRoot, type LoadedConfig } from './config.js';
import { startIndexer } from './index/index.js';
import { createPrPoller, prsOff } from './prs/index.js';
import { childEnvironment } from './server/command.js';
import { createRelayManager, DEFAULT_PORT, PortInUseError, startServer } from './server/index.js';
import { type DirCheckContext, LaunchDirError, pitwallHome, prepareLaunchDir, removeWhenUsed, writeLaunchFile } from './server/launch.js';
import { RELAY_NAME } from './server/relayPrompt.js';
import { DEFAULT_POLL_INTERVAL_MS, PRS_POLL_INTERVAL_MS } from './shared/protocol.js';

/** The shortest and longest poll interval `--interval` accepts, in seconds. */
export const INTERVAL_MIN_SECONDS = 1;
export const INTERVAL_MAX_SECONDS = 300;

/**
 * The fewest different characters PITWALL_TOKEN may have (W51). Low enough that a random token in
 * any common alphabet passes: one from .env.example's command, 43 characters of base64url, fails it
 * about once in 10^32 tries, and 64 hex characters (`openssl rand -hex 32`) about once in 10^19.
 */
export const TOKEN_MIN_DIFFERENT = 8;

export const USAGE = `Usage: pitwall [root...] [--config <path>] [--port <n>] [--interval <seconds>] [--no-open] [--no-prs]

Lists the Claude Code sessions running under each root, in a local web UI.
The roots default to the config file's, then to the current directory.

Options:
  --config <path>       Read this config file instead of ~/.pitwall/config.json.
                        It must exist.
  --port <n>            Port on 127.0.0.1. Default ${DEFAULT_PORT}, or a free port if
                        ${DEFAULT_PORT} is busy. 0 always picks a free port. A pinned
                        tab needs the same port every run, so give one with --port
                        if ${DEFAULT_PORT} is often busy.
  --interval <seconds>  How often to poll claude agents, in whole seconds
                        from ${INTERVAL_MIN_SECONDS} to ${INTERVAL_MAX_SECONDS}. Default ${DEFAULT_POLL_INTERVAL_MS / 1000}.
  --no-open             Don't open the browser.
  --no-prs              Don't list your open pull requests, and never run gh.
                        Without it, pitwall runs gh api graphql at start, every
                        ${PRS_POLL_INTERVAL_MS / 60_000} minutes and on Refresh, for your open PRs on
                        github.com. gh must be installed and logged in.
  -h, --help            Show this help.
  -v, --version         Show the version.

Config file:
  With --config, pitwall reads that file. Without it, pitwall reads
  config.json in ~/.pitwall, or in PITWALL_HOME when that's set, if it's
  there. It's JSON, with // and /* */ comments and trailing commas allowed:

    {
      "roots": [
        "~/oss",
        { "path": "~/work", "github": { "owners": ["example-co"] } }
      ]
    }

  roots                 The roots to watch when none are given as arguments.
                        Each is a path, absolute or starting with ~/, or an
                        object with "path" and "github".
  github.owners         Whose pull requests a root lists for repos it has no
                        clone of: a list of GitHub owners, "all" for every
                        owner no other root lists, or "none" for its own
                        clones only. Without it, each owner goes to the root
                        with the most clones from it.

  A flag wins over an environment variable, which wins over the file. Roots
  given as arguments replace the file's, and each keeps its "github" settings
  when it's the same directory as one in the file. A bad value stops pitwall,
  and an unknown key is a warning. On macOS and Linux, the file must be yours,
  and not writable by group or others. It can't hold a token: PITWALL_TOKEN
  comes from the environment only, and GitHub's stays in gh.

The browser is opened through a launch file in ~/.pitwall (mode 0600, in a
0700 directory), so the token never appears in a command line. The file is
deleted once the page connects, after 60 seconds, or on exit, whichever is first.
With a fixed PITWALL_TOKEN, it isn't deleted when a page connects, so a pinned
tab that reconnects first can't take it from a new one.

Environment:
  PITWALL_TOKEN          Use this token instead of a random one. At least 32
                         characters from A-Z, a-z, 0-9, "-" and "_", with at
                         least ${TOKEN_MIN_DIFFERENT} different ones, and not one piece repeated
                         (abcabc...). The pitwall repo's .env.example shows how
                         to make a random one. Reusing it keeps one token alive
                         across runs: any page or script that ever saw it can
                         drive every later run that uses it, so use it only on
                         a single-user machine or for development. pitwall
                         then prints its URL without the token: a tab that has
                         it reconnects by itself, and a new tab needs #token=
                         and the token added. Leave it unset, or empty, to get
                         a new token on every run, printed with the URL.
                         pitwall reads it from the environment only, never
                         from a .env file; npm run dev also reads it from the
                         pitwall repo's own .env.
  PITWALL_NO_OPEN        Set to 1 to skip opening the browser.
  PITWALL_HOME           Where config.json, launch files and attachments are,
                         instead of ~/.pitwall.
  PITWALL_OPEN_MARKER    A file path. Open the browser only if it doesn't exist
                         yet, then create it. npm run dev sets it, so the
                         browser opens once per dev run, not on every restart.
  PITWALL_TOKEN_PER_RUN  Set to 1, with PITWALL_OPEN_MARKER, when PITWALL_TOKEN
                         isn't fixed but this run's own, so pitwall prints it
                         with the URL. npm run dev sets both for the token it
                         makes for each dev run, and never for a fixed one.
                         Without the marker it's ignored: PITWALL_TOKEN is
                         fixed, and never printed.`;

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
      /** As given, not yet resolved. Empty means the config file's roots, else the current directory. */
      roots: string[];
      /** From `--config <path>`, as given. Undefined means config.json in pitwall's folder, if it exists. */
      config?: string;
      /** Undefined means the default port, with fallback. */
      port?: number;
      /** From `--interval <seconds>`. Undefined means the indexer's default. */
      intervalMs?: number;
      open: boolean;
      /** False with `--no-prs`: pitwall never runs gh. */
      prs: boolean;
    };

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string' },
        port: { type: 'string' },
        interval: { type: 'string' },
        'no-open': { type: 'boolean' },
        'no-prs': { type: 'boolean' },
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

  if (values.config === '') throw new UsageError('--config needs a path');
  return {
    kind: 'run',
    roots: positionals,
    ...(values.config === undefined ? {} : { config: values.config }),
    ...(values.port === undefined ? {} : { port: parsePort(values.port) }),
    ...(values.interval === undefined ? {} : { intervalMs: parseInterval(values.interval) * 1000 }),
    open: !values['no-open'] && env.PITWALL_NO_OPEN !== '1',
    prs: !values['no-prs'],
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

/**
 * The roots to watch: the arguments, resolved by resolveRoots(); without any,
 * the config file's, each checked as an argument is, with its key and the file
 * named in the message; without those, the current directory. Arguments
 * replace the file's roots rather than adding to them (W103).
 */
export function effectiveRoots(args: string[], config: Pick<LoadedConfig, 'file' | 'roots'>, cwd: string): string[] {
  if (args.length > 0 || config.roots === undefined) return resolveRoots(args, cwd);
  return config.roots.map((root) => {
    try {
      return resolveRoots([root.path], cwd)[0]!;
    } catch (error) {
      if (error instanceof UsageError) throw new UsageError(`${error.message} ("${root.key}" in ${config.file})`);
      throw error;
    }
  });
}

/**
 * The line printed at start when PITWALL_TOKEN is set, by the CLI and by npm
 * run dev, which says where it came from (`source`). Never the token itself.
 */
export function fixedTokenNotice(source?: string): string {
  return `the token is fixed by PITWALL_TOKEN${source ? ` in ${source}` : ''}, so every run that uses it has the same one. Use this only on a single-user machine or for development.`;
}

/**
 * Whether PITWALL_TOKEN fixes the token: set and not empty, since an empty one
 * counts as unset (W40), and not npm run dev's own token for one dev run, which
 * it marks with PITWALL_TOKEN_PER_RUN=1 (W51). That mark counts only with
 * PITWALL_OPEN_MARKER set too, as npm run dev sets both (W58): set by hand
 * without it, it would print a fixed token and delete its launch file at the
 * first authentication, so it's ignored.
 */
export function hasFixedToken(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PITWALL_TOKEN === undefined || env.PITWALL_TOKEN === '') return false;
  const devRunsOwn = env.PITWALL_TOKEN_PER_RUN === '1' && env.PITWALL_OPEN_MARKER !== undefined && env.PITWALL_OPEN_MARKER !== '';
  return !devRunsOwn;
}

/**
 * PITWALL_TOKEN when set and valid, otherwise 32 random bytes as base64url.
 * An empty PITWALL_TOKEN counts as unset, so `PITWALL_TOKEN=` in a .env, as
 * .env.example has it, gives a new token every run; one that's set but not
 * valid is refused. No message quotes it.
 *
 * Valid: at least 32 characters from base64url's alphabet, at least
 * TOKEN_MIN_DIFFERENT of them different, and not one piece written out again
 * and again (W51). The last two only refuse an obviously weak token, such as
 * 32 zeros or a word repeated; they can't tell a random token from a made-up
 * one. A token that npm run dev made for its run is checked here too, in the
 * CLI it starts, and passes them as any random token does.
 */
export function resolveToken(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PITWALL_TOKEN;
  if (fromEnv === undefined || fromEnv === '') return randomBytes(32).toString('base64url');
  if (fromEnv.length < 32) throw new UsageError('PITWALL_TOKEN must be at least 32 characters');
  // The token goes into a URL fragment, an Authorization header and, on
  // Windows, a `cmd /c start` command line, so keep it to URL-safe characters.
  if (!/^[A-Za-z0-9_-]+$/.test(fromEnv)) {
    throw new UsageError('PITWALL_TOKEN may only contain A-Z, a-z, 0-9, "-" and "_"');
  }
  if (new Set(fromEnv).size < TOKEN_MIN_DIFFERENT) {
    throw new UsageError(`PITWALL_TOKEN must have at least ${TOKEN_MIN_DIFFERENT} different characters`);
  }
  if (repeatsOnePiece(fromEnv)) throw new UsageError('PITWALL_TOKEN must not be one piece repeated, as in abcabcabc');
  return fromEnv;
}

/**
 * Whether `text` is one piece written out at least twice, the last copy
 * perhaps cut short: `abcabcab`, `xyxy`. That is, its shortest period is at
 * most half its length. Found from the longest prefix that's also a suffix
 * (KMP's failure function), in time linear in the length, since the
 * environment can hold a long value.
 */
export function repeatsOnePiece(text: string): boolean {
  if (text.length < 2) return false;
  const border = new Array<number>(text.length).fill(0);
  for (let i = 1, k = 0; i < text.length; i++) {
    while (k > 0 && text[i] !== text[k]) k = border[k - 1]!;
    if (text[i] === text[k]) k++;
    border[i] = k;
  }
  return text.length - border[text.length - 1]! <= text.length / 2;
}

/**
 * Why npm run dev mustn't read the pitwall repo's .env (W51), or undefined
 * when it may. The file can hold PITWALL_TOKEN, so it must be a file of yours
 * that neither group nor others can read or change, as ensureLaunchDir asks of
 * ~/.pitwall. `stats` is from the open file (fstat), so what's checked is
 * what's read. The message names the file, never its contents. Windows has no
 * POSIX owner or mode bits, so there only the file check applies. The CLI
 * itself never reads a .env.
 */
export function envFileProblem(file: string, stats: Pick<Stats, 'mode' | 'uid' | 'isFile'>, context: DirCheckContext = {}): string | undefined {
  const platform = context.platform ?? process.platform;
  const uid = 'uid' in context ? context.uid : process.getuid?.();
  if (!stats.isFile()) return `${file} is not a file. Move it aside, then run npm run dev again.`;
  if (platform === 'win32') return undefined;
  if (uid !== undefined && stats.uid !== uid) {
    return `${file} belongs to another user (uid ${stats.uid}). npm run dev reads a .env only when it's yours, since it can hold PITWALL_TOKEN.`;
  }
  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return `${file} can be read or changed by other users (mode ${mode.toString(8).padStart(3, '0')}), and it can hold PITWALL_TOKEN. Run chmod 600 ${file}, then run npm run dev again.`;
  }
  return undefined;
}

/**
 * The line printed under the URL when the token is fixed, in place of the
 * token, which the URL then leaves out (W51).
 */
export const FIXED_TOKEN_LINE =
  "The token is the one in PITWALL_TOKEN, so it isn't printed. A tab that has it reconnects by itself; for a new tab, add #token= and that token to the address.";

/**
 * What the CLI prints once its server is listening. A per-run token's link, as
 * it always has (W8): the token dies with the run. A fixed token's address with
 * no token, and FIXED_TOKEN_LINE: printed, the token would outlive the run in
 * scrollback, logs and agents' transcripts (W48 F2).
 */
export function runningLines(serverUrl: string, token: string, fixed: boolean): string[] {
  if (fixed) return [`pitwall is running at ${serverUrl}/`, FIXED_TOKEN_LINE];
  return [`pitwall is running at ${serverUrl}/#token=${token}`];
}

/** What to do when the browser can't be opened: the printed link, or with a fixed token, the address and the token. */
export function openInsteadHint(fixed: boolean): string {
  return fixed ? 'Open the URL above instead, and add #token= and your PITWALL_TOKEN to it.' : 'Open the URL above instead.';
}

/**
 * What the CLI prints when the default port was busy and it fell back to a
 * free one: a pinned tab can't follow a port that changes every run.
 */
export function fallbackPortMessage(defaultPort: number, port: number): string {
  return (
    `pitwall: port ${defaultPort} is busy, so this run uses port ${port}, which changes every time. ` +
    `A pinned pitwall tab needs the same port every run, so start pitwall with --port <n> to keep one working.`
  );
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

/**
 * Opens the file with execFile, so no shell parses it, in the environment
 * every child gets (childEnvironment()), so `open` or `xdg-open` is never
 * found in the directory pitwall started in through an empty or relative
 * PATH entry (W98). A failure is reported, not fatal, with what to open
 * instead (`fixed`: the token isn't printed).
 */
export function openBrowser(file: string, fixed: boolean): void {
  const [command, args] = browserCommand(file);
  const child = execFile(command, args, { env: childEnvironment(process.env) }, (error) => {
    // On one line: execFile's message ends with a line break and the opener's stderr.
    if (error) console.error(`pitwall: couldn't open a browser (${error.message.trim().replace(/\s+/g, ' ')}). ${openInsteadHint(fixed)}`);
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
  let config: LoadedConfig;
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
    // The config file (W103, D24), before the roots, which can come from it.
    config = loadConfig({ ...(command.config === undefined ? {} : { file: command.config }), cwd });
    for (const warning of config.warnings) console.error(`pitwall: ${warning}`);
    roots = effectiveRoots(command.roots, config, cwd);
    token = resolveToken();
  } catch (error) {
    if (!(error instanceof UsageError || error instanceof ConfigError)) throw error;
    console.error(`pitwall: ${error.message}\nRun pitwall --help for usage.`);
    return 1;
  }
  // Whether the token outlives this run. If so, it's never printed (W51), and
  // its launch file isn't deleted when a page first authenticates.
  const fixed = hasFixedToken();
  // A fixed token, said once. Not under npm run dev, which sets the marker: it says so itself when
  // PITWALL_TOKEN is fixed, and otherwise passes a token of its own run, marked PITWALL_TOKEN_PER_RUN.
  if (fixed && marker === undefined) console.error(`pitwall: ${fixedTokenNotice()}`);
  // Unset, as it counts: not passed on to the children, empty.
  if (process.env.PITWALL_TOKEN === '') delete process.env.PITWALL_TOKEN;
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
  delete process.env.PITWALL_TOKEN_PER_RUN;

  const intervalMs = command.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  // The relay (D8) starts on the first message. The index leaves its own session out, and shows its exchanges.
  const relay = createRelayManager();
  const indexer = startIndexer({
    roots,
    intervalMs,
    exclude: (row) => relay.isRelay(row),
    relayExchange: (sessionId) => relay.exchange(sessionId),
    relayAlert: () => relay.alert(),
    relayOff: () => relay.off(),
    // Its messages to the relay show in each session's conversation (W46).
    relayName: RELAY_NAME,
  });
  // Set once the launch file is written, for a per-run token only. The first
  // page to authenticate has read it, so it's deleted then, rather than left
  // holding the token. A fixed token's file waits its 60 seconds, or the exit:
  // a pinned tab that already has the token reconnects before a new tab has
  // read the file, and would otherwise take it away from that tab (W51).
  let launchFileUsed: (() => void) | undefined;
  let server;
  try {
    server = await startServer({
      indexer,
      token,
      relay,
      onAuthenticated: () => launchFileUsed?.(),
      webRoot: resolveWebRoot(),
      // Attachments for New session's first prompt go in its attachments folder (W79), made on the first upload.
      pitwallHome: pitwallHome(),
      // Your open PRs (M4), which the server starts fetching once it's listening. With --no-prs, never gh.
      // With the index, each PR is placed under the clone of its repo, or the root that claims its
      // owner, with each configured root's `github.owners` by real path (W105, W103).
      prs: command.prs ? createPrPoller({ index: indexer, ownersByRoot: ownersByRoot(config, roots) }) : prsOff(),
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

  // The launch file always has the token: it's the one place a fixed token is written (D7).
  const url = `${server.url}/#token=${token}`;
  if (command.port === undefined && server.port !== DEFAULT_PORT) console.log(fallbackPortMessage(DEFAULT_PORT, server.port));
  for (const line of runningLines(server.url, token, fixed)) console.log(line);
  if (config.found) console.log(`Using the config file ${config.file}`);
  console.log(`Watching ${roots.length === 1 ? 'root' : 'roots'}: ${roots.join(', ')}, polling every ${intervalMs / 1000}s`);
  // Only now that this process's own server is listening, so the browser is
  // never sent to whatever else holds the port.
  if (launchDir !== undefined && (marker === undefined || claimOpenMarker(marker))) {
    const used = openThroughLaunchFile(launchDir, server.port, url, fixed);
    if (!fixed) launchFileUsed = used;
  }
  return 0;
}

/**
 * Writes the launch file and opens it. The file is deleted when the returned
 * function is called, 60 seconds after it was written, or when this process
 * exits, whichever comes first. A failure is reported, not fatal.
 */
function openThroughLaunchFile(dir: string, port: number, url: string, fixed: boolean): (() => void) | undefined {
  let file: string;
  try {
    file = writeLaunchFile(dir, port, url);
  } catch (error) {
    console.error(`pitwall: couldn't write the launch file in ${dir} (${(error as Error).message}). ${openInsteadHint(fixed)}`);
    return undefined;
  }
  const used = removeWhenUsed(file);
  openBrowser(file, fixed);
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
