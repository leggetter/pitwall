// The recap engine (M5, W110): which sessions get a recap and when, the budget and its midnight
// reset, updates against first recaps, failures, the hiding of its calls, and what the snapshot
// shows, Needs you's 'recap' reason included; and plan statuses (W123). A fake index, a fake `claude` that answers as
// `claude -p --output-format json` does, and the test's own clock: no test runs claude. Every session
// and recap here is made up.
import { describe, expect, it } from 'vitest';
import type { SessionFacts } from '../index/index.js';
import type { RecapSourceReader, RecapSources } from '../index/recapSources.js';
import { PLAN_TURNS_CAP, RECAP_DAILY_BUDGET, RECAP_DEBOUNCE_MS, RECAP_MODEL, RECAP_TURNS_CAP, RECAP_UPDATE_DEBOUNCE_MS, type ConversationEntry, type ConversationPage, type IndexSnapshot, type PullRequestList, type PullRequestSummary, type SessionRecap, type SessionSummary, type WorkChoice } from '../shared/protocol.js';
import { modelRejectedMessage } from '../server/work.js';
import { memoryBudget } from './budget.js';
import { memoryRecapStore } from './store.js';
import type { RecapChildEvents, RecapSpawner } from './call.js';
import { createRecapEngine, ownersNeedingYou, OWN_NAME_MS, PAUSE_AFTER_FAILURES, PLAN_MAX_CONCURRENT, PLAN_MODEL_REJECTED, RETRY_AFTER_FAILURE_MS, secondsToMidnight, type RecapEngineOptions, type RecapIndex } from './engine.js';
import { CALL_FAILED, RECAP_REFUSALS, PLAN_STATUS_SYSTEM_PROMPT, planStatusArgs, recapArgs, RECAP_NAME } from './prompt.js';

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

