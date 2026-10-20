import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastMessagePath, type IndexSnapshot, type LastMessage, type SessionSummary } from '../../../src/shared/protocol.js';
import { createApiClient } from '../api.js';
import type { ConnectionView } from '../connection.js';
import { FINISHED_STATE_KEY, type StorageSource } from '../groupState.js';
import { memoryNavigation, VIEW_STATE_KEY, type NavigationEnv } from '../selection.js';
import { createReplyLoader, ReplyLoaderContext, type FetchLike } from '../lastMessage.js';
import { group, minutesAgo, mixedSnapshot, NOW, session, snapshot } from '../test/fixtures.js';
import { Dashboard } from './Dashboard.js';

interface RenderOptions {
  /** Open the Finished section after rendering, as most tests look at rows. Default true. */
  expand?: boolean;
  storage?: StorageSource;
  /** The query string the page starts with, such as "?repo=…". Default: none, which is All sessions. */
  search?: string;
  navigation?: NavigationEnv;
}

function renderDashboard(snap: IndexSnapshot | undefined, overrides: Partial<ConnectionView> = {}, options: RenderOptions = {}) {
  const view: ConnectionView = { state: 'live', snapshot: snap, ...overrides };
  const navigation = options.navigation ?? memoryNavigation(options.search ?? '');
  const result = render(<Dashboard view={view} navigation={navigation} {...(options.storage ? { storage: options.storage } : {})} />);
  if (options.expand !== false) expandFinished();
  return { ...result, navigation };
}

function expandFinished() {
  for (const toggle of document.querySelectorAll<HTMLElement>('.finished-toggle[aria-expanded="false"]')) fireEvent.click(toggle);
}

function row(name: string): HTMLElement {
  // By the heading's text rather than its accessible name: happy-dom gives <mark> no display, so
  // dom-accessibility-api puts spaces around a highlighted match, where a browser, with <mark>
  // inline, doesn't.
  const item = screen
    .getAllByRole('heading', { level: 3 })
    .find((heading) => heading.textContent === name)
    ?.closest('li');
  if (!item) throw new Error(`no row for ${name}`);
  return item;
}

/** The repo list. */
function repoList(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Repos' });
}

/** A repo list item, by its label as shown. */
function repoItem(label: string, within: ParentNode = document): HTMLAnchorElement {
  const item = [...within.querySelectorAll<HTMLAnchorElement>('a[data-repo-item]')].find((link) => link.querySelector('.repo-item-label')?.textContent === label);
  if (!item) throw new Error(`no repo list item ${label}`);
  return item;
}

/** What each repo list item says, label and count, with the text only screen readers get. */
function repoItems(): string[] {
  return [...repoList().querySelectorAll('a[data-repo-item]')].map((link) => link.textContent ?? '');
}

/** Chooses a repo list item, as a click would, and opens the Finished section it shows. */
function choose(label: string) {
  fireEvent.click(repoItem(label));
  expandFinished();
}

/** The session list's heading, the selection's name. */
function listHeading(): HTMLElement {
  return screen.getByRole('heading', { level: 2, name: /./, hidden: false });
}

/** The session list's summary. */
function summary(): string {
  return document.querySelector('.session-list .summary')?.textContent ?? '';
}

/** The window's width, which the layout follows: 1,024 px in happy-dom unless a test sets it. */
function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

function visibleRowNames(): string[] {
  return screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent ?? '');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
});

describe('Dashboard header', () => {
  it('shows the roots with the home directory shortened, the connection state and the update age', () => {
    renderDashboard(snapshot([], { roots: ['/Users/example/code', '/srv/projects'] }));

    expect(document.querySelector('.roots')?.textContent).toBe('~/code, /srv/projects');
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('updated 3s ago')).toBeTruthy();

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText('updated 5s ago')).toBeTruthy();
  });

  it('has the theme switch at the right of the header, before and after the first snapshot', () => {
    const { container, rerender } = render(<Dashboard view={{ state: 'connecting', snapshot: undefined }} />);
    const status = () => container.querySelector('header .app-header-end');
    expect(within(status() as HTMLElement).getByRole('group', { name: 'Theme' })).toBeTruthy();

    rerender(<Dashboard view={{ state: 'live', snapshot: snapshot([]) }} />);
    expect(status()?.lastElementChild?.getAttribute('aria-label')).toBe('Theme');
  });

  it("shows a heartbeat's time as the update age, newer than the snapshot's", () => {
    const snap = snapshot([group({ sessions: [session({ name: 'kept' })] })]);
    renderDashboard(snap, { lastPoll: { generatedAt: new Date(NOW - 1_000).toISOString(), source: { ok: true } } });

    expect(screen.getByText('updated 1s ago')).toBeTruthy();
    expect(visibleRowNames()).toEqual(['kept']);
  });

  it('warns when the latest heartbeat says the source failed, even though the snapshot did not', () => {
    const snap = snapshot([group({ sessions: [session({ name: 'kept' })] })]);
    renderDashboard(snap, { lastPoll: { generatedAt: new Date(NOW).toISOString(), source: { ok: false, error: 'timed out' } } });

    expect(screen.getByRole('alert').textContent).toBe('claude agents --json --all failed on the latest poll: timed out');
    expect(visibleRowNames()).toEqual(['kept']);
  });

  it('drops the warning when the latest heartbeat says the source works again', () => {
    const snap = snapshot([], { source: { ok: false, error: 'timed out' } });
    renderDashboard(snap, { lastPoll: { generatedAt: new Date(NOW).toISOString(), source: { ok: true } } });

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the reconnecting state and a note that the list may be out of date', () => {
    renderDashboard(mixedSnapshot(), { state: 'reconnecting' });

    expect(screen.getByText('Reconnecting')).toBeTruthy();
    expect(screen.getByText(/Reconnecting; this list may be out of date/)).toBeTruthy();
  });

  it('warns when the session source failed', () => {
    renderDashboard(snapshot([], { source: { ok: false, error: 'claude: command not found' } }));

    expect(screen.getByRole('alert').textContent).toBe('claude agents --json --all failed on the latest poll: claude: command not found');
  });

  it('shows server error messages until dismissed', () => {
    renderDashboard(mixedSnapshot(), { serverError: 'index crashed' });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('index crashed');
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says when the relay tried to send a message nobody asked for and pitwall blocked it, until dismissed, and again for the next one', () => {
    const alert = { at: minutesAgo(1), detail: "The relay tried to send a message when pitwall hadn’t asked it to. pitwall's gate blocked it.", count: 1, blocked: true };
    const view = (relayAlert: typeof alert) => <Dashboard view={{ state: 'live', snapshot: { ...mixedSnapshot(), relayAlert } }} />;
    const { rerender } = render(view(alert));
    const banner = screen.getByRole('alert');
    expect(banner.className).toContain('warning');
    expect(banner.textContent).toBe(
      "pitwall's relay tried to send a message nobody asked for, and pitwall blocked it. That usually means another session messaged the relay. Once since pitwall started. Latest: The relay tried to send a message when pitwall hadn’t asked it to. pitwall's gate blocked it.Dismiss",
    );
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(view(alert));
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(view({ ...alert, count: 2 }));
    expect(screen.getByRole('alert').textContent).toContain('2 times since pitwall started.');
  });

  it('says more when the relay’s message may have been sent', () => {
    renderDashboard({ ...mixedSnapshot(), relayAlert: { at: minutesAgo(1), detail: "pitwall's gate didn't stop it <b>.", count: 1, blocked: false } });
    const banner = screen.getByRole('alert');
    expect(banner.className).toContain('error');
    expect(banner.textContent).toContain('It may have reached one of your sessions: check their conversations for a message from pitwall-relay.');
    expect(banner.textContent).toContain('pitwall has stopped using it until you restart pitwall.');
    expect(banner.textContent).toContain("Latest: pitwall's gate didn't stop it <b>.");
    expect(banner.querySelector('b')).toBeNull();
  });

  it('counts sessions that need attention, in the repo list, the session list and the tab title', () => {
    renderDashboard(mixedSnapshot());

    expect(repoItem('Needs you').textContent).toBe('Needs you2 need you');
    expect(summary()).toBe('5 sessions2 need you');
    expect(document.title).toBe('(2) pitwall');
  });
});

