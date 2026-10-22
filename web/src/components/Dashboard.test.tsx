import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexSnapshot, SessionSummary } from '../../../src/shared/protocol.js';
import type { ConnectionState, ConnectionView } from '../connection.js';
import { GROUP_BY_KEY } from '../groupBy.js';
import { FINISHED_STATE_KEY, type StorageSource } from '../groupState.js';
import { memoryNavigation, VIEW_STATE_KEY, type NavigationEnv } from '../selection.js';
import { SORT_KEY } from '../sort.js';
import { group, minutesAgo, mixedSnapshot, NOW, session, snapshot } from '../test/fixtures.js';
import { cutShort, tooltipText } from '../test/tooltips.js';
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
  return renderWith(snap, overrides, options);
}

function renderWith(snap: IndexSnapshot | undefined, overrides: Partial<ConnectionView> = {}, options: RenderOptions = {}) {
  const view: ConnectionView = { state: 'live', snapshot: snap, ...overrides };
  const navigation = options.navigation ?? memoryNavigation(options.search ?? '');
  const result = render(<Dashboard view={view} navigation={navigation} {...(options.storage ? { storage: options.storage } : {})} />);
  if (options.expand !== false) expandFinished();
  return { ...result, navigation };
}

/** Storage of its own, starting with `entries`. */
function storageWith(entries: Record<string, string>): StorageSource {
  const values = new Map(Object.entries(entries));
  const store = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v) };
  return () => store;
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
  return within(screen.getByRole('main')).getByRole('heading', { level: 2, name: /./, hidden: false });
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

/** A row's badges, by their text. */
function badges(name: string): string[] {
  return [...row(name).querySelectorAll('.badge')].map((badge) => badge.textContent ?? '');
}

/** A row's status badge, by the state it shows, or undefined when it has none. */
function status(name: string): string | undefined {
  return row(name).querySelector<HTMLElement>('.badge[data-status]')?.dataset.status;
}

/** A row's second line. */
function line2(name: string): string | undefined {
  return row(name).querySelector('.session-what')?.textContent ?? undefined;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
});