const NEXT = 'Say whether to mark #42 ready';
const answer = (overrides: Record<string, unknown> = {}) => ({
  summary: 'You asked it to fix the nightly export. It opened draft PR #42 with a fix, and CI passes.',
  todos: [
    { text: 'Open a backport PR for 1.x', owner: 'session' },
    { text: NEXT, owner: 'you' },
    { text: 'Say whether to close #40', owner: 'you' },
  ],
  waitingOn: 'you',
  title: 'Fix the nightly export',
  goal: 'Make the nightly export work on large files.',
  workingOn: '#42: the fix, which the export needs.',
  plan: '',
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

/** A made-up open PR of yours, `example/demo-app#42`, healthy unless overridden. */
const pullRequest = (overrides: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  url: 'https://github.com/example/demo-app/pull/42',
  repo: 'example/demo-app',
  repoLabel: 'example/demo-app',
  number: 42,
  title: 'Fix the nightly export',
  draft: true,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-28T12:00:00.000Z',
  checks: 'passing',
  mergeable: 'clean',
  relation: 'authored',
  ...overrides,
});
const prList = (prs: PullRequestSummary[], extra: Partial<PullRequestList> = {}): PullRequestList => ({ source: { ok: true }, refreshing: false, prs, fetchedAt: '2026-10-29T12:00:00.000Z', ...extra });
const OPENED_42 = [{ kind: 'opened' as const, repo: 'example/demo-app', number: 42, lastAt: '2026-10-01T12:00:00.000Z' }];

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
  /** Entries a conversation page holds; all of them in one page by default. */
  const paging: { size?: number; fail?: boolean } = {};
  const index: RecapIndex = {
    latest: () => latest,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async conversation(sessionId, before): Promise<ConversationPage | undefined> {
      if (paging.fail === true) throw new Error('made-up read failure');
      const all = pages.get(sessionId) ?? [];
      if (paging.size === undefined) return { sessionId, entries: all };
      // Pages of paging.size entries, the cursor the index of the oldest entry handed back.
      const end = before === undefined ? all.length : Number(before);
      const start = Math.max(0, end - paging.size);
      return { sessionId, entries: all.slice(start, end), ...(start > 0 ? { before: String(start) } : {}) };
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
    recapStore: memoryRecapStore(),
    log: (message) => logs.push(message),
    randomId: () => '0123456789abcdef',
    env: { PATH: '/usr/bin:/bin', HOME: '/made-up/home' },
    ...options,
  });
  let changes = 0;
  engine.subscribe(() => changes++);
  let prs: PullRequestList = prList([]);
  const prListeners = new Set<(list: PullRequestList) => void>();

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
    paging,
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
      engine.start(index, {
        latest: () => prs,
        subscribe(listener) {
          prListeners.add(listener);
          return () => prListeners.delete(listener);
        },
      });
    },
    /** A new PR list, as the PR poller sends one. */
    async setPrs(list: PullRequestSummary[], extra: Partial<PullRequestList> = {}) {
      prs = prList(list, extra);
      for (const listener of [...prListeners]) listener(prs);
      await tick();
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

  it('recaps a finished session that owns a PR that needs you, once per activity, from a new PR list too (W128)', async () => {
    const h = harness();
    h.start();
    // Finished weeks after it opened its PR, its transcript's last mark a turn that never ended.
    const old = new Date(h.clock.now - 3 * 24 * 60 * MINUTE).toISOString();
    const done = h.add('done', { finished: true, alive: false, pid: undefined, lastActivityAt: old, prLinks: OPENED_42 }, { turnEnded: false });
    const ended = h.add('ended', { finished: true, ended: true, alive: false, kind: 'interactive', lastActivityAt: old, prLinks: [{ ...OPENED_42[0]!, number: 43 }] });
    const stale = h.add('stale', { stale: true, alive: false, lastActivityAt: old, prLinks: [{ ...OPENED_42[0]!, number: 44 }] });
    const noTranscript = h.add('no-transcript', { finished: true, alive: false, transcript: 'missing', lastActivityAt: old, prLinks: [{ ...OPENED_42[0]!, number: 45 }] });
    const sessions = [done, ended, stale, noTranscript];
    // A healthy PR, a draft included, needs nothing: no recap.
    await h.setPrs([pullRequest()]);
    await h.poll(sessions);
    expect(h.calls).toHaveLength(0);
    // Conflicts on #42, and #43 is someone else's PR with failing checks, which isn't yours to fix.
    await h.setPrs([
      pullRequest({ mergeable: 'conflicts' }),
      pullRequest({ number: 43, url: 'https://github.com/example/demo-app/pull/43', checks: 'failing', relation: 'mentioned' }),
      ...[44, 45].map((number) => pullRequest({ number, url: `https://github.com/example/demo-app/pull/${number}`, checks: 'failing' })),
    ]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.input).toContain('Fix done.');
    await h.reply(h.calls[0], envelope(answer()));
    expect(h.engine.recap(done)?.source).toBe('pitwall');
    // Nothing new in its transcript: none again, whatever the PR list does.
    await h.setPrs([pullRequest({ mergeable: 'conflicts', checks: 'failing' })]);
    await h.poll(sessions);
    expect(h.calls).toHaveLength(1);
    // Its transcript changes: one more, an update, once it's been quiet RECAP_UPDATE_DEBOUNCE_MS (W132).
    const later = { ...done, lastActivityAt: new Date(h.clock.now - RECAP_UPDATE_DEBOUNCE_MS).toISOString() };
    h.pages.get('done')!.push({ kind: 'user', text: 'Is the PR still needed?', at: later.lastActivityAt });
    await h.poll([later, ended, stale, noTranscript]);
    expect(h.calls).toHaveLength(2);
  });

  it("doesn't retry a finished session's failed recap until it has new activity (#130's review)", async () => {
    const h = harness();
    h.start();
    const old = new Date(h.clock.now - 3 * 24 * 60 * MINUTE).toISOString();
    const done = h.add('done', { finished: true, alive: false, pid: undefined, lastActivityAt: old, prLinks: OPENED_42 }, { turnEnded: false });
    await h.poll([done]);
    await h.setPrs([pullRequest({ mergeable: 'conflicts' })]);
    expect(h.calls).toHaveLength(1);
    await h.reply(h.calls[0], envelope('Sure! Here is your recap.'));
    // A running session would be tried again after RETRY_AFTER_FAILURE_MS; a finished one waits for activity.
    h.clock.now += 2 * RETRY_AFTER_FAILURE_MS;
    await h.setPrs([pullRequest({ mergeable: 'conflicts', checks: 'failing' })]);
    await h.poll([done]);
    expect(h.calls).toHaveLength(1);
  });

  it('finds the sessions that own a PR that needs you, as the page does (W128)', () => {
    const mine = session('mine', { prLinks: OPENED_42 });
    // Prompted with the PR's URL ranks below opening it, so it doesn't own it.
    const prompted = session('prompted', { prLinks: [{ ...OPENED_42[0]!, kind: 'prompted', lastAt: '2026-10-28T12:00:00.000Z' }] });
    const mentioned = session('mentioned', { prLinks: [{ ...OPENED_42[0]!, kind: 'mentioned', number: 46 }] });
    const snapshot = snapshotOf([mine, prompted, mentioned]);
    expect([...ownersNeedingYou(snapshot, prList([pullRequest({ checks: 'failing' })]))]).toEqual(['mine']);
    expect([...ownersNeedingYou(snapshot, prList([pullRequest()]))]).toEqual([]);
    expect([...ownersNeedingYou(snapshot, prList([pullRequest({ number: 46, url: 'https://github.com/example/demo-app/pull/46', checks: 'failing' })]))]).toEqual([]);
    expect([...ownersNeedingYou(snapshot, undefined)]).toEqual([]);
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
    h.clock.now += 16 * MINUTE;
    a = { ...a, lastActivityAt: newer };
    expect(h.engine.recap(a)?.stale).toBe(true);
    await h.poll([a]);
    expect(h.calls).toHaveLength(2);
    const input = h.calls[1]!.input!;
    expect(input).toContain('<previous-recap>\n{"goal":"Make the nightly export work on large files.","workingOn":"#42: the fix, which the export needs.","plan":"","summary":"You asked it to fix the nightly export. It opened draft PR #42 with a fix, and CI passes.","todos":[{"text":"Open a backport PR for 1.x","owner":"session"}');
    expect(input).toContain('<turns-since-previous-recap>');
    expect(input).toContain('User: Yes, open it.');
    expect(input).not.toContain('Please fix a.');
    expect(input).toContain('Revise the previous recap with what the newer turns show: keep its goal, plan and summary steady');
    expect(input).not.toContain('<latest-turns>');
    const reviewed = [{ text: 'Review #43', owner: 'someone else' }];
    await h.reply(h.calls[1], envelope(answer({ summary: 'It opened #43.', todos: reviewed, waitingOn: 'someone else' })));
    expect(h.engine.recap(a)).toMatchObject({ summary: 'It opened #43.', todos: reviewed, waitingOn: 'someone else', throughAt: newer });
    expect(Date.parse(newer)).toBeGreaterThan(Date.parse(firstThrough));

    // Activity with nothing the input shows, such as a tool's result: no call, and the recap holds through it.
    h.clock.now += 16 * MINUTE;
    const toolResult = new Date(h.clock.now - RECAP_UPDATE_DEBOUNCE_MS).toISOString();
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

  it('sends Claude Code’s own recap and the whole compaction summary in a first recap (W150)', async () => {
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
    // Whole since W150, as a plan status reads it.
    expect(h.calls[0]!.input).toContain('<compaction-summary>\n1. Primary Request and Intent:\nFix a.\n2. Two:\nleft out\n</compaction-summary>');
  });
});

describe('kept across restarts (W132)', () => {
  // Made-up session ids, as Claude Code's: kept recaps are filed by a session's UUID.
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';
  const C = '00000000-0000-4000-8000-00000000000c';

  /** A first run that recaps `ids`, then a second run on the same store, as a restart is. */
  async function restarted(ids: string[], first: Partial<RecapEngineOptions> = {}) {
    const store = memoryRecapStore();
    const one = harness({ recapStore: store, ...first });
    one.start();
    const sessions = ids.map((id) => one.add(id));
    await one.poll(sessions);
    // Two at a time: each reply lets the next call start.
    for (let i = 0; i < one.calls.length; i++) await one.reply(one.calls[i], envelope(answer()));
    await one.engine.close();
    const two = harness({ recapStore: store });
    return { store, one, two, sessions };
  }

  it('keeps each recap with the transcript position it covers, and a restart recaps no session that has not moved on', async () => {
    const { store, one, two, sessions } = await restarted([A, B]);
    expect(one.calls).toHaveLength(2);
    const kept = store.current();
    expect([...kept.keys()].sort()).toEqual([A, B]);
    expect(kept.get(A)).toEqual({ ...answer(), at: new Date(one.clock.now).toISOString(), throughAt: sessions[0]!.lastActivityAt, source: 'pitwall' });

    two.start();
    const [a, b] = [two.add(A), two.add(B)];
    await two.poll([a, b]);
    two.clock.now += 60 * MINUTE;
    await two.poll([a, b]);
    expect(two.calls).toHaveLength(0);
    // Shown as before, and Needs you's 'recap' reason with it, which a restart no longer loses.
    expect(two.engine.recap(a)).toEqual(kept.get(A));
    expect(two.engine.decorate(a)).toMatchObject({ recap: { source: 'pitwall', waitingOn: 'you', next: NEXT }, needsYou: { reason: 'recap', text: NEXT }, title: 'Fix the nightly export', titleSource: 'pitwall' });
    expect(two.logs).toEqual([]);
  });

  it("updates one whose transcript moved on, from its kept recap, and keeps the update", async () => {
    const { store, two } = await restarted([A]);
    two.start();
    two.clock.now += 30 * MINUTE;
    const newer = new Date(two.clock.now - RECAP_UPDATE_DEBOUNCE_MS).toISOString();
    two.pages.set(A, [
      { kind: 'user', text: 'Yes, open it.', at: newer },
      { kind: 'assistant', text: 'Opened #43.', at: newer },
    ]);
    two.add(A);
    const a = { ...session(A, {}, two.clock), lastActivityAt: newer };
    expect(two.engine.recap(a)?.stale).toBe(true);
    await two.poll([a]);
    expect(two.calls).toHaveLength(1);
    expect(two.calls[0]!.input).toContain('<previous-recap>\n{"goal":"Make the nightly export work on large files.","workingOn":"#42: the fix, which the export needs.","plan":"","summary":"You asked it to fix the nightly export.');
    expect(two.calls[0]!.input).toContain('User: Yes, open it.');
    await two.reply(two.calls[0], envelope(answer({ summary: 'It opened #43.' })));
    expect(store.current().get(A)).toMatchObject({ summary: 'It opened #43.', throughAt: newer });
  });

  it('keeps a throughAt moved on without a call, so a restart makes no call for it either', async () => {
    const { store, two } = await restarted([A]);
    two.start();
    two.clock.now += 30 * MINUTE;
    // Activity the input shows no turn for, such as a tool's result.
    const toolResult = new Date(two.clock.now - RECAP_UPDATE_DEBOUNCE_MS).toISOString();
    two.pages.set(A, [{ kind: 'assistant', text: 'Fixed. Shall I open a PR?', at: new Date(Date.parse('2026-10-29T12:00:00.000Z') - 6 * MINUTE).toISOString() }]);
    two.add(A);
    await two.poll([{ ...session(A, {}, two.clock), lastActivityAt: toolResult }]);
    expect(two.calls).toHaveLength(0);
    expect(store.current().get(A)?.throughAt).toBe(toolResult);
  });

  it('recaps a finished session for its PR once, not again on every start (W128)', async () => {
    const store = memoryRecapStore();
    const prs = [pullRequest({ mergeable: 'conflicts' })];
    const old = new Date(Date.parse('2026-10-29T12:00:00.000Z') - 3 * 24 * 60 * MINUTE).toISOString();
    const finished = { finished: true, alive: false, pid: undefined, lastActivityAt: old, prLinks: OPENED_42 };
    for (const run of [1, 2, 3]) {
      const h = harness({ recapStore: store });
      h.start();
      await h.setPrs(prs);
      await h.poll([h.add(A, finished)]);
      expect(h.calls, `run ${run}`).toHaveLength(run === 1 ? 1 : 0);
      if (run === 1) await h.reply(h.calls[0], envelope(answer()));
      await h.engine.close();
    }
  });

  it('forgets a kept recap once its session was listed and has left, never for a failed listing or a session not listed yet', async () => {
    const { store, two } = await restarted([A, B, C]);
    two.start();
    const [a, b] = [two.add(A), two.add(B)];
    // C isn't listed by this run, as under roots another pitwall on this home has: it stays on disk.
    await two.poll([a, b]);
    expect([...store.current().keys()].sort()).toEqual([A, B, C]);
    // A listing that failed keeps the last sessions: nothing is forgotten.
    await two.poll([], false);
    expect([...store.current().keys()].sort()).toEqual([A, B, C]);
    // B has left: gone, in memory and on disk.
    await two.poll([a]);
    expect([...store.current().keys()].sort()).toEqual([A, C]);
    expect(two.engine.recap(b)).toBeUndefined();
    // C, listed later, has its kept recap and needs no call.
    const c = two.add(C);
    await two.poll([a, c]);
    expect(two.engine.recap(c)?.source).toBe('pitwall');
    expect(two.calls).toHaveLength(0);
  });

  it('keeps nothing for a session id that is not a UUID', async () => {
    const { store } = await restarted(['not-a-uuid']);
    expect(store.current().size).toBe(0);
  });

  it("counts kept recaps it couldn't use in the log, never their text, and makes those sessions new ones", async () => {
    const logs: string[] = [];
    const h = harness({
      recapStore: { load: () => ({ recaps: new Map(), ignored: 2, expired: 1 }), save: () => undefined, remove: () => undefined },
      log: (message) => logs.push(message),
    });
    expect(logs).toEqual(["ignored 2 kept recaps pitwall couldn't use; those sessions get new ones."]);
    h.start();
    await h.poll([h.add(A)]);
    expect(h.calls).toHaveLength(1);
  });
});

describe('the two waits after a turn ends (W132)', () => {
  it(`makes a first recap ${RECAP_DEBOUNCE_MS / MINUTE} minutes after a turn ends, and an update only ${RECAP_UPDATE_DEBOUNCE_MS / MINUTE}`, async () => {
    expect(RECAP_DEBOUNCE_MS).toBe(5 * MINUTE);
    expect(RECAP_UPDATE_DEBOUNCE_MS).toBe(15 * MINUTE);
    const h = harness();
    h.start();
    let a = h.add('a', { state: 'working', lastActivityAt: new Date(h.clock.now - RECAP_DEBOUNCE_MS + 1000).toISOString() });
    await h.poll([a]);
    expect(h.calls).toHaveLength(0);
    h.clock.now += 1000;
    await h.poll([a]);
    expect(h.calls).toHaveLength(1);
    await h.reply(h.calls[0], envelope(answer()));

    // A new turn ends: no update 5 minutes on, nor 1 second short of 15.
    const turnEnd = new Date(h.clock.now).toISOString();
    h.pages.get('a')!.push({ kind: 'user', text: 'Yes, open it.', at: turnEnd }, { kind: 'assistant', text: 'Opened #43.', at: turnEnd });
    a = { ...a, lastActivityAt: turnEnd };
    h.clock.now += RECAP_DEBOUNCE_MS;
    await h.poll([a]);
    h.clock.now += RECAP_UPDATE_DEBOUNCE_MS - RECAP_DEBOUNCE_MS - 1000;
    await h.poll([a]);
    expect(h.calls).toHaveLength(1);
    // Meanwhile the recap there stands in, marked stale.
    expect(h.engine.decorate(a).recap?.stale).toBe(true);
    h.clock.now += 1000;
    await h.poll([a]);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.input).toContain('<previous-recap>');
  });

  it('answers a refresh at once, whatever the waits, so Refresh still works', async () => {
    const h = harness();
    h.start();
    const a = h.add('a', { lastActivityAt: new Date(h.clock.now - MINUTE).toISOString() });
    await h.poll([a]);
    expect(h.calls).toHaveLength(0);
    expect(h.engine.refresh(a)).toEqual({ kind: 'queued' });
    await tick();
    expect(h.calls).toHaveLength(1);
  });

  it(`allows ${RECAP_DAILY_BUDGET} calls a day`, () => {
    expect(RECAP_DAILY_BUDGET).toBe(500);
    expect(harness().engine.health()).toMatchObject({ budget: 500 });
  });
});

