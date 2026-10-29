// One recap call's process (call.ts): the input on stdin, stdout collected, a timeout, a cap on what
// it prints, and no shell. The child is Node running a short script, never claude.
import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { MAX_STDOUT_CHARS, runRecapCall, spawnRecapChild, type CallOptions, type RecapSpawner } from './call.js';

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
    signal: new AbortController().signal,
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

  it('stops a call when pitwall closes, and starts none once it has', async () => {
    const closing = new AbortController();
    const outcome = runRecapCall(options('setInterval(() => {}, 1000)', { signal: closing.signal }));
    setTimeout(() => closing.abort(), 50);
    expect(await outcome).toEqual({ kind: 'stopped' });
    let spawned = 0;
    const counting: RecapSpawner = (...args) => {
      spawned++;
      return spawnRecapChild(...args);
    };
    expect(await runRecapCall(options('', { signal: closing.signal, spawn: counting }))).toEqual({ kind: 'stopped' });
    expect(spawned).toBe(0);
  });

  it("lets go of a finished call: no listener of its stays on pitwall's signal (W110's review)", async () => {
    const closing = new AbortController();
    // A fake child, so a hundred calls take no time: each prints about 180 KB and exits.
    const spawn: RecapSpawner = (_file, _args, _options, events) => ({
      pid: 1,
      send() {
        events.stdout('x'.repeat(180_000));
        events.exit(0, null);
      },
      kill: () => undefined,
    });
    for (let i = 0; i < 100; i++) {
      const outcome = await runRecapCall(options('', { signal: closing.signal, spawn }));
      expect(outcome.kind).toBe('exit');
    }
    expect(getEventListeners(closing.signal, 'abort')).toHaveLength(0);
    // And one still running has its listener until it settles.
    const held: RecapSpawner = () => ({ pid: 2, send: () => undefined, kill: () => undefined });
    const pending = runRecapCall(options('', { signal: closing.signal, spawn: held, timeoutMs: 20 }));
    expect(getEventListeners(closing.signal, 'abort')).toHaveLength(1);
    expect(await pending).toEqual({ kind: 'timeout' });
    expect(getEventListeners(closing.signal, 'abort')).toHaveLength(0);
  });

  it('says when the program is missing', async () => {
    expect(await runRecapCall(options('', { claudeBin: '/made-up/no-such-program' }))).toEqual({ kind: 'spawn-error', notFound: true });
  });
});
