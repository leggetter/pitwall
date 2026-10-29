// The recap engine (M5, W110): which sessions get a recap and when, the budget and its midnight
// reset, updates against first recaps, failures, the hiding of its calls, and what the snapshot
// shows, Needs you's 'recap' reason included. A fake index, a fake `claude` that answers as
// `claude -p --output-format json` does, and the test's own clock: no test runs claude. Every session
// and recap here is made up.
import { describe, expect, it } from 'vitest';
import type { SessionFacts } from '../index/index.js';
import type { RecapSourceReader, RecapSources } from '../index/recapSources.js';
import { RECAP_DAILY_BUDGET, RECAP_DEBOUNCE_MS, type ConversationEntry, type ConversationPage, type IndexSnapshot, type SessionSummary } from '../shared/protocol.js';
import { memoryBudget } from './budget.js';
import type { RecapChildEvents, RecapSpawner } from './call.js';
import { createRecapEngine, OWN_NAME_MS, PAUSE_AFTER_FAILURES, RETRY_AFTER_FAILURE_MS, secondsToMidnight, type RecapEngineOptions, type RecapIndex } from './engine.js';
import { ANSWER_INVALID, CALL_FAILED, recapArgs, RECAP_NAME } from './prompt.js';

const MINUTE = 60_000;
const DIR = '/made-up/pitwall-home/recap';

interface FakeCall {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  input?: string;
  pid: number;
  events: RecapChildEvents;
  signals: NodeJS.Signals[];
}

const answer = (overrides: Record<string, unknown> = {}) => ({
  why: 'You asked it to fix the nightly export.',
  now: 'It opened draft PR #42 with a fix, and CI passes.',
  next: 'Say whether to mark #42 ready.',
  waitingOn: 'you',
  title: 'Fix the nightly export',
  ...overrides,
});
const envelope = (result: unknown, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: typeof result === 'string' ? result : JSON.stringify(result), total_cost_usd: 0.0011, duration_ms: 4000, ...overrides });

function session(id: string, overrides: Partial<SessionSummary> = {}, clock?: { now: number }): SessionSummary {
  const base = clock?.now ?? Date.parse('2026-10-29T12:00:00.000Z');
  return {
    sessionId: id,
    name: `pitwall-test-${id}`,
    kind: 'background',
    cwd: `/made-up/work/${id}`,
    pid: 4000,
    alive: true,
    status: 'idle',
    state: 'done',
    startedAt: new Date(base - 60 * MINUTE).toISOString(),
    stale: false,
    finished: false,
    transcript: 'ok',
    lastActivityAt: new Date(base - 6 * MINUTE).toISOString(),
    ...overrides,
  };
}

const snapshotOf = (sessions: SessionSummary[], ok = true): IndexSnapshot => ({
  generatedAt: new Date().toISOString(),
  roots: ['/made-up/work'],
  groups: [{ key: '/made-up/work/repo', label: 'repo', kind: 'git', root: '/made-up/work', sessions }],
  source: ok ? { ok: true } : { ok: false, error: 'claude agents --json timed out after 10s' },
});

const tick = async (times = 10) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
};

