// The recap strip (M5, W111; docs/design-system.md, 4: Recap strip): when it shows, what it fetches
// and when, the one request for a new recap as a view opens on a stale recap or none, never in a
// loop, the headline by what it waits on, the lines under it, collapsed and open, Refresh and its
// answers, and its loading and failed states. Made-up sessions and recaps only.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECAP_DAILY_BUDGET, recapPath, recapRefreshPath, type RecapHealth, type RecapSummary, type SessionRecap, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, type ApiClient, type ApiResult } from '../api.js';
import { RECAP_COLLAPSED_KEY, RECAP_WAIT_MS, RECAPS_OFF_TEXT, budgetText, refreshRecapFailedText } from '../recap.js';
import { minutesAgo, session } from '../test/fixtures.js';
import { RecapStrip, STALE_LABEL } from './RecapStrip.js';
import { SessionView } from './SessionView.js';
import { ToastContext, type ShowToast } from './Toast.js';

const SID = '00000000-0000-4000-8000-000000000111';
const HEALTH: RecapHealth = { calls: 12, budget: RECAP_DAILY_BUDGET, costUsd: 0.01 };
const SPENT: RecapHealth = { calls: RECAP_DAILY_BUDGET, budget: RECAP_DAILY_BUDGET, costUsd: 0.2 };

function full(extra: Partial<SessionRecap> = {}): SessionRecap {
  return {
    why: 'You asked it to fix the made-up export on large files.',
    now: 'It opened draft PR #42 with a fix and a test.',
    next: 'Say whether to mark #42 ready.',
    waitingOn: 'you',
    title: 'Fix the made-up export',
    at: minutesAgo(4),
    throughAt: minutesAgo(5),
    source: 'pitwall',
    ...extra,
  };
}

function summaryOf(recap: SessionRecap): RecapSummary {
  return {
    waitingOn: recap.waitingOn,
    title: recap.title,
    at: recap.at,
    source: recap.source,
    ...(recap.waitingOn === 'you' ? { next: recap.next } : {}),
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

function renderStrip(props: { session: SessionSummary; health?: RecapHealth | undefined; listed?: boolean; hidden?: boolean }, api: ApiClient, toast: ShowToast = vi.fn()) {
  const ui = (next: typeof props) => (
    <ToastContext.Provider value={toast}>
      <ApiContext.Provider value={api}>
        <RecapStrip session={next.session} health={'health' in next ? next.health : HEALTH} listed={next.listed ?? true} hidden={next.hidden ?? false} />
      </ApiContext.Provider>
    </ToastContext.Provider>
  );
  const view = render(ui(props));
  return { ...view, update: (next: typeof props) => view.rerender(ui(next)) };
}

const strip = () => document.querySelector<HTMLElement>('.session-recap');
const toggle = () => document.querySelector<HTMLButtonElement>('.recap-toggle');
const refreshButton = () => document.querySelector<HTMLButtonElement>('[data-recap-refresh]');
const headline = () => document.querySelector('.recap-headline')?.textContent;
const lines = () => [...document.querySelectorAll('.recap-line')].map((line) => [line.querySelector('dt')?.textContent, line.querySelector('dd')?.textContent]);

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

  it('has none for an ended session, which pitwall never recaps', async () => {
    const server = fakeApi();
    renderStrip({ session: target(undefined, { ended: true, finished: true, alive: false }) }, server.api);
    await pastAskDelay();
    expect(strip()).toBeNull();
    expect(server.post).not.toHaveBeenCalled();
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
    const second = full({ at: minutesAgo(0.5), now: 'It marked #42 ready.' });
    server.setRecap(second);
    view.update({ session: target(second) });
    await settle();
    expect(server.get).toHaveBeenCalledTimes(2);
    expect(lines()).toContainEqual(['Now', 'It marked #42 ready.']);
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
    view.update({ session: target(undefined), health: { ...HEALTH, calls: HEALTH.calls + 1, error: 'Made up: claude -p exited with code 1' } });
    await settle();
    expect(strip()?.dataset.recap).toBe('none');
    expect(strip()?.textContent).toContain('No recap yet. The latest recap failed: Made up: claude -p exited with code 1.');
  });
});

