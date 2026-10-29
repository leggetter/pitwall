// The working line in the session view (W102; docs/design-system.md, 4: Conversation): while the
// session works, "Working", the time since its turn began and the step; while it waits on you, that
// and where to answer; gone as the turn ends, and never for an ended session. Its status region says
// "Claude is working", "Finished" or the waiting text once each. The newest page is fetched every 2 s
// while it works and the Conversation tab is shown, and stops when it's idle, hidden or closed.
// Made-up sessions and conversations only.

import { act, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEntry, ConversationPage, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { AttachContext } from '../attach.js';
import { fakeSockets, NOW, minutesAgo, session, withoutSubagents } from '../test/fixtures.js';
import { FINISHED_ANNOUNCEMENT, WORKING_ANNOUNCEMENT, WORKING_POLL_MS } from '../working.js';
import { SessionView } from './SessionView.js';

const SID = '00000000-0000-4000-8000-0000000000d2';
const API_KEY = 'k'.repeat(43);
const CWD = '/Users/example/code/demo-app';
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const you = (seconds: number, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({ kind: 'user', at: ago(seconds), text: `prompt ${seconds}`, ...extra });
const claude = (seconds: number): ConversationEntry => ({ kind: 'assistant', at: ago(seconds), text: `reply ${seconds}`, markdown: true });
const call = (seconds: number, text: string, result?: 'ok' | 'error'): ConversationEntry => ({
  kind: 'tool',
  at: ago(seconds),
  text,
  toolName: text.split(':')[0] ?? text,
  ...(result === undefined ? {} : { toolError: result === 'error' }),
});

/** A fake server whose newest page the test sets as it goes, counting each time it's asked for. */
function fakeServer(first: Omit<ConversationPage, 'sessionId'>) {
  let newest: ConversationPage = { sessionId: SID, ...first };
  let asked = 0;
  const fetch = vi.fn<FetchLike>(async (url) => {
    if (url.includes('/conversation')) asked += 1;
    return new Response(JSON.stringify(newest), { status: 200 });
  });
  return {
    fetch: withoutSubagents(fetch),
    get asked() {
      return asked;
    },
    newest(next: Omit<ConversationPage, 'sessionId'>) {
      newest = { sessionId: SID, ...next };
    },
  };
}

const flush = () => act(async () => {});
/** Moves the fake clock on, running the timers it passes and the fetches they start. */
const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

/** The session view alone; with `attach`, where pitwall can attach, so a background session's Terminal tab opens. */
function renderView(server: ReturnType<typeof fakeServer>, overrides: Partial<SessionSummary>, props: { listed?: boolean; hidden?: boolean; attach?: boolean } = {}) {
  const api = createApiClient({ apiKey: API_KEY, fetch: server.fetch });
  const env = props.attach === true ? { token: 'pitwall-test-token', host: '127.0.0.1:4517', createSocket: fakeSockets().factory } : undefined;
  let current = session({ sessionId: SID, name: 'pitwall-test-working', cwd: CWD, lastActivityAt: minutesAgo(1), ...overrides });
  let { listed = true, hidden = false } = props;
  const ui = () => (
    <ApiContext.Provider value={api}>
      <AttachContext.Provider value={env}>
        <SessionView session={current} listed={listed} hidden={hidden} onClose={() => {}} />
      </AttachContext.Provider>
    </ApiContext.Provider>
  );
  const result = render(ui());
  const panel = () => result.container.querySelector<HTMLElement>('.session-view-body')!;
  return {
    ...result,
    line: () => panel().querySelector<HTMLElement>('.working-line'),
    status: () => panel().querySelector('.working-status')?.textContent ?? null,
    step: () => panel().querySelector('.working-step')?.textContent ?? null,
    where: () => panel().querySelector('.working-where')?.textContent ?? null,
    announced: () => panel().querySelector('.working-announcer')?.textContent ?? null,
    async update(next: Partial<SessionSummary>, nextProps: { listed?: boolean; hidden?: boolean } = {}) {
      current = { ...current, ...next };
      for (const key of Object.keys(next) as (keyof SessionSummary)[]) if (next[key] === undefined) delete current[key];
      listed = nextProps.listed ?? listed;
      hidden = nextProps.hidden ?? hidden;
      result.rerender(ui());
      await flush();
    },
  };
}

const WORKING: Partial<SessionSummary> = { status: 'busy' };
const IDLE: Partial<SessionSummary> = { status: 'idle' };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Working line: while the session works', () => {
  it('shows Working, the time since the prompt that began the turn, and the open call, after the newest entry', async () => {
    const server = fakeServer({ entries: [you(300), claude(299), you(134), claude(130), call(120, 'Bash: npm test')] });
    const view = renderView(server, WORKING);
    await flush();
    expect(view.status()).toBe('Working · 2m 14s');
    expect(view.step()).toBe('Running Bash: npm test');
    // After the newest entry.
    expect(view.line()?.previousElementSibling?.matches('ol.conversation')).toBe(true);
    // The time is hidden from screen readers, which hear "Working" and the step.
    expect(view.container.querySelector('.working-time')?.getAttribute('aria-hidden')).toBe('true');
    await pass(1_000);
    expect(view.status()).toBe('Working · 2m 15s');
  });

  it('keeps counting from the prompt that began the turn when you type another mid-turn (W99)', async () => {
    const server = fakeServer({ entries: [you(200), call(190, 'Bash: npm test', 'ok'), you(30, { midTurn: true }), call(20, `Edit: ${CWD}/src/app.ts`)] });
    const view = renderView(server, WORKING);
    await flush();
    expect(view.status()).toBe('Working · 3m 20s');
    expect(view.step()).toBe('Editing src/app.ts');
  });

  it('says Thinking while no call waits on its result', async () => {
    const view = renderView(fakeServer({ entries: [you(5)] }), WORKING);
    await flush();
    expect(view.step()).toBe('Thinking');
  });

  it('shows the spinner, or under reduced motion a steady dot in its place, so nothing spins', async () => {
    const server = fakeServer({ entries: [you(5)] });
    const moving = renderView(server, WORKING);
    await flush();
    expect(moving.line()?.querySelector('.spinner')).not.toBeNull();
    expect(moving.line()?.querySelector('.working-dot')).toBeNull();
    moving.unmount();
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query }) as MediaQueryList);
    const steady = renderView(server, WORKING);
    await flush();
    expect(steady.line()?.querySelector('.spinner')).toBeNull();
    expect(steady.line()?.querySelector('.working-dot')).not.toBeNull();
  });

  it('isn’t there when the newest page says the turn has ended, though Claude Code says busy, as with a plugin’s monitor', async () => {
    const server = fakeServer({ entries: [you(60), claude(50)], turnEnded: true });
    const view = renderView(server, WORKING);
    await flush();
    expect(view.line()).toBeNull();
    // And nothing is fetched until the activity moves.
    const asked = server.asked;
    await pass(3 * WORKING_POLL_MS);
    expect(server.asked).toBe(asked);
  });
});

