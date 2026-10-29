// End session (W90, spike 005): the route through the real HTTP server and its /api/* checks, with a
// fake `claude agents`, fake ps lookups and a fake signaller, so no test signals a process or runs
// `claude`. src/test/noClaude.ts refuses both anyway. Made-up sessions and pids only.
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { AgentRow, AgentsResult } from '../index/agents.js';
import type { Indexer, TurnState } from '../index/index.js';
import {
  endSessionPath,
  WS_PATH,
  type IndexSnapshot,
  type ServerMessage,
  type SessionSummary,
  type SubagentList,
  type SubagentState,
} from '../shared/protocol.js';
import { pitwallOrigin, proofFor } from '../test/proof.js';
import { CommandSlots } from './actions.js';
import { DEFAULT_END_RATE, END_SIGNAL, isRelayName, parseEndRequest, workingError, type EndOptions, type Signaller } from './end.js';
import type { RunningServer } from './index.js';
import type { ProcessInfo, ProcessLookup, ProcessParents, Processes } from './processes.js';
import type { RelayManager } from './relay.js';
import { startServerWithInternals, type ServerInternals } from './server.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';

let tmp: string;
let webRoot: string;

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'pitwall-test-end-')));
  webRoot = tmp;
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>pitwall</title>');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fixtures

const ROOT = '/Users/pitwall-test/oss';
const CWD = `${ROOT}/repo`;
const INTERACTIVE_ID = '22222222-2222-4222-8222-222222222222';
const BG_ID = '11111111-1111-4111-8111-111111111111';
const ENDED_ID = '66666666-6666-4666-8666-666666666666';
const NO_PID_ID = '33333333-3333-4333-8333-333333333333';
/** Never what the index lists, but refused all the same: an ended session with a pid, and one not alive with one. */
const ENDED_PID_ID = '44444444-4444-4444-8444-444444444444';
const DEAD_PID_ID = '55555555-5555-4555-8555-555555555555';
/** A safe id that isn't a UUID, which the index wouldn't list for an interactive session, but might. */
const NAMED_ID = 'pitwall-test-named';
const PID = 4242;
/** pitwall's own pid in these tests, and the shell and terminal above it. */
const SELF = 7000;
const STARTED = '2026-10-28T10:00:01.500Z';
/** Its process, as ps gives it: a second and a half before the session's startedAt, to the whole second. */
const CLAUDE_PROCESS: ProcessInfo = { startedAtMs: Date.UTC(2026, 9, 28, 10, 0, 0), command: 'claude' };

function session(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId,
    name: 'pitwall-test-end-a',
    kind: 'interactive',
    cwd: CWD,
    pid: PID,
    alive: true,
    status: 'busy',
    startedAt: STARTED,
    stale: false,
    finished: false,
    transcript: 'ok',
    ...overrides,
  };
}

function snapshot(...extra: SessionSummary[]): IndexSnapshot {
  return {
    generatedAt: '2026-10-28T10:05:00.000Z',
    roots: [ROOT],
    groups: [
      {
        key: CWD,
        label: 'repo',
        kind: 'git',
        root: ROOT,
        sessions: [
          session(INTERACTIVE_ID),
          session(BG_ID, { kind: 'background', shortId: 'b3899da0', pid: 5151, state: 'working' }),
          session(ENDED_ID, { pid: undefined, alive: false, status: undefined, finished: true, ended: true }),
          session(NO_PID_ID, { pid: undefined, alive: false, status: undefined }),
          session(ENDED_PID_ID, { finished: true, ended: true }),
          session(DEAD_PID_ID, { alive: false }),
          session(NAMED_ID),
          ...extra,
        ],
      },
    ],
    source: { ok: true },
  };
}

interface FakeIndexer extends Indexer {
  pollSoon: ReturnType<typeof vi.fn<() => void>>;
  turn: TurnState;
  /** Its running sub-agents, by a scan just then; undefined when the scan couldn't read them. */
  running: number | undefined;
}

