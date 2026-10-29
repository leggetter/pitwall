// Pull requests in the web UI (M4, W95, W106; docs/design-system.md, 4: Pull requests): a row is a
// piece of work. The repo list's items and counts, Needs you through a PR, a cloned repo with only PR
// rows and one that isn't cloned; a session row's badge for the PRs it owns, a later session taking
// one over, its line 2, and an ended session that owns an open PR; a PR row's two lines; the Pull
// requests view, its hidden line, Show older, the filter and each source state; Refresh and its
// answers; the session view's Pull requests tab and its links; the PR view; Has PR; and navigation
// both ways, with the back button and the keys, through session and PR rows alike. W101's PRs that ask
// your review or mention you, their chips, badges and sentence. Made-up PRs, repos, teams and
// sessions only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PRS_MAX, PRS_REFRESH_MIN_MS, PRS_REFRESH_PATH, type IndexSnapshot, type PullRequestList, type PullRequestPlace, type PullRequestSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import type { ConnectionView } from '../connection.js';
import type { StorageSource } from '../groupState.js';
import { PRS_OFF_TEXT, refreshFailedText, refreshSoonText } from '../prRefresh.js';
import { prKey, sessionsFor } from '../prs.js';
import { memoryNavigation, type NavigationEnv } from '../selection.js';
import { createShortcutsStore, ShortcutsStoreContext } from '../shortcuts.js';
import { group, minutesAgo, NOW, pr, prLink, prList, session, snapshot } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { toastMessages } from '../test/toasts.js';
import { Dashboard } from './Dashboard.js';
import { CONFIGURATION_URL, NO_RELATION, prSourceBody, REFRESH_LABEL, REFRESH_OFF } from './PrList.js';
import { COPY_LINK, OPEN_ON_GITHUB, OWNS_IT, PR_MISSING, PrView } from './PrView.js';
import { LINKED_NOTE } from './SessionPrs.js';
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

const RELAY = `${ROOT}/event-relay`;
const placed = (each: PullRequestSummary, place: PullRequestPlace): PullRequestSummary => ({ ...each, place });
const cloned = (key: string, label: string): PullRequestPlace => ({ kind: 'cloned', root: ROOT, key, label });

// The made-up PRs: alpha owns #42 and #43 in demo-app, beta #9 in event-relay; #8 in event-relay and
// #5 in example/Docs-Site, which isn't cloned, have no session; #3, in blog, is older than the 90 days;
// and no root claims other-org/tool's #6.
const failing = pr({ number: 42, title: 'Fix the made-up export job', checks: 'failing', failingChecks: ['test (22.x)', 'lint'], failingCount: 4 }, 30);
const approved = pr({ number: 43, review: 'approved' }, 200);
const conflicts = pr({ number: 9, repoLabel: 'example/event-relay', mergeable: 'conflicts' }, 10);
const draft = placed(pr({ number: 8, repoLabel: 'example/event-relay', title: 'Document the made-up retry headers', draft: true, checks: 'pending', mergeable: 'unknown' }, 300), cloned(RELAY, 'event-relay'));
const docs = placed(pr({ number: 5, repoLabel: 'example/Docs-Site', title: 'Move the made-up guide' }, 60), { kind: 'not-cloned', root: ROOT });
const older = placed(pr({ number: 3, repoLabel: 'example/blog', review: 'changes-requested' }, 100 * DAY), cloned(`${ROOT}/blog`, 'blog'));
const unclaimed = placed(pr({ number: 6, repoLabel: 'other-org/tool' }, 70), { kind: 'unclaimed' });
const PRS = [conflicts, failing, approved, draft, docs, older, unclaimed];

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
const prRows = () => [...main().querySelectorAll<HTMLElement>('[data-open-pr]')].filter((button) => !button.closest('[hidden]')).map((button) => button.dataset.openPr);
/** Every row shown, a session's by its name, a PR's as "#n", in order. */
const rows = () =>
  [...main().querySelectorAll<HTMLElement>('[data-open-session], [data-open-pr]')]
    .filter((button) => !button.closest('[hidden]'))
    .map((button) => (button.dataset.openPr !== undefined ? `#${button.dataset.openPr.split('/').pop()}` : button.textContent));
