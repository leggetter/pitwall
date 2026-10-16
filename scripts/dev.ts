// `npm run dev [-- root...]`: rebuilds the web UI on change (`vite build --watch`)
// and restarts the server on change (`tsx watch src/cli.ts`), passing the roots
// through. There is no Vite dev server in M1: the pitwall server serves dist/web,
// so the UI is always same-origin.
import { spawn, type ChildProcess } from 'node:child_process';

const roots = process.argv.slice(2);

const children: ChildProcess[] = [
  run('vite', ['build', '--watch']),
  run('tsx', ['watch', '--clear-screen=false', 'src/cli.ts', ...roots]),
];

// When either process exits, stop the other, and exit with the first one's code.
function run(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    process.exitCode ??= code ?? (signal ? 1 : 0);
    for (const other of children) {
      if (other !== child && other.exitCode === null && other.signalCode === null) other.kill('SIGTERM');
    }
  });
  return child;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
  });
}
