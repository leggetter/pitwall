// `npm run dev [-- root...]`: rebuilds the web UI on change (`vite build --watch`)
// and restarts the server on change (`tsx watch src/cli.ts`), passing the roots
// through. There is no Vite dev server: the pitwall server serves dist/web, so
// the UI is always same-origin.
//
// tsx watch restarts the CLI on every change. So that a restart doesn't mint a
// new token and open another browser tab, this script generates one random
// token per `npm run dev` run, passes it to the CLI as PITWALL_TOKEN (the
// environment, which other users can't read, never the command line), and pins
// the port. Every security check stays on. After each restart the web UI
// reconnects, answers a fresh challenge with the token it already has, and
// gets the new server's apiKey.
//
// The browser is opened once per dev run, by the CLI child itself, through its
// launch file, and only after that child's own server is listening on the
// port. This script passes it PITWALL_OPEN_MARKER, a path in a private temp
// directory: the first CLI to listen creates the marker and opens the browser,
// and later restarts find the marker and don't. A process squatting on the
// port never gets a browser pointed at it, because the CLI can't listen there
// and so never opens anything.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_DEV_PORT = 4517;

// PITWALL_DEV_PORT exists for the npm run dev tests in src/cli.test.ts, so they never need 4517.
const PORT = devPort(process.env.PITWALL_DEV_PORT);
const roots = process.argv.slice(2);
const token = randomBytes(32).toString('base64url');

// With a fixed port, a busy one would make every restart fail. Check before starting.
if (!(await portIsFree(PORT))) {
  console.error(`pitwall dev: port ${PORT} on 127.0.0.1 is already in use. Stop whatever holds it, then run npm run dev again.`);
  process.exit(1);
}

// mkdtemp makes the directory 0700, so no one else can create the marker first.
const markerDir = mkdtempSync(join(tmpdir(), 'pitwall-dev-'));
process.on('exit', () => rmSync(markerDir, { recursive: true, force: true }));

const children: ChildProcess[] = [
  run('vite', ['build', '--watch'], process.env),
  run('tsx', ['watch', '--clear-screen=false', 'src/cli.ts', '--port', String(PORT), ...roots], {
    ...process.env,
    PITWALL_TOKEN: token,
    PITWALL_OPEN_MARKER: join(markerDir, 'opened'),
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
