// Started and dismissed spin-off proposals (W212): the store, its file, the matcher and the routes.
// Made-up sessions and folders under a temporary directory only.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPIN_OFF_MIGRATE_PATH, spinOffSettlePath, type IndexSnapshot, type SessionSummary, type SpinOff } from '../shared/protocol.js';
import { readSpinOffsFile, registerSpinOffSettle, SpinOffStore, SPIN_OFFS_FILE_NAME, SPIN_OFFS_HELD_MAX, spinOffEntryId } from './spinOffs.js';

const PROPOSER = '44444444-4444-4444-8444-444444444444';
const STARTED = '55555555-5555-4555-8555-555555555555';
const LATER = '66666666-6666-4666-8666-666666666666';
const KEY = '0123456789abcdef';
const T0 = '2026-11-24T13:55:00.000Z';
const T1 = '2026-11-24T14:10:00.000Z';

let dir: string;
let home: string;
let folder: string;
let other: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-test-spin-offs-')));
  home = join(dir, 'home');
  folder = join(dir, 'proposed');
  other = join(dir, 'other');
  mkdirSync(folder);
  mkdirSync(other);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const proposal = (overrides: Partial<Extract<SpinOff, { kind: 'proposal' }>> = {}): SpinOff => ({
  kind: 'proposal',
  key: KEY,
  folder,
  name: 'plugin-hosted-mcp-test',
  prompt: 'Try the hosted MCP.',
  ...overrides,
});

function session(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { sessionId: id, name: 'x', kind: 'interactive', cwd: dir, alive: true, startedAt: T0, stale: false, finished: false, transcript: 'ok', ...overrides };
}

const proposer = (spinOff: SpinOff | undefined = proposal()) => session(PROPOSER, { name: 'proposer', lastActivityAt: T0, ...(spinOff === undefined ? {} : { spinOff }) });
const started = (overrides: Partial<SessionSummary> = {}) => session(STARTED, { name: 'plugin-hosted-mcp-test', cwd: folder, startedAt: T1, ...overrides });

const snapshotOf = (...sessions: SessionSummary[]): IndexSnapshot => ({
  generatedAt: T1,
  roots: [dir],
  groups: [{ key: dir, label: 'dir', kind: 'git', root: dir, sessions }],
  source: { ok: true },
});

const settledOf = (store: SpinOffStore, snapshot: IndexSnapshot) => store.decorate(snapshot).groups[0]!.sessions.find((each) => each.sessionId === PROPOSER)?.spinOff?.settled;

