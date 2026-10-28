import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentsSource, listedSessionIds, parseAgentRows, pidOwners, sessionPids } from './agents.js';
import { RunError, type RunFile } from './exec.js';

// Synthetic rows, shaped like Claude Code 2.1.301's and 2.1.302's `claude agents --json --all`.
const STARTED_MS = Date.parse('2026-10-01T09:00:00.000Z');

const interactive = {
  pid: 4101,
  cwd: '/work/repo-a',
  kind: 'interactive',
  startedAt: STARTED_MS,
  sessionId: '11111111-1111-4111-8111-111111111111',
  name: 'repo-a-1',
  status: 'busy',
};

const background = {
  pid: 4102,
  id: 'ab12cd34',
  cwd: '/work/repo-b',
  kind: 'background',
  startedAt: STARTED_MS,
  sessionId: '22222222-2222-4222-8222-222222222222',
  name: 'pitwall-test-bg',
  status: 'waiting',
  state: 'blocked',
  waitingFor: 'permission prompt',
};

const backgroundNoProcess = {
  id: 'ef56ab78',
  cwd: '/work/repo-b',
  kind: 'background',
  startedAt: STARTED_MS,
  sessionId: '33333333-3333-4333-8333-333333333333',
  name: 'pitwall-test-old',
  state: 'blocked',
};

// What `--all` adds: a background session that has finished, with no process,
// no status and an epoch-millisecond startedAt (Claude Code 2.1.302).
const backgroundFinished = {
  id: 'cd90ef12',
  cwd: '/work/repo-b',
  kind: 'background',
  startedAt: STARTED_MS,
  sessionId: '44444444-4444-4444-8444-444444444444',
  name: 'pitwall-test-done',
  state: 'done',
};

