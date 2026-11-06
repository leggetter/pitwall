// Snooze (W154, docs/design-system.md, 4: Snooze): the snooze menu on the row of a session that needs
// you, the POST it makes, the snapshot's `snoozed` taking the session out of Needs you and every count
// while its row stays, quietly, in All sessions; why one is back; the toasts, their Undo; the session
// view's menu; and W88's marks, removed once. Made-up sessions only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { snoozePath, unsnoozePath, type IndexSnapshot, type SessionSnooze } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import type { StorageSource } from '../groupState.js';
import { memoryNavigation } from '../selection.js';
import { canSnooze, isSnoozed, needsAttention, snoozeBack, statusBadge } from '../sessions.js';
import { createShortcutsStore, ShortcutsStoreContext } from '../shortcuts.js';
import { asSnoozeResult, OLD_MARKS_KEY, SNOOZE_BACK_TEXT, SNOOZE_CHOICES, snoozedText, snoozedToast, snoozeLabel, UNDO_SNOOZE, WAKE_ITEM, whenText, wokenText } from '../snooze.js';
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
const id = (n: number) => `00000000-0000-4000-8000-0000001540${String(n).padStart(2, '0')}`;
const LINE = 'Waiting for the made-up author to reply';
const LATER: SessionSnooze = { at: new Date(NOW - 60_000).toISOString() };

function sessions(snooze?: SessionSnooze, extra: Partial<Parameters<typeof session>[0]> = {}) {
  const review = session({
    sessionId: id(1),
    name: 'review',
    kind: 'background',
    shortId: 'pt154rv',
    state: 'blocked',
    needsYou: { reason: 'claude-code', text: LINE },
    cwd: `${ROOT}/app`,
    lastActivityAt: minutesAgo(1),
    ...(snooze === undefined ? {} : { snoozed: snooze }),
    ...extra,
  });
  const docs = session({ sessionId: id(2), name: 'docs', status: 'waiting', waitingFor: 'permission prompt', cwd: `${ROOT}/app`, lastActivityAt: minutesAgo(4) });
  const idle = session({ sessionId: id(4), name: 'idle', cwd: `${ROOT}/app`, lastActivityAt: minutesAgo(2) });
  return { review, docs, idle };
}

function snap(list = sessions()): IndexSnapshot {
  return snapshot([group({ key: `${ROOT}/app`, label: 'app', sessions: [list.review, list.docs, list.idle] })]);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Every POST answers `answer`; any GET, an empty page. */
function fakeServer(answer: { status: number; body: unknown } = { status: 200, body: { ok: true, snoozed: LATER } }) {
  return vi.fn<FetchLike>(async (_url, init) => (init.method === 'POST' ? json(answer.status, answer.body) : json(200, { entries: [] })));
}

const posts = (fetch: ReturnType<typeof fakeServer>) => fetch.mock.calls.filter(([, init]) => init.method === 'POST').map(([url, init]) => [url, JSON.parse(String(init.body))]);

function memory(seed: Record<string, string> = {}): StorageSource & { items: Map<string, string> } {
  const items = new Map(Object.entries(seed));
  const source = () => ({ getItem: (name: string) => items.get(name) ?? null, setItem: (name: string, value: string) => void items.set(name, value), removeItem: (name: string) => void items.delete(name) });
  return Object.assign(source, { items });
}

function renderDashboard(first: IndexSnapshot, fetch = fakeServer(), search = '?view=needs-you', storage = memory()) {
  const api = createApiClient({ apiKey: 'pitwall-test-key', fetch });
  const navigation = memoryNavigation(search);
  const shortcuts = createShortcutsStore({ storage: memory(), events: { addEventListener: () => {} } });
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
const snoozeControl = (name: string) => within(main()).queryByRole('button', { name: snoozeLabel(name) });
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
  it('leaves a snoozed session out of needsAttention(), keeps its status outlined, and offers a snooze only on one that needs you and isn’t set aside', () => {
    const { review, docs, idle } = sessions();
    const snoozed = { ...review, snoozed: LATER };
    expect(needsAttention(snoozed)).toBe(false);
    expect(isSnoozed(snoozed)).toBe(true);
    expect(statusBadge(snoozed)).toMatchObject({ status: 'blocked', look: 'outline', setAside: true });
    expect([review, docs, idle, snoozed, { ...review, flagged: { at: LATER.at } }].map(canSnooze)).toEqual([true, true, false, false, false]);
  });

  it('says why one is back only while it needs you and isn’t snoozed again', () => {
    const { review, idle } = sessions();
    expect(snoozeBack({ ...review, snoozeEnded: { at: LATER.at, why: 'woken' } })).toBe('woken');
    expect(snoozeBack({ ...idle, snoozeEnded: { at: LATER.at, why: 'time' } })).toBeUndefined();
    expect(snoozeBack({ ...review, snoozed: LATER, snoozeEnded: { at: LATER.at, why: 'time' } })).toBeUndefined();
  });
});

