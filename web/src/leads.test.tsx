// Leads and workers (W218, leads.ts): arranging a list's rows into leads with their workers, pointers
// and "under" lines; the closed count; which menu items a session offers; pitwall.leads.v1, missing,
// malformed, throwing and capped; and the requests' answers. Made-up sessions only.

import { describe, expect, it, vi } from 'vitest';
import type { SessionGroup, SessionSummary } from '../../src/shared/protocol.js';
import type { ApiClient, ApiResult } from './api.js';
import {
  arrangeLeads,
  closedWorkersText,
  LEAD_FAILED,
  leadActions,
  leadChoices,
  LEADS_CAP,
  LEADS_STORAGE_KEY,
  makeLead,
  readClosedLeads,
  reportTo,
  toggleClosed,
  workerCount,
  workerStarted,
  writeClosedLeads,
  type ArrangedListed,
} from './leads.js';
import type { StorageSource } from './groupState.js';
import type { Listed } from './sessions.js';
import { group, session } from './test/fixtures.js';

const ROOT = '/Users/example/code';
const id = (n: number) => `00000000-0000-4000-8000-0000002180${String(n).padStart(2, '0')}`;
const app = group({ key: `${ROOT}/app`, label: 'app', sessions: [] });
const docs = group({ key: `${ROOT}/docs`, label: 'docs', sessions: [] });

/** A lead in app with three workers: one in app, one finished in app, one in docs; plus a plain session and a worker of a docs lead. */
function made() {
  const lead = session({ sessionId: id(1), name: 'design', cwd: `${ROOT}/app`, lead: { workers: [id(2), id(3), id(4)] } });
  const spike = session({ sessionId: id(2), name: 'spike', cwd: `${ROOT}/app`, workerOf: { lead: id(1), how: 'started' } });
  const flaky = session({ sessionId: id(3), name: 'flaky', cwd: `${ROOT}/app`, finished: true, alive: false, workerOf: { lead: id(1), how: 'reported' } });
  const fix = session({ sessionId: id(4), name: 'docs fix', cwd: `${ROOT}/docs`, status: 'waiting', waitingFor: 'permission prompt', workerOf: { lead: id(1), how: 'launched' } });
  const notes = session({ sessionId: id(5), name: 'notes', cwd: `${ROOT}/app` });
  const other = session({ sessionId: id(6), name: 'other lead', cwd: `${ROOT}/docs`, lead: { workers: [id(7)] } });
  const helper = session({ sessionId: id(7), name: 'helper', cwd: `${ROOT}/app`, workerOf: { lead: id(6), how: 'reported' } });
  return { lead, spike, flaky, fix, notes, other, helper };
}

const at = (s: SessionSummary, g: SessionGroup): Listed => ({ session: s, group: g });

function every(m = made()): Map<string, Listed> {
  const home: [SessionSummary, SessionGroup][] = [
    [m.lead, app],
    [m.spike, app],
    [m.flaky, app],
    [m.fix, docs],
    [m.notes, app],
    [m.other, docs],
    [m.helper, app],
  ];
  return new Map(home.map(([s, g]) => [s.sessionId, at(s, g)]));
}

const names = (rows: readonly (ArrangedListed | { pr: unknown })[]) => rows.map((row) => ('session' in row ? row.session.name : 'pr'));

