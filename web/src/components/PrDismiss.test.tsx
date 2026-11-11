// Not for me (W188; docs/design-system.md, 4: Pull requests): a PR you're not taking on leaves Needs
// you and every count it feeds, its row moves to a muted, collapsed Dismissed section, Undo brings it
// back from that row, the PR view or the toast, and a row whose dismissal ended says why it's back.
// Made-up PRs, repos and sessions only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PR_DISMISS_PATH, PR_UNDISMISS_PATH, type IndexSnapshot, type PullRequestList, type PullRequestSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import type { ConnectionView } from '../connection.js';
import type { StorageSource } from '../groupState.js';
import { BACK_TEXT, DISMISSED_HEADING, DISMISSED_NOTE, dismissedToast, NOT_FOR_ME, notForMeLabel, UNDO_DISMISS, undismissedToast } from '../prDismiss.js';
import { memoryNavigation } from '../selection.js';
import { createShortcutsStore, ShortcutsStoreContext } from '../shortcuts.js';
import { group, minutesAgo, pr, prList, session, snapshot } from '../test/fixtures.js';
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
const API_KEY = 'a'.repeat(43);
const HASH = '0123456789abcdef';
const AT = minutesAgo(5);
const here = (each: PullRequestSummary): PullRequestSummary => ({ ...each, place: { kind: 'cloned', root: ROOT, key: `${ROOT}/demo-app`, label: 'demo-app' } });

// #11 asks your review; #12 is yours with failing checks; #13 mentions you; #14 asks your review with no hash.
const asked = here(pr({ number: 11, relation: 'review-requested', reviewRequest: { via: 'direct' }, stateHash: HASH }, 20));
const mine = here(pr({ number: 12, checks: 'failing', stateHash: 'fedcba9876543210' }, 30));
const mentions = here(pr({ number: 13, relation: 'mentioned', stateHash: '1111111111111111' }, 40));
const unhashed = here(pr({ number: 14, relation: 'review-requested', reviewRequest: { via: 'direct' } }, 50));

function snap(): IndexSnapshot {
  return snapshot([group({ key: `${ROOT}/demo-app`, label: 'demo-app', sessions: [session({ sessionId: 'pr-epsilon', name: 'epsilon' })] })]);
}

function memory(): StorageSource {
  const items = new Map<string, string>();
  return () => ({ getItem: (name) => items.get(name) ?? null, setItem: (name, value) => void items.set(name, value) });
}

function renderDashboard(prs: PullRequestList, search = '?view=prs', answer: unknown = { ok: true, dismissed: { at: AT } }) {
  const fetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify(answer), { status: 200 }));
  const shortcuts = createShortcutsStore({ storage: memory(), events: { addEventListener: () => {} } });
  const api = createApiClient({ apiKey: API_KEY, fetch });
  const ui = (list: PullRequestList) => {
    const view: ConnectionView = { state: 'live', snapshot: snap(), prs: list };
    return (
      <ApiContext.Provider value={api}>
        <ShortcutsStoreContext.Provider value={shortcuts}>
          <Dashboard view={view} navigation={memoryNavigation(search)} storage={memory()} />
        </ShortcutsStoreContext.Provider>
      </ApiContext.Provider>
    );
  };
  const result = render(ui(prs));
  return { ...result, fetch, again: (next: PullRequestList) => result.rerender(ui(next)) };
}

const settle = () => act(async () => {});
const main = () => screen.getByRole('main');
const repoList = () => screen.getByRole('navigation', { name: 'Repos' });
const repoItem = (label: string) => [...repoList().querySelectorAll<HTMLAnchorElement>('a[data-repo-item]')].find((link) => link.querySelector('.repo-item-label')?.textContent === label);
/** The PR rows shown, by number, outside any collapsed section. */
const shownRows = () =>
  [...main().querySelectorAll<HTMLElement>('[data-open-pr]')].filter((button) => !button.closest('[hidden]')).map((button) => Number(button.dataset.openPr?.split('/').pop()));
