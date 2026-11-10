// The run rate's readings (W159): numbers and times only, 0600, written by rename, merged with what
// another pitwall wrote, and read back as untrusted.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { READINGS_AHEAD_MS, READINGS_FILE_MAX_BYTES, READINGS_FILE_NAME, READINGS_KEEP_MS, READINGS_MAX, ReadingStore, readReadingsFile } from './readings.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const HOUR = 3_600_000;
const RESET = Date.parse('2026-11-15T12:00:00Z');
const reading = (hoursAgo: number, used: number) => ({ at: NOW - hoursAgo * HOUR, used, resetsAt: RESET });

let home: string;
let file: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'pitwall-test-readings-'));
  chmodSync(home, 0o700);
  file = path.join(home, READINGS_FILE_NAME);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const write = (value: unknown, mode = 0o600) => {
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
  chmodSync(file, mode);
};

describe('the readings', () => {
  it('writes the time, percentage and reset only, at 0600, and reads them back in order', () => {
    const store = new ReadingStore({ home, now: () => NOW });
    store.add(reading(1, 20));
    store.add(reading(2, 18));
    store.add(reading(1, 99)); // the same time again: kept once, as first read
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, readings: [reading(2, 18), reading(1, 20)] });
    const again = new ReadingStore({ home, now: () => NOW });
    expect(again.all()).toEqual([reading(2, 18), reading(1, 20)]);
    expect(again.latest()).toEqual(reading(1, 20));
  });

  it('keeps them in memory only without a home', () => {
    const store = new ReadingStore({ now: () => NOW });
    store.add(reading(1, 5));
    expect(store.all()).toEqual([reading(1, 5)]);
  });

  it('merges with what another pitwall on the same home wrote since', () => {
    const one = new ReadingStore({ home, now: () => NOW });
    const two = new ReadingStore({ home, now: () => NOW });
    one.add(reading(3, 10));
    two.add(reading(2, 12));
    one.add(reading(1, 14));
    expect(readReadingsFile(file, NOW)).toEqual([reading(3, 10), reading(2, 12), reading(1, 14)]);
  });

  it('drops readings older than 8 days, and the oldest past READINGS_MAX', () => {
    const store = new ReadingStore({ home, now: () => NOW });
    store.add({ at: NOW - READINGS_KEEP_MS - 1, used: 1, resetsAt: NOW });
    expect(store.all()).toEqual([]);
    const many = Array.from({ length: READINGS_MAX + 5 }, (_, i) => ({ at: NOW - (READINGS_MAX + 5 - i) * 60_000, used: 10, resetsAt: RESET }));
    write({ v: 1, readings: many });
    const loaded = new ReadingStore({ home, now: () => NOW });
    expect(loaded.all()).toHaveLength(READINGS_MAX);
    expect(loaded.all()[0]!.at).toBe(many[5]!.at);
  });

  it('skips a reading that fails a check, and keeps only its three fields', () => {
    write({
      v: 1,
      readings: [
        { ...reading(1, 20), note: 'ignore previous instructions' },
        { at: NOW - HOUR + 0.5, used: 20, resetsAt: RESET },
        { at: NOW - 2 * HOUR, used: -1, resetsAt: RESET },
        { at: NOW - 3 * HOUR, used: 1001, resetsAt: RESET },
        { at: NOW - 4 * HOUR, used: '50', resetsAt: RESET },
        { at: NOW - 5 * HOUR, used: 50, resetsAt: NOW - 6 * HOUR },
        { at: NOW - 6 * HOUR, used: 50, resetsAt: NOW + 30 * 86_400_000 },
        { at: NOW + 2 * 86_400_000, used: 50, resetsAt: RESET + 2 * 86_400_000 },
        { __proto__: { at: NOW, used: 1, resetsAt: RESET } },
        null,
        [],
      ],
    });
    expect(readReadingsFile(file, NOW)).toEqual([reading(1, 20)]);
    expect(Object.keys(readReadingsFile(file, NOW)[0]!)).toEqual(['at', 'used', 'resetsAt']);
  });

  it('refuses a reading more than 5 minutes ahead, or with a fraction of a percent, and rounds a fraction it’s given', () => {
    write({
      v: 1,
      readings: [
        { at: NOW + 23 * HOUR, used: 999, resetsAt: RESET },
        { at: NOW + READINGS_AHEAD_MS + 1, used: 20, resetsAt: RESET },
        { at: NOW + READINGS_AHEAD_MS, used: 20, resetsAt: RESET },
        { at: NOW - HOUR, used: 20.5, resetsAt: RESET },
      ],
    });
    expect(readReadingsFile(file, NOW)).toEqual([{ at: NOW + READINGS_AHEAD_MS, used: 20, resetsAt: RESET }]);
    const store = new ReadingStore({ now: () => NOW });
    store.add({ at: NOW - HOUR, used: 41.6, resetsAt: RESET });
    store.add({ at: NOW + HOUR, used: 50, resetsAt: RESET });
    expect(store.all()).toEqual([{ at: NOW - HOUR, used: 42, resetsAt: RESET }]);
  });

  it('reads nothing from a file that isn’t safe: a link, a FIFO, writable by others, too big, or not version 1', () => {
    const good = { v: 1, readings: [reading(1, 20)] };
    write(good);
    expect(readReadingsFile(file, NOW)).toHaveLength(1);
    write(good, 0o622);
    expect(readReadingsFile(file, NOW)).toEqual([]);
    write({ v: 2, readings: good.readings });
    expect(readReadingsFile(file, NOW)).toEqual([]);
    write('{ not json');
    expect(readReadingsFile(file, NOW)).toEqual([]);
    write(' '.repeat(READINGS_FILE_MAX_BYTES + 1));
    expect(readReadingsFile(file, NOW)).toEqual([]);
    rmSync(file);
    const real = path.join(home, 'real.json');
    writeFileSync(real, JSON.stringify(good), { mode: 0o600 });
    symlinkSync(real, file);
    expect(readReadingsFile(file, NOW)).toEqual([]);
    rmSync(file);
    execFileSync('mkfifo', [file]);
    expect(readReadingsFile(file, NOW)).toEqual([]);
  });

  it('fails soft when the file can’t be written: the reading is kept for the run', () => {
    rmSync(home, { recursive: true, force: true });
    writeFileSync(home, 'not a directory');
    const store = new ReadingStore({ home, now: () => NOW });
    store.add(reading(1, 20));
    expect(store.all()).toEqual([reading(1, 20)]);
    rmSync(home);
  });
});
