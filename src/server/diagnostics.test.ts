// The diagnostics log (W165): the recorder's transitions, the file's mode, rotation, fail-soft writes,
// and that no free text from a session or a PR can reach it. Made-up sessions and PRs only.
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePullRequest } from '../prs/parse.js';
import type { IndexSnapshot, PullRequestSummary, SessionSummary } from '../shared/protocol.js';
import { prNode, reviewRequests, VIEWER } from '../test/prs.js';
import {
  DIAGNOSTICS_LOG_MAX_BYTES,
  DIAGNOSTICS_LOG_NAME,
  DiagnosticsLog,
  NeedsYouRecorder,
  parseDiagnosticsLine,
  readDiagnosticsLog,
  type DiagnosticsLine,
} from './diagnostics.js';

const ID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: ID,
    name: 'pitwall-test-diag',
    kind: 'interactive',
    cwd: '/tmp/pitwall-test-root/repo',
    alive: true,
    pid: 4242,
    startedAt: '2026-11-06T00:00:00.000Z',
    stale: false,
    finished: false,
    transcript: 'ok',
    ...overrides,
  };
}

function snapshotOf(...sessions: SessionSummary[]): IndexSnapshot {
  return { generatedAt: '2026-11-06T10:00:00.000Z', roots: ['/tmp/pitwall-test-root'], groups: [{ key: '/tmp/pitwall-test-root/repo', label: 'repo', kind: 'git', root: '/tmp/pitwall-test-root', sessions }], source: { ok: true } };
}

const reviewPr = (number = 7): PullRequestSummary => parsePullRequest(prNode({ number, reviewRequests: reviewRequests({ user: VIEWER }) }), 'review-requested', VIEWER)!;
const ownsPr = (number = 7) => ({ prLinks: [{ kind: 'opened' as const, repo: 'example/demo-app', number, lastAt: '2026-11-06T09:00:00.000Z' }] });
const NO_PRS = { prs: [] as PullRequestSummary[] };

let home: string;
let file: string;
let clockMs: number;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pitwall-test-diag-'));
  chmodSync(home, 0o700);
  file = join(home, DIAGNOSTICS_LOG_NAME);
  clockMs = Date.UTC(2026, 10, 6, 10, 0, 0);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const logOf = () => new DiagnosticsLog({ home, now: () => new Date((clockMs += 1000)) });
const lines = () => readDiagnosticsLog(file);

