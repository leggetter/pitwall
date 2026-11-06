// The recap strip (M5, W111, W121; docs/design-system.md, 4: Recap strip): when it shows, what it
// fetches and when, the one request for a new recap as a view opens on a stale recap or none, never in
// a loop, the summary and the to-dos under it, collapsed and open, Refresh and its answers, and its
// loading and failed states; Plan status (W123); and the picture (W150): the goal, what it's working
// on, the plan with Show plan, and only your to-dos. Made-up sessions, recaps and plans only.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planStatusPath, planStatusRefreshPath, RECAP_DAILY_BUDGET, recapPath, recapRefreshPath, type PlanStatus, type RecapHealth, type RecapSummary, type SessionRecap, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, type ApiClient, type ApiResult } from '../api.js';
import { NO_PLAN_LINE, RECAP_COLLAPSED_KEY, RECAP_WAIT_MS, RECAPS_OFF_TEXT, budgetText, parseRecap, refreshRecapFailedText } from '../recap.js';
import { minutesAgo, session } from '../test/fixtures.js';
import { NO_PLAN_TEXT, PLAN_FULL_TEXT, PLAN_STATUS_LABEL, PLAN_NO_TRANSCRIPT_TEXT, PLAN_OFF_TEXT, PLAN_STATUS_BUSY, PLAN_STATUS_READY, parsePlanStatus, planFailedText } from '../planStatus.js';
import { RecapStrip, STALE_LABEL } from './RecapStrip.js';
import { SessionView } from './SessionView.js';
import { ToastContext, type ShowToast } from './Toast.js';

const SID = '00000000-0000-4000-8000-000000000111';
const HEALTH: RecapHealth = { calls: 12, budget: RECAP_DAILY_BUDGET, costUsd: 0.01 };
const SPENT: RecapHealth = { calls: RECAP_DAILY_BUDGET, budget: RECAP_DAILY_BUDGET, costUsd: 0.2 };

const SUMMARY = 'You asked it to fix the made-up export on large files. It opened draft PR #42 with a fix and a test.';

function full(extra: Partial<SessionRecap> = {}): SessionRecap {
  return {
    summary: SUMMARY,
    todos: [
      { text: 'Say whether to mark #42 ready', owner: 'you' },
      { text: 'Open a backport PR, if you say yes', owner: 'session' },
      { text: 'Finish the checks on #42', owner: 'CI' },
      { text: 'Say whether to close #40', owner: 'you' },
      { text: 'Review #42', owner: 'someone else' },
    ],
    waitingOn: 'you',
    title: 'Fix the made-up export',
    at: minutesAgo(4),
    throughAt: minutesAgo(5),
    source: 'pitwall',
    ...extra,
  };
}

function summaryOf(recap: SessionRecap): RecapSummary {
  const yours = recap.todos.filter((todo) => todo.owner === 'you');
  return {
    waitingOn: recap.waitingOn,
    title: recap.title,
    forYou: yours.length,
    at: recap.at,
    source: recap.source,
    ...(yours[0] === undefined ? {} : { next: yours[0].text }),
    ...(recap.stale ? { stale: true as const } : {}),
  };
}

function target(recap: SessionRecap | undefined, extra: Partial<SessionSummary> = {}): SessionSummary {
  return session({ sessionId: SID, name: 'pitwall-test-recap', ...(recap ? { recap: summaryOf(recap) } : {}), ...extra });
}

type Answer = ApiResult | 'pending' | Promise<ApiResult>;
const ok = (body: unknown): ApiResult => ({ kind: 'ok', status: 200, body });
const status = (code: number, body?: unknown): ApiResult => (body === undefined ? { kind: 'failed', status: code } : { kind: 'failed', status: code, body });

/** An ApiClient that answers GET recapPath() with `recap` (a 404 without one) and POSTs with `posts` in turn. */
function fakeApi(options: { recap?: SessionRecap | Answer; posts?: Answer[] } = {}) {
  let recap: SessionRecap | Answer | undefined = options.recap;
  const posts = [...(options.posts ?? [ok({ ok: true })])];
  const answer = (value: Answer): Promise<ApiResult> => (value === 'pending' ? new Promise(() => {}) : value instanceof Promise ? value : Promise.resolve(value));
  const get = vi.fn<ApiClient['get']>(async (path) => {
    if (path !== recapPath(SID)) return status(404);
    if (recap === undefined) return status(404);
    if (recap === 'pending' || recap instanceof Promise || 'kind' in recap) return answer(recap);
    return ok(recap);
  });
  const post = vi.fn<ApiClient['post']>(async (path) => {
    if (path !== recapRefreshPath(SID)) return status(404);
    return answer(posts.length > 1 ? posts.shift()! : (posts[0] ?? ok({ ok: true })));
  });
  const api: ApiClient = { get, post, upload: vi.fn(), delete: vi.fn() };
  return {
    api,
    get,
    post,
    setRecap(next: SessionRecap | Answer | undefined) {
      recap = next;
    },
  };
}

const settle = () => act(async () => {});
/** Past --pw-delay-attach, which the strip waits before asking for a recap (500 ms with no stylesheet). */
const pastAskDelay = () => act(async () => void (await vi.advanceTimersByTimeAsync(600)));

function renderStrip(props: { session: SessionSummary; health?: RecapHealth | undefined; listed?: boolean; hidden?: boolean; turnEnded?: boolean }, api: ApiClient, toast: ShowToast = vi.fn()) {
  const ui = (next: typeof props) => (
    <ToastContext.Provider value={toast}>
      <ApiContext.Provider value={api}>
        <RecapStrip session={next.session} health={'health' in next ? next.health : HEALTH} listed={next.listed ?? true} hidden={next.hidden ?? false} {...(next.turnEnded === undefined ? {} : { turnEnded: next.turnEnded })} />
      </ApiContext.Provider>
    </ToastContext.Provider>
  );
  const view = render(ui(props));
  return { ...view, update: (next: typeof props) => view.rerender(ui(next)) };
}