function harness(options: Partial<RecapEngineOptions> = {}) {
  const clock = { now: Date.parse('2026-10-29T12:00:00.000Z') };
  const calls: FakeCall[] = [];
  const pages = new Map<string, ConversationEntry[]>();
  const sources = new Map<string, RecapSources>();
  const facts = new Map<string, SessionFacts>();
  let latest: IndexSnapshot | undefined;
  const listeners = new Set<(snapshot: IndexSnapshot) => void>();
  const index: RecapIndex = {
    latest: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async conversation(sessionId): Promise<ConversationPage | undefined> {
      return { sessionId, entries: pages.get(sessionId) ?? [] };
    },
  };
  const reader: RecapSourceReader = {
    read: async (file) => sources.get(file) ?? {},
    retain: () => undefined,
  };
  const spawn: RecapSpawner = (file, args, spawnOptions, events) => {
    const call: FakeCall = { file, args, cwd: spawnOptions.cwd, env: spawnOptions.env, pid: 50_000 + calls.length, events, signals: [] };
    calls.push(call);
    return {
      pid: call.pid,
      send(input) {
        call.input = input;
      },
      kill(signal) {
        call.signals.push(signal);
        events.exit(null, signal);
      },
    };
  };
  const logs: string[] = [];
  const engine = createRecapEngine({
    dir: DIR,
    spawn,
    sources: reader,
    prepareDir: (dir) => dir,
    claudeVersion: async () => '2.1.312 (Claude Code)',
    now: () => clock.now,
    relay: { name: 'pitwall-relay', sent: (msgId) => msgId === 'sent-by-our-relay' },
    budgetStore: memoryBudget(),
    log: (message) => logs.push(message),
    randomId: () => '0123456789abcdef',
    env: { PATH: '/usr/bin:/bin', HOME: '/made-up/home' },
    ...options,
  });
  let changes = 0;
  engine.subscribe(() => changes++);

  /** A session the engine can recap: listed, with a transcript file, a page of turns and a first prompt. */
  function add(id: string, overrides: Partial<SessionSummary> = {}, fact: SessionFacts = { turnEnded: true }) {
    const s = session(id, overrides, clock);
    facts.set(id, { file: `/made-up/projects/${id}.jsonl`, ...fact });
    sources.set(`/made-up/projects/${id}.jsonl`, { firstPrompt: `Fix ${id}.` });
    if (!pages.has(id)) {
      pages.set(id, [
        { kind: 'user', text: `Please fix ${id}.`, at: new Date(clock.now - 20 * MINUTE).toISOString() },
        { kind: 'assistant', text: 'Fixed. Shall I open a PR?', at: s.lastActivityAt! },
      ]);
    }
    return s;
  }

  return {
    engine,
    clock,
    calls,
    pages,
    sources,
    facts,
    logs,
    changes: () => changes,
    add,
    /** Hands the engine the facts and the snapshot, as the index does after a poll. */
    async poll(sessions: SessionSummary[], ok = true) {
      engine.observe(new Map(facts));
      latest = snapshotOf(sessions, ok);
      for (const listener of [...listeners]) listener(latest);
      await tick();
    },
    start() {
      engine.start(index);
    },
    /** Answers a call as `claude -p --output-format json` would. */
    async reply(call: FakeCall | undefined, stdout: string, code: number | null = 0) {
      call!.events.stdout(stdout);
      call!.events.exit(code, null);
      await tick();
    },
  };
}