function fakeIndexer(latest: IndexSnapshot | null = snapshot()): FakeIndexer {
  const indexer: FakeIndexer = {
    turn: 'ended',
    running: 0,
    latest: () => latest ?? undefined,
    subscribe: () => () => {},
    conversation: async () => undefined,
    subagents: async (sessionId): Promise<SubagentList> => ({
      sessionId,
      subagents: [
        ...Array.from({ length: indexer.running ?? 0 }, (_, i) => subagent(`a${i}`, 'running')),
        subagent('done1', 'done'),
      ],
      truncated: false,
    }),
    subagentConversation: async () => undefined,
    pollSoon: vi.fn(),
    noteRestart: vi.fn(),
    turnState: vi.fn(async () => indexer.turn),
    runningSubagents: vi.fn(async () => indexer.running),
    stop: () => {},
  };
  return indexer;
}

function subagent(agentId: string, state: SubagentState) {
  return { agentId, description: 'pitwall-test sub-agent', state, toolCalls: 0 };
}

const row = (overrides: Partial<AgentRow> = {}): AgentRow => ({
  sessionId: INTERACTIVE_ID,
  name: 'pitwall-test-end-a',
  kind: 'interactive',
  cwd: CWD,
  pid: PID,
  status: 'busy',
  startedAt: STARTED,
  ...overrides,
});

function fakeAgents(result: AgentsResult = { ok: true, rows: [row(), row({ sessionId: NAMED_ID, pid: PID + 10 })] }) {
  const agents = { result, list: vi.fn(async () => agents.result) };
  return agents;
}

/**
 * ps, made up: `processes` by pid, which a test or the signaller can change; `answers` to give the
 * next lookups instead, in order; and the parents table.
 */
function fakeProcesses() {
  const fake = {
    processes: new Map<number, ProcessInfo>([[PID, CLAUDE_PROCESS]]),
    answers: [] as ProcessLookup[],
    parents: { ok: true, parents: new Map([[1, 0], [500, 1], [PID, 500], [SELF, 600], [600, 500]]) } as ProcessParents,
    lookups: [] as number[],
    /** The time limit each lookup was given, in order: undefined for none. */
    limits: [] as Array<number | undefined>,
    gate: undefined as Promise<void> | undefined,
    /** Once set, every lookup from then on never answers, as a ps that hangs. */
    hang: false,
    async lookup(pid: number, timeoutMs?: number): Promise<ProcessLookup> {
      fake.lookups.push(pid);
      fake.limits.push(timeoutMs);
      if (fake.hang) return new Promise<ProcessLookup>(() => {});
      if (fake.gate) await fake.gate;
      const next = fake.answers.shift();
      if (next) return next;
      const info = fake.processes.get(pid);
      return info ? { ok: true, process: { ...info } } : { ok: true };
    },
    async parentsOf(): Promise<ProcessParents> {
      return fake.parents;
    },
  };
  const processes: Processes = { lookup: (pid, timeoutMs) => fake.lookup(pid, timeoutMs), parents: () => fake.parentsOf() };
  return Object.assign(fake, { api: processes });
}

/** A signaller that records each signal and, by default, ends the process, as SIGTERM does (spike 005). */
function fakeSignal(processes: ReturnType<typeof fakeProcesses>, behaviour: 'exit' | 'linger' | 'reused' | 'hang' | 'ESRCH' | 'EPERM' = 'exit') {
  const calls: Array<{ pid: number; signal: string }> = [];
  const signal: Signaller = (pid, sig) => {
    calls.push({ pid, signal: sig });
    if (behaviour === 'ESRCH' || behaviour === 'EPERM') throw Object.assign(new Error(behaviour), { code: behaviour });
    if (behaviour === 'exit') processes.processes.delete(pid);
    // It exits, and a newer process takes its pid at once.
    if (behaviour === 'reused') processes.processes.set(pid, { startedAtMs: CLAUDE_PROCESS.startedAtMs + 60_000, command: 'claude' });
    // It lingers, and every ps from now on hangs.
    if (behaviour === 'hang') processes.hang = true;
  };
  return Object.assign(signal, { calls });
}

// ---------------------------------------------------------------- clients

const running: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

interface Started {
  server: RunningServer;
  apiKey: string;
  indexer: FakeIndexer;
  agents: ReturnType<typeof fakeAgents>;
  processes: ReturnType<typeof fakeProcesses>;
  signal: ReturnType<typeof fakeSignal>;
}