describe('Working line: waiting on you', () => {
  it('says what for, and where to answer, with no time and no spinner: an interactive session in its terminal', async () => {
    const view = renderView(fakeServer({ entries: [you(60), call(50, 'Bash: rm -rf build')] }), { status: 'waiting', waitingFor: 'permission prompt' });
    await flush();
    expect(view.status()).toBe('Waiting for you: permission prompt');
    expect(view.where()).toBe('Answer it in its terminal.');
    expect(view.line()?.querySelector('.working-time, .spinner, .working-step')).toBeNull();
  });

  it('a background session in its Terminal tab, or nowhere it can say where pitwall can’t attach', async () => {
    const job: Partial<SessionSummary> = { kind: 'background', shortId: 'pt102a', status: 'waiting', state: 'blocked', waitingFor: 'input needed' };
    const view = renderView(fakeServer({ entries: [you(60)] }), job, { attach: true });
    await flush();
    expect(view.status()).toBe('Waiting for you: input needed');
    expect(view.where()).toBe('Answer it in its Terminal tab.');
    view.unmount();
    const unattachable = renderView(fakeServer({ entries: [you(60)] }), job);
    await flush();
    expect(unattachable.where()).toBeNull();
  });
});

describe('Working line: ending', () => {
  it('goes when the turn ends, and never shows for an ended session', async () => {
    const server = fakeServer({ entries: [you(60), call(50, 'Bash: npm test')] });
    const view = renderView(server, WORKING);
    await flush();
    expect(view.line()).not.toBeNull();
    server.newest({ entries: [you(60), call(50, 'Bash: npm test', 'ok'), claude(1)], turnEnded: true });
    await view.update({ ...IDLE, lastActivityAt: ago(1) });
    expect(view.line()).toBeNull();
    view.unmount();

    const ended = renderView(fakeServer({ entries: [you(60), call(50, 'Bash: npm test')] }), { ended: true, finished: true, alive: false, pid: undefined, status: undefined });
    await flush();
    expect(ended.line()).toBeNull();
  });

  it('goes once the session is no longer listed, without saying it finished', async () => {
    const view = renderView(fakeServer({ entries: [you(60)] }), WORKING);
    await flush();
    await view.update({}, { listed: false });
    expect(view.line()).toBeNull();
    expect(view.announced()).toBe('');
  });
});

