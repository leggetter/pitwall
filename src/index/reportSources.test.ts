// A worker's newest report to its lead (W218 piece 2): SendMessage calls matched by the lead's name only,
// through only when Claude Code said so, the newest winning, read from the transcript's tail and fail-soft.
// Made-up entries only.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addressedName, parseNewestReport, readNewestReport, REPORT_LINE_MAX, REPORT_TAIL_BYTES } from './reportSources.js';

const LEAD = 'pitwall-test-lead';

let next = 0;
/** A SendMessage call and its result, as two JSONL lines. */
function report(to: string, timestamp: string, result: { success?: boolean; isError?: boolean } = {}): string {
  const id = `toolu_test${next++}`;
  const call = { type: 'assistant', timestamp, message: { content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, message: 'made-up report' } }] } };
  const answer = {
    type: 'user',
    timestamp,
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'made-up', ...(result.isError === true ? { is_error: true } : {}) }] },
    toolUseResult: { success: result.success ?? true, message: 'made-up', msg_id: 'm1' },
  };
  return `${JSON.stringify(call)}\n${JSON.stringify(answer)}\n`;
}

const T1 = '2026-11-27T10:00:00.000Z';
const T2 = '2026-11-27T10:42:00.000Z';

describe('addressedName()', () => {
  it('trims, takes off a trailing [ref] and ignores case', () => {
    expect(addressedName('  Pitwall-Test-Lead [ab12]  ')).toBe(LEAD);
    expect(addressedName('pitwall-test-lead')).toBe(LEAD);
    expect(addressedName('lead [not a ref!]')).toBe('lead [not a ref!]');
  });
});

describe('parseNewestReport()', () => {
  it('matches the name with a [ref], spaces or another case', () => {
    expect(parseNewestReport(report('PITWALL-TEST-LEAD [7f3a]', T1), LEAD)).toBe(T1);
    expect(parseNewestReport(report(` ${LEAD} `, T1), LEAD)).toBe(T1);
  });

  it('ignores a call to another name, or to a session id', () => {
    expect(parseNewestReport(report('pitwall-test-other', T1), LEAD)).toBeUndefined();
    expect(parseNewestReport(report('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', T1), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaab0')).toBeUndefined();
    // Addressed by the lead's id while the lead is named: not a report to the name.
    expect(parseNewestReport(report('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', T1), LEAD)).toBeUndefined();
  });

  it('ignores a call Claude Code says failed, or whose result is an error, or that has no result', () => {
    expect(parseNewestReport(report(LEAD, T1, { success: false }), LEAD)).toBeUndefined();
    expect(parseNewestReport(report(LEAD, T1, { isError: true }), LEAD)).toBeUndefined();
    expect(parseNewestReport(report(LEAD, T1).split('\n')[0]!, LEAD)).toBeUndefined();
  });

  it('takes the newest of several, a failed newer one not counting', () => {
    expect(parseNewestReport(report(LEAD, T1) + report(LEAD, T2), LEAD)).toBe(T2);
    expect(parseNewestReport(report(LEAD, T2) + report(LEAD, T1), LEAD)).toBe(T2);
    expect(parseNewestReport(report(LEAD, T1) + report(LEAD, T2, { success: false }), LEAD)).toBe(T1);
  });

  it('skips a cut first line, a line past REPORT_LINE_MAX and lines that aren’t JSON', () => {
    const text = report(LEAD, T1);
    expect(parseNewestReport(text, LEAD, true)).toBeUndefined();
    expect(parseNewestReport(`{"SendMessage": oops\n${text}`, LEAD, true)).toBe(T1);
    const long = report(LEAD, T1).replace('made-up report', 'x'.repeat(REPORT_LINE_MAX));
    expect(parseNewestReport(long, LEAD)).toBeUndefined();
    expect(parseNewestReport(`not json "SendMessage"\n${text}`, LEAD)).toBe(T1);
  });

  it('answers nothing for an empty name or a call without a time', () => {
    expect(parseNewestReport(report('', T1), '')).toBeUndefined();
    expect(parseNewestReport(report(LEAD, 'not a time'), LEAD)).toBeUndefined();
  });
});

describe('readNewestReport()', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pitwall-test-reports-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the time from a file, {} when there is none', async () => {
    const file = path.join(dir, 'a.jsonl');
    writeFileSync(file, report(LEAD, T1));
    expect(await readNewestReport(file, LEAD)).toEqual({ at: T1 });
    writeFileSync(file, report('pitwall-test-other', T1));
    expect(await readNewestReport(file, LEAD)).toEqual({});
  });

  it('reads only the tail, skipping the line it cuts into', async () => {
    const file = path.join(dir, 'a.jsonl');
    const filler = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } })}\n`;
    writeFileSync(file, report(LEAD, T1) + filler.repeat(Math.ceil(REPORT_TAIL_BYTES / filler.length) + 1));
    expect(await readNewestReport(file, LEAD)).toEqual({});
    writeFileSync(file, report(LEAD, T1) + filler.repeat(Math.ceil(REPORT_TAIL_BYTES / filler.length) + 1) + report(LEAD, T2));
    expect(await readNewestReport(file, LEAD)).toEqual({ at: T2 });
  });

  it('answers undefined for a symlink, a folder or a missing file', async () => {
    const file = path.join(dir, 'a.jsonl');
    writeFileSync(file, report(LEAD, T1));
    const link = path.join(dir, 'link.jsonl');
    symlinkSync(file, link);
    expect(await readNewestReport(link, LEAD)).toBeUndefined();
    expect(await readNewestReport(dir, LEAD)).toBeUndefined();
    expect(await readNewestReport(path.join(dir, 'missing.jsonl'), LEAD)).toBeUndefined();
  });
});