describe('the headline and the lines', () => {
  async function shown(recap: SessionRecap) {
    const server = fakeApi({ recap });
    const view = renderStrip({ session: target(recap) }, server.api);
    await settle();
    return view;
  }

  it('says what you need to do, then Why and Now, while it waits on you', async () => {
    await shown(full());
    expect(headline()).toBe('You need to: Say whether to mark #42 ready.');
    expect(document.querySelector('.recap-label')?.className).toContain('badge-subtle-warning');
    expect(lines()).toEqual([
      ['Why', 'You asked it to fix the made-up export on large files.'],
      ['Now', 'It opened draft PR #42 with a fix and a test.'],
    ]);
  });

  it('says what it waits on, quietly, for CI, another session or someone else', async () => {
    for (const [waitingOn, label] of [
      ['CI', 'Waiting on CI'],
      ['another session', 'Waiting on another session'],
      ['someone else', 'Waiting on someone else'],
    ] as const) {
      const view = await shown(full({ waitingOn, next: 'It waits for the made-up run.' }));
      expect(headline()).toBe(`${label}: It waits for the made-up run.`);
      expect(document.querySelector('.recap-label')?.className).toContain('badge-subtle-neutral');
      expect(lines().map(([name]) => name)).toEqual(['Why', 'Now']);
      view.unmount();
    }
  });

  it('says it is done with where it is, then Why, and Next only when there is one', async () => {
    await shown(full({ waitingOn: 'nothing', next: '' }));
    expect(headline()).toBe('Done: It opened draft PR #42 with a fix and a test.');
    expect(document.querySelector('.recap-label')?.className).toContain('badge-subtle-success');
    expect(lines().map(([name]) => name)).toEqual(['Why']);
  });

  it('shows Claude Code’s recap, which says only where it is, with nothing to open', async () => {
    await shown(full({ source: 'claude-code', why: '', next: '', waitingOn: 'nothing', now: 'The made-up fix is in #42.' }));
    expect(screen.getByRole('heading', { name: "Claude Code's recap" })).toBeTruthy();
    expect(headline()).toBe('Now: The made-up fix is in #42.');
    expect(toggle()).toBeNull();
    expect(lines()).toEqual([]);
  });

  it('says a stale recap may be out of date, first', async () => {
    const stale = full({ stale: true });
    const server = fakeApi({ recap: stale, posts: ['pending'] });
    renderStrip({ session: target(stale) }, server.api);
    await settle();
    expect(headline()).toBe(`${STALE_LABEL}. You need to: Say whether to mark #42 ready.`);
  });

  it('shows the recap’s text as text, and its age', async () => {
    await shown(full({ why: '<b>not bold</b>\u001b[31m', next: '**not bold**' }));
    expect(lines()[0]).toEqual(['Why', '<b>not bold</b>']);
    expect(document.querySelector('.recap-line b')).toBeNull();
    expect(headline()).toBe('You need to: **not bold**');
    expect(document.querySelector('.recap-age')?.getAttribute('datetime')).toBe(full().at);
  });

  it('is a region named by its heading, with no live region', async () => {
    await shown(full());
    expect(screen.getByRole('region', { name: 'Recap' })).toBe(strip());
    expect(strip()?.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });
});

describe('collapsed', () => {
  it('keeps the headline alone, and remembers the choice as a boolean', async () => {
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
    expect(headline()).toBe('You need to: Say whether to mark #42 ready.');
    expect(window.localStorage.getItem(RECAP_COLLAPSED_KEY)).toBe('true');
    // Another view, opened later, starts collapsed.
    view.unmount();
    renderStrip({ session: target(recap) }, fakeApi({ recap }).api);
    await settle();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle()!);
    expect(window.localStorage.getItem(RECAP_COLLAPSED_KEY)).toBe('false');
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
  it('shows the headline from the snapshot while the recap is on its way, when it waits on you', async () => {
    const recap = full();
    renderStrip({ session: target(recap) }, fakeApi({ recap: 'pending' }).api);
    await settle();
    expect(strip()?.dataset.recap).toBe('loading');
    expect(headline()).toBe('You need to: Say whether to mark #42 ready.');
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
  });
});