describe('Dashboard header', () => {
  it('shows the root with the home directory shortened, the connection state and the update age', () => {
    renderDashboard(snapshot([], { roots: ['/Users/example/code'] }));

    expect(document.querySelector('.roots')?.textContent).toBe('~/code');
    // One root: no tabs, and the header as it always was (W38).
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.querySelector('header')?.className).toBe('app-header');
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('updated 3s ago')).toBeTruthy();

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText('updated 5s ago')).toBeTruthy();
  });

  it('ends the header with the theme switch, View preferences, then the keyboard shortcuts button, before and after the first snapshot', () => {
    const { container, rerender } = render(<Dashboard view={{ state: 'connecting', snapshot: undefined }} />);
    const status = () => container.querySelector('header .app-header-end');
    // The View preferences menu's anchor holds its button, which has the name (W42).
    const name = (element: Element) => element.getAttribute('aria-label') ?? element.querySelector('button[aria-haspopup="menu"]')?.getAttribute('aria-label');
    const lastThree = () => [...(status()?.children ?? [])].slice(-3).map(name);
    expect(within(status() as HTMLElement).getByRole('group', { name: 'Theme' })).toBeTruthy();
    expect(lastThree()).toEqual(['Theme', 'View preferences', 'Keyboard shortcuts']);

    rerender(<Dashboard view={{ state: 'live', snapshot: snapshot([]) }} />);
    expect(lastThree()).toEqual(['Theme', 'View preferences', 'Keyboard shortcuts']);
  });

  it("shows a heartbeat's time as the update age, newer than the snapshot's", () => {
    const snap = snapshot([group({ sessions: [session({ name: 'kept' })] })]);
    renderDashboard(snap, { lastPoll: { generatedAt: new Date(NOW - 1_000).toISOString(), source: { ok: true } } });

    expect(screen.getByText('updated 1s ago')).toBeTruthy();
    expect(visibleRowNames()).toEqual(['kept']);
  });

  it('warns when the latest heartbeat says the source failed, even though the snapshot did not', () => {
    const snap = snapshot([group({ sessions: [session({ name: 'kept' })] })]);
    const { rerender } = render(<Dashboard view={{ state: 'live', snapshot: snap }} navigation={memoryNavigation()} />);
    rerender(
      <Dashboard
        view={{ state: 'live', snapshot: snap, lastPoll: { generatedAt: new Date(NOW).toISOString(), source: { ok: false, error: 'timed out' } } }}
        navigation={memoryNavigation()}
      />,
    );

    // Arrived live, so it's announced.
    expect(screen.getByRole('alert').textContent).toBe("Couldn't list sessionsclaude agents --json --all failed on the latest poll: timed out");
    expect(visibleRowNames()).toEqual(['kept']);
  });

  it('drops the warning when the latest heartbeat says the source works again', () => {
    const snap = snapshot([], { source: { ok: false, error: 'timed out' } });
    renderDashboard(snap, { lastPoll: { generatedAt: new Date(NOW).toISOString(), source: { ok: true } } });

    expect(document.querySelector('.inline-alert')).toBeNull();
  });

  it('shows the reconnecting state and a note that the list may be out of date', () => {
    renderDashboard(mixedSnapshot(), { state: 'reconnecting' });

    expect(screen.getByText('Reconnecting…')).toBeTruthy();
    expect(screen.getByText(/Reconnecting; this list may be out of date/)).toBeTruthy();
  });

  it("shows the connection as a badge in role=\"status\": a spinner while connecting, a dot once live", () => {
    const cases: [ConnectionState, string, string, string | undefined][] = [
      ['connecting', 'Connecting…', 'badge-subtle-neutral', 'spinner'],
      ['live', 'Live', 'badge-subtle-success', 'status-dot'],
      ['reconnecting', 'Reconnecting…', 'badge-subtle-warning', 'spinner'],
      ['unauthorized', 'Token rejected', 'badge-subtle-danger', undefined],
    ];
    const { rerender } = render(<Dashboard view={{ state: 'connecting' }} navigation={memoryNavigation()} />);
    for (const [state, label, look, lead] of cases) {
      rerender(<Dashboard view={{ state }} navigation={memoryNavigation()} />);
      const badge = document.querySelector('.app-header .connection')!;
      expect(badge.getAttribute('role')).toBe('status');
      expect(badge.textContent).toBe(label);
      expect(badge.querySelector('.badge')?.className).toContain(look);
      const leading = badge.querySelector('.spinner, .status-dot');
      expect(leading?.className).toBe(lead);
      if (leading) expect(leading.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('warns when the session source failed, without announcing a warning that was there on load', () => {
    renderDashboard(snapshot([], { source: { ok: false, error: 'claude: command not found' } }));

    const alert = document.querySelector('.inline-alert.warning')!;
    expect(alert.textContent).toBe("Couldn't list sessionsclaude agents --json --all failed on the latest poll: claude: command not found");
    expect(alert.hasAttribute('role')).toBe(false);
  });

  it('shows server error messages until dismissed', () => {
    const { rerender } = render(<Dashboard view={{ state: 'live', snapshot: mixedSnapshot() }} navigation={memoryNavigation()} />);
    rerender(<Dashboard view={{ state: 'live', snapshot: mixedSnapshot(), serverError: 'index crashed' }} navigation={memoryNavigation()} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('index crashed');
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(document.querySelector('.inline-alert')).toBeNull();
  });

  it('says when the relay tried to send a message nobody asked for and pitwall blocked it, until dismissed, and again for the next one', () => {
    const alert = { at: minutesAgo(1), detail: "The relay tried to send a message when pitwall hadn’t asked it to. pitwall's gate blocked it.", count: 1, blocked: true, cause: 'unrequested' as const };
    const view = (relayAlert?: typeof alert) => <Dashboard view={{ state: 'live', snapshot: { ...mixedSnapshot(), ...(relayAlert ? { relayAlert } : {}) } }} />;
    const { rerender } = render(view());
    rerender(view(alert));
    const banner = screen.getByRole('alert');
    expect(banner.className).toContain('warning');
    expect(banner.textContent).toBe(
      "pitwall blocked a message you didn't ask forIts relay tried to send it, and pitwall's gate stopped it, so nothing was sent. That usually means another session messaged the relay. Once since pitwall started. Latest: The relay tried to send a message when pitwall hadn’t asked it to. pitwall's gate blocked it.Dismiss",
    );
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(document.querySelector('.relay-alert')).toBeNull();
    rerender(view(alert));
    expect(document.querySelector('.relay-alert')).toBeNull();
    rerender(view({ ...alert, count: 2 }));
    expect(screen.getByRole('alert').textContent).toContain('2 times since pitwall started.');
  });

  it('says more when the relay’s message may have been sent, and that messaging is off only when it is', () => {
    const relayAlert = { at: minutesAgo(1), detail: "pitwall's gate didn't stop it <b>.", count: 1, blocked: false, cause: 'unrequested' as const };
    const { rerender } = render(<Dashboard view={{ state: 'live', snapshot: mixedSnapshot() }} navigation={memoryNavigation()} />);
    rerender(<Dashboard view={{ state: 'live', snapshot: { ...mixedSnapshot(), relayAlert } }} navigation={memoryNavigation()} />);
    const banner = screen.getByRole('alert');
    expect(banner.className).toContain('danger');
    expect(banner.textContent).toContain("pitwall's relay may have sent a message you didn't ask for");
    expect(banner.textContent).toContain("Check your sessions' conversations for a message from pitwall-relay.");
    expect(banner.textContent).toContain("Latest: pitwall's gate didn't stop it <b>.");
    expect(banner.querySelector('b')).toBeNull();
    // Some of these only restart the relay: it's off only when the snapshot says so.
    expect(banner.textContent).not.toContain('Messaging is off');
    expect(document.querySelector('.app-strip')).toBeNull();

    const relayOff = { since: minutesAgo(1), reason: "its gate didn't check a SendMessage call." };
    rerender(<Dashboard view={{ state: 'live', snapshot: { ...mixedSnapshot(), relayAlert, relayOff } }} navigation={memoryNavigation()} />);
    expect(screen.getByRole('alert').textContent).toContain('Messaging is off until you restart pitwall.');
    expect(document.querySelector('.app-strip')?.textContent).toBe("Messaging is off until you restart pitwall: its gate didn't check a SendMessage call.Details");
  });

  it('counts sessions that need attention, in the repo list, the session list and the tab title', () => {
    renderDashboard(mixedSnapshot());

    expect(repoItem('Needs you').textContent).toBe('Needs you2 need you');
    expect(summary()).toBe('5 sessions2 need you');
    expect(document.title).toBe('(2) pitwall');
  });
});

describe('Dashboard states', () => {
  it('says it is connecting before the first snapshot, with skeletons after --pw-delay-spinner (more in States.test.tsx)', () => {
    renderDashboard(undefined, { state: 'connecting' });

    expect(screen.getByText('Connecting…')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByText('Loading sessions')).toBeTruthy();
    expect(document.querySelectorAll('.skeleton-row')).toHaveLength(3);
  });

  it('shows the empty state with the roots', () => {
    renderDashboard(snapshot([], { roots: ['/Users/example/code'] }));

    expect(screen.getByText('No Claude Code sessions under ~/code')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});

describe('the repo list', () => {
  const ROOT = '/Users/example/code';

  it('lists Needs you, All sessions and Starred, a divider, then every group alphanumerically, each with one count', () => {
    renderDashboard(mixedSnapshot());

    expect(repoItems()).toEqual([
      'Needs you2 need you',
      'All sessions5 sessions',
      'Starred',
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
    expect(repoItems()).toEqual(['Needs you', 'All sessions', 'Starred']);

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

    expect(repoItems().slice(3)).toEqual(['~/code, directory1 session', 'archive, git repo1 session', 'zeta, git repo1 session']);
    expect(repoItem('archive').className).toContain('finished');
    expect(repoItem('zeta').className).not.toContain('finished');
    choose('~/code');
    expect(listHeading().textContent).toBe('~/code, directory');
  });

  it("shows each root's groups in its own root tab when there are several roots, and tells two groups with the same key apart", () => {
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

    // No root headings in the list: the tab names the root (W38).
    expect(within(repoList()).getAllByRole('list').map((list) => list.getAttribute('aria-labelledby'))).toEqual([null, null]);
    expect(repoItems().slice(3)).toEqual(['demo-app, git repo1 session']);
    choose('demo-app');
    expect(visibleRowNames()).toEqual(['in-main']);
    expect(listHeading().textContent).toBe('demo-app, git repo');
    fireEvent.click(screen.getAllByRole('tab')[1]!);
    expect(repoItems().slice(3)).toEqual(['~/code/demo-app, git repo1 session']);
    choose('~/code/demo-app');
    expect(visibleRowNames()).toEqual(['in-worktree']);
    expect(listHeading().textContent).toBe('~/code/demo-app, git repo');
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
    expect(document.activeElement).toBe(repoItem('Starred'));
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
    expect(list.firstElementChild?.classList.contains('session-list-alerts')).toBe(true);
    expect(list.firstElementChild?.querySelector('.inline-alert.danger')?.textContent).toContain('index crashed');
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
  it('sorts by urgency unless told otherwise', () => {
    renderDashboard(mixedSnapshot());

    expect(visibleRowNames()).toEqual(['demo-docs', 'demo-worker', 'demo-api', 'notes-tidy', 'legacy-migration']);
  });

  it('has two lines: the name, title, badges and time, then what it was last asked', () => {
    renderDashboard(snapshot([group({ sessions: [session({ name: 'git-a0', title: 'Review the auth flow', status: 'busy', lastUserPrompt: 'check the tests' })] })]), {}, { search: '?repo=/Users/example/code/demo-app' });

    const item = row('git-a0');
    expect([...item.children].map((child) => child.className)).toEqual(['session-line', 'session-what']);
    const first = item.querySelector('.session-line')!;
    expect([...first.querySelectorAll('h3, .session-title, .badge, time')].map((part) => part.textContent)).toEqual([
      'git-a0',
      'Review the auth flow',
      'Busy',
      '5m ago',
    ]);
    expect(line2('git-a0')).toBe('You: check the tests');
  });

  it('starts line 2 with the group label in All sessions and Needs you, but not in a group', () => {
    const ROOT = '/Users/example/code';
    const snap = snapshot([
      group({ sessions: [session({ name: 'waits', status: 'waiting', lastUserPrompt: 'update the guide' })] }),
      group({ key: ROOT, label: 'code', kind: 'directory', sessions: [session({ name: 'in-root', cwd: ROOT, lastUserPrompt: undefined, askedYou: { reason: 'question', excerpt: 'Ship it?' } })] }),
    ]);
    renderDashboard(snap);

    expect(line2('waits')).toBe('demo-app · You: update the guide');
    // The root's own directory is labelled with its path.
    expect(line2('in-root')).toBe('~/code · Asked: Ship it?');
    expect(row('waits').querySelector('.session-what-sep')?.getAttribute('aria-hidden')).toBe('true');

    choose('Needs you');
    expect(line2('waits')).toBe('demo-app · You: update the guide');
    expect(line2('in-root')).toBe('~/code · Asked: Ship it?');

    choose('demo-app');
    expect(line2('waits')).toBe('You: update the guide');
    expect(row('waits').querySelector('.session-group')).toBeNull();
  });

  it('puts what the session asked on line 2 in place of what it was asked, and shows only the group label with neither', async () => {
    renderDashboard(
      snapshot([
        group({
          sessions: [
            session({ name: 'asks', askedYou: { reason: 'question', excerpt: 'Ship it?' }, lastUserPrompt: 'fix the test' }),
            session({ name: 'quiet', lastUserPrompt: undefined }),
          ],
        }),
      ]),
    );

    expect(line2('asks')).toBe('demo-app · Asked: Ship it?');
    expect(row('asks').querySelector('.asked')?.getAttribute('class')).toBe('asked');
    // The whole of it in a tooltip, once it's cut short on screen.
    const what = row('asks').querySelector('.session-what')!;
    expect(await tooltipText(what)).toBeUndefined();
    cutShort(what);
    expect(await tooltipText(what)).toBe('Ship it?');
    expect(row('asks').textContent).not.toContain('fix the test');
    expect(line2('quiet')).toBe('demo-app');

    choose('demo-app');
    expect(row('quiet').querySelector('.session-what')).toBeNull();
  });

  it("leaves the reply, Show more, the relay exchange, the cwd, the attach command and a Message button to the session view", () => {
    const relay = { sentAt: minutesAgo(3), status: 'delivered' as const, reply: { at: minutesAgo(2), text: 'All three fixed.' } };
    renderDashboard(
      snapshot([
        group({
          sessions: [
            session({ name: 'chatty', relay, cwd: '/Users/example/code/demo-app/packages/worker' }),
            session({ name: 'job', kind: 'background', shortId: 'bg7f3a', state: 'working', status: undefined, cwdMissing: true }),
          ],
        }),
      ]),
    );

    for (const name of ['chatty', 'job']) {
      const item = row(name);
      // The name, and the star toggle (W53), which is named by its tooltip.
      expect(within(item).getAllByRole('button').map((button) => button.textContent || button.getAttribute('aria-label'))).toEqual([name, `Star ${name}`]);
      expect(item.querySelector('.reply, .clamp-text, .relay-exchange, .cwd, .cwd-missing, .copy-command, code')).toBeNull();
      expect(item.textContent).not.toMatch(/All three fixed|Message from pitwall|packages\/worker|claude attach|no longer exists|interactive|background/i);
    }
  });

  it('marks waiting and blocked sessions as needing you, with the bar and a solid badge, but not stale ones, and never tints the row', () => {
    renderDashboard(mixedSnapshot());

    expect(row('demo-docs').dataset.attention).toBe('true');
    expect(row('demo-docs').className).toContain('attention');
    expect(status('demo-docs')).toBe('waiting');
    expect(badges('demo-docs')).toEqual(['Waiting: permission prompt']);
    expect(row('demo-worker').dataset.attention).toBe('true');
    expect(status('demo-worker')).toBe('blocked');

    expect(row('demo-api').dataset.attention).toBeUndefined();
    expect(row('legacy-migration').dataset.attention).toBeUndefined();
    expect(status('legacy-migration')).toBe('blocked-stale');
  });

  it('shows the stale badge only on stale sessions, with its explanation on hover', async () => {
    renderDashboard(mixedSnapshot());

    expect(badges('legacy-migration')).toEqual(['Blocked', 'Stale']);
    expect(await tooltipText(within(row('legacy-migration')).getByText('Stale').closest('.badge')!)).toMatch(
      /no activity for more than 7 days, whether or not its process is running/,
    );
    expect(within(row('demo-worker')).queryByText('Stale')).toBeNull();
  });

  it('shows each status as a badge in sentence case, and none for an idle session, which still counts when it asked you', () => {
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
            session({ name: 'h', status: 'idle', askedYou: { reason: 'question', excerpt: 'Ship it?' } }),
          ],
        }),
      ]),
    );

    expect(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name) => badges(name).join(', '))).toEqual([
      'Busy',
      '',
      'Done',
      'Failed',
      'Stopped',
      'Not running',
      'Waiting: a brand new reason',
      'Asked you',
    ]);
    expect(row('a').querySelector('.badge .status-dot')?.getAttribute('aria-hidden')).toBe('true');
    expect(row('b').querySelector('.badge')).toBeNull();
    expect(row('b').dataset.attention).toBeUndefined();
    expect(row('h').dataset.attention).toBe('true');
    expect(repoItem('Needs you').textContent).toBe('Needs you2 need you');
  });

  it('shows last activity as relative time with the absolute time on hover', async () => {
    renderDashboard(mixedSnapshot());

    const time = within(row('demo-docs')).getByText('5m ago');
    expect(time.tagName).toBe('TIME');
    expect(time.getAttribute('dateTime')).toBe('2026-03-02T11:55:00.000Z');
    expect(await tooltipText(time)).toMatch(/2026/);
    expect(time.hasAttribute('title')).toBe(false);
  });

  it('shows a missing or unreadable transcript quietly on line 2, after the group label', () => {
    renderDashboard(
      snapshot([
        group({
          sessions: [
            session({ name: 'gone', transcript: 'missing', lastUserPrompt: 'old prompt' }),
            session({ name: 'garbled', transcript: 'unreadable', lastActivityAt: undefined }),
          ],
        }),
      ]),
    );

    expect(line2('gone')).toBe('demo-app · Transcript not found');
    expect(within(row('gone')).getByText('Transcript not found').className).toBe('transcript-note');
    expect(row('gone').textContent).not.toMatch(/old prompt/);
    expect(line2('garbled')).toBe('demo-app · Transcript unreadable');
  });
});

describe('row semantics', () => {
  it('names the session with a button that controls the session view, marked current while its session is open', () => {
    const snap = mixedSnapshot();
    renderDashboard(snap);
    const name = within(row('notes-tidy')).getByRole('button', { name: 'notes-tidy' });

    expect(name.getAttribute('aria-controls')).toBe('session-view');
    expect(name.hasAttribute('aria-haspopup')).toBe(false);
    expect(name.hasAttribute('aria-current')).toBe(false);
    expect(name.closest('h3')).toBeTruthy();
    expect(name.dataset.openSession).toBe(snap.groups[1]!.sessions[0]!.sessionId);

    fireEvent.click(name);
    expect(name.getAttribute('aria-current')).toBe('true');
    expect(row('notes-tidy').className).toContain('open');
    expect(document.getElementById('session-view')?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(within(row('demo-docs')).getByRole('button', { name: 'demo-docs' }).hasAttribute('aria-current')).toBe(false);
  });

  it('opens the session from a click anywhere on the row', () => {
    renderDashboard(mixedSnapshot());

    fireEvent.click(row('notes-tidy').querySelector('.session-what')!);
    expect(screen.getByRole('dialog', { name: 'notes-tidy' })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });

    fireEvent.click(row('demo-docs').querySelector('time')!);
    expect(screen.getByRole('dialog', { name: 'demo-docs' })).toBeTruthy();
  });

  it("doesn't open the session from a click that ends a text selection", () => {
    renderDashboard(mixedSnapshot());
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'notes' } as Selection);

    fireEvent.click(row('notes-tidy').querySelector('.session-what')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    selection.mockRestore();
  });
});

describe('session titles', () => {
  const CLAUDE_CODE_HINT = "Claude Code's title, from the session's first prompt";

  it("shows Claude Code's title after the name, muted, with where it came from on hover", async () => {
    renderDashboard(
      snapshot([group({ sessions: [session({ name: 'git-a0', title: 'Review the auth flow', titleSource: 'claude-code' })] })]),
    );

    // The " · " between them is drawn by CSS, so it goes with the title when the row is narrow.
    const head = row('git-a0').querySelector('.session-ident');
    expect(head?.textContent).toBe('git-a0Review the auth flow');
    const title = within(row('git-a0')).getByText('Review the auth flow');
    expect(title.className).toBe('session-title');
    expect(await tooltipText(title)).toBe(`Review the auth flow\n${CLAUDE_CODE_HINT}`);
    // The heading stays the name alone.
    expect(screen.getByRole('heading', { level: 3, name: 'git-a0' })).toBeTruthy();
  });

  it('shows nothing after the name when there is no title', () => {
    renderDashboard(snapshot([group({ sessions: [session({ name: 'untitled' })] })]));

    expect(row('untitled').querySelector('.session-title')).toBeNull();
  });

  it('keeps a long title whole in the text and the tooltip, for the ellipsis to cut on screen', async () => {
    const long = `Investigate why ${'the very long session title '.repeat(4)}keeps going`;
    renderDashboard(snapshot([group({ sessions: [session({ name: 'git-b1', title: long, titleSource: 'claude-code' })] })]));

    const title = row('git-b1').querySelector('.session-title');
    expect(title?.textContent).toBe(long);
    expect(await tooltipText(title!)).toBe(`${long}\n${CLAUDE_CODE_HINT}`);
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

  it('shows a subtle "Asked you" badge, distinct from waiting, on a row that needs you', () => {
    renderDashboard(askedSnapshot());

    const asks = row('asks');
    expect(asks.dataset.attention).toBe('true');
    expect(asks.className).toContain('attention');
    expect(status('asks')).toBe('asked');
    expect(badges('asks')).toEqual(['Asked you']);
    expect(status('waits')).toBe('waiting');
    expect(row('calm').dataset.attention).toBeUndefined();
  });

  it('shows the excerpt on line 2, and not the last reply', () => {
    renderDashboard(askedSnapshot());

    const asks = row('asks');
    expect(asks.querySelector('.asked')?.textContent).toBe('Asked: Should I push it?');
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

  it('mutes finished rows, with the state as the badge and an outline asked-you badge', async () => {
    render();
    fireEvent.click(finishedToggle());

    const done = row('done-one');
    expect(done.className).toContain('finished');
    expect(done.className).not.toContain('attention');
    expect(done.dataset.attention).toBeUndefined();
    expect(badges('done-one')).toEqual(['Done', 'Asked you']);
    const asked = within(done).getByText('Asked you').closest('.badge')!;
    expect(asked.className).toContain('badge-outline');
    expect(asked.hasAttribute('data-status')).toBe(false);
    expect(await tooltipText(asked)).toMatch(/isn't counted as needing you/);
    expect(done.querySelector('.asked')?.textContent).toBe('Asked: Open the PR?');
    expect(badges('failed-one')).toEqual(['Failed']);
    expect(row('idle-done').className).not.toContain('finished');
  });

  it('shows a group whose sessions have all finished with only its Finished section', () => {
    render(finishedSnapshot(), undefined, 'old');

    expect(summary()).toBe('1 session·Nothing needs you');
    expect(visibleRowNames()).toEqual([]);
    fireEvent.click(finishedToggle());
    expect(badges('stopped-one')).toEqual(['Stopped']);
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

describe('the Sort setting', () => {
  const sortSelect = () => screen.getByRole('combobox', { name: 'Sort' }) as HTMLSelectElement;
  const sortBy = (order: string) => fireEvent.change(sortSelect(), { target: { value: order } });
  const finished = { kind: 'background' as const, alive: false, pid: undefined, status: undefined, finished: true };

  function sortSnapshot(): IndexSnapshot {
    return snapshot([
      group({
        sessions: [
          session({ name: 'zeta', status: 'waiting', lastActivityAt: minutesAgo(9) }),
          session({ name: 'Alpha', lastActivityAt: minutesAgo(1) }),
          session({ name: 'job-10', kind: 'background', shortId: 'j10', status: undefined, state: 'working', lastActivityAt: minutesAgo(3) }),
          session({ name: 'job-2', lastActivityAt: minutesAgo(2) }),
          session({ name: 'b-done', ...finished, shortId: 'f1', state: 'done', lastActivityAt: minutesAgo(30) }),
          session({ name: 'a-done', ...finished, shortId: 'f2', state: 'failed', lastActivityAt: minutesAgo(60) }),
          session({ name: 'c-done', ...finished, shortId: 'f3', state: 'stopped', lastActivityAt: minutesAgo(10) }),
        ],
      }),
    ]);
  }

  it('is a select labelled Sort, after the filter chips, with Urgency, the default, then Recent and Name', () => {
    renderDashboard(sortSnapshot());

    expect(sortSelect().value).toBe('urgency');
    expect([...sortSelect().options].map((option) => option.textContent)).toEqual(['Urgency', 'Recent', 'Name']);
    const line2 = document.querySelector('.session-list-filters')!;
    expect(line2.contains(sortSelect())).toBe(true);
    const chips = within(line2 as HTMLElement).getByRole('group', { name: 'Filters' });
    expect(chips.compareDocumentPosition(sortSelect()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sorts by Urgency, Recent or Name, and the Finished section follows, except that Urgency orders it by activity alone', () => {
    renderDashboard(sortSnapshot());

    expect(visibleRowNames()).toEqual(['zeta', 'Alpha', 'job-2', 'job-10', 'c-done', 'b-done', 'a-done']);
    sortBy('recent');
    expect(visibleRowNames()).toEqual(['Alpha', 'job-2', 'job-10', 'zeta', 'c-done', 'b-done', 'a-done']);
    sortBy('name');
    expect(visibleRowNames()).toEqual(['Alpha', 'job-2', 'job-10', 'zeta', 'a-done', 'b-done', 'c-done']);
  });

  it('applies to every selection, and is stored in pitwall.sort.v1 for the next visit', () => {
    const first = renderDashboard(sortSnapshot());
    sortBy('name');
    expect(window.localStorage.getItem(SORT_KEY)).toBe('name');
    choose('Needs you');
    expect(sortSelect().value).toBe('name');
    choose('demo-app');
    expect(visibleRowNames()).toEqual(['Alpha', 'job-2', 'job-10', 'zeta', 'a-done', 'b-done', 'c-done']);
    first.unmount();

    renderDashboard(sortSnapshot());
    expect(sortSelect().value).toBe('name');
    expect(visibleRowNames()).toEqual(['Alpha', 'job-2', 'job-10', 'zeta', 'a-done', 'b-done', 'c-done']);
  });

  it('still sorts, by Urgency until told otherwise, when storage throws', () => {
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    renderDashboard(sortSnapshot(), {}, { storage: denied });

    expect(sortSelect().value).toBe('urgency');
    sortBy('name');
    expect(visibleRowNames()[0]).toBe('Alpha');
  });
});

describe('holding the row order while the reader is in the list', () => {
  const ROW_IDS = { first: 'aaaaaaaa-0000-4000-8000-000000000001', second: 'aaaaaaaa-0000-4000-8000-000000000002', third: 'aaaaaaaa-0000-4000-8000-000000000003' };

  /** first, second and third, in that order by Urgency, unless `third` is waiting, which puts it first. */
  function rows(overrides: { third?: Partial<SessionSummary>; extra?: SessionSummary[]; without?: string[] } = {}): IndexSnapshot {
    const sessions = [
      session({ sessionId: ROW_IDS.first, name: 'first', status: 'busy', lastActivityAt: minutesAgo(1) }),
      session({ sessionId: ROW_IDS.second, name: 'second', lastActivityAt: minutesAgo(2) }),
      session({ sessionId: ROW_IDS.third, name: 'third', lastActivityAt: minutesAgo(3), ...overrides.third }),
      ...(overrides.extra ?? []),
    ].filter((shown) => !(overrides.without ?? []).includes(shown.name));
    return snapshot([group({ sessions })]);
  }

  const reordered = () => rows({ third: { status: 'waiting', waitingFor: 'permission prompt' } });

  function renderList(first: IndexSnapshot = rows(), storage?: StorageSource) {
    const navigation = memoryNavigation();
    const ui = (snap: IndexSnapshot) => (
      <Dashboard view={{ state: 'live', snapshot: snap }} navigation={navigation} {...(storage ? { storage } : {})} />
    );
    const result = render(ui(first));
    return { ...result, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
  }

  const list = () => screen.getByRole('main');

  it('waits while the pointer is over the list, updating the rows in place, and applies once it leaves', () => {
    const { update } = renderList();
    expect(visibleRowNames()).toEqual(['first', 'second', 'third']);
    const third = row('third');

    fireEvent.pointerEnter(list());
    update(reordered());
    expect(visibleRowNames()).toEqual(['first', 'second', 'third']);
    // The row itself is up to date, and is the same element.
    expect(row('third')).toBe(third);
    expect(badges('third')).toEqual(['Waiting: permission prompt']);

    fireEvent.pointerLeave(list());
    expect(visibleRowNames()).toEqual(['third', 'first', 'second']);
    expect(row('third')).toBe(third);
  });

  it('waits while focus is inside the list, and applies once it leaves', () => {
    const { update } = renderList();
    const name = within(row('second')).getByRole('button', { name: 'second' });

    act(() => name.focus());
    update(reordered());
    expect(visibleRowNames()).toEqual(['first', 'second', 'third']);

    act(() => name.blur());
    expect(visibleRowNames()).toEqual(['third', 'first', 'second']);
  });

  it('waits until both the pointer and focus have left', () => {
    const { update } = renderList();
    const name = within(row('first')).getByRole('button', { name: 'first' });

    fireEvent.pointerEnter(list());
    act(() => name.focus());
    update(reordered());
    fireEvent.pointerLeave(list());
    expect(visibleRowNames()).toEqual(['first', 'second', 'third']);

    fireEvent.pointerEnter(list());
    act(() => name.blur());
    expect(visibleRowNames()).toEqual(['first', 'second', 'third']);

    fireEvent.pointerLeave(list());
    expect(visibleRowNames()).toEqual(['third', 'first', 'second']);
  });

  it('adds and removes rows at once, holding the rest', () => {
    const { update } = renderList();
    fireEvent.pointerEnter(list());

    const fourth = session({ name: 'fourth', status: 'waiting', lastActivityAt: minutesAgo(0.5) });
    update(rows({ third: { status: 'waiting' }, extra: [fourth], without: ['second'] }));
    // By Urgency it would be fourth, third, first: fourth comes in where it goes, second has gone, third waits.
    expect(visibleRowNames()).toEqual(['fourth', 'first', 'third']);

    fireEvent.pointerLeave(list());
    expect(visibleRowNames()).toEqual(['fourth', 'third', 'first']);
  });

  it('holds the Finished section too', () => {
    const finished = { kind: 'background' as const, alive: false, pid: undefined, status: undefined, finished: true, state: 'done' as const };
    const done = (minutes: [number, number]) =>
      snapshot([
        group({
          sessions: [
            session({ sessionId: ROW_IDS.first, name: 'done-a', ...finished, shortId: 'd1', lastActivityAt: minutesAgo(minutes[0]) }),
            session({ sessionId: ROW_IDS.second, name: 'done-b', ...finished, shortId: 'd2', lastActivityAt: minutesAgo(minutes[1]) }),
          ],
        }),
      ]);
    const { update } = renderList(done([1, 2]));
    expandFinished();
    expect(visibleRowNames()).toEqual(['done-a', 'done-b']);

    fireEvent.pointerEnter(list());
    update(done([2, 1]));
    expect(visibleRowNames()).toEqual(['done-a', 'done-b']);
    fireEvent.pointerLeave(list());
    expect(visibleRowNames()).toEqual(['done-b', 'done-a']);
  });

  it('applies a sort the reader chose at once, though the pointer and focus are in the list', () => {
    renderList(reordered());
    const select = screen.getByRole('combobox', { name: 'Sort' });
    expect(visibleRowNames()).toEqual(['third', 'first', 'second']);

    fireEvent.pointerEnter(list());
    act(() => select.focus());
    fireEvent.change(select, { target: { value: 'name' } });
    expect(visibleRowNames()).toEqual(['first', 'second', 'third']);
    fireEvent.change(select, { target: { value: 'urgency' } });
    expect(visibleRowNames()).toEqual(['third', 'first', 'second']);
  });

  it("applies a new selection's order at once", () => {
    const { update } = renderList();
    fireEvent.pointerEnter(list());
    update(reordered());
    expect(visibleRowNames()).toEqual(['first', 'second', 'third']);

    choose('Needs you');
    expect(visibleRowNames()).toEqual(['third']);
    choose('All sessions');
    expect(visibleRowNames()).toEqual(['third', 'first', 'second']);
  });

  it('never holds under Name, whose order only names change', () => {
    window.localStorage.setItem(SORT_KEY, 'name');
    const { update } = renderList();
    expect(visibleRowNames()).toEqual(['first', 'second', 'third']);

    fireEvent.pointerEnter(list());
    update(rows({ third: { name: 'a-third' } }));
    expect(visibleRowNames()).toEqual(['a-third', 'first', 'second']);
  });

  it('announces nothing it updates: the rows are in no live region', () => {
    const { update } = renderList();
    update(reordered());

    expect(list().querySelector('[aria-live], [role="status"], [role="alert"], [role="log"]')).toBeNull();
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

  it("marks each match in session names, titles and the rows' group labels, case-insensitively, and never in the repo list", () => {
    renderDashboard(highlightSnapshot());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: ' Export ' } });

    // tools matches by its group's label, exporter, which starts its line 2 in All sessions.
    expect(visibleRowNames()).toEqual(['export-retry', 'tools']);
    const retry = row('export-retry');
    expect(marks(retry.querySelector('.session-name')!)).toEqual(['export']);
    expect(marks(retry.querySelector('.session-title')!)).toEqual(['EXPORT']);
    // It matches by its directory too, which the row doesn't show.
    expect(marks(retry.querySelector('.session-what')!)).toEqual([]);
    expect(marks(row('tools').querySelector('.session-group')!)).toEqual(['export']);
    expect(marks(repoList())).toEqual([]);
    for (const mark of document.querySelectorAll('mark')) expect(mark.className).toBe('match');
  });

  it("keeps the text whole: a match doesn't change a name, its button's text or a title's tooltip", async () => {
    renderDashboard(highlightSnapshot());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'retry' } });

    const retry = row('export-retry');
    expect(retry.querySelector('[data-open-session]')?.textContent).toBe('export-retry');
    expect(retry.querySelector('.session-title')?.textContent).toBe('Retry a failed EXPORT');
    const title = retry.querySelector('.session-title')!;
    cutShort(title);
    expect(await tooltipText(title)).toBe('Retry a failed EXPORT');
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

    // Then the toasts' stack, fixed over the page, and there before any toast (4: Toasts).
    expect(parts()).toEqual(['app-header', 'columns', 'toasts']);
    // The third column's pane is there in every layout, empty below 1,200 px, so the session view never remounts.
    expect(columns()).toEqual(['nav.repo-list', 'main.session-list', 'div.session-pane']);
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

  it('shows the root in full in a tooltip, home-shortened on screen', async () => {
    renderDashboard(snapshot([], { roots: ['/Users/example/work/projects'] }));

    const roots = document.querySelector('.roots')!;
    expect(await tooltipText(roots)).toBe('/Users/example/work/projects');
    expect(roots.querySelector('.middle-ellipsis-start')?.textContent).toBe('~/work');
    expect(roots.querySelector('.middle-ellipsis-end')?.textContent).toBe('/projects');
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
              title: '<i>title</i> **markdown**',
              status: 'waiting',
              waitingFor: '<u>reason</u>',
              lastUserPrompt: hostile,
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
      '?view=starred',
      '?repo=/Users/example/code/demo-app',
    ]);
    expect(container.textContent).toContain('<a href="javascript:alert(3)">name</a>');
    expect(container.textContent).toContain('<i>label</i>');
    expect(container.textContent).toContain('Waiting: <u>reason</u>');
    expect(container.textContent).toContain('<script>alert(2)</script><b>bold</b>');
    expect(container.textContent).toContain('**markdown**');
  });

  it('drops terminal escapes and control characters', () => {
    renderDashboard(
      snapshot([
        group({
          sessions: [session({ name: 'esc', lastUserPrompt: '\u001b[31mred\u001b[0m and \u001b]0;title\u0007plain‮' })],
        }),
      ]),
    );

    expect(row('esc').querySelector('.prompt')?.textContent).toBe('You: red and plain');
  });
});

// Where it started, in View preferences (W42): the snapshot's groups as they are, W39's listing. The
// other modes are in ViewPreferences.test.tsx.
describe('Where it started: each session in one group (W39)', () => {
  const whereStarted = () => storageWith({ [GROUP_BY_KEY]: 'where-started' });
  const renderDashboard = (snap: IndexSnapshot | undefined, overrides: Partial<ConnectionView> = {}, options: RenderOptions = {}) =>
    renderWith(snap, overrides, { storage: whereStarted(), ...options });
  const ROOT = '/Users/example/code';
  const WORK = '/Users/example/work';
  const key = (name: string, root = ROOT) => `${root}/${name}`;
  const worked = (...names: string[]) => names.map((name, index) => ({ key: key(name), label: name, root: ROOT, calls: 20 - index, changes: 1, lastAt: minutesAgo(index + 1) }));

  /**
   * What the index sends once sessions have been scanned: each session in the group it started in
   * alone. Six sessions, two of which need you. `fromRoot` started in the root and worked in docs and
   * api; docs has no group, since nothing started there.
   */
  function oneGroupEach() {
    const inApp = session({ name: 'in-app', cwd: key('app'), status: 'waiting', waitingFor: 'permission prompt', lastUserPrompt: 'made-up prompt in app', workedIn: worked('api') });
    const app2 = session({ name: 'app-only', cwd: key('app') });
    const inApi = session({ name: 'in-api', cwd: key('api') });
    const fromRoot = session({ name: 'from-root', cwd: ROOT, askedYou: { reason: 'question', excerpt: 'Merge the made-up docs change?' }, workedIn: worked('docs', 'api') });
    const inNotes = session({ name: 'in-notes', cwd: key('notes'), workedIn: worked('docs') });
    const alone = session({ name: 'alone', cwd: ROOT });
    const snap = snapshot([
      group({ key: key('app'), label: 'app', sessions: [inApp, app2] }),
      group({ key: key('api'), label: 'api', sessions: [inApi] }),
      group({ key: key('notes'), label: 'notes', kind: 'directory', sessions: [inNotes] }),
      group({ key: ROOT, label: 'code', kind: 'directory', sessions: [fromRoot, alone] }),
    ]);
    return { snap, inApp, app2, inApi, fromRoot, inNotes, alone };
  }

  /** The number at an item's right: its sessions, or the badge's sessions that need you. */
  const counted = (link: Element, selector: string) => Number.parseInt(link.querySelector(selector)?.textContent ?? '0', 10);
  const groupLinks = (list: ParentNode) => [...list.querySelectorAll('a[data-repo-item]')].filter((link) => !['Needs you', 'All sessions'].includes(link.querySelector('.repo-item-label')?.textContent ?? ''));

  it('counts the sessions started in each group, so the groups’ badges add up to Needs you, and a repo sessions only worked in has no item', () => {
    renderDashboard(oneGroupEach().snap);
    expect(repoItems()).toEqual(['Needs you2 need you', 'All sessions6 sessions', 'Starred', '~/code, directory1 needs you', 'api, git repo1 session', 'app, git repo1 needs you', 'notes, directory1 session']);
    expect(repoItems().some((item) => item.startsWith('docs'))).toBe(false);
    const badges = groupLinks(repoList()).reduce((sum, link) => sum + counted(link, '.badge-attention'), 0);
    expect(badges).toBe(counted(repoItem('Needs you'), '.badge-attention'));
  });

  it('adds the groups’ counts in each root’s tab up to that root’s All sessions (W38)', () => {
    const calm = (name: string, cwd: string, repos: string[] = []) => session({ name, cwd, ...(repos.length > 0 ? { workedIn: worked(...repos) } : {}) });
    const snap = snapshot(
      [
        group({ key: key('app'), label: 'app', sessions: [calm('a1', key('app'), ['api']), calm('a2', key('app'))] }),
        group({ key: key('api'), label: 'api', sessions: [calm('p1', key('api'), ['app'])] }),
        group({ key: ROOT, label: 'code', kind: 'directory', sessions: [calm('r1', ROOT, ['app', 'api', 'docs']), calm('r2', ROOT)] }),
        group({ key: key('svc', WORK), label: 'svc', root: WORK, sessions: [calm('w1', key('svc', WORK), ['app'])] }),
      ],
      { roots: [ROOT, WORK] },
    );
    renderDashboard(snap);
    const sum = () => groupLinks(repoList()).reduce((total, link) => total + counted(link, '.repo-item-count'), 0);
    expect(sum()).toBe(5);
    expect(counted(repoItem('All sessions'), '.repo-item-count')).toBe(5);
    // Each group's summary says what its item does.
    for (const [label, count] of [['app', '2 sessions'], ['api', '1 session'], ['~/code', '2 sessions']] as const) {
      choose(label);
      expect(summary()).toBe(`${count}·Nothing needs you`);
    }
    fireEvent.click(screen.getAllByRole('tab')[1]!);
    expect(sum()).toBe(1);
    expect(counted(repoItem('All sessions'), '.repo-item-count')).toBe(1);
    choose('svc');
    expect(summary()).toBe('1 session·Nothing needs you');
  });

  it('lists each session once in All sessions and Needs you, and counts them in the summary and the title', () => {
    renderDashboard(oneGroupEach().snap);
    expect(visibleRowNames().sort()).toEqual(['alone', 'app-only', 'from-root', 'in-api', 'in-app', 'in-notes']);
    expect(summary()).toBe('6 sessions2 need you');
    expect(document.title).toBe('(2) pitwall');
    choose('Needs you');
    expect(visibleRowNames()).toEqual(['in-app', 'from-root']);
    expect(summary()).toBe('2 sessions2 need you');
  });

  it('names the group each row started in, in All sessions, the one it is listed under', () => {
    renderDashboard(oneGroupEach().snap);
    expect(line2('in-app')).toBe('app · You: made-up prompt in app');
    expect(line2('in-notes')).toBe('notes · You: run the tests');
    expect(line2('from-root')).toBe('~/code · Asked: Merge the made-up docs change?');
    expect(line2('alone')).toBe('~/code · You: run the tests');
  });

  it("lists only the sessions started in a group, and no row there starts with where it started", () => {
    renderDashboard(oneGroupEach().snap);
    choose('api');
    expect(visibleRowNames()).toEqual(['in-api']);
    expect(summary()).toBe('1 session·Nothing needs you');
    choose('~/code');
    expect(visibleRowNames()).toEqual(['from-root', 'alone']);
    expect(line2('from-root')).toBe('Asked: Merge the made-up docs change?');
    for (const label of ['app', 'api', 'notes', '~/code']) {
      choose(label);
      for (const name of visibleRowNames()) {
        expect(line2(name), `${label}: ${name}`).not.toMatch(/^Started in /);
        expect(row(name).querySelector('.session-group'), `${label}: ${name}`).toBeNull();
      }
    }
    expect(document.querySelector('.session-started')).toBeNull();
  });

  it('lets a row through the filter when a repo it worked in matches, whether or not that repo has a group', () => {
    renderDashboard(oneGroupEach().snap);
    // docs has no group: the two sessions that worked there.
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'docs' } });
    expect(visibleRowNames().sort()).toEqual(['from-root', 'in-notes']);
    // The badge counts the selection, as it always has, not what the filter shows.
    expect(summary()).toBe('2 of 6 sessions2 need you');
    // api has one: the session started there and the two that worked there.
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'api' } });
    expect(visibleRowNames().sort()).toEqual(['from-root', 'in-api', 'in-app']);
  });

  it('names every repo the session worked in, by its label, a repo with no group too, with the rule in an info button', () => {
    const { snap, fromRoot } = oneGroupEach();
    renderDashboard(snap, {}, { search: `?view=all&session=${fromRoot.sessionId}` });
    const line = () => document.querySelector('#session-view .session-view-worked');
    // The " · " is drawn; screen readers get ", and" instead.
    const shown = (element: Element) => [...element.childNodes].map((node) => (node instanceof HTMLElement && node.classList.contains('visually-hidden') ? '' : node.textContent)).join('');
    expect(shown(line()?.querySelector('.session-view-worked-text') as Element)).toBe('Started in ~/code · worked in docs, api');
    expect(line()?.querySelectorAll('.session-view-repo')).toHaveLength(3);
    // The names are text: nothing to select or follow.
    expect(line()?.querySelectorAll('a, button:not(.info-tip)')).toHaveLength(0);
    const info = within(line() as HTMLElement).getByRole('button');
    expect(info.getAttribute('aria-label')).toBe(
      "A repo counts when the session changed it, or when at least 5% of its tool calls touched it, its sub-agents' included. View preferences, in the header, sets which of these repos list the session; to find every session that worked in a repo, type its name in the filter on All sessions.",
    );
    // Rows keep their two lines.
    expect(row('from-root').children).toHaveLength(2);
  });

  it('has no worked-in line for a session that worked in no other repo, or has not been scanned yet', () => {
    const { snap, app2 } = oneGroupEach();
    renderDashboard(snap, {}, { search: `?view=all&session=${app2.sessionId}` });
    expect(document.querySelector('#session-view')).toBeTruthy();
    expect(document.querySelector('.session-view-worked')).toBeNull();
  });

  it('selects the group a ?session= started in, the root’s own for one started there that worked in repos', () => {
    const first = oneGroupEach();
    const opened = renderDashboard(first.snap, {}, { search: `?session=${first.inApp.sessionId}` });
    expect(listHeading().textContent).toBe('app, git repo');
    opened.unmount();
    const second = oneGroupEach();
    renderDashboard(second.snap, {}, { search: `?session=${second.fromRoot.sessionId}` });
    expect(listHeading().textContent).toBe('~/code, directory');
  });

  it('falls back as before when a saved selection names a group that has gone, such as a directory that emptied', () => {
    const storage = (() => {
      const values = new Map([[VIEW_STATE_KEY, `repo=${key('scratch')}`], [GROUP_BY_KEY, 'where-started']]);
      const store = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), removeItem: (k: string) => void values.delete(k) };
      return () => store as unknown as Storage;
    })();
    renderDashboard(oneGroupEach().snap, {}, { storage });
    expect(listHeading().textContent).toBe('scratch');
    expect(screen.getByText('No sessions in scratch now')).toBeTruthy();
    expect(screen.getByText('Its sessions are no longer listed under these roots.')).toBeTruthy();
    expect(repoList().querySelector('[aria-current]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all sessions' }));
    expect(listHeading().textContent).toBe('All sessions');
  });

  it("names the root's group by its path once its sessions have gone, with the fallback any group that has gone has", () => {
    const navigation = memoryNavigation(`?repo=${ROOT}`);
    const elsewhere = session({ name: 'elsewhere', cwd: key('api'), workedIn: worked('docs') });
    render(<Dashboard view={{ state: 'live', snapshot: snapshot([group({ key: key('api'), label: 'api', sessions: [elsewhere] })]) }} navigation={navigation} storage={whereStarted()} />);
    expect(listHeading().textContent).toBe('~/code');
    expect(screen.getByText('No sessions in ~/code now')).toBeTruthy();
    expect(screen.getByText('Its sessions are no longer listed under these roots.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show all sessions' }));
    expect(visibleRowNames()).toEqual(['elsewhere']);
  });

  it("keeps a session in the root's group once its scan finds repos, and gives those repos no item", () => {
    const navigation = memoryNavigation(`?repo=${ROOT}`);
    const alone = session({ name: 'alone', cwd: ROOT });
    const other = session({ name: 'other', cwd: ROOT });
    const storage = whereStarted();
    const ui = (snap: IndexSnapshot) => <Dashboard view={{ state: 'live', snapshot: snap }} navigation={navigation} storage={storage} />;
    const zeta = group({ key: key('zeta'), label: 'zeta', sessions: [session({ name: 'z' })] });
    const { rerender } = render(ui(snapshot([zeta, group({ key: ROOT, label: 'code', kind: 'directory', sessions: [alone, other] })])));
    expect(visibleRowNames()).toEqual(['alone', 'other']);
    const before = repoItems();
    rerender(ui(snapshot([zeta, group({ key: ROOT, label: 'code', kind: 'directory', sessions: [{ ...alone, workedIn: worked('beta', 'zeta') }, other] })])));
    expect(visibleRowNames()).toEqual(['alone', 'other']);
    expect(repoItems()).toEqual(before);
    expect(repoItems()).toEqual(['Needs you', 'All sessions3 sessions', 'Starred', '~/code, directory2 sessions', 'zeta, git repo1 session']);
  });

  it('moves focus to the row that takes its place when the focused row leaves the selected group, or to the heading when none is left', () => {
    const navigation = memoryNavigation(`?repo=${ROOT}`);
    const a = session({ name: 'first-in-root', cwd: ROOT, lastActivityAt: minutesAgo(1) });
    const b = session({ name: 'second-in-root', cwd: ROOT, lastActivityAt: minutesAgo(2) });
    const elsewhere = group({ key: key('api'), label: 'api', sessions: [session({ name: 'in-api', cwd: key('api') })] });
    const ui = (sessions: SessionSummary[]) => (
      <Dashboard view={{ state: 'live', snapshot: snapshot([...(sessions.length ? [group({ key: ROOT, label: 'code', kind: 'directory', sessions })] : []), elsewhere]) }} navigation={navigation} />
    );
    const { rerender } = render(ui([a, b]));
    const button = (name: string) => within(row(name)).getByRole('button', { name });
    button('first-in-root').focus();
    // It held the order, but a row that leaves, here because the session went, goes at once.
    rerender(ui([b]));
    expect(visibleRowNames()).toEqual(['second-in-root']);
    expect(document.activeElement).toBe(button('second-in-root'));
    rerender(ui([]));
    expect(document.activeElement).toBe(listHeading());
  });
});