const row = (number: number) => main().querySelector<HTMLElement>(`li[data-pr$="/${number}"]`)!;
const dismissedToggle = () => main().querySelector<HTMLButtonElement>('[data-dismissed-toggle]');
const posted = (fetch: ReturnType<typeof vi.fn<FetchLike>>) => fetch.mock.calls.map(([url, init]) => [url, JSON.parse(String(init.body)) as unknown]);
const dismissed = (each: PullRequestSummary): PullRequestSummary => ({ ...each, dismissed: { at: AT } });

describe('Not for me on a PR row', () => {
  it('is a toggle at the end of line 2, off, on each row it can dismiss', () => {
    renderDashboard(prList([asked, mine, mentions]));
    for (const each of [asked, mine, mentions]) {
      const toggle = within(row(each.number)).getByRole('button', { name: notForMeLabel(each) });
      expect(toggle.getAttribute('aria-pressed')).toBe('false');
      expect(toggle.closest('.session-line-2')?.lastElementChild).toBe(toggle);
    }
  });

  it('dismisses it in the state the page shows, with a toast whose Undo takes it off', async () => {
    const { fetch } = renderDashboard(prList([asked, mine, mentions]));
    const button = within(row(11)).getByRole('button', { name: notForMeLabel(asked) });
    fireEvent.click(button);
    await settle();
    expect(posted(fetch)).toEqual([[PR_DISMISS_PATH, { repo: 'example/demo-app', number: 11, seen: HASH }]]);
    expect(toastMessages()).toEqual([dismissedToast(asked)]);
    fireEvent.click(within(toastSaying(dismissedToast(asked))).getByRole('button', { name: UNDO_DISMISS }));
    await settle();
    expect(posted(fetch)[1]).toEqual([PR_UNDISMISS_PATH, { repo: 'example/demo-app', number: 11 }]);
    expect(toastMessages()).toEqual([]);
  });

  it('takes its toast away once the dismissal ends by itself, as Undo would do nothing', async () => {
    const { again } = renderDashboard(prList([asked]));
    fireEvent.click(within(row(11)).getByRole('button', { name: notForMeLabel(asked) }));
    await settle();
    again(prList([dismissed(asked)]));
    expect(toastMessages()).toEqual([dismissedToast(asked)]);
    again(prList([{ ...asked, stateHash: 'aaaaaaaaaaaaaaaa', dismissalEnded: { at: AT } }]));
    await settle();
    expect(toastMessages()).toEqual([]);
  });

  it('sends the red hash the page shows, for your own PR whose CI fails (W188’s review)', async () => {
    const red = { ...mine, redHash: 'abababababababab' };
    const { fetch } = renderDashboard(prList([red]));
    fireEvent.click(within(row(12)).getByRole('button', { name: notForMeLabel(red) }));
    await settle();
    expect(posted(fetch)).toEqual([[PR_DISMISS_PATH, { repo: 'example/demo-app', number: 12, seen: 'fedcba9876543210', seenRed: 'abababababababab' }]]);
  });

  it('says what went wrong when the server refuses, as when something new happened since', async () => {
    renderDashboard(prList([asked]), '?view=prs', { ok: false, error: 'Something new happened on it since the page showed it. Look again before you dismiss it.' });
    fireEvent.click(within(row(11)).getByRole('button', { name: notForMeLabel(asked) }));
    await settle();
    expect(toastMessages()).toEqual(['Something new happened on it since the page showed it. Look again before you dismiss it.']);
  });

  it('isn’t offered on a PR the server can’t compare, with no state hash', () => {
    renderDashboard(prList([unhashed]));
    expect(within(row(14)).queryByRole('button', { name: notForMeLabel(unhashed) })).toBeNull();
  });
});

