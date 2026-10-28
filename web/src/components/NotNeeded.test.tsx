// Not needed now (W88, docs/design-system.md, 4: Not needed now): the toggle on the row of a session
// that needs you, its name and state; marking takes it out of Needs you, the repo list's badges (Needs
// you's, Starred's, its group's and the Hidden section's), the session list's "N need you", the root
// tabs' badges, the page title's count and the urgency sort, and keeps it in All sessions and its
// group, quietly; the toast and its Undo; focus; back in Needs you by itself once what it needs
// changes, but not because it's missing from a snapshot; the session view's menu; a reload, another
// tab, and storage that throws. Made-up sessions only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexSnapshot, SessionSummary } from '../../../src/shared/protocol.js';
import type { StorageSource } from '../groupState.js';
import { hiddenKey } from '../hidden.js';
import { needHash, NOT_NEEDED_KEY } from '../notNeeded.js';
import { memoryNavigation, type NavigationEnv } from '../selection.js';
import { createShortcutsStore, ShortcutsStoreContext } from '../shortcuts.js';
import { STARRED_KEY } from '../starred.js';
import { group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { toastMessages, toastSaying } from '../test/toasts.js';
import { Dashboard, notNeededText, putBackText, UNDO_NOT_NEEDED } from './Dashboard.js';
import { notNeededLabel } from './NotNeededButton.js';
import { MARK_NOT_NEEDED, PUT_BACK } from './SessionView.js';
import type { TerminalHandle } from './Terminal.js';

// xterm.js, replaced by a terminal that does nothing, through the module the view loads it from.
class QuietTerminal implements TerminalHandle {
  cols = 80;
  rows = 24;
  write() {}
  onData() {}
  fit() {}
  focus() {}
  dispose() {}
}
vi.mock('../xterm.js', () => ({ createXterm: () => new QuietTerminal() }));

const ROOT = '/Users/example/code';
const WORK = '/Users/example/work';
const id = (n: number) => `00000000-0000-4000-8000-0000000088${String(n).padStart(2, '0')}`;
const REVIEW_LINE = "Waiting for the made-up author's fix before re-running the check";

/**
 * Phil's case, made up: `review` is a background job Claude Code calls blocked, waiting on a pull
 * request's author. `docs` waits on a permission prompt, `asks` asked a question; `idle` and `busy`
 * need nothing.
 */
function sessions(overrides: { review?: Partial<SessionSummary> } = {}) {
  const review = session({
    sessionId: id(1),
    name: 'review',
    kind: 'background',
    shortId: 'pt88rev',
    status: 'idle',
    state: 'blocked',
    needsYou: { reason: 'claude-code', text: REVIEW_LINE },
    cwd: `${ROOT}/app`,
    lastActivityAt: minutesAgo(1),
    ...overrides.review,
  });
  const docs = session({ sessionId: id(2), name: 'docs', status: 'waiting', waitingFor: 'permission prompt', cwd: `${ROOT}/app`, lastActivityAt: minutesAgo(4) });
  const asks = session({ sessionId: id(3), name: 'asks', askedYou: { reason: 'question', excerpt: 'Shall I go on with the made-up change?' }, cwd: `${ROOT}/jobs`, lastActivityAt: minutesAgo(6) });
  const busy = session({ sessionId: id(4), name: 'busy', status: 'busy', cwd: `${ROOT}/app`, lastActivityAt: minutesAgo(8) });
  const idle = session({ sessionId: id(5), name: 'idle', cwd: `${ROOT}/jobs`, lastActivityAt: minutesAgo(2) });
  return { review, docs, asks, busy, idle };
}

function snap(list = sessions()): IndexSnapshot {
  return snapshot([
    group({ key: `${ROOT}/app`, label: 'app', sessions: [list.review, list.docs, list.busy] }),
    group({ key: `${ROOT}/jobs`, label: 'jobs', sessions: [list.asks, list.idle] }),
  ]);
}

/** Two roots: review under ~/code, and a session that needs you under ~/work. */
function twoRoots(list = sessions()): IndexSnapshot {
  return snapshot(
    [
      group({ key: `${ROOT}/app`, label: 'app', root: ROOT, sessions: [list.idle] }),
      group({ key: `${WORK}/svc`, label: 'svc', root: WORK, sessions: [list.review, list.docs] }),
    ],
    { roots: [ROOT, WORK] },
  );
}

function memory(initial: Record<string, string> = {}) {
  const items = new Map<string, string>(Object.entries(initial));
  const source: StorageSource = () => ({ getItem: (name) => items.get(name) ?? null, setItem: (name, value) => void items.set(name, value) });
  return { items, source };
}

const marksIn = (items: Map<string, string>) => (JSON.parse(items.get(NOT_NEEDED_KEY) ?? '{"v":1,"entries":[]}') as { entries: { id: string; hash: string }[] }).entries;

interface Options {
  search?: string;
  storage?: StorageSource;
  navigation?: NavigationEnv;
}

function renderDashboard(first: IndexSnapshot = snap(), options: Options = {}) {
  const store = memory();
  const storage = options.storage ?? store.source;
  const navigation = options.navigation ?? memoryNavigation(options.search ?? '?view=needs-you');
  const shortcuts = createShortcutsStore({ storage: memory().source, events: { addEventListener: () => {} } });
  const ui = (s: IndexSnapshot) => (
    <ShortcutsStoreContext.Provider value={shortcuts}>
      <Dashboard view={{ state: 'live', snapshot: s }} navigation={navigation} storage={storage} />
    </ShortcutsStoreContext.Provider>
  );
  const result = render(ui(first));
  return { ...result, items: store.items, storage, navigation, again: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

const settle = () => act(async () => {});
const main = () => screen.getByRole('main');
const repoList = () => screen.getByRole('navigation', { name: 'Repos' });
const rowNames = () => within(main()).queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent ?? '');
const row = (name: string) => within(main()).getByRole('button', { name }).closest('li.session') as HTMLElement;
const toggle = (name: string) => within(main()).getByRole('button', { name: notNeededLabel(name) });
const queryToggle = (name: string) => within(main()).queryByRole('button', { name: notNeededLabel(name) });
const summary = () => document.querySelector('.session-list .summary')?.textContent ?? '';
const view = () => document.getElementById('session-view') ?? undefined;
const pressed = (button: HTMLElement) => button.getAttribute('aria-pressed');
const badgeOf = (name: string) => row(name).querySelector<HTMLElement>('.badge[data-status]');

function repoItem(label: string): HTMLAnchorElement {
  const item = [...repoList().querySelectorAll<HTMLAnchorElement>('a[data-repo-item]')].find((link) => link.querySelector('.repo-item-label')?.textContent === label);
  if (!item) throw new Error(`no repo list item ${label}`);
  return item;
}
const badgeIn = (label: string) => repoItem(label).querySelector('.badge-attention')?.textContent ?? null;

function choose(label: string) {
  fireEvent.click(repoItem(label));
}

async function open(name: string) {
  fireEvent.click(within(main()).getByRole('button', { name }));
  await settle();
}

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

/** Opens the session view's actions menu and chooses `label`. */
function chooseInMenu(label: string) {
  fireEvent.click(within(view()!).getByRole('button', { name: 'Session actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
}
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

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('the toggle on a row', () => {
  it('is on each row that needs you, named for its session, not pressed, at the end of line 2; never on one that needs nothing', () => {
    renderDashboard(snap(), { search: '?view=all' });
    for (const name of ['review', 'docs', 'asks']) {
      const button = toggle(name);
      expect(button.getAttribute('type')).toBe('button');
      expect(pressed(button)).toBe('false');
      // Line 2's last control, after what it says, so line 1 keeps its room.
      expect(button.parentElement?.classList.contains('session-line-2')).toBe(true);
      expect(button.parentElement?.lastElementChild).toBe(button);
      expect(button.previousElementSibling?.classList.contains('session-what')).toBe(true);
      expect(row(name).querySelector('.session-line')?.contains(button)).toBe(false);
    }
    expect(queryToggle('busy')).toBeNull();
    expect(queryToggle('idle')).toBeNull();
  });

  it('gives a row that needs you a line 2 of its own for it, when there is nothing else to say there', () => {
    const lone = session({ sessionId: id(9), name: 'lone', kind: 'background', shortId: 'pt88one', status: 'idle', state: 'blocked', needsYou: { reason: 'blocked' }, lastUserPrompt: undefined, cwd: `${ROOT}/solo` });
    renderDashboard(snapshot([group({ key: `${ROOT}/solo`, label: 'solo', sessions: [lone] })]), { search: `?repo=${ROOT}/solo` });
    const line2 = toggle('lone').parentElement!;
    expect(line2.classList.contains('session-line-2')).toBe(true);
    expect(line2.querySelector('.session-what')).toBeNull();
  });

  it('marks the session in Needs you: the row leaves at once, with a toast, and focus goes to the next row\'s toggle', async () => {
    const { items, navigation } = renderDashboard();
    expect(rowNames()).toEqual(['review', 'docs', 'asks']);
    const button = toggle('review');
    button.focus();
    fireEvent.click(button);
    await settle();
    expect(rowNames()).toEqual(['docs', 'asks']);
    expect(document.activeElement).toBe(toggle('docs'));
    expect(toastMessages()).toEqual([notNeededText('review')]);
    expect(within(toastSaying(notNeededText('review'))).getByRole('button', { name: UNDO_NOT_NEEDED })).toBeTruthy();
    expect(marksIn(items)).toEqual([{ id: id(1), hash: needHash(sessions().review) }]);
    // It never opens or selects the session.
    expect(view()).toBeUndefined();
    expect(navigation.location.search).toBe('?view=needs-you');
  });

  it("keeps it in All sessions and its group, quietly: no bar, the badge outlined, \"Not needed now\" on line 2, the toggle pressed", () => {
    renderDashboard(snap(), { search: '?view=all' });
    expect(row('review').dataset.attention).toBe('true');
    expect(badgeOf('review')?.classList.contains('state-not-needed')).toBe(false);
    const button = toggle('review');
    const offIcon = button.querySelector('path')?.getAttribute('d');
    fireEvent.click(button);
    expect(toggle('review')).toBe(button);
    expect(pressed(button)).toBe('true');
    expect(button.querySelector('path')?.getAttribute('d')).not.toBe(offIcon);
    expect(row('review').dataset.attention).toBeUndefined();
    expect(row('review').classList.contains('attention')).toBe(false);
    expect(row('review').classList.contains('not-needed')).toBe(true);
    // The badge keeps its text and status, outlined.
    expect(badgeOf('review')?.textContent).toBe('Blocked');
    expect(badgeOf('review')?.dataset.status).toBe('blocked');
    expect(badgeOf('review')?.classList.contains('state-not-needed')).toBe(true);
    // Line 2: the group, then Not needed now, then what it needs.
    expect(row('review').querySelector('.session-what')?.textContent).toBe(`app · Not needed now · Needs: ${REVIEW_LINE}`);

    choose('app');
    expect(pressed(toggle('review'))).toBe('true');
    expect(row('review').querySelector('.session-what')?.textContent).toBe(`Not needed now · Needs: ${REVIEW_LINE}`);
  });

  it('takes the mark away from the row with no toast, and the mark\'s toast goes, with nothing left to undo', async () => {
    const { items } = renderDashboard(snap(), { search: '?view=all' });
    fireEvent.click(toggle('review'));
    expect(toastMessages()).toEqual([notNeededText('review')]);
    fireEvent.click(toggle('review'));
    await settle();
    expect(pressed(toggle('review'))).toBe('false');
    expect(row('review').dataset.attention).toBe('true');
    expect(toastMessages()).toEqual([]);
    expect(marksIn(items)).toEqual([]);
  });
});

describe('j and k', () => {
  it("start from a row's Not needed now toggle, as from its star", () => {
    renderDashboard();
    toggle('docs').focus();
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: 'j' });
    });
    expect(document.activeElement).toBe(within(main()).getByRole('button', { name: 'asks' }));
    toggle('docs').focus();
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: 'k' });
    });
    expect(document.activeElement).toBe(within(main()).getByRole('button', { name: 'review' }));
  });
});

