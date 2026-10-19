import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lastMessagePath, type IndexSnapshot, type LastMessage, type SessionSummary } from '../../../src/shared/protocol.js';
import { createApiClient } from '../api.js';
import type { ConnectionView } from '../connection.js';
import { FINISHED_STATE_KEY, GROUP_STATE_KEY, type StorageSource } from '../groupState.js';
import { createReplyLoader, ReplyLoaderContext, type FetchLike } from '../lastMessage.js';
import { group, minutesAgo, mixedSnapshot, NOW, session, snapshot } from '../test/fixtures.js';
import { Dashboard } from './Dashboard.js';

interface RenderOptions {
  /** Open every group, and every group's Finished list, after rendering, as most tests look at rows. Default true. */
  expand?: boolean;
  storage?: StorageSource;
}

function renderDashboard(snap: IndexSnapshot | undefined, overrides: Partial<ConnectionView> = {}, options: RenderOptions = {}) {
  const view: ConnectionView = { state: 'live', snapshot: snap, ...overrides };
  const result = render(<Dashboard view={view} {...(options.storage ? { storage: options.storage } : {})} />);
  if (options.expand !== false) {
    for (const toggle of result.container.querySelectorAll<HTMLElement>('.group-toggle[aria-expanded="false"], .finished-toggle[aria-expanded="false"]')) {
      fireEvent.click(toggle);
    }
  }
  return result;
}

function row(name: string): HTMLElement {
  const item = screen.getByRole('heading', { level: 3, name }).closest('li');
  if (!item) throw new Error(`no row for ${name}`);
  return item;
}

function groupSection(label: string): HTMLElement {
  const toggle = screen
    .queryAllByRole('button', { expanded: true })
    .concat(screen.queryAllByRole('button', { expanded: false }))
    .find((button) => within(button).queryByText(label, { selector: '.group-label' }));
  const section = toggle?.closest('section');
  if (!section) throw new Error(`no group ${label}`);
  return section;
}

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

    expect(screen.getByText('~/code, /srv/projects')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('updated 3s ago')).toBeTruthy();

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText('updated 5s ago')).toBeTruthy();
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

  it('counts sessions that need attention, in the page and the tab title', () => {
    renderDashboard(mixedSnapshot());

    expect(screen.getByText('2 need you', { selector: '.summary-attention' })).toBeTruthy();
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

describe('groups', () => {
  it('renders one section per group in the order given, with marker, count and attention count', () => {
    renderDashboard(mixedSnapshot());

    const toggles = screen.getAllByRole('button', { expanded: true });
    expect(toggles.map((button) => button.textContent)).toEqual([
      'git repodemo-app3 sessions2 need you',
      'directorynotes1 session',
      'git repolegacy1 session',
    ]);
  });

  it('collapses and expands a group', () => {
    renderDashboard(mixedSnapshot());
    const section = groupSection('demo-app');
    const toggle = within(section).getByRole('button', { expanded: true });
    const list = section.querySelector('ul')!;

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(list.hidden).toBe(true);

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);
  });

  it('keeps two groups with the same key under different roots apart', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A worktree under one root whose main repo is under another: both groups
    // are keyed by the main repo.
    const key = '/Users/example/code/demo-app';
    renderDashboard(
      snapshot(
        [
          group({ key, label: 'demo-app', root: '/Users/example/code', sessions: [session({ name: 'in-main' })] }),
          group({
            key,
            label: '~/code/demo-app',
            root: '/Users/example/worktrees',
            sessions: [session({ name: 'in-worktree', cwd: '/Users/example/worktrees/demo-app-feature' })],
          }),
        ],
        { roots: ['/Users/example/code', '/Users/example/worktrees'] },
      ),
    );

    const main = groupSection('demo-app');
    const worktree = groupSection('~/code/demo-app');
    fireEvent.click(within(main).getByRole('button', { name: /demo-app/ }));
    expect(main.querySelector('ul')!.hidden).toBe(true);
    expect(worktree.querySelector('ul')!.hidden).toBe(false);
    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key/);
  });

  it('shows which root a group is under when there are several roots', () => {
    const snap = mixedSnapshot();
    snap.roots = ['/Users/example/code', '/Users/example/other'];
    renderDashboard(snap);

    expect(within(groupSection('notes')).getByText('in ~/code')).toBeTruthy();
  });
});

