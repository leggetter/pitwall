// Pull requests in the web UI (M4, W95; docs/design-system.md, 4: Pull requests): the repo list's
// item and its count, the PR list with its repo headings, collapsed and remembered, its rows, Show
// older, the filter and each source state; Refresh and its answers; the session row's badge and the
// session view's links; the PR view; and navigation both ways, with the back button and the keys.
// W101's PRs that ask your review or mention you, their chips, badges and sentence. Made-up PRs,
// repos, teams and sessions only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PRS_MAX, PRS_REFRESH_MIN_MS, PRS_REFRESH_PATH, type IndexSnapshot, type PullRequestList } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import type { ConnectionView } from '../connection.js';
import type { StorageSource } from '../groupState.js';
import { fnv1a64 } from '../notNeeded.js';
import { PRS_OFF_TEXT, refreshFailedText, refreshSoonText } from '../prRefresh.js';
import { PR_REPOS_KEY } from '../prRepos.js';
import { prKey, sessionsFor } from '../prs.js';
import { memoryNavigation, type NavigationEnv } from '../selection.js';
import { createShortcutsStore, ShortcutsStoreContext } from '../shortcuts.js';
import { group, minutesAgo, NOW, pr, prLink, prList, session, snapshot } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { toastMessages } from '../test/toasts.js';
import { Dashboard } from './Dashboard.js';
import { NO_RELATION, PrList, REFRESH_LABEL, REFRESH_OFF } from './PrList.js';
import { COPY_LINK, OPEN_ON_GITHUB, PR_MISSING, PrView } from './PrView.js';
import type { TerminalHandle } from './Terminal.js';

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
const API_KEY = 'a'.repeat(43);
const DAY = 60 * 24;

// The made-up PRs: two in demo-app, two in event-relay, and one in blog older than the 90 days.
const failing = pr({ number: 42, title: 'Fix the made-up export job', checks: 'failing', failingChecks: ['test (22.x)', 'lint'], failingCount: 4 }, 30);
const approved = pr({ number: 43, review: 'approved' }, 200);
const conflicts = pr({ number: 9, repoLabel: 'example/event-relay', mergeable: 'conflicts' }, 10);
const draft = pr({ number: 8, repoLabel: 'example/event-relay', draft: true, checks: 'pending', mergeable: 'unknown' }, 300);
const older = pr({ number: 3, repoLabel: 'example/blog', review: 'changes-requested' }, 100 * DAY);
const PRS = [conflicts, failing, approved, draft, older];

/** The made-up sessions: alpha opened #42 and pushed #43's branch, beta pushed to #9, gamma named #42 in a reply, delta (finished) was given #42. */
function sessions() {
  const alpha = session({ sessionId: 'pr-alpha', name: 'alpha', prLinks: [prLink('opened', failing, 5), prLink('pushed', approved, 2)] });
  const beta = session({ sessionId: 'pr-beta', name: 'beta', cwd: `${ROOT}/event-relay`, prLinks: [prLink('pushed', conflicts, 3)] });
  const gamma = session({ sessionId: 'pr-gamma', name: 'gamma', prLinks: [prLink('mentioned', failing, 1)] });
  const delta = session({ sessionId: 'pr-delta', name: 'delta', kind: 'background', shortId: 'd95', alive: false, pid: undefined, status: undefined, state: 'done', finished: true, prLinks: [prLink('prompted', failing, 40)] });
  const epsilon = session({ sessionId: 'pr-epsilon', name: 'epsilon' });
  return { alpha, beta, gamma, delta, epsilon };
}

function snap(): IndexSnapshot {
  const { alpha, beta, gamma, delta, epsilon } = sessions();
  return snapshot([
    group({ key: `${ROOT}/demo-app`, label: 'demo-app', sessions: [alpha, gamma, epsilon, delta] }),
    group({ key: `${ROOT}/event-relay`, label: 'event-relay', sessions: [beta] }),
  ]);
}

function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const source: StorageSource = () => ({ getItem: (name) => items.get(name) ?? null, setItem: (name, value) => void items.set(name, value) });
  return { items, source };
}

interface Options {
  search?: string;
  navigation?: NavigationEnv;
  storage?: StorageSource;
  fetch?: FetchLike;
}

/** The Dashboard with `prs` as the latest 'prs' message's list, or none yet with null. */
function renderDashboard(prs: PullRequestList | null = prList(PRS), options: Options = {}) {
  const storage = options.storage ?? memory().source;
  const navigation = options.navigation ?? memoryNavigation(options.search ?? '?view=prs');
  const shortcuts = createShortcutsStore({ storage: memory().source, events: { addEventListener: () => {} } });
  const api = createApiClient({ apiKey: API_KEY, fetch: options.fetch ?? vi.fn<FetchLike>(async () => new Response('{}', { status: 200 })) });
  const ui = (list: PullRequestList | null, s: IndexSnapshot = snap()) => {
    const view: ConnectionView = list ? { state: 'live', snapshot: s, prs: list } : { state: 'live', snapshot: s };
    return (
      <ApiContext.Provider value={api}>
        <ShortcutsStoreContext.Provider value={shortcuts}>
          <Dashboard view={view} navigation={navigation} storage={storage} />
        </ShortcutsStoreContext.Provider>
      </ApiContext.Provider>
    );
  };
  const result = render(ui(prs));
  return { ...result, navigation, again: (next: PullRequestList | null) => result.rerender(ui(next)) };
}