interface StartOptions {
  indexer?: FakeIndexer;
  agents?: ReturnType<typeof fakeAgents>;
  processes?: ReturnType<typeof fakeProcesses>;
  behaviour?: Parameters<typeof fakeSignal>[1];
  end?: Omit<EndOptions, 'slots'>;
  internals?: ServerInternals;
  relay?: RelayManager;
}

async function start(options: StartOptions = {}): Promise<Started> {
  const indexer = options.indexer ?? fakeIndexer();
  const agents = options.agents ?? fakeAgents();
  const processes = options.processes ?? fakeProcesses();
  const signal = fakeSignal(processes, options.behaviour);
  const server = await startServerWithInternals(
    { indexer, token: TOKEN, webRoot, port: 0, ...(options.relay ? { relay: options.relay } : {}) },
    {
      end: { agents, processes: processes.api, signal, selfPid: SELF, pollMs: 10, ...options.end },
      ...options.internals,
    },
  );
  running.push(server);
  return { server, apiKey: await apiKeyOf(server.port), indexer, agents, processes, signal };
}

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  json: unknown;
}

function request(port: number, path: string, headers: Record<string, string>, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers, agent: false }, (res) => {
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
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const origin = (port: number) => `http://127.0.0.1:${port}`;

/** POSTs as the web UI does: the apiKey, this server's Origin, and `body` as JSON. */
function end(started: Started, sessionId = INTERACTIVE_ID, body: unknown = {}, headers: Record<string, string> = {}): Promise<HttpResult> {
  return request(
    started.server.port,
    endSessionPath(sessionId),
    { authorization: `Bearer ${started.apiKey}`, origin: origin(started.server.port), 'content-type': 'application/json', ...headers },
    typeof body === 'string' ? body : JSON.stringify(body),
  );
}

/** The apiKey, from W8's challenge-response handshake. */
async function apiKeyOf(port: number): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin: origin(port) });
  const messages: ServerMessage[] = [];
  const waiters: ((message: ServerMessage) => void)[] = [];
  ws.on('message', (data) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const next = () => {
    const queued = messages.shift();
    return queued ? Promise.resolve(queued) : new Promise<ServerMessage>((resolve) => waiters.push(resolve));
  };
  const challenge = await next();
  if (challenge.type !== 'challenge') throw new Error(`expected a challenge, got ${challenge.type}`);
  ws.send(JSON.stringify({ type: 'auth', proof: proofFor(TOKEN, challenge.nonce, pitwallOrigin(port)) }));
  const reply = await next();
  ws.close();
  if (reply.type !== 'authenticated') throw new Error(`expected authenticated, got ${reply.type}`);
  return reply.apiKey;
}

/** Nothing was signalled, and, with `listed: false`, nothing was even listed. */
function expectNothingSignalled(started: Started) {
  expect(started.signal.calls).toEqual([]);
}

// ---------------------------------------------------------------- tests

