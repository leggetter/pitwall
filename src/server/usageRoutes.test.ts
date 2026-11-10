// The Usage view's route (W158) through the real HTTP server and its /api/* checks, with a stand-in
// source, so no test reads a transcript or runs claude. And pitwall's own processes for the index's
// exclude (own.ts), the `/usage` call among them.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRow } from '../index/agents.js';
import type { Indexer } from '../index/index.js';
import { RUN_RATE_PATH, SNAPSHOT_PATH, USAGE_PATH, type IndexSnapshot, type RunRate, type UsageView, type UsageWindowKey } from '../shared/protocol.js';
import type { UsageSource } from '../usage/service.js';
import type { RunningServer } from './index.js';
import { isPitwallOwn } from './own.js';
import { startServerWithInternals } from './server.js';
import { USAGE_READS_MAX } from './usageRoutes.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';

let tmp: string;
let webRoot: string;
const running: RunningServer[] = [];

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-usage-route-'));
  webRoot = join(tmp, 'web');
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>pitwall</title>');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

const SNAPSHOT: IndexSnapshot = { generatedAt: '2026-11-10T12:00:00.000Z', roots: [], groups: [], source: { ok: true } } as unknown as IndexSnapshot;

const indexer: Indexer = {
  latest: () => SNAPSHOT,
  subscribe: () => () => {},
  conversation: async () => undefined,
  subagents: async () => undefined,
  subagentConversation: async () => undefined,
  pollSoon: () => {},
  noteRestart: () => {},
  turnState: async () => 'unknown',
  runningSubagents: async () => undefined,
  stop: () => {},
};

const VIEW = { window: { key: 'week' } } as unknown as UsageView;

const RATE: RunRate = { status: 'unavailable', readAt: '2026-11-10T12:00:00.000Z', reason: 'timeout' };

function fakeSource(hold?: Promise<void>, planReads = true): UsageSource & { asked: UsageWindowKey[]; closed: number; rates: number } {
  const source = {
    planReads,
    asked: [] as UsageWindowKey[],
    closed: 0,
    rates: 0,
    async runRate() {
      source.rates++;
      return planReads ? RATE : ({ status: 'off' } as const);
    },
    async report() {
      throw new Error('not asked here');
    },
    async view(key: UsageWindowKey) {
      source.asked.push(key);
      await hold;
      return { ...VIEW, window: { ...VIEW.window, key } };
    },
    isOwn: () => false,
    close: () => {
      source.closed++;
    },
  };
  return source;
}

async function start(usage?: UsageSource): Promise<RunningServer> {
  const server = await startServerWithInternals({ indexer, token: TOKEN, webRoot, port: 0, ...(usage === undefined ? {} : { usage }) });
  running.push(server);
  return server;
}