const settle = () => act(async () => {});
const main = () => screen.getByRole('main');
const repoList = () => screen.getByRole('navigation', { name: 'Repos' });
const prItem = () => [...repoList().querySelectorAll<HTMLAnchorElement>('a[data-repo-item]')].find((link) => link.querySelector('.repo-item-label')?.textContent === 'Pull requests');
const repoHeadings = () => [...main().querySelectorAll('.pr-repo-label')].map((label) => label.textContent);
const prRows = () => [...main().querySelectorAll<HTMLElement>('[data-open-pr]')].filter((button) => !button.closest('[hidden]')).map((button) => button.dataset.openPr);
const row = (number: number) => main().querySelector<HTMLElement>(`li[data-pr$="/${number}"]`)!;
const prView = () => document.getElementById('pr-view') ?? undefined;
const sessionView = () => document.getElementById('session-view') ?? undefined;
const summary = () => main().querySelector('.summary')?.textContent ?? '';

function press(key: string, target: Element | null = document.activeElement) {
  act(() => {
    fireEvent.keyDown(target ?? document.body, { key });
  });
}

describe('the repo list', () => {
  it("has no Pull requests item before a 'prs' message has come, as from a pitwall from before M4", () => {
    renderDashboard(null, { search: '?view=all' });
    expect(prItem()).toBeUndefined();
  });

  it('counts failing checks and conflicts, not the older changes requested, in subtle danger', () => {
    renderDashboard(prList(PRS), { search: '?view=all' });
    const labels = [...repoList().querySelectorAll('a[data-repo-item] .repo-item-label')].map((label) => label.textContent);
    expect(labels.slice(0, 4)).toEqual(['Needs you', 'All sessions', 'Starred', 'Pull requests']);
    const badge = prItem()?.querySelector('.badge');
    expect(badge?.textContent).toBe('2 need attention');
    expect(badge?.classList.contains('badge-subtle-danger')).toBe(true);
  });

  it('shows how many there are while none needs attention, and nothing before the first fetch', () => {
    const { again } = renderDashboard(prList([approved, draft]), { search: '?view=all' });
    expect(prItem()?.querySelector('.repo-item-count')?.textContent).toBe('2 pull requests');
    again(prList([], { fetchedAt: undefined, refreshing: true }));
    expect(prItem()).toBeDefined();
    expect(prItem()?.querySelector('.repo-item-count, .badge')).toBeNull();
  });

  it('has no item while pull requests are off', () => {
    renderDashboard(prList([], { fetchedAt: undefined, source: { ok: false, reason: 'off', error: 'Off.' } }), { search: '?view=all' });
    expect(prItem()).toBeUndefined();
  });

  it('selects the PR list in the session list column, with ?view=prs', async () => {
    const { navigation } = renderDashboard(prList(PRS), { search: '?view=all' });
    fireEvent.click(prItem()!);
    await settle();
    expect(navigation.location.search).toBe('?view=prs');
    expect(within(main()).getByRole('heading', { level: 2 }).textContent).toBe('Pull requests');
    expect(prItem()?.getAttribute('aria-current')).toBe('page');
  });
});

