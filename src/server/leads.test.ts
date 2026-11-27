// Leads and workers (W218): the tree, the store's file, its changes and undoing them, and the snapshot's decoration.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IndexSnapshot, SessionLineageLinks, SessionSummary } from '../shared/protocol.js';
import type { DerivedFrom } from '../index/lineageSources.js';
import { LEADS_FILE_MAX_BYTES, LEADS_FILE_NAME, LEADS_HELD_MAX, LeadStore, readLeadsFile, treeOf, WORKER_EXPECTED_MAX, WORKER_WAIT_MS, type LeadLink, type LeadMark, type TreeInput } from './leads.js';

/** A canonical UUID made of one hex digit. */
const uuid = (d: string) => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
const A = uuid('a');
const B = uuid('b');
const C = uuid('c');
const D = uuid('d');
const E = uuid('e');

const at = (minute: number) => new Date(Date.UTC(2026, 10, 27, 10, minute)).toISOString();
const mark = (id: string, minute: number, on = true): LeadMark => ({ id, at: at(minute), on });
const link = (lead: string, worker: string, minute: number, on = true, how?: 'started' | 'reported'): LeadLink => ({ lead, worker, at: at(minute), on, ...(how === undefined ? {} : { how }) });

function tree(input: Partial<TreeInput> & { successors?: Record<string, string> }) {
  const successors = input.successors ?? {};
  return treeOf({
    marks: input.marks ?? [],
    links: input.links ?? [],
    derived: input.derived ?? { launchedBy: new Map(), clearedFrom: new Map() },
    successorOf: input.successorOf ?? ((id) => successors[id]),
  });
}

describe('treeOf()', () => {
  it('makes a lead from a mark or a link, with its workers oldest link first', () => {
    const t = tree({ marks: [mark(A, 0)], links: [link(B, D, 3), link(B, C, 2)] });
    expect([...t.leads].sort()).toEqual([A, B]);
    expect([...t.marked]).toEqual([A]);
    expect(t.workersOf.get(B)).toEqual([C, D]);
    expect(t.leadOf.get(C)).toEqual({ lead: B, how: 'reported' });
  });

  it('takes the newest entry of each key: a later off undoes a mark or a link, and a later on brings it back', () => {
    expect(tree({ marks: [mark(A, 0), mark(A, 1, false)] }).leads.size).toBe(0);
    expect(tree({ marks: [mark(A, 1, false), mark(A, 0)] }).leads.size).toBe(0);
    expect(tree({ links: [link(A, B, 0), link(A, B, 1, false)] }).leadOf.size).toBe(0);
    expect(tree({ links: [link(A, B, 0), link(A, B, 1, false), link(A, B, 2, true, 'started')] }).leadOf.get(B)).toEqual({ lead: A, how: 'started' });
  });

  it('is one level: a lead is never a worker, and a worker has one lead, the newest link winning', () => {
    // B reports to A, then later C to B. Newest first: B→C is taken, so B is a lead and A→B isn't.
    let t = tree({ links: [link(A, B, 0), link(B, C, 1)] });
    expect(t.leadOf.get(C)?.lead).toBe(B);
    expect(t.leadOf.has(B)).toBe(false);
    // A marked lead isn't taken as a worker.
    t = tree({ marks: [mark(B, 0)], links: [link(A, B, 1)] });
    expect(t.leadOf.has(B)).toBe(false);
    expect(t.leads.has(A)).toBe(false);
    // Two leads for one worker: the newer link wins.
    t = tree({ links: [link(A, C, 0), link(B, C, 1)] });
    expect(t.leadOf.get(C)?.lead).toBe(B);
    expect(t.leads.has(A)).toBe(false);
    // Never its own worker.
    expect(tree({ links: [link(A, A, 0)] }).leads.size).toBe(0);
  });

  it('reads every id as the newest in its chain: lineage, then a derived-from clear', () => {
    // A continued by B (lineage); C cleared into D (derived-from).
    const t = tree({ marks: [mark(A, 0)], links: [link(A, C, 1)], successors: { [A]: B }, derived: { launchedBy: new Map(), clearedFrom: new Map([[D, C]]) } });
    expect([...t.leads]).toEqual([B]);
    expect([...t.marked]).toEqual([B]);
    expect(t.leadOf.get(D)).toEqual({ lead: B, how: 'reported' });
    expect(t.leadOf.has(C)).toBe(false);
  });

  it('stops at a loop in the chain', () => {
    const t = tree({ marks: [mark(A, 0)], successors: { [A]: B, [B]: A } });
    expect(t.leads.size).toBe(1);
  });

  it('counts a launch only under a lead already, and not once you said Not a worker for that pair', () => {
    const launches = (pairs: [string, string][]) => ({ launchedBy: new Map(pairs), clearedFrom: new Map<string, string>() });
    // A launched B, but A isn't a lead: nothing.
    expect(tree({ derived: launches([[B, A]]) }).leads.size).toBe(0);
    // A marked: B is its worker, launched.
    expect(tree({ marks: [mark(A, 0)], derived: launches([[B, A]]) }).leadOf.get(B)).toEqual({ lead: A, how: 'launched' });
    // An off link for the pair, as written, keeps it undone.
    expect(tree({ marks: [mark(A, 0)], links: [link(A, B, 1, false)], derived: launches([[B, A]]) }).leadOf.has(B)).toBe(false);
    // A launch never makes a lead a worker, nor overrides your link.
    expect(tree({ marks: [mark(A, 0), mark(B, 0)], derived: launches([[B, A]]) }).leadOf.has(B)).toBe(false);
    expect(tree({ marks: [mark(A, 0)], links: [link(C, B, 1)], derived: launches([[B, A]]) }).leadOf.get(B)?.lead).toBe(C);
    // A launcher that's a worker can't take workers.
    expect(tree({ links: [link(C, A, 1)], derived: launches([[B, A]]) }).leadOf.has(B)).toBe(false);
  });
});

