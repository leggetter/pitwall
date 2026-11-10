// The settings each session pitwall started with a work profile used (W155; Phil, 2026-11-09): the
// store, its file, and how it reads one back. Resume's use of it is in actions.test.ts. Made-up ids only.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IndexSnapshot, SessionSummary } from '../shared/protocol.js';
import { checkedLaunch, launchWork, readSessionLaunchesFile, SESSION_LAUNCHES_FILE_NAME, SESSION_LAUNCHES_MAX, SessionLaunches } from './sessionLaunches.js';

const ID = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const REVIEW = { profile: 'Review', model: 'sonnet', effort: 'high' as const, subagentModel: 'sonnet' };

let home: string;
let clock: number;
const now = () => new Date(clock);
const file = () => join(home, SESSION_LAUNCHES_FILE_NAME);
const store = () => new SessionLaunches({ home, now });

function snapshotWith(...sessions: Pick<SessionSummary, 'sessionId' | 'shortId'>[]): IndexSnapshot {
  return {
    generatedAt: '2026-11-09T10:00:00.000Z',
    roots: ['/tmp/pitwall-test-root'],
    groups: [{ key: '/tmp/pitwall-test-root/repo', label: 'repo', kind: 'git', root: '/tmp/pitwall-test-root', sessions: sessions as SessionSummary[] }],
    source: { ok: true },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pitwall-test-launches-'));
  clock = Date.parse('2026-11-09T10:00:00.000Z');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('SessionLaunches (W155)', () => {
  it('keeps what a spawn with a profile used, at 0600, and reads it back after a restart, by short id then by session id once listed', () => {
    const first = store();
    first.record('a1b2c3d4', REVIEW);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    const body = JSON.parse(readFileSync(file(), 'utf8')) as { v: number; launches: unknown[] };
    expect(body).toEqual({ v: 1, launches: [{ shortId: 'a1b2c3d4', at: '2026-11-09T10:00:00.000Z', launch: REVIEW }] });

    const again = store();
    expect(again.lookup({ sessionId: ID, shortId: 'a1b2c3d4' })).toEqual({
      launch: REVIEW,
      session: { model: 'sonnet', effort: 'high' },
      subagents: { model: 'sonnet' },
    });
    // Listed: linked to its session id, so it's found with no short id, as an ended session may be.
    again.link(snapshotWith({ sessionId: ID, shortId: 'a1b2c3d4' }));
    expect(store().lookup({ sessionId: ID })?.launch).toEqual(REVIEW);
  });

  it("keeps nothing for a spawn without a profile, or a short id that isn't one", () => {
    const launches = store();
    launches.record('a1b2c3d4', { model: 'sonnet', effort: 'high' });
    launches.record('-rf', REVIEW);
    expect(launches.size).toBe(0);
    expect(existsSync(file())).toBe(false);
  });

  it('never matches a short id used again by another session, once the record is linked', () => {
    const launches = store();
    launches.record('a1b2c3d4', REVIEW);
    launches.link(snapshotWith({ sessionId: ID, shortId: 'a1b2c3d4' }));
    expect(launches.lookup({ sessionId: OTHER, shortId: 'a1b2c3d4' })).toBeUndefined();
    expect(launches.lookup({ sessionId: OTHER })).toBeUndefined();
    expect(launches.lookup({ sessionId: ID, shortId: 'zzzzzzzz' })?.launch.profile).toBe('Review');
  });

  it('after a resume, links it to its session id and moves it under the short id it now has', () => {
    const launches = store();
    launches.record('a1b2c3d4', REVIEW);
    launches.resumed({ sessionId: ID, shortId: 'a1b2c3d4' }, 'e5f6a7b8');
    const again = store();
    expect(again.size).toBe(1);
    expect(again.lookup({ sessionId: ID })?.launch).toEqual(REVIEW);
    expect(again.lookup({ sessionId: OTHER, shortId: 'a1b2c3d4' })).toBeUndefined();
  });

  it('after a resume on a profile you approved (W156), keeps that profile instead, and gives a session with no record one', () => {
    const launches = store();
    launches.record('a1b2c3d4', REVIEW);
    const docs = { profile: 'Docs', model: 'sonnet', effort: 'medium' as const, subagentModel: 'sonnet' };
    launches.resumed({ sessionId: ID, shortId: 'a1b2c3d4' }, 'e5f6a7b8', docs);
    launches.resumed({ sessionId: OTHER }, 'c9d0e1f2', REVIEW);
    // A launch with no profile, or a short id that isn't one, keeps nothing new.
    launches.resumed({ sessionId: '66666666-6666-4666-8666-666666666666' }, 'a0a0a0a0', { model: 'sonnet' });
    launches.resumed({ sessionId: '77777777-7777-4777-8777-777777777777' }, '-bad', REVIEW);
    const again = store();
    expect(again.size).toBe(2);
    expect(again.lookup({ sessionId: ID })?.launch).toEqual(docs);
    expect(again.lookup({ sessionId: OTHER })?.launch).toEqual(REVIEW);
  });

  it('launchWork() takes an approved launch only whole: its profile and all three settings, each passing the checks (W156)', () => {
    expect(launchWork(REVIEW)).toEqual({ launch: REVIEW, session: { model: 'sonnet', effort: 'high' }, subagents: { model: 'sonnet' } });
    expect(launchWork({ ...REVIEW, profile: undefined })).toBeUndefined();
    expect(launchWork({ ...REVIEW, model: '--dangerously-skip-permissions' })).toBeUndefined();
    expect(launchWork({ ...REVIEW, effort: 'huge' as never })).toBeUndefined();
    expect(launchWork({ profile: 'Review', model: 'sonnet', effort: 'high' })).toBeUndefined();
  });

  it(`keeps at most ${SESSION_LAUNCHES_MAX}, dropping the least recently started or resumed first`, () => {
    const launches = store();
    for (let i = 0; i < SESSION_LAUNCHES_MAX + 5; i++) {
      clock += 1000;
      launches.record(`s${i}`, REVIEW);
      // The first is resumed along the way, so it stays.
      if (i === 10) launches.resumed({ sessionId: ID, shortId: 's0' }, 's0');
    }
    const again = store();
    expect(again.size).toBe(SESSION_LAUNCHES_MAX);
    expect(again.lookup({ sessionId: ID })).toBeDefined();
    expect(again.lookup({ sessionId: OTHER, shortId: 's1' })).toBeUndefined();
    expect(again.lookup({ sessionId: OTHER, shortId: 's5' })).toBeUndefined();
    expect(again.lookup({ sessionId: OTHER, shortId: 's6' })).toBeDefined();
    expect(again.lookup({ sessionId: OTHER, shortId: `s${SESSION_LAUNCHES_MAX + 4}` })).toBeDefined();
  });

  it('drops any value that fails the profiles\' checks, as it reads the file and again as it looks one up', () => {
    writeFileSync(
      file(),
      JSON.stringify({
        v: 1,
        launches: [
          { shortId: 'good', sessionId: ID, at: '2026-11-09T09:00:00.000Z', launch: { profile: 'Review', model: 'opus --dangerously-skip-permissions', effort: 'high', subagentModel: 'opusplan' } },
          { shortId: 'bad', at: '2026-11-09T09:00:00.000Z', launch: { profile: 'Review', model: 'x y', effort: 'ultracode' } },
          { shortId: '-flag', at: '2026-11-09T09:00:00.000Z', launch: REVIEW },
          { shortId: 'nottime', at: 'yesterday', launch: REVIEW },
          { shortId: 'noid', sessionId: '../etc', at: '2026-11-09T09:00:00.000Z', launch: { ...REVIEW, profile: 'Bad\nname', skill: 'handoff' } },
        ],
      }),
      { mode: 0o600 },
    );
    const launches = store();
    expect(launches.size).toBe(2);
    expect(launches.lookup({ sessionId: ID })).toEqual({ launch: { profile: 'Review', effort: 'high' }, session: { effort: 'high' }, subagents: {} });
    // The bad session id is left off, so it's found by its short id; the bad name and the skill are dropped.
    expect(launches.lookup({ sessionId: OTHER, shortId: 'noid' })?.launch).toEqual({ model: 'sonnet', effort: 'high', subagentModel: 'sonnet' });
    expect(checkedLaunch({ model: 'default', effort: 'default', subagentModel: 'default' })).toEqual({ model: 'default', effort: 'default', subagentModel: 'default' });
    expect(checkedLaunch({ profile: 'Review', skill: 'handoff' })).toBeUndefined();
  });

  it("reads nothing from a corrupt file, a link, one others can write to or one that's too large, and starts empty", () => {
    writeFileSync(file(), '{ not json', { mode: 0o600 });
    expect(store().size).toBe(0);
    writeFileSync(file(), JSON.stringify({ v: 2, launches: [] }), { mode: 0o600 });
    expect(store().size).toBe(0);

    const good = JSON.stringify({ v: 1, launches: [{ shortId: 'a1', at: '2026-11-09T09:00:00.000Z', launch: REVIEW }] });
    writeFileSync(file(), good, { mode: 0o600 });
    expect(store().size).toBe(1);
    chmodSync(file(), 0o622);
    expect(readSessionLaunchesFile(file())).toEqual([]);
    rmSync(file());
    const real = join(home, 'elsewhere.json');
    writeFileSync(real, good, { mode: 0o600 });
    symlinkSync(real, file());
    expect(readSessionLaunchesFile(file())).toEqual([]);
    rmSync(file());
    writeFileSync(file(), ' '.repeat(300 * 1024), { mode: 0o600 });
    expect(readSessionLaunchesFile(file())).toEqual([]);
  });

  it("fails soft when pitwall's home is missing or can't be written: held in memory for the run", () => {
    const missing = new SessionLaunches({ home: join(home, 'no', 'such'), now });
    expect(() => missing.record('a1b2c3d4', REVIEW)).not.toThrow();
    expect(missing.lookup({ sessionId: ID, shortId: 'a1b2c3d4' })?.launch).toEqual(REVIEW);

    chmodSync(home, 0o500);
    try {
      const readOnly = store();
      expect(() => readOnly.record('a1b2c3d4', REVIEW)).not.toThrow();
      expect(readOnly.lookup({ sessionId: ID, shortId: 'a1b2c3d4' })?.launch).toEqual(REVIEW);
    } finally {
      chmodSync(home, 0o700);
    }
    expect(existsSync(file())).toBe(false);

    const memory = new SessionLaunches({ now });
    memory.record('a1b2c3d4', REVIEW);
    expect(memory.lookup({ sessionId: ID, shortId: 'a1b2c3d4' })?.launch).toEqual(REVIEW);
  });
});
