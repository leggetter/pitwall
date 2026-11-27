// The lead and worker routes (W218): ids validated, listed sessions only, JSON only, a body limit, and 409s.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { leadPath, workerPath, workerStartedPath, type IndexSnapshot, type LeadResult, type SessionSummary } from '../shared/protocol.js';
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

function setup(options: { listed?: boolean; spawned?: string[] | null } = {}) {
  const store = new LeadStore({ now: () => new Date('2026-11-27T10:00:00.000Z'), readDerived: async () => ({}) });
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
  });
  const post = async (path: string, body: unknown, type = 'application/json') => {
    const res = await app.request(path, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as LeadResult, cache: res.headers.get('cache-control') };
  };
  return { store, post };
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
});
