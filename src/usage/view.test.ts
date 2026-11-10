// The Usage view's figures (W158): the window, each response once, cache reads and writes apart,
// rows by stand-in cost, main sessions against sub-agents, and kept days for deleted transcripts.
// Then the source: the plan's week read only when asked, and its `/usage` call known as its own.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USAGE_ROWS_MAX, type UsagePlan } from '../shared/protocol.js';
import { DayStore, emptyTokens, localDay, type DayTotals } from './days.js';
import { READINGS_FILE_NAME, readReadingsFile } from './readings.js';
import type { RateLimits, RateLimitsReader } from './rateLimits.js';
import type { CallRecord, FileScan } from './scan.js';
import { createUsageSource, RUN_RATE_READ_MS } from './service.js';
import { buildUsageView, readScans, startOfDay, usageWindow, type BuildViewOptions } from './view.js';

// Local time, so days are the machine's days, as the view's are.
const NOW = new Date(2026, 10, 10, 15, 30).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PITWALL_HOME = '/made-up/home/.pitwall';

function rec(id: string, at: number, u: Partial<CallRecord> = {}): CallRecord {
  return { id, at, model: 'claude-opus-5-5', input: 0, cacheWrite5m: 0, cacheWrite1h: 0, splitKnown: true, cacheRead: 0, output: 0, sidechain: false, toolContext: 0, ...u };
}

function scan(sessionId: string, calls: CallRecord[], extra: Partial<FileScan> = {}): FileScan {
  return {
    file: `/made-up/projects/p/${sessionId}.jsonl`,
    sessionId,
    subagent: false,
    cwd: '/made-up/work/repo',
    names: [],
    calls,
    toolResults: [],
    lines: calls.length,
    parsed: calls.length,
    malformed: 0,
    noTimestamp: 0,
    outsideWindow: 0,
    noUsage: 0,
    synthetic: 0,
    sameFileDuplicates: 0,
    usageDiffered: 0,
    unreadable: false,
    ...extra,
  };
}

const PLAN: UsagePlan = { status: 'unavailable', readAt: new Date(NOW).toISOString(), reason: 'no-report' };

function options(overrides: Partial<BuildViewOptions> = {}): BuildViewOptions {
  return {
    window: usageWindow('14d', NOW, null),
    plan: PLAN,
    home: '/made-up/home',
    pitwallHome: PITWALL_HOME,
    resolveRepo: async (cwd) => cwd,
    keptDay: () => undefined,
    scan: { at: new Date(NOW).toISOString(), files: 0, unreadable: 0, malformed: 0 },
    ...overrides,
  };
}

describe('the window', () => {
  it('is the plan’s week from its reset, or today and the six days before when there is none', () => {
    const resetsAt = NOW + 2 * DAY;
    expect(usageWindow('week', NOW, resetsAt)).toMatchObject({ since: resetsAt - 7 * DAY, until: NOW, from: 'reset', bucket: 'day' });
    // A reset already past, from a kept read: the week after it.
    expect(usageWindow('week', NOW, NOW - HOUR)).toMatchObject({ since: NOW - HOUR, from: 'reset' });
    const fallback = usageWindow('week', NOW, null);
    expect(fallback).toMatchObject({ from: 'days', bucket: 'day' });
    expect(new Date(fallback.since).getDate()).toBe(4);
    expect(new Date(fallback.since).getHours()).toBe(0);
    expect(new Date(usageWindow('30d', NOW, null).since).getMonth()).toBe(9);
    expect(usageWindow('24h', NOW, resetsAt)).toMatchObject({ since: Math.floor((NOW - 23 * HOUR) / HOUR) * HOUR, from: 'hours', bucket: 'hour' });
  });
});