describe('Working line: announcements', () => {
  it('says nothing for the state the view opened in, then each change once: working, waiting, finished', async () => {
    const server = fakeServer({ entries: [you(60)] });
    const view = renderView(server, IDLE);
    await flush();
    expect(view.announced()).toBe('');

    server.newest({ entries: [you(5), call(4, 'Bash: npm test')], turnEnded: false });
    await view.update({ ...WORKING, lastActivityAt: ago(4) });
    expect(view.announced()).toBe(WORKING_ANNOUNCEMENT);

    // The timer and the step change; what it said doesn't.
    server.newest({ entries: [you(5), call(4, 'Bash: npm test', 'ok'), call(2, 'Bash: npm run lint')], turnEnded: false });
    await pass(WORKING_POLL_MS);
    expect(view.step()).toBe('Running Bash: npm run lint');
    expect(view.announced()).toBe(WORKING_ANNOUNCEMENT);

    await view.update({ status: 'waiting', waitingFor: 'permission prompt', needsYou: { reason: 'prompt' } });
    expect(view.announced()).toBe('Waiting for you: permission prompt. Answer it in its terminal.');

    await view.update({ ...WORKING, waitingFor: undefined, needsYou: undefined });
    expect(view.announced()).toBe(WORKING_ANNOUNCEMENT);

    server.newest({ entries: [you(5), claude(1)], turnEnded: true });
    await view.update({ ...IDLE, lastActivityAt: ago(1) });
    expect(view.announced()).toBe(FINISHED_ANNOUNCEMENT);
  });

  it('says nothing for a working session it opens on, as j or k steps onto one, nor once the page says its turn had ended', async () => {
    const working = renderView(fakeServer({ entries: [you(60)] }), WORKING);
    await flush();
    expect(working.line()).not.toBeNull();
    expect(working.announced()).toBe('');
    working.unmount();

    // Claude Code says busy, but the first page says the turn has ended: no "Finished".
    const monitored = renderView(fakeServer({ entries: [you(60), claude(50)], turnEnded: true }), WORKING);
    await flush();
    expect(monitored.announced()).toBe('');
  });

  it('is one polite status region, apart from the count of new entries', async () => {
    const view = renderView(fakeServer({ entries: [you(60)] }), WORKING);
    await flush();
    const regions = [...view.container.querySelectorAll('.session-view-body [role="status"].visually-hidden')];
    expect(regions).toHaveLength(2);
    expect(regions[1]?.classList.contains('working-announcer')).toBe(true);
  });
});