describe('end session: the request', () => {
  it('parses {} and { whileWorking: true } and nothing else', () => {
    expect(parseEndRequest({})).toEqual({ ok: true, whileWorking: false });
    expect(parseEndRequest({ whileWorking: true })).toEqual({ ok: true, whileWorking: true });
    for (const body of [null, [], 'x', { whileWorking: false }, { whileWorking: 'true' }, { pid: 1 }, { whileWorking: true, pid: 1 }]) {
      expect(parseEndRequest(body).ok, JSON.stringify(body)).toBe(false);
    }
  });

  it('says what is running in a working session', () => {
    expect(workingError({ turn: 'running' })).toMatch(/its turn is still running/);
    expect(workingError({ turn: 'unknown', subagents: 1 })).toMatch(/can't tell .* whether its turn has ended, and 1 sub-agent is running/);
    expect(workingError({ subagents: 3 })).toMatch(/3 sub-agents are running/);
  });
});

describe('end session: credentials', () => {
  it('refuses the raw token, a missing or foreign Origin, a wrong Host and no credential, signalling nothing', async () => {
    const started = await start();
    const { port } = started.server;
    const path = endSessionPath(INTERACTIVE_ID);
    const json = { 'content-type': 'application/json' };
    expect((await request(port, path, { ...json, authorization: `Bearer ${TOKEN}`, origin: origin(port) }, '{}')).status).toBe(403);
    expect((await request(port, path, { ...json, authorization: `Bearer ${started.apiKey}` }, '{}')).status).toBe(403);
    expect((await request(port, path, { ...json, authorization: `Bearer ${started.apiKey}`, origin: 'http://127.0.0.1:1' }, '{}')).status).toBe(403);
    expect((await request(port, path, { ...json, authorization: `Bearer ${started.apiKey}`, origin: origin(port), host: `localhost:${port}` }, '{}')).status).toBe(403);
    expect((await request(port, path, { ...json, origin: origin(port) }, '{}')).status).toBe(401);
    expectNothingSignalled(started);
    expect(started.agents.list).not.toHaveBeenCalled();
    expect(started.processes.lookups).toEqual([]);
  });

  it('refuses a body that isn’t {} or { whileWorking: true } with 400, so the request can never name a pid', async () => {
    const started = await start();
    expect((await end(started, INTERACTIVE_ID, '{}', { 'content-type': 'text/plain' })).status).toBe(400);
    expect((await end(started, INTERACTIVE_ID, 'not json')).status).toBe(400);
    expect((await end(started, INTERACTIVE_ID, { pid: 1 })).status).toBe(400);
    expect((await end(started, INTERACTIVE_ID, { whileWorking: false })).status).toBe(400);
    expect((await end(started, INTERACTIVE_ID, JSON.stringify({ whileWorking: true, pad: 'x'.repeat(2048) }))).status).toBe(400);
    expectNothingSignalled(started);
  });
});

describe('end session: success', () => {
  it('sends SIGTERM, once, to the listed pid, and says it ended', async () => {
    const started = await start();
    const res = await end(started);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, ended: true });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(started.signal.calls).toEqual([{ pid: PID, signal: 'SIGTERM' }]);
    expect(END_SIGNAL).toBe('SIGTERM');
    // A fresh listing, then the process checked before it, again just before the signal, then until it exits.
    expect(started.agents.list).toHaveBeenCalledTimes(1);
    expect(started.processes.lookups.slice(0, 3)).toEqual([PID, PID, PID]);
    // The snapshot then lists it as ended (W67).
    expect(started.indexer.pollSoon).toHaveBeenCalled();
  });

  it('says when it hadn’t exited in time, and never sends another signal (spike 005: no SIGKILL)', async () => {
    const started = await start({ behaviour: 'linger', end: { waitMs: 200, pollMs: 50 } });
    const res = await end(started);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, ended: false });
    expect(started.signal.calls).toEqual([{ pid: PID, signal: 'SIGTERM' }]);
  });

  it('waits by the clock, not by lookups: a ps that hangs after the signal still answers within the wait, each lookup capped to the time left', async () => {
    const processes = fakeProcesses();
    const started = await start({ processes, behaviour: 'hang', end: { waitMs: 300, pollMs: 50 } });
    const begun = Date.now();
    const res = await end(started);
    const took = Date.now() - begun;
    expect(res.json).toEqual({ ok: true, ended: false });
    // The wait is 300 ms; with one ps that never answers, a count of lookups would have waited forever.
    expect(took).toBeLessThan(2000);
    // The lookups before the signal have ps's own limit; the one after it, only the time left.
    const afterSignal = processes.limits.slice(2);
    expect(afterSignal.length).toBeGreaterThan(0);
    for (const limit of afterSignal) {
      expect(limit).toBeGreaterThan(0);
      expect(limit).toBeLessThanOrEqual(300);
    }
    // The slot and the session's lock are free again.
    processes.hang = false;
    processes.processes.set(PID, CLAUDE_PROCESS);
    expect((await end(started)).status).toBe(200);
  });

  it('counts the pid taken by another process meanwhile as ended, without signalling that one', async () => {
    const started = await start({ behaviour: 'reused', end: { waitMs: 200, pollMs: 50 } });
    expect((await end(started)).json).toEqual({ ok: true, ended: true });
    expect(started.signal.calls).toHaveLength(1);
  });

  it('ends a working session once you confirmed the stronger warning, with whileWorking', async () => {
    const indexer = fakeIndexer();
    indexer.turn = 'running';
    indexer.running = 2;
    const started = await start({ indexer });
    const res = await end(started, INTERACTIVE_ID, { whileWorking: true });
    expect(res.status).toBe(200);
    expect(started.signal.calls).toEqual([{ pid: PID, signal: 'SIGTERM' }]);
  });
});