describe('when a session is recapped', () => {
  it("recaps a running session once its turn has ended and it's been idle RECAP_DEBOUNCE_MS, with spike 010's call", async () => {
    const h = harness();
    h.start();
    const a = h.add('a');
    await h.poll([a]);
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.file).toBe('claude');
    expect(call.args).toEqual(recapArgs());
    expect(call.cwd).toBe(DIR);
    expect(call.env.DISABLE_PROMPT_CACHING).toBe('1');
    expect(call.input).toContain('<first-prompt>\nFix a.\n</first-prompt>');
    expect(call.input).toContain('User: Please fix a.');
    expect(call.input).toContain('Claude: Fixed. Shall I open a PR?');
    expect(call.input).toContain('Write the recap. Answer with the JSON object only.');
    expect(h.engine.health()).toEqual({ calls: 1, budget: RECAP_DAILY_BUDGET, costUsd: 0 });

    await h.reply(call, envelope(answer()));
    expect(h.engine.health()).toEqual({ calls: 1, budget: RECAP_DAILY_BUDGET, costUsd: 0.0011 });
    expect(h.engine.recap(a)).toEqual({ ...answer(), at: new Date(h.clock.now).toISOString(), throughAt: a.lastActivityAt, source: 'pitwall' });
    expect(h.changes()).toBeGreaterThan(0);
    // Nothing new since: no second call.
    await h.poll([a]);
    expect(h.calls).toHaveLength(1);
  });

  it('waits for the debounce, the turn to end, and a running process with a transcript', async () => {
    const h = harness();
    h.start();
    const sessions = [
      h.add('recent', { lastActivityAt: new Date(h.clock.now - RECAP_DEBOUNCE_MS + 1000).toISOString() }),
      h.add('running-turn', {}, { turnEnded: false }),
      h.add('ended', { ended: true, finished: true, alive: false, kind: 'interactive' }),
      h.add('finished', { finished: true, alive: false }),
      h.add('no-process', { alive: false, state: 'blocked' }),
      h.add('no-transcript', { transcript: 'missing' }),
      h.add('no-activity', { lastActivityAt: undefined }),
      // No turn mark, as from an older Claude Code: Claude Code's status says it's busy.
      h.add('busy', { status: 'busy' }, {}),
      h.add('waiting', { status: 'waiting' }, {}),
      h.add('working', { state: 'working', status: 'idle' }, {}),
    ];
    await h.poll(sessions);
    expect(h.calls).toHaveLength(0);
    // No mark and idle by Claude Code's status: due.
    await h.poll([...sessions, h.add('idle-no-mark', {}, {})]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.input).toContain('Fix idle-no-mark.');
    // Once the debounce has passed, the recent one too.
    h.clock.now += 2000;
    await h.poll(sessions);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.input).toContain('Fix recent.');
  });

  it("doesn't schedule from a snapshot whose listing failed", async () => {
    const h = harness();
    h.start();
    await h.poll([h.add('a')], false);
    expect(h.calls).toHaveLength(0);
  });

  it('updates from the previous recap and the turns since, and moves on without a call for activity no turn shows', async () => {
    const h = harness();
    h.start();
    let a = h.add('a');
    await h.poll([a]);
    await h.reply(h.calls[0], envelope(answer()));
    const firstThrough = h.engine.recap(a)!.throughAt;

    // A new turn, then idle.
    const newer = new Date(h.clock.now + MINUTE).toISOString();
    h.pages.get('a')!.push({ kind: 'user', text: 'Yes, open it.', at: newer }, { kind: 'assistant', text: 'Opened #43.', at: newer });
    h.clock.now += 7 * MINUTE;
    a = { ...a, lastActivityAt: newer };
    expect(h.engine.recap(a)?.stale).toBe(true);
    await h.poll([a]);
    expect(h.calls).toHaveLength(2);
    const input = h.calls[1]!.input!;
    expect(input).toContain('<previous-recap>\n{"why":"You asked it to fix the nightly export."');
    expect(input).toContain('<turns-since-previous-recap>');
    expect(input).toContain('User: Yes, open it.');
    expect(input).not.toContain('Please fix a.');
    expect(input).toContain('Update the previous recap with what the newer turns show.');
    expect(input).not.toContain('<latest-turns>');
    await h.reply(h.calls[1], envelope(answer({ now: 'It opened #43.', waitingOn: 'someone else' })));
    expect(h.engine.recap(a)).toMatchObject({ now: 'It opened #43.', waitingOn: 'someone else', throughAt: newer });
    expect(Date.parse(newer)).toBeGreaterThan(Date.parse(firstThrough));

    // Activity with nothing the input shows, such as a tool's result: no call, and the recap holds through it.
    const toolResult = new Date(h.clock.now - 6 * MINUTE).toISOString();
    a = { ...a, lastActivityAt: toolResult };
    await h.poll([a]);
    expect(h.calls).toHaveLength(2);
    expect(h.engine.recap(a)).toMatchObject({ throughAt: toolResult });
    expect(h.engine.recap(a)).not.toHaveProperty('stale');
  });

  it("writes your messages through pitwall's relay as yours (finding 4)", async () => {
    const h = harness();
    h.start();
    const a = h.add('a');
    h.pages.set('a', [
      { kind: 'cross-session', text: 'Please rebase on main.', from: 'pitwall-relay', msgId: 'sent-by-our-relay', at: new Date(h.clock.now - 9 * MINUTE).toISOString() },
      { kind: 'assistant', text: 'Rebased.', at: a.lastActivityAt! },
    ]);
    await h.poll([a]);
    expect(h.calls[0]!.input).toContain('User: Please rebase on main.');
    expect(h.calls[0]!.input).not.toContain('Message from session pitwall-relay');
  });

  it('sends Claude Code’s own recap and the compaction summary in a first recap', async () => {
    const h = harness();
    h.start();
    const a = h.add('a');
    h.sources.set('/made-up/projects/a.jsonl', {
      firstPrompt: 'Fix a.',
      awaySummary: { text: 'Claude Code says: waiting for review.', at: a.lastActivityAt! },
      compaction: { text: '1. Primary Request and Intent:\nFix a.\n2. Two:\nleft out' },
    });
    await h.poll([a]);
    expect(h.calls[0]!.input).toContain(`<claude-code-recap at="${a.lastActivityAt}">\nClaude Code says: waiting for review.\n</claude-code-recap>`);
    expect(h.calls[0]!.input).toContain('<compaction-summary>\n1. Primary Request and Intent:\nFix a.\n</compaction-summary>');
  });
});

