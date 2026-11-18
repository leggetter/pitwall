// Clear and continue (W168) against a fake PTY and a fake `claude agents --json`: the typing sequence,
// its refusals and its fall-backs, then the routes on a bare Hono app. Made-up sessions only; nothing runs claude.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AgentRow, AgentsResult } from '../index/agents.js';
import { clearAndContinuePath, continuedPath, type ClearAndContinueResult, type ContinuedResult, type IndexSnapshot, type SessionSummary, type SpinOff } from '../shared/protocol.js';
import { continuesLine } from '../shared/handoff.js';
import { CLEAR_TIMINGS, createClearAndContinue, registerClearAndContinue, typedPromptProblem, type ClearAndContinue } from './clearAndContinue.js';
import { LineageStore } from './lineage.js';
import type { PtyProcess, PtySpawner } from './pty.js';

const OLD = '44444444-4444-4444-8444-444444444444';
const NEW = '55555555-5555-4555-8555-555555555555';
const JOB = 'abcd1234';
const KEY = '0123456789abcdef';
const FAST = { quietMs: 5, readyMaxMs: 200, enterGapMs: 1, clearMaxMs: 150, pollMs: 2, settleMs: 1, afterPromptMs: 1 };
const PROMPT = `${continuesLine(OLD)}\nTidy the README.\nThen run the tests.`;

class FakePty implements PtyProcess {
  writes: string[] = [];
  killed: Array<string | undefined> = [];
  private data: Array<(d: string) => void> = [];
  private exit: Array<(e: { exitCode: number }) => void> = [];
  onData(l: (d: string) => void) { this.data.push(l); }
  onExit(l: (e: { exitCode: number }) => void) { this.exit.push(l); }
  write(d: string) { this.writes.push(d); this.onWrite?.(d); }
  resize() {}
  kill(signal?: string) { this.killed.push(signal); }
  pause() {}
  resume() {}
  onWrite?: (d: string) => void;
  emit(d: string) { for (const l of this.data) l(d); }
  end() { for (const l of this.exit) l({ exitCode: 0 }); }
}

const row = (overrides: Partial<AgentRow> = {}): AgentRow => ({ sessionId: OLD, shortId: JOB, name: 'pitwall-test-job', kind: 'background', cwd: '/tmp', pid: 4242, state: 'done', startedAt: '2026-11-18T00:00:00.000Z', ...overrides });

interface Setup {
  runner: ClearAndContinue;
  ptys: FakePty[];
  spawned: Array<{ file: string; args: string[] }>;
  lineage: LineageStore;
  /** What the listing says now. */
  listing: { value: () => AgentsResult };
}

function setup(options: { listing?: () => AgentsResult; bracketed?: boolean; script?: (pty: FakePty) => void; throwOnSpawn?: boolean } = {}): Setup {
  const ptys: FakePty[] = [];
  const spawned: Array<{ file: string; args: string[] }> = [];
  const listing = { value: options.listing ?? (() => ({ ok: true, rows: [row()] }) as AgentsResult) };
  const spawnPty: PtySpawner = (file, args) => {
    if (options.throwOnSpawn) throw new Error('no pty');
    const pty = new FakePty();
    ptys.push(pty);
    spawned.push({ file, args });
    setTimeout(() => pty.emit(options.bracketed === false ? 'screen' : 'screen\u001b[?2004h'), 1);
    options.script?.(pty);
    return pty;
  };
  const lineage = new LineageStore();
  const runner = createClearAndContinue({ spawnPty, token: 't', env: {}, agents: { list: async () => listing.value() }, lineage, timings: FAST });
  return { runner, ptys, spawned, lineage, listing };
}

/** After `/clear` and Enter are typed, the job lists a new session id. */
function clears(s: { listing: { value: () => AgentsResult } }, pty: FakePty): void {
  pty.onWrite = (d) => {
    if (d === '\r' && pty.writes.length === 2) s.listing.value = () => ({ ok: true, rows: [row({ sessionId: NEW })] });
  };
}

describe('typedPromptProblem()', () => {
  it('takes plain text and refuses a leading / or !, hidden characters, and blank or oversized text', () => {
    expect(typedPromptProblem(PROMPT)).toBeUndefined();
    expect(typedPromptProblem('/compact')).toMatch(/slash command/);
    expect(typedPromptProblem('  !rm -rf x')).toMatch(/shell line/);
    for (const hidden of ['a​b', 'a‮b', 'a\u001b[201~b', 'a\rb', 'a\u0000b']) expect(typedPromptProblem(hidden)).toMatch(/doesn’t show as itself/);
    expect(typedPromptProblem('  \n ')).toMatch(/empty/);
    expect(typedPromptProblem('x'.repeat(16_385))).toMatch(/over/);
  });
});

