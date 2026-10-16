import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { removePath, stopPath, type IndexSnapshot, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import type { ConnectionView } from '../connection.js';
import { group, NOW, session, snapshot } from '../test/fixtures.js';
import { Dashboard } from './Dashboard.js';

// Made-up sessions only.

const API_KEY = 'k'.repeat(43);
const BG = '00000000-0000-4000-8000-0000000000b1';
const INTERACTIVE = '00000000-0000-4000-8000-0000000000a1';

const STOP_TEXT = 'Stops the session; its conversation is kept, and attaching restarts it.';
const REMOVE_TEXT = 'Removes it from the list. Claude Code keeps a worktree that has unpushed commits.';

function background(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return session({ sessionId: BG, name: 'pitwall-test-bg', kind: 'background', shortId: 'b3899da0', state: 'working', ...overrides });
}

function snap(bg: SessionSummary = background()): IndexSnapshot {
  return snapshot([group({ sessions: [bg, session({ sessionId: INTERACTIVE, name: 'pitwall-test-interactive' })] })]);
}

type Answer = { status: number; body?: unknown };

/** POSTs get the next answer; GETs (the conversation) get an empty page. */
function fakeServer(...answers: Answer[]) {
  let call = 0;
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method !== 'POST') {
      const sessionId = decodeURIComponent(/\/api\/sessions\/([^/]+)\//.exec(url)?.[1] ?? '');
      return new Response(JSON.stringify({ sessionId, entries: [] }), { status: 200 });
    }
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (!answer) throw new Error('no answer');
    return new Response(answer.body === undefined ? 'not json' : JSON.stringify(answer.body), { status: answer.status });
  });
}

const postedUrls = (fetch: ReturnType<typeof fakeServer>) => fetch.mock.calls.filter(([, init]) => init.method === 'POST').map(([url]) => url);

