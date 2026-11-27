// Clear and continue (W168; spinOff.ts, SpinOffCards.tsx): a hand-off's card for a running background job
// offers Clear and continue, with Start new session… beside it; an interactive session's offers Start and
// End session…. Nothing is sent until a click. Made-up sessions and a fake server only.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAndContinuePath, continuedPath, endSessionPath, SPAWN_PATH, spinOffPath, spinOffSettlePath, type IndexSnapshot, type SessionSummary, type SpinOff } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { AttachContext, type AttachEnv } from '../attach.js';
import type { StorageSource } from '../groupState.js';
import { memoryNavigation } from '../selection.js';
import { statusBadge } from '../sessions.js';
import { clearedText, handoffTitle, SPIN_OFF_CLEAR_NOTE } from '../spinOff.js';
import { fakeSockets, group, NOW, session, snapshot } from '../test/fixtures.js';
import { toastMessages } from '../test/toasts.js';
import { AppShell } from './AppShell.js';
import type { TerminalHandle } from './Terminal.js';

class QuietTerminal implements TerminalHandle {
  cols = 80;
  rows = 24;
  write() {}
  onData() {}
  paste() {}
  fit() {}
  focus() {}
  dispose() {}
}
vi.mock('../xterm.js', () => ({ createXterm: () => new QuietTerminal() }));

const ROOT = '/Users/example/code';
const DEMO = `${ROOT}/demo-app`;
const KEY = '0123456789abcdef';
const ASKER_ID = '00000000-0000-4000-8000-000000168001';
const HANDOFF = `Continues session ${ASKER_ID}.\nRead NOW.md, then start the next item.`;
const proposal = (prompt: string): SpinOff => ({ kind: 'proposal', key: KEY, folder: DEMO, prompt });
const NEW_JOB = { shortId: 'cc168', name: 'next-item' } as const;

const asker = (kind: 'background' | 'interactive', spinOff: SpinOff): SessionSummary =>
  session({ sessionId: ASKER_ID, name: 'export-work', cwd: DEMO, kind, ...(kind === 'background' ? { shortId: 'ab168', state: 'done' as const } : {}), spinOff });

const snap = (kind: 'background' | 'interactive' = 'background', spinOff: SpinOff = proposal(HANDOFF)): IndexSnapshot =>
  snapshot([group({ key: DEMO, label: 'demo-app', root: ROOT, sessions: [asker(kind, spinOff)] })], { roots: [ROOT] });

function fakeServer(clear: [number, unknown] = [200, { ok: true, sessionId: '00000000-0000-4000-8000-000000168002' }]) {
  const posts: { url: string; body: unknown }[] = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    if (init.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === clearAndContinuePath(ASKER_ID)) return new Response(JSON.stringify(clear[1]), { status: clear[0] });
      if (url === spinOffPath(ASKER_ID)) return new Response(JSON.stringify({ ok: true, cwd: DEMO, prompt: HANDOFF }), { status: 200 });
      if (url === SPAWN_PATH) return new Response(JSON.stringify({ ok: true, ...NEW_JOB }), { status: 201 });
      if (url === continuedPath(ASKER_ID)) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.includes('/spin-off/settle')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({ ok: false, error: 'not in this test' }), { status: 409 });
    }
    return new Response(JSON.stringify({ sessionId: 'x', entries: [] }), { status: 200 });
  });
  return { fetch, posts: () => posts };
}

function memory(): StorageSource & { values: Map<string, string> } {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  return Object.assign(() => storage, { values });
}

function renderAppShell(server = fakeServer(), first: IndexSnapshot = snap(), storage = memory()) {
  const api = createApiClient({ apiKey: 'k'.repeat(43), fetch: server.fetch });
  const navigation = memoryNavigation('?view=needs-you');
  const attach: AttachEnv = { token: 'pitwall-test-token-0123456789abcdefghijklmnop', createSocket: fakeSockets().factory, host: '127.0.0.1:4517' };
  render(
    <ApiContext.Provider value={api}>
      <AttachContext.Provider value={attach}>
        <AppShell view={{ state: 'live', snapshot: first }} navigation={navigation} storage={storage} />
      </AttachContext.Provider>
    </ApiContext.Provider>,
  );
  return { storage };
}