describe('the typing sequence', () => {
  it('types /clear, Enter, waits for the new id, then the bracketed prompt and Enter, and records the clear', async () => {
    const s = setup();
    const outcome = setupRun(s);
    const result = await outcome;
    expect(result).toEqual({ ok: true, sessionId: NEW });
    expect(s.spawned).toEqual([{ file: 'claude', args: ['attach', JOB] }]);
    expect(s.ptys[0]!.writes).toEqual(['/clear', '\r', `\u001b[200~${PROMPT}\u001b[201~`, '\r']);
    expect(s.ptys[0]!.killed.length).toBeGreaterThan(0);
    expect(s.lineage.lines().map((l) => ({ from: l.from, to: l.to, how: l.how, job: l.job }))).toEqual([{ from: OLD, to: NEW, how: 'clear', job: JOB }]);
  });

  function setupRun(s: Setup) {
    const run = s.runner.run({ sessionId: OLD, shortId: JOB, cwd: '/tmp' }, PROMPT);
    // The fake PTY exists once run() has read the listing; arm the clear then.
    const arm = setInterval(() => {
      if (s.ptys[0] !== undefined) {
        clears(s, s.ptys[0]);
        clearInterval(arm);
      }
    }, 0);
    return run.finally(() => clearInterval(arm));
  }

  it('times out waiting for a new session id: a clear error, no prompt typed, the PTY closed', async () => {
    const s = setup();
    const result = await s.runner.run({ sessionId: OLD, shortId: JOB, cwd: '/tmp' }, PROMPT);
    expect(result).toMatchObject({ ok: false, status: 504 });
    expect((result as { error: string }).error).toMatch(/prompt was not typed/);
    expect(s.ptys[0]!.writes).toEqual(['/clear', '\r']);
    expect(s.ptys[0]!.killed.length).toBeGreaterThan(0);
    expect(s.lineage.lines()).toEqual([]);
  });

  it('stops without the prompt when the job disappears from the list after /clear', async () => {
    const s = setup();
    const run = s.runner.run({ sessionId: OLD, shortId: JOB, cwd: '/tmp' }, PROMPT);
    const arm = setInterval(() => {
      const pty = s.ptys[0];
      if (pty === undefined) return;
      pty.onWrite = (d) => {
        if (d === '\r') s.listing.value = () => ({ ok: true, rows: [] });
      };
      clearInterval(arm);
    }, 0);
    const result = await run;
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect((result as { error: string }).error).toMatch(/disappeared/);
    expect(s.ptys[0]!.writes).toEqual(['/clear', '\r']);
  });

  it('does not take a row with no worker as the new session', async () => {
    const s = setup();
    const run = s.runner.run({ sessionId: OLD, shortId: JOB, cwd: '/tmp' }, PROMPT);
    const arm = setInterval(() => {
      const pty = s.ptys[0];
      if (pty === undefined) return;
      pty.onWrite = (d) => {
        if (d === '\r') s.listing.value = () => ({ ok: true, rows: [row({ sessionId: NEW, pid: undefined })] });
      };
      clearInterval(arm);
    }, 0);
    expect(await run).toMatchObject({ ok: false, status: 504 });
  });

  it('types nothing when the prompt is refused, before any PTY opens', async () => {
    const s = setup();
    const result = await s.runner.run({ sessionId: OLD, shortId: JOB, cwd: '/tmp' }, '/clear everything');
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(s.ptys).toEqual([]);
  });

  it('types nothing when the terminal never turns on bracketed paste', async () => {
    const s = setup({ bracketed: false });
    const result = await s.runner.run({ sessionId: OLD, shortId: JOB, cwd: '/tmp' }, PROMPT);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(s.ptys[0]!.writes).toEqual([]);
    expect(s.ptys[0]!.killed.length).toBeGreaterThan(0);
  });

  it('does not attach to a job that has no worker, is working or blocked, or has moved on', async () => {
    for (const [overrides, pattern] of [
      [{ pid: undefined }, /restart/],
      [{ state: 'working' }, /still working/],
      [{ state: 'blocked' }, /waiting for you/],
      [{ sessionId: NEW }, /moved on/],
    ] as const) {
      const s = setup({ listing: () => ({ ok: true, rows: [row(overrides)] }) });
      const result = await s.runner.run({ sessionId: OLD, shortId: JOB, cwd: '/tmp' }, PROMPT);
      expect(result).toMatchObject({ ok: false, status: 409 });
      expect((result as { error: string }).error).toMatch(pattern);
      expect(s.ptys).toEqual([]);
    }
  });

  it('says so when the job is not listed, or claude agents fails, or the PTY will not start', async () => {
    const gone = setup({ listing: () => ({ ok: true, rows: [] }) });
    expect(await gone.runner.run({ sessionId: OLD, shortId: JOB, cwd: '/tmp' }, PROMPT)).toMatchObject({ ok: false, status: 409 });
    const broken = setup({ listing: () => ({ ok: false, error: 'x' }) as AgentsResult });
    expect(await broken.runner.run({ sessionId: OLD, shortId: JOB, cwd: '/tmp' }, PROMPT)).toMatchObject({ ok: false, status: 502 });
    const noPty = setup({ throwOnSpawn: true });
    expect(await noPty.runner.run({ sessionId: OLD, shortId: JOB, cwd: '/tmp' }, PROMPT)).toMatchObject({ ok: false, status: 502 });
  });

  it('stops when attach ends on its own before it can type', async () => {
    const s = setup({ script: (pty) => setTimeout(() => pty.end(), 0) });
    const result = await s.runner.run({ sessionId: OLD, shortId: JOB, cwd: '/tmp' }, PROMPT);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(s.ptys[0]!.writes).toEqual([]);
  });

  it('runs one at a time', async () => {
    const s = setup();
    const first = s.runner.run({ sessionId: OLD, shortId: JOB, cwd: '/tmp' }, PROMPT);
    expect(await s.runner.run({ sessionId: OLD, shortId: JOB, cwd: '/tmp' }, PROMPT)).toMatchObject({ ok: false, status: 429 });
    await first;
  });

  it('keeps the defaults spike 014 measured, with room', () => {
    expect(CLEAR_TIMINGS).toMatchObject({ quietMs: 1000, enterGapMs: 300, clearMaxMs: 30_000 });
  });
});