describe('the queue and the budget', () => {
  it('runs at most two at a time, on-demand requests first, then automatic ones newest activity first', async () => {
    const h = harness();
    h.start();
    const sessions = [1, 2, 3, 4].map((n) => h.add(`s${n}`, { lastActivityAt: new Date(h.clock.now - (5 + n) * MINUTE).toISOString() }));
    await h.poll(sessions);
    expect(h.calls.map((call) => /Fix (s\d)\./.exec(call.input!)?.[1])).toEqual(['s1', 's2']);
    expect(h.engine.refresh(sessions[3]!)).toEqual({ kind: 'queued' });
    expect(h.engine.refresh(sessions[3]!)).toEqual({ kind: 'queued' });
    expect(h.engine.refresh(sessions[0]!)).toEqual({ kind: 'running', retryAfterSeconds: 5 });
    await h.reply(h.calls[0], envelope(answer()));
    expect(/Fix (s\d)\./.exec(h.calls[2]!.input!)?.[1]).toBe('s4');
    await h.reply(h.calls[1], envelope(answer()));
    expect(/Fix (s\d)\./.exec(h.calls[3]!.input!)?.[1]).toBe('s3');
    expect(h.calls).toHaveLength(4);
  });

  it('stops at the day’s budget, answers a refresh with the seconds to midnight, and starts again after local midnight', async () => {
    const h = harness({ budget: 2 });
    h.clock.now = new Date(2026, 9, 29, 23, 0).getTime();
    h.start();
    const sessions = ['a', 'b', 'c'].map((id) => h.add(id));
    await h.poll(sessions);
    expect(h.calls).toHaveLength(2);
    await h.reply(h.calls[0], envelope(answer()));
    await h.reply(h.calls[1], envelope(answer()));
    await h.poll(sessions);
    expect(h.calls).toHaveLength(2);
    expect(h.engine.health()).toMatchObject({ calls: 2, budget: 2 });
    expect(h.engine.refresh(sessions[2]!)).toEqual({ kind: 'spent', retryAfterSeconds: 3600 });
    expect(secondsToMidnight(new Date(2026, 9, 29, 23, 59, 59, 500).getTime())).toBe(1);

    h.clock.now = new Date(2026, 9, 30, 0, 0, 1).getTime();
    expect(h.engine.health()).toMatchObject({ calls: 0, costUsd: 0 });
    await h.poll(sessions);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]!.input).toContain('Fix c.');
  });

  it("refreshes any listed session with a transcript, ended ones included, and says when it can't", async () => {
    const h = harness();
    h.start();
    const ended = h.add('ended', { ended: true, finished: true, alive: false, kind: 'interactive', lastActivityAt: new Date(h.clock.now - MINUTE).toISOString() });
    const missing = h.add('missing', { transcript: 'missing' });
    const unfound = session('unfound');
    await h.poll([ended, missing, unfound]);
    expect(h.calls).toHaveLength(0);
    expect(h.engine.refresh(ended)).toEqual({ kind: 'queued' });
    await tick();
    expect(h.calls).toHaveLength(1);
    expect(h.engine.refresh(missing)).toEqual({ kind: 'no-transcript' });
    expect(h.engine.refresh(unfound)).toEqual({ kind: 'no-transcript' });
    await h.reply(h.calls[0], envelope(answer({ waitingOn: 'nothing' })));
    expect(h.engine.recap(ended)).toMatchObject({ source: 'pitwall', waitingOn: 'nothing' });
    // Asked again with nothing new: a first recap afresh, not an update with no turns.
    expect(h.engine.refresh(ended)).toEqual({ kind: 'queued' });
    await tick();
    expect(h.calls[1]!.input).toContain('<latest-turns>');
    await h.engine.close();
    expect(h.engine.refresh(ended)).toEqual({ kind: 'closed' });
  });
});

