// The lead and worker routes (W218): ids validated, listed sessions only, JSON only, a body limit, and 409s.
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { leadBriefPath, leadPath, workerBriefPath, workerPath, workerStartedPath, type IndexSnapshot, type LeadBriefResult, type LeadResult, type SessionSummary } from '../shared/protocol.js';
import { workerBriefText, type LiveNames } from './leadBrief.js';
import { LEAD_BODY_MAX_BYTES, registerLeads } from './leadRoutes.js';
import { LeadStore } from './leads.js';

const uuid = (d: string) => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
const A = uuid('a');
const B = uuid('b');
const C = uuid('c');
const UNLISTED = uuid('d');

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

function setup(options: { listed?: boolean; spawned?: string[] | null; live?: () => LiveNames } = {}) {
  const store = new LeadStore({ now: () => new Date('2026-11-27T10:00:00.000Z'), readDerived: async () => ({}), readReport: async () => ({}) });
  const snapshot: IndexSnapshot = {
    generatedAt: '2026-11-27T10:00:00.000Z',
    roots: ['/tmp/pitwall-test-root'],
    groups: [{ key: '/tmp/pitwall-test-root/repo', label: 'repo', kind: 'git', root: '/tmp/pitwall-test-root', sessions: [session(A), session(B), session(C), session('deploy')] }],
    source: { ok: true },
  };
  const app = new Hono();
  registerLeads(app, {
    snapshots: { latest: () => (options.listed === false ? undefined : snapshot) },
    store,
    ...(options.spawned === null ? {} : { spawned: new Set(options.spawned ?? []) }),
    ...(options.live === undefined ? {} : { live: options.live }),
  });
  const post = async (path: string, body: unknown, type = 'application/json') => {
    const res = await app.request(path, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as LeadResult, cache: res.headers.get('cache-control') };
  };
  const get = async (path: string) => {
    const res = await app.request(path);
    return { status: res.status, json: (await res.json()) as LeadBriefResult, cache: res.headers.get('cache-control') };
  };
  return { store, post, get };
}