const strip = () => document.querySelector<HTMLElement>('.session-recap');
const toggle = () => document.querySelector<HTMLButtonElement>('.recap-toggle');
const refreshButton = () => document.querySelector<HTMLButtonElement>('[data-recap-refresh]');
const summaryText = () => document.querySelector('.recap-summary-text')?.textContent;
const forYou = () => document.querySelector('.recap-for-you')?.textContent;
const todos = () => [...document.querySelectorAll('.recap-todo')].map((todo) => [todo.querySelector('.recap-todo-text')?.textContent, todo.querySelector('.recap-owner')?.textContent]);
const note = () => document.querySelector('.recap-body .recap-note')?.textContent;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('when there is a strip', () => {
  it('has none, and asks for nothing, with recaps off', async () => {
    const server = fakeApi({ recap: full() });
    renderStrip({ session: target(full()), health: undefined }, server.api);
    await pastAskDelay();
    expect(strip()).toBeNull();
    expect(server.get).not.toHaveBeenCalled();
    expect(server.post).not.toHaveBeenCalled();
  });

  it('has one for an ended session, which asks once as its view opens, as any other does (D26)', async () => {
    const server = fakeApi();
    const ended = (recap?: SessionRecap) => target(recap, { ended: true, finished: true, alive: false, pid: undefined, status: undefined });
    const view = renderStrip({ session: ended() }, server.api);
    expect(strip()?.dataset.recap).toBe('loading');
    await pastAskDelay();
    expect(server.post).toHaveBeenCalledTimes(1);
    const recap = full({ waitingOn: 'nothing', todos: [] });
    server.setRecap(recap);
    view.update({ session: ended(recap) });
    await settle();
    expect(strip()?.dataset.recap).toBe('shown');
    expect(summaryText()).toBe(SUMMARY);
    expect(note()).toBe('Nothing left to do.');
    expect(server.post).toHaveBeenCalledTimes(1);
  });

  it('goes when the server says it does not recap the session (404) or recaps are off (409)', async () => {
    for (const code of [404, 409]) {
      const server = fakeApi({ posts: [status(code)] });
      const view = renderStrip({ session: target(undefined) }, server.api);
      expect(strip()).not.toBeNull();
      await pastAskDelay();
      expect(server.post).toHaveBeenCalledTimes(1);
      expect(strip()).toBeNull();
      view.unmount();
    }
  });
});

describe('in the session view', () => {
  it('sits between the header and the tabs, and stays on every tab', async () => {
    const recap = full();
    const server = fakeApi({ recap });
    render(
      <ApiContext.Provider value={server.api}>
        <SessionView session={target(recap, { title: recap.title, titleSource: 'pitwall' })} listed onClose={() => {}} recaps={HEALTH} />
      </ApiContext.Provider>,
    );
    await settle();
    const view = document.querySelector('.session-view')!;
    const order = [...view.children].map((child) => (child.matches('header') ? 'header' : child.matches('.session-recap') ? 'recap' : child.getAttribute('role') === 'tablist' ? 'tabs' : 'other'));
    expect(order.indexOf('recap')).toBe(order.indexOf('header') + 1);
    expect(order.indexOf('tabs')).toBe(order.indexOf('recap') + 1);
    fireEvent.click(screen.getByRole('tab', { name: /Terminal/ }));
    expect(strip()).not.toBeNull();
  });

  it('has none where the view isn’t given the snapshot’s recaps', async () => {
    const recap = full();
    const server = fakeApi({ recap });
    render(
      <ApiContext.Provider value={server.api}>
        <SessionView session={target(recap)} listed onClose={() => {}} />
      </ApiContext.Provider>,
    );
    await pastAskDelay();
    expect(strip()).toBeNull();
    expect(server.get.mock.calls.filter(([path]) => path === recapPath(SID))).toEqual([]);
    expect(server.post).not.toHaveBeenCalled();
  });
});

describe('what it fetches, and when', () => {
  it('fetches the recap once when the view opens, and again only when the snapshot says there is a new one', async () => {
    const first = full();
    const server = fakeApi({ recap: first });
    const view = renderStrip({ session: target(first) }, server.api);
    await settle();
    expect(server.get).toHaveBeenCalledTimes(1);
    expect(server.get.mock.calls[0]?.[0]).toBe(recapPath(SID));
    // The same recap in a later snapshot: nothing more.
    view.update({ session: { ...target(first), lastActivityAt: minutesAgo(1) } });
    await settle();
    expect(server.get).toHaveBeenCalledTimes(1);
    // A new one: fetched.
    const second = full({ at: minutesAgo(0.5), summary: 'It marked #42 ready.' });
    server.setRecap(second);
    view.update({ session: target(second) });
    await settle();
    expect(server.get).toHaveBeenCalledTimes(2);
    expect(summaryText()).toBe('It marked #42 ready.');
  });

  it('fetches nothing for a session with no recap, which has none to fetch', async () => {
    const server = fakeApi({ posts: ['pending'] });
    renderStrip({ session: target(undefined) }, server.api);
    await pastAskDelay();
    expect(server.get).not.toHaveBeenCalled();
  });

  it('waits until a hidden view is shown', async () => {
    const recap = full();
    const server = fakeApi({ recap });
    const view = renderStrip({ session: target(recap), hidden: true }, server.api);
    await pastAskDelay();
    expect(server.get).not.toHaveBeenCalled();
    view.update({ session: target(recap), hidden: false });
    await settle();
    expect(server.get).toHaveBeenCalledTimes(1);
  });
});