describe('arrangeLeads', () => {
  it("nests a lead's workers under it in its repo group, oldest link first, a finished one too, and one from another group with that group named", () => {
    const m = made();
    const { current, finished } = arrangeLeads(
      { current: [at(m.notes, app), at(m.spike, app), at(m.lead, app), at(m.helper, app)], finished: [at(m.flaky, app)] },
      { kind: 'group', group: app },
      { every: every(m) },
    );
    expect(names(current)).toEqual(['notes', 'design', 'helper']);
    expect(finished).toEqual([]);
    const lead = current[1] as ArrangedListed;
    expect(lead.workers?.map((w) => [w.session.name, w.repo])).toEqual([
      ['spike', undefined],
      ['flaky', undefined],
      ['docs fix', 'docs'],
    ]);
    expect(lead.workerTotal).toBe(3);
    // helper's lead is listed under docs: a pointer here.
    expect((current[2] as ArrangedListed).pointer).toEqual({ leadId: id(6), leadName: 'other lead', leadRepo: 'docs' });
  });

  it('leaves out a worker from another group that the filters hide', () => {
    const m = made();
    const { current } = arrangeLeads({ current: [at(m.lead, app), at(m.spike, app)], finished: [] }, { kind: 'group', group: app }, { every: every(m), matches: (l) => l.session.name !== 'docs fix' });
    expect((current[0] as ArrangedListed).workers?.map((w) => w.session.name)).toEqual(['spike']);
    expect((current[0] as ArrangedListed).workerTotal).toBe(3);
  });

  it('in All sessions nests only the workers that list has, with no pointers, and a worker whose lead is hidden says "under"', () => {
    const m = made();
    const { current } = arrangeLeads(
      { current: [at(m.lead, app), at(m.spike, app), at(m.fix, docs), at(m.helper, app)], finished: [] },
      { kind: 'all' },
      { every: every(m) },
    );
    expect(names(current)).toEqual(['design', 'helper']);
    expect((current[0] as ArrangedListed).workers?.map((w) => [w.session.name, w.repo])).toEqual([
      ['spike', undefined],
      ['docs fix', undefined],
    ]);
    expect((current[1] as ArrangedListed).pointer).toBeUndefined();
    expect((current[1] as ArrangedListed).under).toEqual({ leadId: id(6), leadName: 'other lead' });
  });

  it('in Needs you stays flat, a worker saying which lead it is under', () => {
    const m = made();
    const { current } = arrangeLeads({ current: [at(m.fix, docs), at(m.notes, app)], finished: [] }, { kind: 'needs-you' }, { every: every(m) });
    expect(names(current)).toEqual(['docs fix', 'notes']);
    expect((current[0] as ArrangedListed).under?.leadName).toBe('design');
    expect((current[1] as ArrangedListed).under).toBeUndefined();
  });

  it("keeps a finished lead with the current rows while a worker isn't finished, and in Finished once all are", () => {
    const m = made();
    const lead = { ...m.lead, finished: true };
    const moved = arrangeLeads({ current: [at(m.spike, app)], finished: [at(lead, app), at(m.flaky, app)] }, { kind: 'all' }, { every: every(m) });
    expect(names(moved.current)).toEqual(['design']);
    expect(moved.finished).toEqual([]);
    const stays = arrangeLeads({ current: [], finished: [at(lead, app), at(m.flaky, app)] }, { kind: 'all' }, { every: every(m) });
    expect(names(stays.finished)).toEqual(['design']);
  });

  it('leaves Pull requests alone, and a lead you marked with no workers has an empty list', () => {
    const m = made();
    const marked = session({ sessionId: id(8), name: 'marked', lead: { workers: [], marked: true } });
    expect(arrangeLeads({ current: [at(m.spike, app)], finished: [] }, { kind: 'prs' }, { every: every(m) }).current[0]).not.toHaveProperty('pointer');
    const { current } = arrangeLeads({ current: [at(marked, app)], finished: [] }, { kind: 'group', group: app }, { every: every(m) });
    expect((current[0] as ArrangedListed).workers).toEqual([]);
  });
});

describe('the counts', () => {
  it('says how many workers, and the most urgent state while they are closed', () => {
    const m = made();
    expect(workerCount(0)).toBe('No workers');
    expect(workerCount(1)).toBe('1 worker');
    expect(workerCount(3)).toBe('3 workers');
    expect(closedWorkersText(3, [{ session: m.spike }, { session: m.fix }])).toBe('3 workers, 1 needs you');
    expect(closedWorkersText(2, [{ session: m.fix }, { session: { ...m.fix, sessionId: id(9) } }])).toBe('2 workers, 2 need you');
    expect(closedWorkersText(1, [{ session: { ...m.spike, status: 'busy' } }])).toBe('1 worker, 1 working');
    expect(closedWorkersText(1, [{ session: m.flaky }])).toBe('1 worker');
  });
});

