// The recap strip (M5, W111, W121; docs/design-system.md, 4: Recap strip): when it shows, what it
// fetches and when, the one request for a new recap as a view opens on a stale recap or none, never in
// a loop, the summary and the to-dos under it, collapsed and open, Refresh and its answers, and its
// loading and failed states; and the picture (W150): the goal, what it's working on, the Plan section
// with the plan's items (W172), and only your to-dos. Made-up sessions, recaps and plans only.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECAP_DAILY_BUDGET, recapPath, recapRefreshPath, type RecapHealth, type RecapSummary, type SessionRecap, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, type ApiClient, type ApiResult } from '../api.js';
import { RECAP_COLLAPSED_KEY, RECAP_PLAN_COLLAPSED_KEY, RECAP_WAIT_MS, RECAPS_OFF_TEXT, budgetText, parseRecap, refreshRecapFailedText } from '../recap.js';
import { minutesAgo, session } from '../test/fixtures.js';
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
    // No plan UI without a recap: W123's Plan status, which needed none, is gone (W172).
    expect(strip()?.querySelector('.recap-plan')).toBeNull();
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

  it('is a region named by its heading, with no live region (W172: the plan status panel had the only one)', async () => {
    await shown(full());
    expect(screen.getByRole('region', { name: 'Recap' })).toBe(strip());
    expect(strip()?.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(0);
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
    // No plan UI without a recap (W172).
    expect(strip()?.querySelector('.recap-plan')).toBeNull();
  });
});