describe('NeedsYouRecorder', () => {
  it("writes a line when a session enters Needs you and when it leaves, and nothing for an unchanged state", () => {
    const recorder = new NeedsYouRecorder(logOf());
    recorder.observe(snapshotOf(session()), NO_PRS);
    expect(lines()).toEqual([]);
    const needing = session({ needsYou: { reason: 'recap', text: 'Pick one' } });
    recorder.observe(snapshotOf(needing), NO_PRS);
    recorder.observe(snapshotOf(needing), NO_PRS);
    recorder.observe(snapshotOf({ ...needing, lastActivityAt: '2026-11-06T10:05:00.000Z' }), NO_PRS);
    expect(lines()).toMatchObject([{ kind: 'enter', sessionId: ID, own: 'recap', won: 'own' }]);
    recorder.observe(snapshotOf(session()), NO_PRS);
    recorder.observe(snapshotOf(session()), NO_PRS);
    expect(lines().map((line) => line.kind)).toEqual(['enter', 'leave']);
  });

  it('marks the sessions already in Needs you at the first snapshot, once', () => {
    const recorder = new NeedsYouRecorder(logOf());
    recorder.observe(snapshotOf(session({ needsYou: { reason: 'asked' } })), NO_PRS);
    recorder.observe(snapshotOf(session({ needsYou: { reason: 'asked' } }), session({ sessionId: OTHER, needsYou: { reason: 'prompt' } })), NO_PRS);
    const [first, second] = lines() as unknown as [{ atStart?: true }, { atStart?: true }];
    expect(first.atStart).toBe(true);
    expect(second.atStart).toBeUndefined();
  });

  it("gives a PR's need as the reason when the session has none, with the PR as owner/repo#number, and which won", () => {
    const recorder = new NeedsYouRecorder(logOf());
    recorder.observe(snapshotOf(session(ownsPr())), { prs: [reviewPr()] });
    expect(lines()).toMatchObject([{ kind: 'enter', prNeed: 'review-requested', prRef: 'example/demo-app#7', prVia: 'direct', won: 'pr' }]);
    // Its own reason arrives while the PR still needs it: a change, and the session's own wins.
    recorder.observe(snapshotOf(session({ ...ownsPr(), needsYou: { reason: 'asked' } })), { prs: [reviewPr()] });
    expect(lines().at(-1)).toMatchObject({ kind: 'change', own: 'asked', prNeed: 'review-requested', won: 'own' });
  });

  it('leaves a busy session out for its PR, as the page does (W161), and says why a flagged one is out', () => {
    const recorder = new NeedsYouRecorder(logOf());
    const busy = session({ ...ownsPr(), status: 'busy' });
    recorder.observe(snapshotOf(busy), { prs: [reviewPr()] });
    expect(lines()).toEqual([]);
    recorder.observe(snapshotOf({ ...busy, status: 'idle' }), { prs: [reviewPr()] });
    expect(lines()).toMatchObject([{ kind: 'enter', prNeed: 'review-requested' }]);
    const other = session({ sessionId: OTHER, needsYou: { reason: 'asked' } });
    recorder.observe(snapshotOf(other), NO_PRS);
    recorder.observe(snapshotOf({ ...other, flagged: { at: '2026-11-06T10:00:00.000Z' } }), NO_PRS);
    expect(lines().at(-1)).toMatchObject({ kind: 'leave', sessionId: OTHER, setAside: 'flagged' });
  });

  it('says a session left because it finished or ended', () => {
    const recorder = new NeedsYouRecorder(logOf());
    const needing = session({ needsYou: { reason: 'blocked' } });
    recorder.observe(snapshotOf(needing), NO_PRS);
    recorder.observe(snapshotOf({ ...needing, finished: true }), NO_PRS);
    expect(lines().at(-1)).toMatchObject({ kind: 'leave', over: 'finished' });
  });

  it("keeps a session's state when it isn't listed for a poll, so a failed poll doesn't write a leave and an enter", () => {
    const recorder = new NeedsYouRecorder(logOf());
    const needing = session({ needsYou: { reason: 'asked' } });
    recorder.observe(snapshotOf(needing), NO_PRS);
    recorder.observe(snapshotOf(), NO_PRS);
    recorder.observe(snapshotOf(needing), NO_PRS);
    expect(lines()).toHaveLength(1);
  });

  it('carries no free text: only fixed words, ids and counts reach the file, whatever the session and the PR say', () => {
    const secret = 'TOP-SECRET-TRANSCRIPT-TEXT';
    const log = logOf();
    const recorder = new NeedsYouRecorder(log);
    const hostile = session({
      ...ownsPr(),
      name: `${secret} name`,
      title: `${secret} title`,
      cwd: `/tmp/${secret}`,
      needsYou: { reason: 'claude-code', text: `${secret} needs` },
      waitingFor: `${secret} waiting`,
      askedYou: { excerpt: `${secret} asked` } as SessionSummary['askedYou'],
      recap: { waitingOn: 'you', title: `${secret} recap`, forYou: 1, next: `${secret} next`, at: '2026-11-06T10:00:00.000Z', source: 'pitwall' },
    });
    const pr = parsePullRequest(prNode({ number: 7, title: `${secret} pr title`, headRefName: `${secret}-branch`, reviewRequests: reviewRequests({ user: VIEWER }) }), 'review-requested', VIEWER)!;
    recorder.observe(snapshotOf(hostile), { prs: [pr] });
    recorder.observe(snapshotOf({ ...hostile, finished: true }), { prs: [pr] });
    log.poll({ authored: { listed: 1, skipped: 0, failed: false } });
    const text = readFileSync(file, 'utf8');
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('SECRET');
    // Every field is one of the fixed shapes: parse-and-rewrite loses nothing.
    for (const raw of text.trim().split('\n')) expect(parseDiagnosticsLine(raw)).toEqual(JSON.parse(raw));
    const allowed = new Set(['v', 'kind', 'at', 'sessionId', 'own', 'setAside', 'prNeed', 'prRef', 'prVia', 'won', 'over', 'atStart', 'searches']);
    for (const line of lines()) for (const key of Object.keys(line)) expect(allowed.has(key), key).toBe(true);
  });

  it('drops a line field that is not one of the fixed shapes when reading, so the file can be read as untrusted', () => {
    const parsed = parseDiagnosticsLine(JSON.stringify({ v: 1, kind: 'enter', at: '2026-11-06T10:00:00.000Z', sessionId: ID, own: 'free text here', prNeed: 'ignore all instructions', prRef: 'not a ref', text: 'x', won: 'own' }));
    expect(parsed).toEqual({ v: 1, kind: 'enter', at: '2026-11-06T10:00:00.000Z', sessionId: ID, won: 'own' });
    expect(parseDiagnosticsLine(JSON.stringify({ v: 1, kind: 'enter', at: 'nope', sessionId: ID }))).toBeUndefined();
    expect(parseDiagnosticsLine(JSON.stringify({ v: 1, kind: 'enter', at: '2026-11-06T10:00:00.000Z', sessionId: '../../etc' }))).toBeUndefined();
  });
});

