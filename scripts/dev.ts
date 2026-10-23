// `npm run dev [-- root...]`: rebuilds the web UI on change (`vite build --watch
// --mode development`, which adds the #uikit gallery) and restarts the server on
// change (`tsx watch src/cli.ts`), passing the roots through. There is no Vite
// dev server: the pitwall server serves dist/web, so the UI is always same-origin.
//
// tsx watch restarts the CLI on every change. So that a restart doesn't mint a
// new token and open another browser tab, this script generates one random
// token per `npm run dev` run, passes it to the CLI as PITWALL_TOKEN (the
// environment, which other users can't read, never the command line), and pins
// the port. It also sets PITWALL_TOKEN_PER_RUN=1, so the CLI knows the token
// dies with this dev run and prints its link, on every restart, as for any
// per-run token. The CLI honours it only with PITWALL_OPEN_MARKER, which this
// script sets too, and this script never takes it from the environment or the
// .env (W58), so it can't mark a fixed token. Every security check stays on.
// After each restart the web UI reconnects, answers a fresh challenge with the
// token it already has, and gets the new server's apiKey.
//
// A fixed token, opt-in (W40), for a single-user machine or for development:
// PITWALL_TOKEN from the environment, or from the pitwall repo's own .env,
// is used instead, for every dev run, and this script says so in one line,
// never with the token. The CLI then never prints it either, on any restart
// (W51): only the address, and that the token is PITWALL_TOKEN's. The .env is
// found from this file's location, never from the current directory, and read
// only when it exists, and only when it's a file of yours that no one else can
// read or change (mode 0600, W51); otherwise this script stops, saying chmod
// 600, and never shows what's in it. The environment wins over it. Its other
// variables reach the tsx watcher, and the Vite watcher gets the environment
// pitwall gives any child (childEnvironment), without PITWALL_* or anything
// holding the token. The token is checked as the CLI checks it (resolveToken
// in src/cli.ts): an empty one counts as unset, and one that's set but not
// valid, or obviously weak, is refused. .env.example says how to make one.
// The CLI itself never reads a .env.
//
// The browser is opened once per dev run, by the CLI child itself, through its
// launch file, and only after that child's own server is listening on the
// port. This script passes it PITWALL_OPEN_MARKER, a path in a private temp
// directory: the first CLI to listen creates the marker and opens the browser,
// and later restarts find the marker and don't. A process squatting on the
// port never gets a browser pointed at it, because the CLI can't listen there
// and so never opens anything.
//
// Residual risk, left as it is on purpose: the token outlives each restart.
// The page keeps it in sessionStorage, which belongs to the origin
// http://127.0.0.1:<port>. A process that grabs the port in the moment the
// CLI restarts serves its own page on that same origin, so the tab's next
// reload (the user's, or the "still building" page's own) loads the
// squatter's page, which can read sessionStorage. The token it finds still
// works, because every later restart in this dev run uses it again. The
// proof's origin binding (protocol v3) doesn't help, because the squatter's
// origin is the real one. It needs another local process to win a race for
// the port. Outside npm run dev, each run gets a new token unless
// PITWALL_TOKEN is set, so a token read that way is already dead. With
// PITWALL_TOKEN set, from the environment or .env, it never dies: every later
// run that uses it, dev or not, accepts it.
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { envFileProblem, fixedTokenNotice, resolveToken, UsageError } from '../src/cli.js';
import { childEnvironment } from '../src/server/command.js';

const DEFAULT_DEV_PORT = 4517;

// PITWALL_DEV_PORT exists for the npm run dev tests in src/cli.test.ts, so they never need 4517.
const PORT = devPort(process.env.PITWALL_DEV_PORT);
const roots = process.argv.slice(2);
const { token, fixed } = devToken();

// With a fixed port, a busy one would make every restart fail. Check before starting.
if (!(await portIsFree(PORT))) {
  console.error(`pitwall dev: port ${PORT} on 127.0.0.1 is already in use. Stop whatever holds it, then run npm run dev again.`);
  process.exit(1);
}

// mkdtemp makes the directory 0700, so no one else can create the marker first.
const markerDir = mkdtempSync(join(tmpdir(), 'pitwall-dev-'));
process.on('exit', () => rmSync(markerDir, { recursive: true, force: true }));