describe('the lead routes', () => {
  it('Make lead and Not a lead', async () => {
    const { store, post } = setup();
    expect(await post(leadPath(A), { on: true })).toEqual({ status: 200, json: { ok: true }, cache: 'no-store' });
    expect(store.tree().marked.has(A)).toBe(true);
    expect((await post(leadPath(A), { on: false })).status).toBe(200);
    expect(store.tree().leads.size).toBe(0);
  });

  it('Report to… and Not a worker', async () => {
    const { store, post } = setup();
    await post(leadPath(A), { on: true });
    expect((await post(workerPath(B), { lead: A })).status).toBe(200);
    expect(store.tree().leadOf.get(B)).toEqual({ lead: A, how: 'reported' });
    expect((await post(workerPath(B), { lead: null })).status).toBe(200);
    expect(store.tree().leadOf.has(B)).toBe(false);
  });

  it('refuses a session id that isn’t listed, isn’t valid, or before the first listing', async () => {
    const { post } = setup();
    expect((await post(leadPath(UNLISTED), { on: true })).status).toBe(404);
    expect((await post(leadPath('../etc'), { on: true })).status).toBe(400);
    // Listed, but not a UUID: nothing to record it by.
    expect((await post(leadPath('deploy'), { on: true })).status).toBe(400);
    expect((await setup({ listed: false }).post(leadPath(A), { on: true })).status).toBe(503);
  });

  it('refuses a body lead that isn’t valid or isn’t listed', async () => {
    const { post } = setup();
    await post(leadPath(A), { on: true });
    expect((await post(workerPath(B), { lead: '../etc' })).status).toBe(400);
    expect((await post(workerPath(B), { lead: 42 })).status).toBe(400);
    expect((await post(workerPath(B), { lead: 'deploy' })).status).toBe(400);
    const unlisted = await post(workerPath(B), { lead: UNLISTED });
    expect(unlisted.status).toBe(409);
    expect(unlisted.json).toMatchObject({ ok: false });
  });

  it('refuses anything but a JSON body of exactly the one field, and a large one', async () => {
    const { post } = setup();
    expect((await post(leadPath(A), { on: true }, 'text/plain')).status).toBe(415);
    expect((await post(leadPath(A), '{"on":')).status).toBe(400);
    expect((await post(leadPath(A), { on: 'yes' })).status).toBe(400);
    expect((await post(leadPath(A), { on: true, lead: A })).status).toBe(400);
    expect((await post(leadPath(A), {})).status).toBe(400);
    expect((await post(leadPath(A), [true])).status).toBe(400);
    expect((await post(workerPath(B), { worker: A })).status).toBe(400);
    expect((await post(workerPath(B), { lead: A, pad: 'x'.repeat(LEAD_BODY_MAX_BYTES) })).status).toBe(413);
  });

  it('answers 409 when the store refuses: a worker made a lead, a lead made a worker, a lead that isn’t one, itself', async () => {
    const { post } = setup();
    expect((await post(workerPath(B), { lead: A })).status).toBe(409);
    await post(leadPath(A), { on: true });
    await post(workerPath(B), { lead: A });
    const refused = await post(leadPath(B), { on: true });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ ok: false, error: expect.stringContaining('worker') });
    expect((await post(workerPath(A), { lead: C })).status).toBe(409);
    expect((await post(workerPath(A), { lead: A })).status).toBe(409);
  });

  it('notes a started worker only for a short id this pitwall just spawned', async () => {
    const { store, post } = setup({ spawned: ['0f0f0f0f'] });
    expect((await post(workerStartedPath(A), { shortId: '1e1e1e1e' })).status).toBe(409);
    expect((await post(workerStartedPath(A), { shortId: '../etc' })).status).toBe(400);
    expect((await post(workerStartedPath(A), { shortId: '0F0F0F0F' })).status).toBe(400);
    expect((await post(workerStartedPath(UNLISTED), { shortId: '0f0f0f0f' })).status).toBe(404);
    expect((await post(workerStartedPath(A), { shortId: '0f0f0f0f' })).status).toBe(200);
    // The link waits for the listing: once a snapshot lists the job, A is its lead.
    store.decorate({
      generatedAt: '2026-11-27T10:00:05.000Z',
      roots: ['/tmp/pitwall-test-root'],
      groups: [{ key: 'k', label: 'repo', kind: 'git', root: '/tmp/pitwall-test-root', sessions: [session(A), session(C, { shortId: '0f0f0f0f' })] }],
      source: { ok: true },
    });
    expect(store.tree().leadOf.get(C)).toEqual({ lead: A, how: 'started' });
  });

  it('refuses Start a worker… on a worker, and without the spawn record', async () => {
    const { post } = setup({ spawned: ['0f0f0f0f'] });
    await post(leadPath(A), { on: true });
    await post(workerPath(B), { lead: A });
    expect((await post(workerStartedPath(B), { shortId: '0f0f0f0f' })).status).toBe(409);
    expect((await setup({ spawned: null }).post(workerStartedPath(A), { shortId: '0f0f0f0f' })).status).toBe(409);
  });

  it("refuses Start a worker… on a lead only by its own transcript's word (the fix check's N1)", async () => {
    const { store, post } = setup({ spawned: ['0f0f0f0f'] });
    // A shows as a lead in the list, but the trusted tree has no lead A.
    vi.spyOn(store, 'tree').mockReturnValue({ ...store.tree(), leads: new Set([A]) } as ReturnType<typeof store.tree>);
    const refused = await post(workerStartedPath(A), { shortId: '0f0f0f0f' });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ ok: false, error: expect.stringContaining('Confirm as lead') });
    // Confirm as lead (Make lead) makes it one pitwall names, and the start is noted.
    await post(leadPath(A), { on: true });
    expect((await post(workerStartedPath(A), { shortId: '0f0f0f0f' })).status).toBe(200);
  });

  it('answers the worker paragraph for a lead you set, and for a worker’s lead (W218 piece 2)', async () => {
    const { post, get } = setup();
    await post(leadPath(A), { on: true });
    await post(workerPath(B), { lead: A });
    const text = workerBriefText(`pitwall-test-${A.slice(0, 4)}`);
    expect(await get(leadBriefPath(A))).toEqual({ status: 200, json: { ok: true, leadId: A, leadName: `pitwall-test-${A.slice(0, 4)}`, text }, cache: 'no-store' });
    expect(await get(workerBriefPath(B))).toEqual({ status: 200, json: { ok: true, leadId: A, leadName: `pitwall-test-${A.slice(0, 4)}`, text }, cache: 'no-store' });
  });

  it('refuses the paragraph with 409 for a session that isn’t a lead or a worker, and 400, 404 and 503 as the POSTs do', async () => {
    const { get } = setup();
    const notLead = await get(leadBriefPath(A));
    expect(notLead.status).toBe(409);
    expect(notLead.json).toMatchObject({ ok: false, error: expect.any(String) });
    expect((await get(workerBriefPath(B))).status).toBe(409);
    expect((await get(leadBriefPath('../etc'))).status).toBe(400);
    expect((await get(leadBriefPath('deploy'))).status).toBe(400);
    expect((await get(workerBriefPath(UNLISTED))).status).toBe(404);
    expect((await setup({ listed: false }).get(leadBriefPath(A))).status).toBe(503);
  });

  it('refuses the paragraph when another live row, outside the listing, has the lead’s name (the review’s F4)', async () => {
    const name = `pitwall-test-${A.slice(0, 4)}`;
    const elsewhere = { sessionId: UNLISTED, name, kind: 'background' as const, cwd: '/tmp/pitwall-test-elsewhere', pid: 5000, startedAt: '2026-11-27T09:00:00.000Z' };
    const { post, get } = setup({ live: () => ({ rows: [elsewhere] }) });
    await post(leadPath(A), { on: true });
    await post(workerPath(B), { lead: A });
    for (const path of [leadBriefPath(A), workerBriefPath(B)]) {
      const refused = await get(path);
      expect(refused.status, path).toBe(409);
      expect(refused.json).toMatchObject({ ok: false, error: expect.stringMatching(/Another running session/) });
    }
  });
});