describe('what a mark takes it out of', () => {
  it("Needs you's, its group's and Starred's badges, the summary's need-you count and the page title's", () => {
    const { items } = renderDashboard(snap(), { search: '?view=all' });
    fireEvent.click(within(main()).getByRole('button', { name: 'Star review' }));
    expect(JSON.parse(items.get(STARRED_KEY)!).ids).toEqual([id(1)]);
    expect(badgeIn('Needs you')).toBe('3 need you');
    expect(badgeIn('app')).toBe('2 need you');
    expect(badgeIn('Starred')).toBe('1 needs you');
    expect(summary()).toContain('3 need you');
    expect(document.title).toBe('(3) pitwall');

    fireEvent.click(toggle('review'));
    expect(badgeIn('Needs you')).toBe('2 need you');
    expect(badgeIn('app')).toBe('1 needs you');
    // Starred has no badge now, so it counts its sessions.
    expect(badgeIn('Starred')).toBeNull();
    expect(repoItem('Starred').querySelector('.repo-item-count')?.textContent).toBe('1 session');
    // The group still counts it among its sessions.
    expect(summary()).toContain('2 need you');
    expect(document.title).toBe('(2) pitwall');
  });

  it("the Hidden section's badge", () => {
    const hidden = memory({ [hiddenKey(ROOT)]: JSON.stringify({ v: 1, open: false, groups: [{ key: `${ROOT}/app`, label: 'app', kind: 'git' }] }) });
    renderDashboard(snap(), { search: '?view=all', storage: hidden.source });
    const section = () => repoList().querySelector('.repo-hidden-toggle')!;
    expect(section().querySelector('.badge-attention')?.textContent).toBe('2 need you');
    fireEvent.click(toggle('review'));
    expect(section().querySelector('.badge-attention')?.textContent).toBe('1 needs you');
  });

  it("the root tabs' badges", () => {
    renderDashboard(twoRoots(), { search: `?view=all&root=${ROOT}` });
    const workBadge = () => screen.getByRole('tab', { name: /work/ }).querySelector('.badge-attention')?.textContent?.replace(/^, /, '') ?? null;
    expect(workBadge()).toBe('2 need you');
    // Marked in ~/work's tab; back in ~/code's, ~/work's badge counts the one left.
    fireEvent.click(screen.getByRole('tab', { name: /work/ }));
    fireEvent.click(toggle('review'));
    fireEvent.click(screen.getByRole('tab', { name: /code/ }));
    expect(workBadge()).toBe('1 needs you');
  });

  it('the urgency sort: it sorts as one that needs nothing, by its status', () => {
    renderDashboard(snap(), { search: '?view=all' });
    expect(rowNames()).toEqual(['review', 'docs', 'asks', 'busy', 'idle']);
    fireEvent.click(toggle('review'));
    // Moved down once the pointer and focus have left the list, as any reorder waits.
    fireEvent.blur(toggle('review'));
    fireEvent.pointerLeave(main());
    expect(rowNames()).toEqual(['docs', 'asks', 'busy', 'review', 'idle']);
  });
});