describe('asking for a new recap as the view opens', () => {
  it('asks once, after --pw-delay-attach, for a stale recap', async () => {
    const stale = full({ stale: true });
    const server = fakeApi({ recap: stale });
    const view = renderStrip({ session: target(stale) }, server.api);
    await settle();
    expect(server.post).not.toHaveBeenCalled();
    await pastAskDelay();
    expect(server.post).toHaveBeenCalledTimes(1);
    expect(server.post.mock.calls[0]?.[0]).toBe(recapRefreshPath(SID));
    // Still stale in the next snapshots, and after the wait for the new one: never asked again.
    for (let poll = 0; poll < 3; poll += 1) {
      view.update({ session: { ...target(stale), lastActivityAt: minutesAgo(0.1 * poll) } });
      await settle();
    }
    await act(async () => void (await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS + 1000)));
    view.update({ session: target(stale) });
    await pastAskDelay();
    expect(server.post).toHaveBeenCalledTimes(1);
  });

  it('asks once for a session with none, and shows the skeleton while it comes', async () => {
    const server = fakeApi();
    const view = renderStrip({ session: target(undefined) }, server.api);
    expect(strip()?.dataset.recap).toBe('loading');
    await pastAskDelay();
    expect(server.post).toHaveBeenCalledTimes(1);
    expect(strip()?.dataset.recap).toBe('loading');
    // It arrives in the snapshot, and is fetched.
    const recap = full();
    server.setRecap(recap);
    view.update({ session: target(recap) });
    await settle();
    expect(strip()?.dataset.recap).toBe('shown');
    expect(server.post).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing for a stale recap while the session works, shows the one it has, and Refresh still asks (W132)', async () => {
    const stale = full({ stale: true });
    const server = fakeApi({ recap: stale });
    renderStrip({ session: target(stale, { status: 'busy' }) }, server.api);
    await pastAskDelay();
    expect(server.post).not.toHaveBeenCalled();
    expect(strip()?.dataset.recap).toBe('shown');
    expect(refreshButton()?.disabled).toBe(false);
    act(() => refreshButton()!.click());
    await settle();
    expect(server.post).toHaveBeenCalledTimes(1);
  });

  it("asks for a stale recap once the page says the turn has ended, whatever Claude Code's status (W132)", async () => {
    const stale = full({ stale: true });
    const server = fakeApi({ recap: stale });
    // A plugin's monitor can keep Claude Code's status at busy with no turn running (spike 007, finding 6).
    renderStrip({ session: target(stale, { status: 'busy' }), turnEnded: true }, server.api);
    await pastAskDelay();
    expect(server.post).toHaveBeenCalledTimes(1);
  });

  it('decides by the session as it is when the wait is up, so a turn that ends meanwhile asks (W132)', async () => {
    const stale = full({ stale: true });
    const server = fakeApi({ recap: stale });
    const view = renderStrip({ session: target(stale, { status: 'busy' }) }, server.api);
    await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    view.update({ session: target(stale, { status: 'idle' }) });
    await pastAskDelay();
    expect(server.post).toHaveBeenCalledTimes(1);
  });

  it('asks for one with none, even while the session works (W132)', async () => {
    const server = fakeApi();
    renderStrip({ session: target(undefined, { status: 'busy' }) }, server.api);
    await pastAskDelay();
    expect(server.post).toHaveBeenCalledTimes(1);
  });

  it('asks for nothing when the recap is current', async () => {
    const recap = full();
    const server = fakeApi({ recap });
    const view = renderStrip({ session: target(recap) }, server.api);
    await pastAskDelay();
    // Going stale later, while the view is open, doesn't ask either: the recap engine makes the next.
    view.update({ session: target({ ...recap, stale: true }) });
    await pastAskDelay();
    expect(server.post).not.toHaveBeenCalled();
  });

  it('asks for nothing while the day’s budget is spent, and says none is coming', async () => {
    const server = fakeApi();
    renderStrip({ session: target(undefined), health: SPENT }, server.api);
    await pastAskDelay();
    expect(server.post).not.toHaveBeenCalled();
    expect(strip()?.dataset.recap).toBe('none');
    expect(strip()?.textContent).toContain(`No recap yet. ${budgetText(RECAP_DAILY_BUDGET)}`);
    // Plan status needs no recap, so it's still there (W150's review).
    expect(strip()?.querySelector('.recap-plan-action [data-plan-status]')?.textContent).toBe(PLAN_STATUS_LABEL);
  });

  it('asks for nothing for a view only passed through, closed before the wait was up', async () => {
    const server = fakeApi();
    const view = renderStrip({ session: target(undefined) }, server.api);
    await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
    view.unmount();
    await pastAskDelay();
    expect(server.post).not.toHaveBeenCalled();
  });

  it('asks for nothing for a session that is no longer listed', async () => {
    const server = fakeApi();
    renderStrip({ session: target(undefined), listed: false }, server.api);
    await pastAskDelay();
    expect(server.post).not.toHaveBeenCalled();
    expect(strip()?.dataset.recap).toBe('none');
  });

  it('says none came once the wait is over, with the latest failure in pitwall’s words', async () => {
    const server = fakeApi();
    const view = renderStrip({ session: target(undefined) }, server.api);
    await pastAskDelay();
    view.update({ session: target(undefined), health: { ...HEALTH, calls: HEALTH.calls + 1, error: 'Made up: claude -p exited with code 1', errorAt: new Date(Date.now() + 1000).toISOString() } });
    await settle();
    expect(strip()?.dataset.recap).toBe('none');
    expect(strip()?.textContent).toContain('No recap yet. The latest recap failed: Made up: claude -p exited with code 1.');
  });
});