describe('the menu', () => {
  it('offers a lead Start a worker… and Not a lead; a worker Report to… and Not a worker; anything else Make lead and Report to…', () => {
    const m = made();
    expect(leadActions(m.lead, true)).toEqual(['start-worker', 'not-lead']);
    expect(leadActions(m.spike, true)).toEqual(['report-to', 'not-worker']);
    expect(leadActions(m.notes, true)).toEqual(['make-lead', 'report-to']);
    expect(leadActions(m.notes, false)).toEqual(['make-lead']);
    expect(leadActions(m.flaky, false)).toEqual(['not-worker']);
  });

  it("lists every lead but the session itself, by name, for Report to…", () => {
    const m = made();
    expect(leadChoices(every(m).values(), m.notes.sessionId).map((l) => l.session.name)).toEqual(['design', 'other lead']);
    expect(leadChoices(every(m).values(), m.lead.sessionId).map((l) => l.session.name)).toEqual(['other lead']);
  });
});

function memory(initial?: string) {
  const items = new Map<string, string>(initial === undefined ? [] : [[LEADS_STORAGE_KEY, initial]]);
  const source: StorageSource = () => ({ getItem: (name) => items.get(name) ?? null, setItem: (name, value) => void items.set(name, value) });
  return { items, source };
}

describe('pitwall.leads.v1', () => {
  it('reads closed leads by id only, and nothing from storage that is missing, malformed or throws', () => {
    expect(readClosedLeads(memory().source)).toEqual([]);
    expect(readClosedLeads(memory('not json').source)).toEqual([]);
    expect(readClosedLeads(memory('{"v":2,"closed":[]}').source)).toEqual([]);
    expect(readClosedLeads(memory(JSON.stringify({ v: 1, closed: [id(1), 'design', 7, id(1)] })).source)).toEqual([id(1)]);
    expect(readClosedLeads(() => ({ getItem: () => { throw new Error('blocked'); }, setItem: () => {} }))).toEqual([]);
    expect(readClosedLeads(() => { throw new Error('blocked'); })).toEqual([]);
  });

  it('writes ids only, the newest LEADS_CAP, and ignores a write that throws', () => {
    const store = memory();
    let closed: string[] = [];
    for (let n = 0; n < LEADS_CAP + 5; n++) closed = toggleClosed(closed, `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, false);
    writeClosedLeads(store.source, closed);
    const stored = JSON.parse(store.items.get(LEADS_STORAGE_KEY) ?? '{}') as { v: number; closed: string[] };
    expect(stored.v).toBe(1);
    expect(stored.closed).toHaveLength(LEADS_CAP);
    expect(stored.closed[0]).toBe('00000000-0000-4000-8000-000000000005');
    expect(toggleClosed(closed, stored.closed[0]!, true)).toHaveLength(LEADS_CAP - 1);
    expect(() => writeClosedLeads(() => ({ getItem: () => null, setItem: () => { throw new Error('quota'); } }), closed)).not.toThrow();
  });
});

describe('the requests', () => {
  const answering = (result: ApiResult) => {
    const post = vi.fn<ApiClient['post']>(async () => result);
    return { post };
  };

  it('posts each body to its path, and is done on { ok: true }', async () => {
    const api = answering({ kind: 'ok', status: 200, body: { ok: true } });
    expect(await makeLead(api, id(1), true)).toBeUndefined();
    expect(await reportTo(api, id(2), id(1))).toBeUndefined();
    expect(await reportTo(api, id(2), null)).toBeUndefined();
    expect(await workerStarted(api, id(1), 'a1b2c3d4')).toBeUndefined();
    expect(api.post.mock.calls).toEqual([
      [`/api/sessions/${id(1)}/lead`, { on: true }],
      [`/api/sessions/${id(2)}/worker`, { lead: id(1) }],
      [`/api/sessions/${id(2)}/worker`, { lead: null }],
      [`/api/sessions/${id(1)}/worker-started`, { shortId: 'a1b2c3d4' }],
    ]);
  });

  it("shows a 409's error as it is, and its own words for anything else", async () => {
    expect(await makeLead(answering({ kind: 'failed', status: 409, body: { ok: false, error: 'It’s a worker. Choose Not a worker first, then Make lead.' } }), id(2), true)).toBe(
      'It’s a worker. Choose Not a worker first, then Make lead.',
    );
    expect(await makeLead(answering({ kind: 'failed', status: 500 }), id(2), true)).toBe(LEAD_FAILED);
    expect(await makeLead(answering({ kind: 'unauthorized' }), id(2), true)).toMatch(/Reload the page/);
    expect(await makeLead({ post: () => Promise.reject(new Error('offline')) }, id(2), true)).toBe(LEAD_FAILED);
  });
});