const cards = () => [...document.querySelectorAll<HTMLElement>('li.spin-off-card')];
const card = () => cards()[0]!;
const buttons = () => [...card().querySelectorAll('button')].map((button) => button.textContent);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('a hand-off’s card', () => {
  it('for a running background job offers Clear and continue, with Start new session… and the prompt beside it, and sends nothing', () => {
    const server = fakeServer();
    renderAppShell(server);
    expect(buttons()).toEqual(expect.arrayContaining(['Clear and continue', 'Start new session…', 'Open session', 'Dismiss']));
    expect(card().querySelector('.approval-note')?.textContent).toBe(SPIN_OFF_CLEAR_NOTE);
    expect(card().querySelector('.approval-text')?.textContent).toBe(HANDOFF);
    expect(server.posts()).toEqual([]);
  });

  it('Clear and continue asks the server for the proposal by its key, then the card goes with a toast', async () => {
    const server = fakeServer();
    renderAppShell(server);
    fireEvent.click(within(card()).getByRole('button', { name: 'Clear and continue' }));
    await waitFor(() => expect(cards()).toEqual([]));
    expect(server.posts().filter((post) => post.url !== spinOffSettlePath(ASKER_ID))).toEqual([{ url: clearAndContinuePath(ASKER_ID), body: { key: KEY } }]);
    expect(toastMessages()).toContain(clearedText('export-work'));
    await waitFor(() => expect(server.posts().find((post) => post.url === spinOffSettlePath(ASKER_ID))?.body).toEqual({ key: KEY, how: 'dismissed' }));
  });

  it('keeps the card, says why and leaves Start new session… when Clear and continue fails', async () => {
    renderAppShell(fakeServer([504, { ok: false, error: 'The job didn’t list a new session id in time, so the prompt was not typed.' }]));
    fireEvent.click(within(card()).getByRole('button', { name: 'Clear and continue' }));
    await waitFor(() => expect(within(card()).queryByRole('alert')).not.toBeNull());
    expect(within(card()).getByRole('alert').textContent).toContain('the prompt was not typed.');
    expect(within(card()).getByRole('alert').textContent).toContain('Start new session…');
    expect(cards()).toHaveLength(1);
    expect(buttons()).toContain('Start new session…');
  });

  it('Start new session… opens New session, and starting it tells the server it continues the old one', async () => {
    const server = fakeServer();
    renderAppShell(server);
    fireEvent.click(within(card()).getByRole('button', { name: 'Start new session…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    expect(server.posts().some((post) => post.url === clearAndContinuePath(ASKER_ID))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(server.posts().some((post) => post.url === continuedPath(ASKER_ID))).toBe(true));
    expect(server.posts().find((post) => post.url === continuedPath(ASKER_ID))).toEqual({ url: continuedPath(ASKER_ID), body: { shortId: NEW_JOB.shortId } });
  });

  it('for an interactive session offers Start new session… and End session…, and ends nothing until confirmed', async () => {
    const server = fakeServer();
    renderAppShell(server, snap('interactive'));
    expect(buttons()).toEqual(expect.arrayContaining(['Start new session…', 'End session…']));
    expect(buttons()).not.toContain('Clear and continue');
    fireEvent.click(within(card()).getByRole('button', { name: 'End session…' }));
    expect(within(card()).getByText('End this session?')).toBeTruthy();
    expect(server.posts().some((post) => post.url === endSessionPath(ASKER_ID))).toBe(false);
    fireEvent.click(within(card()).getByRole('button', { name: 'Cancel' }));
    expect(server.posts()).toEqual([]);
  });

  it('a proposal that isn’t this session’s own hand-off gets Start… only', () => {
    renderAppShell(fakeServer(), snap('background', proposal('Fix the flaky export test.')));
    expect(buttons()).toContain('Start…');
    expect(buttons()).not.toContain('Clear and continue');
    expect(buttons()).not.toContain('End session…');
    cleanup();
    renderAppShell(fakeServer(), snap('background', proposal('Continues session 00000000-0000-4000-8000-000000000999.\nDo it.')));
    expect(buttons()).not.toContain('Clear and continue');
  });

  it('a hand-off whose prompt ends in a backslash is not offered Clear and continue', () => {
    renderAppShell(fakeServer(), snap('background', proposal(`${HANDOFF}\\`)));
    expect(buttons()).not.toContain('Clear and continue');
  });
});

describe('a hand-off written by hand, from the recap (W210)', () => {
  const RECAP_PROMPT = 'Read /Users/example/code/demo-app/NOW.md';
  const fromRecap = (): SpinOff => ({ kind: 'proposal', key: KEY, folder: DEMO, prompt: RECAP_PROMPT, source: 'recap' });

  it('shows the session as Handed off, not Done, and its card says it handed off to free up context', () => {
    const made = asker('background', fromRecap());
    expect(statusBadge(made)).toEqual({ status: 'handed-off', label: 'Handed off', look: 'subtle-warning' });
    expect(statusBadge({ ...made, spinOff: undefined })).toMatchObject({ status: 'done', label: 'Done' });
    expect(statusBadge({ ...made, state: 'failed' })).toMatchObject({ status: 'failed' });
    expect(statusBadge({ ...made, state: 'stopped' })).toMatchObject({ status: 'stopped' });
    expect(statusBadge({ ...made, ended: true })).toMatchObject({ status: 'ended' });
    // A block that starts with its own Continues line is Handed off too; another session's, or a plain spin-off, is not.
    expect(statusBadge(asker('background', proposal(HANDOFF))).status).toBe('handed-off');
    expect(statusBadge(asker('background', proposal('Fix the flaky export test.'))).status).toBe('done');
    renderAppShell(fakeServer(), snap('background', fromRecap()));
    expect(card().querySelector('h4')?.textContent).toBe(handoffTitle('export-work'));
  });

  it('offers Clear and continue with the prompt shown whole, and sends only the key', async () => {
    const server = fakeServer();
    renderAppShell(server, snap('background', fromRecap()));
    expect(buttons()).toEqual(expect.arrayContaining(['Clear and continue', 'Start new session…']));
    expect(card().querySelector('.approval-text')?.textContent).toBe(RECAP_PROMPT);
    fireEvent.click(within(card()).getByRole('button', { name: 'Clear and continue' }));
    await waitFor(() => expect(cards()).toEqual([]));
    expect(server.posts().filter((post) => post.url !== spinOffSettlePath(ASKER_ID))).toEqual([{ url: clearAndContinuePath(ASKER_ID), body: { key: KEY } }]);
  });

  it('for an interactive session offers Start new session… only beside End session…, and a trailing backslash gets no Clear and continue', () => {
    renderAppShell(fakeServer(), snap('interactive', fromRecap()));
    expect(buttons()).toEqual(expect.arrayContaining(['Start new session…', 'End session…']));
    expect(buttons()).not.toContain('Clear and continue');
    cleanup();
    renderAppShell(fakeServer(), snap('background', { kind: 'proposal', key: KEY, folder: DEMO, prompt: `${RECAP_PROMPT}\\`, source: 'recap' }));
    expect(buttons()).not.toContain('Clear and continue');
  });

  it('Start new session… tells the server it continues the old one', async () => {
    const server = fakeServer();
    renderAppShell(server, snap('background', fromRecap()));
    fireEvent.click(within(card()).getByRole('button', { name: 'Start new session…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(server.posts().some((post) => post.url === continuedPath(ASKER_ID))).toBe(true));
  });
});