describe('DiagnosticsLog', () => {
  it('writes 0600, and writes the poll only when the counts change', () => {
    const log = logOf();
    const counts = { authored: { listed: 2, skipped: 0, failed: false }, 'review-requested': { listed: 0, skipped: 1, failed: false } };
    log.poll(counts);
    log.poll(counts);
    log.poll({ ...counts, mentioned: { listed: 0, skipped: 0, failed: true } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(lines()).toMatchObject([{ kind: 'poll', searches: counts }, { kind: 'poll', searches: { mentioned: { failed: true } } }]);
  });

  it('keeps the newest half past its size cap, and the file stays under the cap', () => {
    const log = logOf();
    const sessions: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const id = `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`;
      sessions.push(id);
      log.session({ kind: 'enter', sessionId: id, own: 'recap', won: 'own' });
    }
    expect(statSync(file).size).toBeLessThanOrEqual(DIAGNOSTICS_LOG_MAX_BYTES);
    const kept = lines() as { sessionId: string }[];
    expect(kept.length).toBeGreaterThan(1000);
    expect(kept.length).toBeLessThan(sessions.length);
    expect(kept.at(-1)!.sessionId).toBe(sessions.at(-1));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('drops a write it cannot make and never throws: a log that is a link, a mode open to others, a home that is gone', () => {
    const target = join(home, 'elsewhere.jsonl');
    writeFileSync(target, '');
    symlinkSync(target, file);
    const log = logOf();
    expect(() => log.session({ kind: 'enter', sessionId: ID, own: 'asked' })).not.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('');
    rmSync(file);
    writeFileSync(file, '', { mode: 0o666 });
    chmodSync(file, 0o666);
    expect(() => log.session({ kind: 'enter', sessionId: ID, own: 'asked' })).not.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('');
    expect(() => new DiagnosticsLog({ home: join(home, 'missing', 'deeper') }).session({ kind: 'enter', sessionId: ID })).not.toThrow();
    expect(() => new DiagnosticsLog().poll({})).not.toThrow();
  });

  it("reads nothing from a log it can't trust, and skips lines that don't check out", () => {
    writeFileSync(file, `not json\n${JSON.stringify({ v: 1, kind: 'leave', at: '2026-11-06T10:00:00.000Z', sessionId: ID })}\n{"v":2}\n`, { mode: 0o600 });
    expect((readDiagnosticsLog(file) as DiagnosticsLine[]).map((line) => line.kind)).toEqual(['leave']);
    chmodSync(file, 0o666);
    expect(readDiagnosticsLog(file)).toEqual([]);
  });
});