describe('parseAgentRows', () => {
  it('maps interactive rows, which have no state or waitingFor', () => {
    expect(parseAgentRows([interactive])).toEqual([
      {
        sessionId: interactive.sessionId,
        name: 'repo-a-1',
        kind: 'interactive',
        cwd: '/work/repo-a',
        pid: 4101,
        status: 'busy',
        startedAt: '2026-10-01T09:00:00.000Z',
      },
    ]);
  });

  it('maps background rows, with the short id', () => {
    expect(parseAgentRows([background])).toEqual([
      {
        sessionId: background.sessionId,
        shortId: 'ab12cd34',
        name: 'pitwall-test-bg',
        kind: 'background',
        cwd: '/work/repo-b',
        pid: 4102,
        status: 'waiting',
        state: 'blocked',
        waitingFor: 'permission prompt',
        startedAt: '2026-10-01T09:00:00.000Z',
      },
    ]);
  });

  it('leaves pid and status out when the process is gone', () => {
    const [row] = parseAgentRows([backgroundNoProcess]);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('pid');
    expect(row).not.toHaveProperty('status');
    expect(row?.state).toBe('blocked');
  });

  it('maps a finished background row from --all, with an epoch-millisecond startedAt', () => {
    expect(parseAgentRows([backgroundFinished])).toEqual([
      {
        sessionId: backgroundFinished.sessionId,
        shortId: 'cd90ef12',
        name: 'pitwall-test-done',
        kind: 'background',
        cwd: '/work/repo-b',
        state: 'done',
        startedAt: '2026-10-01T09:00:00.000Z',
      },
    ]);
    for (const state of ['stopped', 'failed'] as const) {
      expect(parseAgentRows([{ ...backgroundFinished, state }])[0]?.state).toBe(state);
    }
  });

  it('skips malformed rows and keeps the rest', () => {
    const rows = parseAgentRows([
      null,
      42,
      'not a row',
      [interactive],
      { ...interactive, sessionId: undefined },
      { ...interactive, sessionId: '' },
      { ...interactive, cwd: 'relative/path' },
      { ...interactive, cwd: 7 },
      { ...interactive, kind: 'cloud' },
      { ...interactive, startedAt: 'not a date' },
      { ...interactive, startedAt: undefined },
      background,
    ]);
    expect(rows.map((r) => r.sessionId)).toEqual([background.sessionId]);
  });

  it('ignores unknown fields and drops unknown status and state values', () => {
    const [row] = parseAgentRows([{ ...background, colour: 'teal', status: 'napping', state: 'paused', extra: { a: 1 } }]);
    expect(row).not.toHaveProperty('colour');
    expect(row).not.toHaveProperty('extra');
    expect(row).not.toHaveProperty('status');
    expect(row).not.toHaveProperty('state');
  });

  it('passes an undocumented waitingFor through', () => {
    const [row] = parseAgentRows([{ ...background, waitingFor: 'something new' }]);
    expect(row?.waitingFor).toBe('something new');
  });

  it('ignores a pid that is not a positive integer', () => {
    for (const pid of [0, -1, 1.5, '4101', null]) {
      const [row] = parseAgentRows([{ ...interactive, pid }]);
      expect(row).not.toHaveProperty('pid');
    }
  });

  it('accepts an ISO startedAt', () => {
    const [row] = parseAgentRows([{ ...interactive, startedAt: '2026-10-01T10:00:00+01:00' }]);
    expect(row?.startedAt).toBe('2026-10-01T09:00:00.000Z');
  });

  it('falls back to the short id, then the session id, for a missing name', () => {
    const rows = parseAgentRows([
      { ...background, name: undefined },
      { ...interactive, name: '' },
    ]);
    expect(rows.map((r) => r.name)).toEqual(['ab12cd34', '11111111']);
  });

  it('keeps one row per session id, preferring one with a process', () => {
    const rows = parseAgentRows([
      { ...backgroundNoProcess },
      { ...backgroundNoProcess, pid: 999, name: 'with-process' },
      { ...backgroundNoProcess, pid: 1000, name: 'later' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('with-process');
  });
});

describe('createAgentsSource', () => {
  function sourceWith(run: RunFile) {
    return createAgentsSource({ claudeBin: 'claude-test', run, cwd: '/tmp/pitwall-test-cwd', timeoutMs: 1234 });
  }

  it('runs `claude agents --json --all` from the given directory with the timeout', async () => {
    const calls: unknown[] = [];
    const source = sourceWith(async (file, args, options) => {
      calls.push({ file, args, options });
      return JSON.stringify([interactive]);
    });
    const result = await source.list();
    expect(result).toEqual({ ok: true, rows: parseAgentRows([interactive]), sessionIds: [interactive.sessionId], pids: [{ pid: interactive.pid, sessionId: interactive.sessionId }] });
    expect(calls).toEqual([
      { file: 'claude-test', args: ['agents', '--json', '--all'], options: { cwd: '/tmp/pitwall-test-cwd', timeoutMs: 1234 } },
    ]);
  });

  it('defaults to the temp directory and a 10 second timeout', async () => {
    let seen: { cwd?: string; timeoutMs: number } | undefined;
    const source = createAgentsSource({
      run: async (_file, _args, options) => {
        seen = options;
        return '[]';
      },
    });
    await source.list();
    expect(seen?.timeoutMs).toBe(10_000);
    expect(seen?.cwd).toBe(os.tmpdir());
  });

  it('resolves a relative claude path against the current directory, and leaves a bare name for PATH', async () => {
    const files: string[] = [];
    const run: RunFile = async (file) => {
      files.push(file);
      return '[]';
    };
    await createAgentsSource({ claudeBin: './bin/claude', run }).list();
    await createAgentsSource({ claudeBin: 'claude', run }).list();
    expect(files).toEqual([path.resolve('bin/claude'), 'claude']);
  });

  it('returns an empty list', async () => {
    expect(await sourceWith(async () => '[]\n').list()).toEqual({ ok: true, rows: [], sessionIds: [], pids: [] });
  });

  it('names every session id in its output, in rows parseAgentRows skips too, so none of them reads as ended (W81)', async () => {
    const odd = [
      { ...interactive, sessionId: '33333333-3333-4333-8333-333333333333', kind: 'remote' },
      { ...interactive, sessionId: '44444444-4444-4444-8444-444444444444', startedAt: undefined },
      { ...interactive, sessionId: '55555555-5555-4555-8555-555555555555', cwd: 'relative/dir' },
    ];
    const output = [interactive, ...odd, { ...background, sessionId: interactive.sessionId }, { sessionId: 42 }, 'not a row', null];
    const result = await sourceWith(async () => JSON.stringify(output)).list();
    if (!result.ok) throw new Error(result.error);
    expect(result.rows.map((row) => row.sessionId)).toEqual([interactive.sessionId]);
    expect(result.sessionIds).toEqual([interactive.sessionId, ...odd.map((row) => row.sessionId)]);
    expect([...listedSessionIds(result)]).toEqual(result.sessionIds);
  });

  it('names every pid in its output, in rows parseAgentRows skips or merges too, so End session sees a pid two rows share (W90)', async () => {
    const otherId = '33333333-3333-4333-8333-333333333333';
    const output = [
      interactive,
      // Dropped by parseAgentRows: an unknown kind, a relative cwd, no startedAt.
      { ...interactive, sessionId: otherId, kind: 'remote' },
      { ...interactive, sessionId: '44444444-4444-4444-8444-444444444444', cwd: 'relative/dir', pid: 4103 },
      { ...interactive, sessionId: '55555555-5555-4555-8555-555555555555', startedAt: undefined, pid: '4104' },
      // The same session again, with another process: parseAgentRows keeps one row per session id.
      { ...interactive, pid: 4105 },
      // No session id, and pids that aren't one.
      { pid: interactive.pid },
      { ...background, pid: 0 },
      { ...background, pid: -3 },
      { ...background, pid: 1.5 },
      { ...background, pid: '12a' },
      'not a row',
    ];
    const result = await sourceWith(async () => JSON.stringify(output)).list();
    if (!result.ok) throw new Error(result.error);
    // One parsed row per session id; the background rows with a pid that isn't one parse as a row with no process.
    expect(result.rows.map((row) => [row.sessionId, row.pid])).toEqual([
      [interactive.sessionId, interactive.pid],
      [background.sessionId, undefined],
    ]);
    expect(pidOwners(result, interactive.pid)).toEqual([interactive.sessionId, otherId, undefined]);
    expect(pidOwners(result, 4104)).toEqual(['55555555-5555-4555-8555-555555555555']);
    expect([...sessionPids(result, interactive.sessionId)]).toEqual([interactive.pid, 4105]);
    expect(result.pids?.some((each) => each.pid <= 0 || !Number.isInteger(each.pid))).toBe(false);
  });

  it("pidOwners and sessionPids read the rows, for a source that doesn't say", () => {
    const rows = parseAgentRows([interactive, background]);
    expect(pidOwners({ ok: true, rows }, interactive.pid)).toEqual([interactive.sessionId]);
    expect(pidOwners({ ok: true, rows }, 9999)).toEqual([]);
    expect([...sessionPids({ ok: true, rows }, background.sessionId)]).toEqual([background.pid]);
  });

  it("listedSessionIds adds the rows' ids, for a source that doesn't say", () => {
    const rows = parseAgentRows([interactive, background]);
    expect([...listedSessionIds({ ok: true, rows })]).toEqual([interactive.sessionId, background.sessionId]);
    expect([...listedSessionIds({ ok: true, rows, sessionIds: ['66666666-6666-4666-8666-666666666666'] })]).toEqual([
      '66666666-6666-4666-8666-666666666666',
      interactive.sessionId,
      background.sessionId,
    ]);
  });

  const failures: Array<[string, RunFile, string]> = [
    ['a missing binary', async () => Promise.reject(new RunError('not-found', 'x')), 'claude agents --json --all failed: claude-test was not found'],
    ['a timeout', async () => Promise.reject(new RunError('timeout', 'timed out after 10s')), 'claude agents --json --all timed out after 10s'],
    ['a non-zero exit', async () => Promise.reject(new RunError('exit', 'exited with code 1', 1)), 'claude agents --json --all exited with code 1'],
    ['an unexpected error', async () => Promise.reject(new Error('boom\nsecond line')), 'claude agents --json --all failed: boom second line'],
    ['output that is not JSON', async () => 'Starting background service…', "claude agents --json --all printed output that isn't JSON"],
    ['JSON that is not an array', async () => '{"sessions":[]}', "claude agents --json --all didn't print a JSON array"],
  ];

  for (const [what, run, error] of failures) {
    it(`reports ${what} as a one-line error without throwing`, async () => {
      const result = await sourceWith(run).list();
      expect(result).toEqual({ ok: false, error });
      if (!result.ok) expect(result.error).not.toContain('\n');
    });
  }
});
