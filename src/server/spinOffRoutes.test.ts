// Spin-off proposals' check (W163) on a bare Hono app, with a real folder under a made-up root, since
// checkSpawn() reads the directory by its real path. Made-up sessions only.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conversationSpinOffPath, spinOffPath, type ConversationEntry, type ConversationPage, type IndexSnapshot, type SessionSummary, type SpinOff, type SpinOffCheck } from '../shared/protocol.js';
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

// W209: a block in the Conversation tab is found in the transcript, through the conversation reader.
describe('POST conversationSpinOffPath()', () => {
  const block = (overrides: Partial<Extract<SpinOff, { kind: 'proposal' }>> = {}): SpinOff => ({ kind: 'proposal', key: KEY, folder: repo, prompt: 'Tidy the README.', ...overrides });
  const entry = (spinOffs?: ConversationEntry['spinOffs'], kind: ConversationEntry['kind'] = 'assistant'): ConversationEntry => ({ kind, text: 'x', ...(spinOffs === undefined ? {} : { spinOffs }) });

  function scanning(pages: ConversationPage[], reads: string[] = [], extra: Partial<Parameters<typeof registerSpinOffs>[1]> = {}) {
    const snapshot: IndexSnapshot = {
      generatedAt: '2026-11-07T10:00:00.000Z',
      roots: [root],
      groups: [{ key: repo, label: 'repo', kind: 'git', root, sessions: [session(undefined)] }],
      source: { ok: true },
    };
    const hono = new Hono();
    registerSpinOffs(hono, {
      snapshots: { latest: () => snapshot },
      conversation: async (_id, before) => {
        reads.push(before ?? 'newest');
        return pages[before === undefined ? 0 : Number(before)];
      },
      ...extra,
    });
    return async (body: unknown = { key: KEY }, type = 'application/json') => {
      const response = await hono.request(conversationSpinOffPath(ID), { method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body) });
      return { status: response.status, json: (await response.json()) as SpinOffCheck };
    };
  }
  const page = (entries: ConversationEntry[], before?: string): ConversationPage => ({ sessionId: ID, entries, ...(before === undefined ? {} : { before }) });

  it('finds a block in an older message and checks it as the card route does', async () => {
    const reads: string[] = [];
    const check = scanning([page([entry()], '1'), page([entry([{ spinOff: block({ name: 'pitwall-test-tidy' }), lines: 3, check: 'aaaaaaaa' }]), entry()])], reads);
    expect(await check()).toEqual({ status: 200, json: { ok: true, cwd: repo, name: 'pitwall-test-tidy', prompt: 'Tidy the README.' } });
    expect(reads).toEqual(['newest', '1']);
  });

  it('answers 409 for a key that no message has now, or a block that changed', async () => {
    const changed = scanning([page([entry([{ spinOff: block({ key: 'fedcba9876543210' }), lines: 3, check: 'aaaaaaaa' }])])]);
    expect(await changed()).toMatchObject({ status: 409, json: { ok: false, error: expect.stringMatching(/isn’t in the session/) } });
    expect((await scanning([page([])])()).status).toBe(409);
  });

  it('never reads a block from a message that isn’t the assistant’s', async () => {
    expect((await scanning([page([entry([{ spinOff: block(), lines: 3, check: 'aaaaaaaa' }], 'user')])])()).status).toBe(409);
  });

  it('refuses an unreadable block with why, and what spawn_session refuses', async () => {
    const unreadable = scanning([page([entry([{ spinOff: { kind: 'unreadable', key: KEY, problem: 'The block names no folder.' }, lines: 1, check: 'aaaaaaaa' }])])]);
    expect(await unreadable()).toEqual({ status: 409, json: { ok: false, error: 'The block names no folder.' } });
    expect((await scanning([page([entry([{ spinOff: block({ folder: tmpdir() }), lines: 3, check: 'aaaaaaaa' }])])])()).status).toBe(409);
  });

  it('stops reading after its page limit', async () => {
    const reads: string[] = [];
    const endless = Array.from({ length: 40 }, (_unused, index) => page([entry()], String(index + 1)));
    expect((await scanning(endless, reads)()).status).toBe(409);
    expect(reads).toHaveLength(20);
  });

  it('counts each page it reads through the shared read limit, and answers 429 when it is full (F3)', async () => {
    const reads: string[] = [];
    let busy = 0;
    const limit = { full: () => busy >= 1, take: () => void (busy += 1), release: () => void (busy -= 1) };
    const check = scanning([page([entry([{ spinOff: block(), lines: 3, check: 'aaaaaaaa' }])])], reads, { reads: limit });
    expect((await check()).status).toBe(200);
    expect(busy).toBe(0);
    busy = 1;
    expect((await check()).status).toBe(429);
    expect(reads).toHaveLength(1);
  });

  it('gives the read back when the conversation reader throws (F3)', async () => {
    let busy = 0;
    const limit = { full: () => busy >= 1, take: () => void (busy += 1), release: () => void (busy -= 1) };
    const hono = new Hono();
    registerSpinOffs(hono, {
      snapshots: { latest: () => ({ generatedAt: '2026-11-07T10:00:00.000Z', roots: [root], groups: [{ key: repo, label: 'repo', kind: 'git', root, sessions: [session(undefined)] }], source: { ok: true } }) },
      conversation: async () => {
        throw new Error('boom');
      },
      reads: limit,
    });
    const response = await hono.request(conversationSpinOffPath(ID), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY }) });
    expect(response.status).toBe(409);
    expect(busy).toBe(0);
  });

  it('stops paging after its deadline and answers 503 (F3)', async () => {
    const endless = Array.from({ length: 40 }, (_unused, index) => page([entry()], String(index + 1)));
    const reads: string[] = [];
    const result = await scanning(endless, reads, { scanMs: -1 })();
    expect(result.status).toBe(503);
    expect(reads).toHaveLength(0);
  });

  it('refuses a bad body, content type and id like the proposal route', async () => {
    const check = scanning([page([entry([{ spinOff: block(), lines: 3, check: 'aaaaaaaa' }])])]);
    expect((await check({})).status).toBe(400);
    expect((await check({ key: KEY, prompt: 'x' })).status).toBe(400);
    expect((await check({ key: 'nope' })).status).toBe(400);
    expect((await check({ key: KEY }, 'text/plain')).status).toBe(415);
    expect((await check({ key: KEY })).status).toBe(200);
  });
});