describe('Dashboard states', () => {
  it('says it is connecting before the first snapshot', () => {
    renderDashboard(undefined, { state: 'connecting' });

    expect(screen.getByText('Connecting to pitwall…')).toBeTruthy();
  });

  it('shows the empty state with the roots', () => {
    renderDashboard(snapshot([], { roots: ['/Users/example/code'] }));

    expect(screen.getByText('No Claude Code sessions under ~/code')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});

describe('the repo list', () => {
  const ROOT = '/Users/example/code';

  it('lists Needs you and All sessions, a divider, then every group alphanumerically, each with one count', () => {
    renderDashboard(mixedSnapshot());

    expect(repoItems()).toEqual([
      'Needs you2 need you',
      'All sessions5 sessions',
      'demo-app, git repo2 need you',
      'legacy, git repo1 session',
      'notes, directory1 session',
    ]);
    expect(repoList().querySelectorAll('hr')).toHaveLength(1);
    // Only a group shows its kind's icon, hidden from assistive technology like every icon.
    expect(repoItem('Needs you').querySelector('svg')).toBeNull();
    expect(repoItem('notes').querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it("counts a group's sessions that need you as a solid badge, or else its sessions, and Needs you shows nothing when nothing does", () => {
    renderDashboard(
      snapshot([
        group({ sessions: [session({ name: 'calm' }), session({ name: 'calm-too' })] }),
        group({ key: `${ROOT}/busy`, label: 'busy', sessions: [session({ name: 'waits', status: 'waiting' })] }),
      ]),
    );

    expect(repoItem('demo-app').querySelector('.badge')).toBeNull();
    expect(repoItem('demo-app').querySelector('.repo-item-count')?.textContent).toBe('2 sessions');
    expect(repoItem('busy').querySelector('.badge-attention')?.textContent).toBe('1 needs you');
    expect(repoItem('busy').querySelector('.repo-item-count')).toBeNull();
    // All sessions always counts; the badge is Needs you's.
    expect(repoItem('All sessions').textContent).toBe('All sessions3 sessions');
    expect(repoItem('Needs you').textContent).toBe('Needs you1 needs you');
  });

  it("shows only the views, with no counts, before the first snapshot, and Needs you's count stays off when nothing needs you", () => {
    const { rerender } = render(<Dashboard view={{ state: 'connecting' }} navigation={memoryNavigation()} />);
    expect(repoItems()).toEqual(['Needs you', 'All sessions']);

    rerender(<Dashboard view={{ state: 'live', snapshot: snapshot([group({ sessions: [session({ name: 'calm' })] })]) }} navigation={memoryNavigation()} />);
    expect(repoItem('Needs you').textContent).toBe('Needs you');
  });

  it("labels the root's own directory with its path, first among its root's groups, and mutes a group whose sessions have all finished", () => {
    const done = { kind: 'background' as const, alive: false, pid: undefined, status: undefined, state: 'done' as const, finished: true };
    renderDashboard(
      snapshot([
        group({ key: `${ROOT}/zeta`, label: 'zeta', sessions: [session({ name: 'z' })] }),
        group({ key: ROOT, label: 'code', kind: 'directory', sessions: [session({ name: 'in-root', cwd: ROOT })] }),
        group({ key: `${ROOT}/archive`, label: 'archive', sessions: [session({ name: 'old', ...done, shortId: 'o1' })] }),
      ]),
    );

    expect(repoItems().slice(2)).toEqual(['~/code, directory1 session', 'archive, git repo1 session', 'zeta, git repo1 session']);
    expect(repoItem('archive').className).toContain('finished');
    expect(repoItem('zeta').className).not.toContain('finished');
    choose('~/code');
    expect(listHeading().textContent).toBe('~/code, directory');
  });

  it("puts each root's groups under its path when there are several roots, and tells two groups with the same key apart", () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A worktree under one root whose main repo is under another: both groups are keyed by the main repo.
    const key = `${ROOT}/demo-app`;
    renderDashboard(
      snapshot(
        [
          group({ key, label: 'demo-app', root: ROOT, sessions: [session({ name: 'in-main' })] }),
          group({ key, label: '~/code/demo-app', root: '/Users/example/worktrees', sessions: [session({ name: 'in-worktree', cwd: '/Users/example/worktrees/demo-app-feature' })] }),
        ],
        { roots: [ROOT, '/Users/example/worktrees'] },
      ),
    );

    const lists = within(repoList()).getAllByRole('list');
    expect(lists.map((list) => list.getAttribute('aria-labelledby') && document.getElementById(list.getAttribute('aria-labelledby')!)?.textContent)).toEqual([
      null,
      '~/code',
      '~/worktrees',
    ]);
    choose('~/code/demo-app');
    expect(visibleRowNames()).toEqual(['in-worktree']);
    expect(listHeading().textContent).toBe('~/code/demo-app, git repoin ~/worktrees');
    choose('demo-app');
    expect(visibleRowNames()).toEqual(['in-main']);
    expect(listHeading().textContent).toBe('demo-app, git repoin ~/code');
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key/);
  });

  it('marks the selection with aria-current="page", and links each item to its selection', () => {
    renderDashboard(mixedSnapshot());

    expect(repoItem('All sessions').getAttribute('aria-current')).toBe('page');
    expect(repoItem('demo-app').getAttribute('aria-current')).toBeNull();
    expect(repoItem('demo-app').getAttribute('href')).toBe('?repo=/Users/example/code/demo-app');
    expect(repoItem('Needs you').getAttribute('href')).toBe('?view=needs-you');

    choose('notes');
    expect(repoItem('notes').getAttribute('aria-current')).toBe('page');
    expect(repoItem('notes').className).toContain('selected');
    expect(repoItem('All sessions').getAttribute('aria-current')).toBeNull();
  });

  it('is one Tab stop: ↓ and ↑ move, Home and End jump to the ends, and Enter selects, leaving focus in the list', () => {
    renderDashboard(mixedSnapshot());
    const stops = () => [...repoList().querySelectorAll('a[data-repo-item]')].filter((link) => link.getAttribute('tabindex') === '0');
    expect(stops()).toEqual([repoItem('All sessions')]);

    repoItem('All sessions').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(repoItem('demo-app'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(repoItem('notes'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(repoItem('notes'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(repoItem('legacy'));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(repoItem('Needs you'));
    // The item focused last is the list's one Tab stop.
    expect(stops()).toEqual([repoItem('Needs you')]);

    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    // A link activates on Enter with a click, which the list handles without a reload.
    fireEvent.click(document.activeElement!);
    expect(listHeading().textContent).toBe('notes, directory');
    expect(document.activeElement).toBe(repoItem('notes'));
  });

  it("leaves a click with a modifier key, which opens a tab, to the browser", () => {
    const { navigation } = renderDashboard(mixedSnapshot());

    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    repoItem('notes').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(navigation.location.search).toBe('?view=all');
  });

  it("keeps its counts while the filter narrows the session list, which covers only the selection", () => {
    renderDashboard(mixedSnapshot());

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'notes' } });
    expect(visibleRowNames()).toEqual(['notes-tidy']);
    expect(repoItems()).toContain('demo-app, git repo2 need you');
    expect(repoItems()).toContain('All sessions5 sessions');
  });
});

describe('the session list', () => {
  const ROOT = '/Users/example/code';
  const finished = { kind: 'background' as const, alive: false, pid: undefined, status: undefined, finished: true };

  function withFinished(): IndexSnapshot {
    return snapshot([
      group({
        sessions: [
          session({ name: 'waits', status: 'waiting' }),
          session({ name: 'idle-one', status: 'idle' }),
          session({ name: 'app-done', ...finished, shortId: 'f1', state: 'done' }),
        ],
      }),
      group({
        key: `${ROOT}/jobs`,
        label: 'jobs',
        sessions: [session({ name: 'job', kind: 'background', shortId: 'j1', status: undefined, state: 'working' }), session({ name: 'job-failed', ...finished, shortId: 'f2', state: 'failed' })],
      }),
    ]);
  }

  const finishedToggle = () => screen.queryByRole('button', { name: /^Finished \(/ });

  it('shows All sessions the first time: every unfinished session from every group, then one Finished section', () => {
    renderDashboard(withFinished(), {}, { expand: false });

    expect(listHeading().textContent).toBe('All sessions');
    // Waiting first; the other two tie on rank and activity, so the session id decides, as in the index.
    expect(visibleRowNames()).toEqual(['waits', 'idle-one', 'job']);
    expect(finishedToggle()?.textContent).toBe('Finished (2)');
    expect(finishedToggle()?.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(finishedToggle()!);
    expect(visibleRowNames()).toEqual(['waits', 'idle-one', 'job', 'app-done', 'job-failed']);
  });

  it("shows a group's own sessions, then its own Finished section, under its name and kind", () => {
    renderDashboard(withFinished(), {}, { expand: false });

    choose('jobs');
    expect(listHeading().textContent).toBe('jobs, git repo');
    expect(listHeading().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(visibleRowNames()).toEqual(['job', 'job-failed']);
    expect(finishedToggle()?.textContent).toBe('Finished (1)');
  });

  it('lists every session that needs you under Needs you, with no Finished section', () => {
    renderDashboard(mixedSnapshot());

    choose('Needs you');
    expect(listHeading().textContent).toBe('Needs you');
    expect(visibleRowNames()).toEqual(['demo-docs', 'demo-worker']);
    expect(finishedToggle()).toBeNull();
  });

  it('summarises the selection: its sessions, "x of y" while the filter hides some, then the need-you badge or "Nothing needs you"', () => {
    renderDashboard(mixedSnapshot());
    expect(summary()).toBe('5 sessions2 need you');
    expect(document.querySelector('.session-list .summary .badge-attention')?.textContent).toBe('2 need you');

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'demo' } });
    expect(summary()).toBe('3 of 5 sessions2 need you');

    choose('notes');
    expect(summary()).toBe('0 of 1 session·Nothing needs you');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(summary()).toBe('1 session·Nothing needs you');
  });

  it('remembers each selection\'s Finished section apart, in pitwall.finished.v1, and never touches pitwall.groups.v1', () => {
    window.localStorage.setItem('pitwall.groups.v1', JSON.stringify({ x: true }));
    const first = renderDashboard(withFinished(), {}, { expand: false });
    fireEvent.click(finishedToggle()!);
    choose('jobs');
    expect(finishedToggle()?.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(finishedToggle()!);
    expect(JSON.parse(window.localStorage.getItem(FINISHED_STATE_KEY) ?? 'null')).toEqual({ 'view:all': true, [`${ROOT}\0${ROOT}/jobs`]: false });
    first.unmount();

    renderDashboard(withFinished(), {}, { expand: false, search: '?view=all' });
    expect(finishedToggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(window.localStorage.getItem('pitwall.groups.v1')).toBe(JSON.stringify({ x: true }));
  });

  it('starts its Finished section collapsed, and still toggles it, when storage throws', () => {
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    renderDashboard(withFinished(), {}, { expand: false, storage: denied });

    expect(finishedToggle()?.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(finishedToggle()!);
    expect(finishedToggle()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('says nothing matched in the selection, offers Clear filters, and in a group, Search all sessions, which keeps the text', () => {
    renderDashboard(mixedSnapshot());
    choose('demo-app');

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'tidy' } });
    expect(visibleRowNames()).toEqual([]);
    expect(screen.getByText('No sessions match')).toBeTruthy();
    expect(screen.getByText('Nothing in demo-app matches "tidy".')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Search all sessions' }));
    expect(listHeading().textContent).toBe('All sessions');
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('tidy');
    expect(visibleRowNames()).toEqual(['notes-tidy']);
  });

  it('offers only Clear filters when nothing matches outside a group, or with only chips on', () => {
    renderDashboard(mixedSnapshot());

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing in All sessions matches "zzz".')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Search all sessions' })).toBeNull();
    fireEvent.click(within(document.querySelector('.session-list-body')!).getByRole('button', { name: 'Clear filters' }));
    expect(visibleRowNames()).toHaveLength(5);

    choose('notes');
    fireEvent.click(screen.getByRole('button', { name: 'Background' }));
    expect(screen.getByText('Nothing in notes matches these filters.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Search all sessions' })).toBeNull();
  });

  it('says so, calmly, when nothing needs you, and offers all sessions', () => {
    renderDashboard(snapshot([group({ sessions: [session({ name: 'calm', status: 'idle' })] })]), {}, { search: '?view=needs-you' });

    expect(screen.getByText('Nothing needs you right now')).toBeTruthy();
    expect(screen.getByText('Sessions that are waiting for you, or asked you something, show here.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all sessions' }));
    expect(visibleRowNames()).toEqual(['calm']);
  });

  it('keeps a selected group that has left the snapshot selected, with its own empty state', () => {
    const view = (snap: IndexSnapshot) => <Dashboard view={{ state: 'live', snapshot: snap }} navigation={navigation} />;
    const navigation = memoryNavigation(`?repo=${ROOT}/legacy`);
    const { rerender } = render(view(mixedSnapshot()));
    expect(visibleRowNames()).toEqual(['legacy-migration']);

    const gone = mixedSnapshot();
    gone.groups = gone.groups.filter((shown) => shown.label !== 'legacy');
    rerender(view(gone));
    expect(listHeading().textContent).toBe('legacy');
    expect(screen.getByText('No sessions in legacy now')).toBeTruthy();
    expect(screen.getByText('Its sessions are no longer listed under these roots.')).toBeTruthy();
    expect(repoList().querySelector('[aria-current]')).toBeNull();
    expect(navigation.location.search).toBe('?repo=/Users/example/code/legacy');

    fireEvent.click(screen.getByRole('button', { name: 'Show all sessions' }));
    expect(listHeading().textContent).toBe('All sessions');
  });

  it('puts the page alerts above its header', () => {
    const { container } = renderDashboard(mixedSnapshot(), { serverError: 'index crashed' });

    const list = container.querySelector('main.session-list')!;
    expect(list.firstElementChild?.className).toBe('session-list-alerts');
    expect(within(list.firstElementChild as HTMLElement).getByRole('alert').textContent).toContain('index crashed');
    expect(list.firstElementChild?.nextElementSibling?.className).toBe('session-list-head');
  });
});

describe('the selection in the URL', () => {
  const ROOT = '/Users/example/code';

  it('selects the group a ?repo= names on load, and the stored selection, or All sessions, otherwise', () => {
    const first = renderDashboard(mixedSnapshot(), {}, { search: `?repo=${ROOT}/notes` });
    expect(listHeading().textContent).toBe('notes, directory');
    first.unmount();

    window.localStorage.setItem(VIEW_STATE_KEY, 'view=needs-you');
    const second = renderDashboard(mixedSnapshot());
    expect(listHeading().textContent).toBe('Needs you');
    expect(second.navigation.location.search).toBe('?view=needs-you');
  });

  it('pushes each choice, stores it, and follows the back button', () => {
    window.history.replaceState(null, '', '/?view=all');
    renderDashboard(mixedSnapshot(), {}, { navigation: window });

    choose('legacy');
    expect(window.location.search).toBe('?repo=/Users/example/code/legacy');
    expect(window.localStorage.getItem(VIEW_STATE_KEY)).toBe('repo=/Users/example/code/legacy');

    act(() => {
      window.history.replaceState(null, '', '/?view=needs-you');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(listHeading().textContent).toBe('Needs you');
  });

  it("selects a ?session='s group when the URL names no selection", () => {
    const snap = mixedSnapshot();
    const tidy = snap.groups[1]!.sessions[0]!;
    const { navigation } = renderDashboard(snap, {}, { search: `?session=${tidy.sessionId}` });

    expect(listHeading().textContent).toBe('notes, directory');
    expect(navigation.location.search).toBe(`?repo=/Users/example/code/notes&session=${tidy.sessionId}`);
  });
});

describe('below 900 px: the repo list is a drawer', () => {
  const repos = () => screen.getByRole('button', { name: 'Repos' });
  const drawer = () => screen.queryByRole('dialog', { name: 'Repos' });

  it('shows the Repos button in place of the repo list, which opens the drawer, modal, focusing the selection', () => {
    setWidth(600);
    renderDashboard(mixedSnapshot());

    expect(screen.queryByRole('navigation', { name: 'Repos' })).toBeNull();
    expect(repos().getAttribute('aria-expanded')).toBe('false');
    expect(repos().getAttribute('aria-haspopup')).toBe('dialog');
    fireEvent.click(repos());

    expect(drawer()?.getAttribute('aria-modal')).toBe('true');
    expect(repos().getAttribute('aria-expanded')).toBe('true');
    expect(within(drawer()!).getByRole('navigation', { name: 'Repos' })).toBeTruthy();
    expect(document.activeElement).toBe(repoItem('All sessions'));
  });

  it("closes on Escape, putting focus back on the Repos button, and the session view behind it stays open", () => {
    setWidth(600);
    renderDashboard(mixedSnapshot());
    fireEvent.click(within(row('notes-tidy')).getByRole('button', { name: 'notes-tidy' }));
    fireEvent.click(repos());

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(repos());
    expect(screen.getByRole('dialog', { name: 'notes-tidy' })).toBeTruthy();
  });

  it('closes on a click on the backdrop, putting focus back on the Repos button', () => {
    setWidth(600);
    renderDashboard(mixedSnapshot());
    fireEvent.click(repos());

    fireEvent.click(document.querySelector('.repo-drawer-backdrop')!);
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(repos());
  });

  it("closes when an item is chosen, and focus moves to the session list's heading", () => {
    setWidth(600);
    renderDashboard(mixedSnapshot());
    fireEvent.click(repos());

    fireEvent.click(repoItem('legacy'));
    expect(drawer()).toBeNull();
    expect(listHeading().textContent).toBe('legacy, git repo');
    expect(document.activeElement).toBe(listHeading());
  });

  it('keeps Tab inside', () => {
    setWidth(600);
    renderDashboard(mixedSnapshot());
    fireEvent.click(repos());

    const event = fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(event).toBe(false);
    expect(document.activeElement).toBe(repoItem('All sessions'));
  });

  it('closes, and the repo list comes back beside the session list, when the window widens past 900 px', () => {
    setWidth(600);
    renderDashboard(mixedSnapshot());
    fireEvent.click(repos());

    setWidth(1000);
    expect(drawer()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Repos' })).toBeNull();
    expect(repoList()).toBeTruthy();
  });
});

describe('from 1,200 px: the session view is the third column', () => {
  it('shows "Select a session" in it with nothing open, as a region, so the layout stays put', () => {
    setWidth(1300);
    const { container } = renderDashboard(mixedSnapshot());

    expect(container.querySelector('.app')?.getAttribute('data-layout')).toBe('three-columns');
    expect(screen.getByRole('region', { name: 'Session' }).textContent).toBe('Select a sessionIts conversation, terminal and actions open here.');
  });

  it('opens a session there as a region named by its title, not a dialog, and closing it brings the empty state back', () => {
    setWidth(1300);
    renderDashboard(mixedSnapshot());

    fireEvent.click(within(row('notes-tidy')).getByRole('button', { name: 'notes-tidy' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const view = screen.getByRole('region', { name: 'notes-tidy' });
    expect(view.className).toContain('in-column');

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'notes-tidy' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Session' })).toBeTruthy();
  });

  it('overlays the session list as a non-modal dialog below 1,200 px', () => {
    renderDashboard(mixedSnapshot());

    fireEvent.click(within(row('notes-tidy')).getByRole('button', { name: 'notes-tidy' }));
    expect(screen.getByRole('dialog', { name: 'notes-tidy' }).getAttribute('aria-modal')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Session' })).toBeNull();
  });
});

describe('session rows', () => {
  it('renders sessions in the order given', () => {
    renderDashboard(mixedSnapshot());

    expect(visibleRowNames()).toEqual(['demo-docs', 'demo-worker', 'demo-api', 'notes-tidy', 'legacy-migration']);
  });

  it('marks waiting and blocked sessions as needing attention, but not stale ones', () => {
    renderDashboard(mixedSnapshot());

    expect(row('demo-docs').dataset.attention).toBe('true');
    expect(within(row('demo-docs')).getByText('waiting: permission prompt').className).toContain('tone-attention');
    expect(row('demo-worker').dataset.attention).toBe('true');
    expect(within(row('demo-worker')).getByText('blocked').className).toContain('tone-attention');

    expect(row('demo-api').dataset.attention).toBeUndefined();
    expect(row('legacy-migration').dataset.attention).toBeUndefined();
    expect(within(row('legacy-migration')).getByText('blocked').className).not.toContain('tone-attention');
  });

  it('shows the stale marker only on stale sessions', () => {
    renderDashboard(mixedSnapshot());

    expect(within(row('legacy-migration')).getByText('stale').getAttribute('title')).toMatch(
      /no activity for more than 7 days, whether or not its process is running/,
    );
    expect(within(row('demo-worker')).queryByText('stale')).toBeNull();
  });

  it('shows kind, status pill text for each state, and not running', () => {
    renderDashboard(
      snapshot([
        group({
          sessions: [
            session({ name: 'a', status: 'busy' }),
            session({ name: 'b', status: 'idle' }),
            session({ name: 'c', kind: 'background', shortId: 'c1', state: 'done', alive: false, status: undefined, finished: true }),
            session({ name: 'd', kind: 'background', shortId: 'd1', state: 'failed', alive: false, status: undefined, finished: true }),
            session({ name: 'e', kind: 'background', shortId: 'e1', state: 'stopped', alive: false, status: undefined, finished: true }),
            session({ name: 'f', alive: false, status: undefined }),
            session({ name: 'g', status: 'waiting', waitingFor: 'a brand new reason' }),
          ],
        }),
      ]),
    );

    const pill = (name: string) => row(name).querySelector('.pill')?.textContent;
    expect(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(pill)).toEqual([
      'busy',
      'idle',
      'done',
      'failed',
      'stopped',
      'not running',
      'waiting: a brand new reason',
    ]);
    expect(within(row('a')).getByText('interactive')).toBeTruthy();
    expect(within(row('c')).getByText('background')).toBeTruthy();
  });

  it('shows last activity as relative time with the absolute time on hover', () => {
    renderDashboard(mixedSnapshot());

    const time = within(row('demo-docs')).getByText('5m ago');
    expect(time.tagName).toBe('TIME');
    expect(time.getAttribute('dateTime')).toBe('2026-03-02T11:55:00.000Z');
    expect(time.getAttribute('title')).toMatch(/2026/);
  });

  it('shows the last prompt and the last assistant text', () => {
    renderDashboard(mixedSnapshot());

    const docs = row('demo-docs');
    expect(within(docs).getByText('update the getting started guide')).toBeTruthy();
    expect(within(docs).getByText('I need permission to edit docs/quickstart.md.')).toBeTruthy();
  });

  it('expands long assistant text', () => {
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
    renderDashboard(mixedSnapshot());

    const docs = row('demo-docs');
    const more = within(docs).getByRole('button', { name: 'Show more' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(within(docs).getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true');
    expect(within(docs).getByText(/I need permission/).className).toContain('expanded');

    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  });

  it('offers no expand toggle when the text fits', () => {
    renderDashboard(mixedSnapshot());

    expect(within(row('demo-docs')).queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('shows the cwd relative to the group when it is a subdirectory, and the full path when outside it', () => {
    renderDashboard(
      snapshot([
        group({
          key: '/Users/example/code/demo-app',
          sessions: [
            session({ name: 'at-root', cwd: '/Users/example/code/demo-app' }),
            session({ name: 'nested', cwd: '/Users/example/code/demo-app/packages/worker' }),
            session({ name: 'worktree', cwd: '/Users/example/code/demo-app-worktrees/feature' }),
          ],
        }),
      ]),
    );

    expect(row('at-root').querySelector('.cwd')).toBeNull();
    expect(row('nested').querySelector('.cwd')?.textContent).toBe('packages/worker');
    expect(row('worktree').querySelector('.cwd')?.textContent).toBe('~/code/demo-app-worktrees/feature');
  });

  it('shows a missing or unreadable transcript quietly instead of the text fields', () => {
    renderDashboard(
      snapshot([
        group({
          sessions: [
            session({ name: 'gone', transcript: 'missing', lastUserPrompt: 'old prompt', lastAssistantText: 'old reply' }),
            session({ name: 'garbled', transcript: 'unreadable', lastActivityAt: undefined }),
          ],
        }),
      ]),
    );

    expect(within(row('gone')).getByText('Transcript not found')).toBeTruthy();
    expect(within(row('gone')).queryByText('old prompt')).toBeNull();
    expect(within(row('gone')).queryByText('old reply')).toBeNull();
    expect(within(row('garbled')).getByText('Transcript unreadable')).toBeTruthy();
  });
});

describe('session titles', () => {
  const CLAUDE_CODE_HINT = "Claude Code's title, from the session's first prompt";

  it("shows Claude Code's title after the name, muted, with where it came from on hover", () => {
    renderDashboard(
      snapshot([group({ sessions: [session({ name: 'git-a0', title: 'Review the auth flow', titleSource: 'claude-code' })] })]),
    );

    const head = row('git-a0').querySelector('.session-ident');
    expect(head?.textContent).toBe('git-a0·Review the auth flow');
    expect(head?.querySelector('.session-title-sep')?.getAttribute('aria-hidden')).toBe('true');
    const title = within(row('git-a0')).getByText('Review the auth flow');
    expect(title.className).toBe('session-title');
    expect(title.getAttribute('title')).toBe(`Review the auth flow\n${CLAUDE_CODE_HINT}`);
    // The heading stays the name alone.
    expect(screen.getByRole('heading', { level: 3, name: 'git-a0' })).toBeTruthy();
  });

  it('shows nothing after the name when there is no title', () => {
    renderDashboard(snapshot([group({ sessions: [session({ name: 'untitled' })] })]));

    expect(row('untitled').querySelector('.session-title, .session-title-sep')).toBeNull();
  });

  it('keeps a long title whole in the text and the hover text, for the ellipsis to cut on screen', () => {
    const long = `Investigate why ${'the very long session title '.repeat(4)}keeps going`;
    renderDashboard(snapshot([group({ sessions: [session({ name: 'git-b1', title: long, titleSource: 'claude-code' })] })]));

    const title = row('git-b1').querySelector('.session-title');
    expect(title?.textContent).toBe(long);
    expect(title?.getAttribute('title')).toBe(`${long}\n${CLAUDE_CODE_HINT}`);
  });

  it('renders the title as text, not markup', () => {
    const { container } = renderDashboard(
      snapshot([group({ sessions: [session({ name: 'html-title', title: '<img src=x onerror="alert(1)"> <b>t</b>', titleSource: 'claude-code' })] })]),
    );

    expect(container.querySelector('img, b')).toBeNull();
    expect(row('html-title').querySelector('.session-title')?.textContent).toBe('<img src=x onerror="alert(1)"> <b>t</b>');
  });

  it('is matched by the filter, case-insensitively', () => {
    renderDashboard(
      snapshot([
        group({
          sessions: [
            session({ name: 'git-a0', title: 'Review the auth flow', titleSource: 'claude-code' }),
            session({ name: 'git-a1', title: 'Fix the docs build', titleSource: 'claude-code' }),
            session({ name: 'git-a2' }),
          ],
        }),
      ]),
    );

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'AUTH' } });
    expect(visibleRowNames()).toEqual(['git-a0']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'git-a' } });
    expect(visibleRowNames()).toEqual(['git-a0', 'git-a1', 'git-a2']);
  });
});

describe('sessions that asked you something', () => {
  const asked = (excerpt: string, reason: 'open-questions' | 'question' = 'open-questions') => ({ reason, excerpt });

  function askedSnapshot(): IndexSnapshot {
    return snapshot([
      group({
        sessions: [
          session({ name: 'waits', status: 'waiting', waitingFor: 'permission prompt' }),
          session({
            name: 'asks',
            status: 'idle',
            askedYou: asked('Should I push it?'),
            lastAssistantText: 'Fixed the test. Open questions: - Should I push it?',
          }),
          session({ name: 'calm', status: 'idle' }),
        ],
      }),
      group({
        key: '/Users/example/code/docs',
        label: 'docs',
        sessions: [
          session({
            name: 'docs-done',
            kind: 'background',
            shortId: 'bg42',
            state: 'done',
            alive: false,
            pid: undefined,
            status: undefined,
            finished: true,
            cwd: '/Users/example/code/docs',
            askedYou: asked('Want me to open the PR?', 'question'),
          }),
        ],
      }),
    ]);
  }

  it('shows an "asked you" pill, distinct from waiting, on an attention row', () => {
    renderDashboard(askedSnapshot());

    const asks = row('asks');
    expect(asks.dataset.attention).toBe('true');
    expect(asks.className).toContain('attention');
    const pill = within(asks).getByText('asked you');
    expect(pill.className).toContain('pill');
    expect(pill.className).toContain('tone-asked');
    expect(pill.className).not.toContain('tone-attention');
    expect(within(row('waits')).getByText('waiting: permission prompt').className).toContain('tone-attention');
    expect(row('calm').dataset.attention).toBeUndefined();
  });

  it('shows the excerpt above the last reply', () => {
    renderDashboard(askedSnapshot());

    const asks = row('asks');
    const line = asks.querySelector('.asked');
    expect(line?.textContent).toBe('Asked: Should I push it?');
    const reply = within(asks).getByText(/Fixed the test/);
    expect(line && line.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row('docs-done').querySelector('.asked')?.textContent).toBe('Asked: Want me to open the PR?');
    expect(row('calm').querySelector('.asked')).toBeNull();
    expect(row('waits').querySelector('.asked')).toBeNull();
  });

  it('counts them in the repo list, the summary and the tab title, except a finished one', () => {
    renderDashboard(askedSnapshot());

    expect(repoItem('demo-app').querySelector('.badge-attention')?.textContent).toBe('2 need you');
    // docs-done asked something, but it has finished: muted, and not counted.
    expect(repoItem('docs').querySelector('.badge')).toBeNull();
    expect(repoItem('docs').className).toContain('finished');
    expect(summary()).toBe('4 sessions2 need you');
    expect(document.title).toBe('(2) pitwall');
  });

  it('lists them under Needs you, but not a finished one', () => {
    renderDashboard(askedSnapshot());

    choose('Needs you');

    expect(visibleRowNames()).toEqual(['waits', 'asks']);
    expect(screen.queryByRole('button', { name: /^Finished \(/ })).toBeNull();
  });

  it('renders the excerpt as text, not markup', () => {
    const { container } = renderDashboard(
      snapshot([
        group({
          sessions: [session({ name: 'html', askedYou: asked('<img src=x onerror="alert(1)"> keep <b>this</b>?') })],
        }),
      ]),
    );

    expect(container.querySelector('img, b')).toBeNull();
    expect(row('html').querySelector('.asked')?.textContent).toBe('Asked: <img src=x onerror="alert(1)"> keep <b>this</b>?');
  });
});

describe('finished sessions', () => {
  const ROOT = '/Users/example/code';
  const id = (name: string) => `${ROOT}\0${ROOT}/${name}`;
  const finished = { kind: 'background' as const, alive: false, pid: undefined, status: undefined, finished: true };

  function finishedSnapshot(): IndexSnapshot {
    return snapshot([
      group({
        key: `${ROOT}/demo-app`,
        label: 'demo-app',
        sessions: [
          session({ name: 'live-one', status: 'busy' }),
          session({ name: 'idle-done', kind: 'background', shortId: 'bg1', state: 'done', status: 'idle' }),
          session({ name: 'done-one', ...finished, shortId: 'bg2', state: 'done', askedYou: { reason: 'question', excerpt: 'Open the PR?' } }),
          session({ name: 'failed-one', ...finished, shortId: 'bg3', state: 'failed' }),
        ],
      }),
      group({
        key: `${ROOT}/old`,
        label: 'old',
        sessions: [session({ name: 'stopped-one', ...finished, shortId: 'bg4', state: 'stopped', cwd: `${ROOT}/old` })],
      }),
    ]);
  }

  /** With the group `label` selected, and the Finished section as it starts. */
  function render(snap = finishedSnapshot(), storage?: StorageSource, label = 'demo-app') {
    return renderDashboard(snap, {}, { expand: false, search: `?repo=${ROOT}/${label}`, ...(storage ? { storage } : {}) });
  }

  const finishedToggle = () => screen.getByRole('button', { name: /^Finished \(\d+\)/ });
  const finishedOpen = () => finishedToggle().getAttribute('aria-expanded') === 'true';
  const stored = () => JSON.parse(window.localStorage.getItem(FINISHED_STATE_KEY) ?? 'null') as unknown;

  it('lists them in a collapsed "Finished (n)" section at the bottom of the session list', () => {
    render();

    const toggle = finishedToggle();
    expect(toggle.textContent).toBe('Finished (2) · 1 asked you');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const list = document.getElementById(toggle.getAttribute('aria-controls') ?? '')!;
    expect(list.hidden).toBe(true);
    // Collapsed, so only the unfinished rows show. A done session with a live process is idle, not finished.
    expect(visibleRowNames()).toEqual(['live-one', 'idle-done']);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);
    expect(within(list).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['done-one', 'failed-one']);
    // After the other rows.
    const last = document.querySelector('.session-list-body > ul.sessions')!.lastElementChild;
    expect(last?.contains(toggle)).toBe(true);
  });

  it('says on the Finished line how many finished sessions asked something, muted, and never as needing you', () => {
    const asked = { reason: 'question' as const, excerpt: 'Ship it?' };
    render(
      snapshot([
        group({
          key: `${ROOT}/demo-app`,
          sessions: [
            session({ name: 'live-one', status: 'idle' }),
            session({ name: 'f1', ...finished, shortId: 'f1', state: 'done', askedYou: asked }),
            session({ name: 'f2', ...finished, shortId: 'f2', state: 'stopped' }),
            session({ name: 'f3', ...finished, shortId: 'f3', state: 'failed', askedYou: asked }),
          ],
        }),
      ]),
    );

    const toggle = finishedToggle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Finished (3) · 2 asked you');
    const count = toggle.querySelector('.finished-asked');
    expect(count?.textContent).toBe(' · 2 asked you');
    expect(count?.closest('.badge, .tone-asked, .attention')).toBeNull();
    expect(repoItem('demo-app').querySelector('.badge')).toBeNull();
    expect(summary()).toBe('4 sessions·Nothing needs you');
    // Stays the same open, so the button's name doesn't change under the user.
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe('Finished (3) · 2 asked you');
  });

  it('leaves the asked count off a Finished line whose sessions asked nothing', () => {
    render(finishedSnapshot(), undefined, 'old');

    expect(finishedToggle().textContent).toBe('Finished (1)');
    expect(finishedToggle().querySelector('.finished-asked')).toBeNull();
  });

  it('counts finished sessions in the totals, but never as needing you', () => {
    render();

    expect(summary()).toBe('4 sessions·Nothing needs you');
    expect(repoItem('demo-app').textContent).toBe('demo-app, git repo4 sessions');
    expect(repoItem('Needs you').textContent).toBe('Needs you');
    expect(document.title).toBe('pitwall');
  });

  it('mutes finished rows, with the state as the pill and a muted asked-you badge', () => {
    render();
    fireEvent.click(finishedToggle());

    const done = row('done-one');
    expect(done.className).toContain('finished');
    expect(done.className).not.toContain('attention');
    expect(done.dataset.attention).toBeUndefined();
    const pills = [...done.querySelectorAll('.pill')];
    expect(pills.map((p) => p.textContent)).toEqual(['done', 'asked you']);
    expect(pills[1]?.className).toContain('tone-asked-muted');
    expect(pills[1]?.className).not.toMatch(/tone-asked(\s|$)/);
    expect(done.querySelector('.asked')?.textContent).toBe('Asked: Open the PR?');
    expect(row('failed-one').querySelector('.pill')?.textContent).toBe('failed');
    expect(row('idle-done').className).not.toContain('finished');
  });

  it('shows a group whose sessions have all finished with only its Finished section', () => {
    render(finishedSnapshot(), undefined, 'old');

    expect(summary()).toBe('1 session·Nothing needs you');
    expect(visibleRowNames()).toEqual([]);
    fireEvent.click(finishedToggle());
    expect(row('stopped-one').querySelector('.pill')?.textContent).toBe('stopped');
  });

  it('opens a finished row in the session view, like any other row', () => {
    render(finishedSnapshot(), undefined, 'old');
    fireEvent.click(finishedToggle());

    fireEvent.click(within(row('stopped-one')).getByRole('button', { name: 'stopped-one' }));
    expect(screen.getByRole('dialog', { name: 'stopped-one' })).toBeTruthy();
  });

  it("remembers each group's Finished section across a reload, under the group's id as before", () => {
    const first = render(finishedSnapshot(), undefined, 'old');
    fireEvent.click(finishedToggle());
    expect(stored()).toEqual({ [id('old')]: true });
    first.unmount();

    const second = render(finishedSnapshot(), undefined, 'old');
    expect(finishedOpen()).toBe(true);
    fireEvent.click(finishedToggle());
    expect(stored()).toEqual({ [id('old')]: false });
    second.unmount();

    render();
    expect(finishedOpen()).toBe(false);
  });

  it('starts collapsed, and still toggles, when storage throws or holds the wrong shape', () => {
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    const first = render(finishedSnapshot(), () => ({ getItem: denied, setItem: denied }));
    expect(finishedOpen()).toBe(false);
    fireEvent.click(finishedToggle());
    expect(finishedOpen()).toBe(true);
    first.unmount();

    window.localStorage.setItem(FINISHED_STATE_KEY, '[]');
    render();
    expect(finishedOpen()).toBe(false);
  });

  it('keeps a finished session that matches the text filter in the Finished section', () => {
    render();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'failed-one' } });

    expect(finishedToggle().textContent).toBe('Finished (1)');
    expect(visibleRowNames()).toEqual([]);
    fireEvent.click(finishedToggle());
    expect(visibleRowNames()).toEqual(['failed-one']);
  });
});

describe('missing working directory', () => {
  it('shows a quiet marker on the row, even when the cwd is the group directory', () => {
    renderDashboard(
      snapshot([
        group({
          key: '/Users/example/code/demo-app-worktrees/old',
          label: 'demo-app-worktrees/old',
          kind: 'directory',
          sessions: [
            session({ name: 'gone', cwd: '/Users/example/code/demo-app-worktrees/old', cwdMissing: true }),
            session({ name: 'here', cwd: '/Users/example/code/demo-app-worktrees/old' }),
          ],
        }),
      ]),
    );

    const marker = within(row('gone')).getByText('directory no longer exists');
    expect(marker.className).toBe('cwd-missing');
    expect(marker.getAttribute('title')).toMatch(/no longer exists/);
    expect(row('gone').dataset.attention).toBeUndefined();
    expect(within(row('here')).queryByText('directory no longer exists')).toBeNull();
  });
});

describe('copy command', () => {
  it('is offered for background sessions only', () => {
    renderDashboard(mixedSnapshot());

    expect(within(row('demo-worker')).getByText('claude attach bg7f3a').tagName).toBe('CODE');
    expect(within(row('demo-worker')).getByRole('button', { name: 'Copy' })).toBeTruthy();
    for (const name of ['demo-docs', 'demo-api', 'notes-tidy']) {
      expect(within(row(name)).queryByRole('button', { name: 'Copy' })).toBeNull();
      expect(row(name).textContent).not.toMatch(/claude (attach|--resume)/);
    }
  });

  it('copies the attach command to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderDashboard(mixedSnapshot());

    await act(async () => {
      fireEvent.click(within(row('demo-worker')).getByRole('button', { name: 'Copy' }));
    });

    expect(writeText).toHaveBeenCalledWith('claude attach bg7f3a');
    expect(within(row('demo-worker')).getByText('Copied')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2_000));
    expect(within(row('demo-worker')).queryByText('Copied')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('is not offered when the short id looks unsafe to paste into a shell', () => {
    renderDashboard(
      snapshot([group({ sessions: [session({ name: 'odd', kind: 'background', shortId: 'x; rm -rf ~', state: 'working' })] })]),
    );

    expect(within(row('odd')).queryByRole('button', { name: 'Copy' })).toBeNull();
  });

  it('is not offered when the short id starts with "-", which claude would read as an option', () => {
    renderDashboard(
      snapshot([
        group({
          sessions: [
            session({ name: 'dash-h', kind: 'background', shortId: '-h', state: 'working' }),
            session({ name: 'dash-help', kind: 'background', shortId: '--help', state: 'working' }),
            session({ name: 'inner-dash', kind: 'background', shortId: 'bg-7f3a', state: 'working' }),
            session({ name: 'underscore', kind: 'background', shortId: '_bg7f', state: 'working' }),
          ],
        }),
      ]),
    );

    expect(within(row('dash-h')).queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(within(row('dash-help')).queryByRole('button', { name: 'Copy' })).toBeNull();
    expect(row('dash-h').textContent).not.toContain('claude attach');
    expect(within(row('inner-dash')).getByText('claude attach bg-7f3a')).toBeTruthy();
    expect(within(row('underscore')).getByText('claude attach _bg7f')).toBeTruthy();
  });
});

describe('filters', () => {
  it('matches session names, group labels and cwds, case-insensitively', () => {
    renderDashboard(mixedSnapshot());
    const filter = screen.getByRole('searchbox', { name: 'Filter sessions' });

    fireEvent.change(filter, { target: { value: 'API' } });
    expect(visibleRowNames()).toEqual(['demo-api']);

    fireEvent.change(filter, { target: { value: 'legacy' } });
    expect(visibleRowNames()).toEqual(['legacy-migration']);

    fireEvent.change(filter, { target: { value: 'packages/worker' } });
    expect(visibleRowNames()).toEqual(['demo-worker']);

    fireEvent.change(filter, { target: { value: 'notes' } });
    expect(visibleRowNames()).toEqual(['notes-tidy']);
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
  });

  it('keeps the filter as the selection changes, and filters the new selection', () => {
    renderDashboard(mixedSnapshot());

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'demo' } });
    choose('Needs you');
    expect(visibleRowNames()).toEqual(['demo-docs', 'demo-worker']);
    choose('legacy');
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('demo');
    expect(screen.getByText('Nothing in legacy matches "demo".')).toBeTruthy();
  });

  it('is in the session list\'s header, with the chips, once there are sessions', () => {
    renderDashboard(mixedSnapshot());

    const head = document.querySelector('.session-list-head')!;
    expect(within(head as HTMLElement).getByRole('search')).toBeTruthy();
    expect(within(head as HTMLElement).getByRole('group', { name: 'Filters' })).toBeTruthy();
  });
});

describe('filter chips in the list', () => {
  const finished = { kind: 'background' as const, alive: false, pid: undefined, status: undefined, finished: true };

  function chipsSnapshot(): IndexSnapshot {
    return snapshot([
      group({
        sessions: [
          session({ name: 'waits', status: 'waiting', waitingFor: 'permission prompt' }),
          session({ name: 'blocked-job', kind: 'background', shortId: 'bj1', status: undefined, state: 'blocked' }),
          session({ name: 'idle-one', status: 'idle' }),
          session({ name: 'done-job', ...finished, shortId: 'dj1', state: 'done' }),
        ],
      }),
    ]);
  }

  const chip = (name: string) => within(screen.getByRole('group', { name: 'Filters' })).getByRole('button', { name });

  it('shows one kind of session per chip, both kinds with both on, and keeps finished ones in the Finished section', () => {
    renderDashboard(chipsSnapshot(), {}, { expand: false });

    fireEvent.click(chip('Interactive'));
    expect(visibleRowNames()).toEqual(['waits', 'idle-one']);
    expect(screen.queryByRole('button', { name: /^Finished \(/ })).toBeNull();

    fireEvent.click(chip('Background'));
    expect(visibleRowNames()).toEqual(['waits', 'blocked-job', 'idle-one']);
    fireEvent.click(chip('Interactive'));
    expect(visibleRowNames()).toEqual(['blocked-job']);
    // A finished background session matches, and stays in the collapsed Finished section.
    expect(screen.getByRole('button', { name: /^Finished \(1\)/ }).getAttribute('aria-expanded')).toBe('false');
    expect(summary()).toBe('2 of 4 sessions2 need you');
  });

  it('ANDs the chips with the selection and the text', () => {
    renderDashboard(chipsSnapshot());

    fireEvent.click(chip('Background'));
    choose('Needs you');
    expect(visibleRowNames()).toEqual(['blocked-job']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'waits' } });
    expect(visibleRowNames()).toEqual([]);
    expect(screen.getByText('Nothing in Needs you matches "waits" with these filters.')).toBeTruthy();
  });

  it('clears with Clear filters: the text and the chips, not the selection', () => {
    renderDashboard(chipsSnapshot());
    choose('demo-app');
    fireEvent.click(chip('Interactive'));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'waits' } });
    expect(visibleRowNames()).toEqual(['waits']);

    fireEvent.click(within(screen.getByRole('group', { name: 'Filters' })).getByRole('button', { name: 'Clear filters' }));
    expect(visibleRowNames()).toEqual(['waits', 'blocked-job', 'idle-one', 'done-job']);
    expect(chip('Interactive').getAttribute('aria-pressed')).toBe('false');
    expect(listHeading().textContent).toBe('demo-app, git repo');
  });
});

describe('the highlight', () => {
  const marks = (root: ParentNode = document) => [...root.querySelectorAll('mark')].map((mark) => mark.textContent);

  function highlightSnapshot(): IndexSnapshot {
    return snapshot([
      group({
        sessions: [
          session({ name: 'export-retry', title: 'Retry a failed EXPORT', cwd: '/Users/example/code/demo-app/packages/export' }),
          session({ name: 'docs', title: 'Tidy the README' }),
        ],
      }),
      group({
        key: '/Users/example/code/exporter',
        label: 'exporter',
        sessions: [session({ name: 'tools', cwd: '/Users/example/code/exporter' })],
      }),
    ]);
  }

  it('marks each match in session names, titles and paths, case-insensitively, and never in the repo list', () => {
    renderDashboard(highlightSnapshot());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: ' Export ' } });

    // tools matches by its group's label, exporter.
    expect(visibleRowNames()).toEqual(['export-retry', 'tools']);
    const retry = row('export-retry');
    expect(marks(retry.querySelector('.session-name')!)).toEqual(['export']);
    expect(marks(retry.querySelector('.session-title')!)).toEqual(['EXPORT']);
    expect(marks(retry.querySelector('.cwd')!)).toEqual(['export']);
    expect(marks(repoList())).toEqual([]);
    for (const mark of document.querySelectorAll('mark')) expect(mark.className).toBe('match');
  });

  it("keeps the text whole: a match doesn't change a name, its button's text or a title's hover text", () => {
    renderDashboard(highlightSnapshot());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'retry' } });

    const retry = row('export-retry');
    expect(retry.querySelector('[data-open-session]')?.textContent).toBe('export-retry');
    expect(retry.querySelector('.session-title')?.textContent).toBe('Retry a failed EXPORT');
    expect(retry.querySelector('.session-title')?.getAttribute('title')).toBe('Retry a failed EXPORT');
  });

  it('marks nothing without text, or with only chips on', () => {
    renderDashboard(highlightSnapshot());
    expect(marks()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Interactive' }));
    expect(marks()).toEqual([]);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '   ' } });
    expect(marks()).toEqual([]);
  });

  it('renders matched text as text, not markup', () => {
    const { container } = renderDashboard(snapshot([group({ sessions: [session({ name: '<b>bold</b> name' })] })]));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '<b>' } });

    expect(container.querySelector('.session-name b')).toBeNull();
    expect(marks()).toEqual(['<b>']);
    expect(row('<b>bold</b> name').querySelector('.session-name')?.textContent).toBe('<b>bold</b> name');
  });
});

