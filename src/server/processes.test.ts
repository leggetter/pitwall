// End session's process lookups (W90): ps's lines, parsed, and the calls made, through a fake runFile,
// so nothing here depends on this machine's processes. Made-up pids only.
import { describe, expect, it } from 'vitest';
import { RunError, type RunFile, type RunOptions } from '../index/exec.js';
import { ancestry, createProcesses, isClaudeCommand, parseLookupLine, parseParents, PS, PS_TIMEOUT_MS } from './processes.js';

interface Call {
  file: string;
  args: readonly string[];
  options: RunOptions;
}

function fakeRun(answer: (call: Call) => Promise<string>): RunFile & { calls: Call[] } {
  const calls: Call[] = [];
  const run: RunFile = (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    return answer(call);
  };
  return Object.assign(run, { calls });
}

describe('parseLookupLine', () => {
  it('reads the start time, in UTC, and the command', () => {
    expect(parseLookupLine('Mon Oct 26 10:20:56 2026     claude')).toEqual({ startedAtMs: Date.UTC(2026, 9, 26, 10, 20, 56), command: 'claude' });
    // A single-digit day is padded with a space.
    expect(parseLookupLine('Thu Oct  1 09:05:07 2026 /Users/pitwall-test/.local/bin/claude  ')).toEqual({
      startedAtMs: Date.UTC(2026, 9, 1, 9, 5, 7),
      command: '/Users/pitwall-test/.local/bin/claude',
    });
  });

  it('keeps a command with spaces whole', () => {
    expect(parseLookupLine('Sat Oct 24 13:19:16 2026     /Applications/Some App.app/Contents/MacOS/app')?.command).toBe('/Applications/Some App.app/Contents/MacOS/app');
  });

  it('refuses a line of any other shape, an unknown month and an impossible date', () => {
    expect(parseLookupLine('')).toBeUndefined();
    expect(parseLookupLine('Mon Oct 26 10:20:56 2026')).toBeUndefined();
    expect(parseLookupLine('2026-10-26T10:20:56Z claude')).toBeUndefined();
    expect(parseLookupLine('Mon Okt 26 10:20:56 2026 claude')).toBeUndefined();
    expect(parseLookupLine('Mon Feb 31 10:20:56 2026 claude')).toBeUndefined();
  });
});

describe('parseParents', () => {
  it('reads pid and parent pid pairs, and skips anything else', () => {
    const parents = parseParents('    1     0\n  333     1\n 4242   333\nnot a line\n\n');
    expect([...parents]).toEqual([
      [1, 0],
      [333, 1],
      [4242, 333],
    ]);
  });
});

describe('isClaudeCommand', () => {
  it('takes claude by name or as the last part of a path, and nothing else', () => {
    expect(isClaudeCommand('claude')).toBe(true);
    expect(isClaudeCommand('/Users/pitwall-test/.local/bin/claude')).toBe(true);
    expect(isClaudeCommand('node')).toBe(false);
    expect(isClaudeCommand('claude-code')).toBe(false);
    expect(isClaudeCommand('/opt/claude/bin/zsh')).toBe(false);
    expect(isClaudeCommand('2.1.312')).toBe(false);
  });
});

describe('ancestry', () => {
  const parents = new Map([
    [1, 0],
    [10, 1],
    [20, 10],
    [30, 20],
    // A loop, as a table read mid-change could show.
    [40, 41],
    [41, 40],
  ]);

  it('walks from a pid up to the first process', () => {
    expect(ancestry(30, parents)).toEqual([30, 20, 10, 1]);
  });

  it('stops at a pid with no parent listed, and at a loop', () => {
    expect(ancestry(99, parents)).toEqual([99]);
    expect(ancestry(40, parents)).toEqual([40, 41]);
  });
});

describe('createProcesses', () => {
  it('runs /bin/ps with no shell, in UTC and the C locale, for one pid’s start time and command only', async () => {
    const run = fakeRun(async () => 'Mon Oct 26 10:20:56 2026     claude\n');
    const found = await createProcesses({ run }).lookup(4242);
    expect(found).toEqual({ ok: true, process: { startedAtMs: Date.UTC(2026, 9, 26, 10, 20, 56), command: 'claude' } });
    expect(run.calls).toHaveLength(1);
    const [call] = run.calls;
    expect(call?.file).toBe(PS);
    // Never `args` or `command`, which would read a command line.
    expect(call?.args).toEqual(['-o', 'lstart=', '-o', 'comm=', '-p', '4242']);
    expect(call?.options.env).toMatchObject({ TZ: 'UTC0', LC_ALL: 'C' });
  });

  it('gives one ps the time it’s given, at most its own limit, as End session’s wait does with the time left (W90)', async () => {
    const run = fakeRun(async () => 'Mon Oct 26 10:20:56 2026     claude\n');
    const processes = createProcesses({ run });
    await processes.lookup(4242);
    await processes.lookup(4242, 300);
    await processes.lookup(4242, 60_000);
    await processes.lookup(4242, 0);
    expect(run.calls.map((call) => call.options.timeoutMs)).toEqual([PS_TIMEOUT_MS, 300, PS_TIMEOUT_MS, 1]);
  });

  it('says there is no process when ps exits 1, and asks nothing for a pid that isn’t one', async () => {
    const run = fakeRun(async () => {
      throw new RunError('exit', 'exited with code 1', 1);
    });
    const processes = createProcesses({ run });
    expect(await processes.lookup(4242)).toEqual({ ok: true });
    expect(await processes.lookup(0)).toEqual({ ok: true });
    expect(await processes.lookup(-1)).toEqual({ ok: true });
    expect(await processes.lookup(1.5)).toEqual({ ok: true });
    expect(run.calls).toHaveLength(1);
  });

  it('fails soft when ps fails, or prints what it can’t read', async () => {
    const missing = createProcesses({ run: fakeRun(async () => Promise.reject(new RunError('not-found', '/bin/ps was not found'))) });
    expect(await missing.lookup(4242)).toEqual({ ok: false, error: 'ps /bin/ps was not found' });
    expect((await missing.parents()).ok).toBe(false);
    const garbled = createProcesses({ run: fakeRun(async () => 'something else\n') });
    expect(await garbled.lookup(4242)).toEqual({ ok: false, error: "ps printed a line pitwall can't read" });
    const twice = createProcesses({ run: fakeRun(async () => 'Mon Oct 26 10:20:56 2026 claude\nMon Oct 26 10:20:56 2026 claude\n') });
    expect((await twice.lookup(4242)).ok).toBe(false);
    expect(await createProcesses({ run: fakeRun(async () => '\n') }).lookup(4242)).toEqual({ ok: true });
  });

  it('reads every pid’s parent, and nothing else, and fails on an empty table', async () => {
    const run = fakeRun(async () => '    1     0\n 4242     1\n');
    const parents = await createProcesses({ run }).parents();
    expect(parents).toEqual({ ok: true, parents: new Map([[1, 0], [4242, 1]]) });
    expect(run.calls[0]?.args).toEqual(['-A', '-o', 'pid=', '-o', 'ppid=']);
    expect((await createProcesses({ run: fakeRun(async () => '') }).parents()).ok).toBe(false);
  });
});
