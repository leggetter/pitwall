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

describe('buildReport, across restarts and two writers', () => {
  it("closes a stretch open when pitwall stopped at the last line before the start, as restart, and doesn't count the gap or the at-start enter", () => {
    const report = buildReport(
      [
        { v: 1, kind: 'start', at: at(0) },
        { v: 1, kind: 'enter', at: at(1), sessionId: ID, own: 'asked', won: 'own' },
        { v: 1, kind: 'enter', at: at(20), sessionId: OTHER, own: 'recap', won: 'own' },
        // pitwall stops here and starts again 49 hours later; ID left Needs you while it was off.
        { v: 1, kind: 'start', at: at(49 * 60) },
        { v: 1, kind: 'enter', at: at(49 * 60), sessionId: OTHER, own: 'recap', won: 'own', atStart: true },
      ],
      { days: 7, now: Date.parse(at(50 * 60)) },
    );
    expect(report.restarts).toBe(2);
    expect(report.enters).toBe(2);
    expect(report.entersAtStart).toBe(1);
    expect(report.open).toBe(1);
    expect(report.segments.filter((each) => each.sessionId === ID)).toEqual([{ sessionId: ID, from: at(1), to: at(20), ms: 19 * 60_000, reason: 'asked', over: 'restart' }]);
    expect(report.byReason.recap).toEqual({ stretches: 2, totalMs: 0 + 60 * 60_000, longestMs: 60 * 60_000 });
    expect(formatReport(report)).toContain('pitwall started 2 times; 1 sessions were already in Needs you then');
  });

  it('reads two pitwalls writing the same transitions to one home as one stretch, and a repeated poll once', () => {
    const poll = { authored: { listed: 2, skipped: 0, failed: false } };
    const report = buildReport(
      [
        { v: 1, kind: 'enter', at: at(0), sessionId: ID, own: 'asked', won: 'own' },
        { v: 1, kind: 'enter', at: at(0), sessionId: ID, own: 'asked', won: 'own' },
        { v: 1, kind: 'poll', at: at(1), searches: poll },
        { v: 1, kind: 'poll', at: at(1), searches: poll },
        { v: 1, kind: 'leave', at: at(10), sessionId: ID },
        { v: 1, kind: 'leave', at: at(10), sessionId: ID },
      ],
      { days: 7, now },
    );
    expect(report.enters).toBe(1);
    expect(report.segments).toEqual([{ sessionId: ID, from: at(0), to: at(10), ms: 10 * 60_000, reason: 'asked' }]);
    expect(report.polls.logged).toBe(1);
  });
});

describe('duration', () => {
  it('reads as seconds, minutes, hours and days', () => {
    expect([20_000, 45 * 60_000, 200 * 60_000, 60 * 60 * 60_000].map(duration)).toEqual(['20s', '45m', '3h 20m', '2d 12h']);
  });
});