describe('snooze.ts', () => {
  it('works out each choice in the page’s time zone, Monday a week on from a Monday', () => {
    const friday = new Date(2026, 10, 6, 15, 30);
    const until = (choice: string, from = friday) => SNOOZE_CHOICES.find((each) => each.id === choice)!.until(from);
    expect(until('1h')?.getTime()).toBe(friday.getTime() + 60 * 60 * 1000);
    expect(until('3h')?.getTime()).toBe(friday.getTime() + 3 * 60 * 60 * 1000);
    expect(until('tomorrow')).toEqual(new Date(2026, 10, 7, 9, 0));
    expect(until('next-week')).toEqual(new Date(2026, 10, 9, 9, 0));
    expect(until('next-week', new Date(2026, 10, 9, 8, 0))).toEqual(new Date(2026, 10, 16, 9, 0));
    expect(until('next-week', new Date(2026, 10, 8, 20, 0))).toEqual(new Date(2026, 10, 9, 9, 0));
    expect(until('later')).toBeUndefined();
  });

  it('says when briefly: the time today, tomorrow, a weekday, or a date', () => {
    const now = new Date(2026, 10, 6, 15, 30);
    const time = (date: Date) => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    expect(whenText(new Date(2026, 10, 6, 18, 30).toISOString(), now)).toBe(time(new Date(2026, 10, 6, 18, 30)));
    expect(whenText(new Date(2026, 10, 7, 9, 0).toISOString(), now)).toBe(`tomorrow, ${time(new Date(2026, 10, 7, 9, 0))}`);
    expect(whenText(new Date(2026, 10, 9, 9, 0).toISOString(), now)).toMatch(/ /);
    expect(snoozedText(LATER, now)).toBe("Snoozed until it's woken");
  });

  it('reads a SnoozeResult strictly', () => {
    expect(asSnoozeResult({ ok: true })).toEqual({ ok: true });
    expect(asSnoozeResult({ ok: true, snoozed: LATER })).toEqual({ ok: true, snoozed: LATER });
    expect(asSnoozeResult({ ok: true, snoozed: { at: 'soon' } })).toBeUndefined();
    expect(asSnoozeResult({ ok: false, error: 'no' })).toEqual({ ok: false, error: 'no' });
    expect(asSnoozeResult(null)).toBeUndefined();
  });
});

