// Hiding groups from the repo list (W35): the header's Hide from repo list and Show in repo list, the
// Hidden section at the list's foot, what hiding leaves alone, storage per root, selection, focus,
// toasts, the URL, the keyboard, and the drawer and the overlay below 900 and 1,200 px.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexSnapshot } from '../../../src/shared/protocol.js';
import type { StorageSource } from '../groupState.js';
import { hiddenKey } from '../hidden.js';
import { memoryNavigation, type NavigationEnv } from '../selection.js';
import { group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { toastMessages } from '../test/toasts.js';
import { Dashboard, hiddenText, unhiddenText } from './Dashboard.js';
import { HIDE_LABEL, SHOW_LABEL } from './HideButton.js';

const ROOT = '/Users/example/code';
const WORK = '/Users/example/work';
const key = (name: string, root = ROOT) => `${root}/${name}`;
const worked = (...names: string[]) => names.map((name, index) => ({ key: key(name), label: name, calls: 20 - index, changes: 1, lastAt: minutesAgo(index + 1) }));

/**
 * Six sessions in four groups, three of which need you. `multi` started in app and worked in old, and
 * it needs you; it's listed under app alone (W39). Nothing started in docs, which multi worked in too,
 * so it has no group.
 */
function several() {
  const waits = session({ name: 'waits', cwd: key('app'), status: 'waiting', waitingFor: 'permission prompt' });
  const multi = session({ name: 'multi', cwd: key('app'), askedYou: { reason: 'question', excerpt: 'Keep the made-up flag?' }, workedIn: worked('old', 'docs') });
  const calm = session({ name: 'calm', cwd: key('app') });
  const inOld = session({ name: 'in-old', cwd: key('old'), status: 'waiting', waitingFor: 'permission prompt' });
  const notes = session({ name: 'note-taker', cwd: key('notes') });
  const inRoot = session({ name: 'in-root', cwd: ROOT });
  const groups = {
    root: group({ key: ROOT, label: 'code', kind: 'directory', sessions: [inRoot] }),
    app: group({ key: key('app'), label: 'app', sessions: [waits, multi, calm] }),
    notes: group({ key: key('notes'), label: 'notes', kind: 'directory', sessions: [notes] }),
    old: group({ key: key('old'), label: 'old', sessions: [inOld] }),
  };
  return { snap: snapshot(Object.values(groups)), groups, waits, multi, calm, inOld, notes, inRoot };
}

/** localStorage-like storage that lasts for the test, so a reload is a new Dashboard on the same storage. */
function memory(initial: Record<string, string> = {}) {
  const items = new Map<string, string>(Object.entries(initial));
  const source: StorageSource = () => ({ getItem: (name) => items.get(name) ?? null, setItem: (name, value) => void items.set(name, value) });
  return { items, source };
}

interface Options {
  search?: string;
  storage?: StorageSource;
  navigation?: NavigationEnv;
}

function ui(snap: IndexSnapshot, { storage, navigation }: { storage?: StorageSource | undefined; navigation: NavigationEnv }) {
  return <Dashboard view={{ state: 'live', snapshot: snap }} navigation={navigation} {...(storage ? { storage } : {})} />;
}

function renderDashboard(snap: IndexSnapshot, options: Options = {}) {
  const navigation = options.navigation ?? memoryNavigation(options.search ?? '');
  const result = render(ui(snap, { storage: options.storage, navigation }));
  return { ...result, navigation, again: (next: IndexSnapshot) => result.rerender(ui(next, { storage: options.storage, navigation })) };
}

const repoList = () => screen.getByRole('navigation', { name: 'Repos' });

/** A repo list item, by its label as shown: one of the list's own, not a hidden one. */
function repoItem(label: string): HTMLAnchorElement {
  const item = [...document.querySelectorAll<HTMLAnchorElement>('a[data-repo-item]')].find((link) => link.querySelector('.repo-item-label')?.textContent === label);
  if (!item) throw new Error(`no repo list item ${label}`);
  return item;
}

/** What each of the list's own items says, label and count, with the text only screen readers get. */
const repoItems = () => [...repoList().querySelectorAll('a[data-repo-item]')].map((link) => link.textContent ?? '');

const hiddenToggle = () => repoList().querySelector<HTMLButtonElement>('.repo-hidden-toggle');

/** What each hidden group's link says, as the list's own items do. */
const hiddenItems = () => [...repoList().querySelectorAll('[data-hidden-entry] a')].map((link) => link.textContent ?? '');

function hiddenLink(label: string): HTMLAnchorElement {
  const link = [...repoList().querySelectorAll<HTMLAnchorElement>('[data-hidden-entry] a')].find((candidate) => candidate.querySelector('.repo-item-label')?.textContent === label);
  if (!link) throw new Error(`no hidden entry ${label}`);
  return link;
}

const unhideButton = (label: string) => within(repoList()).getByRole('button', { name: `Unhide ${label}` });

const listHeading = () => within(screen.getByRole('main')).getByRole('heading', { level: 2 });
const headerButton = () => document.querySelector<HTMLButtonElement>('.session-list-hide');
const visibleRowNames = () => screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent ?? '');
const summary = () => document.querySelector('.session-list .summary')?.textContent ?? '';