describe('a finished background job is updated after the short wait (W162)', () => {
  /** A first recap made, then new activity at the turn's end; the clock moves on `after` ms and the engine polls. Returns the calls made since the first. */
  async function update(overrides: Partial<SessionSummary>, fact: SessionFacts, after: number) {
    const { h } = await updated(overrides, fact, after);
    return h.calls.length - 1;
  }

  /** As update(), returning the harness and the session, to go on from there. */
  async function updated(overrides: Partial<SessionSummary>, fact: SessionFacts, after: number) {
    const h = harness();
    h.start();
    let a = h.add('a', { state: 'working', lastActivityAt: new Date(h.clock.now - RECAP_DEBOUNCE_MS).toISOString() });
    await h.poll([a]);
    expect(h.calls).toHaveLength(1);
    await h.reply(h.calls[0], envelope(answer()));
    const turnEnd = new Date(h.clock.now).toISOString();
    h.pages.get('a')!.push({ kind: 'user', text: 'Go on.', at: turnEnd }, { kind: 'assistant', text: 'Done. Mark it ready before you post.', at: turnEnd });
    h.facts.set('a', { file: '/made-up/projects/a.jsonl', ...fact });
    a = { ...a, ...overrides, lastActivityAt: turnEnd };
    h.clock.now += after;
    await h.poll([a]);
    return { h, a };
  }

  it('waits the short debounce for an update when the job says done, its process is alive and its turn has ended', async () => {
    expect(await update({ state: 'done' }, { turnEnded: true }, RECAP_DEBOUNCE_MS - 1000)).toBe(0);
    expect(await update({ state: 'done' }, { turnEnded: true }, RECAP_DEBOUNCE_MS)).toBe(1);
  });

  it('keeps the long wait for a job that is working or blocked', async () => {
    for (const state of ['working', 'blocked'] as const) {
      expect(await update({ state }, { turnEnded: true }, RECAP_DEBOUNCE_MS)).toBe(0);
      expect(await update({ state }, { turnEnded: true }, RECAP_UPDATE_DEBOUNCE_MS)).toBe(1);
    }
  });

  it('makes none while the turn has not ended, whatever the wait', async () => {
    expect(await update({ state: 'done' }, { turnEnded: false }, RECAP_UPDATE_DEBOUNCE_MS)).toBe(0);
  });

  it('makes no second call once the update has landed', async () => {
    const { h, a } = await updated({ state: 'done' }, { turnEnded: true }, RECAP_DEBOUNCE_MS);
    expect(h.calls).toHaveLength(2);
    await h.reply(h.calls[1], envelope(answer()));
    h.clock.now += RECAP_UPDATE_DEBOUNCE_MS;
    await h.poll([a]);
    expect(h.calls).toHaveLength(2);
  });

  it('waits RETRY_AFTER_FAILURE_MS after a failed update, not the short wait again', async () => {
    const { h, a } = await updated({ state: 'done' }, { turnEnded: true }, RECAP_DEBOUNCE_MS);
    expect(h.calls).toHaveLength(2);
    await h.reply(h.calls[1], envelope('Sure! Here is your recap.'));
    h.clock.now += RETRY_AFTER_FAILURE_MS - 1000;
    await h.poll([a]);
    expect(h.calls).toHaveLength(2);
    h.clock.now += 1000;
    await h.poll([a]);
    expect(h.calls).toHaveLength(3);
  });

  it('uses Claude Code\'s status for the turn when the transcript has no mark', async () => {
    expect(await update({ state: 'done', status: 'idle' }, {}, RECAP_DEBOUNCE_MS)).toBe(1);
    expect(await update({ state: 'done', status: 'busy' }, {}, RECAP_UPDATE_DEBOUNCE_MS)).toBe(0);
  });

  it('keeps the long wait for an interactive session, which has no job state', async () => {
    expect(await update({ kind: 'interactive', state: undefined }, { turnEnded: true }, RECAP_DEBOUNCE_MS)).toBe(0);
  });

  it('makes no automatic update for a done job whose process is gone, however long the wait', async () => {
    expect(await update({ state: 'done', alive: false, pid: undefined, finished: true }, { turnEnded: true }, RECAP_UPDATE_DEBOUNCE_MS)).toBe(0);
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
    await h.reply(h.calls[0], envelope(answer({ waitingOn: 'nothing', todos: [] })));
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
    const store = memoryBudget({ day: '2026-10-29', calls: RECAP_DAILY_BUDGET - 1, costUsd: 0.2 });
    const h = harness({ budgetStore: store, now: () => Date.parse('2026-10-29T12:00:00.000Z') });
    expect(h.engine.health()).toMatchObject({ calls: RECAP_DAILY_BUDGET - 1, costUsd: 0.2 });
    h.start();
    await h.poll([h.add('a'), h.add('b')]);
    expect(h.calls).toHaveLength(1);
    expect(store.current()).toEqual({ day: '2026-10-29', calls: RECAP_DAILY_BUDGET, costUsd: 0.2 });
    await h.reply(h.calls[0], envelope(answer()));
    expect(store.current()).toEqual({ day: '2026-10-29', calls: RECAP_DAILY_BUDGET, costUsd: 0.2011 });
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
    await h.reply(h.calls[0], envelope('Sure! Here is your recap: {"summary": "a"}'));
    // errorAt is when the error was set, so a page can tell a failure since its ask from an older one (W111's review).
    expect(h.engine.health()).toEqual({ calls: 1, budget: RECAP_DAILY_BUDGET, costUsd: 0.0011, error: RECAP_REFUSALS['text-around'], errorAt: new Date(h.clock.now).toISOString() });
    expect(JSON.stringify(h.engine.health())).not.toContain('Sure!');
    expect(h.engine.recap(a)).toBeUndefined();
    await h.poll([a]);
    expect(h.calls).toHaveLength(1);
    // After RETRY_AFTER_FAILURE_MS, or new activity, it's tried again, and a success clears the error.
    h.clock.now += RETRY_AFTER_FAILURE_MS;
    await h.poll([a]);
    expect(h.calls).toHaveLength(2);
    // A call that starts while the error stands leaves errorAt where it was: it isn't a new failure.
    expect(h.engine.health()).toMatchObject({ calls: 2, error: RECAP_REFUSALS['text-around'], errorAt: new Date(h.clock.now - RETRY_AFTER_FAILURE_MS).toISOString() });
    await h.reply(h.calls[1], envelope(answer()));
    expect(h.engine.health()).not.toHaveProperty('error');
    expect(h.engine.health()).not.toHaveProperty('errorAt');
  });

  it('turns each kind of failure into a reason that never quotes what claude printed', async () => {
    const outcomes: [(call: FakeCall, h: ReturnType<typeof harness>) => Promise<void>, RegExp][] = [
      [(call, h) => h.reply(call, 'API Error: secret detail', 1), /^The recap call exited with code 1\.$/],
      [(call, h) => h.reply(call, envelope('x', { is_error: true })), new RegExp(`^${CALL_FAILED}$`)],
      [(call, h) => h.reply(call, 'not json at all'), /couldn't read/],
      [(call, h) => h.reply(call, envelope('```json\n{}\n```')), /missing or extra fields/],
      [(call, h) => h.reply(call, envelope(answer({ summary: 'It fixed\u202e it.' }))), /^The recap call's answer had a hidden character, which pitwall refuses\.$/],
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

  it('repairs a fenced answer and a waitingOn that disagrees with the to-dos, and logs which repair, never the answer (W126)', async () => {
    const h = harness();
    h.start();
    const a = h.add('a');
    await h.poll([a]);
    const text = '```json\n' + JSON.stringify(answer({ waitingOn: 'nothing', summary: 'A distinctive summary.' })) + '\n```';
    await h.reply(h.calls[0]!, envelope(text));
    expect(h.engine.health()).not.toHaveProperty('error');
    expect(h.engine.recap(a)).toMatchObject({ waitingOn: 'you', summary: 'A distinctive summary.' });
    expect(h.logs).toContain('a recap answer was repaired (fence, waiting-on).');
    expect(h.logs.join('\n')).not.toContain('distinctive');
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

  it('gives the session its recap: what it waits on, how many to-dos are yours, the first of them as `next`, and the title', async () => {
    const { h, a } = await recapped();
    const decorated = h.engine.decorate({ ...a, title: 'Claude Code’s title', titleSource: 'claude-code' });
    expect(decorated.recap).toEqual({ waitingOn: 'you', title: 'Fix the nightly export', forYou: 2, next: NEXT, at: new Date(h.clock.now).toISOString(), source: 'pitwall' });
    expect(decorated).toMatchObject({ title: 'Fix the nightly export', titleSource: 'pitwall' });
    // Your first to-do is `next` whatever it waits on now, for the strip; only Needs you depends on 'you'.
    const ci = await recapped({ waitingOn: 'CI', todos: [{ text: 'Finish the checks on #42', owner: 'CI' }, { text: NEXT, owner: 'you' }] });
    expect(ci.h.engine.decorate(ci.a).recap).toMatchObject({ waitingOn: 'CI', forYou: 1, next: NEXT });
    const none = await recapped({ waitingOn: 'CI', todos: [{ text: 'Finish the checks on #42', owner: 'CI' }] });
    expect(none.h.engine.decorate(none.a).recap).toMatchObject({ forYou: 0 });
    expect(none.h.engine.decorate(none.a).recap).not.toHaveProperty('next');
    // A title that says no more than the name isn't shown.
    const same = await recapped({ title: 'pitwall-test-a' });
    expect(same.h.engine.decorate(same.a)).not.toHaveProperty('title');
  });

  it("adds Needs you's 'recap' when the recap is current and waits on you, and no earlier reason holds", async () => {
    const { h, a } = await recapped();
    // Its text is the first to-do for you, not the first to-do.
    expect(h.engine.decorate(a).needsYou).toEqual({ reason: 'recap', text: NEXT });
    // It comes after a prompt, Claude Code's line and a question asked, and before a restart and a bare blocked.
    for (const reason of ['prompt', 'claude-code', 'asked'] as const) {
      const needsYou = reason === 'claude-code' ? { reason, text: 'Approve the deploy' } : { reason };
      expect(h.engine.decorate({ ...a, needsYou }).needsYou, reason).toEqual(needsYou);
    }
    for (const reason of ['restarted', 'blocked'] as const) expect(h.engine.decorate({ ...a, needsYou: { reason } }).needsYou).toEqual({ reason: 'recap', text: NEXT });
  });

  it("not for a to-do of yours behind someone else's, which isn't due yet (W146)", async () => {
    const todos = [
      { text: 'Merge #42', owner: 'someone else' },
      { text: 'Release the CLI once #42 ships', owner: 'you' },
    ];
    const { h, a } = await recapped({ todos, waitingOn: 'you' });
    expect(h.engine.decorate(a).recap).toMatchObject({ waitingOn: 'someone else', forYou: 1 });
    expect(h.engine.decorate(a)).not.toHaveProperty('needsYou');
  });

  it("not while CI runs a step of the session's before yours (#168's review)", async () => {
    const todos = [
      { text: 'Watch CI on #42 and fix failures', owner: 'session' },
      { text: 'Merge #42', owner: 'you' },
    ];
    const { h, a } = await recapped({ todos, waitingOn: 'CI' });
    expect(h.engine.decorate(a).recap).toMatchObject({ waitingOn: 'CI', forYou: 1, next: 'Merge #42' });
    expect(h.engine.decorate(a)).not.toHaveProperty('needsYou');
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
      const other = await recapped({ waitingOn, todos: [{ text: 'Carry on', owner: 'session' }] });
      expect(other.h.engine.decorate(other.a), waitingOn).not.toHaveProperty('needsYou');
    }
    // 'nothing' beside a to-do for you is repaired to 'you', so Needs you has it to show (W126).
    const repaired = await recapped({ waitingOn: 'nothing' });
    expect(repaired.h.engine.decorate(repaired.a).needsYou?.reason).toBe('recap');
  });

  it("shows Claude Code's away_summary before the first recap and while the budget is spent, and it never sets Needs you", async () => {
    const h = harness({ budget: 1 });
    h.start();
    const away = { text: 'Waiting for your answer on the backport.', at: new Date(h.clock.now - 3 * MINUTE).toISOString() };
    const a = h.add('a', {}, { turnEnded: true, awaySummary: away });
    h.engine.observe(new Map(h.facts));
    // A summary only, with no to-dos (W121).
    const fallback = { summary: away.text, todos: [], waitingOn: 'nothing', title: '', at: away.at, throughAt: away.at, source: 'claude-code' };
    expect(h.engine.recap(a)).toEqual(fallback);
    expect(h.engine.decorate(a)).toMatchObject({ recap: { source: 'claude-code', waitingOn: 'nothing', title: '', forYou: 0 } });
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
    expect(h.engine.recap(moved)).toMatchObject({ source: 'claude-code', summary: 'Merged.', todos: [] });
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

describe('plan status (W123)', () => {
  const PLAN = { found: true, plan: 'M2 of the made-up export rewrite', items: [{ text: 'W1: the reader', state: 'done' }, { text: 'W2: the writer', state: 'now' }, { text: 'W3: the old path', state: 'dropped' }], changes: 'W3 was dropped: the writer replaces it.' };
  /** A session no recap is due for by itself (ended), so only the plan status calls. */
  const quiet = (h: ReturnType<typeof harness>, id: string) => h.add(id, { alive: false, ended: true, pid: undefined });

  it("makes one on demand with a recap's call and the plan prompt, over the first prompt, the whole compaction summary and up to 24k of turns", async () => {
    const h = harness();
    h.start();
    const a = quiet(h, 'a');
    h.sources.set('/made-up/projects/a.jsonl', { firstPrompt: 'Work through M2 in PLAN.md.', compaction: { text: '1. Primary Request and Intent:\nM2.\n2. Two:\nkept too' } });
    await h.poll([a]);
    expect(h.calls).toHaveLength(0);
    const made = h.engine.makePlanStatus(a);
    await tick();
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.args).toEqual(planStatusArgs({ model: RECAP_MODEL }));
    expect(call.args[call.args.indexOf('--system-prompt') + 1]).toBe(PLAN_STATUS_SYSTEM_PROMPT);
    expect(call.cwd).toBe(DIR);
    expect(call.env.DISABLE_PROMPT_CACHING).toBe('1');
    expect(call.input).toContain('<first-prompt>\nWork through M2 in PLAN.md.\n</first-prompt>');
    // All its sections, not a recap's excerpt.
    expect(call.input).toContain('2. Two:\nkept too');
    expect(call.input).toContain('Write the plan status');
    // A second while it runs is refused.
    expect(await h.engine.makePlanStatus(a)).toEqual({ kind: 'running', retryAfterSeconds: 5 });
    await h.reply(call, envelope(PLAN));
    const result = await made;
    expect(result.kind).toBe('made');
    const status = { found: true, plan: PLAN.plan, items: PLAN.items, changes: PLAN.changes, at: new Date(h.clock.now).toISOString(), throughAt: a.lastActivityAt };
    expect(result).toEqual({ kind: 'made', status });
    expect(h.engine.planStatus(a)).toEqual(status);
    // The snapshot carries only when it was made (D14), and the call counted against the budget.
    expect(h.engine.decorate(a)).toEqual({ ...a, planStatusAt: status.at });
    expect(h.engine.health()).toMatchObject({ calls: 1, costUsd: 0.0011 });
    // Kept apart from recaps: no recap was made, and recaps' health has no error.
    expect(h.engine.recap(a)).toBeUndefined();
  });

  it('collects up to PLAN_TURNS_CAP characters of turns, three times a recap', async () => {
    const h = harness();
    h.start();
    const a = quiet(h, 'a');
    const long = Array.from({ length: 40 }, (_, i) => ({ kind: 'assistant' as const, text: `Turn ${i} ${'x'.repeat(900)}`, at: new Date(h.clock.now - (40 - i) * MINUTE).toISOString() }));
    h.pages.set('a', long);
    await h.poll([a]);
    const made = h.engine.makePlanStatus(a);
    await tick();
    const turns = /<latest-turns>\n([\s\S]*)\n<\/latest-turns>/.exec(h.calls[0]!.input!)![1]!;
    expect(turns.length).toBeGreaterThan(RECAP_TURNS_CAP);
    expect(turns.length).toBeLessThanOrEqual(PLAN_TURNS_CAP);
    await h.reply(h.calls[0], envelope({ found: false }));
    expect((await made).kind).toBe('made');
  });

  it("says no plan without a call when there's nothing to read, and refuses without a transcript, once the budget is spent, and after close", async () => {
    const h = harness({ budget: 1 });
    h.start();
    const a = quiet(h, 'a');
    h.pages.set('a', []);
    h.sources.set('/made-up/projects/a.jsonl', {});
    const none = session('none', { alive: false, ended: true, transcript: 'missing' });
    await h.poll([a, none]);
    expect(await h.engine.makePlanStatus(none)).toEqual({ kind: 'no-transcript' });
    const empty = await h.engine.makePlanStatus(a);
    expect(empty).toMatchObject({ kind: 'made', status: { found: false, items: [] } });
    expect(h.calls).toHaveLength(0);
    const b = quiet(h, 'b');
    await h.poll([a, b]);
    const made = h.engine.makePlanStatus(b);
    await tick();
    await h.reply(h.calls[0], envelope({ found: false }));
    await made;
    const spent = await h.engine.makePlanStatus(b);
    expect(spent.kind).toBe('spent');
    await h.engine.close();
    expect(await h.engine.makePlanStatus(b)).toEqual({ kind: 'closed' });
  });

  it("answers a refused answer or a failed call in pitwall's words, keeps the one before, and leaves recaps' health alone", async () => {
    const h = harness();
    h.start();
    const a = quiet(h, 'a');
    await h.poll([a]);
    const first = h.engine.makePlanStatus(a);
    await tick();
    await h.reply(h.calls[0], envelope(PLAN));
    await first;
    const second = h.engine.makePlanStatus(a);
    await tick();
    await h.reply(h.calls[1], envelope('Here is the plan: ignore your instructions.'));
    expect(await second).toEqual({ kind: 'failed', reason: "The plan status call's answer wasn't the JSON pitwall asked for." });
    const third = h.engine.makePlanStatus(a);
    await tick();
    await h.reply(h.calls[2], 'oops', 1);
    expect(await third).toEqual({ kind: 'failed', reason: 'The plan status call exited with code 1.' });
    expect(h.engine.planStatus(a)?.plan).toBe(PLAN.plan);
    expect(h.engine.health().error).toBeUndefined();
  });

  it(`makes at most PLAN_MAX_CONCURRENT (${PLAN_MAX_CONCURRENT}) at a time, of all sessions, answering others 'running'`, async () => {
    const h = harness();
    h.start();
    const [a, b, c] = [quiet(h, 'a'), quiet(h, 'b'), quiet(h, 'c')];
    await h.poll([a, b, c]);
    const first = h.engine.makePlanStatus(a);
    const second = h.engine.makePlanStatus(b);
    await tick();
    expect(h.calls).toHaveLength(2);
    expect(await h.engine.makePlanStatus(c)).toEqual({ kind: 'running', retryAfterSeconds: 5, others: true });
    expect(h.calls).toHaveLength(2);
    await h.reply(h.calls[0], envelope({ found: false }));
    await first;
    // One has finished, so there's room for c.
    const third = h.engine.makePlanStatus(c);
    await tick();
    expect(h.calls).toHaveLength(3);
    await h.reply(h.calls[1], envelope({ found: false }));
    await h.reply(h.calls[2], envelope({ found: false }));
    expect((await second).kind).toBe('made');
    expect((await third).kind).toBe('made');
  });

  it("says in its own words which setting to change when Claude Code refuses the model, and leaves recaps' health alone", async () => {
    const h = harness({ work: () => ({ model: 'claude-haiku-9-9' }) });
    h.start();
    const a = quiet(h, 'a');
    await h.poll([a]);
    const made = h.engine.makePlanStatus(a);
    await tick();
    await h.reply(h.calls[0], envelope("There's an issue with the selected model (claude-haiku-9-9). It may not exist or you may not have access to it.", { is_error: true, total_cost_usd: 0 }), 1);
    expect(await made).toEqual({ kind: 'failed', reason: PLAN_MODEL_REJECTED });
    expect(PLAN_MODEL_REJECTED).toMatch(/plan status/);
    expect(PLAN_MODEL_REJECTED).toMatch(/"work.recaps"/);
    expect(h.engine.health().error).toBeUndefined();
  });

  it('is stopped by close, which waits for it', async () => {
    const h = harness();
    h.start();
    const a = quiet(h, 'a');
    await h.poll([a]);
    const made = h.engine.makePlanStatus(a);
    await tick();
    await h.engine.close();
    expect(h.calls[0]!.signals).toEqual(['SIGTERM']);
    expect(await made).toEqual({ kind: 'closed' });
  });

  it('forgets the plan status of a session no longer listed', async () => {
    const h = harness();
    h.start();
    const a = quiet(h, 'a');
    await h.poll([a]);
    const made = h.engine.makePlanStatus(a);
    await tick();
    await h.reply(h.calls[0], envelope({ found: false }));
    await made;
    await h.poll([]);
    expect(h.engine.planStatus(a)).toBeUndefined();
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

describe('the model and effort for recaps (W119)', () => {
  it("reads the store's choice at each call, so a change in Preferences reaches the next recap", async () => {
    let choice: WorkChoice = { model: 'claude-haiku-5-5' };
    const h = harness({ work: () => choice, env: { PATH: '/usr/bin:/bin', HOME: '/made-up/home', CLAUDE_CODE_EFFORT_LEVEL: 'max' } });
    h.start();
    await h.poll([h.add('a')]);
    expect(h.calls[0]!.args).toEqual(recapArgs());
    await h.reply(h.calls[0], envelope(answer()));
    choice = { model: 'sonnet', effort: 'low' };
    await h.poll([h.add('a'), h.add('b')]);
    expect(h.calls).toHaveLength(2);
    const args = h.calls[1]!.args;
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 4)).toEqual(['--model', 'sonnet', '--effort', 'low']);
    // An inherited effort can't change what's chosen: the call's environment leaves it out.
    expect(h.calls[1]!.env).not.toHaveProperty('CLAUDE_CODE_EFFORT_LEVEL');
  });

  it("says in pitwall's words which setting to change when Claude Code refuses the model", async () => {
    const h = harness({ work: () => ({ model: 'claude-haiku-9-9' }) });
    h.start();
    await h.poll([h.add('a')]);
    const refused = envelope("There's an issue with the selected model (claude-haiku-9-9). It may not exist or you may not have access to it.", { is_error: true, total_cost_usd: 0 });
    await h.reply(h.calls[0], refused, 1);
    expect(h.engine.health().error).toBe(modelRejectedMessage('recaps'));
    expect(h.engine.health().error).toMatch(/Preferences, under Models and effort, or in the config file's "work.recaps"/);
  });
});

describe("the picture and the session's PRs (W150)", () => {
  it('reads up to PLAN_TURNS_CAP of turns for a first recap, and keeps the goal, working on and plan', async () => {
    const h = harness();
    h.start();
    const a = h.add('a');
    h.pages.set('a', Array.from({ length: 40 }, (_, i) => ({ kind: 'assistant' as const, text: `Turn ${i} ${'x'.repeat(900)}`, at: new Date(h.clock.now - (46 - i) * MINUTE).toISOString() })));
    await h.poll([a]);
    const turns = /<latest-turns>\n([\s\S]*)\n<\/latest-turns>/.exec(h.calls[0]!.input!)![1]!;
    expect(turns.length).toBeGreaterThan(RECAP_TURNS_CAP);
    expect(turns.length).toBeLessThanOrEqual(PLAN_TURNS_CAP);
    await h.reply(h.calls[0], envelope(answer({ plan: 'M2 of the export, on W2' })));
    expect(h.engine.recap(a)).toMatchObject({ goal: answer().goal, workingOn: answer().workingOn, plan: 'M2 of the export, on W2' });
  });

  it('makes a first recap, not an update, after a recap without the picture, and after a compaction newer than the previous recap', async () => {
    const ID = '00000000-0000-4000-8000-0000000000c1';
    for (const why of ['no picture', 'compacted'] as const) {
      const clock = Date.parse('2026-10-29T12:00:00.000Z');
      const { goal: _goal, workingOn: _workingOn, plan: _plan, ...beforeW150 } = answer();
      // A recap kept before W150, without the picture, or one made now, with it.
      const kept: SessionRecap = { ...(why === 'no picture' ? beforeW150 : answer()), at: new Date(clock).toISOString(), throughAt: new Date(clock - 6 * MINUTE).toISOString(), source: 'pitwall' } as SessionRecap;
      const h = harness({ recapStore: memoryRecapStore(new Map([[ID, kept]])) });
      h.start();
      let a = h.add(ID);
      expect(h.engine.recap(a), why).toMatchObject({ summary: kept.summary });
      const newer = new Date(h.clock.now + MINUTE).toISOString();
      h.pages.get(ID)!.push({ kind: 'user', text: 'Carry on with W3.', at: newer });
      if (why === 'compacted') h.sources.set(`/made-up/projects/${ID}.jsonl`, { firstPrompt: `Fix ${ID}.`, compaction: { text: '1. Primary Request and Intent:\nM2.', at: newer } });
      h.clock.now += 16 * MINUTE;
      a = { ...a, lastActivityAt: newer };
      await h.poll([a]);
      expect(h.calls, why).toHaveLength(1);
      const input = h.calls[0]!.input!;
      expect(input, why).toContain('<latest-turns>');
      expect(input, why).not.toContain('<previous-recap>');
      expect(input, why).toContain('Write the recap.');
    }
  });

  it('makes an update, not a first recap, after a compaction older than the previous recap', async () => {
    const ID = '00000000-0000-4000-8000-0000000000c2';
    const clock = Date.parse('2026-10-29T12:00:00.000Z');
    const kept: SessionRecap = { ...answer(), at: new Date(clock).toISOString(), throughAt: new Date(clock - 6 * MINUTE).toISOString(), source: 'pitwall' } as SessionRecap;
    const h = harness({ recapStore: memoryRecapStore(new Map([[ID, kept]])) });
    h.start();
    let a = h.add(ID);
    const newer = new Date(h.clock.now + MINUTE).toISOString();
    h.pages.get(ID)!.push({ kind: 'user', text: 'Carry on with W3.', at: newer });
    // Compacted before the previous recap's throughAt: that recap already read it.
    h.sources.set(`/made-up/projects/${ID}.jsonl`, { firstPrompt: `Fix ${ID}.`, compaction: { text: '1. Primary Request and Intent:\nM2.', at: new Date(clock - 10 * MINUTE).toISOString() } });
    h.clock.now += 16 * MINUTE;
    a = { ...a, lastActivityAt: newer };
    await h.poll([a]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.input!).toContain('<previous-recap>');
  });

  it("names the session's PRs in a recap's input, an update's and a plan status's, and none without a list", async () => {
    const h = harness();
    h.start();
    const links = [
      { kind: 'opened' as const, repo: 'example/demo-app', number: 42, lastAt: '2026-10-29T11:00:00.000Z' },
      { kind: 'opened' as const, repo: 'example/demo-app', number: 40, lastAt: '2026-10-28T11:00:00.000Z' },
      { kind: 'mentioned' as const, repo: 'example/demo-app', number: 7, lastAt: '2026-10-29T11:30:00.000Z' },
    ];
    await h.setPrs([pullRequest({ checks: 'failing', review: 'changes-requested' }), pullRequest({ number: 7, url: 'https://github.com/example/demo-app/pull/7' })], {
      searches: { authored: { fetchedAt: '2026-10-29T12:00:00.000Z' } },
    });
    let a = h.add('a', { prLinks: links });
    await h.poll([a]);
    const block = '<pull-requests fetched-at="2026-10-29T12:00:00.000Z">\nexample/demo-app#42: open, draft, checks failing, changes requested. Title: "Fix the nightly export"\nexample/demo-app#40: no longer open: merged or closed\n</pull-requests>\n</session-0123456789abcdef>';
    expect(h.calls[0]!.input).toContain(block);
    expect(h.calls[0]!.input).not.toContain('#7');
    await h.reply(h.calls[0], envelope(answer()));
    const newer = new Date(h.clock.now + MINUTE).toISOString();
    h.pages.get('a')!.push({ kind: 'user', text: 'Carry on.', at: newer });
    h.clock.now += 16 * MINUTE;
    a = { ...a, lastActivityAt: newer };
    await h.poll([a]);
    expect(h.calls[1]!.input).toContain('<previous-recap>');
    expect(h.calls[1]!.input).toContain(block);
    await h.reply(h.calls[1], envelope(answer()));
    const made = h.engine.makePlanStatus(a);
    await tick();
    expect(h.calls[2]!.input).toContain(block);
    await h.reply(h.calls[2], envelope({ found: false }));
    await made;

    // With --no-prs, or before the first fetch: no block.
    await h.setPrs([], { source: { ok: false, reason: 'off', error: 'off' }, fetchedAt: undefined });
    const plain = h.engine.makePlanStatus(a);
    await tick();
    expect(h.calls[3]!.input).not.toContain('<pull-requests');
    await h.reply(h.calls[3], envelope({ found: false }));
    await plain;
  });
});

describe('an answer in a busy stretch (W152)', () => {
  const ID = '00000000-0000-4000-8000-0000000000d1';
  const clock = Date.parse('2026-10-29T12:00:00.000Z');
  const BUDGET = 'Approve a recap budget of 40 a day?';

  /** A recap carrying your question, then your answer and a busy stretch of `busy` tool calls and hand-backs. */
  function busy(maxPages: number, busy = 30) {
    const kept: SessionRecap = { ...answer({ todos: [{ text: BUDGET, owner: 'you' }] }), at: new Date(clock).toISOString(), throughAt: new Date(clock - 6 * MINUTE).toISOString(), source: 'pitwall' } as SessionRecap;
    const h = harness({ recapStore: memoryRecapStore(new Map([[ID, kept]])), maxPages });
    h.paging.size = 10;
    h.start();
    let a = h.add(ID);
    const after = (seconds: number) => new Date(clock + seconds * 1000).toISOString();
    h.pages.get(ID)!.push({ kind: 'user', text: 'Yes, 40 a day is fine.', at: after(10) });
    for (let i = 0; i < busy; i++) {
      h.pages.get(ID)!.push({ kind: 'tool', text: `Bash: gh run watch ${i}`, at: after(20 + 2 * i) });
      h.pages.get(ID)!.push({ kind: 'cross-session', text: `Done: step ${i}. ${'x'.repeat(900)}`, at: after(21 + 2 * i), subagent: { description: 'review a step' } as ConversationEntry['subagent'] });
    }
    // Past the update's 15 minutes after the last activity.
    h.clock.now += 18 * MINUTE;
    a = { ...a, lastActivityAt: after(21 + 2 * (busy - 1)) };
    return { h, a };
  }

  it("keeps your answer in the update's input, however many turns came after it", async () => {
    const { h, a } = busy(8);
    await h.poll([a]);
    expect(h.calls).toHaveLength(1);
    const turns = /<turns-since-previous-recap>\n([\s\S]*)\n<\/turns-since-previous-recap>/.exec(h.calls[0]!.input!)![1]!;
    const lines = turns.split('\n');
    expect(lines[0]).toBe('[10-29 12:00] User: Yes, 40 a day is fine.');
    expect(lines[1]).toMatch(/^\[… \d+ other turns left out …\]$/);
    expect(turns).toContain('Done: step 29.');
    expect(turns).not.toContain('not read');
    expect(h.calls[0]!.input).toContain(BUDGET);
  });

  it("makes no call when the turns can't be read, and keeps the recap (W152's review)", async () => {
    const { h, a } = busy(8);
    h.paging.fail = true;
    await h.poll([a]);
    expect(h.calls).toHaveLength(0);
    expect(h.engine.recap(a)).toMatchObject({ todos: [{ text: BUDGET, owner: 'you' }] });
  });

  it('says older turns were not read when the stretch is longer than its pages', async () => {
    // One page of 10 a recap, so an update reads 4: 40 of 61 entries.
    const { h, a } = busy(1);
    await h.poll([a]);
    const turns = /<turns-since-previous-recap>\n([\s\S]*)\n<\/turns-since-previous-recap>/.exec(h.calls[0]!.input!)![1]!;
    expect(turns.split('\n')[0]).toBe('[… older turns since the previous recap not read …]');
    expect(turns).not.toContain('40 a day is fine');
  });
});
