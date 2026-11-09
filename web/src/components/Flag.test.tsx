// Flag: "It doesn't need me" (W153, docs/design-system.md, 4: Flag): the toggle on the row of a
// running session that needs you, the POST it makes, the snapshot's `flagged` taking the session out of
// Needs you and every count while its row stays, quietly, in All sessions; the toasts, their Undo,
// and the session view's menu. Made-up sessions only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flagPath, unflagPath, type IndexSnapshot } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { asFlagResult, FLAG_ITEM, flaggedText, flagLabel, FLAGGED_TEXT, UNDO_FLAG, UNFLAG_ITEM, unflaggedText } from '../flags.js';
import type { StorageSource } from '../groupState.js';
import { memoryNavigation } from '../selection.js';
import { canFlag, isFlagged, needsAttention, statusBadge } from '../sessions.js';
import { createShortcutsStore, ShortcutsStoreContext } from '../shortcuts.js';
import { group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { toastMessages, toastSaying } from '../test/toasts.js';
import { Dashboard } from './Dashboard.js';
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
const id = (n: number) => `00000000-0000-4000-8000-0000001530${String(n).padStart(2, '0')}`;
const LINE = 'Waiting for the made-up author to reply';
const FLAGGED_AT = '2026-11-06T10:05:00.000Z';

function sessions(flagged = false) {
  const review = session({
    sessionId: id(1),
    name: 'review',
    kind: 'background',
    shortId: 'pt153rv',
    state: 'blocked',
    needsYou: { reason: 'claude-code', text: LINE },
    cwd: `${ROOT}/app`,
    lastActivityAt: minutesAgo(1),
    ...(flagged ? { flagged: { at: FLAGGED_AT } } : {}),
  });
  const docs = session({ sessionId: id(2), name: 'docs', status: 'waiting', waitingFor: 'permission prompt', cwd: `${ROOT}/app`, lastActivityAt: minutesAgo(4) });
  const gone = session({ sessionId: id(3), name: 'gone', alive: false, pid: undefined, kind: 'background', shortId: 'pt153gn', state: 'blocked', needsYou: { reason: 'claude-code', text: 'x' }, cwd: `${ROOT}/app`, lastActivityAt: minutesAgo(6) });
  const idle = session({ sessionId: id(4), name: 'idle', cwd: `${ROOT}/app`, lastActivityAt: minutesAgo(2) });
  return { review, docs, gone, idle };
}

function snap(list = sessions()): IndexSnapshot {
  return snapshot([group({ key: `${ROOT}/app`, label: 'app', sessions: [list.review, list.docs, list.gone, list.idle] })]);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Every POST answers `answer`; any GET, an empty page. */
function fakeServer(answer: { status: number; body: unknown } = { status: 200, body: { ok: true, asked: { status: 'delivered' } } }) {
  return vi.fn<FetchLike>(async (_url, init) => (init.method === 'POST' ? json(answer.status, answer.body) : json(200, { entries: [] })));
}

const posts = (fetch: ReturnType<typeof fakeServer>) => fetch.mock.calls.filter(([, init]) => init.method === 'POST').map(([url, init]) => [url, JSON.parse(String(init.body))]);

function memory(): StorageSource {
  const items = new Map<string, string>();
  return () => ({ getItem: (name) => items.get(name) ?? null, setItem: (name, value) => void items.set(name, value) });
}

function renderDashboard(first: IndexSnapshot, fetch = fakeServer(), search = '?view=needs-you') {
  const api = createApiClient({ apiKey: 'pitwall-test-key', fetch });
  const navigation = memoryNavigation(search);
  const shortcuts = createShortcutsStore({ storage: memory(), events: { addEventListener: () => {} } });
  const storage = memory();
  const ui = (s: IndexSnapshot) => (
    <ApiContext.Provider value={api}>
      <ShortcutsStoreContext.Provider value={shortcuts}>
        <Dashboard view={{ state: 'live', snapshot: s }} navigation={navigation} storage={storage} />
      </ShortcutsStoreContext.Provider>
    </ApiContext.Provider>
  );
  const result = render(ui(first));
  return { ...result, fetch, again: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

const settle = () => act(async () => {});
const main = () => screen.getByRole('main');
const rowNames = () => within(main()).queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent ?? '');
const row = (name: string) => within(main()).getByRole('button', { name }).closest('li.session') as HTMLElement;
const flagToggle = (name: string) => within(main()).queryByRole('button', { name: flagLabel(name) });
const view = () => document.getElementById('session-view') ?? undefined;
const menuLabels = () => {
  fireEvent.click(within(view()!).getByRole('button', { name: 'Session actions' }));
  const labels = screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  return labels;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('sessions.ts', () => {
  it('leaves a flagged session out of needsAttention(), keeps its status outlined, and offers a flag only on a running one that needs you', () => {
    const { review, docs, gone, idle } = sessions();
    const flagged = { ...review, flagged: { at: FLAGGED_AT } };
    expect(needsAttention(review)).toBe(true);
    expect(needsAttention(flagged)).toBe(false);
    expect(isFlagged(flagged)).toBe(true);
    expect(statusBadge(flagged)).toMatchObject({ status: 'blocked', look: 'outline', setAside: true });
    expect([review, docs, gone, idle, flagged].map(canFlag)).toEqual([true, true, false, false, false]);
  });
});

describe('flags.ts', () => {
  it('reads a FlagResult strictly', () => {
    expect(asFlagResult({ ok: true })).toEqual({ ok: true });
    expect(asFlagResult({ ok: true, asked: { status: 'failed', detail: 'why' } })).toEqual({ ok: true, asked: { status: 'failed', detail: 'why' } });
    expect(asFlagResult({ ok: true, asked: { status: 'sent' } })).toBeUndefined();
    expect(asFlagResult({ ok: false, error: 'no' })).toEqual({ ok: false, error: 'no' });
    expect(asFlagResult({ ok: false })).toBeUndefined();
    expect(asFlagResult(null)).toBeUndefined();
  });

  it('says what came of the ask', () => {
    expect(flaggedText('review', { status: 'delivered' }).tone).toBe('success');
    expect(flaggedText('review', { status: 'failed', detail: 'No running session is named review now.' })).toEqual({
      tone: 'error',
      message: "Flagged review: it's out of Needs you, but pitwall couldn't ask it what it needs. No running session is named review now.",
    });
  });
});

describe('the flag toggle on a row', () => {
  it('is on each running row that needs you, named for its session, not pressed; never on one that needs nothing or isn’t running', () => {
    renderDashboard(snap(), fakeServer(), '?view=all');
    expect(flagToggle('review')?.getAttribute('aria-pressed')).toBe('false');
    expect(flagToggle('docs')).not.toBeNull();
    expect(flagToggle('idle')).toBeNull();
    expect(flagToggle('gone')).toBeNull();
    // Before the snooze menu, at the end of line 2.
    const line2 = row('review').querySelector('.session-line-2')!;
    expect([...line2.querySelectorAll('button')].map((button) => button.className.includes('flag-toggle'))).toEqual([true, false]);
  });

  it('flags it with the reason the page shows, and says the session was asked, with Undo', async () => {
    const { fetch } = renderDashboard(snap());
    fireEvent.click(flagToggle('review')!);
    await settle();
    expect(posts(fetch)).toEqual([[flagPath(id(1)), { reason: 'claude-code', from: 'row' }]]);
    expect(toastMessages()).toContain(flaggedText('review', { status: 'delivered' }).message);
    // Undo takes it away.
    fireEvent.click(within(toastSaying(flaggedText('review', { status: 'delivered' }).message)).getByRole('button', { name: UNDO_FLAG }));
    await settle();
    expect(posts(fetch).at(-1)).toEqual([unflagPath(id(1)), {}]);
  });

  it('says why when pitwall refuses the flag', async () => {
    renderDashboard(snap(), fakeServer({ status: 409, body: { ok: false, error: 'What it needs you for has just changed. Look again before you flag it.' } }));
    fireEvent.click(flagToggle('review')!);
    await settle();
    expect(toastMessages()).toContain('What it needs you for has just changed. Look again before you flag it.');
  });

  it('leaves Needs you once the snapshot says it is flagged', async () => {
    const { again } = renderDashboard(snap());
    expect(rowNames()).toContain('review');
    again(snap(sessions(true)));
    await settle();
    expect(rowNames()).not.toContain('review');
  });

  it('stays in All sessions, quietly: the badge outlined, "You flagged this" on line 2, the toggle pressed', () => {
    renderDashboard(snap(sessions(true)), fakeServer(), '?view=all');
    const flagged = row('review');
    expect(flagged.className).toContain('set-aside');
    expect(flagged.querySelector('.session-set-aside')?.textContent).toBe(FLAGGED_TEXT);
    expect(flagged.querySelector('.badge[data-status]')?.className).toContain('state-set-aside');
    expect(flagToggle('review')?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('a flagged row’s toggle', () => {
  it('takes the flag away with no toast', async () => {
    const { fetch } = renderDashboard(snap(sessions(true)), fakeServer({ status: 200, body: { ok: true } }), '?view=all');
    fireEvent.click(flagToggle('review')!);
    await settle();
    expect(posts(fetch)).toEqual([[unflagPath(id(1)), {}]]);
    expect(toastMessages()).toEqual([]);
  });
});

describe("the session view's actions menu", () => {
  it("has It doesn't need me while it can be flagged, and Undo flag, with a toast, once it is", async () => {
    const { fetch, again } = renderDashboard(snap(), fakeServer(), '?view=all');
    fireEvent.click(within(main()).getByRole('button', { name: 'review' }));
    await settle();
    expect(menuLabels()).toContain(FLAG_ITEM);
    fireEvent.click(within(view()!).getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: FLAG_ITEM }));
    await settle();
    expect(posts(fetch)).toEqual([[flagPath(id(1)), { reason: 'claude-code', from: 'view' }]]);
    again(snap(sessions(true)));
    await settle();
    expect(view()!.querySelector('.session-view-set-aside')?.textContent).toBe(FLAGGED_TEXT);
    expect(menuLabels()).toContain(UNFLAG_ITEM);
    fireEvent.click(within(view()!).getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: UNFLAG_ITEM }));
    await settle();
    expect(posts(fetch).at(-1)).toEqual([unflagPath(id(1)), {}]);
    expect(toastMessages()).toContain(unflaggedText('review'));
  });

  it('has neither for a session that needs nothing', async () => {
    renderDashboard(snap(), fakeServer(), '?view=all');
    fireEvent.click(within(main()).getByRole('button', { name: 'idle' }));
    await settle();
    const labels = menuLabels();
    expect(labels).not.toContain(FLAG_ITEM);
    expect(labels).not.toContain(UNFLAG_ITEM);
  });
});