const children: ChildProcess[] = [
  // Development mode builds in the #uikit gallery (web/src/App.tsx). Everything else is the same
  // build as npm run build's: Vite's mode doesn't change NODE_ENV, so React stays its production build.
  // The build needs no PITWALL_* variable, and must not hold a fixed token (W48 F7).
  run('vite', ['build', '--watch', '--mode', 'development'], childEnvironment(process.env, token)),
  run('tsx', ['watch', '--clear-screen=false', 'src/cli.ts', '--port', String(PORT), ...roots], {
    ...process.env,
    PITWALL_TOKEN: token,
    PITWALL_OPEN_MARKER: join(markerDir, 'opened'),
    // This dev run's own token, which the CLI prints; never set for a fixed one.
    ...(fixed ? {} : { PITWALL_TOKEN_PER_RUN: '1' }),
  }),
];

// When either process exits, stop the other, and exit with the first one's code.
function run(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, { stdio: 'inherit', env });
  child.on('exit', (code, signal) => {
    process.exitCode ??= code ?? (signal ? 1 : 0);
    for (const other of children) {
      if (other !== child && other.exitCode === null && other.signalCode === null) other.kill('SIGTERM');
    }
  });
  return child;
}

// A Ctrl-C in the terminal already reaches the children, which share its process
// group. Forwarding it as well makes tsx watch see a second signal and SIGKILL
// the CLI before it closes. So forward only to children still running a moment
// later, as when the signal was sent to this process alone.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    setTimeout(() => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      }
    }, 1000).unref();
  });
}

/**
 * PITWALL_TOKEN from the environment or the pitwall repo's .env, checked as the CLI checks it, or
 * else one random token for this run. Exits 1 with the CLI's message for one that isn't valid.
 */
function devToken(): { token: string; fixed: boolean } {
  // An empty PITWALL_TOKEN counts as unset (resolveToken), so the repo's .env can still set it.
  if (process.env.PITWALL_TOKEN === '') delete process.env.PITWALL_TOKEN;
  const fromEnvironment = process.env.PITWALL_TOKEN !== undefined;
  // The repo's root, from this file's own place: never the current directory, whose .env isn't ours.
  const envFile = join(fileURLToPath(new URL('..', import.meta.url)), '.env');
  loadPrivateEnvFile(envFile);
  // Only this script says a token is its own, for the one it mints, below. From the environment or
  // the .env, it would mark a fixed token as per-run: printed at every restart, and its launch file
  // deleted at the first authentication (W58). So it's dropped from both, after the .env is read.
  delete process.env.PITWALL_TOKEN_PER_RUN;
  let resolved: string;
  try {
    resolved = resolveToken(process.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`pitwall dev: ${error.message}${fromEnvironment ? '' : ` (from ${envFile})`}`);
    process.exit(1);
  }
  // Fixed when a PITWALL_TOKEN that isn't empty was given, from the environment or the .env.
  const fixed = process.env.PITWALL_TOKEN !== undefined && process.env.PITWALL_TOKEN !== '';
  if (fixed) console.error(`pitwall dev: ${fixedTokenNotice(fromEnvironment ? undefined : '.env')}`);
  return { token: resolved, fixed };
}

/**
 * Adds the variables in `file`, when it exists, to process.env, without replacing any already set,
 * as process.loadEnvFile() does. It's opened first and checked through that open file, so what's
 * checked is what's read: a file that isn't yours, or that group or others can read or change, stops
 * the script before anything in it is read (envFileProblem in src/cli.ts). O_NONBLOCK, so a FIFO in
 * its place is refused rather than waited on.
 */
function loadPrivateEnvFile(file: string): void {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.error(`pitwall dev: couldn't open ${file} (${(error as Error).message})`);
    process.exit(1);
  }
  try {
    const problem = envFileProblem(file, fstatSync(fd));
    if (problem !== undefined) {
      console.error(`pitwall dev: ${problem}`);
      process.exit(1);
    }
    for (const [name, value] of Object.entries(parseEnv(readFileSync(fd, 'utf8')))) {
      if (value !== undefined && process.env[name] === undefined) process.env[name] = value;
    }
  } finally {
    closeSync(fd);
  }
}

function devPort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_DEV_PORT;
  const port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    console.error(`pitwall dev: PITWALL_DEV_PORT must be a port from 1 to 65535, not "${raw}"`);
    process.exit(1);
  }
  return port;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host: '127.0.0.1' }, () => probe.close(() => resolve(true)));
  });
}