const repoItem = (label: string) => [...repoList().querySelectorAll<HTMLAnchorElement>('a[data-repo-item]')].find((link) => link.querySelector('.repo-item-label')?.textContent === label);
/** A session's row by its name, in a collapsed Finished section too. */
const sessionRow = (name: string) => [...main().querySelectorAll<HTMLElement>('[data-open-session]')].find((button) => button.textContent === name)!.closest('li')!;
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

  it('counts the rows that need you through a PR in Needs you, the Pull requests item and the page title (W106)', () => {
    const { again } = renderDashboard(null, { search: '?view=all' });
    expect(repoItem('Needs you')?.querySelector('.badge')).toBeNull();
    again(prList(PRS));
    const labels = [...repoList().querySelectorAll('a[data-repo-item] .repo-item-label')].map((label) => label.textContent);
    expect(labels.slice(0, 4)).toEqual(['Needs you', 'All sessions', 'Starred', 'Pull requests']);
    // alpha, through #42's failing checks, and beta, through #9's conflicts.
    expect(repoItem('Needs you')?.querySelector('.badge')?.textContent).toBe('2 need you');
    const badge = prItem()?.querySelector('.badge');
    expect(badge?.textContent).toBe('2 need you');
    expect(badge?.classList.contains('badge-attention')).toBe(true);
    expect(document.title).toBe('(2) pitwall');
    // Every row: five sessions and the two PR rows, #8 and #5.
    expect(repoItem('All sessions')?.querySelector('.repo-item-count')?.textContent).toBe('7 sessions');
  });

  it('shows how many rows have a PR while none needs you, and nothing before the first fetch', () => {
    const { again } = renderDashboard(prList([approved, draft]), { search: '?view=all' });
    expect(prItem()?.querySelector('.repo-item-count')?.textContent).toBe('2 sessions');
    again(prList([], { fetchedAt: undefined, refreshing: true }));
    expect(prItem()).toBeDefined();
    expect(prItem()?.querySelector('.repo-item-count, .badge')).toBeNull();
  });

  it('has no item while pull requests are off', () => {
    renderDashboard(prList([], { fetchedAt: undefined, source: { ok: false, reason: 'off', error: 'Off.' } }), { search: '?view=all' });
    expect(prItem()).toBeUndefined();
  });

  it('lists a cloned repo with only PR rows, and one that is not cloned, with its own icon and "not cloned" (W106)', () => {
    const fresh = placed(pr({ number: 11, repoLabel: 'example/api-server' }, 20), cloned(`${ROOT}/api-server`, 'api-server'));
    renderDashboard(prList([...PRS, fresh]), { search: '?view=all' });
    expect(repoItem('api-server')?.querySelector('.repo-item-count')?.textContent).toBe('1 session');
    const notCloned = repoItem('example/Docs-Site')!;
    expect(notCloned.textContent).toBe('example/Docs-Site, not cloned1 session');
    expect(notCloned.classList.contains('not-cloned')).toBe(true);
    expect(notCloned.querySelector('.repo-item-icon')?.getAttribute('data-icon') ?? notCloned.querySelector('svg')?.outerHTML).toBeTruthy();
    expect(new URL(notCloned.href).search).toBe('?repo=github.com/example/docs-site');
    // Its repo goes once it has no PR row.
    renderDashboard(prList([conflicts]), { search: '?view=all' });
    expect(screen.getAllByRole('navigation', { name: 'Repos' }).at(-1)?.textContent).not.toContain('Docs-Site');
  });

  it('opens a not-cloned repo with its PR rows, says so in its heading, offers no Hide, and keeps its name out of storage', async () => {
    const store = memory();
    renderDashboard(prList(PRS), { search: '?view=all', storage: store.source });
    fireEvent.click(repoItem('example/Docs-Site')!);
    await settle();
    const heading = within(main()).getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('example/Docs-Site, not clonedNot cloned');
    expect(rows()).toEqual(['#5']);
    expect(main().querySelector('li[data-pr] .pr-row-end')?.textContent).toBe(' · Not cloned');
    expect(within(main()).queryByRole('button', { name: /Hide from repo list/ })).toBeNull();
    expect(store.items.get('pitwall.view.v1') ?? '').not.toContain('docs-site');
  });

  it('selects Pull requests in the session list column, with ?view=prs', async () => {
    const { navigation } = renderDashboard(prList(PRS), { search: '?view=all' });
    fireEvent.click(prItem()!);
    await settle();
    expect(navigation.location.search).toBe('?view=prs');
    expect(within(main()).getByRole('heading', { level: 2 }).textContent).toBe('Pull requests');
    expect(prItem()?.getAttribute('aria-current')).toBe('page');
  });
});