describe('the PR list', () => {
  it('heads each repo by its newest update, the PRs that need attention first, with the summary', () => {
    renderDashboard();
    expect(summary()).toBe('4 open2 need attention');
    expect(repoHeadings()).toEqual(['example/event-relay', 'example/demo-app']);
    expect(prRows()).toEqual(['example/event-relay/9', 'example/event-relay/8', 'example/demo-app/42', 'example/demo-app/43']);
    const heading = within(main()).getByRole('button', { name: /example\/demo-app/ });
    expect(heading.textContent).toBe('example/demo-app2 open1 needs attention');
    expect(heading.getAttribute('aria-expanded')).toBe('true');
  });

  it('gives each row its title in <bdi>, its badges, its number, and its strongly linked sessions', () => {
    renderDashboard();
    const fortyTwo = row(42);
    expect(fortyTwo.querySelector('bdi')?.textContent).toBe('Fix the made-up export job');
    expect([...fortyTwo.querySelectorAll('.badge')].map((badge) => badge.textContent)).toEqual(['Checks failing']);
    // alpha opened it and delta was given it; gamma only named it, so it isn't here.
    expect(fortyTwo.querySelector('.pr-what')?.textContent).toBe('#42 · , sessions alpha, delta');
    expect([...fortyTwo.querySelectorAll('.pr-sessions bdi')].map((bdi) => bdi.textContent)).toEqual(['alpha', 'delta']);
    expect([...row(8).querySelectorAll('.badge')].map((badge) => badge.textContent)).toEqual(['Draft', 'Checks pending']);
    expect([...row(43).querySelectorAll('.badge')].map((badge) => badge.textContent)).toEqual(['Approved']);
    const many = sessionsFor(failing, [...Object.values(sessions()), session({ name: 'zeta', prLinks: [prLink('opened', failing)] })]).strong;
    expect(many).toHaveLength(3);
  });

  it('names two sessions, then "+n"', () => {
    const extra = ['zeta', 'eta', 'theta'].map((name) => session({ name, prLinks: [prLink('opened', approved)] }));
    const base = snap();
    const s = { ...base, groups: [...base.groups, group({ key: `${ROOT}/more`, label: 'more', sessions: extra })] };
    const storage = memory().source;
    const navigation = memoryNavigation('?view=prs');
    render(
      <Dashboard view={{ state: 'live', snapshot: s, prs: prList(PRS) }} navigation={navigation} storage={storage} />,
    );
    expect(row(43).querySelector('.pr-sessions')?.textContent).toMatch(/^ · , sessions (alpha|zeta|eta|theta), (alpha|zeta|eta|theta) \+2, and 2 more$/);
  });

  it('collapses a repo, and remembers it by a hash of its name, never the name', () => {
    const store = memory();
    const first = renderDashboard(prList(PRS), { storage: store.source });
    const toggle = within(main()).getByRole('button', { name: /example\/event-relay/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(prRows()).toEqual(['example/demo-app/42', 'example/demo-app/43']);
    const raw = store.items.get(PR_REPOS_KEY) ?? '';
    expect(raw).not.toContain('event-relay');
    expect(JSON.parse(raw)).toEqual({ v: 1, collapsed: [fnv1a64('example/event-relay')] });
    first.unmount();
    // A reload: still collapsed, with its counts in sight.
    renderDashboard(prList(PRS), { storage: store.source });
    expect(within(main()).getByRole('button', { name: /example\/event-relay/ }).getAttribute('aria-expanded')).toBe('false');
    expect(within(main()).getByRole('button', { name: /example\/event-relay/ }).textContent).toContain('1 needs attention');
  });

  it('lists the PRs older than 90 days behind Show older, which keeps focus as Hide older', async () => {
    renderDashboard();
    expect(prRows()).not.toContain('example/blog/3');
    const show = within(main()).getByRole('button', { name: 'Show 1 older pull request' });
    expect(show.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.click(show);
    await settle();
    expect(prRows()).toContain('example/blog/3');
    expect(summary()).toBe('5 open3 need attention');
    expect(document.activeElement?.textContent).toBe('Hide older pull requests');
  });

  it('has Show older as the empty state when every PR is older', () => {
    renderDashboard(prList([older]));
    expect(screen.getByText('No pull requests updated in the last 90 days')).toBeDefined();
    fireEvent.click(within(main()).getByRole('button', { name: 'Show 1 older pull request' }));
    expect(prRows()).toEqual(['example/blog/3']);
  });

  it('filters by title, repo, number and branch, and says when nothing matches', () => {
    renderDashboard();
    const field = within(main()).getByRole('searchbox', { name: 'Filter pull requests' });
    expect(field.getAttribute('placeholder')).toBe('Filter by title, repo, number or branch');
    fireEvent.change(field, { target: { value: 'event-relay' } });
    expect(prRows()).toEqual(['example/event-relay/9', 'example/event-relay/8']);
    expect(summary()).toBe('2 of 4 open2 need attention');
    fireEvent.change(field, { target: { value: 'export' } });
    expect(prRows()).toEqual(['example/demo-app/42']);
    expect(row(42).querySelector('mark')?.textContent).toBe('export');
    fireEvent.change(field, { target: { value: 'branch-43' } });
    expect(prRows()).toEqual(['example/demo-app/43']);
    fireEvent.change(field, { target: { value: 'nothing like it' } });
    expect(screen.getByText('No pull requests match')).toBeDefined();
    fireEvent.click(within(main()).getByRole('button', { name: 'Clear filter' }));
    expect(prRows()).toHaveLength(4);
    expect(document.activeElement).toBe(field);
  });

  it('says when GitHub found more than PRS_MAX', () => {
    renderDashboard(prList(PRS, { truncated: true }));
    expect(main().querySelector('.pr-truncated')?.textContent).toBe(`GitHub found more than ${PRS_MAX} pull requests for one of its searches, so the ${PRS_MAX} of them updated most recently are listed.`);
  });

  it('says when it was fetched', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    renderDashboard();
    expect(main().querySelector('.pr-list-updated')?.textContent).toMatch(/^Updated (\d+m ago|just now)$/);
  });
});

describe('each source state', () => {
  it('waits for the first fetch', () => {
    renderDashboard(prList([], { fetchedAt: undefined, refreshing: true }));
    expect(main().querySelector('.list-waiting')).not.toBeNull();
    expect(main().querySelector('.pr-list-updated')?.textContent).toBe('Fetching from GitHub…');
    expect(screen.getByRole('button', { name: REFRESH_LABEL }).getAttribute('aria-busy')).toBe('true');
  });

  it('falls back to All sessions with pull requests off, as for ?view=prs remembered from an earlier run, keeping a ?pr=', async () => {
    const off = prList([], { fetchedAt: undefined, source: { ok: false, reason: 'off', error: 'Off.' } });
    const store = memory({ 'pitwall.view.v1': 'view=prs' });
    const { navigation } = renderDashboard(off, { search: '?view=prs&pr=example/demo-app/42', storage: store.source });
    await settle();
    expect(navigation.location.search).toBe('?view=all&pr=example/demo-app/42');
    expect(store.items.get('pitwall.view.v1')).toBe('view=all');
    expect(within(main()).getByRole('heading', { level: 2 }).textContent).toBe('All sessions');
    expect(prItem()).toBeUndefined();
    expect(screen.getByRole('heading', { name: "This pull request isn't listed" })).toBeDefined();
    expect(prView()?.textContent).toContain('Pull requests are off');
  });

  it('says pull requests are off, with Show all sessions, in the list itself', () => {
    const onShowAll = vi.fn();
    const refresh = { refresh: () => {}, sending: false, offUntil: 0 };
    render(
      <PrList
        list={prList([], { fetchedAt: undefined, source: { ok: false, reason: 'off', error: 'Off.' } })}
        sessions={[]}
        filter=""
        onFilter={() => {}}
        relations={new Set()}
        onRelations={() => {}}
        showOlder={false}
        onToggleOlder={() => {}}
        collapsed={new Set()}
        onToggleRepo={() => {}}
        refresh={refresh}
        onShowAll={onShowAll}
      />,
    );
    expect(screen.getByText('Pull requests are off')).toBeDefined();
    expect(screen.queryByRole('button', { name: REFRESH_LABEL })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all sessions' }));
    expect(onShowAll).toHaveBeenCalledTimes(1);
  });

  it('says how to install gh, how to log it in, and what failed, each with Refresh', () => {
    const { again } = renderDashboard(prList([], { fetchedAt: undefined, source: { ok: false, reason: 'gh-missing', error: 'No gh.' } }));
    expect(screen.getByText("gh isn't installed")).toBeDefined();
    expect(main().querySelector('.empty-state-sentence')?.textContent).toContain('Install it from cli.github.com, run gh auth login, then Refresh.');
    expect(within(main().querySelector('.empty-state')!).getByRole('button', { name: 'Refresh' })).toBeDefined();
    again(prList([], { fetchedAt: undefined, source: { ok: false, reason: 'gh-auth', error: 'Not logged in.' } }));
    expect(screen.getByText("gh isn't logged in to GitHub")).toBeDefined();
    expect(main().querySelector('.empty-state-sentence')?.textContent).toContain('Run gh auth login in a terminal, then Refresh.');
    again(prList([], { fetchedAt: undefined, source: { ok: false, reason: 'error', error: 'gh took longer than 30 seconds.' } }));
    expect(screen.getByText("Couldn't list your pull requests")).toBeDefined();
    expect(main().querySelector('.empty-state-sentence')?.textContent).toBe('gh took longer than 30 seconds. Refresh to try again.');
  });

  it('keeps the last list after a failed fetch, under a notice that says when it is from', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    renderDashboard(prList(PRS, { fetchedAt: minutesAgo(125), source: { ok: false, reason: 'error', error: 'No network.' } }));
    const notice = main().querySelector('.pr-stale .inline-alert');
    expect(notice?.querySelector('.inline-alert-title')?.textContent).toBe("Couldn't refresh your pull requests");
    expect(notice?.querySelector('.inline-alert-body')?.textContent).toMatch(/^No network\. This list is from 2h ago\.$/);
    expect(prRows()).toHaveLength(4);
  });
});

describe('Refresh', () => {
  type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
  function server(answer: Answer) {
    return vi.fn<FetchLike>(async () => new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: answer.headers ?? {} }));
  }

  it('POSTs with the apiKey, then is off for a minute, saying why', async () => {
    const fetch = server({ status: 200, body: { ok: true } });
    renderDashboard(prList(PRS), { fetch });
    const button = screen.getByRole('button', { name: REFRESH_LABEL });
    fireEvent.click(button);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(PRS_REFRESH_PATH);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent).toBe(REFRESH_OFF);
    fireEvent.click(button);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('is on again a minute after a refresh, not before (W100)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const fetch = server({ status: 200, body: { ok: true } });
      renderDashboard(prList(PRS), { fetch });
      const button = screen.getByRole('button', { name: REFRESH_LABEL });
      fireEvent.click(button);
      await settle();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(PRS_REFRESH_MIN_MS).toBe(60_000);
      act(() => vi.advanceTimersByTime(PRS_REFRESH_MIN_MS - 1000));
      expect(button.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(button);
      await settle();
      expect(fetch).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(1000));
      expect(button.getAttribute('aria-disabled')).toBeNull();
      fireEvent.click(button);
      await settle();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a spinner while a fetch runs', () => {
    renderDashboard(prList(PRS, { refreshing: true }));
    const button = screen.getByRole('button', { name: REFRESH_LABEL });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.spinner')).not.toBeNull();
  });

  it('takes a 429 calmly: an info toast with when, and off until then', async () => {
    renderDashboard(prList(PRS), { fetch: server({ status: 429, body: { ok: false, error: 'Too soon.' }, headers: { 'Retry-After': '12' } }) });
    fireEvent.click(screen.getByRole('button', { name: REFRESH_LABEL }));
    await settle();
    expect(toastMessages()).toEqual([refreshSoonText(12)]);
    expect(document.querySelector('.toast')?.classList.contains('info')).toBe(true);
    expect(screen.getByRole('button', { name: REFRESH_LABEL }).getAttribute('aria-disabled')).toBe('true');
  });

  it('says pull requests are off after a 409, and what failed after anything else', async () => {
    const first = renderDashboard(prList(PRS), { fetch: server({ status: 409, body: { ok: false, error: 'Off.' } }) });
    fireEvent.click(screen.getByRole('button', { name: REFRESH_LABEL }));
    await settle();
    expect(toastMessages()).toEqual([PRS_OFF_TEXT]);
    first.unmount();
    renderDashboard(prList(PRS), { fetch: server({ status: 500 }) });
    fireEvent.click(screen.getByRole('button', { name: REFRESH_LABEL }));
    await settle();
    expect(toastMessages()).toEqual([refreshFailedText(500)]);
    expect(refreshFailedText(500)).toBe("Couldn't refresh your pull requests (HTTP 500). Try again in a moment.");
    // On again at once.
    expect(screen.getByRole('button', { name: REFRESH_LABEL }).getAttribute('aria-disabled')).toBeNull();
  });
});