describe("the day's count on file", () => {
  it('starts from what an earlier run today counted, and keeps only the day, the calls and the cost', async () => {
    const store = memoryBudget({ day: '2026-10-29', calls: 199, costUsd: 0.2 });
    const h = harness({ budgetStore: store, now: () => Date.parse('2026-10-29T12:00:00.000Z') });
    expect(h.engine.health()).toMatchObject({ calls: 199, costUsd: 0.2 });
    h.start();
    await h.poll([h.add('a'), h.add('b')]);
    expect(h.calls).toHaveLength(1);
    expect(store.current()).toEqual({ day: '2026-10-29', calls: 200, costUsd: 0.2 });
    await h.reply(h.calls[0], envelope(answer()));
    expect(store.current()).toEqual({ day: '2026-10-29', calls: 200, costUsd: 0.2011 });
    expect(JSON.stringify(store.current())).not.toMatch(/nightly|pitwall-test|made-up/);
    expect(h.engine.refresh(session('b', {}, h.clock))).toMatchObject({ kind: 'spent' });
  });

  it('ignores a count from another day, and shares one with another pitwall on the same home', async () => {
    const old = harness({ budgetStore: memoryBudget({ day: '2026-10-28', calls: 200, costUsd: 1 }) });
    expect(old.engine.health()).toMatchObject({ calls: 0, costUsd: 0 });

    const store = memoryBudget();
    const first = harness({ budgetStore: store, budget: 3 });
    const second = harness({ budgetStore: store, budget: 3 });
    first.start();
    second.start();
    await first.poll([first.add('a')]);
    await second.poll([second.add('b')]);
    expect(store.current()?.calls).toBe(2);
    await first.reply(first.calls[0], envelope(answer()));
    await second.reply(second.calls[0], envelope(answer()));
    // The third call of the day is one of them; the fourth is refused by the other, which read the file.
    await first.poll([first.add('c')]);
    expect(store.current()?.calls).toBe(3);
    const d = second.add('d');
    second.engine.observe(new Map(second.facts));
    expect(second.engine.refresh(d)).toMatchObject({ kind: 'spent' });
    await second.poll([second.add('e')]);
    expect(second.calls).toHaveLength(1);
  });
});