describe('rows', () => {
  it("gives a session's row a badge for the most urgent open PR it owns, its state short, with how many more", () => {
    renderDashboard(prList(PRS), { search: '?view=all' });
    const badgeOf = (name: string) => sessionRow(name).querySelector('.pr-badge');
    const alpha = badgeOf('alpha');
    expect(alpha?.textContent).toBe('Pull request #42 CI failing, needs attention+1, and 1 more');
    expect(alpha?.classList.contains('badge-subtle-danger')).toBe(true);
    expect(badgeOf('beta')?.textContent).toBe('Pull request #9 conflicts, needs attention');
    // Only mentioned, or a weaker link to a PR another session owns: no badge.
    expect(badgeOf('gamma')).toBeNull();
    expect(badgeOf('delta')).toBeNull();
    expect(badgeOf('epsilon')).toBeNull();
    // Not a control of its own.
    expect(alpha?.closest('button')).toBeNull();
  });

  it("says why on line 2 and has the bar while a PR it owns needs attention, and is neutral while it doesn't", () => {
    const { again } = renderDashboard(prList(PRS), { search: '?view=all' });
    expect(sessionRow('alpha').classList.contains('attention')).toBe(true);
    expect(sessionRow('alpha').querySelector('.session-what')?.textContent).toBe('demo-app · CI is failing on #42');
    // Its Not needed now toggle is for what the session needs, not its PRs.
    expect(sessionRow('alpha').querySelector('[data-not-needed-session]')).toBeNull();
    again(prList([approved]));
    const badge = sessionRow('alpha').querySelector('.pr-badge');
    expect(badge?.textContent).toBe('Pull request #43');
    expect(badge?.classList.contains('badge-subtle-neutral')).toBe(true);
    expect(sessionRow('alpha').classList.contains('attention')).toBe(false);
    expect(sessionRow('alpha').querySelector('.session-what')?.textContent).toBe('demo-app · You: run the tests');
  });

  it('moves a PR to the session that acted on it later, which takes its badge over', () => {
    const base = snap();
    const zeta = session({ sessionId: 'pr-zeta', name: 'zeta', prLinks: [prLink('pushed', approved, 1)] });
    const s = { ...base, groups: [...base.groups, group({ key: `${ROOT}/more`, label: 'more', sessions: [zeta] })] };
    render(<Dashboard view={{ state: 'live', snapshot: s, prs: prList(PRS) }} navigation={memoryNavigation('?view=all')} storage={memory().source} />);
    expect(sessionRow('alpha').querySelector('.pr-badge')?.textContent).toBe('Pull request #42 CI failing, needs attention');
    expect(sessionRow('zeta').querySelector('.pr-badge')?.textContent).toBe('Pull request #43');
  });

  it('keeps an ended session that owns an open PR in the list, not in Finished, until the PR closes', () => {
    const open = pr({ number: 61, title: 'Tidy the made-up notes' }, 15);
    const base = snap();
    const omega = session({ sessionId: 'pr-omega', name: 'omega', ended: true, finished: true, alive: false, pid: undefined, status: undefined, prLinks: [prLink('opened', open, 60)] });
    const s = { ...base, groups: [...base.groups, group({ key: `${ROOT}/notes`, label: 'notes', sessions: [omega] })] };
    const ui = (list: PullRequestList) => <Dashboard view={{ state: 'live', snapshot: s, prs: list }} navigation={memoryNavigation('?view=all')} storage={memory().source} />;
    const { rerender } = render(ui(prList([...PRS, open])));
    const finishedRows = () => [...main().querySelectorAll('.finished-sessions [data-open-session]')].map((button) => button.textContent);
    expect(finishedRows()).toEqual(['delta']);
    expect(sessionRow('omega').closest('.finished-sessions')).toBeNull();
    expect(sessionRow('omega').classList.contains('finished')).toBe(false);
    expect(sessionRow('omega').querySelector('.badge[data-status]')?.textContent).toBe('Ended');
    rerender(ui(prList(PRS)));
    expect(finishedRows()).toEqual(['delta', 'omega']);
  });

  it('gives a PR with no session a row of two lines, under the repo the server placed it in', () => {
    renderDashboard(prList(PRS), { search: '?view=all' });
    const eight = row(8);
    expect(eight.querySelector('h3 button')?.textContent).toBe('#8 Document the made-up retry headers');
    expect([...eight.querySelectorAll('.badge')].map((badge) => badge.textContent)).toEqual(['Draft', 'Checks pending']);
    expect(eight.querySelector('.pr-what')?.textContent).toMatch(/^event-relay · Yours · Updated .+ ago · No session yet$/);
    // The time's slot is kept empty, and the slot for W107's actions.
    expect(eight.querySelector('.session-line > .activity')?.textContent).toBe('');
    expect(eight.querySelector('.pr-row-actions')).not.toBeNull();
    expect(eight.classList.contains('attention')).toBe(false);
    // In its group's own list, line 2 has no label; one that needs you says why, with the bar.
    const asked = placed(pr({ number: 77, repoLabel: 'example/event-relay', relation: 'review-requested' }, 20), cloned(RELAY, 'event-relay'));
    renderDashboard(prList([asked]), { search: `?repo=${RELAY}` });
    const seventySeven = screen.getAllByRole('main').at(-1)!.querySelector('li[data-pr$="/77"]')!;
    expect(seventySeven.querySelector('.pr-what')?.textContent).toMatch(/^Your review is requested · Updated .+ ago · No session yet$/);
    expect(seventySeven.classList.contains('attention')).toBe(true);
  });

  it('opens a PR row in the PR view, as ?pr=', async () => {
    const { navigation } = renderDashboard(prList(PRS), { search: '?view=all' });
    fireEvent.click(within(main()).getByRole('button', { name: '#8 Document the made-up retry headers' }));
    await settle();
    expect(navigation.location.search).toBe('?view=all&pr=example/event-relay/8');
    expect(prView()?.querySelector('h2 bdi')?.textContent).toBe('Document the made-up retry headers');
    expect(row(8).classList.contains('open')).toBe(true);
  });

  it('keeps only the rows with an open PR with Has PR, and no PR row with a kind chip (W106)', () => {
    renderDashboard(prList(PRS), { search: '?view=all' });
    fireEvent.click(within(main()).getByRole('button', { name: 'Has PR', pressed: false }));
    expect(rows()).toEqual(['alpha', 'beta', '#5', '#8']);
    fireEvent.click(within(main()).getByRole('button', { name: 'Interactive', pressed: false }));
    expect(rows()).toEqual(['alpha', 'beta']);
    fireEvent.click(within(main()).getByRole('button', { name: 'Has PR', pressed: true }));
    expect(rows()).toEqual(['alpha', 'beta', 'epsilon', 'gamma']);
  });
});

