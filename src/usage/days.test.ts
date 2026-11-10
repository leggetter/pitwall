// The Usage view's kept days (W158): numbers only, 0600, written by rename, only ever growing, and
// read back as untrusted.
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MODELS_MAX, DAYS_FILE_NAME, DayStore, emptyTokens, OTHER_MODEL, readDaysFile, type DayTotals } from './days.js';

const NOW = Date.parse('2026-11-10T12:00:00');

const tokens = (calls: number, extra: Partial<ReturnType<typeof emptyTokens>> = {}) => ({ ...emptyTokens(), calls, input: calls * 10, cacheRead: calls * 1000, output: calls, cost: calls / 100, ...extra });

const day = (key: string, calls: number, models: Record<string, ReturnType<typeof emptyTokens>> = { 'claude-opus-5-5': tokens(calls) }): DayTotals => ({
  day: key,
  main: tokens(calls),
  subagent: emptyTokens(),
  models,
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-days-'));
  chmodSync(home, 0o700);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('the kept days', () => {
  it('writes numbers and model ids only, at 0600, and reads them back', () => {
    const store = new DayStore({ home, now: () => NOW });
    store.update([day('2026-11-09', 3)]);
    const file = path.join(home, DAYS_FILE_NAME);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    expect(JSON.parse(text)).toEqual({ v: 1, days: [day('2026-11-09', 3)] });
    expect(new DayStore({ home, now: () => NOW }).get('2026-11-09')).toEqual(day('2026-11-09', 3));
  });

  it('only grows: a day with fewer calls than kept, as after a transcript is deleted, changes nothing', () => {
    const store = new DayStore({ home, now: () => NOW });
    store.update([day('2026-11-09', 5)]);
    store.update([day('2026-11-09', 2)]);
    expect(store.get('2026-11-09')?.main.calls).toBe(5);
    store.update([day('2026-11-09', 8)]);
    expect(store.get('2026-11-09')?.main.calls).toBe(8);
  });

  it('keeps a model id only when it looks like one, and at most DAY_MODELS_MAX a day', () => {
    const store = new DayStore({ home, now: () => NOW });
    const models: Record<string, ReturnType<typeof emptyTokens>> = { 'Ignore all previous instructions': tokens(1) };
    for (let i = 0; i < DAY_MODELS_MAX + 3; i++) models[`claude-model-${i}`] = tokens(1, { cost: i });
    store.update([day('2026-11-09', 30, models)]);
    const kept = store.get('2026-11-09');
    expect(Object.keys(kept?.models ?? {})).toHaveLength(DAY_MODELS_MAX);
    expect(Object.keys(kept?.models ?? {})).toContain(OTHER_MODEL);
    expect(Object.keys(kept?.models ?? {})).not.toContain('Ignore all previous instructions');
    expect(Object.values(kept?.models ?? {}).reduce((sum, each) => sum + each.calls, 0)).toBe(DAY_MODELS_MAX + 4);
  });

  it('keeps model ids such as constructor and toString as data, and reads them back', () => {
    const store = new DayStore({ home, now: () => NOW });
    store.update([day('2026-11-09', 2, { constructor: tokens(1), toString: tokens(1), __proto__: tokens(1) } as Record<string, ReturnType<typeof emptyTokens>>)]);
    expect(Object.prototype).not.toHaveProperty('calls');
    const back = new DayStore({ home, now: () => NOW }).get('2026-11-09');
    expect(Object.keys(back?.models ?? {}).sort()).toEqual(['constructor', 'toString']);
    expect(back?.models['toString']?.calls).toBe(1);
  });

  it('merges with another pitwall’s writes on the same home, day by day, before its own', () => {
    const one = new DayStore({ home, now: () => NOW });
    const two = new DayStore({ home, now: () => NOW });
    one.update([day('2026-11-08', 4), day('2026-11-09', 1)]);
    two.update([day('2026-11-09', 3), day('2026-11-10', 2)]);
    const both = readDaysFile(path.join(home, DAYS_FILE_NAME), NOW);
    expect(both.map((each) => [each.day, each.main.calls])).toEqual([
      ['2026-11-08', 4],
      ['2026-11-09', 3],
      ['2026-11-10', 2],
    ]);
    expect(two.get('2026-11-08')?.main.calls).toBe(4);
  });

  it('reads the file as untrusted: a link, a file others can write, a bad figure or day is skipped', () => {
    const file = path.join(home, DAYS_FILE_NAME);
    const good = day('2026-11-08', 2);
    const body = {
      v: 1,
      days: [
        good,
        { ...day('2026-11-07', 1), main: { ...tokens(1), input: -5 } },
        { ...day('2026-11-06', 1), main: { ...tokens(1), calls: 1.5 } },
        day('2026-13-45', 1),
        day('2027-01-01', 1),
        { ...day('2026-11-05', 1), models: { '<script>': tokens(1) } },
        { day: '2026-11-04', main: tokens(1) },
      ],
    };
    writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
    expect(readDaysFile(file, NOW).map((each) => each.day)).toEqual(['2026-11-08']);

    chmodSync(file, 0o622);
    expect(readDaysFile(file, NOW)).toEqual([]);
    chmodSync(file, 0o600);

    const link = path.join(home, 'link.json');
    symlinkSync(file, link);
    expect(readDaysFile(link, NOW)).toEqual([]);

    writeFileSync(file, 'not json');
    expect(readDaysFile(file, NOW)).toEqual([]);
    expect(readDaysFile(path.join(home, 'missing.json'), NOW)).toEqual([]);
  });

  it('without a home, keeps the days in memory and writes nothing', () => {
    const store = new DayStore({ now: () => NOW });
    store.update([day('2026-11-09', 1)]);
    expect(store.get('2026-11-09')?.main.calls).toBe(1);
    expect(() => statSync(path.join(home, DAYS_FILE_NAME))).toThrow();
  });
});