describe('the shell', () => {
  it('is the header, then the columns: the repo list and the session list, with no filters until there are sessions', () => {
    const { container, rerender } = render(<Dashboard view={{ state: 'live', snapshot: snapshot([]) }} navigation={memoryNavigation()} />);
    const parts = () => [...container.querySelectorAll('.app > *')].map((part) => part.className);
    const columns = () => [...container.querySelectorAll('.columns > *')].map((part) => part.tagName.toLowerCase() + '.' + part.className);

    expect(parts()).toEqual(['app-header', 'columns']);
    expect(columns()).toEqual(['nav.repo-list', 'main.session-list']);
    expect(screen.queryByRole('search')).toBeNull();

    rerender(<Dashboard view={{ state: 'live', snapshot: mixedSnapshot() }} navigation={memoryNavigation()} />);
    expect(screen.getByRole('search')).toBeTruthy();
  });

  it('has the landmarks and headings 6.1 lists: one <h1>, the session list\'s <h2>, <nav> and <main>', () => {
    renderDashboard(mixedSnapshot());

    expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)).toEqual(['pitwall']);
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual(['All sessions']);
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('main', { name: 'All sessions' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Repos' })).toBeTruthy();
  });

  it('has New session as a primary button with the add icon', () => {
    renderDashboard(mixedSnapshot());

    const button = screen.getByRole('button', { name: 'New session' });
    expect(button.className).toBe('button primary md');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the roots in full in the hover text, home-shortened on screen', () => {
    renderDashboard(snapshot([], { roots: ['/Users/example/code', '/Users/example/work/clients'] }));

    const roots = document.querySelector('.roots')!;
    expect(roots.getAttribute('title')).toBe('/Users/example/code, /Users/example/work/clients');
    expect(roots.querySelector('.middle-ellipsis-start')?.textContent).toBe('~/code, ~/work');
    expect(roots.querySelector('.middle-ellipsis-end')?.textContent).toBe('/clients');
  });
});