describe('end session: the snapshot’s guards', () => {
  it('answers 400, 404 and 503 from resolveSession(), and signals nothing', async () => {
    const started = await start();
    expect((await end(started, '-rf')).status).toBe(400);
    expect((await end(started, '99999999-9999-4999-8999-999999999999')).status).toBe(404);
    const early = await start({ indexer: fakeIndexer(null) });
    expect((await end(early)).status).toBe(503);
    expectNothingSignalled(started);
    expectNothingSignalled(early);
  });

  it('refuses a background session, an ended one, one with no process, and an id that isn’t a UUID, with 409', async () => {
    const started = await start();
    for (const id of [BG_ID, ENDED_ID, NO_PID_ID, ENDED_PID_ID, DEAD_PID_ID, NAMED_ID]) {
      const res = await end(started, id);
      expect(res.status, id).toBe(409);
      expect(res.json).toMatchObject({ ok: false });
    }
    expect((await end(started, BG_ID)).json).toMatchObject({ error: expect.stringMatching(/Stop a background session instead/) });
    expectNothingSignalled(started);
    expect(started.agents.list).not.toHaveBeenCalled();
    expect(started.processes.lookups).toEqual([]);
  });
});

describe('end session: the fresh listing’s guards', () => {
  it('refuses with 502 when claude agents fails, signalling nothing', async () => {
    const started = await start({ agents: fakeAgents({ ok: false, error: 'claude agents --json --all timed out after 10s' }) });
    const res = await end(started);
    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ ok: false, error: expect.stringMatching(/couldn't check that it's still running/) });
    expectNothingSignalled(started);
  });

  it('refuses one no longer listed, or listed with no process, and polls soon', async () => {
    for (const rows of [[], [row({ pid: undefined })]]) {
      const started = await start({ agents: fakeAgents({ ok: true, rows }) });
      const res = await end(started);
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ error: expect.stringMatching(/isn't running any more/) });
      expect(started.indexer.pollSoon).toHaveBeenCalled();
      expectNothingSignalled(started);
    }
  });

  it('refuses one that is a background session now', async () => {
    const started = await start({ agents: fakeAgents({ ok: true, rows: [row({ kind: 'background', shortId: '22222222' })] }) });
    expect((await end(started)).status).toBe(409);
    expectNothingSignalled(started);
  });

  it('refuses a pid other than the snapshot’s, and a pid another row has too', async () => {
    const cases = [
      { rows: [row({ pid: PID + 1 })], error: /different process/ },
      { rows: [row(), row({ sessionId: BG_ID, kind: 'background' as const, shortId: 'b3899da0' })], error: /can't tell which is the session's/ },
    ];
    for (const { rows, error } of cases) {
      const processes = fakeProcesses();
      processes.processes.set(PID + 1, CLAUDE_PROCESS);
      const started = await start({ agents: fakeAgents({ ok: true, rows }), processes });
      const res = await end(started);
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ error: expect.stringMatching(error) });
      expectNothingSignalled(started);
    }
  });

  it('refuses a pid any row names besides the session’s own, rows parseAgentRows() dropped included, and another pid for the session', async () => {
    const cases: Array<{ what: string; pids: Array<{ pid: number; sessionId?: string }> }> = [
      // A row with an unknown kind, a relative cwd or no startedAt: dropped from `rows`, but its pid is printed.
      { what: 'a dropped row of another session', pids: [{ pid: PID, sessionId: INTERACTIVE_ID }, { pid: PID, sessionId: '99999999-9999-4999-8999-999999999999' }] },
      { what: 'a row with no session id', pids: [{ pid: PID, sessionId: INTERACTIVE_ID }, { pid: PID }] },
      // parseAgentRows() keeps one row per session id: a second process for it is printed, not parsed.
      { what: 'another pid for the session', pids: [{ pid: PID, sessionId: INTERACTIVE_ID }, { pid: PID + 7, sessionId: INTERACTIVE_ID }] },
    ];
    for (const { what, pids } of cases) {
      const started = await start({ agents: fakeAgents({ ok: true, rows: [row()], pids }) });
      const res = await end(started);
      expect(res.status, what).toBe(409);
      expect(res.json).toMatchObject({ error: expect.stringMatching(/can't tell which is the session's/) });
      expectNothingSignalled(started);
    }
    // The session's own row printed twice, with the same pid, names no other process.
    const twice = await start({ agents: fakeAgents({ ok: true, rows: [row()], pids: [{ pid: PID, sessionId: INTERACTIVE_ID }, { pid: PID, sessionId: INTERACTIVE_ID }] }) });
    expect((await end(twice)).status).toBe(200);
  });

  it('never ends a session named as a pitwall relay is, another pitwall’s included, in the snapshot or the listing', async () => {
    expect(isRelayName('pitwall-relay')).toBe(true);
    expect(isRelayName(' Pitwall-Relay ')).toBe(true);
    expect(isRelayName('pitwall-relay-2')).toBe(false);
    const RELAY_ID = '77777777-7777-4777-8777-777777777777';
    const listed = await start({
      indexer: fakeIndexer(snapshot(session(RELAY_ID, { name: 'pitwall-relay', pid: PID + 20 }))),
      agents: fakeAgents({ ok: true, rows: [row({ sessionId: RELAY_ID, name: 'pitwall-relay', pid: PID + 20 })] }),
    });
    const fromSnapshot = await end(listed, RELAY_ID);
    expect(fromSnapshot.status).toBe(409);
    expect(fromSnapshot.json).toMatchObject({ error: expect.stringMatching(/pitwall relay/) });
    expectNothingSignalled(listed);
    // Named so only by the fresh listing, as when it was renamed since the poll.
    const renamed = await start({ agents: fakeAgents({ ok: true, rows: [row({ name: 'Pitwall-Relay' })] }) });
    const fromListing = await end(renamed);
    expect(fromListing.status).toBe(409);
    expect(fromListing.json).toMatchObject({ error: expect.stringMatching(/pitwall relay/) });
    expectNothingSignalled(renamed);
  });

  it('never ends pitwall’s own relay, by the server’s relay', async () => {
    const relay: RelayManager = {
      send: async () => ({ status: 'failed' }),
      exchange: () => undefined,
      alert: () => undefined,
      off: () => undefined,
      isRelay: (each) => each.pid === PID,
      sentByRelay: () => false,
      close: async () => {},
    };
    const started = await start({ relay });
    const res = await end(started);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: expect.stringMatching(/pitwall's own relay/) });
    expectNothingSignalled(started);
  });
});