function renderDashboard(fetch: FetchLike | undefined, first: IndexSnapshot = snap()) {
  const api = fetch ? createApiClient({ apiKey: API_KEY, fetch }) : undefined;
  const ui = (s: IndexSnapshot) => {
    const view: ConnectionView = { state: 'live', snapshot: s };
    return (
      <ApiContext.Provider value={api}>
        <Dashboard view={view} />
      </ApiContext.Provider>
    );
  };
  const result = render(ui(first));
  for (const toggle of result.container.querySelectorAll<HTMLElement>('.group-toggle[aria-expanded="false"]')) fireEvent.click(toggle);
  return { ...result, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

const settle = () => act(async () => {});

async function openView(name: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name }));
  await settle();
  return screen.getByRole('dialog', { name });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('Stop and Remove', () => {
  it('are offered for a background session, and not for an interactive one, which keeps its note', async () => {
    renderDashboard(fakeServer({ status: 200, body: { ok: true } }));
    const bg = await openView('pitwall-test-bg');
    expect(within(bg).getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(within(bg).getByRole('button', { name: 'Remove' })).toBeTruthy();

    const interactive = await openView('pitwall-test-interactive');
    expect(within(interactive).queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(within(interactive).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(within(interactive).getByText(/moves it to the background/)).toBeTruthy();
  });

  it('asks before stopping, and Cancel or Escape leaves the session alone and the view open', async () => {
    const server = fakeServer({ status: 200, body: { ok: true } });
    renderDashboard(server);
    const view = await openView('pitwall-test-bg');

    fireEvent.click(within(view).getByRole('button', { name: 'Stop' }));
    const confirm = within(view).getByRole('group', { name: STOP_TEXT });
    expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(within(view).queryByRole('group')).toBeNull();

    fireEvent.click(within(view).getByRole('button', { name: 'Stop' }));
    fireEvent.keyDown(within(view).getByRole('button', { name: 'Stop session' }), { key: 'Escape' });
    expect(within(view).queryByRole('group')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'pitwall-test-bg' })).toBe(view);
    expect(postedUrls(server)).toEqual([]);
  });

  it('stops the session once confirmed, and says so', async () => {
    const server = fakeServer({ status: 200, body: { ok: true } });
    renderDashboard(server);
    const view = await openView('pitwall-test-bg');
    fireEvent.click(within(view).getByRole('button', { name: 'Stop' }));
    fireEvent.click(within(view).getByRole('button', { name: 'Stop session' }));
    await settle();

    expect(postedUrls(server)).toEqual([stopPath(BG)]);
    const call = server.mock.calls.find(([, init]) => init.method === 'POST');
    expect((call?.[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(within(view).getByRole('status').textContent).toBe('Stopped. Its conversation is kept.');
  });

  it("can't stop a session that isn't running, but can remove it", async () => {
    renderDashboard(fakeServer({ status: 200, body: { ok: true } }), snap(background({ alive: false, state: 'stopped', pid: undefined })));
    const view = await openView('pitwall-test-bg');
    const stop = within(view).getByRole('button', { name: 'Stop' }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    expect(stop.title).toMatch(/isn't running/);
    expect((within(view).getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('asks before removing, then removes the session and closes its view', async () => {
    const server = fakeServer({ status: 200, body: { ok: true } });
    renderDashboard(server);
    const view = await openView('pitwall-test-bg');
    fireEvent.click(within(view).getByRole('button', { name: 'Remove' }));
    expect(within(view).getByRole('group', { name: REMOVE_TEXT })).toBeTruthy();
    fireEvent.click(within(view).getByRole('button', { name: 'Remove session' }));
    await settle();

    expect(postedUrls(server)).toEqual([removePath(BG)]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("shows Claude Code's message when it refuses, and keeps the view open", async () => {
    const refusal = "Kept the worktree pitwall-test-wt: it has 2 unpushed commits.\nTo discard them, run 'claude rm b3899da0 --discard-unpushed 1a2b3c@pitwall-test-wt'.";
    renderDashboard(fakeServer({ status: 409, body: { ok: false, error: refusal } }, { status: 502 }));
    const view = await openView('pitwall-test-bg');
    fireEvent.click(within(view).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(view).getByRole('button', { name: 'Remove session' }));
    await settle();

    expect(within(view).getByRole('alert').textContent).toBe(refusal);
    expect(screen.getByRole('dialog', { name: 'pitwall-test-bg' })).toBe(view);

    fireEvent.click(within(view).getByRole('button', { name: 'Stop' }));
    fireEvent.click(within(view).getByRole('button', { name: 'Stop session' }));
    await settle();
    expect(within(view).getByRole('alert').textContent).toBe("Couldn't stop the session (HTTP 502).");
  });

  it('shows the action in progress and allows nothing else meanwhile', async () => {
    let answer: (response: Response) => void = () => {};
    const server = vi.fn<FetchLike>(async (_url, init) =>
      init.method === 'POST'
        ? new Promise<Response>((resolve) => (answer = resolve))
        : new Response(JSON.stringify({ sessionId: BG, entries: [] }), { status: 200 }),
    );
    renderDashboard(server);
    const view = await openView('pitwall-test-bg');
    fireEvent.click(within(view).getByRole('button', { name: 'Stop' }));
    fireEvent.click(within(view).getByRole('button', { name: 'Stop session' }));
    await settle();
    expect((within(view).getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(view).getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(true);
    answer(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await settle();
    expect(within(view).getByRole('button', { name: 'Stop' })).toBeTruthy();
  });

  it('are not offered once the session is no longer listed', async () => {
    const { update } = renderDashboard(fakeServer({ status: 200, body: { ok: true } }));
    const view = await openView('pitwall-test-bg');
    update(snapshot([group({ sessions: [session({ sessionId: INTERACTIVE, name: 'pitwall-test-interactive' })] })]));
    await settle();
    expect(within(view).queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(within(view).getByText(/no longer listed/)).toBeTruthy();
  });
});
