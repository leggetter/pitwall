// Spin-off proposals in Needs you (W163; spinOff.ts, SpinOffCards.tsx): a card for each proposal,
// naming the session that asked, with its folder, name and whole prompt; counted in Needs you and the
// page title; Start checks it with the server and opens New session filled in; Dismiss and starting it
// take the card away. Made-up sessions and a fake server only: nothing here reaches a session.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPAWN_PATH, spinOffPath, type IndexSnapshot, type SessionSummary, type SpinOff } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { AttachContext, type AttachEnv } from '../attach.js';
import { shortenHome } from '../format.js';
import type { StorageSource } from '../groupState.js';
import { memoryNavigation } from '../selection.js';
import { SPIN_OFFS_KEY, spinOffTitle } from '../spinOff.js';
import { fakeSockets, group, NOW, session, snapshot } from '../test/fixtures.js';
import { toastMessages } from '../test/toasts.js';
import { Dashboard, startedText } from './Dashboard.js';
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
const DOCS = `${ROOT}/docs-site`;
const KEY = '0123456789abcdef';
const PROMPT = 'Tidy the made-up README.\n\nKeep the install steps as they are.';
const PROPOSAL: SpinOff = { kind: 'proposal', key: KEY, folder: DOCS, name: 'tidy-readme', prompt: PROMPT };
const ASKER_ID = '00000000-0000-4000-8000-000000163001';
const STARTED = { shortId: 'so163', name: 'tidy-readme' } as const;

const asker = (spinOff: SpinOff | null): SessionSummary => session({ sessionId: ASKER_ID, name: 'export-work', cwd: DEMO, ...(spinOff === null ? {} : { spinOff }) });

/** The session that asked, with `spinOff`, PROPOSAL by default, or none with null. */
const snap = (spinOff: SpinOff | null = PROPOSAL): IndexSnapshot => snapshot([group({ key: DEMO, label: 'demo-app', root: ROOT, sessions: [asker(spinOff)] })], { roots: [ROOT] });

interface Server {
  fetch: ReturnType<typeof vi.fn<FetchLike>>;
  posts: () => { url: string; body: unknown }[];
}