describe('the view', () => {
  it('counts each response once, keeps cache reads and writes apart, and ranks by stand-in cost', async () => {
    const t = NOW - 2 * HOUR;
    // A session that reads a lot of cache but costs little, and one whose output costs more.
    const reader = scan('aaaaaaaa-0000-4000-8000-000000000001', [rec('r1', t, { cacheRead: 1_000_000, input: 10 })], { cwd: '/made-up/work/cheap' });
    const writer = scan('aaaaaaaa-0000-4000-8000-000000000002', [rec('w1', t, { output: 50_000, cacheWrite5m: 2000, cacheWrite1h: 1000 }), rec('w2', t, { output: 1, sidechain: true })], {
      cwd: '/made-up/work/dear',
    });
    // Its sub-agent's own file has w2 too, the newer layout: counted once, as the sub-agent's.
    const sub = scan('aaaaaaaa-0000-4000-8000-000000000002', [rec('w2', t, { output: 1 }), rec('s1', t, { output: 100, model: 'claude-haiku-4-5' })], {
      file: '/made-up/projects/p/aaaaaaaa-0000-4000-8000-000000000002/subagents/agent-1.jsonl',
      subagent: true,
      cwd: undefined,
    });
    // pitwall's own recap call, by its directory.
    const recap = scan('aaaaaaaa-0000-4000-8000-000000000003', [rec('p1', t, { input: 5, model: 'claude-haiku-5-5' })], { cwd: `${PITWALL_HOME}/recap` });
    const view = await buildUsageView(readScans([reader, writer, sub, recap]), options());

    expect(view.totals).toMatchObject({ calls: 5, input: 15, cacheWrite: 3000, cacheRead: 1_000_000, output: 50_101 });
    expect(view.costLabel).toMatch(/stand-in/);
    expect(view.byRepo.rows.map((row) => row.repo)).toEqual(['/made-up/work/dear', '/made-up/work/cheap', "pitwall's own: recap"]);
    expect(view.byRepo.rows[0]).toMatchObject({ sessions: 1, calls: 3, cacheWrite: 3000, cacheRead: 0 });
    const [first] = view.bySession.rows;
    expect(first).toMatchObject({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000002', kind: 'main', model: 'claude-opus-5-5', subagentRuns: 1 });
    expect(first?.subagentCost).toBeGreaterThan(0);
    expect(view.bySession.rows.find((row) => row.repo === "pitwall's own: recap")?.kind).toBe('pitwall');
    expect(view.split.main).toMatchObject({ calls: 3, sessions: 3 });
    expect(view.split.subagent).toMatchObject({ calls: 2, runs: 1 });
    expect(view.byModel.map((row) => row.model)).toEqual(['claude-opus-5-5', 'claude-haiku-4-5', 'claude-haiku-5-5']);
    expect(view.buckets).toHaveLength(14);
    expect(view.buckets.at(-1)).toMatchObject({ calls: 5, start: new Date(startOfDay(NOW)).toISOString() });
    expect(view.history).toBeUndefined();
    // No field sums cache reads with the rest.
    expect(Object.keys(view.totals).sort()).toEqual(['cacheRead', 'cacheWrite', 'calls', 'cost', 'input', 'output']);
  });

  it('buckets by hour for 24 hours, and leaves out calls outside the window', async () => {
    const view = await buildUsageView(
      readScans([scan('aaaaaaaa-0000-4000-8000-000000000001', [rec('a', NOW - 30 * HOUR, { output: 1 }), rec('b', NOW - HOUR, { output: 2 }), rec('c', NOW - 5 * 60_000, { output: 3 })])]),
      options({ window: usageWindow('24h', NOW, null) }),
    );
    expect(view.buckets).toHaveLength(24);
    expect(view.totals.output).toBe(5);
    expect(view.buckets.filter((bucket) => bucket.calls > 0).map((bucket) => bucket.output)).toEqual([2, 3]);
  });

  it('counts a kept day whose transcripts are gone in the totals, by day and by model, and in no row', async () => {
    const gone = startOfDay(NOW) - 5 * DAY + 10 * HOUR;
    const kept: DayTotals = {
      day: localDay(gone),
      main: { ...emptyTokens(), calls: 10, input: 100, cacheRead: 5000, output: 50, cost: 1 },
      subagent: { ...emptyTokens(), calls: 2, output: 10, cost: 0.5 },
      models: { 'claude-sonnet-5': { ...emptyTokens(), calls: 12, input: 100, cacheRead: 5000, output: 60, cost: 1.5 } },
    };
    // One call that day is still in a transcript; the rest were deleted.
    const left = scan('aaaaaaaa-0000-4000-8000-000000000001', [rec('k1', gone, { output: 5, model: 'claude-sonnet-5' }), rec('today', NOW - HOUR, { output: 1 })]);
    const view = await buildUsageView(readScans([left]), options({ keptDay: (key) => (key === kept.day ? kept : undefined) }));
    const bucket = view.buckets.find((each) => each.start === new Date(startOfDay(gone)).toISOString());
    expect(bucket).toMatchObject({ history: true, calls: 12, output: 60 });
    expect(view.totals).toMatchObject({ calls: 13, output: 61 });
    expect(view.history).toMatchObject({ days: 1, calls: 11, output: 55 });
    expect(view.byRepo.rows.reduce((sum, row) => sum + row.calls, 0)).toBe(2);
    expect(view.byModel.find((row) => row.model === 'claude-sonnet-5')).toMatchObject({ calls: 12 });
    expect(view.split.subagent.calls).toBe(2);
    // A kept day that shows less than the transcripts changes nothing.
    const less = await buildUsageView(readScans([left]), options({ keptDay: (key) => (key === kept.day ? { ...kept, main: { ...emptyTokens() }, subagent: { ...emptyTokens() } } : undefined) }));
    expect(less.history).toBeUndefined();
    expect(less.totals.calls).toBe(2);
  });

  it('keeps a model id from a transcript as data: __proto__, constructor and toString pollute nothing', async () => {
    const t = NOW - HOUR;
    const odd = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    const read = readScans([scan('aaaaaaaa-0000-4000-8000-000000000001', odd.map((model, i) => rec(`o${i}`, t, { model, output: 10 + i })))]);
    const view = await buildUsageView(read, options());
    expect(Object.prototype).not.toHaveProperty('calls');
    expect(Object.prototype).not.toHaveProperty('output');
    expect(typeof Object.prototype.toString).toBe('function');
    expect(typeof ({} as { constructor: unknown }).constructor).toBe('function');
    // `__proto__` fails MODEL_ID, so it's (other models); the rest are ids of their own, as plain keys.
    const day = [...read.days.values()][0];
    expect(Object.keys(day?.models ?? {}).sort()).toEqual(['(other models)', 'constructor', 'hasOwnProperty', 'toString']);
    expect(day?.models['constructor']).toMatchObject({ calls: 1, output: 11 });
    expect(view.byModel.map((row) => row.model).sort()).toEqual(['(other models)', 'constructor', 'hasOwnProperty', 'toString']);
    expect(view.totals).toMatchObject({ calls: 4, output: 46 });
    expect(JSON.parse(JSON.stringify(view)).totals.calls).toBe(4);
  });

  it('sums the rows past USAGE_ROWS_MAX', async () => {
    const scans = Array.from({ length: USAGE_ROWS_MAX + 3 }, (_, i) =>
      scan(`aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`, [rec(`c${i}`, NOW - HOUR, { output: 1000 + i })], { cwd: `/made-up/work/r${i}` }),
    );
    const view = await buildUsageView(readScans(scans), options());
    expect(view.bySession.rows).toHaveLength(USAGE_ROWS_MAX);
    expect(view.bySession.rest).toMatchObject({ count: 3, calls: 3 });
    expect(view.byRepo.rest?.count).toBe(3);
    expect(view.bySession.rows[0]?.output).toBe(1000 + USAGE_ROWS_MAX + 2);
  });
});

describe('the source', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-usage-source-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function fakeReader(result: RateLimits): RateLimitsReader & { reads: number } {
    const reader = {
      reads: 0,
      read: async () => {
        reader.reads++;
        return result;
      },
      last: () => result,
      isOwn: (row: { name: string; cwd: string }) => row.name === 'pitwall-usage' && row.cwd === '/made-up/home/.pitwall/rate-limits',
    };
    return reader;
  }

  it('reads the plan’s week only when asked, aligns the week to its reset, keeps the days, and knows its call', async () => {
    const config = path.join(dir, 'claude');
    const project = path.join(config, 'projects', 'p');
    await mkdir(project, { recursive: true });
    const file = path.join(project, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl');
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: new Date(NOW - HOUR).toISOString(),
      cwd: '/made-up/work/repo',
      message: { id: 'm1', model: 'claude-opus-5-5', content: [], usage: { input_tokens: 3, cache_read_input_tokens: 40, cache_creation_input_tokens: 0, output_tokens: 2 } },
    });
    await writeFile(file, `${line}\n`);
    await utimes(file, new Date(NOW - HOUR), new Date(NOW - HOUR));
    const resetsAt = Math.round((NOW + 3 * DAY) / 1000);
    const reader = fakeReader({ status: 'available', readAt: NOW - 1000, fiveHour: null, sevenDay: { usedPercentage: 42, resetsAt } });
    const home = path.join(dir, 'pitwall');
    await mkdir(home, { mode: 0o700 });
    const source = createUsageSource({ pitwallHome: home, configDir: config, home: dir, now: () => NOW, rateLimits: reader, resolveRepo: async (cwd) => cwd });
    expect(reader.reads).toBe(0);

    const view = await source.view('week');
    expect(reader.reads).toBe(1);
    expect(view.window).toMatchObject({ key: 'week', from: 'reset', since: new Date(resetsAt * 1000 - 7 * DAY).toISOString() });
    expect(view.plan).toEqual({ status: 'available', readAt: new Date(NOW - 1000).toISOString(), fiveHour: null, sevenDay: { usedPercentage: 42, resetsAt: new Date(resetsAt * 1000).toISOString() } });
    expect(view.totals).toMatchObject({ calls: 1, input: 3, cacheRead: 40, output: 2 });
    expect(view.scan.files).toBe(1);
    expect(new DayStore({ home, now: () => NOW }).get(localDay(NOW - HOUR))?.main.calls).toBe(1);

    expect(source.isOwn({ name: 'pitwall-usage', cwd: '/made-up/home/.pitwall/rate-limits' })).toBe(true);
    expect(source.isOwn({ name: 'pitwall-test-a', cwd: '/made-up/work/a' })).toBe(false);
  });

  it('falls back to the last seven days when the plan’s week is unavailable', async () => {
    const source = createUsageSource({ configDir: path.join(dir, 'none'), home: dir, now: () => NOW, rateLimits: fakeReader({ status: 'unavailable', readAt: NOW, reason: 'not-found' }), resolveRepo: async (cwd) => cwd });
    const view = await source.view('week');
    expect(view.window.from).toBe('days');
    expect(view.plan).toMatchObject({ status: 'unavailable', reason: 'not-found' });
    expect(view.buckets).toHaveLength(7);
    expect(view.totals.calls).toBe(0);
  });

  it('the run rate (W159): through the same reader, each new reading of the week kept, and the report for the supervisor', async () => {
    const resetsAt = Math.round((NOW + 3 * DAY) / 1000);
    const reader = fakeReader({ status: 'available', readAt: NOW - 1000, fiveHour: null, sevenDay: { usedPercentage: 75, resetsAt } });
    const home = path.join(dir, 'pitwall');
    await mkdir(home, { mode: 0o700 });
    const source = createUsageSource({ pitwallHome: home, configDir: path.join(dir, 'none'), home: dir, now: () => NOW, rateLimits: reader, resolveRepo: async (cwd) => cwd, target: { percent: 60, day: 'friday', time: '18:00' } });
    expect(source.planReads).toBe(true);
    const rate = await source.runRate();
    expect(reader.reads).toBe(1);
    expect(rate).toMatchObject({ status: 'available', target: { percent: 60 }, sevenDay: { usedPercentage: 75, level: 'amber', projection: { status: 'thin' } } });
    await source.runRate();
    expect(readReadingsFile(path.join(home, READINGS_FILE_NAME), NOW)).toEqual([{ at: NOW - 1000, used: 75, resetsAt: resetsAt * 1000 }]);
    const report = await source.report();
    expect(report.runRate).toEqual(rate);
    expect(report.week.from).toBe('reset');
    expect(report.heaviest).toEqual([]);
    expect((await source.view('24h')).runRate).toEqual(rate);
  });

  it('the run rate calls the reader at most once in 5 minutes, even while its reads fail', async () => {
    let now = NOW;
    const reader = fakeReader({ status: 'unavailable', readAt: NOW, reason: 'timeout' });
    const source = createUsageSource({ configDir: path.join(dir, 'none'), home: dir, now: () => now, rateLimits: reader, resolveRepo: async (cwd) => cwd });
    expect(await source.runRate()).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    now += RUN_RATE_READ_MS - 1;
    await source.runRate();
    expect(reader.reads).toBe(1);
    now += 1;
    await source.runRate();
    expect(reader.reads).toBe(2);
  });

  it('the supervisor’s report (W160) reads through the same floor: with the run rate, at most once in 5 minutes', async () => {
    let now = NOW;
    const reader = fakeReader({ status: 'unavailable', readAt: NOW, reason: 'timeout' });
    const source = createUsageSource({ configDir: path.join(dir, 'none'), home: dir, now: () => now, rateLimits: reader, resolveRepo: async (cwd) => cwd });
    expect((await source.report()).runRate).toMatchObject({ status: 'unavailable', reason: 'timeout' });
    expect(reader.reads).toBe(1);
    now += RUN_RATE_READ_MS - 1;
    await source.report();
    await source.runRate();
    await source.report();
    expect(reader.reads).toBe(1);
    now += 1;
    await source.report();
    expect(reader.reads).toBe(2);
    // The Usage view reads through the same floor (W180, U-F7): a failing read isn't retried each minute.
    await source.view('week');
    expect(reader.reads).toBe(2);
    now += 61_000;
    await source.view('week');
    expect(reader.reads).toBe(2);
    now += RUN_RATE_READ_MS;
    await source.view('week');
    expect(reader.reads).toBe(3);
  });

  it('with --no-usage: never reads the plan’s percentages, keeps no readings, and the week is the last 7 days', async () => {
    const reader = fakeReader({ status: 'available', readAt: NOW, fiveHour: null, sevenDay: { usedPercentage: 10, resetsAt: Math.round((NOW + DAY) / 1000) } });
    const home = path.join(dir, 'pitwall');
    await mkdir(home, { mode: 0o700 });
    const source = createUsageSource({ pitwallHome: home, configDir: path.join(dir, 'none'), home: dir, now: () => NOW, rateLimits: reader, planReads: false, resolveRepo: async (cwd) => cwd });
    expect(source.planReads).toBe(false);
    expect(await source.runRate()).toEqual({ status: 'off' });
    const view = await source.view('week');
    expect(view.window.from).toBe('days');
    expect(view.plan).toMatchObject({ status: 'unavailable', reason: 'off' });
    expect(view.runRate).toEqual({ status: 'off' });
    expect(reader.reads).toBe(0);
    expect(existsSync(path.join(home, READINGS_FILE_NAME))).toBe(false);
    expect(source.isOwn({ name: 'pitwall-usage', cwd: '/made-up/home/.pitwall/rate-limits' })).toBe(false);
  });
});
