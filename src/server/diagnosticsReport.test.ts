// The diagnostics report (W165): stretches, reasons, the session timeline and poll counts, on made-up lines.
import { describe, expect, it } from 'vitest';
import type { DiagnosticsLine } from './diagnostics.js';
import { buildReport, duration, formatReport } from './diagnosticsReport.js';

const ID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 6, 10, minutes)).toISOString();
const now = Date.UTC(2026, 10, 6, 12, 0);

const LINES: DiagnosticsLine[] = [
  { v: 1, kind: 'enter', at: at(0), sessionId: ID, prNeed: 'review-requested', prRef: 'example/demo-app#7', won: 'pr' },
  { v: 1, kind: 'change', at: at(10), sessionId: ID, own: 'asked', prNeed: 'review-requested', prRef: 'example/demo-app#7', won: 'own' },
  { v: 1, kind: 'leave', at: at(40), sessionId: ID, setAside: 'snoozed' },
  { v: 1, kind: 'enter', at: at(5), sessionId: OTHER, own: 'recap', won: 'own' },
  { v: 1, kind: 'poll', at: at(1), searches: { authored: { listed: 3, skipped: 0, failed: false }, 'review-requested': { listed: 1, skipped: 2, failed: false } } },
  { v: 1, kind: 'poll', at: at(30), searches: { authored: { listed: 0, skipped: 0, failed: true } } },
];

describe('buildReport', () => {
  const report = buildReport(LINES, { days: 7, now });

  it('counts the stretches by reason with their time, and those still open', () => {
    expect(report.enters).toBe(2);
    expect(report.open).toBe(1);
    expect(report.byReason['pr:review-requested']).toEqual({ stretches: 1, totalMs: 10 * 60_000, longestMs: 10 * 60_000 });
    expect(report.byReason.asked).toEqual({ stretches: 1, totalMs: 30 * 60_000, longestMs: 30 * 60_000 });
    expect(report.byReason.recap!.totalMs).toBe((120 - 5) * 60_000);
    expect(report.segments.find((each) => each.reason === 'asked')).toMatchObject({ setAside: 'snoozed', to: at(40) });
    expect(report.byWon).toEqual({ own: 2, pr: 1 });
  });

  it('counts the polls', () => {
    expect(report.polls).toMatchObject({ logged: 2, failedSearches: 1, skippedTotal: 2, byRelation: { authored: { polls: 2, failed: 1, skipped: 0 }, 'review-requested': { polls: 1, failed: 0, skipped: 2 } } });
    expect(report.polls.latest).toEqual({ authored: { listed: 0, skipped: 0, failed: true } });
  });

  it('leaves out lines older than the window', () => {
    expect(buildReport(LINES, { days: 1, now: now + 3 * 24 * 60 * 60 * 1000 }).lines).toBe(0);
  });

  it('gives one session its timeline, by id or a prefix of 8 or more, and nothing for a short prefix', () => {
    const one = buildReport(LINES, { days: 7, now, session: ID.slice(0, 8) });
    expect(one.sessions).toBe(1);
    expect(one.timeline?.map((line) => line.kind)).toEqual(['enter', 'change', 'leave']);
    expect(buildReport(LINES, { days: 7, now, session: '2222' }).timeline).toEqual([]);
    expect(formatReport(one)).toContain('own=asked pr=review-requested example/demo-app#7 won=own');
  });

  it('prints a text report with the reasons and the polls', () => {
    const text = formatReport(report);
    expect(text).toContain('2 entries on 2 sessions, 1 still in');
    expect(text).toContain('pr:review-requested');
    expect(text).toContain('2 skipped as reviewed already');
  });
});

describe('duration', () => {
  it('reads as seconds, minutes, hours and days', () => {
    expect([20_000, 45 * 60_000, 200 * 60_000, 60 * 60 * 60_000].map(duration)).toEqual(['20s', '45m', '3h 20m', '2d 12h']);
  });
});
