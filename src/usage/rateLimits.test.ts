import { describe, expect, it } from 'vitest';
import type { RecapSpawner } from '../recaps/call.js';
import { createRateLimitsReader, parseRateLimits, RATE_LIMITS_INPUT, rateLimitsArgs, readRateLimits } from './rateLimits.js';

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

  it('keeps a window whose reset is null', () => {
    const result = parseRateLimits(stream(report([row('weekly_all', 15, null)])), READ_AT);
    expect(result).toMatchObject({ status: 'available', sevenDay: { usedPercentage: 15, resetsAt: null } });
  });

  it('drops a row that is not as documented', () => {
    for (const bad of [row('weekly_all', '15', null), row('weekly_all', -1, null), row('weekly_all', Number.NaN, null), row('weekly_all', 15, 'not a date'), row('weekly_all', 15, 1794744000)]) {
      const result = parseRateLimits(stream(report([bad])), READ_AT);
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
  input?: string;
  env: Record<string, string>;
}

function fakeSpawner(answer: { stdout?: string; code?: number; notFound?: boolean; hang?: boolean }, calls: FakeCall[]): RecapSpawner {
  return (_file, args, options, events) => {
    const call: FakeCall = { args, env: options.env };
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
    const result = await readRateLimits({
      spawn: fakeSpawner({ stdout: stream(report([row('weekly_all', 15, '2026-11-15T12:00:00Z')])) }, calls),
      env: { PATH: '/usr/bin', NODE_OPTIONS: '--require /made/up.js' },
      onPid: (pid) => pids.push(pid),
      now: () => READ_AT,
    });
    expect(result).toMatchObject({ status: 'available', sevenDay: { usedPercentage: 15 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(RATE_LIMITS_INPUT);
    expect(calls[0]?.args).toEqual(rateLimitsArgs());
    expect(calls[0]?.args).toEqual(expect.arrayContaining(['-p', '--no-session-persistence', 'stream-json', '--strict-mcp-config']));
    // The relay's environment: nothing that loads code.
    expect(calls[0]?.env.NODE_OPTIONS).toBeUndefined();
    expect(pids).toEqual([4242]);
  });

  it('is unavailable when claude is missing, fails or times out', async () => {
    expect(await readRateLimits({ spawn: fakeSpawner({ notFound: true }, []), now: () => READ_AT })).toEqual({ status: 'unavailable', readAt: READ_AT, reason: 'not-found' });
    expect(await readRateLimits({ spawn: fakeSpawner({ stdout: '', code: 1 }, []) })).toMatchObject({ reason: 'failed' });
    expect(await readRateLimits({ spawn: fakeSpawner({ hang: true }, []), timeoutMs: 5 })).toMatchObject({ reason: 'timeout' });
  });
});

describe('createRateLimitsReader', () => {
  it('keeps a read for the TTL and shares a call in flight', async () => {
    const calls: FakeCall[] = [];
    let now = READ_AT;
    const reader = createRateLimitsReader({
      spawn: fakeSpawner({ stdout: stream(report([row('weekly_all', 15, null)])) }, calls),
      now: () => now,
      ttlMs: 60_000,
    });
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

  it('keeps an unavailable read too, so a failing endpoint is not called again at once', async () => {
    const calls: FakeCall[] = [];
    const reader = createRateLimitsReader({ spawn: fakeSpawner({ stdout: '', code: 1 }, calls), now: () => READ_AT });
    await reader.read();
    await reader.read();
    expect(calls).toHaveLength(1);
    expect(reader.last()).toMatchObject({ status: 'unavailable', reason: 'failed' });
  });
});