describe('a dismissed PR', () => {
  it('needs you nowhere: Needs you, the Pull requests item’s badge and the page title leave it out', () => {
    const { again } = renderDashboard(prList([asked, mine]), '?view=all');
    expect(repoItem('Needs you')?.querySelector('.badge')?.textContent).toBe('2 need you');
    expect(repoItem('Pull requests')?.querySelector('.badge')?.textContent).toBe('2 need you');
    expect(document.title).toBe('(2) pitwall');
    again(prList([dismissed(asked), mine]));
    expect(repoItem('Needs you')?.querySelector('.badge')?.textContent).toBe('1 needs you');
    expect(repoItem('Pull requests')?.querySelector('.badge')?.textContent).toBe('1 needs you');
    expect(document.title).toBe('(1) pitwall');
    again(prList([dismissed(asked), dismissed(mine)]));
    expect(repoItem('Needs you')?.querySelector('.badge')).toBeNull();
    expect(document.title).toBe('pitwall');
  });

  it('isn’t listed in Needs you at all', () => {
    renderDashboard(prList([dismissed(asked), mine]), '?view=needs-you');
    expect(shownRows()).toEqual([12]);
    expect(dismissedToggle()).toBeNull();
  });

  it('moves to the Dismissed section, collapsed and muted, its toggle pressed: pressing it is Undo', async () => {
    const { fetch } = renderDashboard(prList([dismissed(asked), mine, mentions]));
    expect(shownRows()).toEqual([12, 13]);
    const toggle = dismissedToggle()!;
    expect(toggle.textContent).toBe(`${DISMISSED_HEADING} (1)`);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(shownRows()).toEqual([12, 13, 11]);
    expect(row(11).classList.contains('pr-dismissed')).toBe(true);
    expect(row(11).dataset.attention).toBeUndefined();
    const pressed = within(row(11)).getByRole('button', { name: notForMeLabel(asked) });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(pressed);
    await settle();
    expect(posted(fetch)).toEqual([[PR_UNDISMISS_PATH, { repo: 'example/demo-app', number: 11 }]]);
    // Undo from the row needs no toast: the row moves back.
    expect(toastMessages()).toEqual([]);
  });

  it('is in the Dismissed section of All sessions too, and the summary still counts it', () => {
    renderDashboard(prList([dismissed(asked), mine]), '?view=all');
    expect(shownRows()).toEqual([12]);
    expect(dismissedToggle()?.textContent).toBe(`${DISMISSED_HEADING} (1)`);
  });

  it('keeps the section when every PR is dismissed, rather than saying there are none', () => {
    renderDashboard(prList([dismissed(asked)]));
    expect(screen.queryByText('No open pull requests')).toBeNull();
    expect(dismissedToggle()?.textContent).toBe(`${DISMISSED_HEADING} (1)`);
  });

  it('says why it’s back once its dismissal ended, first on line 2', () => {
    renderDashboard(prList([{ ...asked, dismissalEnded: { at: AT } }]));
    expect(row(11).querySelector('.pr-back')?.textContent).toBe(BACK_TEXT);
    expect(row(11).dataset.attention).toBe('true');
  });
});

describe('the PR view', () => {
  it('offers Not for me, and once it’s dismissed says so with Undo', async () => {
    const { fetch, again } = renderDashboard(prList([asked]), '?view=prs&pr=example%2Fdemo-app%2F11');
    const view = document.getElementById('pr-view')!;
    fireEvent.click(within(view).getByRole('button', { name: NOT_FOR_ME }));
    await settle();
    expect(posted(fetch)).toEqual([[PR_DISMISS_PATH, { repo: 'example/demo-app', number: 11, seen: HASH }]]);
    again(prList([dismissed(asked)]));
    const after = document.getElementById('pr-view')!;
    expect(after.querySelector('.pr-view-dismissed')?.textContent).toContain(DISMISSED_NOTE);
    expect(within(after).queryByRole('button', { name: NOT_FOR_ME })).toBeNull();
    const undo = within(after).getByRole('button', { name: UNDO_DISMISS });
    // Focus follows to Undo, which took Not for me's place.
    expect(document.activeElement).toBe(undo);
    fireEvent.click(undo);
    await settle();
    expect(posted(fetch)[1]).toEqual([PR_UNDISMISS_PATH, { repo: 'example/demo-app', number: 11 }]);
    expect(toastMessages()).toContain(undismissedToast(asked));
  });
});