describe('failures', () => {
  it("counts a failed call, says why in pitwall's words, and doesn't try the same activity again soon", async () => {
    const h = harness();
    h.start();
    const a = h.add('a');
    await h.poll([a]);
    await h.reply(h.calls[0], envelope('Sure! Here is your recap: {"why": "a"}'));
    // errorAt is when the error was set, so a page can tell a failure since its ask from an older one (W111's review).
    expect(h.engine.health()).toEqual({ calls: 1, budget: RECAP_DAILY_BUDGET, costUsd: 0.0011, error: ANSWER_INVALID, errorAt: new Date(h.clock.now).toISOString() });
    expect(JSON.stringify(h.engine.health())).not.toContain('Sure!');
    expect(h.engine.recap(a)).toBeUndefined();
    await h.poll([a]);
    expect(h.calls).toHaveLength(1);
    // After RETRY_AFTER_FAILURE_MS, or new activity, it's tried again, and a success clears the error.
    h.clock.now += RETRY_AFTER_FAILURE_MS;
    await h.poll([a]);
    expect(h.calls).toHaveLength(2);
    // A call that starts while the error stands leaves errorAt where it was: it isn't a new failure.
    expect(h.engine.health()).toMatchObject({ calls: 2, error: ANSWER_INVALID, errorAt: new Date(h.clock.now - RETRY_AFTER_FAILURE_MS).toISOString() });
    await h.reply(h.calls[1], envelope(answer()));
    expect(h.engine.health()).not.toHaveProperty('error');
    expect(h.engine.health()).not.toHaveProperty('errorAt');
  });

  it('turns each kind of failure into a reason that never quotes what claude printed', async () => {
    const outcomes: [(call: FakeCall, h: ReturnType<typeof harness>) => Promise<void>, RegExp][] = [
      [(call, h) => h.reply(call, 'API Error: secret detail', 1), /^The recap call exited with code 1\.$/],
      [(call, h) => h.reply(call, envelope('x', { is_error: true })), new RegExp(`^${CALL_FAILED}$`)],
      [(call, h) => h.reply(call, 'not json at all'), /couldn't read/],
      [(call, h) => h.reply(call, envelope('```json\n{}\n```')), /wasn't the JSON/],
      [
        async (call) => {
          call.events.stdout('x'.repeat(1024 * 1024 + 1));
          await tick();
        },
        /far more than a recap/,
      ],
    ];
    for (const [act, reason] of outcomes) {
      const h = harness();
      h.start();
      await h.poll([h.add('a')]);
      await act(h.calls[0]!, h);
      expect(h.engine.health().error, String(reason)).toMatch(reason);
      expect(h.engine.health().error).not.toMatch(/secret|x{20}/);
      expect(h.engine.health().calls).toBe(1);
    }
  });

  it('stops a call that takes too long, and says claude was not found', async () => {
    const h = harness({ timeoutMs: 20 });
    h.start();
    await h.poll([h.add('a')]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await tick();
    expect(h.calls[0]!.signals).toEqual(['SIGTERM']);
    expect(h.engine.health().error).toBe("The recap call didn't finish in time, so pitwall stopped it.");

    const missing = harness({
      spawn: (_file, _args, _options, events) => {
        events.error('not-found');
        events.exit(null, null);
        return { pid: undefined, send: () => undefined, kill: () => undefined };
      },
    });
    missing.start();
    await missing.poll([missing.add('a')]);
    expect(missing.engine.health()).toMatchObject({ calls: 1, error: "claude wasn't found, so pitwall couldn't make a recap." });
  });

  it(`pauses automatic recaps after ${PAUSE_AFTER_FAILURES} failures in a row, so a broken claude can't spend the budget`, async () => {
    const h = harness();
    h.start();
    const sessions = ['a', 'b', 'c', 'd', 'e'].map((id) => h.add(id));
    await h.poll(sessions);
    for (let i = 0; i < PAUSE_AFTER_FAILURES; i++) await h.reply(h.calls[i], 'oops', 1);
    expect(h.calls).toHaveLength(PAUSE_AFTER_FAILURES + 1);
    await h.reply(h.calls[PAUSE_AFTER_FAILURES], 'oops', 1);
    await h.poll(sessions);
    expect(h.calls).toHaveLength(PAUSE_AFTER_FAILURES + 1);
    expect(h.logs.some((line) => /automatic recaps pause/.test(line))).toBe(true);
    // On demand still works.
    expect(h.engine.refresh(sessions[4]!)).toEqual({ kind: 'queued' });
    await tick();
    expect(h.calls).toHaveLength(PAUSE_AFTER_FAILURES + 2);
  });

  it("makes no call on a Claude Code older than spike 010's, and says so", async () => {
    const h = harness({ claudeVersion: async () => '2.1.300 (Claude Code)' });
    h.start();
    await h.poll([h.add('a')]);
    expect(h.calls).toHaveLength(0);
    expect(h.engine.health()).toEqual({ calls: 0, budget: RECAP_DAILY_BUDGET, costUsd: 0, error: 'Recaps need Claude Code 2.1.312 or later, and this is 2.1.300.', errorAt: new Date(h.clock.now).toISOString() });
    const broken = harness({ claudeVersion: async () => Promise.reject(new Error('ENOENT')) });
    broken.start();
    await broken.poll([broken.add('a')]);
    expect(broken.calls).toHaveLength(0);
    expect(broken.engine.health().error).toBe("pitwall couldn't run claude --version, so it made no recap.");
  });

  it("makes no call when pitwall can't prepare its folder", async () => {
    const h = harness({
      prepareDir: () => {
        throw new Error('mode 0755');
      },
    });
    h.start();
    await h.poll([h.add('a')]);
    expect(h.calls).toHaveLength(0);
    expect(h.engine.health().error).toBe(`pitwall couldn't prepare its folder for recap calls, ${DIR}.`);
  });
});

describe('hiding its calls', () => {
  it('knows its calls by their pid while they run, by their directory, and by their name while the row is young', async () => {
    const h = harness();
    h.start();
    await h.poll([h.add('a')]);
    const pid = h.calls[0]!.pid;
    const startedAgo = (ms: number) => new Date(h.clock.now - ms).toISOString();
    expect(h.engine.isOwn({ name: 'anything', cwd: '/elsewhere', pid })).toBe(true);
    expect(h.engine.isOwn({ name: RECAP_NAME, cwd: '/elsewhere', startedAt: startedAgo(5000) })).toBe(true);
    // A session of yours with the name, older than any call lives, isn't hidden; nor one with no start time.
    expect(h.engine.isOwn({ name: RECAP_NAME, cwd: '/elsewhere', startedAt: startedAgo(OWN_NAME_MS) })).toBe(false);
    expect(h.engine.isOwn({ name: RECAP_NAME, cwd: '/elsewhere', startedAt: startedAgo(3 * 3_600_000) })).toBe(false);
    expect(h.engine.isOwn({ name: RECAP_NAME, cwd: '/elsewhere' })).toBe(false);
    expect(h.engine.isOwn({ name: RECAP_NAME, cwd: '/elsewhere', startedAt: 'not a time' })).toBe(false);
    expect(h.engine.isOwn({ name: 'cwd-ab', cwd: DIR })).toBe(true);
    expect(h.engine.isOwn({ name: 'cwd-ab', cwd: `${DIR}/` })).toBe(true);
    expect(h.engine.isOwn({ name: 'pitwall-test-a', cwd: '/made-up/work/a', pid: 4000 })).toBe(false);
    await h.reply(h.calls[0], envelope(answer()));
    expect(h.engine.isOwn({ name: 'anything', cwd: '/elsewhere', pid })).toBe(false);
  });
});

describe('what the snapshot shows', () => {
  async function recapped(overrides: Record<string, unknown> = {}) {
    const h = harness();
    h.start();
    const a = h.add('a');
    await h.poll([a]);
    await h.reply(h.calls[0], envelope(answer(overrides)));
    return { h, a };
  }

  it('gives the session its recap, `next` only when it waits on you, and the title from the recap', async () => {
    const { h, a } = await recapped();
    const decorated = h.engine.decorate({ ...a, title: 'Claude Code’s title', titleSource: 'claude-code' });
    expect(decorated.recap).toEqual({ waitingOn: 'you', title: 'Fix the nightly export', next: answer().next, at: new Date(h.clock.now).toISOString(), source: 'pitwall' });
    expect(decorated).toMatchObject({ title: 'Fix the nightly export', titleSource: 'pitwall' });
    const ci = await recapped({ waitingOn: 'CI' });
    expect(ci.h.engine.decorate(ci.a).recap).not.toHaveProperty('next');
    // A title that says no more than the name isn't shown.
    const same = await recapped({ title: 'pitwall-test-a' });
    expect(same.h.engine.decorate(same.a)).not.toHaveProperty('title');
  });

  it("adds Needs you's 'recap' when the recap is current and waits on you, and no earlier reason holds", async () => {
    const { h, a } = await recapped();
    expect(h.engine.decorate(a).needsYou).toEqual({ reason: 'recap', text: answer().next });
    // It comes after a prompt, Claude Code's line and a question asked, and before a restart and a bare blocked.
    for (const reason of ['prompt', 'claude-code', 'asked'] as const) {
      const needsYou = reason === 'claude-code' ? { reason, text: 'Approve the deploy' } : { reason };
      expect(h.engine.decorate({ ...a, needsYou }).needsYou, reason).toEqual(needsYou);
    }
    for (const reason of ['restarted', 'blocked'] as const) expect(h.engine.decorate({ ...a, needsYou: { reason } }).needsYou).toEqual({ reason: 'recap', text: answer().next });
  });

  it('never for a working, stale or finished session, a stale recap, or one that waits on anyone else', async () => {
    const { h, a } = await recapped();
    const newer = new Date(Date.parse(a.lastActivityAt!) + 1000).toISOString();
    expect(h.engine.decorate({ ...a, lastActivityAt: newer })).toMatchObject({ recap: { stale: true } });
    expect(h.engine.decorate({ ...a, lastActivityAt: newer })).not.toHaveProperty('needsYou');
    expect(h.engine.decorate({ ...a, stale: true })).not.toHaveProperty('needsYou');
    expect(h.engine.decorate({ ...a, finished: true })).not.toHaveProperty('needsYou');
    h.facts.set('a', { file: '/made-up/projects/a.jsonl', turnEnded: false });
    h.engine.observe(new Map(h.facts));
    expect(h.engine.decorate(a)).not.toHaveProperty('needsYou');
    h.facts.set('a', { file: '/made-up/projects/a.jsonl' });
    h.engine.observe(new Map(h.facts));
    expect(h.engine.decorate({ ...a, status: 'busy' })).not.toHaveProperty('needsYou');
    expect(h.engine.decorate({ ...a, status: 'idle' }).needsYou?.reason).toBe('recap');
    for (const waitingOn of ['another session', 'CI', 'someone else', 'nothing']) {
      const other = await recapped({ waitingOn });
      expect(other.h.engine.decorate(other.a), waitingOn).not.toHaveProperty('needsYou');
    }
  });

  it("shows Claude Code's away_summary before the first recap and while the budget is spent, and it never sets Needs you", async () => {
    const h = harness({ budget: 1 });
    h.start();
    const away = { text: 'Waiting for your answer on the backport.', at: new Date(h.clock.now - 3 * MINUTE).toISOString() };
    const a = h.add('a', {}, { turnEnded: true, awaySummary: away });
    h.engine.observe(new Map(h.facts));
    const fallback = { why: '', now: away.text, next: '', waitingOn: 'nothing', title: '', at: away.at, throughAt: away.at, source: 'claude-code' };
    expect(h.engine.recap(a)).toEqual(fallback);
    expect(h.engine.decorate(a)).toMatchObject({ recap: { source: 'claude-code', waitingOn: 'nothing', title: '' } });
    expect(h.engine.decorate(a)).not.toHaveProperty('needsYou');
    expect(h.engine.decorate(a)).not.toHaveProperty('titleSource');
    // Not for a session pitwall doesn't recap by itself.
    expect(h.engine.recap({ ...a, alive: false, finished: true })).toBeUndefined();

    await h.poll([a]);
    await h.reply(h.calls[0], envelope(answer()));
    expect(h.engine.recap(a)?.source).toBe('pitwall');
    // The budget is spent, and a newer away_summary comes: it's shown in place of the stale recap.
    const later = new Date(h.clock.now + 4 * MINUTE).toISOString();
    h.facts.set('a', { file: '/made-up/projects/a.jsonl', turnEnded: true, awaySummary: { text: 'Merged.', at: later } });
    h.engine.observe(new Map(h.facts));
    const moved = { ...a, lastActivityAt: new Date(h.clock.now + MINUTE).toISOString() };
    expect(h.engine.recap(moved)).toMatchObject({ source: 'claude-code', now: 'Merged.' });
    expect(h.engine.recap(moved)).not.toHaveProperty('stale');
    expect(h.engine.decorate(moved)).not.toHaveProperty('needsYou');
  });

  it('leaves a session without a recap as it was', () => {
    const h = harness();
    const a = session('a');
    expect(h.engine.decorate(a)).toBe(a);
    expect(h.engine.recap(a)).toBeUndefined();
  });
});

describe('close', () => {
  it('stops running calls, drops queued ones, and schedules nothing more', async () => {
    const h = harness({ maxConcurrent: 1 });
    h.start();
    const sessions = [h.add('a'), h.add('b')];
    await h.poll(sessions);
    expect(h.calls).toHaveLength(1);
    await h.engine.close();
    expect(h.calls[0]!.signals).toEqual(['SIGTERM']);
    await h.poll(sessions);
    expect(h.calls).toHaveLength(1);
    expect(h.engine.health().calls).toBe(1);
  });
});
