// Preferences in the app (W59, W42): the header's Preferences button and its dialog, opened and
// closed, focus moving in and back, Tab staying inside, one stop per radio group, each setting
// chosen there, applied at once and stored under its own key, and the dialog taking no single-key
// shortcut. Then each mode of Group sessions by, chosen there, through the repo list, Needs you and
// All sessions, the rows' group labels, the root tabs and their badges, the filter, hidden repos and
// ?session=; the stored mode; and a switch that keeps the selection, or replaces it with focus kept,
// and leaves the session view open. Open running background sessions on is W54's
// (TerminalFirst.test.tsx). Made-up sessions and paths only. Where it started, W39's listing, is in
// Dashboard.test.tsx too.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexSnapshot, WorkedIn } from '../../../src/shared/protocol.js';
import dialogCss from './Dialog.css?raw';
import { BACKGROUND_TAB_KEY } from '../backgroundTab.js';
import { GROUP_BY_KEY, type GroupBy } from '../groupBy.js';
import type { StorageSource } from '../groupState.js';
import { hiddenKey } from '../hidden.js';
import { VIEW_STATE_KEY } from '../selection.js';
import { createShortcutsStore, SHORTCUTS_KEY, ShortcutsStoreContext } from '../shortcuts.js';
import { TERMINAL_FOCUS_KEY } from '../terminalFocus.js';
import { createThemeStore, THEME_KEY, ThemeStoreContext } from '../theme.js';
import { block, declarations, withoutComments } from '../test/css.js';
import { group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { chosenPreference, choosePreference, openPreferences, preferenceGroup, preferenceOption, preferenceOptions, preferencesButton, preferencesDialog } from '../test/preferences.js';
import { shownTooltip } from '../test/tooltips.js';
import { Dashboard } from './Dashboard.js';

const WORK = '/Users/example/work';
const PERSONAL = '/Users/example/personal';
const at = (root: string, name: string) => `${root}/${name}`;
const id = (n: number) => `00000000-0000-4000-8000-0000004200${String(n).padStart(2, '0')}`;
const worked = (root: string, name: string, changes: number, calls: number, minutes = 1): WorkedIn => ({ key: at(root, name), label: name, root, calls, changes, lastAt: minutesAgo(minutes) });
const waiting = { status: 'waiting', waitingFor: 'permission prompt' } as const;

/**
 * Two roots, as the index sends them, each session where it started (W39).
 * - Started in ~/work itself: `big`, which needs you, worked most in evals, which has no group, and
 *   less in blog, under ~/personal; `cross`, which changed blog most, then api; `alone`, which worked
 *   in no repo.
 * - `in-api`, started in api, asked you, and worked in evals: a repo-started session never moves.
 * - `in-web`, in web. Under ~/personal: `in-blog`, waiting, and `p-alone`, in the root itself.
 */
function sessions() {
  const big = session({ sessionId: id(1), name: 'big', cwd: WORK, ...waiting, lastActivityAt: minutesAgo(1), workedIn: [worked(WORK, 'evals', 183, 1642, 1), worked(PERSONAL, 'blog', 4, 120, 30)] });
  const cross = session({ sessionId: id(2), name: 'cross', cwd: WORK, lastActivityAt: minutesAgo(2), workedIn: [worked(PERSONAL, 'blog', 10, 50, 2), worked(WORK, 'api', 1, 60, 3)] });
  const alone = session({ sessionId: id(3), name: 'alone', cwd: WORK, lastActivityAt: minutesAgo(3) });
  const inApi = session({ sessionId: id(4), name: 'in-api', cwd: at(WORK, 'api'), askedYou: { reason: 'question', excerpt: 'Keep the made-up flag?' }, lastActivityAt: minutesAgo(4), workedIn: [worked(WORK, 'evals', 1, 9)] });
  const inWeb = session({ sessionId: id(5), name: 'in-web', cwd: at(WORK, 'web'), lastActivityAt: minutesAgo(5) });
  const inBlog = session({ sessionId: id(11), name: 'in-blog', cwd: at(PERSONAL, 'blog'), ...waiting, lastActivityAt: minutesAgo(6) });
  const pAlone = session({ sessionId: id(12), name: 'p-alone', cwd: PERSONAL, lastActivityAt: minutesAgo(7) });
  return { big, cross, alone, inApi, inWeb, inBlog, pAlone };
}

function twoRoots(list = sessions()): IndexSnapshot {
  const { big, cross, alone, inApi, inWeb, inBlog, pAlone } = list;
  return snapshot(
    [
      group({ key: WORK, label: 'work', kind: 'directory', root: WORK, sessions: [big, cross, alone] }),
      group({ key: at(WORK, 'api'), label: 'api', root: WORK, sessions: [inApi] }),
      group({ key: at(WORK, 'web'), label: 'web', root: WORK, sessions: [inWeb] }),
      group({ key: at(PERSONAL, 'blog'), label: 'blog', root: PERSONAL, sessions: [inBlog] }),
      group({ key: PERSONAL, label: 'personal', kind: 'directory', root: PERSONAL, sessions: [pAlone] }),
    ],
    { roots: [WORK, PERSONAL] },
  );
}

function memory(entries: Record<string, string> = {}): StorageSource & { values: Map<string, string> } {
  const values = new Map(Object.entries(entries));
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  return Object.assign(() => storage, { values });
}

/** A system that prefers light, as matchMedia(DARK_QUERY) would say, which never changes here. */
const lightSystem = { matches: false, addEventListener: () => {} };

/**
 * The Dashboard on made-up storage. The theme and the single-key shortcuts are their stores', which
 * the header and the dialog share, here on storage of their own: `theme` and `shortcuts`.
 */
function renderApp(options: { mode?: GroupBy; search?: string; storage?: StorageSource; snap?: IndexSnapshot; theme?: ReturnType<typeof memory>; shortcuts?: ReturnType<typeof memory> } = {}) {
  const history = fakeHistory(options.search ?? '');
  const storage = options.storage ?? memory(options.mode ? { [GROUP_BY_KEY]: options.mode } : {});
  const theme = options.theme ?? memory();
  const shortcuts = options.shortcuts ?? memory();
  const themeStore = createThemeStore({ storage: theme, darkQuery: () => lightSystem, events: { addEventListener: () => {} } });
  const shortcutsStore = createShortcutsStore({ storage: shortcuts, events: { addEventListener: () => {} } });
  const wrap = (children: ReactNode) => (
    <ThemeStoreContext.Provider value={themeStore}>
      <ShortcutsStoreContext.Provider value={shortcutsStore}>{children}</ShortcutsStoreContext.Provider>
    </ThemeStoreContext.Provider>
  );
  const ui = (snap: IndexSnapshot) => wrap(<Dashboard view={{ state: 'live', snapshot: snap }} navigation={history.navigation} storage={storage} />);
  const result = render(ui(options.snap ?? twoRoots()));
  return { ...result, history, storage, theme, shortcuts, update: (snap: IndexSnapshot) => result.rerender(ui(snap)) };
}

const repoList = () => screen.getByRole('navigation', { name: 'Repos' });
/** Each repo list item's text: its label, kind and count, with what only screen readers get. */
const repoItems = () => [...repoList().querySelectorAll('a[data-repo-item]')].map((link) => link.textContent ?? '');
const repoItem = (label: string) => {
  const item = [...repoList().querySelectorAll<HTMLAnchorElement>('a[data-repo-item]')].find((link) => link.querySelector('.repo-item-label')?.textContent === label);
  if (!item) throw new Error(`no repo list item ${label}`);
  return item;
};
const choose = (label: string) => fireEvent.click(repoItem(label));
const rowNames = () => screen.queryAllByRole('heading', { level: 3 }).filter((heading) => !heading.closest('[role="dialog"]')).map((heading) => heading.textContent ?? '');
const rowItem = (name: string) => {
  const item = screen.getAllByRole('heading', { level: 3 }).find((heading) => heading.textContent === name)?.closest('li');
  if (!item) throw new Error(`no row for ${name}`);
  return item;
};
/** The group label line 2 starts with, in Needs you and All sessions. */
const rowGroup = (name: string) => rowItem(name).querySelector('.session-group')?.textContent?.replace(/ · $/, '');
const listHeading = () => within(screen.getByRole('main')).getByRole('heading', { level: 2 });
const summary = () => document.querySelector('.session-list .summary')?.textContent ?? '';
const tabs = () => screen.getAllByRole('tab').filter((tab) => tab.classList.contains('root-tab'));
const tab = (label: string) => {
  const found = tabs().find((candidate) => candidate.querySelector('.root-tab-label, .middle-ellipsis')?.textContent?.includes(label) || candidate.textContent?.startsWith(label));
  if (!found) throw new Error(`no tab ${label}`);
  return found;
};
const tabNames = () => tabs().map((candidate) => candidate.getAttribute('aria-label') ?? candidate.textContent);
const toasts = () => [...document.querySelectorAll('.toast-message')].map((toast) => toast.textContent);
/** What a radio's line says: the text its aria-describedby names. */
const describedBy = (element: Element) => document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent;
const labelOf = (radio: HTMLInputElement) => radio.labels?.[0]?.textContent;

const GROUP_BY = 'Group sessions by';
const BACKGROUND_TAB = 'Open running background sessions on';
const TERMINAL_FOCUS = 'The terminal takes the keyboard';
const SHORTCUTS = 'Single-key shortcuts';
const THEME = 'Theme';

/** Chooses a mode of Group sessions by in Preferences, by its label, and closes it. */
function groupBy(label: string) {
  choosePreference(GROUP_BY, label);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the Preferences button', () => {
  it('sits after the theme switch, before the keyboard shortcuts button: an icon button named Preferences that opens a dialog', () => {
    renderApp();
    const button = preferencesButton();
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-label')).toBe('Preferences');
    expect(button.hasAttribute('aria-expanded')).toBe(false);
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    const end = [...(document.querySelector('.app-header-end')?.children ?? [])];
    const at = end.indexOf(button);
    expect(at).toBeGreaterThan(0);
    expect(end[at - 1]?.getAttribute('aria-label')).toBe('Theme');
    expect(end[at + 1]?.getAttribute('aria-label')).toBe('Keyboard shortcuts');
    // No menu in the header any more.
    expect(document.querySelector('header [aria-haspopup="menu"]')).toBeNull();
  });
});