describe('Working line: fetching while it works', () => {
  it('fetches the newest page every 2 s while it works and the Conversation tab is shown, one at a time', async () => {
    const server = fakeServer({ entries: [you(60), call(50, 'Bash: npm test')] });
    renderView(server, WORKING);
    await flush();
    expect(server.asked).toBe(1);
    await pass(WORKING_POLL_MS - 1);
    expect(server.asked).toBe(1);
    await pass(1);
    expect(server.asked).toBe(2);
    await pass(WORKING_POLL_MS);
    expect(server.asked).toBe(3);
  });

  it('stops behind the Terminal tab, and starts again on Conversation', async () => {
    const server = fakeServer({ entries: [you(60), call(50, 'Bash: npm test')] });
    const view = renderView(server, { kind: 'background', shortId: 'pt102b', status: undefined, state: 'working' }, { attach: true });
    await flush();
    expect(server.asked).toBe(1);
    const tabs = within(view.container.querySelector<HTMLElement>('[role="tablist"]')!);
    await act(async () => void fireEvent.click(tabs.getByRole('tab', { name: /Terminal/ })));
    await pass(3 * WORKING_POLL_MS);
    expect(server.asked).toBe(1);
    await act(async () => void fireEvent.click(tabs.getByRole('tab', { name: /Conversation/ })));
    await pass(WORKING_POLL_MS);
    expect(server.asked).toBe(2);
  });

  it('never fetches by itself for an idle session', async () => {
    const server = fakeServer({ entries: [you(60), claude(50)] });
    renderView(server, IDLE);
    await flush();
    await pass(5 * WORKING_POLL_MS);
    expect(server.asked).toBe(1);
  });

  it('stops when the turn ends, while the view is hidden, while the browser tab is hidden, and when it closes', async () => {
    const server = fakeServer({ entries: [you(60), call(50, 'Bash: npm test')] });
    const view = renderView(server, WORKING);
    await flush();
    await pass(WORKING_POLL_MS);
    expect(server.asked).toBe(2);

    // Hidden with its root tab (W38).
    await view.update({}, { hidden: true });
    await pass(3 * WORKING_POLL_MS);
    expect(server.asked).toBe(2);
    await view.update({}, { hidden: false });
    await pass(WORKING_POLL_MS);
    expect(server.asked).toBe(3);

    // The browser tab hidden: nothing; shown again: at once, then every 2 s.
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await pass(3 * WORKING_POLL_MS);
    expect(server.asked).toBe(3);
    visibility.mockReturnValue('visible');
    await act(async () => void document.dispatchEvent(new Event('visibilitychange')));
    await flush();
    expect(server.asked).toBe(4);
    await pass(WORKING_POLL_MS);
    expect(server.asked).toBe(5);

    // The turn ends: the page says so, and nothing more is fetched by itself.
    server.newest({ entries: [you(60), call(50, 'Bash: npm test', 'ok'), claude(1)], turnEnded: true });
    await pass(WORKING_POLL_MS);
    expect(server.asked).toBe(6);
    expect(view.line()).toBeNull();
    await pass(3 * WORKING_POLL_MS);
    expect(server.asked).toBe(6);

    // Closed.
    server.newest({ entries: [you(1)], turnEnded: false });
    await view.update({ lastActivityAt: ago(0) });
    expect(server.asked).toBe(7);
    view.unmount();
    await pass(3 * WORKING_POLL_MS);
    expect(server.asked).toBe(7);
  });

  it('never asks again while a fetch is still out', async () => {
    let release = () => {};
    let asked = 0;
    const page: ConversationPage = { sessionId: SID, entries: [you(60), call(50, 'Bash: npm test')] };
    const fetch = withoutSubagents(async (url) => {
      if (url.includes('/conversation')) asked += 1;
      if (asked >= 2) await new Promise<void>((resolve) => (release = resolve));
      return new Response(JSON.stringify(page), { status: 200 });
    });
    const api = createApiClient({ apiKey: API_KEY, fetch });
    render(
      <ApiContext.Provider value={api}>
        <SessionView session={session({ sessionId: SID, cwd: CWD, ...WORKING })} listed onClose={() => {}} />
      </ApiContext.Provider>,
    );
    await flush();
    await pass(WORKING_POLL_MS);
    expect(asked).toBe(2);
    await pass(5 * WORKING_POLL_MS);
    expect(asked).toBe(2);
    await act(async () => release());
    await pass(WORKING_POLL_MS);
    expect(asked).toBe(3);
  });
});