describe('the snooze menu on a row', () => {
  it('is on each row that needs you, named for its session, after the flag toggle; never on one that needs nothing', () => {
    renderDashboard(snap(), fakeServer(), '?view=all');
    expect(snoozeControl('review')?.getAttribute('aria-haspopup')).toBe('menu');
    expect(snoozeControl('docs')).not.toBeNull();
    expect(snoozeControl('idle')).toBeNull();
    const line2 = row('review').querySelector('.session-line-2')!;
    expect([...line2.querySelectorAll('button')].map((button) => button.getAttribute('aria-haspopup'))).toEqual([null, 'menu']);
  });

  it('snoozes it until the choice, and says so in a toast with Undo, which wakes it', async () => {
    const { fetch } = renderDashboard(snap());
    fireEvent.click(snoozeControl('review')!);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(SNOOZE_CHOICES.map((choice) => choice.label));
    fireEvent.click(screen.getByRole('menuitem', { name: 'For 1 hour' }));
    await settle();
    expect(posts(fetch)).toEqual([[snoozePath(id(1)), { until: new Date(NOW + 60 * 60 * 1000).toISOString() }]]);
    const message = snoozedToast('review', LATER, new Date(NOW));
    expect(toastMessages()).toContain(message);
    fireEvent.click(within(toastSaying(message)).getByRole('button', { name: UNDO_SNOOZE }));
    await settle();
    expect(posts(fetch).at(-1)).toEqual([unsnoozePath(id(1)), {}]);
  });

  it('snoozes Later with no time', async () => {
    const { fetch } = renderDashboard(snap());
    fireEvent.click(snoozeControl('review')!);
    fireEvent.click(screen.getByRole('menuitem', { name: "Later, until it's woken" }));
    await settle();
    expect(posts(fetch)).toEqual([[snoozePath(id(1)), {}]]);
  });

  it('says why when pitwall refuses the snooze', async () => {
    renderDashboard(snap(), fakeServer({ status: 409, body: { ok: false, error: "It doesn't need you now, so there's nothing to snooze." } }));
    fireEvent.click(snoozeControl('review')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'For 3 hours' }));
    await settle();
    expect(toastMessages()).toContain("It doesn't need you now, so there's nothing to snooze.");
  });

  it('leaves Needs you once the snapshot says it is snoozed', async () => {
    const { again } = renderDashboard(snap());
    expect(rowNames()).toContain('review');
    again(snap(sessions(LATER)));
    await settle();
    expect(rowNames()).not.toContain('review');
  });

  it('stays in All sessions, quietly: the badge outlined, until when on line 2, the toggle pressed, which wakes it with no toast', async () => {
    const { fetch } = renderDashboard(snap(sessions(LATER)), fakeServer({ status: 200, body: { ok: true } }), '?view=all');
    const snoozed = row('review');
    expect(snoozed.className).toContain('set-aside');
    expect(snoozed.querySelector('.session-set-aside')?.textContent).toBe("Snoozed until it's woken");
    expect(snoozed.querySelector('.badge[data-status]')?.className).toContain('state-set-aside');
    expect(snoozeControl('review')?.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(snoozeControl('review')!);
    await settle();
    expect(posts(fetch)).toEqual([[unsnoozePath(id(1)), {}]]);
    expect(toastMessages()).toEqual([]);
  });

  it('says why it is back, before what it needs, and stays in Needs you', () => {
    renderDashboard(snap(sessions(undefined, { snoozeEnded: { at: LATER.at, why: 'woken' } })));
    expect(rowNames()).toContain('review');
    expect(row('review').querySelector('.session-set-aside')?.textContent).toBe(SNOOZE_BACK_TEXT.woken);
    expect(row('review').className).not.toContain('set-aside');
  });

  it('takes its toast away once the snooze ends by itself', async () => {
    const { again } = renderDashboard(snap());
    fireEvent.click(snoozeControl('review')!);
    fireEvent.click(screen.getByRole('menuitem', { name: 'For 1 hour' }));
    await settle();
    expect(toastMessages()).toContain(snoozedToast('review', LATER, new Date(NOW)));
    again(snap(sessions(undefined, { snoozeEnded: { at: new Date(NOW).toISOString(), why: 'woken' } })));
    await settle();
    expect(toastMessages()).toEqual([]);
  });
});

describe("the session view's actions menu", () => {
  it('has a Snooze item for each choice while it can be snoozed, and Wake now, with a toast, once it is', async () => {
    const { fetch, again } = renderDashboard(snap(), fakeServer(), '?view=all');
    fireEvent.click(within(main()).getByRole('button', { name: 'review' }));
    await settle();
    const labels = menuLabels();
    for (const choice of SNOOZE_CHOICES) expect(labels).toContain(choice.menuLabel);
    fireEvent.click(within(view()!).getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: "Snooze until it's woken" }));
    await settle();
    expect(posts(fetch)).toEqual([[snoozePath(id(1)), {}]]);
    again(snap(sessions(LATER)));
    await settle();
    expect(view()!.querySelector('.session-view-set-aside')?.textContent).toBe("Snoozed until it's woken");
    expect(menuLabels()).toContain(WAKE_ITEM);
    fireEvent.click(within(view()!).getByRole('button', { name: 'Session actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: WAKE_ITEM }));
    await settle();
    expect(posts(fetch).at(-1)).toEqual([unsnoozePath(id(1)), {}]);
    expect(toastMessages()).toContain(wokenText('review'));
  });

  it('has neither for a session that needs nothing', async () => {
    renderDashboard(snap(), fakeServer(), '?view=all');
    fireEvent.click(within(main()).getByRole('button', { name: 'idle' }));
    await settle();
    const labels = menuLabels();
    expect(labels.some((label) => label.startsWith('Snooze'))).toBe(false);
    expect(labels).not.toContain(WAKE_ITEM);
  });
});

describe("W88's marks", () => {
  it('are removed from storage once, as the page loads, and hide nothing', () => {
    const storage = memory({ [OLD_MARKS_KEY]: JSON.stringify({ v: 1, entries: [{ id: id(1), hash: '0123456789abcdef' }] }) });
    renderDashboard(snap(), fakeServer(), '?view=needs-you', storage);
    expect(storage.items.has(OLD_MARKS_KEY)).toBe(false);
    expect(rowNames()).toContain('review');
  });
});
