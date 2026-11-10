import { describe, expect, it } from 'vitest';
import { MAX_STDOUT_CHARS, type RecapSpawner } from '../recaps/call.js';
import { OWN_NAME_MS } from '../recaps/engine.js';
import {
  createRateLimitsReader,
  parseRateLimits,
  RATE_LIMITS_INPUT,
  RATE_LIMITS_NAME,
  rateLimitsArgs,
  readRateLimits,
  type RateLimitsReaderOptions,
} from './rateLimits.js';

// Made-up `/usage` output, shaped like `claude -p --output-format stream-json`'s (spike 013): no
// real account's figures, and a text that must never be kept.
const SECRET = 'SECRET-TEXT-NEVER-KEPT';
const READ_AT = Date.parse('2026-11-10T09:00:00Z');

function row(kind: string, percent: unknown, resetsAt: unknown, extra: Record<string, unknown> = {}) {
  return { kind, group: kind === 'session' ? 'session' : 'weekly', percent, resets_at: resetsAt, scope: null, severity: 'normal', is_active: false, ...extra };
}

function stream(usageReport: unknown, options: { omitReport?: boolean } = {}): string {
  const assistant: Record<string, unknown> = {
    type: 'assistant',
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: SECRET }] },
    session_id: 'made-up',
  };
  if (!options.omitReport) assistant.usage_report = usageReport;
  return [
    { type: 'system', subtype: 'init', session_id: 'made-up' },
    assistant,
    { type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 0, result: SECRET },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
}

function report(limits: unknown) {
  return { session: { total_cost_usd: 0, model_usage: {} }, rate_limits: limits === null ? null : { limits, extra_usage: null } };
}