describe('the routes', () => {
  const session = (overrides: Partial<SessionSummary> = {}, spinOff: SpinOff | null = { kind: 'proposal', key: KEY, folder: '/tmp', prompt: PROMPT }): SessionSummary => ({
    sessionId: OLD,
    name: 'pitwall-test-job',
    kind: 'background',
    shortId: JOB,
    cwd: '/tmp',
    alive: true,
    startedAt: '2026-11-18T00:00:00.000Z',
    stale: false,
    finished: false,
    transcript: 'ok',
    ...(spinOff === null ? {} : { spinOff }),
    ...overrides,
  });

  function routes(summary: SessionSummary, options: { spawned?: boolean; calls?: Array<{ job: unknown; prompt: string }>; result?: Awaited<ReturnType<ClearAndContinue['run']>> } = {}) {
    const snapshot: IndexSnapshot = { generatedAt: '2026-11-18T10:00:00.000Z', roots: ['/tmp'], groups: [{ key: '/tmp', label: 'tmp', kind: 'git', root: '/tmp', sessions: [summary] }], source: { ok: true } };
    const calls = options.calls ?? [];
    const lineage = new LineageStore();
    const app = new Hono();
    registerClearAndContinue(app, {
      snapshots: { latest: () => snapshot },
      runner: { run: async (job, prompt) => (calls.push({ job, prompt }), options.result ?? { ok: true, sessionId: NEW }) },
      spawned: { has: () => options.spawned ?? true },
      lineage,
    });
    const post = async (path: string, body: unknown, type = 'application/json') => {
      const response = await app.request(path, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
      return { status: response.status, json: (await response.json()) as ClearAndContinueResult & ContinuedResult, cache: response.headers.get('cache-control') };
    };
    return { post, calls, lineage };
  }

  it('runs the hand-off of a running background job with the snapshot’s own prompt', async () => {
    const r = routes(session());
    const answer = await r.post(clearAndContinuePath(OLD), { key: KEY });
    expect(answer).toMatchObject({ status: 200, json: { ok: true, sessionId: NEW }, cache: 'no-store' });
    expect(r.calls).toEqual([{ job: { sessionId: OLD, shortId: JOB, cwd: '/tmp' }, prompt: PROMPT }]);
  });

  it('refuses without running anything', async () => {
    const cases: Array<[string, ReturnType<typeof routes>, unknown, number, string?]> = [
      ['no proposal', routes(session({}, null)), { key: KEY }, 409],
      ['another key', routes(session()), { key: 'fedcba9876543210' }, 409],
      ['unreadable', routes(session({}, { kind: 'unreadable', key: KEY, problem: 'No.' })), { key: KEY }, 409],
      ['interactive', routes(session({ kind: 'interactive', shortId: undefined })), { key: KEY }, 409],
      ['ended', routes(session({ ended: true })), { key: KEY }, 409],
      ['not its own hand-off', routes(session({}, { kind: 'proposal', key: KEY, folder: '/tmp', prompt: `${continuesLine(NEW)}\nDo it.` })), { key: KEY }, 409],
      ['a plain spin-off', routes(session({}, { kind: 'proposal', key: KEY, folder: '/tmp', prompt: 'Fix the test.' })), { key: KEY }, 409],
      ['bad body', routes(session()), { key: KEY, extra: 1 }, 400],
      ['bad key', routes(session()), { key: 'nope' }, 400],
    ];
    for (const [label, r, body, status] of cases) {
      const answer = await r.post(clearAndContinuePath(OLD), body);
      expect([label, answer.status]).toEqual([label, status]);
      expect(r.calls).toEqual([]);
    }
    const r = routes(session());
    expect((await r.post(clearAndContinuePath(OLD), { key: KEY }, 'text/plain')).status).toBe(415);
    expect((await r.post(clearAndContinuePath(NEW), { key: KEY })).status).toBe(404);
    expect((await r.post(clearAndContinuePath('../x'), { key: KEY })).status).toBe(400);
    expect((await r.post(clearAndContinuePath(OLD), 'not json')).status).toBe(400);
    expect((await r.post(clearAndContinuePath(OLD), { key: KEY, pad: 'x'.repeat(400) })).status).toBe(413);
    expect(r.calls).toEqual([]);
  });

  it('passes the runner’s failure on with its status', async () => {
    const r = routes(session(), { result: { ok: false, status: 504, error: 'Too slow.' } });
    expect(await r.post(clearAndContinuePath(OLD), { key: KEY })).toMatchObject({ status: 504, json: { ok: false, error: 'Too slow.' } });
  });

  it('notes a started session as the continuation, only for a short id pitwall started', async () => {
    const r = routes(session());
    expect(await r.post(continuedPath(OLD), { shortId: '0f0f0f0f' })).toMatchObject({ status: 200, json: { ok: true } });
    const none = routes(session(), { spawned: false });
    expect((await none.post(continuedPath(OLD), { shortId: '0f0f0f0f' })).status).toBe(409);
    expect((await r.post(continuedPath(OLD), { shortId: '../etc' })).status).toBe(400);
    expect((await r.post(continuedPath(OLD), { shortId: '0f0f0f0f' }, 'text/plain')).status).toBe(415);
  });
});

describe('LineageStore.expectContinue()', () => {
  it('records a continue line once the listing gives the started job its session id', () => {
    const store = new LineageStore();
    expect(store.expectContinue('0f0f0f0f', OLD)).toBe(true);
    store.observe({ ok: true, rows: [row({ shortId: '0f0f0f0f', sessionId: NEW })] });
    expect(store.lines().map((l) => ({ from: l.from, to: l.to, how: l.how, job: l.job }))).toEqual([{ from: OLD, to: NEW, how: 'continue', job: '0f0f0f0f' }]);
    store.observe({ ok: true, rows: [row({ shortId: '0f0f0f0f', sessionId: NEW })] });
    expect(store.lines()).toHaveLength(1);
  });

  it('gives up after the wait, and refuses bad ids', () => {
    let at = 0;
    const store = new LineageStore({ now: () => new Date(Date.UTC(2026, 10, 18) + at) });
    expect(store.expectContinue('nope', OLD)).toBe(false);
    expect(store.expectContinue('0f0f0f0f', 'not-a-uuid')).toBe(false);
    expect(store.expectContinue('0f0f0f0f', OLD)).toBe(true);
    at = 11 * 60 * 1000;
    store.observe({ ok: true, rows: [row({ shortId: '0f0f0f0f', sessionId: NEW })] });
    expect(store.lines()).toEqual([]);
  });
});