describe('Has PR, with no list of pull requests (W106)', () => {
  const chipLabels = () => [...main().querySelectorAll('.filter-chips .chip')].map((chip) => chip.textContent);

  it('is no chip before a list comes or with pull requests off, and a filter it was on for drops it', () => {
    const { again } = renderDashboard(null, { search: '?view=all' });
    expect(chipLabels()).toEqual(['Interactive', 'Background']);
    again(prList(PRS));
    expect(chipLabels()).toEqual(['Interactive', 'Background', 'Has PR']);
    fireEvent.click(within(main()).getByRole('button', { name: 'Has PR', pressed: false }));
    expect(rows()).toEqual(['alpha', 'beta', '#5', '#8']);
    again(prList([], { fetchedAt: undefined, source: { ok: false, reason: 'off', error: 'Off.' } }));
    expect(chipLabels()).toEqual(['Interactive', 'Background']);
    expect(rows()).toEqual(['alpha', 'beta', 'epsilon', 'gamma']);
  });
});

describe('the Pull requests view', () => {
  it('lists every row with an open PR, the sessions that own one and the PR rows, those that need you first, with the summary', () => {
    renderDashboard();
    expect(rows()).toEqual(['alpha', 'beta', '#5', '#8']);
    expect(summary()).toBe('4 sessions2 need you');
    // Line 2 names each row's group, as the other views do.
    expect(row(5).querySelector('.pr-what')?.textContent).toMatch(/^example\/Docs-Site · Yours · Updated .+ ago · Not cloned$/);
  });

  it('says how many PRs are hidden because no root claims their owner, with a link to the README’s Configuration', () => {
    renderDashboard();
    const line = main().querySelector('.pr-hidden')!;
    expect(line.textContent).toBe('1 pull request is hidden: no root claims other-org. How to show them');
    const link = within(line as HTMLElement).getByRole('link', { name: 'How to show them' });
    expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]).toEqual([CONFIGURATION_URL, '_blank', 'noopener noreferrer']);
    expect(CONFIGURATION_URL).toBe('https://github.com/leggetter/pitwall#configuration');
  });

  it('lists the PR rows older than 90 days behind Show older, which keeps focus as Hide older', async () => {
    renderDashboard();
    expect(prRows()).not.toContain('example/blog/3');
    const show = within(main()).getByRole('button', { name: 'Show 1 older pull request' });
    expect(show.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.click(show);
    await settle();
    expect(prRows()).toContain('example/blog/3');
    expect(summary()).toBe('5 sessions3 need you');
    expect(document.activeElement?.textContent).toBe('Hide older pull requests');
    // It's a row everywhere while it's shown: blog is in the repo list.
    expect(repoItem('blog')).toBeDefined();
  });

  it('says when no row has an open PR, with the hidden line', () => {
    renderDashboard(prList([unclaimed]));
    expect(screen.getByText('No open pull requests')).toBeDefined();
    expect(main().querySelector('.empty-state .pr-hidden')?.textContent).toContain('1 pull request is hidden');
  });

  it('filters by session, title, repo, number and branch, and says when nothing matches', () => {
    renderDashboard();
    const field = within(main()).getByRole('searchbox', { name: 'Filter pull requests' });
    expect(field.getAttribute('placeholder')).toBe('Filter by session, title, repo or number');
    fireEvent.change(field, { target: { value: 'event-relay' } });
    expect(rows()).toEqual(['beta', '#8']);
    expect(summary()).toBe('2 of 4 sessions2 need you');
    // A session by a PR it owns.
    fireEvent.change(field, { target: { value: 'export' } });
    expect(rows()).toEqual(['alpha']);
    fireEvent.change(field, { target: { value: 'branch-8' } });
    expect(rows()).toEqual(['#8']);
    fireEvent.change(field, { target: { value: '#5' } });
    expect(row(5).querySelector('mark')?.textContent).toBe('#5');
    fireEvent.change(field, { target: { value: 'nothing like it' } });
    expect(screen.getByText('No sessions match')).toBeDefined();
    fireEvent.click(within(main()).getByRole('button', { name: 'Clear filter' }));
    expect(rows()).toHaveLength(4);
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
    render(<>{prSourceBody({ kind: 'off' }, { refresh, refreshing: false, waiting: { shown: false, long: false }, onShowAll })}</>);
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
    expect(rows()).toHaveLength(4);
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
  it("opens a session from the list, the PR from its header, a session from the PR's view, with back and forward", async () => {
    const history = fakeHistory('?view=prs');
    renderDashboard(prList(PRS), { navigation: history.navigation });
    fireEvent.click(within(main()).getByRole('button', { name: 'alpha' }));
    await settle();
    expect(history.location.search).toBe('?view=prs&session=pr-alpha');
    // Its header links to each open PR it owns, most urgent first.
    const links = within(sessionView()!).getAllByRole('button', { name: /^Pull request / });
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual(['Pull request example/demo-app #42', 'Pull request example/demo-app #43']);
    fireEvent.click(links[0]!);
    await settle();
    expect(history.location.search).toBe('?view=prs&pr=example/demo-app/42');
    const view = prView()!;
    expect(view.getAttribute('aria-labelledby') && document.getElementById(view.getAttribute('aria-labelledby')!)?.textContent).toBe('Fix the made-up export job');
    expect(document.activeElement).toBe(view.querySelector('h2'));
    // Its sessions: the one that owns it first, as its session, then the others strongly linked, then mentioned, each with why.
    const sections = [...view.querySelectorAll('.pr-view-section')].map((section) => [section.querySelector('h3')?.textContent, [...section.querySelectorAll('.pr-view-session')].map((li) => li.textContent)]);
    expect(sections.slice(1)).toEqual([
      ['Sessions', [expect.stringMatching(new RegExp(`^alphaIdleActive .+Opened it · ${OWNS_IT}$`)), expect.stringMatching(/^deltaDone(Active .+)?Given it in a prompt$/)]],
      ['Mentioned in', [expect.stringMatching(/^gammaIdleActive .+Named it in a reply$/)]],
    ]);

    fireEvent.click(within(view).getByRole('button', { name: 'delta' }));
    await settle();
    expect(history.location.search).toBe('?view=prs&session=pr-delta');
    expect(prView()).toBeUndefined();
    expect(sessionView()?.querySelector('.session-view-name')?.textContent).toBe('delta');
    // It owns nothing, so its header has no links.
    expect(within(sessionView()!).queryAllByRole('button', { name: /^Pull request / })).toEqual([]);

    history.back();
    await settle();
    expect(prView()?.querySelector('bdi')?.textContent).toBe('Fix the made-up export job');
    history.back();
    await settle();
    expect(sessionView()?.querySelector('.session-view-name')?.textContent).toBe('alpha');
    history.forward();
    await settle();
    expect(prView()).toBeDefined();
  });

  it('closes the PR view with Escape, with focus back on its row', async () => {
    renderDashboard();
    const title = within(main()).getByRole('button', { name: '#8 Document the made-up retry headers' });
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

  it("steps through session and PR rows alike with j and k, and ↓ and ↑ on a row, showing each in the view while one's open", async () => {
    const { navigation } = renderDashboard();
    press('j', document.body);
    expect(document.activeElement?.getAttribute('data-open-session')).toBe('pr-alpha');
    press('ArrowDown');
    expect(document.activeElement?.getAttribute('data-open-session')).toBe('pr-beta');
    press('ArrowDown');
    expect(document.activeElement?.getAttribute('data-open-pr')).toBe('example/docs-site/5');
    fireEvent.click(document.activeElement!);
    await settle();
    expect(navigation.location.search).toBe('?view=prs&pr=example/docs-site/5');
    press('j', document.body);
    await settle();
    expect(navigation.location.search).toBe('?view=prs&pr=example/event-relay/8');
    press('k', document.body);
    await settle();
    press('k', document.body);
    await settle();
    expect(navigation.location.search).toBe('?view=prs&session=pr-beta');
    expect(sessionView()?.querySelector('.session-view-name')?.textContent).toBe('beta');
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
  // #77 asks your review, #78 a team's you're on, with its author's failing checks; #79 mentions you, with failures that are its author's. No session owns them.
  const demo = cloned(`${ROOT}/demo-app`, 'demo-app');
  const review = placed(pr({ number: 77, title: 'Add a made-up retry budget', relation: 'review-requested', reviewRequest: { via: 'direct' } }, 20), demo);
  const teamReview = placed(
    pr({ number: 78, repoLabel: 'example/event-relay', relation: 'review-requested', reviewRequest: { via: 'team', team: 'example/reviewers' }, checks: 'failing', failingChecks: ['lint'] }, 50),
    cloned(RELAY, 'event-relay'),
  );
  const mention = placed(pr({ number: 79, relation: 'mentioned', checks: 'failing', mergeable: 'conflicts' }, 40), demo);
  const ALL = [...PRS, review, teamReview, mention];
  const chip = (label: string) => within(main()).getByRole('button', { name: label, pressed: false });
  const badges = (number: number) => [...row(number).querySelectorAll('.badge')].map((badge) => badge.textContent);

  it('counts a review request among those that need you, and a mention not, in the repo list and the summary', () => {
    renderDashboard(prList(ALL), { search: '?view=all' });
    expect(prItem()?.querySelector('.badge')?.textContent).toBe('4 need you');
    expect(repoItem('Needs you')?.querySelector('.badge')?.textContent).toBe('4 need you');
    fireEvent.click(prItem()!);
    expect(summary()).toBe('7 sessions4 need you');
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
    // Those that need you first, the newest first, then the rest.
    expect(rows()).toEqual(['alpha', 'beta', '#77', '#78', '#79', '#5', '#8']);
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
    expect(rows()).toEqual(['#77', '#78']);
    expect(summary()).toBe('2 of 7 sessions4 need you');
    fireEvent.click(chip('Mentioned'));
    expect(rows()).toEqual(['#77', '#78', '#79']);
    fireEvent.click(chip('Yours'));
    expect(rows()).toHaveLength(7);
    fireEvent.click(within(main()).getByRole('button', { name: 'Review requested', pressed: true }));
    fireEvent.click(within(main()).getByRole('button', { name: 'Mentioned', pressed: true }));
    // Yours: the sessions that own one of yours, and your PR rows.
    expect(rows()).toEqual(['alpha', 'beta', '#5', '#8']);
    const field = within(main()).getByRole('searchbox', { name: 'Filter pull requests' });
    fireEvent.change(field, { target: { value: 'export' } });
    expect(rows()).toEqual(['alpha']);
    expect(clear()?.getAttribute('aria-label')).toBe('Clear filters');
    expect(clear()?.closest('.pr-list-actions')?.querySelector('[data-pr-refresh]')).not.toBeNull();
    fireEvent.click(clear()!);
    expect(rows()).toHaveLength(7);
    expect((field as HTMLInputElement).value).toBe('');
    expect(within(main()).queryByRole('button', { pressed: true })).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it('says when a chip finds none of its kind, with Clear filters', () => {
    renderDashboard(prList([failing, approved]));
    fireEvent.click(chip('Review requested'));
    expect(screen.getByText(NO_RELATION['review-requested'].title)).toBeDefined();
    expect(NO_RELATION['review-requested']).toEqual({ title: 'No reviews requested', sentence: "Open pull requests that ask your review, or a team's you're on, show here. One asked of you leaves once you've reviewed it." });
    fireEvent.click(within(main()).getByRole('button', { name: 'Review requested', pressed: true }));
    fireEvent.click(chip('Mentioned'));
    expect(screen.getByText('No mentions')).toBeDefined();
    fireEvent.click(within(main().querySelector('.empty-state')!).getByRole('button', { name: 'Clear filters' }));
    expect(rows()).toEqual(['alpha']);
  });

  it('says when nothing of yours is open, and when the chips and the text find nothing together', () => {
    const { again } = renderDashboard(prList([review, mention]));
    fireEvent.click(chip('Yours'));
    expect(screen.getByText('No open pull requests of yours')).toBeDefined();
    again(prList(ALL));
    fireEvent.change(within(main()).getByRole('searchbox', { name: 'Filter pull requests' }), { target: { value: 'retry budget' } });
    expect(rows()).toEqual([]);
    expect(main().querySelector('.empty-state-sentence')?.textContent).toBe('Nothing in Pull requests matches "retry budget" with these filters.');
    fireEvent.click(within(main()).getByRole('button', { name: 'Yours', pressed: true }));
    expect(rows()).toEqual(['#77']);
  });

  it("names a search that failed while the others worked, and when its pull requests are from, or that they aren't listed (W101's review)", () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    // The mention search has never worked, so there's no mention in the list.
    const list = prList(ALL.filter((each) => each.relation !== 'mentioned'), {
      searches: {
        authored: { fetchedAt: minutesAgo(2) },
        'review-requested': { fetchedAt: minutesAgo(125), failed: { reason: 'error', error: 'gh api failed with exit code 1.' } },
        mentioned: { failed: { reason: 'error', error: "GitHub didn't answer within 30 seconds." } },
      },
    });
    renderDashboard(list);
    const notice = main().querySelector('.pr-stale .inline-alert');
    expect(notice?.querySelector('.inline-alert-title')?.textContent).toBe("Couldn't refresh part of your pull requests");
    expect([...(notice?.querySelectorAll('.pr-stale-search') ?? [])].map((line) => line.textContent)).toEqual([
      'The pull requests that ask your review are from 2h ago. gh api failed with exit code 1.',
      "The pull requests that mention you aren't listed. GitHub didn't answer within 30 seconds.",
    ]);
    // The list is kept: every row, the review requests' last good ones among them.
    expect(rows()).toHaveLength(6);
    // A chip whose search has never worked says it couldn't list them, not that there are none.
    fireEvent.click(chip('Mentioned'));
    expect(screen.getByText("Couldn't list the pull requests that mention you")).toBeDefined();
    expect(within(main().querySelector('.empty-state')!).getByRole('button', { name: 'Refresh' })).toBeDefined();
  });

  it('has no notice while every search worked', () => {
    renderDashboard(prList(ALL, { searches: { authored: { fetchedAt: minutesAgo(2) }, 'review-requested': { fetchedAt: minutesAgo(2) }, mentioned: { fetchedAt: minutesAgo(2) } } }));
    expect(main().querySelector('.pr-stale')).toBeNull();
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

describe("the session view's Pull requests tab (W106)", () => {
  const tab = () => within(sessionView()!).queryByRole('tab', { name: /^Pull requests/ });

  it('lists the PRs the session owns, with the PR view’s details and Open on GitHub, and opens one’s view', async () => {
    const { navigation } = renderDashboard(prList(PRS), { search: '?view=all&session=pr-alpha' });
    await settle();
    expect(tab()?.textContent).toBe('Pull requests (2)');
    fireEvent.click(tab()!);
    const panel = sessionView()!.querySelector<HTMLElement>('.session-prs')!;
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector('h3')?.textContent).toBe('Its pull requests');
    const cards = [...panel.querySelectorAll('.session-pr')];
    expect(cards.map((card) => card.querySelector('.session-pr-open')?.textContent)).toEqual(['#42 Fix the made-up export job', `#43 ${approved.title}`]);
    const details = Object.fromEntries([...cards[0]!.querySelectorAll('.pr-view-detail')].map((detail) => [detail.querySelector('dt')?.textContent, detail.querySelector('dd')?.textContent]));
    expect(details.Checks).toBe('Failingtest (22.x)lint+2 more');
    expect(details.Merge).toBe('No conflicts');
    expect(details.Draft).toBe('Ready for review');
    const github = within(cards[0] as HTMLElement).getByRole('link', { name: OPEN_ON_GITHUB });
    expect([github.getAttribute('href'), github.getAttribute('target'), github.getAttribute('rel')]).toEqual(['https://github.com/example/demo-app/pull/42', '_blank', 'noopener noreferrer']);
    // The footer stays: the message box is the session's.
    expect(sessionView()!.querySelector<HTMLElement>('.session-view-foot')?.hidden).toBe(false);
    fireEvent.click(within(cards[1] as HTMLElement).getByRole('button', { name: `#43 ${approved.title}` }));
    await settle();
    expect(navigation.location.search).toBe('?view=all&pr=example/demo-app/43');
  });

  it('lists the PRs it worked on that another session owns, saying which, after its own', async () => {
    renderDashboard(prList(PRS), { search: '?view=all&session=pr-delta' });
    await settle();
    expect(tab()?.textContent).toBe('Pull requests (1)');
    fireEvent.click(tab()!);
    const panel = sessionView()!.querySelector<HTMLElement>('.session-prs')!;
    expect(panel.querySelector('h3')?.textContent).toBe('Also worked on');
    expect(panel.querySelector('.session-prs-intro')?.textContent).toBe(LINKED_NOTE);
    expect(panel.querySelector('.session-pr-owner')?.textContent).toBe('Listed with alpha.');
  });

  it('has no tab for a session that only mentioned one, or has none, and keeps it once shown, as Sub-agents does', async () => {
    const first = renderDashboard(prList(PRS), { search: '?view=all&session=pr-gamma' });
    await settle();
    expect(tab()).toBeNull();
    first.unmount();
    const { again } = renderDashboard(prList(PRS), { search: '?view=all&session=pr-beta' });
    await settle();
    fireEvent.click(tab()!);
    again(prList([approved]));
    expect(tab()?.textContent).toBe('Pull requests');
    expect(sessionView()!.querySelector('.session-prs .empty-state-title')?.textContent).toBe('No open pull requests');
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
