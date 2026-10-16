// `npm run dev [-- root...]`: rebuilds the web UI on change (`vite build --watch`)
// and restarts the server on change (`tsx watch src/cli.ts`), passing the roots
// through. There is no Vite dev server in M1: the pitwall server serves dist/web,
// so the UI is always same-origin.
//
// tsx watch restarts the CLI on every change. So that a restart doesn't mint a
// new token and open another browser tab, this script generates one random
// token per `npm run dev` run, passes it to the CLI as PITWALL_TOKEN, pins the
// port, and opens the browser itself, once. Every security check stays on; the
// web UI reconnects after each restart with the token it already has.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { openBrowser } from '../src/cli.js';

const PORT = 4517;
const origin = `http://127.0.0.1:${PORT}`;
const roots = process.argv.slice(2);
const token = randomBytes(32).toString('base64url');

// With a fixed port, a busy one would make every restart fail, and the browser
// would open on whatever else holds the port. Check before starting.
if (!(await portIsFree(PORT))) {
  console.error(`pitwall dev: port ${PORT} on 127.0.0.1 is already in use. Stop whatever holds it, then run npm run dev again.`);
  process.exit(1);
}

let stopping = false;

const children: ChildProcess[] = [
  run('vite', ['build', '--watch'], process.env),
  run('tsx', ['watch', '--clear-screen=false', 'src/cli.ts', '--port', String(PORT), ...roots], {
    ...process.env,
    PITWALL_TOKEN: token,
    PITWALL_NO_OPEN: '1',
  }),
];

if (process.env.PITWALL_NO_OPEN !== '1') void openWhenReady();

// When either process exits, stop the other, and exit with the first one's code.
function run(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(command, args, { stdio: 'inherit', env });
  child.on('exit', (code, signal) => {
    stopping = true;
    process.exitCode ??= code ?? (signal ? 1 : 0);
    for (const other of children) {
      if (other !== child && other.exitCode === null && other.signalCode === null) other.kill('SIGTERM');
    }
  });
  return child;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    for (const child of children) child.kill(signal);
  });
}

/** Opens the browser once the server answers `/` with the built UI, so the first page isn't the 503. */
async function openWhenReady(): Promise<void> {
  while (!stopping) {
    try {
      const res = await fetch(`${origin}/`, { signal: AbortSignal.timeout(1000) });
      await res.body?.cancel();
      if (res.ok) {
        openBrowser(`${origin}/#token=${token}`);
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host: '127.0.0.1' }, () => probe.close(() => resolve(true)));
  });
}