describe('full replies', () => {
  const SID = '00000000-0000-4000-8000-0000000000f1';
  const PREVIEW = `Fixed the flaky test. ${'Details. '.repeat(50)}`.slice(0, 499) + '…';
  const FULL = `Fixed the flaky test.\n\n${'Details. '.repeat(100)}\n\n- one\n- two`;

  /** Every reply's paragraph reports that it overflows two lines, so "Show more" is offered. */
  function overflowing() {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
  }

  function replySession(overrides: Partial<SessionSummary> = {}): SessionSummary {
    return session({ sessionId: SID, name: 'long-reply', lastAssistantText: PREVIEW, lastActivityAt: minutesAgo(5), ...overrides });
  }

  function message(overrides: Partial<LastMessage> = {}): LastMessage {
    return { sessionId: SID, text: FULL, truncated: false, at: minutesAgo(5), ...overrides };
  }

  const ok = (body: LastMessage) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  /** Renders the dashboard with a reply loader over `fetch`. */
  function renderWithReplies(rowSession: SessionSummary, fetch: FetchLike) {
    const loader = createReplyLoader({ api: createApiClient({ apiKey: 'test-token', fetch }) });
    const navigation = memoryNavigation();
    const ui = (s: SessionSummary) => (
      <ReplyLoaderContext.Provider value={loader}>
        <Dashboard view={{ state: 'live', snapshot: snapshot([group({ sessions: [s] })]) }} navigation={navigation} />
      </ReplyLoaderContext.Provider>
    );
    const result = render(ui(rowSession));
    return { ...result, update: (next: SessionSummary) => result.rerender(ui(next)) };
  }

  const text = () => row('long-reply').querySelector('.clamp-text') as HTMLElement;
  const toggle = (name: 'Show more' | 'Show less') => fireEvent.click(within(row('long-reply')).getByRole('button', { name }));
  const settle = () => act(async () => {});

  it('fetches the whole reply on "Show more": a short loading state, then the text with its line breaks', async () => {
    overflowing();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = vi.fn<FetchLike>(async () => {
      await gate;
      return ok(message());
    });
    renderWithReplies(replySession(), fetch);
    expect(text().textContent).toBe(PREVIEW);

    toggle('Show more');
    expect(within(row('long-reply')).getByRole('status').textContent).toBe('Loading the full reply…');
    expect(text().getAttribute('aria-busy')).toBe('true');
    expect(text().textContent).toBe(PREVIEW);
    expect(fetch).toHaveBeenCalledWith(lastMessagePath(SID), expect.objectContaining({ headers: { Authorization: 'Bearer test-token' } }));

    release();
    await settle();
    expect(text().textContent).toBe(FULL);
    expect(text().className).toContain('expanded');
    expect(text().hasAttribute('aria-busy')).toBe(false);
    expect(within(row('long-reply')).queryByText('Loading the full reply…')).toBeNull();
  });

  it('collapses to the preview again on "Show less"', async () => {
    overflowing();
    renderWithReplies(replySession(), vi.fn<FetchLike>(async () => ok(message())));
    toggle('Show more');
    await settle();
    expect(text().textContent).toBe(FULL);

    toggle('Show less');
    expect(text().textContent).toBe(PREVIEW);
    expect(text().className).not.toContain('expanded');
    expect(within(row('long-reply')).getByRole('button', { name: 'Show more' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the preview, with a quiet note, when the reply cannot be loaded', async () => {
    overflowing();
    renderWithReplies(replySession(), vi.fn<FetchLike>(async () => new Response(null, { status: 404 })));
    toggle('Show more');
    await settle();

    expect(text().textContent).toBe(PREVIEW);
    expect(within(row('long-reply')).getByText("Couldn't load the full reply, so this is the preview.").className).toBe('reply-note');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('notes a reply that was cut at 64 KiB', async () => {
    overflowing();
    renderWithReplies(replySession(), vi.fn<FetchLike>(async () => ok(message({ truncated: true }))));
    toggle('Show more');
    await settle();

    expect(text().textContent).toBe(FULL);
    expect(within(row('long-reply')).getByText('This reply is longer than 64 KiB, so this is its first 64 KiB.')).toBeTruthy();
  });

  it('fetches once per session and activity time, and again once the session has moved on', async () => {
    overflowing();
    const fetch = vi.fn<FetchLike>(async () => ok(message()));
    const { update } = renderWithReplies(replySession(), fetch);
    toggle('Show more');
    await settle();
    toggle('Show less');
    toggle('Show more');
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(text().textContent).toBe(FULL);

    toggle('Show less');
    update(replySession({ lastActivityAt: minutesAgo(1), lastAssistantText: `A newer reply. ${PREVIEW}` }));
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockImplementation(async () => ok(message({ text: 'A newer reply, in full.', at: minutesAgo(1) })));
    toggle('Show more');
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(text().textContent).toBe('A newer reply, in full.');
  });

  it('fetches again while expanded when the session moves on, keeping the reply shown until the new one arrives', async () => {
    overflowing();
    const fetch = vi.fn<FetchLike>(async () => ok(message()));
    const { update } = renderWithReplies(replySession(), fetch);
    toggle('Show more');
    await settle();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fetch.mockImplementation(async () => {
      await gate;
      return ok(message({ text: 'Newest, in full.' }));
    });
    update(replySession({ lastActivityAt: minutesAgo(0.5) }));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(text().textContent).toBe(FULL);
    expect(within(row('long-reply')).queryByText('Loading the full reply…')).toBeNull();

    release();
    await settle();
    expect(text().textContent).toBe('Newest, in full.');
  });

  it('renders the full reply as text, not markup, without control characters', async () => {
    overflowing();
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script><b>bold</b>\n\u001b[31mred\u001b[0m‮';
    const { container } = renderWithReplies(replySession(), vi.fn<FetchLike>(async () => ok(message({ text: hostile }))));
    toggle('Show more');
    await settle();

    expect(container.querySelector('img, script, b')).toBeNull();
    expect(text().textContent).toBe('<img src=x onerror="alert(1)"><script>alert(2)</script><b>bold</b>\nred');
  });
});

describe('untrusted session text', () => {
  it('renders HTML in session text as text, not markup', () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script><b>bold</b>';
    const { container } = renderDashboard(
      snapshot([
        group({
          label: '<i>label</i>',
          sessions: [
            session({
              name: '<a href="javascript:alert(3)">name</a>',
              status: 'waiting',
              waitingFor: '<u>reason</u>',
              lastUserPrompt: hostile,
              lastAssistantText: `${hostile}\n\n# heading\n**markdown**`,
            }),
          ],
        }),
      ]),
    );

    // The repo list's items are links of pitwall's own, to ?repo=: none comes from session text.
    expect(container.querySelector('img, script, b, a:not([data-repo-item]), i, u')).toBeNull();
    expect([...container.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      '?view=needs-you',
      '?view=all',
      '?repo=/Users/example/code/demo-app',
    ]);
    expect(container.textContent).toContain('<a href="javascript:alert(3)">name</a>');
    expect(container.textContent).toContain('<i>label</i>');
    expect(container.textContent).toContain('waiting: <u>reason</u>');
    expect(container.textContent).toContain('<script>alert(2)</script><b>bold</b>');
    expect(container.textContent).toContain('**markdown**');
  });

  it('drops terminal escapes and control characters', () => {
    renderDashboard(
      snapshot([
        group({
          sessions: [session({ name: 'esc', lastAssistantText: '\u001b[31mred\u001b[0m and \u001b]0;title\u0007plain‮' })],
        }),
      ]),
    );

    expect(within(row('esc')).getByText('red and plain')).toBeTruthy();
  });
});