describe('parseRateLimits', () => {
  it('reads the five-hour and weekly rows, to the minute', () => {
    const out = stream(
      report([
        row('session', 42.5, '2026-11-10T13:00:00.4+00:00'),
        row('weekly_all', 15, '2026-11-15T11:59:59.869753+00:00', { is_active: true }),
        row('weekly_scoped', 3, '2026-11-15T12:00:00+00:00', { scope: { model: { display_name: 'Made-up' } } }),
      ]),
    );
    const result = parseRateLimits(out, READ_AT);
    expect(result).toEqual({
      status: 'available',
      readAt: READ_AT,
      fiveHour: { usedPercentage: 42.5, resetsAt: Date.parse('2026-11-10T13:00:00Z') / 1000 },
      sevenDay: { usedPercentage: 15, resetsAt: Date.parse('2026-11-15T12:00:00Z') / 1000 },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('leaves a window null when the server sends no row for it', () => {
    const result = parseRateLimits(stream(report([row('weekly_all', 15, '2026-11-15T12:00:00Z')])), READ_AT);
    expect(result).toMatchObject({ status: 'available', fiveHour: null, sevenDay: { usedPercentage: 15 } });
  });

  it('keeps the percentage when the reset is null, missing or unreadable', () => {
    for (const resets of [null, undefined, 'not a date', 1794744000]) {
      const result = parseRateLimits(stream(report([row('weekly_all', 15, resets)])), READ_AT);
      expect(result).toMatchObject({ status: 'available', sevenDay: { usedPercentage: 15, resetsAt: null } });
    }
  });

  it('keeps a percentage over 100, up to 1000', () => {
    const result = parseRateLimits(stream(report([row('weekly_all', 1000, null)])), READ_AT);
    expect(result).toMatchObject({ sevenDay: { usedPercentage: 1000 } });
  });

  it('drops a row whose percentage is unreadable', () => {
    for (const percent of ['15', -1, 1000.5, Number.NaN, null]) {
      const result = parseRateLimits(stream(report([row('weekly_all', percent, '2026-11-15T12:00:00Z')])), READ_AT);
      expect(result).toMatchObject({ status: 'available', sevenDay: null });
    }
  });

  it('is available with both windows null for an empty list', () => {
    expect(parseRateLimits(stream(report([])), READ_AT)).toMatchObject({ status: 'available', fiveHour: null, sevenDay: null });
  });

  it('is unavailable without a usage_report', () => {
    expect(parseRateLimits(stream(undefined, { omitReport: true }), READ_AT)).toEqual({ status: 'unavailable', readAt: READ_AT, reason: 'no-report' });
    expect(parseRateLimits('', READ_AT)).toMatchObject({ reason: 'no-report' });
    expect(parseRateLimits('not json\n{broken', READ_AT)).toMatchObject({ reason: 'no-report' });
  });

  it('is unavailable when the report has no limits', () => {
    expect(parseRateLimits(stream(report(null)), READ_AT)).toMatchObject({ status: 'unavailable', reason: 'no-limits' });
    expect(parseRateLimits(stream({ rate_limits: { limits: null } }), READ_AT)).toMatchObject({ reason: 'no-limits' });
  });
});

interface FakeCall {
  args: string[];
  cwd: string;
  input?: string;
  env: Record<string, string>;
}

const DIR = '/made/up/rate-limits';

function fakeSpawner(answer: { stdout?: string; code?: number; notFound?: boolean; hang?: boolean }, calls: FakeCall[]): RecapSpawner {
  return (_file, args, options, events) => {
    const call: FakeCall = { args, cwd: options.cwd, env: options.env };
    calls.push(call);
    if (answer.notFound) {
      queueMicrotask(() => {
        events.error('not-found');
        events.exit(null, null);
      });
      return { pid: undefined, send: () => undefined, kill: () => undefined };
    }
    return {
      pid: 4242,
      send(input) {
        call.input = input;
        if (answer.hang) return;
        setTimeout(() => {
          if (answer.stdout !== undefined) events.stdout(answer.stdout);
          events.exit(answer.code ?? 0, null);
        }, 1);
      },
      kill() {
        setTimeout(() => events.exit(null, 'SIGTERM'), 1);
      },
    };
  };
}

describe('readRateLimits', () => {
  it('sends /usage over stdin with the isolated command line', async () => {
    const calls: FakeCall[] = [];
    const pids: number[] = [];
    const result = await readRateLimits('/made/up/dir', {
      spawn: fakeSpawner({ stdout: stream(report([row('weekly_all', 15, '2026-11-15T12:00:00Z')])) }, calls),
      env: { PATH: '/usr/bin', NODE_OPTIONS: '--require /made/up.js' },
      onPid: (pid: number) => pids.push(pid),
      now: () => READ_AT,
    });
    expect(result).toMatchObject({ status: 'available', sevenDay: { usedPercentage: 15 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(RATE_LIMITS_INPUT);
    expect(calls[0]?.args).toEqual(rateLimitsArgs());
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['-p', '--no-session-persistence', 'stream-json', '--strict-mcp-config']));
    expect(calls[0]?.cwd).toBe('/made/up/dir');
    // The recap call's environment: nothing that loads code, output capped.
    expect(calls[0]?.env.NODE_OPTIONS).toBeUndefined();
    expect(calls[0]?.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('4096');
    expect(pids).toEqual([4242]);
  });

  it('is unavailable when claude is missing, fails or times out', async () => {
    expect(await readRateLimits(DIR, { spawn: fakeSpawner({ notFound: true }, []), now: () => READ_AT })).toEqual({ status: 'unavailable', readAt: READ_AT, reason: 'not-found' });
    expect(await readRateLimits(DIR, { spawn: fakeSpawner({ stdout: '', code: 1 }, []) })).toMatchObject({ reason: 'failed' });
    expect(await readRateLimits(DIR, { spawn: fakeSpawner({ hang: true }, []), timeoutMs: 5 })).toMatchObject({ reason: 'timeout' });
  });

  it('is unavailable when the output is over the cap', async () => {
    const huge = `${'x'.repeat(MAX_STDOUT_CHARS)}\n${stream(report([row('weekly_all', 15, null)]))}`;
    expect(await readRateLimits(DIR, { spawn: fakeSpawner({ stdout: huge }, []) })).toMatchObject({ status: 'unavailable', reason: 'failed' });
  });

  it('is unavailable when spawn throws', async () => {
    const throwing: RecapSpawner = () => {
      throw new Error('made-up spawn failure');
    };
    expect(await readRateLimits(DIR, { spawn: throwing })).toMatchObject({ status: 'unavailable', reason: 'failed' });
  });

  it('is stopped when aborted', async () => {
    const controller = new AbortController();
    const pending = readRateLimits(DIR, { spawn: fakeSpawner({ hang: true }, []), signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ status: 'unavailable', reason: 'stopped' });
  });
});

function readerOptions(spawn: RecapSpawner, extra: Partial<RateLimitsReaderOptions> = {}): RateLimitsReaderOptions {
  return { dir: DIR, prepareDir: (dir) => dir, spawn, ...extra };
}

describe('createRateLimitsReader', () => {
  it('keeps a read for the TTL and shares a call in flight', async () => {
    const calls: FakeCall[] = [];
    let now = READ_AT;
    const reader = createRateLimitsReader(readerOptions(fakeSpawner({ stdout: stream(report([row('weekly_all', 15, null)])) }, calls), { now: () => now, ttlMs: 60_000 }));
    expect(reader.last()).toBeUndefined();
    const [a, b] = await Promise.all([reader.read(), reader.read()]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
    now += 59_000;
    await reader.read();
    expect(calls).toHaveLength(1);
    now += 2_000;
    await reader.read();
    expect(calls).toHaveLength(2);
    expect(reader.last()).toMatchObject({ status: 'available', readAt: now });
  });

  it('runs the call from its directory', async () => {
    const calls: FakeCall[] = [];
    const prepared: string[] = [];
    const reader = createRateLimitsReader(
      readerOptions(fakeSpawner({ stdout: stream(report([])) }, calls), {
        prepareDir: (dir) => {
          prepared.push(dir);
          return dir;
        },
      }),
    );
    await reader.read();
    expect(prepared).toEqual([DIR]);
    expect(calls[0]?.cwd).toBe(DIR);
  });

  it('is unavailable when its directory cannot be made', async () => {
    const calls: FakeCall[] = [];
    const reader = createRateLimitsReader(
      readerOptions(fakeSpawner({ stdout: stream(report([])) }, calls), {
        prepareDir: () => {
          throw new Error('made-up');
        },
      }),
    );
    expect(await reader.read()).toMatchObject({ status: 'unavailable', reason: 'failed' });
    expect(calls).toHaveLength(0);
  });

  it('keeps a failed read for the shorter TTL, then reads again', async () => {
    const calls: FakeCall[] = [];
    let now = READ_AT;
    const reader = createRateLimitsReader(readerOptions(fakeSpawner({ stdout: '', code: 1 }, calls), { now: () => now, ttlMs: 300_000, failureTtlMs: 60_000 }));
    await reader.read();
    await reader.read();
    expect(calls).toHaveLength(1);
    expect(reader.last()).toMatchObject({ status: 'unavailable', reason: 'failed' });
    now += 59_000;
    await reader.read();
    expect(calls).toHaveLength(1);
    now += 2_000;
    await reader.read();
    expect(calls).toHaveLength(2);
  });

  it('does not keep a stopped read', async () => {
    const calls: FakeCall[] = [];
    const controller = new AbortController();
    const reader = createRateLimitsReader(readerOptions(fakeSpawner({ hang: true }, calls), { signal: controller.signal }));
    const pending = reader.read();
    controller.abort();
    const first = await pending;
    expect(first).toMatchObject({ status: 'unavailable', reason: 'stopped' });
    expect(reader.last()).toBeUndefined();
    // Read again rather than served from the cache; the signal is still aborted, so stopped again.
    const again = await reader.read();
    expect(again).not.toBe(first);
    expect(again).toMatchObject({ reason: 'stopped' });
    expect(calls).toHaveLength(1);
  });

  it('knows its own call by pid while it runs, by directory, and by name for a while', async () => {
    let now = READ_AT;
    let finish: (() => void) | undefined;
    const spawn: RecapSpawner = (_file, _args, _options, events) => ({
      pid: 777,
      send() {
        finish = () => {
          events.stdout(stream(report([])));
          events.exit(0, null);
        };
      },
      kill: () => undefined,
    });
    const reader = createRateLimitsReader(readerOptions(spawn, { now: () => now }));
    const other = { name: 'my-session', cwd: '/made/up/repo' };
    expect(reader.isOwn({ ...other, pid: 777 })).toBe(false);
    const pending = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(reader.isOwn({ ...other, pid: 777 })).toBe(true);
    finish?.();
    await pending;
    expect(reader.isOwn({ ...other, pid: 777 })).toBe(false);
    expect(reader.isOwn({ name: 'my-session', cwd: DIR })).toBe(true);
    expect(reader.isOwn(other)).toBe(false);
    const started = new Date(now).toISOString();
    expect(reader.isOwn({ ...other, name: RATE_LIMITS_NAME, startedAt: started })).toBe(true);
    now += OWN_NAME_MS + 1;
    expect(reader.isOwn({ ...other, name: RATE_LIMITS_NAME, startedAt: started })).toBe(false);
    expect(reader.isOwn({ ...other, name: RATE_LIMITS_NAME })).toBe(false);
  });
});
