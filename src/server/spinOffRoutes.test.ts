// Spin-off proposals' check (W163) on a bare Hono app, with a real folder under a made-up root, since
// checkSpawn() reads the directory by its real path. Made-up sessions only.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spinOffPath, type IndexSnapshot, type SessionSummary, type SpinOff, type SpinOffCheck } from '../shared/protocol.js';
import { registerSpinOffs } from './spinOffRoutes.js';

const ID = '44444444-4444-4444-8444-444444444444';
const KEY = '0123456789abcdef';

let root: string;
let repo: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-test-spin-off-')));
  repo = join(root, 'repo');
  mkdirSync(repo);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function session(spinOff: SpinOff | undefined): SessionSummary {
  return {
    sessionId: ID,
    name: 'pitwall-test-spin-off',
    kind: 'interactive',
    cwd: repo,
    alive: true,
    startedAt: '2026-11-07T00:00:00.000Z',
    stale: false,
    finished: false,
    transcript: 'ok',
    ...(spinOff === undefined ? {} : { spinOff }),
  };
}

function app(spinOff: SpinOff | undefined) {
  const snapshot: IndexSnapshot = {
    generatedAt: '2026-11-07T10:00:00.000Z',
    roots: [root],
    groups: [{ key: repo, label: 'repo', kind: 'git', root, sessions: [session(spinOff)] }],
    source: { ok: true },
  };
  const hono = new Hono();
  registerSpinOffs(hono, { snapshots: { latest: () => snapshot } });
  return async (body: unknown = { key: KEY }, id = ID, type = 'application/json') => {
    const response = await hono.request(spinOffPath(id), { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: response.status, json: (await response.json()) as SpinOffCheck, cache: response.headers.get('cache-control') };
  };
}

const proposal = (overrides: Partial<Extract<SpinOff, { kind: 'proposal' }>> = {}): SpinOff => ({ kind: 'proposal', key: KEY, folder: '', prompt: 'Tidy the README.', ...overrides });

describe('POST spinOffPath()', () => {
  it('answers with the proposal as checked: the folder by its real path, the name and the prompt', async () => {
    const check = app(proposal({ folder: `${repo}/`, name: 'pitwall-test-tidy' }));
    expect(await check()).toEqual({ status: 200, json: { ok: true, cwd: repo, name: 'pitwall-test-tidy', prompt: 'Tidy the README.' }, cache: 'no-store' });
  });

  it('leaves the name out when the proposal has none', async () => {
    expect((await app(proposal({ folder: repo }))()).json).toEqual({ ok: true, cwd: repo, prompt: 'Tidy the README.' });
  });

  it('refuses what spawn_session refuses, with why', async () => {
    const refused = async (overrides: Partial<Extract<SpinOff, { kind: 'proposal' }>>) => {
      const answer = await app(proposal({ folder: repo, ...overrides }))();
      expect(answer.status).toBe(409);
      return answer.json.ok ? '' : answer.json.error;
    };
    expect(await refused({ folder: tmpdir() })).toMatch(/root/i);
    expect(await refused({ folder: join(repo, 'missing') })).not.toBe('');
    expect(await refused({ name: 'a/b' })).toMatch(/name/);
    expect(await refused({ name: 'pitwall-supervisor' })).toMatch(/pitwall's own/);
    expect(await refused({ prompt: 'update' })).toMatch(/claude command/);
    expect(await refused({ prompt: 'Go​ now.' })).toMatch(/doesn't show as itself/);
  });

  it('refuses when there is no proposal, another one than the card showed, or one pitwall couldn’t read', async () => {
    expect(await app(undefined)()).toMatchObject({ status: 409, json: { ok: false } });
    expect(await app(proposal({ folder: repo, key: 'fedcba9876543210' }))()).toMatchObject({ status: 409, json: { ok: false, error: expect.stringMatching(/proposed something else/) } });
    expect(await app({ kind: 'unreadable', key: KEY, problem: 'The block names no folder.' })()).toEqual({ status: 409, json: { ok: false, error: 'The block names no folder.' }, cache: 'no-store' });
  });

  it('refuses a body that isn’t { key }, a body that isn’t JSON, and an unknown or unsafe id', async () => {
    const check = app(proposal({ folder: repo }));
    expect((await check({})).status).toBe(400);
    expect((await check({ key: KEY, prompt: 'Something else.' })).status).toBe(400);
    expect((await check({ key: 'not-a-key' })).status).toBe(400);
    expect((await check('not json')).status).toBe(400);
    expect((await check({ key: KEY }, ID, 'text/plain')).status).toBe(415);
    expect((await check({ key: KEY }, '55555555-5555-4555-8555-555555555555')).status).toBe(404);
    expect((await check({ key: KEY }, '../etc')).status).toBe(400);
    expect((await check({ key: KEY, pad: 'x'.repeat(300) })).status).toBe(413);
  });
});