describe('end session: the process’s guards', () => {
  it('refuses with 502 when ps fails, before the listing, at the parents or just before the signal', async () => {
    const before = fakeProcesses();
    before.answers.push({ ok: false, error: 'ps /bin/ps was not found' });
    const first = await start({ processes: before });
    expect((await end(first)).status).toBe(502);
    expect(first.agents.list).not.toHaveBeenCalled();

    const tree = fakeProcesses();
    tree.parents = { ok: false, error: 'ps timed out after 5s' };
    const second = await start({ processes: tree });
    expect((await end(second)).status).toBe(502);

    const last = fakeProcesses();
    last.answers.push({ ok: true, process: CLAUDE_PROCESS }, { ok: false, error: 'ps timed out after 5s' });
    const third = await start({ processes: last });
    expect((await end(third)).status).toBe(502);
    for (const started of [first, second, third]) expectNothingSignalled(started);
  });

  it('refuses a pid with no process, or one that isn’t claude, before the listing', async () => {
    const gone = fakeProcesses();
    gone.processes.clear();
    const first = await start({ processes: gone });
    expect((await end(first)).status).toBe(409);
    expect(first.agents.list).not.toHaveBeenCalled();

    for (const command of ['node', '/bin/zsh', 'claude-helper']) {
      const other = fakeProcesses();
      other.processes.set(PID, { ...CLAUDE_PROCESS, command });
      const started = await start({ processes: other });
      const res = await end(started);
      expect(res.status, command).toBe(409);
      expect(res.json).toMatchObject({ error: expect.stringMatching(/isn't Claude Code's/) });
      expectNothingSignalled(started);
    }
    expectNothingSignalled(first);
  });

  it('takes claude by a path, as a terminal may start it', async () => {
    const processes = fakeProcesses();
    processes.processes.set(PID, { ...CLAUDE_PROCESS, command: '/Users/pitwall-test/.local/bin/claude' });
    const started = await start({ processes });
    expect((await end(started)).status).toBe(200);
  });

  it('refuses a process that started after the session did, a reused pid, with no slack: 1 s later refuses, the same second ends', async () => {
    // The session's startedAt on a whole second, so ps's whole seconds can meet it exactly.
    const onTheSecond = '2026-10-28T10:00:01.000Z';
    const agents = () => fakeAgents({ ok: true, rows: [row({ startedAt: onTheSecond })] });
    const later = fakeProcesses();
    later.processes.set(PID, { ...CLAUDE_PROCESS, startedAtMs: Date.parse(onTheSecond) + 1000 });
    const refused = await start({ processes: later, agents: agents() });
    const res = await end(refused);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: expect.stringMatching(/started after the time claude agents gives for the session's start/) });
    expectNothingSignalled(refused);

    // ps's lstart is rounded down and startedAt is written after the start, so the same second is the session's own.
    const same = fakeProcesses();
    same.processes.set(PID, { ...CLAUDE_PROCESS, startedAtMs: Date.parse(onTheSecond) });
    const ended = await start({ processes: same, agents: agents() });
    expect((await end(ended)).status).toBe(200);
  });

  it('refuses when the process changed between the first check and the last, by start time or command', async () => {
    // `/x/claude` is still claude by name, but not the command the first check saw.
    for (const changed of [{ ...CLAUDE_PROCESS, startedAtMs: CLAUDE_PROCESS.startedAtMs + 1000 }, { ...CLAUDE_PROCESS, command: 'node' }, { ...CLAUDE_PROCESS, command: '/x/claude' }, undefined]) {
      const processes = fakeProcesses();
      processes.answers.push({ ok: true, process: CLAUDE_PROCESS }, changed === undefined ? { ok: true } : { ok: true, process: changed });
      const started = await start({ processes });
      const res = await end(started);
      expect(res.status).toBe(409);
      expect(res.json).toMatchObject({ error: expect.stringMatching(/changed while pitwall checked it/) });
      expectNothingSignalled(started);
    }
  });

  it('never ends a session pitwall runs under, pitwall itself, or a process pitwall started', async () => {
    // pitwall (7000) under a shell (600) under the session's process.
    const under = fakeProcesses();
    under.parents = { ok: true, parents: new Map([[1, 0], [PID, 1], [600, PID], [SELF, 600]]) };
    const first = await start({ processes: under });
    const res = await end(first);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: expect.stringMatching(/pitwall itself is running under this session/) });

    // The session's process is pitwall's child, as its relay is.
    const child = fakeProcesses();
    child.parents = { ok: true, parents: new Map([[1, 0], [SELF, 1], [PID, SELF]]) };
    const second = await start({ processes: child });
    expect((await end(second)).json).toMatchObject({ error: expect.stringMatching(/a process pitwall started/) });

    // pitwall's own pid.
    const self = await start({ processes: fakeProcesses(), end: { selfPid: PID } });
    expect((await end(self)).status).toBe(409);
    for (const started of [first, second, self]) expectNothingSignalled(started);
  });

  it('answers 409 when the process exited just before the signal, and 502 when it may not be signalled', async () => {
    const gone = await start({ behaviour: 'ESRCH' });
    const res = await end(gone);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: expect.stringMatching(/exited before pitwall signalled it/) });
    const denied = await start({ behaviour: 'EPERM' });
    expect((await end(denied)).status).toBe(502);
  });
});