describe('group open state', () => {
  const ROOT = '/Users/example/code';
  /** The stored id of a group in mixedSnapshot(): root and key. */
  const id = (name: string) => `${ROOT}\0${ROOT}/${name}`;
  const stored = () => JSON.parse(window.localStorage.getItem(GROUP_STATE_KEY) ?? 'null') as unknown;
  const isOpen = (label: string) => !groupSection(label).querySelector('ul')!.hidden;

  it('starts every group collapsed, still showing the label, the count and the attention badge', () => {
    renderDashboard(mixedSnapshot(), {}, { expand: false });

    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0);
    expect(screen.getAllByRole('button', { expanded: false }).map((button) => button.textContent)).toEqual([
      'git repodemo-app3 sessions2 need you',
      'directorynotes1 session',
      'git repolegacy1 session',
    ]);
    expect(['demo-app', 'notes', 'legacy'].map(isOpen)).toEqual([false, false, false]);
    expect(visibleRowNames()).toEqual([]);
    expect(window.localStorage.getItem(GROUP_STATE_KEY)).toBeNull();
  });

  it('remembers a group opened or closed, across a reload', () => {
    const first = renderDashboard(mixedSnapshot(), {}, { expand: false });
    fireEvent.click(within(groupSection('notes')).getByRole('button', { expanded: false }));
    expect(stored()).toEqual({ [id('notes')]: true });
    first.unmount();

    const second = renderDashboard(mixedSnapshot(), {}, { expand: false });
    expect(['demo-app', 'notes', 'legacy'].map(isOpen)).toEqual([false, true, false]);
    expect(visibleRowNames()).toEqual(['notes-tidy']);

    fireEvent.click(within(groupSection('notes')).getByRole('button', { expanded: true }));
    expect(stored()).toEqual({ [id('notes')]: false });
    second.unmount();

    renderDashboard(mixedSnapshot(), {}, { expand: false });
    expect(isOpen('notes')).toBe(false);
  });

  it('restores the state from storage', () => {
    window.localStorage.setItem(GROUP_STATE_KEY, JSON.stringify({ [id('legacy')]: true, [id('notes')]: false }));

    renderDashboard(mixedSnapshot(), {}, { expand: false });

    expect(['demo-app', 'notes', 'legacy'].map(isOpen)).toEqual([false, false, true]);
  });

  it('starts collapsed, and still toggles, when storage throws', () => {
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    const throwing: StorageSource = () => ({ getItem: denied, setItem: denied });
    const first = renderDashboard(mixedSnapshot(), {}, { expand: false, storage: throwing });
    expect(['demo-app', 'notes', 'legacy'].map(isOpen)).toEqual([false, false, false]);
    fireEvent.click(within(groupSection('notes')).getByRole('button', { expanded: false }));
    expect(isOpen('notes')).toBe(true);
    first.unmount();

    // Some browsers throw on reading window.localStorage itself.
    renderDashboard(mixedSnapshot(), {}, { expand: false, storage: denied });
    expect(isOpen('demo-app')).toBe(false);
    fireEvent.click(within(groupSection('demo-app')).getByRole('button', { expanded: false }));
    expect(isOpen('demo-app')).toBe(true);
  });

  it('starts collapsed when the stored data is not the expected shape', () => {
    for (const raw of ['not json', '[]', 'null', '7', JSON.stringify({ [id('notes')]: 'yes' })]) {
      window.localStorage.setItem(GROUP_STATE_KEY, raw);
      const { unmount } = renderDashboard(mixedSnapshot(), {}, { expand: false });
      expect(['demo-app', 'notes', 'legacy'].map(isOpen), raw).toEqual([false, false, false]);
      unmount();
    }
  });

  it('drops entries for groups that are not in the snapshot when it writes', () => {
    window.localStorage.setItem(
      GROUP_STATE_KEY,
      JSON.stringify({ [id('removed-worktree')]: true, [id('notes')]: true, [`/other/root\0${ROOT}/notes`]: false }),
    );

    renderDashboard(mixedSnapshot(), {}, { expand: false });
    fireEvent.click(within(groupSection('legacy')).getByRole('button', { expanded: false }));

    expect(stored()).toEqual({ [id('notes')]: true, [id('legacy')]: true });
  });

  it('keeps a group open while a filter hides it, since it is still in the snapshot', () => {
    renderDashboard(mixedSnapshot(), {}, { expand: false });
    fireEvent.click(within(groupSection('notes')).getByRole('button', { expanded: false }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'legacy' } });
    fireEvent.click(within(groupSection('legacy')).getByRole('button', { expanded: false }));

    expect(stored()).toEqual({ [id('notes')]: true, [id('legacy')]: true });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(['demo-app', 'notes', 'legacy'].map(isOpen)).toEqual([false, true, true]);
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

  it('counts them in the group badges, the header and the tab title, except a finished one', () => {
    renderDashboard(askedSnapshot());

    expect(within(groupSection('demo-app')).getByText('2 need you')).toBeTruthy();
    // docs-done asked something, but it has finished: muted, and not counted.
    expect(groupSection('docs').querySelector('.group-attention')).toBeNull();
    expect(groupSection('docs').className).not.toContain('has-attention');
    expect(screen.getByText('2 need you', { selector: '.summary-attention' })).toBeTruthy();
    expect(document.title).toBe('(2) pitwall');
  });

  it('keeps them under "needs attention only", but not a finished one', () => {
    renderDashboard(askedSnapshot());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Needs attention only' }));

    expect(visibleRowNames()).toEqual(['waits', 'asks']);
    expect(screen.queryByRole('button', { name: /^Finished/ })).toBeNull();
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

  /** Opens every group, leaving the Finished lists as they start. */
  function render(snap = finishedSnapshot(), storage?: StorageSource) {
    const result = renderDashboard(snap, {}, { expand: false, ...(storage ? { storage } : {}) });
    for (const toggle of result.container.querySelectorAll<HTMLElement>('.group-toggle[aria-expanded="false"]')) fireEvent.click(toggle);
    return result;
  }

  const finishedToggle = (label: string) => within(groupSection(label)).getByRole('button', { name: /^Finished \(\d+\)/ });
  const finishedOpen = (label: string) => finishedToggle(label).getAttribute('aria-expanded') === 'true';
  const stored = () => JSON.parse(window.localStorage.getItem(FINISHED_STATE_KEY) ?? 'null') as unknown;

  it('lists them in a collapsed "Finished (n)" sub-list at the bottom of their group', () => {
    render();

    const toggle = finishedToggle('demo-app');
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
    // After the group's other rows.
    const last = groupSection('demo-app').querySelector('ul.sessions')!.lastElementChild;
    expect(last?.contains(toggle)).toBe(true);
  });

  it('says on the Finished line how many finished sessions asked something, muted, and never as needing you', () => {
    const asked = { reason: 'question' as const, excerpt: 'Ship it?' };
    render(
      snapshot([
        group({
          sessions: [
            session({ name: 'live-one', status: 'idle' }),
            session({ name: 'f1', ...finished, shortId: 'f1', state: 'done', askedYou: asked }),
            session({ name: 'f2', ...finished, shortId: 'f2', state: 'stopped' }),
            session({ name: 'f3', ...finished, shortId: 'f3', state: 'failed', askedYou: asked }),
          ],
        }),
      ]),
    );

    const toggle = finishedToggle('demo-app');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Finished (3) · 2 asked you');
    const count = toggle.querySelector('.finished-asked');
    expect(count?.textContent).toBe(' · 2 asked you');
    expect(count?.closest('.group-attention, .tone-asked, .attention')).toBeNull();
    expect(groupSection('demo-app').querySelector('.group-attention')).toBeNull();
    expect(screen.getByText(/nothing needs you/)).toBeTruthy();
    // Stays the same open, so the button's name doesn't change under the user.
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe('Finished (3) · 2 asked you');
  });

  it('leaves the asked count off a Finished line whose sessions asked nothing', () => {
    render();

    expect(finishedToggle('old').textContent).toBe('Finished (1)');
    expect(finishedToggle('old').querySelector('.finished-asked')).toBeNull();
  });

  it('counts finished sessions in the group total, but never as needing you', () => {
    render();

    expect(groupSection('demo-app').querySelector('.group-count')?.textContent).toBe('4 sessions');
    expect(groupSection('demo-app').querySelector('.group-attention')).toBeNull();
    expect(screen.getByText(/nothing needs you/)).toBeTruthy();
    expect(document.title).toBe('pitwall');
  });

  it('mutes finished rows, with the state as the pill and a muted asked-you badge', () => {
    render();
    fireEvent.click(finishedToggle('demo-app'));

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

  it('shows a group whose sessions have all finished with only its Finished list', () => {
    render();

    expect(groupSection('old').querySelector('.group-count')?.textContent).toBe('1 session');
    expect(finishedToggle('old').textContent).toBe('Finished (1)');
    fireEvent.click(finishedToggle('old'));
    expect(row('stopped-one').querySelector('.pill')?.textContent).toBe('stopped');
  });

  it('opens a finished row in the session view, like any other row', () => {
    render();
    fireEvent.click(finishedToggle('old'));

    fireEvent.click(within(row('stopped-one')).getByRole('button', { name: 'stopped-one' }));
    expect(screen.getByRole('dialog', { name: 'stopped-one' })).toBeTruthy();
  });

  it('remembers each group\'s Finished list, apart from the group itself, across a reload', () => {
    const first = render();
    fireEvent.click(finishedToggle('old'));
    expect(stored()).toEqual({ [id('old')]: true });
    expect(JSON.parse(window.localStorage.getItem(GROUP_STATE_KEY) ?? 'null')).toEqual({ [id('demo-app')]: true, [id('old')]: true });
    first.unmount();

    const second = render();
    expect([finishedOpen('demo-app'), finishedOpen('old')]).toEqual([false, true]);
    fireEvent.click(finishedToggle('old'));
    expect(stored()).toEqual({ [id('old')]: false });
    second.unmount();

    render();
    expect(finishedOpen('old')).toBe(false);
  });

  it('starts collapsed, and still toggles, when storage throws or holds the wrong shape', () => {
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    const first = render(finishedSnapshot(), () => ({ getItem: denied, setItem: denied }));
    expect(finishedOpen('demo-app')).toBe(false);
    fireEvent.click(finishedToggle('demo-app'));
    expect(finishedOpen('demo-app')).toBe(true);
    first.unmount();

    window.localStorage.setItem(FINISHED_STATE_KEY, '[]');
    render();
    expect([finishedOpen('demo-app'), finishedOpen('old')]).toEqual([false, false]);
  });

  it('keeps a finished session that matches the text filter in its Finished list', () => {
    render();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'failed-one' } });

    expect(finishedToggle('demo-app').textContent).toBe('Finished (1)');
    expect(visibleRowNames()).toEqual([]);
    fireEvent.click(finishedToggle('demo-app'));
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

  it('shows "x of y" when the filter hides some of a group', () => {
    renderDashboard(mixedSnapshot());

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'demo-api' } });

    expect(within(groupSection('demo-app')).getByText('1 of 3 sessions')).toBeTruthy();
  });

  it('says so when nothing matches', () => {
    renderDashboard(mixedSnapshot());

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });

    expect(visibleRowNames()).toEqual([]);
    expect(screen.getByText('No sessions match the filter.')).toBeTruthy();
  });

  it('"needs attention only" keeps waiting and blocked sessions and drops stale ones', () => {
    renderDashboard(mixedSnapshot());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Needs attention only' }));
    expect(visibleRowNames()).toEqual(['demo-docs', 'demo-worker']);

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'worker' } });
    expect(visibleRowNames()).toEqual(['demo-worker']);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Needs attention only' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(visibleRowNames()).toHaveLength(5);
  });

  it('says nothing needs you when the toggle is on and nothing does', () => {
    renderDashboard(snapshot([group({ sessions: [session({ name: 'calm', status: 'idle' })] })]));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Needs attention only' }));

    expect(screen.getByText('Nothing needs you right now.')).toBeTruthy();
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

  /** Renders the dashboard with a reply loader over `fetch`, every group open. */
  function renderWithReplies(rowSession: SessionSummary, fetch: FetchLike) {
    const loader = createReplyLoader({ api: createApiClient({ apiKey: 'test-token', fetch }) });
    const ui = (s: SessionSummary) => (
      <ReplyLoaderContext.Provider value={loader}>
        <Dashboard view={{ state: 'live', snapshot: snapshot([group({ sessions: [s] })]) }} />
      </ReplyLoaderContext.Provider>
    );
    const result = render(ui(rowSession));
    for (const toggle of result.container.querySelectorAll<HTMLElement>('.group-toggle[aria-expanded="false"]')) {
      fireEvent.click(toggle);
    }
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

    expect(container.querySelector('img, script, b, a, i, u')).toBeNull();
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