/** A lineage stand-in: successors by hand, and its listeners. */
function fakeLineage(successors: Record<string, string> = {}) {
  const listeners = new Set<() => void>();
  return {
    successors,
    linksOf: (id: string): SessionLineageLinks => (successors[id] === undefined ? {} : { to: successors[id] }),
    soleSuccessorOf: (id: string): string | undefined => successors[id],
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tell: () => {
      for (const listener of listeners) listener();
    },
    count: () => listeners.size,
  };
}

function session(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    name: `pitwall-test-${sessionId.slice(0, 4)}`,
    kind: 'background',
    cwd: '/tmp/pitwall-test-root/repo',
    alive: true,
    pid: 4242,
    startedAt: '2026-11-27T09:00:00.000Z',
    stale: false,
    finished: false,
    transcript: 'ok',
    ...overrides,
  };
}

function snapshotOf(...sessions: SessionSummary[]): IndexSnapshot {
  return {
    generatedAt: '2026-11-27T10:00:00.000Z',
    roots: ['/tmp/pitwall-test-root'],
    groups: [{ key: '/tmp/pitwall-test-root/repo', label: 'repo', kind: 'git', root: '/tmp/pitwall-test-root', sessions }],
    source: { ok: true },
  };
}

const byId = (snapshot: IndexSnapshot) => new Map(snapshot.groups.flatMap((group) => group.sessions).map((each) => [each.sessionId, each]));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('LeadStore', () => {
  let home: string;
  let clock: number;
  const now = () => new Date(clock);
  const none = async (): Promise<DerivedFrom> => ({});
  const noReport = async () => ({});
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'pitwall-test-leads-'));
    clock = Date.parse('2026-11-27T10:00:00.000Z');
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  const file = () => path.join(home, LEADS_FILE_NAME);

  it('marks a lead, links a worker and undoes both, keeping each undo in a 0600 file of ids and times only', () => {
    const store = new LeadStore({ readReport: noReport, home, now, readDerived: none });
    expect(store.mark(A, true)).toEqual({ ok: true });
    clock += 1000;
    expect(store.link(B, A, 'reported')).toEqual({ ok: true });
    expect(store.tree().leadOf.get(B)).toEqual({ lead: A, how: 'reported' });
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    clock += 1000;
    expect(store.unlink(B)).toEqual({ ok: true });
    expect(store.tree().leadOf.has(B)).toBe(false);
    clock += 1000;
    store.link(B, A, 'reported');
    clock += 1000;
    expect(store.mark(A, false)).toEqual({ ok: true });
    expect(store.tree().leads.size).toBe(0);
    const written = JSON.parse(readFileSync(file(), 'utf8')) as { v: number; marks: LeadMark[]; links: LeadLink[] };
    expect(written.v).toBe(1);
    expect(written.marks).toEqual([{ id: A, at: new Date(clock).toISOString(), on: false }]);
    expect(written.links).toEqual([{ lead: A, worker: B, at: new Date(clock).toISOString(), on: false }]);
    // Read back by a new store, the undo holds.
    expect(new LeadStore({ readReport: noReport, home, now, readDerived: none }).tree().leads.size).toBe(0);
  });

  it('refuses what would break one level, and a link to a session that isn’t a lead', () => {
    const store = new LeadStore({ readReport: noReport, now, readDerived: none });
    expect(store.link(B, A, 'reported')).toMatchObject({ ok: false });
    store.mark(A, true);
    expect(store.link(A, A, 'reported')).toMatchObject({ ok: false });
    expect(store.link(B, A, 'reported')).toEqual({ ok: true });
    expect(store.mark(B, true)).toMatchObject({ ok: false });
    store.mark(C, true);
    expect(store.link(C, B, 'reported')).toMatchObject({ ok: false });
    expect(store.link(A, C, 'reported')).toMatchObject({ ok: false });
    expect(store.mark('not-an-id', true)).toMatchObject({ ok: false });
    expect(store.link(B, '../x', 'reported')).toMatchObject({ ok: false });
    expect(store.isWorker(B)).toBe(true);
    expect(store.isWorker(A)).toBe(false);
    // Doing it again is fine.
    expect(store.mark(A, true)).toEqual({ ok: true });
    expect(store.link(B, A, 'reported')).toEqual({ ok: true });
    expect(store.mark(D, false)).toEqual({ ok: true });
    expect(store.unlink(D)).toEqual({ ok: true });
  });

  it('Report to… another lead moves the worker', () => {
    const store = new LeadStore({ readReport: noReport, now, readDerived: none });
    store.mark(A, true);
    store.mark(C, true);
    store.link(B, A, 'reported');
    clock += 1000;
    store.link(B, C, 'reported');
    expect(store.tree().leadOf.get(B)?.lead).toBe(C);
    expect(store.tree().workersOf.get(A)).toBeUndefined();
  });

  it('reads an older id in a chain as the newest, for leads and workers', () => {
    const lineage = fakeLineage({ [A]: B });
    const store = new LeadStore({ readReport: noReport, now, lineage, readDerived: none });
    store.mark(A, true);
    expect([...store.tree().leads]).toEqual([B]);
    // Report to… the old id, or the new one, is the same lead.
    expect(store.link(C, A, 'reported')).toEqual({ ok: true });
    expect(store.tree().leadOf.get(C)?.lead).toBe(B);
    // Not a lead on the newest takes off the mark the older one holds.
    clock += 1000;
    expect(store.mark(B, false)).toEqual({ ok: true });
    expect(store.tree().leads.size).toBe(0);
    expect(store.tree().leadOf.size).toBe(0);
    // A new lineage link tells the store's listeners.
    let told = 0;
    store.subscribe(() => told++);
    lineage.tell();
    expect(told).toBe(1);
    store.close();
    expect(lineage.count()).toBe(0);
  });

  it('merges what another pitwall wrote, the newer entry of each key winning', () => {
    const first = new LeadStore({ readReport: noReport, home, now, readDerived: none });
    const second = new LeadStore({ readReport: noReport, home, now, readDerived: none });
    first.mark(A, true);
    clock += 1000;
    second.mark(C, true);
    const third = new LeadStore({ readReport: noReport, home, now, readDerived: none });
    expect([...third.tree().leads].sort()).toEqual([A, C]);
    // An older off from the second doesn't undo the first's newer mark.
    clock += 1000;
    first.mark(A, false);
    clock += 1000;
    first.mark(A, true);
    expect(new LeadStore({ readReport: noReport, home, now, readDerived: none }).tree().leads.has(A)).toBe(true);
  });

  it('reads a future time in the file as now, so a planted entry can’t beat Make lead or push new links out (W218 review, F1)', () => {
    const future = '2099-01-01T00:00:00.000Z';
    const planted = Array.from({ length: LEADS_HELD_MAX }, (_, i) => ({ lead: C, worker: `cccccccc-cccc-4ccc-8ccc-${i.toString(16).padStart(12, '0')}`, at: future, on: false }));
    writeFileSync(file(), JSON.stringify({ v: 1, marks: [{ id: A, at: future, on: false }], links: planted }), { mode: 0o600 });
    expect(readLeadsFile(file(), now()).marks).toEqual([{ id: A, at: now().toISOString(), on: false }]);
    const store = new LeadStore({ readReport: noReport, home, now, readDerived: none });
    clock += 1000;
    expect(store.mark(A, true)).toEqual({ ok: true });
    expect(store.tree().marked.has(A)).toBe(true);
    clock += 1000;
    expect(store.link(B, A, 'reported')).toEqual({ ok: true });
    // Still there after another pitwall reads the file, and not pushed out by the planted 500.
    const again = new LeadStore({ readReport: noReport, home, now, readDerived: none });
    expect(again.tree().marked.has(A)).toBe(true);
    expect(again.tree().leadOf.get(B)).toEqual({ lead: A, how: 'reported' });
    expect(readFileSync(file(), 'utf8')).not.toContain('2099');
  });

  it('refuses a change the tree doesn’t show afterwards, so a 200 means it took (W218 review, F1)', () => {
    writeFileSync(file(), JSON.stringify({ v: 1, marks: [{ id: A, at: at(0), on: false }], links: [] }), { mode: 0o600 });
    const store = new LeadStore({ readReport: noReport, home, now, readDerived: none });
    // Another pitwall's file fills up with LEADS_HELD_MAX marks dated in the future, read as now: as new as
    // Make lead's own, which then loses its place in the newest LEADS_HELD_MAX.
    const planted = Array.from({ length: LEADS_HELD_MAX }, (_, i) => ({ id: `cccccccc-cccc-4ccc-8ccc-${i.toString(16).padStart(12, '0')}`, at: '2099-01-01T00:00:00.000Z', on: false }));
    writeFileSync(file(), JSON.stringify({ v: 1, marks: [{ id: A, at: at(0), on: false }, ...planted], links: [] }), { mode: 0o600 });
    expect(store.mark(A, true)).toMatchObject({ ok: false });
    expect(store.tree().marked.has(A)).toBe(false);
    // Again a moment later: the file's times are in the past now, so it takes.
    clock += 1000;
    expect(store.mark(A, true)).toEqual({ ok: true });
    expect(new LeadStore({ readReport: noReport, home, now, readDerived: none }).tree().marked.has(A)).toBe(true);
  });

  it('Not a lead drops a Start a worker… still waited for, so it doesn’t make the session a lead again (W218 review, F3)', async () => {
    const store = new LeadStore({ readReport: noReport, now, readDerived: none });
    store.mark(A, true);
    expect(store.expectWorker('0f0f0f0f', A)).toBe(true);
    expect(store.mark(A, false)).toEqual({ ok: true });
    const s = byId(store.decorate(snapshotOf(session(A), session(B, { shortId: '0f0f0f0f' }))));
    expect(s.get(A)?.lead).toBeUndefined();
    expect(s.get(B)?.workerOf).toBeUndefined();
    expect(store.tree().leads.size).toBe(0);
    await settle();
  });

  describe('readLeadsFile()', () => {
    const good = { v: 1, marks: [mark(A, 0)], links: [link(A, B, 1, true, 'started')] };
    const write = (value: unknown, mode = 0o600) => {
      writeFileSync(file(), typeof value === 'string' ? value : JSON.stringify(value), { mode });
      chmodSync(file(), mode);
    };

    it('reads a good file', () => {
      write(good);
      expect(readLeadsFile(file())).toEqual({ marks: good.marks, links: good.links });
    });

    it('reads nothing from a symlink, a group- or world-writable file, an oversize one, a folder, bad JSON or another version', () => {
      write(good);
      const link2 = path.join(home, 'link.json');
      symlinkSync(file(), link2);
      expect(readLeadsFile(link2)).toEqual({ marks: [], links: [] });
      write(good, 0o620);
      expect(readLeadsFile(file()).marks).toEqual([]);
      write(good, 0o602);
      expect(readLeadsFile(file()).marks).toEqual([]);
      write(' '.repeat(LEADS_FILE_MAX_BYTES + 1));
      expect(readLeadsFile(file()).marks).toEqual([]);
      write('{"v":1,');
      expect(readLeadsFile(file()).marks).toEqual([]);
      write({ ...good, v: 2 });
      expect(readLeadsFile(file()).marks).toEqual([]);
      const folder = path.join(home, 'folder');
      mkdirSync(folder);
      expect(readLeadsFile(folder).marks).toEqual([]);
      expect(readLeadsFile(path.join(home, 'nope.json')).marks).toEqual([]);
    });

    it('skips entries that don’t check out, field by field, and drops fields it doesn’t know', () => {
      write({
        v: 1,
        marks: [mark('x', 0), { ...mark(A, 0), at: 'yesterday' }, { ...mark(A, 0), on: 'yes' }, { ...mark(C, 0), name: 'secret' }, null],
        links: [
          link(A, A, 0),
          link(A, 'x', 0),
          { ...link(A, B, 0), how: 'launched' },
          { ...link(A, B, 0), at: '2026-11-27T10:00:00Z' },
          { ...link(A, D, 0, false, 'reported') },
          { ...link(A, E, 0, true, 'reported'), prompt: 'secret' },
        ],
      });
      expect(readLeadsFile(file())).toEqual({ marks: [mark(C, 0)], links: [link(A, D, 0, false), link(A, E, 0, true, 'reported')] });
    });

    it('keeps the newest LEADS_HELD_MAX of each', () => {
      const many = Array.from({ length: LEADS_HELD_MAX + 5 }, (_, i) => {
        const hex = i.toString(16).padStart(12, '0');
        return { id: `aaaaaaaa-aaaa-4aaa-8aaa-${hex}`, at: new Date(Date.UTC(2026, 10, 27, 0, 0, i)).toISOString(), on: true };
      });
      write({ v: 1, marks: many.slice().reverse(), links: [] });
      const read = readLeadsFile(file()).marks;
      expect(read).toHaveLength(LEADS_HELD_MAX);
      expect(read[0]).toEqual(many[5]);
      expect(read.at(-1)).toEqual(many.at(-1));
    });
  });

  describe('decorate()', () => {
    it('sets `lead` on listed leads and `workerOf` on listed workers whose lead is listed', async () => {
      const store = new LeadStore({ readReport: noReport, now, readDerived: none });
      store.mark(A, true);
      store.link(B, A, 'reported');
      store.mark(D, true);
      const s = byId(store.decorate(snapshotOf(session(A), session(B), session(C), session(D))));
      expect(s.get(A)?.lead).toEqual({ workers: [B], marked: true });
      expect(s.get(B)?.workerOf).toEqual({ lead: A, how: 'reported' });
      expect(s.get(B)?.lead).toBeUndefined();
      expect(s.get(C)?.lead).toBeUndefined();
      expect(s.get(C)?.workerOf).toBeUndefined();
      expect(s.get(D)?.lead).toEqual({ workers: [], marked: true });
      // The lead not listed: no workerOf; the worker not listed: not in workers.
      expect(byId(store.decorate(snapshotOf(session(B)))).get(B)?.workerOf).toBeUndefined();
      expect(byId(store.decorate(snapshotOf(session(A)))).get(A)?.lead).toEqual({ workers: [], marked: true });
      // Unchanged when nothing is a lead.
      const empty = new LeadStore({ readReport: noReport, now, readDerived: none });
      const snapshot = snapshotOf(session(A));
      expect(empty.decorate(snapshot)).toBe(snapshot);
      await settle();
    });

    it('links a worker by its transcript’s launch only once its launcher is a lead', async () => {
      const derived: Record<string, DerivedFrom> = { [B]: { launchedBy: A } };
      const reads: string[] = [];
      const store = new LeadStore({ readReport: noReport, now, readDerived: async (id) => (reads.push(id), derived[id] ?? {}) });
      const snapshot = snapshotOf(session(A), session(B));
      let told = 0;
      store.subscribe(() => told++);
      store.decorate(snapshot);
      await settle();
      expect(reads.sort()).toEqual([A, B]);
      expect(told).toBe(1);
      expect(byId(store.decorate(snapshot)).get(B)?.workerOf).toBeUndefined();
      store.mark(A, true);
      const s = byId(store.decorate(snapshot));
      expect(s.get(A)?.lead).toEqual({ workers: [B], marked: true });
      expect(s.get(B)?.workerOf).toEqual({ lead: A, how: 'launched' });
      // Read once each this run.
      expect(reads).toHaveLength(2);
      // Not a worker undoes the launch, and it stays undone.
      clock += 1000;
      expect(store.unlink(B)).toEqual({ ok: true });
      expect(byId(store.decorate(snapshot)).get(B)?.workerOf).toBeUndefined();
      // Not a lead on A, then Make lead again: the launch stays undone too.
      clock += 1000;
      store.mark(A, false);
      clock += 1000;
      store.mark(A, true);
      expect(byId(store.decorate(snapshot)).get(B)?.workerOf).toBeUndefined();
    });

    it('reads a young session again while it has no entry, a few times', async () => {
      let calls = 0;
      const store = new LeadStore({ readReport: noReport, now, readDerived: async () => (calls++, {}) });
      const young = snapshotOf(session(A, { startedAt: new Date(clock - 1000).toISOString() }));
      for (let i = 0; i < 8; i++) {
        store.decorate(young);
        await settle();
      }
      expect(calls).toBe(5);
    });

    it('fails soft when a read throws', async () => {
      const store = new LeadStore({ readReport: noReport, now, readDerived: async () => Promise.reject(new Error('boom')) });
      store.mark(A, true);
      expect(byId(store.decorate(snapshotOf(session(A)))).get(A)?.lead).toEqual({ workers: [], marked: true });
      await settle();
    });

    it('links a started worker once the listing has its short id, and only within WORKER_WAIT_MS', async () => {
      const store = new LeadStore({ readReport: noReport, now, readDerived: none });
      expect(store.expectWorker('0f0f0f0f', A)).toBe(true);
      expect(store.expectWorker('nope', A)).toBe(false);
      expect(store.expectWorker('0f0f0f0f', 'x')).toBe(false);
      // Not listed yet.
      expect(byId(store.decorate(snapshotOf(session(A)))).get(A)?.lead).toBeUndefined();
      const s = byId(store.decorate(snapshotOf(session(A), session(B, { shortId: '0f0f0f0f' }))));
      expect(s.get(A)?.lead).toEqual({ workers: [B] });
      expect(s.get(B)?.workerOf).toEqual({ lead: A, how: 'started' });
      // Too late.
      store.expectWorker('1e1e1e1e', A);
      clock += WORKER_WAIT_MS;
      expect(byId(store.decorate(snapshotOf(session(A), session(C, { shortId: '1e1e1e1e' })))).get(C)?.workerOf).toBeUndefined();
      await settle();
    });

    it('doesn’t link a started session that is a lead, or its own lead', async () => {
      const store = new LeadStore({ readReport: noReport, now, readDerived: none });
      store.mark(C, true);
      store.expectWorker('0f0f0f0f', A);
      expect(byId(store.decorate(snapshotOf(session(A), session(C, { shortId: '0f0f0f0f' })))).get(C)?.workerOf).toBeUndefined();
      store.expectWorker('1e1e1e1e', A);
      expect(byId(store.decorate(snapshotOf(session(A, { shortId: '1e1e1e1e' })))).get(A)?.lead).toBeUndefined();
      await settle();
    });

    describe('the report target (W218 piece 2, the review’s F2)', () => {
      const T1 = '2026-11-27T10:42:00.000Z';

      it('stays with your lead when a session’s derived-from clear takes its place, and reports are matched to that lead’s name', async () => {
        // C says, in its own transcript, that it carries on from A after /clear.
        const asked: string[] = [];
        const store = new LeadStore({
          now,
          readDerived: async (id) => (id === C ? { clearedFrom: A } : {}),
          readReport: async (_id, _cwd, name) => (asked.push(name), name === 'pitwall-test-lead' ? { at: T1 } : {}),
        });
        store.mark(A, true);
        store.link(B, A, 'reported');
        const snapshot = snapshotOf(session(A, { name: 'pitwall-test-lead' }), session(B), session(C, { name: 'pitwall-test-claimant' }));
        store.decorate(snapshot);
        await settle();
        // The display tree follows the clear.
        expect(store.tree().leadOf.get(B)?.lead).toBe(C);
        // Where B reports doesn't.
        expect(store.reportTarget(B)).toBe(A);
        expect(store.trustedLead(A)).toBe(A);
        expect(store.trustedLead(C)).toBeUndefined();
        let s = byId(store.decorate(snapshot));
        await settle();
        s = byId(store.decorate(snapshot));
        expect(s.get(B)?.workerOf).toEqual({ lead: C, how: 'reported', reportedAt: T1 });
        expect(new Set(asked)).toEqual(new Set(['pitwall-test-lead']));
      });

      it('follows lineage where a session has one successor, and neither of two', () => {
        const lineage = fakeLineage({ [A]: D });
        const store = new LeadStore({ now, lineage, readDerived: none, readReport: noReport });
        store.mark(A, true);
        store.link(B, A, 'reported');
        expect(store.reportTarget(B)).toBe(D);
        expect(store.trustedLead(A)).toBe(D);
        // Two claim A: the lineage stand-in answers none, as LineageStore.soleSuccessorOf() does.
        const two = { ...fakeLineage(), linksOf: () => ({}), soleSuccessorOf: () => undefined };
        const split = new LeadStore({ now, lineage: two, readDerived: none, readReport: noReport });
        split.mark(A, true);
        split.link(B, A, 'reported');
        expect(split.reportTarget(B)).toBe(A);
        expect(split.trustedLead(A)).toBe(A);
      });

      it('counts a launch for the launched session only, under a lead you set', async () => {
        const store = new LeadStore({ now, readDerived: async (id) => (id === B ? { launchedBy: A } : {}), readReport: noReport });
        store.decorate(snapshotOf(session(A), session(B)));
        await settle();
        expect(store.reportTarget(B)).toBeUndefined();
        store.mark(A, true);
        expect(store.reportTarget(B)).toBe(A);
        expect(store.reportTarget('not an id')).toBeUndefined();
        expect(store.trustedLead('not an id')).toBeUndefined();
      });

      it('has no reportedAt while the lead it reports to isn’t listed', async () => {
        let reads = 0;
        const store = new LeadStore({ now, readDerived: none, readReport: async () => (reads++, { at: T1 }) });
        store.mark(A, true);
        store.link(B, A, 'reported');
        expect(byId(store.decorate(snapshotOf(session(B)))).get(B)?.workerOf).toBeUndefined();
        await settle();
        expect(reads).toBe(0);
      });
    });

    it('holds at most WORKER_EXPECTED_MAX started sessions at once', () => {
      const store = new LeadStore({ readReport: noReport, now, readDerived: none });
      for (let i = 0; i < WORKER_EXPECTED_MAX; i++) expect(store.expectWorker(i.toString(16).padStart(8, '0'), A)).toBe(true);
      expect(store.expectWorker('ffffffff', A)).toBe(false);
      // The same one again is fine.
      expect(store.expectWorker('00000000', A)).toBe(true);
      clock += WORKER_WAIT_MS;
      expect(store.expectWorker('ffffffff', A)).toBe(true);
    });
  });

  it('holds in memory when the file can’t be written', () => {
    const store = new LeadStore({ readReport: noReport, home: path.join(home, 'missing', 'deeper'), now, readDerived: none });
    expect(store.mark(A, true)).toEqual({ ok: true });
    expect(store.tree().leads.has(A)).toBe(true);
  });
});