describe("the mark's toast", () => {
  it('goes once the mark goes by itself, as what the session needs changes, since Undo would have nothing to do', async () => {
    const { again } = renderDashboard();
    fireEvent.click(toggle('review'));
    fireEvent.click(toggle('docs'));
    expect(toastMessages()).toEqual([notNeededText('review'), notNeededText('docs')]);
    again(snap(sessions({ review: { needsYou: { reason: 'blocked' } } })));
    await settle();
    expect(toastMessages()).toEqual([notNeededText('docs')]);
  });

  it('is replaced by the menu\'s Put back in Needs you, which stays', async () => {
    setWidth(1300);
    renderDashboard(snap(), { search: '?view=all' });
    await open('review');
    chooseInMenu(MARK_NOT_NEEDED);
    chooseInMenu(PUT_BACK);
    await settle();
    expect(toastMessages()).toEqual([putBackText('review')]);
  });
});

describe("the toast's Undo", () => {
  it('takes the mark away: back in Needs you, with focus on its toggle', async () => {
    const { items } = renderDashboard();
    fireEvent.click(toggle('review'));
    await settle();
    const undo = within(toastSaying(notNeededText('review'))).getByRole('button', { name: UNDO_NOT_NEEDED });
    undo.focus();
    fireEvent.click(undo);
    await settle();
    expect(rowNames()).toEqual(['review', 'docs', 'asks']);
    expect(document.activeElement).toBe(toggle('review'));
    expect(pressed(toggle('review'))).toBe('false');
    expect(marksIn(items)).toEqual([]);
    expect(toastMessages()).toEqual([]);
  });

  it("leaves focus where it was when it wasn't in the toast", async () => {
    renderDashboard();
    fireEvent.click(toggle('review'));
    await settle();
    const heading = within(main()).getByRole('heading', { level: 2 });
    heading.focus();
    fireEvent.click(within(toastSaying(notNeededText('review'))).getByRole('button', { name: UNDO_NOT_NEEDED }));
    await settle();
    expect(rowNames()).toEqual(['review', 'docs', 'asks']);
    expect(document.activeElement).toBe(heading);
  });
});