describe('the matcher', () => {
  it('settles a proposal as started when a session with its name, in its folder, began after it', () => {
    const store = new SpinOffStore({ home });
    expect(settledOf(store, snapshotOf(proposer(), started()))).toMatchObject({ how: 'started', sessionId: STARTED, name: 'plugin-hosted-mcp-test' });
  });

  it('leaves it open for a session started before the proposal, in another folder, or with another name', () => {
    const store = new SpinOffStore({ home });
    expect(settledOf(store, snapshotOf(proposer(), started({ startedAt: '2026-11-24T13:00:00.000Z' })))).toBeUndefined();
    expect(settledOf(store, snapshotOf(proposer(), started({ cwd: other })))).toBeUndefined();
    expect(settledOf(store, snapshotOf(proposer(), started({ name: 'another' })))).toBeUndefined();
    expect(settledOf(store, snapshotOf(proposer(proposal({ name: undefined })), started()))).toBeUndefined();
  });

  it('finds a session begun after the proposer started, however much later the proposer was active', () => {
    const store = new SpinOffStore({ home });
    const busy = session(PROPOSER, { name: 'proposer', lastActivityAt: '2026-11-24T15:00:00.000Z', spinOff: proposal() });
    expect(settledOf(store, snapshotOf(busy, started()))).toMatchObject({ how: 'started', sessionId: STARTED });
  });

  it('does not match a new proposal to a session an earlier proposal of the same session already claimed', () => {
    const OTHER_KEY = 'fedcba9876543210';
    const claimed = new SpinOffStore({ home: join(dir, 'h-claimed') });
    claimed.settle(PROPOSER, OTHER_KEY, 'started', { sessionId: STARTED, name: 'plugin-hosted-mcp-test' });
    expect(settledOf(claimed, snapshotOf(proposer(), started()))).toBeUndefined();
    // A click-started one carries no session id: a session begun before it was settled isn't the next proposal's.
    let now = new Date('2026-11-24T14:20:00.000Z');
    const clicked = new SpinOffStore({ home: join(dir, 'h-clicked'), now: () => now });
    clicked.settle(PROPOSER, OTHER_KEY, 'started');
    expect(settledOf(clicked, snapshotOf(proposer(), started()))).toBeUndefined();
    now = new Date('2026-11-24T14:30:00.000Z');
    expect(settledOf(clicked, snapshotOf(proposer(), started({ startedAt: '2026-11-24T14:25:00.000Z' })))?.sessionId).toBe(STARTED);
  });

  it('keeps a started proposal started when a stale Dismiss comes, and keeps its session on a bare Start', () => {
    const store = new SpinOffStore({ home });
    store.settle(PROPOSER, KEY, 'started', { sessionId: STARTED, name: 'plugin-hosted-mcp-test' });
    store.settle(PROPOSER, KEY, 'dismissed');
    expect(settledOf(store, snapshotOf(proposer()))).toMatchObject({ how: 'started', sessionId: STARTED });
    store.settle(PROPOSER, KEY, 'started');
    expect(settledOf(store, snapshotOf(proposer()))).toMatchObject({ how: 'started', sessionId: STARTED, name: 'plugin-hosted-mcp-test' });
  });

  it('sees another pitwall’s settle on the same home at the next snapshot, and tells its listeners', async () => {
    const a = new SpinOffStore({ home });
    const b = new SpinOffStore({ home });
    const told: string[] = [];
    a.onSettled((id) => told.push(id));
    expect(settledOf(a, snapshotOf(proposer()))).toBeUndefined();
    const before = a.version();
    b.settle(PROPOSER, KEY, 'dismissed');
    expect(settledOf(a, snapshotOf(proposer()))?.how).toBe('dismissed');
    expect(a.version()).toBeGreaterThan(before);
    await Promise.resolve();
    expect(told).toEqual([PROPOSER]);
  });

  it('compares folders by real path', () => {
    const link = join(dir, 'link');
    symlinkSync(folder, link);
    const store = new SpinOffStore({ home });
    expect(settledOf(store, snapshotOf(proposer(proposal({ folder: link })), started()))?.how).toBe('started');
  });

  it('matches whatever the changed prompt says, and counts a job’s later session after /clear', () => {
    const store = new SpinOffStore({ home, predecessorOf: (id) => (id === LATER ? STARTED : undefined) });
    const later = session(LATER, { name: 'renamed-after-clear', cwd: folder, startedAt: '2026-11-24T16:00:00.000Z' });
    expect(settledOf(store, snapshotOf(proposer(proposal({ prompt: 'A different prompt.' })), later, started()))?.sessionId).toBe(STARTED);
    // The first session is gone from the listing: the later one's own name doesn't match, and nothing is found.
    expect(settledOf(new SpinOffStore({ home: join(dir, 'h2'), predecessorOf: () => undefined }), snapshotOf(proposer(), later))).toBeUndefined();
  });

  it('never finds a session’s own hand-off by name and folder, but a click settles it', () => {
    const handoff = proposal({ folder, name: 'plugin-hosted-mcp-test', prompt: `Continues session ${PROPOSER}.\nGo on.` });
    const store = new SpinOffStore({ home });
    const snapshot = snapshotOf(proposer(handoff), started());
    expect(settledOf(store, snapshot)).toBeUndefined();
    store.settle(PROPOSER, KEY, 'started');
    expect(settledOf(store, snapshot)?.how).toBe('started');
  });

  it('keeps what it found when the started session leaves the listing', () => {
    const store = new SpinOffStore({ home });
    settledOf(store, snapshotOf(proposer(), started()));
    expect(settledOf(new SpinOffStore({ home }), snapshotOf(proposer()))).toMatchObject({ how: 'started', sessionId: STARTED });
  });

  it('a repeated identical block keeps its key, so it stays settled; a new key shows again', () => {
    const store = new SpinOffStore({ home });
    store.settle(PROPOSER, KEY, 'dismissed');
    expect(settledOf(store, snapshotOf(proposer()))?.how).toBe('dismissed');
    expect(settledOf(store, snapshotOf(proposer(proposal({ key: 'fedcba9876543210' }))))).toBeUndefined();
  });
});