function choose(label: string) {
  fireEvent.click(repoItem(label));
}

/** Selects `label` and presses Hide from repo list, with focus on it first, as a keyboard or a pointer in Chrome leaves it. */
function hide(label: string) {
  choose(label);
  const button = screen.getByRole('button', { name: HIDE_LABEL });
  button.focus();
  fireEvent.click(button);
  return button;
}

function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

describe('Hide from repo list, in the session list header', () => {
  it("is there for a group, git or directory, the root's own included, and not for Needs you or All sessions", () => {
    renderDashboard(several().snap);
    expect(headerButton()).toBeNull();
    choose('Needs you');
    expect(headerButton()).toBeNull();
    for (const label of ['app', 'notes', '~/code']) {
      choose(label);
      const button = screen.getByRole('button', { name: HIDE_LABEL });
      expect(button).toBe(headerButton());
      // In the heading's line, after the summary, and not inside the heading.
      expect(button.closest('.session-list-title-row')).toBeTruthy();
      expect(button.closest('h2')).toBeNull();
      expect(button.previousElementSibling?.className).toBe('summary');
      expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it("isn't there for a selected group that has left the snapshot and isn't hidden", () => {
    renderDashboard(several().snap, { search: `?repo=${key('gone')}` });
    expect(screen.getByText('No sessions in gone now')).toBeTruthy();
    expect(headerButton()).toBeNull();
  });

  it('hides a git repo: only its entry leaves the repo list, and the views, their counts, other groups and every list stay as they were', () => {
    renderDashboard(several().snap);
    const before = repoItems();
    expect(before).toEqual(['Needs you3 need you', 'All sessions6 sessions', '~/code, directory1 session', 'app, git repo2 need you', 'notes, directory1 session', 'old, git repo1 needs you']);
    choose('All sessions');
    const allRows = visibleRowNames().sort();
    choose('Needs you');
    const needRows = visibleRowNames().sort();
    choose('app');
    const appRows = visibleRowNames().sort();

    hide('old');
    expect(repoItems()).toEqual(before.filter((item) => !item.startsWith('old')));
    expect(document.title).toBe('(3) pitwall');
    // Its sessions still show under the group, and in every view.
    expect(visibleRowNames().sort()).toEqual(['in-old']);
    choose('All sessions');
    expect(visibleRowNames().sort()).toEqual(allRows);
    expect(summary()).toBe('6 sessions3 need you');
    choose('Needs you');
    expect(visibleRowNames().sort()).toEqual(needRows);
    expect(summary()).toBe('3 sessions3 need you');
    choose('app');
    expect(visibleRowNames().sort()).toEqual(appRows);
    expect(summary()).toBe('3 sessions2 need you');
  });

  it("hides a directory, and the root's own group, the same way", () => {
    renderDashboard(several().snap);
    hide('notes');
    hide('~/code');
    expect(repoItems()).toEqual(['Needs you3 need you', 'All sessions6 sessions', 'app, git repo2 need you', 'old, git repo1 needs you']);
    expect(hiddenItems()).toEqual(['~/code, directory1 session', 'notes, directory1 session']);
    // The rows of All sessions still name their groups.
    choose('All sessions');
    expect(visibleRowNames()).toContain('note-taker');
    expect(visibleRowNames()).toContain('in-root');
  });

  it('keeps the group selected, opens the Hidden section on it, and keeps focus on the button, now Show in repo list', () => {
    const { navigation } = renderDashboard(several().snap);
    const button = hide('old');
    expect(navigation.location.search).toBe(`?repo=${key('old')}`);
    expect(listHeading().textContent).toBe('old, git repo');
    expect(hiddenToggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(hiddenLink('old').getAttribute('aria-current')).toBe('page');
    expect(hiddenLink('old').className).toContain('selected');
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-label')).toBe(SHOW_LABEL);
  });

  it('confirms each hide and unhide with a toast that says where the group went', () => {
    renderDashboard(several().snap);
    hide('old');
    expect(toastMessages()).toEqual(["Hid old. It's under Hidden, at the foot of the repo list."]);
    expect(hiddenText('old')).toBe(toastMessages()[0]);
    fireEvent.click(screen.getByRole('button', { name: SHOW_LABEL }));
    expect(toastMessages()).toContain("Unhid old. It's back in the repo list.");
    expect(unhiddenText('old', false)).toBe("Unhid old. It's back in the repo list once it has sessions.");
    // In the toasts' live region, which was there before them.
    expect(document.querySelector('.toasts')?.getAttribute('aria-live')).toBe('polite');
  });

  it('shows the group again from the same button, back in its place, with focus staying on it', () => {
    renderDashboard(several().snap);
    const button = hide('old');
    fireEvent.click(button);
    expect(repoItems().at(-1)).toBe('old, git repo1 needs you');
    expect(hiddenToggle()).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-label')).toBe(HIDE_LABEL);
    expect(repoItem('old').getAttribute('aria-current')).toBe('page');
  });

  it("leaves the session view's Started in … · worked in … line as it was", () => {
    setWidth(1300);
    const { snap, multi } = several();
    renderDashboard(snap, { search: `?repo=${key('app')}&session=${multi.sessionId}` });
    const line = () => document.querySelector('#session-view .session-view-worked-text')?.textContent;
    expect(line()).toContain('Started in app');
    expect(line()).toContain('worked in old, docs');
    const before = line();
    fireEvent.click(screen.getByRole('button', { name: HIDE_LABEL }));
    expect(line()).toBe(before);
    expect(document.querySelector('#session-view')).toBeTruthy();
  });
});

describe('the Hidden section', () => {
  it('is absent when nothing is hidden', () => {
    renderDashboard(several().snap);
    expect(hiddenToggle()).toBeNull();
    expect(repoList().querySelectorAll('hr')).toHaveLength(1);
  });

  it('is a disclosure, collapsed by default, after the groups, whose open state is remembered', () => {
    const { source, items } = memory({ [hiddenKey(ROOT)]: JSON.stringify({ v: 1, open: false, groups: [{ key: key('old'), label: 'old', kind: 'git' }] }) });
    const first = renderDashboard(several().snap, { storage: source });
    const toggle = hiddenToggle() as HTMLButtonElement;
    expect(toggle.textContent).toBe('Hidden (1)1 needs you');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const list = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(list?.hidden).toBe(true);
    // After every group: the last of the list's own items comes before it.
    expect(repoItem('notes').compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(list?.hidden).toBe(false);
    expect(JSON.parse(items.get(hiddenKey(ROOT)) ?? 'null').open).toBe(true);

    first.unmount();
    renderDashboard(several().snap, { storage: source });
    expect(hiddenToggle()?.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(hiddenToggle() as HTMLButtonElement);
    expect(JSON.parse(items.get(hiddenKey(ROOT)) ?? 'null').open).toBe(false);
  });

  it('carries the needs-you badge when any session in a hidden group needs you, counting each session once', () => {
    renderDashboard(several().snap);
    hide('notes');
    expect(hiddenToggle()?.querySelector('.badge')).toBeNull();
    expect(hiddenToggle()?.textContent).toBe('Hidden (1)');
    hide('old');
    // multi worked in old, but it's listed under app, so old's badge counts in-old alone (W39).
    expect(hiddenToggle()?.textContent).toBe('Hidden (2)1 needs you');
    hide('app');
    expect(hiddenToggle()?.querySelector('.badge-attention')?.textContent).toBe('3 need you');
    expect(hiddenToggle()?.textContent).toBe('Hidden (3)3 need you');
  });

  it('lists each hidden group muted, with its count or need-you badge as the list shows them, and "No sessions" for one the snapshot lacks', () => {
    const { source } = memory({
      [hiddenKey(ROOT)]: JSON.stringify({ v: 1, open: true, groups: [{ key: key('old'), label: 'old', kind: 'git' }, { key: key('notes'), label: 'notes', kind: 'directory' }, { key: key('gone'), label: 'gone', kind: 'git' }] }),
    });
    renderDashboard(several().snap, { storage: source });
    expect(hiddenItems()).toEqual(['gone, git repoNo sessions', 'notes, directory1 session', 'old, git repo1 needs you']);
    expect(hiddenLink('notes').className).toContain('hidden-item');
    expect(hiddenLink('notes').getAttribute('href')).toBe(`?repo=${key('notes')}`);
    expect(hiddenLink('old').querySelector('.badge-attention')?.textContent).toBe('1 needs you');
    expect(unhideButton('gone').querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    // The badge counts only what the snapshot has.
    expect(hiddenToggle()?.textContent).toBe('Hidden (3)1 needs you');
  });

  it('lists a hidden repo that sessions only worked in with "No sessions", since it has no group (W39)', () => {
    const { source } = memory({ [hiddenKey(ROOT)]: JSON.stringify({ v: 1, open: true, groups: [{ key: key('docs'), label: 'docs', kind: 'git' }] }) });
    renderDashboard(several().snap, { storage: source });
    expect(hiddenItems()).toEqual(['docs, git repoNo sessions']);
    expect(hiddenToggle()?.textContent).toBe('Hidden (1)');
    // multi, which worked there, is in app, and still counted in the views.
    expect(repoItems()).toContain('app, git repo2 need you');
    expect(repoItems()).toContain('All sessions6 sessions');
  });

  it('keeps an entry while its group is absent from the snapshot, and when it comes back', () => {
    const { snap, groups } = several();
    const { again } = renderDashboard(snap);
    hide('notes');
    choose('All sessions');
    again(snapshot([groups.root, groups.app, groups.old]));
    expect(hiddenItems()).toEqual(['notes, directoryNo sessions']);
    expect(repoItems().some((item) => item.startsWith('notes'))).toBe(false);
    again(snap);
    expect(hiddenItems()).toEqual(['notes, directory1 session']);
    expect(repoItems().some((item) => item.startsWith('notes'))).toBe(false);
  });

  it("lists each root's hidden groups under its path when pitwall watches more than one", () => {
    const snap = snapshot(
      [group({ key: key('app'), label: 'app', root: ROOT, sessions: [session({ name: 'a' })] }), group({ key: key('svc', WORK), label: 'svc', root: WORK, sessions: [session({ name: 's', cwd: key('svc', WORK) })] })],
      { roots: [ROOT, WORK] },
    );
    renderDashboard(snap);
    hide('svc');
    hide('app');
    const section = repoList().querySelector('.repo-hidden-list') as HTMLElement;
    const lists = within(section).getAllByRole('list');
    expect(lists.map((list) => document.getElementById(list.getAttribute('aria-labelledby') ?? '')?.textContent)).toEqual(['~/code', '~/work']);
    expect(within(lists[1] as HTMLElement).getByRole('link').getAttribute('href')).toBe(`?repo=${key('svc', WORK)}&root=${WORK}`);
  });

  it("selects a hidden group from its link, so its sessions show in the session list as usual, and leaves a modified click to the browser", () => {
    const { navigation } = renderDashboard(several().snap);
    hide('old');
    choose('All sessions');
    fireEvent.click(hiddenLink('old'));
    expect(navigation.location.search).toBe(`?repo=${key('old')}`);
    expect(listHeading().textContent).toBe('old, git repo');
    expect(visibleRowNames().sort()).toEqual(['in-old']);
    expect(hiddenLink('old').getAttribute('aria-current')).toBe('page');
    expect(headerButton()?.getAttribute('aria-label')).toBe(SHOW_LABEL);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    choose('All sessions');
    hiddenLink('old').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("unhides from the section: the group is back in its place, with focus on its item, and the section goes once it's empty", () => {
    renderDashboard(several().snap);
    hide('old');
    hide('notes');
    choose('All sessions');
    unhideButton('notes').focus();
    fireEvent.click(unhideButton('notes'));
    expect(repoItems()).toContain('notes, directory1 session');
    expect(document.activeElement).toBe(repoItem('notes'));
    // The item it landed on is the list's one Tab stop.
    expect(repoItem('notes').tabIndex).toBe(0);
    expect(toastMessages()).toContain("Unhid notes. It's back in the repo list.");
    expect(hiddenItems()).toEqual(['old, git repo1 needs you']);

    fireEvent.click(unhideButton('old'));
    expect(document.activeElement).toBe(repoItem('old'));
    expect(hiddenToggle()).toBeNull();
    expect(repoList().querySelector('.repo-hidden')).toBeNull();
  });

  it('unhides a group with no sessions: focus goes to the next Unhide, or the one before, then the list’s Tab stop', () => {
    const entry = (name: string) => ({ key: key(name), label: name, kind: 'git' });
    const { source } = memory({ [hiddenKey(ROOT)]: JSON.stringify({ v: 1, open: true, groups: [entry('gone-a'), entry('gone-b'), entry('gone-c')] }) });
    renderDashboard(several().snap, { storage: source });
    fireEvent.click(unhideButton('gone-b'));
    expect(toastMessages()).toContain("Unhid gone-b. It's back in the repo list once it has sessions.");
    expect(document.activeElement).toBe(unhideButton('gone-c'));
    fireEvent.click(unhideButton('gone-c'));
    expect(document.activeElement).toBe(unhideButton('gone-a'));
    fireEvent.click(unhideButton('gone-a'));
    expect(hiddenToggle()).toBeNull();
    expect(document.activeElement).toBe(repoItem('All sessions'));
  });
});

describe('hidden groups and the URL', () => {
  it('opens a hidden group from a link or a URL, with its sessions, and Show in repo list', () => {
    const { source } = memory({ [hiddenKey(ROOT)]: JSON.stringify({ v: 1, open: false, groups: [{ key: key('old'), label: 'old', kind: 'git' }] }) });
    renderDashboard(several().snap, { storage: source, search: `?repo=${key('old')}` });
    expect(listHeading().textContent).toBe('old, git repo');
    expect(visibleRowNames().sort()).toEqual(['in-old']);
    expect(headerButton()?.getAttribute('aria-label')).toBe(SHOW_LABEL);
    // The section keeps the state it was left in.
    expect(hiddenToggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(hiddenLink('old').getAttribute('aria-current')).toBe('page');
  });

  it("shows a hidden group that has left the snapshot by its kind, with its empty state, and Show in repo list", () => {
    const { source } = memory({ [hiddenKey(ROOT)]: JSON.stringify({ v: 1, open: true, groups: [{ key: key('gone'), label: 'gone', kind: 'directory' }] }) });
    renderDashboard(several().snap, { storage: source });
    fireEvent.click(hiddenLink('gone'));
    expect(listHeading().textContent).toBe('gone, directory');
    expect(screen.getByText('No sessions in gone now')).toBeTruthy();
    const button = screen.getByRole('button', { name: SHOW_LABEL });
    button.focus();
    fireEvent.click(button);
    expect(toastMessages()).toContain("Unhid gone. It's back in the repo list once it has sessions.");
    expect(hiddenToggle()).toBeNull();
    // Not hidden and not in the snapshot: nothing to hide, so no button, and focus goes to the heading rather than the page.
    expect(headerButton()).toBeNull();
    expect(document.activeElement).toBe(listHeading());
  });
});

describe('hidden groups in storage', () => {
  it("keeps each root's under its own key, so two pitwalls with different roots keep separate lists", () => {
    const { source, items } = memory();
    const one = snapshot([group({ key: key('app'), label: 'app', sessions: [session({ name: 'a' })] })]);
    const first = renderDashboard(one, { storage: source });
    hide('app');
    expect(JSON.parse(items.get(hiddenKey(ROOT)) ?? 'null')).toEqual({ v: 1, open: true, groups: [{ key: key('app'), label: 'app', kind: 'git' }] });
    first.unmount();

    // Another root, on the same origin: none of the first root's.
    const other = snapshot([group({ key: key('app', WORK), label: 'app', root: WORK, sessions: [session({ name: 'w', cwd: key('app', WORK) })] })], { roots: [WORK] });
    const second = renderDashboard(other, { storage: source });
    expect(hiddenToggle()).toBeNull();
    expect(repoItems()).toContain('app, git repo1 session');
    second.unmount();

    // Both roots: each root's key is read, and a hide writes its own root's.
    const both = snapshot([...one.groups, ...other.groups], { roots: [ROOT, WORK] });
    renderDashboard(both, { storage: source });
    expect(hiddenItems()).toEqual(['app, git repo1 session']);
    expect(hiddenLink('app').getAttribute('href')).toBe(`?repo=${key('app')}&root=${ROOT}`);
    fireEvent.click(repoItem('app'));
    fireEvent.click(screen.getByRole('button', { name: HIDE_LABEL }));
    expect(JSON.parse(items.get(hiddenKey(WORK)) ?? 'null').groups).toEqual([{ key: key('app', WORK), label: 'app', kind: 'git' }]);
    expect(JSON.parse(items.get(hiddenKey(ROOT)) ?? 'null').groups).toEqual([{ key: key('app'), label: 'app', kind: 'git' }]);
  });

  it('stores paths and labels only, no session content, and reads them back after a reload', () => {
    const { source, items } = memory();
    const first = renderDashboard(several().snap, { storage: source });
    hide('old');
    const value = items.get(hiddenKey(ROOT)) ?? '';
    expect(value).toBe('{"v":1,"open":true,"groups":[{"key":"/Users/example/code/old","label":"old","kind":"git"}]}');
    for (const text of ['in-old', 'multi', 'Keep the made-up flag', 'permission prompt', 'run the tests']) expect(value).not.toContain(text);
    first.unmount();
    renderDashboard(several().snap, { storage: source });
    expect(repoItems().some((item) => item.startsWith('old'))).toBe(false);
    expect(hiddenItems()).toEqual(['old, git repo1 needs you']);
  });

  it('starts with nothing hidden when storage is missing, throws or holds a bad shape, and hiding still works for the page’s life', () => {
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    const cases: [string, StorageSource][] = [
      ['missing', () => null],
      ['throws on access', denied],
      ['throws on use', () => ({ getItem: denied, setItem: denied })],
      ['a bad shape', memory({ [hiddenKey(ROOT)]: JSON.stringify({ v: 1, groups: 'old' }) }).source],
      ['another version', memory({ [hiddenKey(ROOT)]: JSON.stringify({ v: 2, open: true, groups: [{ key: key('old'), label: 'old', kind: 'git' }] }) }).source],
      ['not JSON', memory({ [hiddenKey(ROOT)]: '{"v":1,' }).source],
    ];
    for (const [name, storage] of cases) {
      const view = renderDashboard(several().snap, { storage });
      expect(hiddenToggle(), name).toBeNull();
      expect(() => hide('old'), name).not.toThrow();
      expect(hiddenItems(), name).toEqual(['old, git repo1 needs you']);
      fireEvent.click(hiddenToggle() as HTMLButtonElement);
      expect(hiddenToggle()?.getAttribute('aria-expanded'), name).toBe('false');
      fireEvent.click(screen.getByRole('button', { name: SHOW_LABEL }));
      expect(hiddenToggle(), name).toBeNull();
      view.unmount();
    }
  });
});

describe('hidden groups and the keyboard', () => {
  it("makes the disclosure, the links and Unhide Tab stops of their own, and leaves the list's ↓, ↑, Home and End to its own items", () => {
    renderDashboard(several().snap);
    hide('old');
    choose('All sessions');
    const toggle = hiddenToggle() as HTMLButtonElement;
    // Its own Tab stop, outside the list's roving one.
    expect(toggle.tabIndex).toBe(0);
    expect(hiddenLink('old').tabIndex).toBe(0);
    expect(hiddenLink('old').hasAttribute('data-repo-item')).toBe(false);
    expect(unhideButton('old').tabIndex).toBe(0);
    const stops = () => [...repoList().querySelectorAll('a[data-repo-item]')].filter((link) => link.getAttribute('tabindex') === '0');
    expect(stops()).toEqual([repoItem('All sessions')]);

    repoItem('All sessions').focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement).toBe(repoItem('notes'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(repoItem('notes'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(document.activeElement).toBe(repoItem('Needs you'));

    // The arrows do nothing on the section's controls, which the browser may use to scroll.
    hiddenLink('old').focus();
    const arrow = fireEvent.keyDown(hiddenLink('old'), { key: 'ArrowUp' });
    expect(arrow).toBe(true);
    expect(document.activeElement).toBe(hiddenLink('old'));
    // A link activates on Enter with a click, which the list handles without a reload.
    fireEvent.click(hiddenLink('old'));
    expect(listHeading().textContent).toBe('old, git repo');
    expect(document.activeElement).toBe(hiddenLink('old'));

    // Enter or Space on a button is a click.
    toggle.focus();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);
    unhideButton('old').focus();
    fireEvent.click(unhideButton('old'));
    expect(document.activeElement).toBe(repoItem('old'));
  });

  it('hands focus on when a focused item leaves the list: to the one that took its place, or the one before it', () => {
    const { snap, groups } = several();
    const { again } = renderDashboard(snap);
    repoItem('notes').focus();
    again(snapshot([groups.root, groups.app, groups.old]));
    expect(document.activeElement).toBe(repoItem('old'));
    again(snapshot([groups.root, groups.app]));
    expect(document.activeElement).toBe(repoItem('app'));
  });
});

describe('hidden groups below 900 and 1,200 px', () => {
  const repos = () => screen.getByRole('button', { name: 'Repos' });
  const drawer = () => screen.queryByRole('dialog', { name: 'Repos' });

  it("shows the Hidden section in the drawer; choosing a hidden group closes it, with focus on the session list's heading", () => {
    const { source } = memory({ [hiddenKey(ROOT)]: JSON.stringify({ v: 1, open: true, groups: [{ key: key('old'), label: 'old', kind: 'git' }] }) });
    setWidth(600);
    renderDashboard(several().snap, { storage: source });
    fireEvent.click(repos());
    expect(within(drawer() as HTMLElement).getByRole('button', { name: /^Hidden \(1\)/ })).toBeTruthy();
    fireEvent.click(hiddenLink('old'));
    expect(drawer()).toBeNull();
    expect(listHeading().textContent).toBe('old, git repo');
    expect(document.activeElement).toBe(listHeading());
  });

  it('hides from the header with the drawer closed, and unhides in the drawer, focus on the item back in it', () => {
    setWidth(600);
    renderDashboard(several().snap, { search: `?repo=${key('old')}` });
    const button = screen.getByRole('button', { name: HIDE_LABEL });
    button.focus();
    fireEvent.click(button);
    expect(document.activeElement).toBe(button);
    fireEvent.click(repos());
    expect(hiddenToggle()?.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(unhideButton('old'));
    expect(drawer()).toBeTruthy();
    expect(document.activeElement).toBe(repoItem('old'));
  });

  it("keeps Tab inside the drawer, past the Hidden section's controls, and skips them while it's closed", () => {
    const { source } = memory({ [hiddenKey(ROOT)]: JSON.stringify({ v: 1, open: false, groups: [{ key: key('old'), label: 'old', kind: 'git' }] }) });
    setWidth(600);
    renderDashboard(several().snap, { storage: source });
    fireEvent.click(repos());
    const toggle = hiddenToggle() as HTMLButtonElement;
    // Closed: the toggle is the last stop, so Tab from it goes back to the list.
    toggle.focus();
    expect(fireEvent.keyDown(toggle, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(repoItem('All sessions'));
    fireEvent.click(toggle);
    unhideButton('old').focus();
    expect(fireEvent.keyDown(unhideButton('old'), { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(repoItem('All sessions'));
    // From the first stop, Shift+Tab goes to the last: Unhide.
    expect(fireEvent.keyDown(repoItem('All sessions'), { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(unhideButton('old'));
  });

  it('is inert with the rest of the repo list where the session view over the list reaches it, below 1,000 px, and usable from 1,000 px', () => {
    const { snap, calm } = several();
    const { source } = memory({ [hiddenKey(ROOT)]: JSON.stringify({ v: 1, open: true, groups: [{ key: key('old'), label: 'old', kind: 'git' }] }) });
    setWidth(950);
    const view = renderDashboard(snap, { storage: source, search: `?view=all&session=${calm.sessionId}` });
    expect(repoList().hasAttribute('inert')).toBe(true);
    expect(unhideButton('old').closest('[inert]')).toBe(repoList());
    view.unmount();
    setWidth(1100);
    renderDashboard(snap, { storage: source, search: `?view=all&session=${calm.sessionId}` });
    expect(repoList().hasAttribute('inert')).toBe(false);
    fireEvent.click(unhideButton('old'));
    expect(document.activeElement).toBe(repoItem('old'));
    expect(screen.getByRole('dialog', { name: 'calm' })).toBeTruthy();
  });
});