describe('end session: idle only, unless you confirm the stronger warning', () => {
  it('refuses a session whose turn is running, or may be, with what is running and nothing signalled', async () => {
    for (const [turn, working] of [
      ['running', { turn: 'running' }],
      ['unknown', { turn: 'unknown' }],
    ] as const) {
      const indexer = fakeIndexer();
      indexer.turn = turn;
      const started = await start({ indexer });
      const res = await end(started);
      expect(res.status, turn).toBe(409);
      expect(res.json).toEqual({ ok: false, error: workingError(working), working });
      expect(indexer.turnState).toHaveBeenCalledWith(INTERACTIVE_ID);
      expectNothingSignalled(started);
    }
  });

  it('counts a prompt on screen as a running turn, whatever the transcript says', async () => {
    const started = await start({ agents: fakeAgents({ ok: true, rows: [row({ status: 'waiting', waitingFor: 'permission prompt' })] }) });
    const res = await end(started);
    expect(res.json).toMatchObject({ working: { turn: 'running' } });
    expectNothingSignalled(started);
  });

  it('refuses a session whose sub-agents are running, saying how many', async () => {
    const indexer = fakeIndexer();
    indexer.running = 2;
    const started = await start({ indexer });
    const res = await end(started);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ working: { subagents: 2 } });
    expectNothingSignalled(started);
  });

  it("counts sub-agents it couldn't read as working, as a transcript that can't say", async () => {
    const indexer = fakeIndexer();
    indexer.running = undefined;
    const started = await start({ indexer });
    const res = await end(started);
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ ok: false, error: workingError({ subagents: 'unknown' }), working: { subagents: 'unknown' } });
    expect(indexer.runningSubagents).toHaveBeenCalledWith(INTERACTIVE_ID);
    expectNothingSignalled(started);
    // Confirmed, it ends.
    expect((await end(started, INTERACTIVE_ID, { whileWorking: true })).status).toBe(200);
  });

  it('still runs every other guard with whileWorking', async () => {
    const processes = fakeProcesses();
    processes.processes.set(PID, { ...CLAUDE_PROCESS, command: 'node' });
    const started = await start({ processes });
    expect((await end(started, INTERACTIVE_ID, { whileWorking: true })).status).toBe(409);
    expectNothingSignalled(started);
  });
});