describe('back in Needs you by itself', () => {
  it('once what it needs changes, and the mark goes from storage', async () => {
    const { items, again } = renderDashboard();
    fireEvent.click(toggle('review'));
    expect(rowNames()).toEqual(['docs', 'asks']);
    // A snapshot with nothing changed for it: still out.
    again(snap(sessions({ review: { lastActivityAt: minutesAgo(0) } })));
    await settle();
    expect(rowNames()).toEqual(['docs', 'asks']);
    expect(marksIn(items)).toHaveLength(1);
    // The author pushed a fix, and Claude Code's line says so.
    again(snap(sessions({ review: { needsYou: { reason: 'claude-code', text: 'The made-up author pushed a fix; re-run the check?' } } })));
    await settle();
    expect(rowNames()).toEqual(['review', 'docs', 'asks']);
    expect(document.title).toBe('(3) pitwall');
    expect(marksIn(items)).toEqual([]);
    // The same need again isn't marked: the mark was for what it needed then.
    again(snap());
    await settle();
    expect(rowNames()).toEqual(['review', 'docs', 'asks']);
  });

  it('for each of the parts of what it needs', async () => {
    const changes: Partial<SessionSummary>[] = [
      { needsYou: { reason: 'blocked' } },
      { askedYou: { reason: 'question', excerpt: 'A made-up question?' } },
      { status: 'waiting', waitingFor: 'permission prompt', needsYou: { reason: 'prompt' } },
      { waitingFor: 'input needed' },
      { state: 'working', needsYou: { reason: 'claude-code', text: REVIEW_LINE } },
    ];
    for (const change of changes) {
      const { items, again, unmount } = renderDashboard();
      fireEvent.click(toggle('review'));
      expect(rowNames(), JSON.stringify(change)).not.toContain('review');
      again(snap(sessions({ review: change })));
      await settle();
      expect(rowNames(), JSON.stringify(change)).toContain('review');
      expect(marksIn(items), JSON.stringify(change)).toEqual([]);
      unmount();
    }
  });

  it('but not because it is missing from a snapshot: back unchanged, it is still out', async () => {
    const { items, again } = renderDashboard();
    fireEvent.click(toggle('review'));
    const list = sessions();
    again(snapshot([group({ key: `${ROOT}/app`, label: 'app', sessions: [list.docs] }), group({ key: `${ROOT}/jobs`, label: 'jobs', sessions: [list.asks] })]));
    await settle();
    expect(marksIn(items)).toEqual([{ id: id(1), hash: needHash(list.review) }]);
    again(snap());
    await settle();
    expect(rowNames()).toEqual(['docs', 'asks']);
  });
});