describe('sessions and PRs', () => {
  it("gives a session's row a badge for its most urgent strongly linked open PR, with how many more", () => {
    renderDashboard(prList(PRS), { search: '?view=all' });
    const badgeOf = (name: string) => within(main()).getByRole('button', { name }).closest('li')?.querySelector('.pr-badge');
    const alpha = badgeOf('alpha');
    expect(alpha?.textContent).toBe('Pull request #42, needs attention+1, and 1 more');
    expect(alpha?.classList.contains('badge-subtle-danger')).toBe(true);
    expect(badgeOf('beta')?.textContent).toBe('Pull request #9, needs attention');
    // Only mentioned: no badge.
    expect(badgeOf('gamma')).toBeNull();
    expect(badgeOf('epsilon')).toBeNull();
    // Not a control of its own.
    expect(alpha?.closest('button')).toBeNull();
  });

  it("is neutral while that PR doesn't need attention", () => {
    renderDashboard(prList([approved]), { search: '?view=all' });
    const badge = within(main()).getByRole('button', { name: 'alpha' }).closest('li')?.querySelector('.pr-badge');
    expect(badge?.textContent).toBe('Pull request #43');
    expect(badge?.classList.contains('badge-subtle-neutral')).toBe(true);
  });

  it("opens a PR from its row, a session from the PR's view, and the PR from the session's header, with back and forward", async () => {
    const history = fakeHistory('?view=prs');
    renderDashboard(prList(PRS), { navigation: history.navigation });
    fireEvent.click(within(main()).getByRole('button', { name: 'Fix the made-up export job' }));
    await settle();
    expect(history.location.search).toBe('?view=prs&pr=example/demo-app/42');
    const view = prView()!;
    expect(view.getAttribute('aria-labelledby') && document.getElementById(view.getAttribute('aria-labelledby')!)?.textContent).toBe('Fix the made-up export job');
    expect(document.activeElement).toBe(view.querySelector('h2'));
    expect(row(42).classList.contains('open')).toBe(true);
    // Its sessions: strongly linked, then mentioned, each with why.
    const sections = [...view.querySelectorAll('.pr-view-section')].map((section) => [section.querySelector('h3')?.textContent, [...section.querySelectorAll('.pr-view-session')].map((li) => li.textContent)]);
    expect(sections.slice(1)).toEqual([
      ['Sessions', [expect.stringMatching(/^alphaIdleActive .+Opened it$/), expect.stringMatching(/^deltaDone(Active .+)?Given it in a prompt$/)]],
      ['Mentioned in', [expect.stringMatching(/^gammaIdleActive .+Named it in a reply$/)]],
    ]);

    fireEvent.click(within(view).getByRole('button', { name: 'alpha' }));
    await settle();
    expect(history.location.search).toBe('?view=prs&session=pr-alpha');
    expect(prView()).toBeUndefined();
    expect(sessionView()?.querySelector('.session-view-name')?.textContent).toBe('alpha');
    // Its header links to each strongly linked open PR, most urgent first.
    const links = within(sessionView()!).getAllByRole('button', { name: /^Pull request / });
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual(['Pull request example/demo-app #42', 'Pull request example/demo-app #43']);
    fireEvent.click(links[1]!);
    await settle();
    expect(history.location.search).toBe('?view=prs&pr=example/demo-app/43');
    expect(sessionView()).toBeUndefined();

    history.back();
    await settle();
    expect(sessionView()?.querySelector('.session-view-name')?.textContent).toBe('alpha');
    expect(prView()).toBeUndefined();
    history.back();
    await settle();
    expect(prView()?.querySelector('bdi')?.textContent).toBe('Fix the made-up export job');
    history.forward();
    await settle();
    expect(sessionView()).toBeDefined();
  });

  it('closes the PR view with Escape, with focus back on its row', async () => {
    renderDashboard();
    const title = within(main()).getByRole('button', { name: 'Fix the made-up export job' });
    fireEvent.click(title);
    await settle();
    expect(prView()).toBeDefined();
    press('Escape');
    await settle();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(prView()).toBeUndefined();
    expect(document.activeElement).toBe(title);
  });

  it('steps through the PR list with j and k, and ↓ and ↑ on a row', async () => {
    const { navigation } = renderDashboard();
    press('j', document.body);
    expect(document.activeElement?.getAttribute('data-open-pr')).toBe('example/event-relay/9');
    press('ArrowDown');
    expect(document.activeElement?.getAttribute('data-open-pr')).toBe('example/event-relay/8');
    fireEvent.click(document.activeElement!);
    await settle();
    expect(navigation.location.search).toBe('?view=prs&pr=example/event-relay/8');
    press('j', document.body);
    await settle();
    expect(navigation.location.search).toBe('?view=prs&pr=example/demo-app/42');
    press('k', document.body);
    await settle();
    expect(navigation.location.search).toBe('?view=prs&pr=example/event-relay/8');
  });

  it('says a ?pr= that is not one of your open PRs is not listed, and waits for the first list', () => {
    const { again } = renderDashboard(null, { search: '?view=prs&pr=example/demo-app/999' });
    expect(prView()?.querySelector('.empty-state')).toBeNull();
    again(prList(PRS));
    expect(screen.getByRole('heading', { name: "This pull request isn't listed" })).toBeDefined();
    expect(prView()?.textContent).toContain('example/demo-app #999');
  });

  it('keeps showing a PR that leaves the list while it is open, and says so', async () => {
    const { again } = renderDashboard(prList(PRS), { search: '?view=prs&pr=example/demo-app/42' });
    await settle();
    again(prList([approved]));
    expect(prView()?.querySelector('bdi')?.textContent).toBe('Fix the made-up export job');
    expect(prView()?.textContent).toContain(PR_MISSING.gone);
  });

  it("doesn't call it gone while a restart's first fetch runs, and says so once pull requests are off", async () => {
    const { again } = renderDashboard(prList(PRS), { search: '?view=prs&pr=example/demo-app/42' });
    await settle();
    // A restart: the poller's first message, before its first fetch, has no PRs and no fetchedAt.
    again(prList([], { fetchedAt: undefined, refreshing: true }));
    expect(prView()?.querySelector('bdi')?.textContent).toBe('Fix the made-up export job');
    expect(prView()?.querySelector('.inline-alert')).toBeNull();
    again(prList([], { fetchedAt: undefined, source: { ok: false, reason: 'gh-auth', error: 'Not logged in.' } }));
    expect(prView()?.textContent).toContain(PR_MISSING.failed);
    again(prList([], { fetchedAt: undefined, source: { ok: false, reason: 'off', error: 'Off.' } }));
    expect(prView()?.textContent).toContain(PR_MISSING.off);
    // Fetched again, it's listed, and the alert goes.
    again(prList(PRS));
    expect(prView()?.querySelector('.inline-alert')).toBeNull();
  });
});

