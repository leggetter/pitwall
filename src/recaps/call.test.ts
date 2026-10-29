// One recap call's process (call.ts): the input on stdin, stdout collected, a timeout, a cap on what
// it prints, and no shell. The child is Node running a short script, never claude.
import { describe, expect, it } from 'vitest';
import { MAX_STDOUT_CHARS, runRecapCall, spawnRecapChild, type CallOptions } from './call.js';

const never = new Promise<void>(() => undefined);

function options(script: string, overrides: Partial<CallOptions> = {}): CallOptions {
  return {
    claudeBin: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    input: 'the input, with "quotes" and $(no shell)',
    timeoutMs: 10_000,
    spawn: spawnRecapChild,
    onPid: () => undefined,
    stopped: never,
    ...overrides,
  };
}

describe('runRecapCall', () => {
  it('writes the input to stdin, closes it, and collects stdout, with the pid known first', async () => {
    const pids: number[] = [];
    const outcome = await runRecapCall(
      options("let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({got:s})))", { onPid: (pid) => pids.push(pid) }),
    );
    expect(outcome).toEqual({ kind: 'exit', code: 0, signal: null, stdout: JSON.stringify({ got: 'the input, with "quotes" and $(no shell)' }) });
    expect(pids).toHaveLength(1);
  });

  it('reports the exit code of a call that fails', async () => {
    expect(await runRecapCall(options('process.exit(3)'))).toEqual({ kind: 'exit', code: 3, signal: null, stdout: '' });
  });

  it("stops a call that doesn't finish in time", async () => {
    expect(await runRecapCall(options('setInterval(() => {}, 1000)', { timeoutMs: 100 }))).toEqual({ kind: 'timeout' });
  });

  it('stops a call that prints far more than a recap', async () => {
    expect(await runRecapCall(options(`process.stdout.write('x'.repeat(${MAX_STDOUT_CHARS + 10}));setInterval(() => {}, 1000)`))).toEqual({ kind: 'too-large' });
  });

  it('stops a call when pitwall closes', async () => {
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const outcome = runRecapCall(options('setInterval(() => {}, 1000)', { stopped }));
    setTimeout(stop, 50);
    expect(await outcome).toEqual({ kind: 'stopped' });
  });

  it('says when the program is missing', async () => {
    expect(await runRecapCall(options('', { claudeBin: '/made-up/no-such-program' }))).toEqual({ kind: 'spawn-error', notFound: true });
  });
});