describe('the summary and the to-dos', () => {
  async function shown(recap: SessionRecap) {
    const server = fakeApi({ recap });
    const view = renderStrip({ session: target(recap) }, server.api);
    await settle();
    return view;
  }

  it('says why it started and where it is, then lists the to-dos in order, each with its owner as a tag', async () => {
    await shown(full());
    expect(summaryText()).toBe(SUMMARY);
    expect(todos()).toEqual([
      ['Say whether to mark #42 ready', 'You'],
      ['Open a backport PR, if you say yes', 'Session'],
      ['Finish the checks on #42', 'CI'],
      ['Say whether to close #40', 'You'],
      ['Review #42', 'Someone else'],
    ]);
    expect(screen.getByRole('list', { name: 'To-dos' }).tagName).toBe('OL');
    // Yours in the Needs you tone; the rest quiet.
    const tags = [...document.querySelectorAll('.recap-owner')].map((tag) => tag.className);
    expect(tags[0]).toContain('badge-subtle-warning');
    expect(tags[3]).toContain('badge-subtle-warning');
    for (const index of [1, 2, 4]) expect(tags[index]).toContain('badge-subtle-neutral');
    expect([...document.querySelectorAll('.recap-todo')].map((todo) => (todo as HTMLElement).dataset.owner)).toEqual(['you', 'session', 'CI', 'you', 'someone else']);
    // Open, the list shows yours, so there's no count.
    expect(forYou()).toBeUndefined();
  });

  it('says there is nothing left to do when there are no to-dos', async () => {
    await shown(full({ waitingOn: 'nothing', todos: [] }));
    expect(todos()).toEqual([]);
    expect(note()).toBe('Nothing left to do.');
  });

  it('shows Claude Code’s recap as a summary alone, with nothing to open', async () => {
    await shown(full({ source: 'claude-code', todos: [], title: '', waitingOn: 'nothing', summary: 'The made-up fix is in #42.' }));
    expect(screen.getByRole('heading', { name: "Claude Code's recap" })).toBeTruthy();
    expect(summaryText()).toBe('The made-up fix is in #42.');
    expect(toggle()).toBeNull();
    expect(todos()).toEqual([]);
    expect(document.querySelector('.recap-body')).toBeNull();
  });

  it('says a stale recap may be out of date, on line 1 after its age and Refresh, so the summary keeps its width', async () => {
    const stale = full({ stale: true });
    const server = fakeApi({ recap: stale, posts: ['pending'] });
    renderStrip({ session: target(stale) }, server.api);
    await settle();
    expect(document.querySelector('.recap-head .recap-stale')?.textContent).toBe(STALE_LABEL);
    // Refresh right after the age, as the recap's own, then May be out of date (W150).
    expect(document.querySelector('.recap-head .recap-age + .recap-refresh + .recap-stale')).not.toBeNull();
    expect(summaryText()).toBe(SUMMARY);
  });

  it('shows the recap’s text as text, and its age', async () => {
    await shown(full({ summary: '<b>not bold</b>\u001b[31m', todos: [{ text: '**not bold**', owner: 'you' }] }));
    expect(summaryText()).toBe('<b>not bold</b>');
    expect(document.querySelector('.recap-summary b')).toBeNull();
    expect(todos()).toEqual([['**not bold**', 'You']]);
    expect(document.querySelector('.recap-age')?.getAttribute('datetime')).toBe(full().at);
  });

  it("is a region named by its heading, with no live region but the plan status panel's, empty until it's used", async () => {
    await shown(full());
    expect(screen.getByRole('region', { name: 'Recap' })).toBe(strip());
    const live = [...(strip()?.querySelectorAll('[role="status"], [role="alert"], [aria-live]') ?? [])];
    expect(live).toHaveLength(1);
    expect(live[0]!.closest('.recap-plan')).not.toBeNull();
    expect(live[0]!.textContent).toBe('');
  });
});