describe('end session: limits', () => {
  it('allows 5 ends a minute, then 429 with Retry-After; a refused one doesn’t count', async () => {
    let now = Date.UTC(2026, 9, 28, 12, 0, 0);
    const processes = fakeProcesses();
    const started = await start({ processes, behaviour: 'linger', end: { now: () => now, waitMs: 0 } });
    // A refusal first: it never reaches the limit.
    started.agents.result = { ok: true, rows: [] };
    expect((await end(started)).status).toBe(409);
    started.agents.result = { ok: true, rows: [row()] };
    for (let i = 0; i < DEFAULT_END_RATE.max; i += 1) expect((await end(started)).status, `end ${i + 1}`).toBe(200);
    now += 18_000;
    const res = await end(started);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('42');
    expect(res.json).toMatchObject({ ok: false, error: 'pitwall ends at most 5 sessions every 60 seconds. Try again in 42s.' });
    expect(started.signal.calls).toHaveLength(DEFAULT_END_RATE.max);
    now += 42_000;
    expect((await end(started)).status).toBe(200);
  });

  it('shares stop, remove, resume and open’s 4 commands at once: 429 with Retry-After: 1', async () => {
    const slots = new CommandSlots(1);
    const release = slots.acquire();
    const started = await start({ internals: { actions: { slots } } });
    const res = await end(started);
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('1');
    expectNothingSignalled(started);
    release?.();
    expect((await end(started)).status).toBe(200);
  });

  it('refuses a second end of the same session while the first is out', async () => {
    const processes = fakeProcesses();
    let open: () => void = () => {};
    processes.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const started = await start({ processes });
    const first = end(started);
    await vi.waitFor(() => expect(processes.lookups.length).toBeGreaterThan(0));
    const second = await end(started);
    expect(second.status).toBe(409);
    expect(second.json).toMatchObject({ error: 'pitwall is already ending this session.' });
    processes.gate = undefined;
    open();
    expect((await first).status).toBe(200);
    expect(started.signal.calls).toHaveLength(1);
  });
});