describe('the file', () => {
  it('is 0600, written whole, and read by another store on the same home', () => {
    const store = new SpinOffStore({ home });
    store.settle(PROPOSER, KEY, 'dismissed');
    const file = join(home, SPIN_OFFS_FILE_NAME);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('Try the hosted MCP');
    expect(new SpinOffStore({ home }).size()).toBe(1);
  });

  it('merges another pitwall’s entries on write rather than losing them', () => {
    const a = new SpinOffStore({ home });
    const b = new SpinOffStore({ home });
    a.settle(PROPOSER, KEY, 'dismissed');
    b.settle(STARTED, 'fedcba9876543210', 'started');
    expect(new SpinOffStore({ home }).size()).toBe(2);
  });

  it('reads a missing, corrupt, linked, group-writable or oversized file as empty, and skips bad entries', () => {
    const file = join(home, SPIN_OFFS_FILE_NAME);
    expect(readSpinOffsFile(file).size).toBe(0);
    mkdirSync(home, { recursive: true });
    writeFileSync(file, '{ nope', { mode: 0o600 });
    expect(readSpinOffsFile(file).size).toBe(0);
    const good = { id: spinOffEntryId(PROPOSER, KEY), how: 'dismissed', at: T0 };
    const body = JSON.stringify({ v: 1, entries: [good, { id: 'bad', how: 'dismissed', at: T0 }, { ...good, id: spinOffEntryId(STARTED, KEY), how: 'other' }, { ...good, id: spinOffEntryId(LATER, KEY), name: 'a‮b' }, 7] });
    writeFileSync(file, body, { mode: 0o600 });
    expect([...readSpinOffsFile(file).keys()]).toEqual([good.id]);
    chmodSync(file, 0o666);
    expect(readSpinOffsFile(file).size).toBe(0);
    chmodSync(file, 0o600);
    const link = join(home, 'link.json');
    symlinkSync(file, link);
    expect(readSpinOffsFile(link).size).toBe(0);
    writeFileSync(file, JSON.stringify({ v: 1, entries: [], pad: 'x'.repeat(300 * 1024) }), { mode: 0o600 });
    expect(readSpinOffsFile(file).size).toBe(0);
  });

  it('keeps at most SPIN_OFFS_HELD_MAX entries, the newest', () => {
    const store = new SpinOffStore({ home });
    const ids = Array.from({ length: SPIN_OFFS_HELD_MAX + 3 }, (_, index) => `${PROPOSER.slice(0, 8)}-0000-4000-8000-${String(index).padStart(12, '0')}:${KEY}`);
    for (let index = 0; index < 4; index += 1) store.migrate(ids.slice(index * 150, index * 150 + 150));
    expect(store.size()).toBeLessThanOrEqual(SPIN_OFFS_HELD_MAX);
  });

  it('holds entries in memory without a home', () => {
    const store = new SpinOffStore();
    store.settle(PROPOSER, KEY, 'dismissed');
    expect(settledOf(store, snapshotOf(proposer()))?.how).toBe('dismissed');
    expect(existsSync(join(home, SPIN_OFFS_FILE_NAME))).toBe(false);
  });
});

describe('the routes', () => {
  function app(spinOff: SpinOff | undefined) {
    const store = new SpinOffStore({ home });
    const snapshot = snapshotOf(spinOff === undefined ? session(PROPOSER, { lastActivityAt: T0 }) : proposer(spinOff));
    const hono = new Hono();
    registerSpinOffSettle(hono, { snapshots: { latest: () => snapshot }, store });
    const post = async (path: string, body: unknown, type = 'application/json') => {
      const response = await hono.request(path, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
      return response.status;
    };
    return { store, post };
  }

  it('records a start or a dismissal of the proposal the card showed', async () => {
    const { store, post } = app(proposal());
    expect(await post(spinOffSettlePath(PROPOSER), { key: KEY, how: 'started' })).toBe(200);
    expect(settledOf(store, snapshotOf(proposer()))?.how).toBe('started');
  });

  it('refuses another key, no proposal, a bad body, another type, an unknown session and a big body', async () => {
    const { post, store } = app(proposal());
    expect(await post(spinOffSettlePath(PROPOSER), { key: 'fedcba9876543210', how: 'dismissed' })).toBe(409);
    expect(await post(spinOffSettlePath(PROPOSER), { key: KEY, how: 'nope' })).toBe(400);
    expect(await post(spinOffSettlePath(PROPOSER), { key: KEY, how: 'dismissed', extra: 1 })).toBe(400);
    expect(await post(spinOffSettlePath(PROPOSER), '{', 'application/json')).toBe(400);
    expect(await post(spinOffSettlePath(PROPOSER), { key: KEY, how: 'dismissed' }, 'text/plain')).toBe(415);
    expect(await post(spinOffSettlePath(STARTED), { key: KEY, how: 'dismissed' })).toBe(404);
    expect(await post(spinOffSettlePath(PROPOSER), { key: KEY, how: 'dismissed', pad: 'x'.repeat(600) })).toBe(413);
    expect(store.size()).toBe(0);
    expect(await app(undefined).post(spinOffSettlePath(PROPOSER), { key: KEY, how: 'dismissed' })).toBe(409);
  });

  it('moves the browser’s old dismissals once, taking only well-formed ids', async () => {
    const { store, post } = app(proposal());
    expect(await post(SPIN_OFF_MIGRATE_PATH, { dismissed: [spinOffEntryId(PROPOSER, KEY), 'bad', 7] })).toBe(200);
    expect(store.size()).toBe(1);
    expect(await post(SPIN_OFF_MIGRATE_PATH, { dismissed: 'x' })).toBe(400);
    expect(await post(SPIN_OFF_MIGRATE_PATH, { dismissed: [] }, 'text/plain')).toBe(415);
  });
});