describe('the picture (W150, W189)', () => {
  const PICTURE = {
    goal: 'Make the made-up export work on files over 2 GB.',
    done: 'The reader fix is merged, and the size field fix is open as a draft PR (#42).',
    workingOn: '#42: the 32-bit size field fix, which the large-file goal needs before the archive job can reuse it.',
    plan: 'The made-up export plan: #42, then the archive job, on #42 now',
  };
  const pictured = (extra: Partial<SessionRecap> = {}) => full({ ...PICTURE, ...extra });
  const line = (name: string) => document.querySelector<HTMLElement>(`[data-line="${name}"]`);
  const text = (name: string) => line(name)?.textContent;
  const planToggle = () => document.querySelector<HTMLButtonElement>('.recap-plan-toggle');
  const planLine = () => document.querySelector('.recap-plan-line')?.textContent;
  const planItems = () => [...document.querySelectorAll('.recap-plan-item')].map((li) => [li.querySelector('.recap-plan-item-text')?.textContent, li.querySelector('.recap-plan-state')?.textContent]);
  const ITEMS = [
    { text: '#42: the 32-bit size field fix', state: 'now' as const },
    { text: 'The archive job reuses it', state: 'next' as const },
    { text: 'The old 2 GB guard', state: 'dropped' as const },
    { text: '#40: the reader', state: 'done' as const },
  ];

  it('leads with the summary, then the goal, what is done, what it is working on, the Plan section, your to-dos and the rest, each tagged (W189)', async () => {
    const recap = pictured();
    renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    expect(strip()?.dataset.picture).toBe('');
    expect(summaryText()).toBe(SUMMARY);
    expect(text('goal')).toBe(`Goal: ${PICTURE.goal}`);
    expect(text('done')).toBe(`Done: ${PICTURE.done}`);
    expect(text('working-on')).toBe(`Working on: ${PICTURE.workingOn}`);
    // A plan's line with no items: under a plain heading, nothing to open.
    expect(line('plan')?.querySelector('h4')?.textContent).toBe('Plan');
    expect(planLine()).toBe(PICTURE.plan);
    expect(planToggle()).toBeNull();
    expect(document.querySelector('.recap-plan-items')).toBeNull();
    expect(line('for-you')?.querySelector('.recap-label')?.textContent).toBe('For you (2):');
    expect(screen.getByRole('list', { name: 'For you' }).tagName).toBe('OL');
    // Yours with no tags; everyone else's under Next, in order, each tagged with who acts (W189).
    expect(line('next')?.querySelector('.recap-label')?.textContent).toBe('Next:');
    expect(screen.getByRole('list', { name: 'Next' }).tagName).toBe('OL');
    expect(todos()).toEqual([
      ['Say whether to mark #42 ready', undefined],
      ['Say whether to close #40', undefined],
      ['Open a backport PR, if you say yes', 'Session'],
      ['Finish the checks on #42', 'CI'],
      ['Review #42', 'Someone else'],
    ]);
    // In order: goal, done, working on, plan, for you, next.
    const order = [...document.querySelectorAll('[data-line]')].map((each) => (each as HTMLElement).dataset.line);
    expect(order).toEqual(['goal', 'done', 'working-on', 'plan', 'for-you', 'next']);
    // Waiting on you: no quiet line, the to-dos say it.
    expect(document.querySelector('.recap-waiting')).toBeNull();
  });

  it('has no Done line for a recap made before W189', async () => {
    const recap = pictured({ done: undefined });
    renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    expect(line('done')).toBeNull();
    expect(text('goal')).toBe(`Goal: ${PICTURE.goal}`);
  });

  it('says quietly what else it waits on, says when nothing is left, and has no Plan section when the recap names no plan', async () => {
    const ci = pictured({ waitingOn: 'CI', todos: [{ text: 'Finish the checks on #42', owner: 'CI' }], plan: '' });
    const view = renderStrip({ session: target(ci) }, fakeApi({ recap: ci }).api);
    await settle();
    expect(document.querySelector('.recap-waiting')?.textContent).toBe('Waiting on CI.');
    expect(line('for-you')).toBeNull();
    expect(note()).toBe('Waiting on CI.');
    expect(todos()).toEqual([['Finish the checks on #42', 'CI']]);
    expect(line('plan')).toBeNull();
    expect(strip()?.textContent).not.toContain('Plan');
    view.unmount();
    const done = pictured({ waitingOn: 'nothing', todos: [] });
    renderStrip({ session: target(done) }, fakeApi({ recap: done }).api);
    await settle();
    expect(document.querySelector('.recap-body .recap-note')?.textContent).toBe('Nothing left to do.');
    expect(document.querySelector('.recap-waiting')).toBeNull();
  });

  it('collapsed, keeps the summary, on one line, and how many to-dos are yours; the rest is hidden (W189)', async () => {
    window.localStorage.setItem(RECAP_COLLAPSED_KEY, 'true');
    const recap = pictured();
    renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    const button = toggle()!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const controlled = button.getAttribute('aria-controls')!.split(' ').map((id) => document.getElementById(id));
    expect(controlled).toHaveLength(1);
    expect(controlled[0]?.hidden).toBe(true);
    for (const name of ['goal', 'done', 'working-on', 'for-you', 'next']) expect(controlled[0]?.contains(line(name)), name).toBe(true);
    expect(summaryText()).toBe(SUMMARY);
    expect(document.querySelector('.recap-summary .recap-for-you')?.textContent).toBe('2 for you');
    fireEvent.click(button);
    expect(controlled[0]?.hidden).toBe(false);
    expect(document.querySelector('.recap-summary .recap-for-you')).toBeNull();
  });

  it("shows the plan's line beside its toggle, collapsed by default, and opens to the items, each tagged, with no Changes when there are none (W172)", async () => {
    const recap = pictured({ planItems: ITEMS });
    renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    const toggle = planToggle()!;
    expect(toggle.textContent).toBe('Plan');
    expect(toggle.closest('h4')).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(line('plan')?.dataset.open).toBe('false');
    // The line is there while it's collapsed, on the toggle's row.
    expect(toggle.closest('.recap-plan-head')?.querySelector('.recap-plan-line')?.textContent).toBe(PICTURE.plan);
    const body = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(body.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    expect(screen.getByRole('list', { name: 'Plan items' }).tagName).toBe('OL');
    expect(planItems()).toEqual([
      ['#42: the 32-bit size field fix', 'Now'],
      ['The archive job reuses it', 'Next'],
      ['The old 2 GB guard', 'Dropped'],
      ['#40: the reader', 'Done'],
    ]);
    const tags = [...document.querySelectorAll('.recap-plan-state')].map((tag) => tag.className);
    expect(tags[0]).toContain('badge-subtle-info');
    expect(tags[1]).toContain('badge-subtle-neutral');
    expect(tags[2]).toContain('badge-outline');
    expect(tags[3]).toContain('badge-subtle-success');
    expect(document.querySelector('.recap-plan-changes')).toBeNull();
    expect(window.localStorage.getItem(RECAP_PLAN_COLLAPSED_KEY)).toBe('false');
  });

  it('shows how the plan changed, once open, when it did', async () => {
    const recap = pictured({ planItems: ITEMS, planChanges: 'The old 2 GB guard was dropped: the fix replaces it.' });
    renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    expect(document.querySelector<HTMLElement>('.recap-plan-changes')?.closest<HTMLElement>('[hidden]')).not.toBeNull();
    fireEvent.click(planToggle()!);
    expect(document.querySelector('.recap-plan-changes')?.textContent).toBe('Changes: The old 2 GB guard was dropped: the fix replaces it.');
  });

  it("remembers the Plan section's choice apart from the strip's, and reads anything but \"false\" as collapsed", async () => {
    const recap = pictured({ planItems: ITEMS });
    const view = renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    fireEvent.click(planToggle()!);
    expect(window.localStorage.getItem(RECAP_PLAN_COLLAPSED_KEY)).toBe('false');
    expect(window.localStorage.getItem(RECAP_COLLAPSED_KEY)).toBeNull();
    view.unmount();
    const again = renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    expect(planToggle()?.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(planToggle()!);
    expect(window.localStorage.getItem(RECAP_PLAN_COLLAPSED_KEY)).toBe('true');
    again.unmount();
    window.localStorage.setItem(RECAP_PLAN_COLLAPSED_KEY, 'open');
    renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    expect(planToggle()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('hides the Plan section with the rest of the body while the strip is collapsed', async () => {
    window.localStorage.setItem(RECAP_COLLAPSED_KEY, 'true');
    window.localStorage.setItem(RECAP_PLAN_COLLAPSED_KEY, 'false');
    const recap = pictured({ planItems: ITEMS });
    renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    expect(line('plan')?.closest<HTMLElement>('.recap-body')?.hidden).toBe(true);
  });

  it("shows a recap without the picture, and Claude Code's, as their summary, with no plan", async () => {
    const claude = full({ source: 'claude-code', todos: [], title: '', waitingOn: 'nothing', summary: 'The made-up fix is in #42.', ...PICTURE });
    renderStrip({ session: target(claude) }, fakeApi({ recap: claude }).api);
    await settle();
    expect(strip()?.dataset.picture).toBeUndefined();
    expect(summaryText()).toBe('The made-up fix is in #42.');
    expect(document.querySelector('.recap-plan')).toBeNull();
    expect(document.querySelector('.recap-line')).toBeNull();
  });

  it('reads the picture defensively: all three as text, or none', () => {
    const body = { ...full(), ...PICTURE };
    expect(parseRecap(body)).toMatchObject(PICTURE);
    expect(parseRecap({ ...body, plan: undefined })).not.toHaveProperty('goal');
    expect(parseRecap({ ...body, goal: 3 })).toBeUndefined();
    expect(parseRecap({ ...body, workingOn: 'x'.repeat(500) })?.workingOn?.length).toBeLessThanOrEqual(400);
    // W189's done: kept with the picture, cut the same way; not text, no recap.
    expect(parseRecap({ ...body, done: 'd'.repeat(500) })?.done?.length).toBeLessThanOrEqual(400);
    expect(parseRecap({ ...body, done: 3 })).toBeUndefined();
    expect(parseRecap({ ...body, done: undefined })).not.toHaveProperty('done');
    expect(parseRecap({ ...body, plan: undefined })).not.toHaveProperty('done');
  });

  it("reads the plan's items and changes defensively (W172)", () => {
    const body = { ...full(), ...PICTURE, planItems: ITEMS, planChanges: 'It changed.' };
    expect(parseRecap(body)).toMatchObject({ planItems: ITEMS, planChanges: 'It changed.' });
    expect(parseRecap({ ...body, planItems: [{ text: 'x', state: 'blocked' }] })).toBeUndefined();
    expect(parseRecap({ ...body, planItems: [{ text: 'x', state: 'now', owner: 'you' }] })).toBeUndefined();
    expect(parseRecap({ ...body, planItems: 'x' })).toBeUndefined();
    expect(parseRecap({ ...body, planChanges: 3 })).toBeUndefined();
    expect(parseRecap({ ...body, planItems: Array.from({ length: 20 }, () => ITEMS[0]) })?.planItems).toHaveLength(15);
    expect(parseRecap({ ...body, planItems: [{ text: 'y'.repeat(300), state: 'now' }] })?.planItems?.[0]?.text.length).toBeLessThanOrEqual(200);
    // Without the picture's three, none of it.
    expect(parseRecap({ ...body, plan: undefined })).not.toHaveProperty('planItems');
  });
});