describe("the session view's actions menu", () => {
  it('marks it, with a toast, outlines its badge with "Not needed now", then puts it back in Needs you', async () => {
    setWidth(1300);
    const { items } = renderDashboard(snap(), { search: '?view=all' });
    await open('review');
    const labels = menuLabels();
    expect(labels).toContain(MARK_NOT_NEEDED);
    // After the copies.
    expect(labels.indexOf(MARK_NOT_NEEDED)).toBeGreaterThan(labels.indexOf('Copy attach command'));
    chooseInMenu(MARK_NOT_NEEDED);
    await settle();
    expect(toastMessages()).toEqual([notNeededText('review')]);
    expect(marksIn(items)).toHaveLength(1);
    const meta = view()!.querySelector('.session-view-meta')!;
    expect(meta.querySelector('.badge[data-status="blocked"]')?.classList.contains('state-not-needed')).toBe(true);
    expect(meta.textContent).toContain('Not needed now');
    expect(pressed(toggle('review'))).toBe('true');
    // Focus back on the menu's button, as after any item.
    expect(document.activeElement).toBe(within(view()!).getByRole('button', { name: 'Session actions' }));

    expect(menuLabels()).toContain(PUT_BACK);
    chooseInMenu(PUT_BACK);
    await settle();
    expect(toastMessages()).toEqual([putBackText('review')]);
    expect(marksIn(items)).toEqual([]);
    expect(view()!.querySelector('.session-view-meta')!.textContent).not.toContain('Not needed now');
    expect(pressed(toggle('review'))).toBe('false');
  });

  it('has neither for a session that needs nothing', async () => {
    setWidth(1300);
    renderDashboard(snap(), { search: '?view=all' });
    await open('busy');
    const labels = menuLabels();
    expect(labels).not.toContain(MARK_NOT_NEEDED);
    expect(labels).not.toContain(PUT_BACK);
  });
});