describe('PRs that ask your review or mention you (W101)', () => {
  // #77 asks your review, #78 a team's you're on, with its author's failing checks; #79 mentions you, with failures that are its author's.
  const review = pr({ number: 77, title: 'Add a made-up retry budget', relation: 'review-requested', reviewRequest: { via: 'direct' } }, 20);
  const teamReview = pr({ number: 78, repoLabel: 'example/event-relay', relation: 'review-requested', reviewRequest: { via: 'team', team: 'example/reviewers' }, checks: 'failing', failingChecks: ['lint'] }, 50);
  const mention = pr({ number: 79, relation: 'mentioned', checks: 'failing', mergeable: 'conflicts' }, 40);
  const ALL = [...PRS, review, teamReview, mention];
  const chip = (label: string) => within(main()).getByRole('button', { name: label, pressed: false });
  const badges = (number: number) => [...row(number).querySelectorAll('.badge')].map((badge) => badge.textContent);

  it('counts a review request among those that need attention, and a mention not, in the repo list and the summary', () => {
    renderDashboard(prList(ALL), { search: '?view=all' });
    expect(prItem()?.querySelector('.badge')?.textContent).toBe('4 need attention');
    fireEvent.click(prItem()!);
    expect(summary()).toBe('7 open4 need attention');
  });

  it('marks a row Review requested or Mentioned, first among its badges, and sorts a review request with those that need attention', () => {
    renderDashboard(prList(ALL));
    expect(badges(77)).toEqual(['Review requested']);
    expect(badges(78)).toEqual(['Review requested', 'Checks failing']);
    expect(badges(79)).toEqual(['Mentioned', 'Checks failing', 'Conflicts']);
    expect(row(78).querySelector('.pr-state-review-requested')?.classList.contains('badge-subtle-warning')).toBe(true);
    expect(row(79).querySelector('.pr-state-mentioned')?.classList.contains('badge-subtle-neutral')).toBe(true);
    // A team's request names the team in its hover tooltip.
    expect(row(78).querySelector('.pr-state-review-requested')?.classList.contains('has-hint')).toBe(true);
    expect(row(77).querySelector('.pr-state-review-requested')?.classList.contains('has-hint')).toBe(false);
    // demo-app: #77 and #42 need attention, the newest first, then #79 and #43, which don't.
    expect(prRows()).toEqual(['example/event-relay/9', 'example/event-relay/78', 'example/event-relay/8', 'example/demo-app/77', 'example/demo-app/42', 'example/demo-app/79', 'example/demo-app/43']);
  });

  it('has the chips Yours, Review requested and Mentioned, which combine as OR, and Clear filters clears them and the text', () => {
    renderDashboard(prList(ALL));
    const group = within(main()).getByRole('group', { name: 'Filters' });
    expect([...group.querySelectorAll('.chip')].map((each) => each.textContent)).toEqual(['Yours', 'Review requested', 'Mentioned']);
    // Clear filters is on line 3, before Refresh, and only while a filter is on.
    const clear = () => main().querySelector('.pr-list-fetched')?.querySelector<HTMLButtonElement>('[data-clear-filters]') ?? null;
    expect(group.querySelector('[data-clear-filters], .filter-clear-room')).toBeNull();
    expect(clear()).toBeNull();
    fireEvent.click(chip('Review requested'));
    expect(within(main()).getByRole('button', { name: 'Review requested', pressed: true })).toBeDefined();
    // The headings follow what's shown: #77 is newer than #78.
    expect(prRows()).toEqual(['example/demo-app/77', 'example/event-relay/78']);
    expect(summary()).toBe('2 of 7 open4 need attention');
    fireEvent.click(chip('Mentioned'));
    expect(prRows()).toEqual(['example/demo-app/77', 'example/demo-app/79', 'example/event-relay/78']);
    fireEvent.click(chip('Yours'));
    expect(prRows()).toHaveLength(7);
    fireEvent.click(within(main()).getByRole('button', { name: 'Review requested', pressed: true }));
    fireEvent.click(within(main()).getByRole('button', { name: 'Mentioned', pressed: true }));
    expect(prRows()).toEqual(['example/event-relay/9', 'example/event-relay/8', 'example/demo-app/42', 'example/demo-app/43']);
    const field = within(main()).getByRole('searchbox', { name: 'Filter pull requests' });
    fireEvent.change(field, { target: { value: 'export' } });
    expect(prRows()).toEqual(['example/demo-app/42']);
    expect(clear()?.getAttribute('aria-label')).toBe('Clear filters');
    expect(clear()?.closest('.pr-list-actions')?.querySelector('[data-pr-refresh]')).not.toBeNull();
    fireEvent.click(clear()!);
    expect(prRows()).toHaveLength(7);
    expect((field as HTMLInputElement).value).toBe('');
    expect(within(main()).queryByRole('button', { pressed: true })).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it('shows what a chip finds under a collapsed heading', () => {
    const store = memory();
    renderDashboard(prList(ALL), { storage: store.source });
    fireEvent.click(within(main()).getByRole('button', { name: /example\/event-relay/ }));
    expect(prRows()).not.toContain('example/event-relay/78');
    fireEvent.click(chip('Review requested'));
    expect(prRows()).toContain('example/event-relay/78');
  });

  it('says when a chip finds none of its kind, with Clear filters', () => {
    renderDashboard(prList([failing, approved]));
    fireEvent.click(chip('Review requested'));
    expect(screen.getByText(NO_RELATION['review-requested'].title)).toBeDefined();
    expect(NO_RELATION['review-requested']).toEqual({ title: 'No reviews requested', sentence: "Open pull requests that ask your review, or a team's you're on, show here until you've reviewed them." });
    fireEvent.click(within(main()).getByRole('button', { name: 'Review requested', pressed: true }));
    fireEvent.click(chip('Mentioned'));
    expect(screen.getByText('No mentions')).toBeDefined();
    fireEvent.click(within(main().querySelector('.empty-state')!).getByRole('button', { name: 'Clear filters' }));
    expect(prRows()).toHaveLength(2);
  });

  it('says when nothing of yours is open, and when the chips and the text find nothing together', () => {
    const { again } = renderDashboard(prList([review, mention]));
    fireEvent.click(chip('Yours'));
    expect(screen.getByText('No open pull requests of yours')).toBeDefined();
    again(prList(ALL));
    fireEvent.change(within(main()).getByRole('searchbox', { name: 'Filter pull requests' }), { target: { value: 'retry budget' } });
    expect(prRows()).toEqual([]);
    expect(main().querySelector('.empty-state-sentence')?.textContent).toBe('Nothing in Pull requests matches "retry budget" with these filters.');
    fireEvent.click(within(main()).getByRole('button', { name: 'Yours', pressed: true }));
    expect(prRows()).toEqual(['example/demo-app/77']);
  });

  it('says in the PR view how it is yours: your review, of you or a team, or a mention', () => {
    const relation = (each: typeof review) => {
      const { unmount } = render(<PrView pr={each} sessions={{ strong: [], mentioned: [] }} onOpenSession={() => {}} onClose={() => {}} layout="column" />);
      const text = prView()?.querySelector('.pr-view-relation')?.textContent ?? null;
      unmount();
      return text;
    };
    expect(relation(review)).toBe('Your review is requested.');
    expect(relation(teamReview)).toBe('Your review is requested through example/reviewers.');
    expect(relation({ ...teamReview, reviewRequest: { via: 'team' } })).toBe("Your review is requested through a team you're on.");
    expect(relation(mention)).toBe("You're mentioned in it.");
    expect(relation(failing)).toBeNull();
  });
});

describe('the PR view', () => {
  const view = (each = failing, linked = sessionsFor(each, Object.values(sessions()))) =>
    render(<PrView pr={each} sessions={linked} onOpenSession={() => {}} onClose={() => {}} layout="column" />);

  it('links to GitHub in a new tab, with no opener or referrer, and copies the link', () => {
    view();
    const link = screen.getByRole('link', { name: OPEN_ON_GITHUB });
    expect(link.getAttribute('href')).toBe('https://github.com/example/demo-app/pull/42');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect([...document.querySelectorAll('.pr-view-session-open bdi')].map((bdi) => bdi.textContent)).toEqual(['alpha', 'delta', 'gamma']);
    expect(screen.getByRole('button', { name: COPY_LINK })).toBeDefined();
  });

  it("has neither for an address that isn't the PR's own on github.com", () => {
    view({ ...failing, url: 'https://example.com/example/demo-app/pull/42' });
    expect(screen.queryByRole('link', { name: OPEN_ON_GITHUB })).toBeNull();
    expect(screen.queryByRole('button', { name: COPY_LINK })).toBeNull();
  });

  it('names the failing checks, then how many more failed, and says each detail', () => {
    view();
    const details = Object.fromEntries([...document.querySelectorAll('.pr-view-detail')].map((detail) => [detail.querySelector('dt')?.textContent, detail.querySelector('dd')?.textContent]));
    expect(details.Checks).toBe('Failingtest (22.x)lint+2 more');
    expect(details.Review).toBe('No review required');
    expect(details.Merge).toBe('No conflicts');
    expect(details.Draft).toBe('Ready for review');
    expect(details.Branch).toBe('made-up/branch-42');
    expect(screen.getByRole('list', { name: 'Failing checks' })).toBeDefined();
  });

  it('says GitHub is still checking for conflicts, a fork, and that no session is linked', () => {
    const fork = { ...draft, head: { repo: 'someone/event-relay', branch: 'fix-retries' } };
    view(fork, { strong: [], mentioned: [] });
    const details = Object.fromEntries([...document.querySelectorAll('.pr-view-detail')].map((detail) => [detail.querySelector('dt')?.textContent, detail.querySelector('dd')?.textContent]));
    expect(details.Merge).toBe('Checking for conflicts: GitHub works it out after a push, so the next fetch usually knows.');
    expect(details.Checks).toBe('Pending');
    expect(details.Draft).toBe('Draft');
    expect(details.Branch).toBe('fix-retries, from someone/event-relay');
    expect(screen.getByText(/No session has opened it/)).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Mentioned in' })).toBeNull();
  });

  it('shows titles, branches and check names as text', () => {
    const awkward = { ...failing, title: '<img src=x onerror=alert(1)> ‮evil', failingChecks: ['<b>bold</b>'], failingCount: undefined, head: { repo: failing.repo, branch: '<i>x</i>' } };
    view(awkward, { strong: [], mentioned: [] });
    expect(document.querySelector('img, b, i')).toBeNull();
    expect(prView()?.querySelector('h2 bdi')?.textContent).toBe('<img src=x onerror=alert(1)> evil');
    expect(prKey(awkward)).toBe('example/demo-app/42');
  });
});