/** A fake pitwall: the check answers `check`, spawn starts STARTED, GETs a page of nothing. */
function fakeServer(check: [number, unknown] = [200, { ok: true, cwd: DOCS, name: 'tidy-readme', prompt: PROMPT }]): Server {
  const posts: { url: string; body: unknown }[] = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    if (init.method === 'POST') {
      posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === spinOffPath(ASKER_ID)) return new Response(JSON.stringify(check[1]), { status: check[0] });
      if (url === SPAWN_PATH) return new Response(JSON.stringify({ ok: true, ...STARTED }), { status: 201 });
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

function renderDashboard(server: Server = fakeServer(), first: IndexSnapshot = snap(), storage = memory()) {
  const api = createApiClient({ apiKey: 'k'.repeat(43), fetch: server.fetch });
  const navigation = memoryNavigation('?view=needs-you');
  const attach: AttachEnv = { token: 'pitwall-test-token-0123456789abcdefghijklmnop', createSocket: fakeSockets().factory, host: '127.0.0.1:4517' };
  const ui = (s: IndexSnapshot) => (
    <ApiContext.Provider value={api}>
      <AttachContext.Provider value={attach}>
        <Dashboard view={{ state: 'live', snapshot: s }} navigation={navigation} storage={storage} />
      </AttachContext.Provider>
    </ApiContext.Provider>
  );
  const result = render(ui(first));
  return {
    ...result,
    storage,
    update: async (s: IndexSnapshot) => {
      result.rerender(ui(s));
      await settle();
    },
  };
}

const settle = () => act(async () => {});
const cards = () => [...document.querySelectorAll<HTMLElement>('li.spin-off-card')];
const card = () => cards()[0]!;
const needsYouItem = () => [...document.querySelectorAll<HTMLAnchorElement>('a[data-repo-item]')].find((link) => link.querySelector('.repo-item-label')?.textContent === 'Needs you')!;
const dialog = () => screen.getByRole('dialog', { name: 'New session' });
const field = (name: 'Name' | 'First prompt') => within(dialog()).getByRole('textbox', { name: name === 'Name' ? /^Name/ : name }) as HTMLInputElement | HTMLTextAreaElement;
const directory = () => within(dialog()).getByRole('combobox', { name: 'Directory' }) as HTMLInputElement;

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

describe('a spin-off proposal in Needs you', () => {
  it('is a card naming the session that asked, with the folder, the name and the whole prompt', () => {
    renderDashboard();
    const region = screen.getByRole('region', { name: /Proposed sessions/ });
    expect(within(region).getByRole('heading', { level: 4 }).textContent).toBe(spinOffTitle('export-work'));
    expect(card().querySelector('.approval-where')?.textContent).toBe(`In ${DOCS}, named tidy-readme.`);
    // The prompt as text, line breaks and all, never as markdown.
    expect(card().querySelector('.approval-text')?.textContent).toBe(PROMPT);
    expect(within(card()).getByRole('button', { name: 'Start…' })).toBeTruthy();
  });

  it('counts in Needs you and the page title, though the session itself doesn’t need you', () => {
    renderDashboard();
    expect(needsYouItem().textContent).toBe('Needs you1 needs you');
    expect(document.title).toMatch(/^\(1\) pitwall/);
    // No row needs you: Needs you says nothing else does.
    expect(screen.getByText('Nothing else needs you right now')).toBeTruthy();
  });

  it('draws a character that doesn’t show as itself as its code', () => {
    renderDashboard(fakeServer(), snap({ ...PROPOSAL, prompt: 'Tidy it.' }));
    expect(card().querySelector('.approval-hidden')?.textContent).toBe('U+00A0');
  });

  it('Start checks it with the server, then opens New session filled in with what it checked', async () => {
    const server = fakeServer();
    renderDashboard(server);
    fireEvent.click(within(card()).getByRole('button', { name: 'Start…' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).not.toBeNull());
    expect(server.posts()).toEqual([{ url: spinOffPath(ASKER_ID), body: { key: KEY } }]);
    expect(directory().value).toBe(shortenHome(DOCS));
    expect(field('Name').value).toBe('tidy-readme');
    expect(field('First prompt').value).toBe(PROMPT);
    expect(dialog().textContent).toContain('as export-work proposed');
  });

  it('starts nothing until New session’s own Start session, then its card goes', async () => {
    const server = fakeServer();
    const { storage } = renderDashboard(server);
    fireEvent.click(within(card()).getByRole('button', { name: 'Start…' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).not.toBeNull());
    expect(server.posts().some((post) => post.url === SPAWN_PATH)).toBe(false);
    fireEvent.change(field('First prompt'), { target: { value: 'Tidy the made-up README, my way.' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull());
    expect(server.posts().at(-1)).toEqual({ url: SPAWN_PATH, body: { cwd: DOCS, name: 'tidy-readme', prompt: 'Tidy the made-up README, my way.' } });
    expect(toastMessages()).toContain(startedText(STARTED.name));
    expect(cards()).toEqual([]);
    expect(storage.values.get(SPIN_OFFS_KEY)).toBe(JSON.stringify({ v: 1, dismissed: [`${ASKER_ID}:${KEY}`] }));
  });

  it('leaves the card when New session is closed without starting', async () => {
    renderDashboard();
    fireEvent.click(within(card()).getByRole('button', { name: 'Start…' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New session' })).not.toBeNull());
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
    expect(cards()).toHaveLength(1);
  });

  it('says why when the server refuses it, and opens nothing', async () => {
    renderDashboard(fakeServer([409, { ok: false, error: 'The directory isn’t under one of your roots.' }]));
    fireEvent.click(within(card()).getByRole('button', { name: 'Start…' }));
    await waitFor(() => expect(within(card()).queryByRole('alert')).not.toBeNull());
    expect(within(card()).getByRole('alert').textContent).toBe('The directory isn’t under one of your roots.');
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
  });

  it('Dismiss takes it away and out of the count, until the session proposes something else', async () => {
    const { update } = renderDashboard();
    fireEvent.click(within(card()).getByRole('button', { name: 'Dismiss' }));
    expect(cards()).toEqual([]);
    expect(needsYouItem().textContent).toBe('Needs you');
    await update(snap());
    expect(cards()).toEqual([]);
    await update(snap({ ...PROPOSAL, key: 'fedcba9876543210', prompt: 'Something else.' }));
    expect(cards()).toHaveLength(1);
  });

  it('goes when the session’s newer turn proposes nothing', async () => {
    const { update } = renderDashboard();
    expect(cards()).toHaveLength(1);
    await update(snap(null));
    expect(cards()).toEqual([]);
    expect(screen.queryByRole('region', { name: /Proposed sessions/ })).toBeNull();
  });

  it('says why pitwall won’t show one it couldn’t read, with no Start', () => {
    renderDashboard(fakeServer(), snap({ kind: 'unreadable', key: KEY, problem: 'The block names no folder.' }));
    expect(card().textContent).toContain('The block names no folder.');
    expect(within(card()).queryByRole('button', { name: 'Start…' })).toBeNull();
    expect(within(card()).getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('Open session opens the session that asked', () => {
    renderDashboard();
    fireEvent.click(within(card()).getByRole('button', { name: 'Open session' }));
    expect(document.getElementById('session-view') ?? screen.getByRole('heading', { name: /export-work/, level: 2 })).toBeTruthy();
  });
});