function get(server: RunningServer, path: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Promise<{ status: number; json: unknown; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path, method: 'GET', headers: { host: `127.0.0.1:${server.port}`, ...headers }, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET USAGE_PATH', () => {
  it('answers the window asked for, the week by default, uncached', async () => {
    const usage = fakeSource();
    const server = await start(usage);
    const week = await get(server, USAGE_PATH);
    expect(week.status).toBe(200);
    expect(week.headers['cache-control']).toBe('no-store');
    expect(week.json).toMatchObject({ window: { key: 'week' } });
    expect((await get(server, `${USAGE_PATH}?window=30d`)).json).toMatchObject({ window: { key: '30d' } });
    expect(usage.asked).toEqual(['week', '30d']);
  });

  it('is behind the token and the Origin check, and refuses a window it doesn’t know', async () => {
    const usage = fakeSource();
    const server = await start(usage);
    expect((await get(server, USAGE_PATH, {})).status).toBe(401);
    expect((await get(server, USAGE_PATH, { authorization: 'Bearer wrong-token-0123456789abcdefghijklmnop' })).status).toBe(401);
    expect((await get(server, USAGE_PATH, { authorization: `Bearer ${TOKEN}`, origin: 'http://evil.example' })).status).toBe(403);
    expect((await get(server, USAGE_PATH, { authorization: `Bearer ${TOKEN}`, host: 'localhost' })).status).toBe(403);
    expect((await get(server, `${USAGE_PATH}?window=365d`)).status).toBe(400);
    expect((await get(server, `${USAGE_PATH}?window=week&window=30d`)).status).toBe(400);
    expect(usage.asked).toEqual([]);
  });

  it('answers 404 without a usage source, and 429 past USAGE_READS_MAX reads at once', async () => {
    expect((await get(await start(), USAGE_PATH)).status).toBe(404);
    let release = () => {};
    const usage = fakeSource(new Promise<void>((resolve) => (release = resolve)));
    const server = await start(usage);
    const held = Array.from({ length: USAGE_READS_MAX }, () => get(server, USAGE_PATH));
    while (usage.asked.length < USAGE_READS_MAX) await new Promise((resolve) => setTimeout(resolve, 5));
    const refused = await get(server, USAGE_PATH);
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBe('2');
    release();
    expect((await Promise.all(held)).map((each) => each.status)).toEqual(Array(USAGE_READS_MAX).fill(200));
  });

  it('stops the source’s call on close()', async () => {
    const usage = fakeSource();
    const server = await start(usage);
    running.splice(running.indexOf(server), 1);
    await server.close();
    expect(usage.closed).toBe(1);
  });
});

describe('pitwall’s own processes (the index’s exclude)', () => {
  const row = (extra: Partial<AgentRow>): AgentRow => ({ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'pitwall-test-a', cwd: '/made-up/work/a', kind: 'background', ...extra }) as AgentRow;

  it('leaves out the Usage view’s `/usage` call, with the relay’s, recaps’ and the supervisor’s', () => {
    const own = isPitwallOwn({
      relay: { isRelay: (each) => each.name === 'relay' },
      recaps: { isOwn: (each) => each.name === 'recap' },
      supervisor: { isOwn: (each) => each.name === 'supervisor' },
      usage: { isOwn: (each) => each.name === 'pitwall-usage' },
    });
    for (const name of ['relay', 'recap', 'supervisor', 'pitwall-usage']) expect(own(row({ name }))).toBe(true);
    expect(own(row({}))).toBe(false);
    expect(isPitwallOwn({ relay: { isRelay: () => false } })(row({ name: 'pitwall-usage' }))).toBe(false);
  });
});

describe('GET RUN_RATE_PATH (W159)', () => {
  it('answers the run rate, uncached, behind the token and the Origin check; 404 without a usage source', async () => {
    const usage = fakeSource();
    const server = await start(usage);
    const answer = await get(server, RUN_RATE_PATH);
    expect(answer.status).toBe(200);
    expect(answer.headers['cache-control']).toBe('no-store');
    expect(answer.json).toEqual(RATE);
    expect((await get(server, RUN_RATE_PATH, {})).status).toBe(401);
    expect((await get(server, RUN_RATE_PATH, { authorization: `Bearer ${TOKEN}`, origin: 'http://evil.example' })).status).toBe(403);
    expect(usage.rates).toBe(1);
    expect((await get(await start(), RUN_RATE_PATH)).status).toBe(404);
  });

  it('the snapshot says the run rate is on only when the source reads the plan’s percentages', async () => {
    expect((await get(await start(fakeSource()), SNAPSHOT_PATH)).json).toMatchObject({ planUsage: 'on' });
    const off = fakeSource(undefined, false);
    const server = await start(off);
    expect((await get(server, SNAPSHOT_PATH)).json).not.toHaveProperty('planUsage');
    expect((await get(server, RUN_RATE_PATH)).json).toEqual({ status: 'off' });
    expect((await get(await start(), SNAPSHOT_PATH)).json).not.toHaveProperty('planUsage');
  });
});