describe('the Preferences dialog', () => {
  it('is a modal dialog named Preferences and described by its subtitle, with no footer, so nothing to save', () => {
    renderApp();
    const dialog = openPreferences();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Each change applies at once, and this browser remembers it.');
    expect(dialog.classList.contains('sm')).toBe(true);
    expect(dialog.querySelector('.dialog-foot')).toBeNull();
    expect(within(dialog).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['Close']);
  });

  it('has a section for each area, each named by its heading, and a radio group for each setting in it, each option with its line', () => {
    renderApp();
    const dialog = openPreferences();
    const sections = within(dialog).getAllByRole('region');
    expect(sections.map((section) => document.getElementById(section.getAttribute('aria-labelledby') ?? '')?.textContent)).toEqual(['Repo list', 'Session view', 'Keyboard', 'Appearance']);
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Repo list', 'Session view', 'Keyboard', 'Appearance']);
    const groupsIn = (section: HTMLElement) => within(section).getAllByRole('group').map((each) => each.querySelector('legend')?.textContent);
    expect(sections.map(groupsIn)).toEqual([[GROUP_BY], [BACKGROUND_TAB, TERMINAL_FOCUS], [SHORTCUTS], [THEME]]);
    for (const each of within(dialog).getAllByRole('group')) {
      expect(each.tagName).toBe('FIELDSET');
      expect(each.firstElementChild?.tagName).toBe('LEGEND');
    }
    const options = (setting: string) => preferenceOptions(setting).map((radio) => [labelOf(radio), describedBy(radio), radio.checked]);
    expect(options(GROUP_BY)).toEqual([
      ['Main repo', 'A session started in a root goes under the repo it changed most.', true],
      ['Where it started', 'Each session stays under the repo or directory it started in.', false],
      ['Every repo it worked in', 'A session shows under every repo it worked in, so counts can overlap.', false],
    ]);
    expect(options(BACKGROUND_TAB)).toEqual([
      ['Terminal', 'The session attaches as its view opens, so its terminal is ready to use.', true],
      ['Conversation', 'The session attaches only once you open its Terminal tab.', false],
    ]);
    expect(options(TERMINAL_FOCUS)).toEqual([
      ['When you open it', 'Right after you open the session or its Terminal tab with a click or Enter. Never after a reload, the back button or j and k.', true],
      ['Never', 'Click the terminal, or Tab to it, to type to the session.', false],
    ]);
    expect(options(SHORTCUTS)).toEqual([
      ['On', 'The keys /, n, ?, j, k and s work anywhere, except while you type in a field or the terminal.', true],
      ['Off', "Those keys do nothing, so a stray key or a speech command can't set one off.", false],
    ]);
    expect(describedBy(preferenceGroup(SHORTCUTS))).toBe('The keyboard shortcuts dialog, from the header, lists every key and has this switch too.');
    expect(options(THEME)).toEqual([
      ['System', 'Light or dark as your system is set, and it follows when that changes.', true],
      ['Light', 'Light, whatever your system says. The terminal stays dark.', false],
      ['Dark', 'Dark, whatever your system says.', false],
    ]);
    // Each group's radios share a name no other group has, so the browser keeps them apart.
    const names = within(dialog).getAllByRole('group').map((each) => new Set(within(each).getAllByRole<HTMLInputElement>('radio').map((radio) => radio.name)));
    expect(names.every((set) => set.size === 1)).toBe(true);
    expect(new Set(names.map((set) => [...set][0])).size).toBe(5);
  });

  it('opens on what is stored, for every setting', () => {
    renderApp({
      storage: memory({ [GROUP_BY_KEY]: 'every-repo', [BACKGROUND_TAB_KEY]: 'conversation', [TERMINAL_FOCUS_KEY]: 'never' }),
      shortcuts: memory({ [SHORTCUTS_KEY]: 'off' }),
      theme: memory({ [THEME_KEY]: 'dark' }),
    });
    openPreferences();
    expect([GROUP_BY, BACKGROUND_TAB, TERMINAL_FOCUS, SHORTCUTS, THEME].map(chosenPreference)).toEqual(['Every repo it worked in', 'Conversation', 'Never', 'Off', 'Dark']);
  });

  it("moves focus to the first group's choice as it opens, and back to its button when Escape, Close or the backdrop closes it, without its tooltip", () => {
    renderApp({ mode: 'where-started' });
    const button = preferencesButton();
    act(() => button.focus());
    fireEvent.click(button);
    expect(document.activeElement).toBe(preferenceOption(GROUP_BY, 'Where it started'));
    expect(shownTooltip()).toBeNull();
    // Escape is the dialog's: it closes, and goes no further.
    expect(fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })).toBe(false);
    expect(preferencesDialog()).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(shownTooltip()).toBeNull();

    fireEvent.click(button);
    fireEvent.click(within(openPreferences()).getByRole('button', { name: 'Close' }));
    expect(preferencesDialog()).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    const backdrop = openPreferences().parentElement as HTMLElement;
    fireEvent.pointerDown(backdrop);
    fireEvent.click(backdrop);
    expect(preferencesDialog()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("keeps Tab inside, one stop for each radio group, its choice: from the last group's choice to Close, and back", () => {
    renderApp();
    const dialog = openPreferences();
    const close = within(dialog).getByRole('button', { name: 'Close' });
    // System, the default, is the last group's choice, and the dialog's last stop: Light and Dark aren't stops.
    const system = preferenceOption(THEME, 'System');
    system.focus();
    expect(fireEvent.keyDown(system, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(close);
    expect(fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(system);
    // Choose Dark, and it's the stop instead.
    choosePreference(THEME, 'Dark', { close: false });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(preferenceOption(THEME, 'Dark'));
    // Tab from a choice that isn't the last is the browser's: the dialog leaves it alone.
    const main = preferenceOption(GROUP_BY, 'Main repo');
    main.focus();
    expect(fireEvent.keyDown(main, { key: 'Tab' })).toBe(true);
  });

  it('takes no single-key shortcut while it is open: it is modal', () => {
    renderApp();
    openPreferences();
    fireEvent.keyDown(document.activeElement as Element, { key: 'n' });
    fireEvent.keyDown(document.activeElement as Element, { key: '?' });
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    expect(preferencesDialog()).not.toBeNull();
  });

  it('is the small dialog, at most the window less 96 px tall, whose body is what scrolls, as in a 375 × 540 window', () => {
    renderApp();
    expect(openPreferences().classList.contains('sm')).toBe(true);
    const css = withoutComments(dialogCss);
    const card = declarations(block(css, /\n\.dialog\s*\{/));
    expect(card.filter(([property]) => property === 'max-height').map(([, value]) => value)).toContain('calc(100dvh - 2 * var(--pw-space-12))');
    const body = new Map(declarations(block(css, /\.dialog-body\s*\{/)));
    expect(body.get('overflow-y')).toBe('auto');
    expect(body.get('min-height')).toBe('0');
  });
});

describe('each setting, chosen in Preferences', () => {
  it('Group sessions by: the repo list behind regroups as it is chosen, with the dialog still open and focus on the choice, and it is stored alone', () => {
    const { storage } = renderApp();
    expect(repoItems()).toContain('evals, git repo1 needs you');
    choosePreference(GROUP_BY, 'Where it started', { close: false });
    expect(preferencesDialog()).not.toBeNull();
    expect(document.activeElement).toBe(preferenceOption(GROUP_BY, 'Where it started'));
    expect(repoItems()).toContain('~/work, directory1 needs you');
    expect(repoItems().some((item) => item.startsWith('evals'))).toBe(false);
    choosePreference(GROUP_BY, 'Every repo it worked in', { close: false });
    expect(repoItems()).toContain('evals, git repo2 need you');
    const stored = (storage as ReturnType<typeof memory>).values;
    expect(stored.get(GROUP_BY_KEY)).toBe('every-repo');
    expect([BACKGROUND_TAB_KEY, TERMINAL_FOCUS_KEY].map((key) => stored.has(key))).toEqual([false, false]);
  });

  it('Open running background sessions on and The terminal takes the keyboard: each stored alone, under its own key', () => {
    const storage = memory();
    renderApp({ storage });
    choosePreference(BACKGROUND_TAB, 'Conversation', { close: false });
    expect(storage.values.get(BACKGROUND_TAB_KEY)).toBe('conversation');
    expect(storage.values.has(TERMINAL_FOCUS_KEY)).toBe(false);
    choosePreference(TERMINAL_FOCUS, 'Never', { close: false });
    expect(storage.values.get(TERMINAL_FOCUS_KEY)).toBe('never');
    expect([GROUP_BY_KEY, BACKGROUND_TAB_KEY].map((key) => storage.values.get(key))).toEqual([undefined, 'conversation']);
    choosePreference(TERMINAL_FOCUS, 'When you open it');
    expect(storage.values.get(TERMINAL_FOCUS_KEY)).toBe('after-open');
    openPreferences();
    expect([BACKGROUND_TAB, TERMINAL_FOCUS].map(chosenPreference)).toEqual(['Conversation', 'When you open it']);
  });

  it("Single-key shortcuts: off and on, the same setting as the keyboard shortcuts dialog's switch, under pitwall.shortcuts.v1", () => {
    const { shortcuts } = renderApp();
    choosePreference(SHORTCUTS, 'Off');
    expect(shortcuts.values.get(SHORTCUTS_KEY)).toBe('off');
    // Off: `n` does nothing, and the keyboard shortcuts dialog's switch says so.
    fireEvent.keyDown(document.body, { key: 'n' });
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    const box = screen.getByRole('checkbox', { name: 'Single-key shortcuts' });
    expect((box as HTMLInputElement).checked).toBe(false);
    // On again from there, and Preferences shows it.
    fireEvent.click(box);
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(shortcuts.values.get(SHORTCUTS_KEY)).toBe('on');
    openPreferences();
    expect(chosenPreference(SHORTCUTS)).toBe('On');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'n' });
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeTruthy();
  });

  it("Theme: shown at once, behind the dialog, the same choice as the header's switch, under pitwall.theme.v1", () => {
    const { theme } = renderApp();
    const pressed = () => within(screen.getByRole('banner')).getAllByRole('button', { pressed: true }).map((button) => button.getAttribute('aria-label'));
    expect(pressed()).toEqual(['System theme']);
    choosePreference(THEME, 'Dark', { close: false });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(theme.values.get(THEME_KEY)).toBe('dark');
    expect(pressed()).toEqual(['Dark theme']);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    // The header's switch, the quick way, and Preferences shows its choice.
    fireEvent.click(screen.getByRole('button', { name: 'Light theme' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    openPreferences();
    expect(chosenPreference(THEME)).toBe('Light');
    choosePreference(THEME, 'System');
    expect(theme.values.get(THEME_KEY)).toBe('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('Main repo, the default', () => {
  it("moves a session started in a root itself to the repo it changed most, a group built for it, and leaves the rest where they started", () => {
    renderApp();
    // ~/work: alone stays; big moves to evals, which has no group of its own; cross to blog, under ~/personal.
    expect(repoItems()).toEqual(['Needs you2 need you', 'All sessions4 sessions', 'Starred', '~/work, directory1 session', 'api, git repo1 needs you', 'evals, git repo1 needs you', 'web, git repo1 session']);
    choose('evals');
    expect(listHeading().textContent).toBe('evals, git repo');
    expect(rowNames()).toEqual(['big']);
    expect(summary()).toBe('1 session1 needs you');
    choose('~/work');
    expect(rowNames()).toEqual(['alone']);
    // in-api, started in api, stays there, though it worked in evals.
    choose('api');
    expect(rowNames()).toEqual(['in-api']);
  });

  it("puts a session whose main repo is under another root in that root's tab, its badge and counts included", () => {
    renderApp();
    expect(tabNames()).toEqual(['~/work', '~/personal, 1 needs you']);
    fireEvent.click(tab('~/personal'));
    expect(repoItems()).toEqual(['Needs you1 needs you', 'All sessions3 sessions', 'Starred', '~/personal, directory1 session', 'blog, git repo1 needs you']);
    choose('blog');
    expect(rowNames()).toEqual(['in-blog', 'cross']);
    expect(tabNames()).toEqual(['~/work, 2 need you', '~/personal']);
  });

  it('lists each session once in Needs you and All sessions, each row naming its group, and the counts add up', () => {
    renderApp({ search: `?view=all&root=${WORK}` });
    expect(rowNames()).toEqual(['big', 'in-api', 'alone', 'in-web']);
    expect(['big', 'in-api', 'alone', 'in-web'].map(rowGroup)).toEqual(['evals', 'api', '~/work', 'web']);
    expect(summary()).toBe('4 sessions2 need you');
    choose('Needs you');
    expect(rowNames()).toEqual(['big', 'in-api']);
    expect(rowGroup('big')).toBe('evals');
    // Every root's, each once.
    expect(document.title).toBe('(3) pitwall · ~/work');
  });

  it('selects the group a ?session= is listed under: its main repo, in its tab', () => {
    const { history } = renderApp({ search: `?session=${id(2)}` });
    expect(listHeading().textContent).toBe('blog, git repo');
    expect(tab('~/personal').getAttribute('aria-selected')).toBe('true');
    expect(new URLSearchParams(history.location.search).get('repo')).toBe(at(PERSONAL, 'blog'));
    expect(document.querySelector('#session-view')).not.toBeNull();
  });
});

describe('Where it started', () => {
  it("lists the snapshot's groups as they are, each session where it started (W39)", () => {
    renderApp({ mode: 'where-started' });
    expect(repoItems()).toEqual(['Needs you2 need you', 'All sessions5 sessions', 'Starred', '~/work, directory1 needs you', 'api, git repo1 needs you', 'web, git repo1 session']);
    expect(tabNames()).toEqual(['~/work', '~/personal, 1 needs you']);
    expect(rowNames()).toEqual(['big', 'in-api', 'cross', 'alone', 'in-web']);
    expect(['big', 'cross', 'alone', 'in-api'].map(rowGroup)).toEqual(['~/work', '~/work', '~/work', 'api']);
    fireEvent.click(tab('~/personal'));
    expect(repoItems()).toEqual(['Needs you1 needs you', 'All sessions2 sessions', 'Starred', '~/personal, directory1 session', 'blog, git repo1 needs you']);
  });

  it('selects the group a ?session= started in', () => {
    renderApp({ mode: 'where-started', search: `?session=${id(1)}` });
    expect(listHeading().textContent).toBe('~/work, directory');
  });
});

describe('Every repo it worked in', () => {
  it("lists each session where it started and under every repo it worked in, the root's own group only those that worked in none (W34)", () => {
    renderApp({ mode: 'every-repo' });
    // Distinct sessions per group: 1 + 2 + 2 + 1 = 6, more than All sessions' 5.
    expect(repoItems()).toEqual(['Needs you2 need you', 'All sessions5 sessions', 'Starred', '~/work, directory1 session', 'api, git repo1 needs you', 'evals, git repo2 need you', 'web, git repo1 session']);
    choose('api');
    expect(rowNames().sort()).toEqual(['cross', 'in-api']);
    expect(summary()).toBe('2 sessions1 needs you');
    choose('evals');
    expect(rowNames()).toEqual(['big', 'in-api']);
    choose('~/work');
    expect(rowNames()).toEqual(['alone']);
  });

  it("lists a session in each root's tab it worked in, each tab's badge and counts counting it once", () => {
    renderApp({ mode: 'every-repo' });
    // big worked in blog: ~/personal's badge counts it and in-blog.
    expect(tabNames()).toEqual(['~/work', '~/personal, 2 need you']);
    fireEvent.click(tab('~/personal'));
    expect(repoItems()).toEqual(['Needs you2 need you', 'All sessions4 sessions', 'Starred', '~/personal, directory1 session', 'blog, git repo2 need you']);
    expect(tabNames()).toEqual(['~/work, 2 need you', '~/personal']);
    // The title counts every root's, each session once.
    expect(document.title).toBe('(3) pitwall · ~/personal');
  });

  it('lists each session once in All sessions and Needs you, each row naming where it started, or a root-started session’s main repo', () => {
    renderApp({ mode: 'every-repo', search: `?view=all&root=${WORK}` });
    expect(rowNames()).toEqual(['big', 'in-api', 'cross', 'alone', 'in-web']);
    expect(['big', 'in-api', 'cross', 'alone', 'in-web'].map(rowGroup)).toEqual(['evals', 'api', 'blog', '~/work', 'web']);
    expect(summary()).toBe('5 sessions2 need you');
    choose('Needs you');
    expect(rowNames()).toEqual(['big', 'in-api']);
  });

  it('selects the home group for a ?session=: a root-started session’s main repo, any other’s start', () => {
    const first = renderApp({ mode: 'every-repo', search: `?session=${id(1)}` });
    expect(listHeading().textContent).toBe('evals, git repo');
    first.unmount();
    renderApp({ mode: 'every-repo', search: `?session=${id(4)}` });
    expect(listHeading().textContent).toBe('api, git repo');
  });
});

describe('what stays the same in every mode', () => {
  it.each(['main-repo', 'where-started', 'every-repo'] as const)('%s: the filter finds a session by its name, its group and every repo it worked in', (mode) => {
    renderApp({ mode, search: `?view=all&root=${WORK}` });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'evals' } });
    expect(rowNames().sort()).toEqual(['big', 'in-api']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'blog' } });
    // In ~/work's tab: the sessions there that worked in blog.
    expect(rowNames().sort()).toEqual(mode === 'main-repo' ? ['big'] : ['big', 'cross']);
  });

  it.each(['main-repo', 'where-started', 'every-repo'] as const)("%s: the session view's line 3 says where it started and every repo it worked in", (mode) => {
    renderApp({ mode, search: `?session=${id(1)}` });
    const text = document.querySelector('#session-view .session-view-worked-text');
    const shown = [...(text?.childNodes ?? [])].map((node) => (node instanceof HTMLElement && node.classList.contains('visually-hidden') ? '' : node.textContent)).join('');
    expect(shown).toBe('Started in ~/work · worked in evals, blog');
  });

  it.each(['main-repo', 'every-repo'] as const)('%s: a built group hides like any other, by its key, and stays hidden across a switch', (mode) => {
    const { storage } = renderApp({ mode });
    choose('evals');
    fireEvent.click(screen.getByRole('button', { name: 'Hide from repo list' }));
    expect(repoItems().some((item) => item.startsWith('evals'))).toBe(false);
    expect((storage as ReturnType<typeof memory>).values.get(hiddenKey(WORK))).toBe(JSON.stringify({ v: 1, open: true, groups: [{ key: at(WORK, 'evals'), label: 'evals', kind: 'git' }] }));
    // Its sessions still show in All sessions.
    choose('All sessions');
    expect(rowNames()).toContain('big');
    // Where it started has no evals group: the Hidden section lists it with No sessions.
    groupBy('Where it started');
    const hiddenList = document.querySelector('.repo-hidden-list');
    expect(hiddenList?.textContent).toContain('evals');
    expect(hiddenList?.textContent).toContain('No sessions');
    groupBy(mode === 'main-repo' ? 'Main repo' : 'Every repo it worked in');
    expect(repoItems().some((item) => item.startsWith('evals'))).toBe(false);
    expect(document.querySelector('.repo-hidden-list')?.textContent).not.toContain('No sessions');
  });
});

describe('the stored mode', () => {
  it('is Main repo when nothing is stored, the value is bad, or storage throws, and a switch still works for the page', () => {
    for (const storage of [
      memory(),
      memory({ [GROUP_BY_KEY]: 'by-colour' }),
      (() => {
        throw new Error('blocked');
      }) as StorageSource,
      (() => ({
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      })) as StorageSource,
    ]) {
      const { unmount } = renderApp({ storage });
      expect(repoItems()).toContain('evals, git repo1 needs you');
      groupBy('Where it started');
      expect(repoItems()).toContain('~/work, directory1 needs you');
      unmount();
    }
  });

  it('keeps the mode across a reload, under pitwall.group-by.v1, holding the mode alone', () => {
    const storage = memory();
    const first = renderApp({ storage });
    groupBy('Every repo it worked in');
    expect(storage.values.get(GROUP_BY_KEY)).toBe('every-repo');
    first.unmount();
    renderApp({ storage });
    expect(repoItems()).toContain('evals, git repo2 need you');
  });
});

describe('switching modes', () => {
  it('keeps the selected group when the new mode has it, with no toast', () => {
    const { history } = renderApp({ search: `?repo=${at(WORK, 'api')}&root=${WORK}` });
    const entries = history.entries.length;
    groupBy('Every repo it worked in');
    expect(listHeading().textContent).toBe('api, git repo');
    expect(rowNames().sort()).toEqual(['cross', 'in-api']);
    groupBy('Where it started');
    expect(listHeading().textContent).toBe('api, git repo');
    expect(rowNames()).toEqual(['in-api']);
    expect(history.entries.length).toBe(entries);
    expect(toasts()).toEqual([]);
  });

  it("selects All sessions in the same tab when the new mode hasn't the group, says so in a toast, and keeps focus on the choice, then the button, never the page", () => {
    const { history, storage } = renderApp({ search: `?repo=${at(WORK, 'evals')}&root=${WORK}` });
    expect(listHeading().textContent).toBe('evals, git repo');
    const entries = history.entries.length;
    choosePreference(GROUP_BY, 'Where it started', { close: false });
    expect(document.activeElement).toBe(preferenceOption(GROUP_BY, 'Where it started'));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(listHeading().textContent).toBe('All sessions');
    expect(repoItem('All sessions').getAttribute('aria-current')).toBe('page');
    // The URL is replaced, not pushed, and the stored selection follows it.
    expect(history.entries.length).toBe(entries);
    expect(history.location.search).toBe(`?view=all&root=${WORK}`);
    expect((storage as ReturnType<typeof memory>).values.get(VIEW_STATE_KEY)).toBe(`view=all&root=${WORK}`);
    expect(toasts()).toEqual(['Selected All sessions: evals has no sessions when grouped by where it started.']);
    expect(document.activeElement).toBe(preferencesButton());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("replaces the root's own group the same way once every session started there has moved", () => {
    const list = sessions();
    const snap = twoRoots(list);
    // Only the sessions that worked in repos are left in ~/work itself.
    const work = snap.groups.find((g) => g.key === WORK);
    if (work) work.sessions = [list.big, list.cross];
    renderApp({ mode: 'where-started', snap, search: `?repo=${WORK}&root=${WORK}` });
    expect(listHeading().textContent).toBe('~/work, directory');
    groupBy('Main repo');
    expect(listHeading().textContent).toBe('All sessions');
    expect(toasts()).toEqual(['Selected All sessions: ~/work has no sessions when grouped by main repo.']);
  });

  it.each([
    ['main-repo', 'changed most'],
    ['every-repo', 'worked in'],
  ] as const)("%s: says where a selected root's group went, once every session started there is under its repos", (mode, how) => {
    const list = sessions();
    const snap = twoRoots(list);
    const work = snap.groups.find((g) => g.key === WORK);
    if (work) work.sessions = [list.big, list.cross];
    renderApp({ mode, snap, search: `?repo=${WORK}&root=${WORK}` });
    // Selected, though not listed, so with no kind, as any group that has gone.
    expect(listHeading().textContent).toBe('~/work');
    expect(screen.getByText('No sessions in ~/work now')).toBeTruthy();
    expect(screen.getByText(`Its sessions are listed under the repos they ${how}, as Preferences groups them.`)).toBeTruthy();
  });

  it("keeps the usual sentence for a group the snapshot no longer has", () => {
    renderApp({ search: `?repo=${at(WORK, 'gone')}&root=${WORK}` });
    expect(screen.getByText('Its sessions are no longer listed under these roots.')).toBeTruthy();
  });

  it("replaces another tab's selection quietly, for when that tab is back", () => {
    renderApp({ search: `?repo=${at(WORK, 'evals')}&root=${WORK}` });
    fireEvent.click(tab('~/personal'));
    expect(listHeading().textContent).toBe('All sessions');
    groupBy('Where it started');
    expect(toasts()).toEqual([]);
    fireEvent.click(tab('~/work'));
    expect(listHeading().textContent).toBe('All sessions');
    expect(screen.queryByText(/No sessions in evals/)).toBeNull();
  });

  it('leaves an open session view open, on the same session, whichever group it moves to', () => {
    renderApp({ mode: 'where-started', search: `?view=all&root=${WORK}&session=${id(1)}` });
    const view = () => document.querySelector('#session-view');
    expect(view()?.querySelector('h2')?.textContent).toContain('big');
    for (const label of ['Main repo', 'Every repo it worked in', 'Where it started']) {
      groupBy(label);
      expect(view()?.querySelector('h2')?.textContent, label).toContain('big');
    }
    // The row still says it's open.
    expect(rowItem('big').querySelector('[aria-current="true"]')).not.toBeNull();
  });

  it('groups the next snapshot by the same mode, with no request of its own', () => {
    const { update } = renderApp();
    groupBy('Every repo it worked in');
    // A new snapshot: in-web has now worked in evals too.
    const list = sessions();
    update(twoRoots({ ...list, inWeb: { ...list.inWeb, workedIn: [worked(WORK, 'evals', 1, 3)] } }));
    choose('evals');
    expect(rowNames()).toEqual(['big', 'in-api', 'in-web']);
    expect(summary()).toBe('3 sessions2 need you');
  });
});