describe('kept in the browser', () => {
  it('through a reload', () => {
    const shared = memory();
    const first = renderDashboard(snap(), { storage: shared.source });
    fireEvent.click(toggle('review'));
    first.unmount();
    renderDashboard(snap(), { storage: shared.source });
    expect(rowNames()).toEqual(['docs', 'asks']);
  });

  it("from another tab, through the window's storage event", () => {
    const shared = memory();
    renderDashboard(snap(), { storage: shared.source });
    shared.items.set(NOT_NEEDED_KEY, JSON.stringify({ v: 1, entries: [{ id: id(2), hash: needHash(sessions().docs) }] }));
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: NOT_NEEDED_KEY }));
    });
    expect(rowNames()).toEqual(['review', 'asks']);
    shared.items.delete(NOT_NEEDED_KEY);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(rowNames()).toEqual(['review', 'docs', 'asks']);
  });

  it('for the page, when storage throws, and nothing throws', async () => {
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    const { again } = renderDashboard(snap(), { storage: () => ({ getItem: denied, setItem: denied }) });
    fireEvent.click(toggle('review'));
    expect(rowNames()).toEqual(['docs', 'asks']);
    again(snap(sessions({ review: { needsYou: { reason: 'blocked' } } })));
    await settle();
    expect(rowNames()).toEqual(['review', 'docs', 'asks']);
  });
});