describe('collapsed', () => {
  it('keeps the summary and how many to-dos are yours, and remembers the choice as a boolean', async () => {
    const recap = full();
    const server = fakeApi({ recap });
    const view = renderStrip({ session: target(recap) }, server.api);
    await settle();
    const button = toggle()!;
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(body.hidden).toBe(false);
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
    expect(strip()?.dataset.collapsed).toBe('true');
    expect(summaryText()).toBe(SUMMARY);
    expect(forYou()).toBe('2 for you');
    expect(document.querySelector('.recap-for-you')?.className).toContain('badge-subtle-warning');
    expect(window.localStorage.getItem(RECAP_COLLAPSED_KEY)).toBe('true');
    // Another view, opened later, starts collapsed.
    view.unmount();
    renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle()!);
    expect(window.localStorage.getItem(RECAP_COLLAPSED_KEY)).toBe('false');
  });

  it('has no count when no to-do is yours', async () => {
    window.localStorage.setItem(RECAP_COLLAPSED_KEY, 'true');
    const recap = full({ waitingOn: 'CI', todos: [{ text: 'Finish the checks on #42', owner: 'CI' }] });
    renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(forYou()).toBeUndefined();
  });

  it('reads anything but "true" as open', async () => {
    window.localStorage.setItem(RECAP_COLLAPSED_KEY, '{"collapsed":true}');
    const recap = full();
    renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('Refresh', () => {
  it('asks for a new recap, and is busy until the snapshot has it', async () => {
    const recap = full();
    const server = fakeApi({ recap });
    const view = renderStrip({ session: target(recap) }, server.api);
    await settle();
    fireEvent.click(refreshButton()!);
    await settle();
    expect(server.post).toHaveBeenCalledTimes(1);
    expect(refreshButton()?.getAttribute('aria-busy')).toBe('true');
    // A second press while busy sends nothing.
    fireEvent.click(refreshButton()!);
    await settle();
    expect(server.post).toHaveBeenCalledTimes(1);
    const next = full({ at: minutesAgo(0.2) });
    server.setRecap(next);
    view.update({ session: target(next) });
    await settle();
    expect(refreshButton()?.getAttribute('aria-busy')).toBeNull();
  });

  it('stays busy while the new recap is fetched, so it never sits idle beside the old one', async () => {
    const recap = full();
    const server = fakeApi({ recap });
    const view = renderStrip({ session: target(recap) }, server.api);
    await settle();
    fireEvent.click(refreshButton()!);
    await settle();
    let answer: (result: ApiResult) => void = () => {};
    server.setRecap(new Promise<ApiResult>((resolve) => (answer = resolve)));
    const next = full({ at: minutesAgo(0.2), summary: 'It marked #42 ready.' });
    view.update({ session: target(next) });
    await settle();
    expect(refreshButton()?.getAttribute('aria-busy')).toBe('true');
    answer(ok(next));
    await settle();
    expect(refreshButton()?.getAttribute('aria-busy')).toBeNull();
    expect(summaryText()).toBe('It marked #42 ready.');
  });

  it('stays busy through an error from before it asked, and stops at one after (errorAt)', async () => {
    const recap = full();
    const server = fakeApi({ recap });
    const before = { ...HEALTH, error: 'Made up: an older failure.', errorAt: new Date(Date.now() - 60_000).toISOString() };
    const view = renderStrip({ session: target(recap), health: before }, server.api);
    await settle();
    fireEvent.click(refreshButton()!);
    await settle();
    // The engine counts the call as it starts; the old error stands until a call succeeds.
    view.update({ session: target(recap), health: { ...before, calls: before.calls + 1 } });
    await settle();
    expect(refreshButton()?.getAttribute('aria-busy')).toBe('true');
    // Another session's call starting changes nothing either.
    view.update({ session: target(recap), health: { ...before, calls: before.calls + 2 } });
    await settle();
    expect(refreshButton()?.getAttribute('aria-busy')).toBe('true');
    view.update({ session: target(recap), health: { ...before, calls: before.calls + 2, error: 'Made up: it failed now.', errorAt: new Date(Date.now() + 1).toISOString() } });
    await settle();
    expect(refreshButton()?.getAttribute('aria-busy')).toBeNull();
  });

  it('stops being busy when a stale recap is made current with nothing new to say: its at kept, its stale gone', async () => {
    const stale = full({ stale: true });
    const server = fakeApi({ recap: stale, posts: [status(500), ok({ ok: true })] });
    const view = renderStrip({ session: target(stale) }, server.api);
    // The view's own ask fails quietly; then Refresh.
    await pastAskDelay();
    fireEvent.click(refreshButton()!);
    await settle();
    expect(refreshButton()?.getAttribute('aria-busy')).toBe('true');
    view.update({ session: target({ ...stale, stale: undefined }) });
    await settle();
    expect(refreshButton()?.getAttribute('aria-busy')).toBeNull();
    expect(document.querySelector('.recap-stale')).toBeNull();
    expect(server.get).toHaveBeenCalledTimes(1);
  });

  it('reads which 429 it is from the answer, for a budget another pitwall spent', async () => {
    const recap = full();
    const toast = vi.fn<ShowToast>();
    renderStrip({ session: target(recap) }, fakeApi({ recap, posts: [status(429, { ok: false, error: 'Made up.', busy: 'spent' })] }).api, toast);
    await settle();
    fireEvent.click(refreshButton()!);
    await settle();
    expect(toast).toHaveBeenCalledWith({ tone: 'info', key: 'recap-refresh', message: budgetText(RECAP_DAILY_BUDGET) });
    expect(refreshButton()?.getAttribute('aria-busy')).toBeNull();
  });

  it('stops being busy after RECAP_WAIT_MS with no new recap', async () => {
    const recap = full();
    const server = fakeApi({ recap });
    renderStrip({ session: target(recap) }, server.api);
    await settle();
    fireEvent.click(refreshButton()!);
    await settle();
    await act(async () => void (await vi.advanceTimersByTimeAsync(RECAP_WAIT_MS)));
    expect(refreshButton()?.getAttribute('aria-busy')).toBeNull();
  });

  it('is off while the day’s budget is spent, saying why, and sends nothing', async () => {
    const recap = full();
    const server = fakeApi({ recap });
    renderStrip({ session: target(recap), health: SPENT }, server.api);
    await settle();
    expect(refreshButton()?.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(refreshButton()!);
    await settle();
    expect(server.post).not.toHaveBeenCalled();
  });

  it('says why in a toast when it can’t: the budget (429), recaps off (409), or a failure', async () => {
    const recap = full();
    const cases: [ApiResult, Parameters<ShowToast>[0]][] = [
      [status(500), { tone: 'error', key: 'recap-refresh', message: refreshRecapFailedText(500) }],
      [status(409), { tone: 'info', key: 'recap-refresh', message: RECAPS_OFF_TEXT }],
    ];
    for (const [answer, toastShown] of cases) {
      const toast = vi.fn<ShowToast>();
      const view = renderStrip({ session: target(recap) }, fakeApi({ recap, posts: [answer] }).api, toast);
      await settle();
      fireEvent.click(refreshButton()!);
      await settle();
      expect(toast).toHaveBeenCalledWith(toastShown);
      view.unmount();
    }
    // A 429 that arrives after a snapshot saying the budget is spent: the toast says so.
    let answer429: (result: ApiResult) => void = () => {};
    const toast = vi.fn<ShowToast>();
    const server = fakeApi({ recap, posts: [new Promise<ApiResult>((resolve) => (answer429 = resolve))] });
    const view = renderStrip({ session: target(recap) }, server.api, toast);
    await settle();
    fireEvent.click(refreshButton()!);
    await settle();
    view.update({ session: target(recap), health: SPENT });
    answer429(status(429));
    await settle();
    expect(toast).toHaveBeenCalledWith({ tone: 'info', key: 'recap-refresh', message: budgetText(RECAP_DAILY_BUDGET) });
    expect(refreshButton()?.getAttribute('aria-disabled')).toBe('true');
  });

  it('treats a 429 while the budget lasts as a call already running: busy until it arrives', async () => {
    const recap = full();
    const toast = vi.fn<ShowToast>();
    renderStrip({ session: target(recap) }, fakeApi({ recap, posts: [status(429)] }).api, toast);
    await settle();
    fireEvent.click(refreshButton()!);
    await settle();
    expect(refreshButton()?.getAttribute('aria-busy')).toBe('true');
    expect(toast).not.toHaveBeenCalled();
  });

  it('says nothing for the view’s own request when it fails', async () => {
    const toast = vi.fn<ShowToast>();
    const stale = full({ stale: true });
    renderStrip({ session: target(stale) }, fakeApi({ recap: stale, posts: [status(500)] }).api, toast);
    await pastAskDelay();
    expect(toast).not.toHaveBeenCalled();
    expect(refreshButton()?.getAttribute('aria-busy')).toBeNull();
  });
});

describe('loading and failing', () => {
  it('shows its age from the snapshot while the recap is on its way, and skeleton bars, never its words', async () => {
    const recap = full();
    renderStrip({ session: target(recap) }, fakeApi({ recap: 'pending' }).api);
    await settle();
    expect(strip()?.dataset.recap).toBe('loading');
    expect(document.querySelector('.recap-age')?.getAttribute('datetime')).toBe(recap.at);
    expect(toggle()).not.toBeNull();
    expect(summaryText()).toBeUndefined();
    expect(strip()?.textContent).toContain('Loading the recap');
  });

  it('says it couldn’t load the recap, and Try again fetches it again', async () => {
    const recap = full();
    const server = fakeApi({ recap: status(500) });
    renderStrip({ session: target(recap) }, server.api);
    await settle();
    expect(strip()?.textContent).toContain("Couldn't load the recap (HTTP 500).");
    server.setRecap(recap);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(server.get).toHaveBeenCalledTimes(2);
    expect(strip()?.dataset.recap).toBe('shown');
  });

  it('takes a recap that isn’t one as a failure', async () => {
    const recap = full();
    renderStrip({ session: target(recap) }, fakeApi({ recap: ok({ ...recap, waitingOn: 'the moon' }) }).api);
    await settle();
    expect(strip()?.dataset.recap).toBe('failed');
    // Plan status needs no recap, so it's there, and its panel is the one it controls (W150's reviews).
    const button = strip()!.querySelector<HTMLButtonElement>('.recap-plan-action [data-plan-status]')!;
    expect(button.textContent).toBe(PLAN_STATUS_LABEL);
    expect(document.getElementById(button.getAttribute('aria-controls')!)).not.toBeNull();
  });
});

describe('Plan status (W123)', () => {
  const PLAN: PlanStatus = {
    found: true,
    plan: 'M2 of the made-up export rewrite',
    items: [
      { text: 'W1: the reader', state: 'done' },
      { text: 'W2: the writer', state: 'now' },
      { text: 'W3: the old path', state: 'dropped' },
      { text: 'W4: the docs', state: 'next' },
    ],
    changes: 'W3 was dropped: the writer replaces it.',
    at: minutesAgo(2),
    throughAt: minutesAgo(3),
  };

  /** An ApiClient for the plan routes: GET planStatusPath() with `stored`, POSTs with `posts` in turn; the recap routes as fakeApi's, with `recap`. */
  function planApi(options: { stored?: PlanStatus; posts?: Answer[] } = {}) {
    const posts = [...(options.posts ?? [])];
    const answer = (value: Answer): Promise<ApiResult> => (value === 'pending' ? new Promise(() => {}) : value instanceof Promise ? value : Promise.resolve(value));
    const get = vi.fn<ApiClient['get']>(async (path) => {
      if (path === recapPath(SID)) return ok(full());
      if (path === planStatusPath(SID)) return options.stored ? ok(options.stored) : status(404);
      return status(404);
    });
    const post = vi.fn<ApiClient['post']>(async (path) => {
      if (path !== planStatusRefreshPath(SID)) return status(404);
      return answer(posts.shift() ?? ok({ ok: true, status: PLAN }));
    });
    const api: ApiClient = { get, post, upload: vi.fn(), delete: vi.fn() };
    return { api, get, post, planPosts: () => post.mock.calls.filter(([path]) => path === planStatusRefreshPath(SID)).length, planGets: () => get.mock.calls.filter(([path]) => path === planStatusPath(SID)).length };
  }

  const button = () => document.querySelector<HTMLButtonElement>('[data-plan-status]');
  const panel = () => document.querySelector<HTMLElement>('.recap-plan');
  const items = () => [...document.querySelectorAll('.recap-plan-item')].map((li) => [li.querySelector('.recap-plan-item-text')?.textContent, li.querySelector('.recap-plan-state')?.textContent]);
  const panelNote = () => document.querySelector('.recap-plan .recap-note')?.textContent;
  // The button is in the strip's body, which shows once the recap is there (W150).
  const press = async () => {
    await settle();
    fireEvent.click(button()!);
    await settle();
  };

  it('is a button named Plan status in the body, after the to-dos, never on line 1, which fetches and makes nothing until it is pressed (W150)', async () => {
    const server = planApi();
    renderStrip({ session: target(full()) }, server.api);
    await pastAskDelay();
    expect(button()?.textContent).toBe('Plan status');
    expect(button()?.closest('.recap-body')).not.toBeNull();
    expect(button()?.closest('.recap-head')).toBeNull();
    expect(document.querySelector('.recap-body .recap-todos + .recap-plan-action [data-plan-status]')).toBe(button());
    expect(button()?.getAttribute('aria-expanded')).toBe('false');
    expect(panel()?.hidden).toBe(true);
    expect(server.planPosts()).toBe(0);
    expect(server.planGets()).toBe(0);
  });

  it('pressed with none made, makes one, busy meanwhile, then shows the plan, its items with their states, the changes and its age', async () => {
    let finish: (result: ApiResult) => void = () => undefined;
    const server = planApi({ posts: [new Promise<ApiResult>((resolve) => (finish = resolve))] });
    renderStrip({ session: target(full()) }, server.api);
    await press();
    expect(server.planPosts()).toBe(1);
    expect(button()?.getAttribute('aria-expanded')).toBe('true');
    expect(button()?.getAttribute('aria-busy')).toBe('true');
    expect(panel()?.hidden).toBe(false);
    expect(panelNote()).toBe(PLAN_STATUS_BUSY);
    await act(async () => {
      finish(ok({ ok: true, status: PLAN }));
    });
    await settle();
    expect(button()?.hasAttribute('aria-busy')).toBe(false);
    expect(document.querySelector('.recap-plan-line')?.textContent).toBe(PLAN.plan);
    expect(items()).toEqual([
      ['W1: the reader', 'Done'],
      ['W2: the writer', 'Now'],
      ['W3: the old path', 'Dropped'],
      ['W4: the docs', 'Next'],
    ]);
    expect(document.querySelector('.recap-plan-changes')?.textContent).toBe(`Changes: ${PLAN.changes}`);
    expect(document.querySelector('.recap-plan-age time')?.getAttribute('datetime') ?? document.querySelector('.recap-plan-age')?.textContent).toBeTruthy();
    expect(document.querySelector('.recap-plan-item[data-state="now"]')).not.toBeNull();
  });

  it('pressed with one made, fetches it and makes none; closed and pressed again, shows it without asking again', async () => {
    const server = planApi({ stored: PLAN });
    renderStrip({ session: target(full(), { planStatusAt: PLAN.at }) }, server.api);
    await press();
    expect(server.planGets()).toBe(1);
    expect(server.planPosts()).toBe(0);
    expect(items()).toHaveLength(4);
    fireEvent.click(document.querySelector<HTMLButtonElement>('.recap-plan-close')!);
    await settle();
    expect(panel()?.hidden).toBe(true);
    expect(document.activeElement).toBe(button());
    await press();
    expect(server.planGets()).toBe(1);
    expect(items()).toHaveLength(4);
    // Make a new one.
    fireEvent.click(document.querySelector<HTMLButtonElement>('.recap-plan-remake')!);
    await settle();
    expect(server.planPosts()).toBe(1);
  });

  it('fetches a newer one while it is open, when the snapshot says one was made', async () => {
    const server = planApi({ stored: PLAN });
    const view = renderStrip({ session: target(full(), { planStatusAt: PLAN.at }) }, server.api);
    await press();
    expect(server.planGets()).toBe(1);
    view.update({ session: target(full(), { planStatusAt: minutesAgo(0) }) });
    await settle();
    expect(server.planGets()).toBe(2);
  });

  it('says "No plan found in this session." when the transcript shows none', async () => {
    const server = planApi({ posts: [ok({ ok: true, status: { found: false, items: [], at: minutesAgo(0), throughAt: minutesAgo(1) } })] });
    renderStrip({ session: target(full()) }, server.api);
    await press();
    expect(panelNote()).toBe(NO_PLAN_TEXT);
    expect(document.querySelector('.recap-plan-items')).toBeNull();
  });

  it.each([
    ['the budget is spent', status(429, { ok: false, error: 'made up', busy: 'spent' }), budgetText(RECAP_DAILY_BUDGET)],
    ['recaps are off', status(409, { ok: false, error: 'made up' }), PLAN_OFF_TEXT],
    ['there is no transcript', status(404, { ok: false, error: 'made up' }), PLAN_NO_TRANSCRIPT_TEXT],
    ['the call failed, in pitwall’s words', status(502, { ok: false, error: "The plan status call's answer wasn't the JSON pitwall asked for." }), "The plan status call's answer wasn't the JSON pitwall asked for."],
    ['anything else', status(500), planFailedText(500)],
    ['pitwall is making as many as it does at a time, for other sessions', status(429, { ok: false, error: 'made up', busy: 'running', others: true }), PLAN_FULL_TEXT],
  ])('says why when %s', async (_name, answer, text) => {
    const server = planApi({ posts: [answer] });
    renderStrip({ session: target(full()) }, server.api);
    await press();
    expect(panelNote()).toBe(text);
    expect(button()?.hasAttribute('aria-busy')).toBe(false);
  });

  it('asks for nothing while the snapshot says the budget is spent, and says so', async () => {
    const server = planApi();
    renderStrip({ session: target(full()), health: SPENT }, server.api);
    await press();
    expect(server.planPosts()).toBe(0);
    expect(panelNote()).toBe(budgetText(RECAP_DAILY_BUDGET));
  });

  it('after a 429 running, stays busy until the snapshot says the other request made one, then fetches it', async () => {
    const server = planApi({ stored: PLAN, posts: [status(429, { ok: false, error: 'made up', busy: 'running' })] });
    const view = renderStrip({ session: target(full()) }, server.api);
    await press();
    expect(button()?.getAttribute('aria-busy')).toBe('true');
    expect(panelNote()).toBe(PLAN_STATUS_BUSY);
    view.update({ session: target(full(), { planStatusAt: PLAN.at }) });
    await settle();
    expect(server.planGets()).toBe(1);
    expect(items()).toHaveLength(4);
    expect(button()?.hasAttribute('aria-busy')).toBe(false);
  });

  it('says "Plan status ready." once to a screen reader when Reading… ends, and nothing for a newer one from a snapshot', async () => {
    let finish: (result: ApiResult) => void = () => undefined;
    const server = planApi({ stored: PLAN, posts: [new Promise<ApiResult>((resolve) => (finish = resolve))] });
    const view = renderStrip({ session: target(full()) }, server.api);
    // There, empty, once the recap and its button are, before anything is pressed.
    await settle();
    const region = document.querySelector<HTMLElement>('.recap-plan [role="status"]')!;
    expect(region.textContent).toBe('');
    await press();
    expect(region.textContent).toBe('');
    await act(async () => {
      finish(ok({ ok: true, status: PLAN }));
    });
    await settle();
    expect(region.textContent).toBe(PLAN_STATUS_READY);
    let changes = 0;
    const observer = new MutationObserver((records) => (changes += records.length));
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    view.update({ session: target(full(), { planStatusAt: minutesAgo(0) }) });
    await settle();
    expect(server.planGets()).toBe(1);
    observer.disconnect();
    expect(changes).toBe(0);
    // Closed, it says nothing.
    fireEvent.click(document.querySelector<HTMLButtonElement>('.recap-plan-close')!);
    await settle();
    expect(region.textContent).toBe('');
  });

  it('says the error once to a screen reader when Reading… ends without a plan status', async () => {
    const reason = "The plan status call's answer wasn't the JSON pitwall asked for.";
    const server = planApi({ posts: [status(502, { ok: false, error: reason })] });
    renderStrip({ session: target(full()) }, server.api);
    await press();
    expect(document.querySelector('.recap-plan [role="status"]')?.textContent).toBe(reason);
  });

  it('reads the plan status defensively', () => {
    expect(parsePlanStatus(PLAN)).toEqual(PLAN);
    expect(parsePlanStatus({ ...PLAN, items: [{ text: 'x', state: 'blocked' }] })).toBeUndefined();
    expect(parsePlanStatus({ ...PLAN, items: [] })).toBeUndefined();
    expect(parsePlanStatus({ found: false, items: [], at: PLAN.at, throughAt: PLAN.throughAt })).toEqual({ found: false, items: [], at: PLAN.at, throughAt: PLAN.throughAt });
    expect(parsePlanStatus({ found: false, plan: 'x', items: [], at: PLAN.at, throughAt: PLAN.throughAt })).toBeUndefined();
    expect(parsePlanStatus({ ...PLAN, at: 'not a time' })).toBeUndefined();
  });
});

describe('the picture (W150)', () => {
  const PICTURE = {
    goal: 'Make the made-up export work on files over 2 GB.',
    workingOn: '#42: the 32-bit size field fix, which the large-file goal needs before the archive job can reuse it.',
    plan: 'The made-up export plan: #42, then the archive job, on #42 now',
  };
  const pictured = (extra: Partial<SessionRecap> = {}) => full({ ...PICTURE, ...extra });
  const line = (name: string) => document.querySelector<HTMLElement>(`.recap-line[data-line="${name}"]`);
  const text = (name: string) => line(name)?.textContent;

  it('shows the goal, what it is working on, the plan with Show plan, and only your to-dos, with no tags and no summary', async () => {
    const recap = pictured();
    renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    expect(strip()?.dataset.picture).toBe('');
    expect(text('goal')).toBe(`Goal: ${PICTURE.goal}`);
    expect(text('working-on')).toBe(`Working on: ${PICTURE.workingOn}`);
    expect(line('plan')?.querySelector('.recap-line-text')?.textContent).toBe(PICTURE.plan);
    expect(line('plan')?.querySelector('[data-plan-status]')?.textContent).toBe('Show plan');
    expect(line('for-you')?.querySelector('.recap-label')?.textContent).toBe('For you (2):');
    expect(todos()).toEqual([
      ['Say whether to mark #42 ready', undefined],
      ['Say whether to close #40', undefined],
    ]);
    expect(screen.getByRole('list', { name: 'For you' }).tagName).toBe('OL');
    // The session's, CI's and someone else's to-dos are the conversation's, and the summary is for recaps without the picture.
    expect(strip()?.textContent).not.toContain('Open a backport PR');
    expect(strip()?.textContent).not.toContain('Review #42');
    expect(summaryText()).toBeUndefined();
    // In order: goal, working on, plan, for you.
    const order = [...document.querySelectorAll('.recap-line')].map((each) => (each as HTMLElement).dataset.line);
    expect(order).toEqual(['goal', 'working-on', 'plan', 'for-you']);
    // Waiting on you: no quiet line, the to-dos say it.
    expect(document.querySelector('.recap-waiting')).toBeNull();
  });

  it('says quietly what else it waits on, says when nothing is left, and names no plan when the recap has none', async () => {
    const ci = pictured({ waitingOn: 'CI', todos: [{ text: 'Finish the checks on #42', owner: 'CI' }], plan: '' });
    const view = renderStrip({ session: target(ci) }, fakeApi({ recap: ci }).api);
    await settle();
    expect(document.querySelector('.recap-waiting')?.textContent).toBe('Waiting on CI.');
    expect(line('for-you')).toBeNull();
    expect(note()).toBe('Waiting on CI.');
    expect(line('plan')?.querySelector('.recap-line-text')?.textContent).toBe(NO_PLAN_LINE);
    expect(line('plan')?.querySelector('[data-plan-status]')).not.toBeNull();
    view.unmount();
    const done = pictured({ waitingOn: 'nothing', todos: [] });
    renderStrip({ session: target(done) }, fakeApi({ recap: done }).api);
    await settle();
    expect(document.querySelector('.recap-body .recap-note')?.textContent).toBe('Nothing left to do.');
    expect(document.querySelector('.recap-waiting')).toBeNull();
  });

  it('collapsed, keeps Working on, on one line, and how many to-dos are yours; the goal and the rest are hidden', async () => {
    window.localStorage.setItem(RECAP_COLLAPSED_KEY, 'true');
    const recap = pictured();
    renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    const button = toggle()!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const controlled = button.getAttribute('aria-controls')!.split(' ').map((id) => document.getElementById(id));
    expect(controlled).toHaveLength(2);
    expect(controlled.every((each) => each?.hidden === true)).toBe(true);
    expect(controlled[0]).toBe(line('goal'));
    expect(line('working-on')?.hidden).toBe(false);
    expect(line('working-on')?.querySelector('.recap-for-you')?.textContent).toBe('2 for you');
    fireEvent.click(button);
    expect(controlled.every((each) => each?.hidden === false)).toBe(true);
    expect(line('working-on')?.querySelector('.recap-for-you')).toBeNull();
  });

  it('Show plan opens the plan status panel under the Plan line, making one when there is none', async () => {
    const recap = pictured();
    const server = fakeApi({ recap, posts: [] });
    const post = vi.fn<ApiClient['post']>(async (path) => (path === planStatusRefreshPath(SID) ? ok({ ok: true, status: { found: true, plan: 'M2', items: [{ text: 'W1', state: 'now' }], at: minutesAgo(0), throughAt: minutesAgo(1) } }) : status(404)));
    renderStrip({ session: target(recap) }, { ...server.api, post });
    await settle();
    const show = line('plan')!.querySelector<HTMLButtonElement>('[data-plan-status]')!;
    expect(show.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(show.getAttribute('aria-controls')!)!;
    expect(panel.hidden).toBe(true);
    // Right under the Plan line, before your to-dos.
    expect(line('plan')!.nextElementSibling).toBe(panel);
    fireEvent.click(show);
    await settle();
    expect(post.mock.calls.filter(([path]) => path === planStatusRefreshPath(SID))).toHaveLength(1);
    expect(show.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector('.recap-plan-line')?.textContent).toBe('M2');
    fireEvent.click(panel.querySelector<HTMLButtonElement>('.recap-plan-close')!);
    await settle();
    expect(document.activeElement).toBe(show);
  });

  it("shows a recap without the picture, and Claude Code's, as their summary, Plan status under Claude Code's", async () => {
    const claude = full({ source: 'claude-code', todos: [], title: '', waitingOn: 'nothing', summary: 'The made-up fix is in #42.', ...PICTURE });
    renderStrip({ session: target(claude) }, fakeApi({ recap: claude }).api);
    await settle();
    expect(strip()?.dataset.picture).toBeUndefined();
    expect(summaryText()).toBe('The made-up fix is in #42.');
    expect(document.querySelector('.recap-summary + .recap-plan-action [data-plan-status]')?.textContent).toBe('Plan status');
    expect(document.querySelector('.recap-line')).toBeNull();
  });

  it('reads the picture defensively: all three as text, or none', () => {
    const body = { ...full(), ...PICTURE };
    expect(parseRecap(body)).toMatchObject(PICTURE);
    expect(parseRecap({ ...body, plan: undefined })).not.toHaveProperty('goal');
    expect(parseRecap({ ...body, goal: 3 })).toBeUndefined();
    expect(parseRecap({ ...body, workingOn: 'x'.repeat(500) })?.workingOn?.length).toBeLessThanOrEqual(400);
  });
});
