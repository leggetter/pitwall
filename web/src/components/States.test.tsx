// W28's states (docs/design-system.md, 4: Skeletons and spinners and Empty states, 5: Errors and
// Empty states): the skeletons on first connect and the long-wait line, every empty state with its
// title, sentence and action, the session view's waiting and unlisted states, the conversation's
// failures with Try again, kept entries after a failed refresh, and the connection badge's Spinner.
// Made-up sessions and conversations only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef, type CSSProperties } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEntry, ConversationPage, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import type { ConnectionView } from '../connection.js';
import { memoryNavigation, type NavigationEnv } from '../selection.js';
import { group, minutesAgo, mixedSnapshot, NOW, session, snapshot } from '../test/fixtures.js';
import { withoutComments, block, declarations } from '../test/css.js';
import stylesCss from '../styles.css?raw';
import { ConnectionBadge } from './ConnectionBadge.js';
import { Dashboard } from './Dashboard.js';
import { SessionView } from './SessionView.js';
import { Spinner } from './Spinner.js';
import { useWaiting } from './Waiting.js';

const styles = withoutComments(stylesCss);

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

/** Moves the fake clock on, letting React apply what the timers set. */
function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function dashboard(view: ConnectionView, navigation: NavigationEnv = memoryNavigation('')) {
  const ui = (next: ConnectionView) => <Dashboard view={next} navigation={navigation} />;
  const result = render(ui(view));
  return { ...result, navigation, update: (next: ConnectionView) => result.rerender(ui(next)) };
}

const repoList = () => screen.getByRole('navigation', { name: 'Repos' });
const listBody = () => document.querySelector<HTMLElement>('.session-list-body')!;
const listHeading = () => within(screen.getByRole('main')).getByRole('heading', { level: 2 });
const rowNames = () => screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent ?? '');

describe('first connect: skeletons', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
  });

  it('shows nothing before --pw-delay-spinner, so a fast connect never flashes them', () => {
    dashboard({ state: 'connecting' });
    wait(499);
    expect(document.querySelector('.skeleton-rows, .skeleton-items, .skeleton-bar')).toBeNull();
    // The status is there from the start, empty, so what it comes to say is announced.
    const status = within(listBody()).getByRole('status');
    expect(status.textContent).toBe('');
  });

  it('then four skeleton items in the repo list and three skeleton rows, aria-hidden, with a hidden "Loading sessions" status', () => {
    dashboard({ state: 'connecting' });
    wait(500);
    const rows = listBody().querySelector('.skeleton-rows')!;
    expect(rows.getAttribute('aria-hidden')).toBe('true');
    expect(rows.querySelectorAll('.skeleton-row')).toHaveLength(3);
    // Two bars a row, as a session row has two lines.
    for (const row of rows.querySelectorAll('.skeleton-row')) expect(row.querySelectorAll('.skeleton-bar')).toHaveLength(2);
    const items = repoList().querySelector('.skeleton-items')!;
    expect(items.getAttribute('aria-hidden')).toBe('true');
    expect(items.querySelectorAll('.skeleton-item')).toHaveLength(4);
    // Below the two views and the divider, which stay real.
    expect([...repoList().querySelectorAll('a[data-repo-item]')].map((link) => link.textContent)).toEqual(['Needs you', 'All sessions']);
    expect(repoList().querySelector('hr.repo-divider')).toBeTruthy();
    const status = within(listBody()).getByRole('status');
    expect(status.textContent).toBe('Loading sessions');
    expect(status.querySelector('.visually-hidden')?.textContent).toBe('Loading sessions');
    expect(rows.contains(status)).toBe(false);
  });

  it('adds what is slow after --pw-delay-long: the first poll, which runs `claude agents`', () => {
    dashboard({ state: 'connecting' });
    wait(9_999);
    expect(within(listBody()).getByRole('status').textContent).toBe('Loading sessions');
    wait(1);
    const status = within(listBody()).getByRole('status');
    const line = status.querySelector('p.status-line')!;
    expect(line.textContent).toBe('Still waiting for claude agents…');
    expect(line.querySelector('code')?.textContent).toBe('claude agents');
    // The skeletons stay.
    expect(listBody().querySelectorAll('.skeleton-row')).toHaveLength(3);
  });

  it('says it is still trying to reach pitwall when the connection dropped before the first snapshot', () => {
    dashboard({ state: 'reconnecting' });
    wait(10_000);
    expect(within(listBody()).getByRole('status').querySelector('.status-line')?.textContent).toBe('Still trying to reach pitwall…');
  });

  it('goes with the first snapshot, and no status is left behind', () => {
    const { update } = dashboard({ state: 'connecting' });
    wait(10_000);
    update({ state: 'live', snapshot: mixedSnapshot() });
    expect(document.querySelector('.skeleton-rows, .skeleton-items, .skeleton-bar, .waiting-status')).toBeNull();
    expect(within(listBody()).queryByRole('status')).toBeNull();
    expect(rowNames()).toContain('demo-docs');
  });

  it('pulses only without reduced motion', () => {
    expect(block(styles, /(?:^|\})\s*\.skeleton-bar\s*\{/)).toContain('animation: pw-pulse 1.5s ease-in-out infinite');
    const reduced = block(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.skeleton-bar\s*\{/);
    expect(declarations(reduced)).toEqual([['animation', 'none']]);
  });
});

describe('the waiting delays come from the tokens', () => {
  function Probe({ style, active }: { style?: CSSProperties; active: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const waiting = useWaiting(ref, active);
    return (
      <div ref={ref} style={style} data-shown={waiting.shown} data-long={waiting.long}>
        probe
      </div>
    );
  }
  const probe = () => screen.getByText('probe');

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('reads --pw-delay-spinner and --pw-delay-long from the element, as a part of the page can set its own', () => {
    render(<Probe active style={{ '--pw-delay-spinner': '50ms', '--pw-delay-long': '0.2s' } as CSSProperties} />);
    wait(49);
    expect(probe().dataset.shown).toBe('false');
    wait(1);
    expect(probe().dataset.shown).toBe('true');
    expect(probe().dataset.long).toBe('false');
    wait(150);
    expect(probe().dataset.long).toBe('true');
  });

  it("falls back to the doc's 500 ms and 10 s, and starts again once it's no longer waiting", () => {
    const { rerender } = render(<Probe active />);
    wait(500);
    expect(probe().dataset.shown).toBe('true');
    rerender(<Probe active={false} />);
    expect(probe().dataset.shown).toBe('false');
    rerender(<Probe active />);
    wait(499);
    expect(probe().dataset.shown).toBe('false');
    wait(9_501);
    expect(probe().dataset.long).toBe('true');
  });
});

describe('empty states', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
  });

  /** The one empty state on the page, as icon, title, sentence and the actions' names. */
  function emptyState(scope: ParentNode = document) {
    const shown = scope.querySelector<HTMLElement>('.empty-state');
    if (!shown) throw new Error('no empty state');
    const icon = shown.firstElementChild;
    return {
      element: shown,
      icon: icon?.tagName.toLowerCase() === 'svg' ? `${icon.getAttribute('width')}×${icon.getAttribute('height')}` : undefined,
      title: shown.querySelector('.empty-state-title')?.textContent,
      sentence: shown.querySelector('.empty-state-sentence')?.textContent,
      actions: [...shown.querySelectorAll<HTMLButtonElement>('.empty-state-actions button')],
    };
  }
  const names = (buttons: HTMLButtonElement[]) => buttons.map((button) => `${button.textContent} (${button.className})`);
  const filterField = () => screen.getByRole('searchbox') as HTMLInputElement;

  it('has the anatomy: a 24 px decorative icon, the title, one sentence and the action, at most 408 px wide and centred', () => {
    dashboard({ state: 'live', snapshot: snapshot([], { roots: ['/Users/example/code'] }) });
    const { element, icon } = emptyState();
    expect(icon).toBe('24×24');
    expect(element.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    const rule = declarations(block(styles, /(?:^|\})\s*\.empty-state\s*\{/));
    expect(rule).toEqual(expect.arrayContaining([['max-width', '408px'], ['text-align', 'center'], ['align-items', 'center'], ['margin', 'auto']]));
    expect(block(styles, /(?:^|\})\s*\.empty-state-icon\s*\{/)).toContain('color: var(--pw-text-subtle)');
  });

  it('no sessions under the roots: primary New session, which opens the dialog', () => {
    dashboard({ state: 'live', snapshot: snapshot([], { roots: ['/Users/example/code'] }) });
    const shown = emptyState(listBody());
    expect(shown.title).toBe('No Claude Code sessions under ~/code');
    expect(shown.sentence).toBe('Start one here, or start Claude Code in any terminal under these directories and it appears here.');
    expect(names(shown.actions)).toEqual(['New session (button primary md)']);
    expect(shown.actions[0]?.querySelector('svg')).toBeTruthy();
    fireEvent.click(shown.actions[0]!);
    expect(screen.getByRole('dialog', { name: 'New session' })).toBeTruthy();
  });

  it('the filter matches nothing: outline Clear filters, which clears the text and chips and puts focus in the field', () => {
    dashboard({ state: 'live', snapshot: mixedSnapshot() });
    fireEvent.click(screen.getByRole('button', { name: 'Background' }));
    fireEvent.change(filterField(), { target: { value: 'zzz' } });
    const shown = emptyState(listBody());
    expect(shown.title).toBe('No sessions match');
    expect(shown.sentence).toBe('Nothing in All sessions matches "zzz" with these filters.');
    // Outside a group, Clear filters alone.
    expect(names(shown.actions)).toEqual(['Clear filters (button md)']);

    fireEvent.click(shown.actions[0]!);
    expect(filterField().value).toBe('');
    expect(screen.getByRole('button', { name: 'Background' }).getAttribute('aria-pressed')).toBe('false');
    expect(rowNames()).toHaveLength(5);
    expect(document.activeElement).toBe(filterField());
  });

  it('in a group, with text in the field: outline Search all sessions too, which selects All sessions and keeps the text', () => {
    dashboard({ state: 'live', snapshot: mixedSnapshot() }, memoryNavigation('?repo=/Users/example/code/demo-app'));
    fireEvent.change(filterField(), { target: { value: 'tidy' } });
    const shown = emptyState(listBody());
    expect(shown.sentence).toBe('Nothing in demo-app matches "tidy".');
    expect(names(shown.actions)).toEqual(['Clear filters (button md)', 'Search all sessions (button md)']);

    fireEvent.click(shown.actions[1]!);
    expect(listHeading().textContent).toBe('All sessions');
    expect(filterField().value).toBe('tidy');
    expect(rowNames()).toEqual(['notes-tidy']);
    expect(document.activeElement).toBe(filterField());
  });

  it('in a group with only a chip on: Clear filters alone, and the sentence about the filters', () => {
    dashboard({ state: 'live', snapshot: mixedSnapshot() }, memoryNavigation('?repo=/Users/example/code/notes'));
    fireEvent.click(screen.getByRole('button', { name: 'Background' }));
    const shown = emptyState(listBody());
    expect(shown.sentence).toBe('Nothing in notes matches these filters.');
    expect(names(shown.actions)).toEqual(['Clear filters (button md)']);
  });

  it('a selected group has left the snapshot: outline Show all sessions, with focus on the heading after', () => {
    const navigation = memoryNavigation('?repo=/Users/example/code/legacy');
    const { update } = dashboard({ state: 'live', snapshot: mixedSnapshot() }, navigation);
    const gone = mixedSnapshot();
    gone.groups = gone.groups.filter((shown) => shown.label !== 'legacy');
    update({ state: 'live', snapshot: gone });
    const shown = emptyState(listBody());
    expect(shown.title).toBe('No sessions in legacy now');
    expect(shown.sentence).toBe('Its sessions are no longer listed under these roots.');
    expect(names(shown.actions)).toEqual(['Show all sessions (button md)']);

    fireEvent.click(shown.actions[0]!);
    expect(listHeading().textContent).toBe('All sessions');
    expect(navigation.location.search).toBe('?view=all');
    expect(document.activeElement).toBe(listHeading());
  });

  it('Needs you, and nothing does: outline Show all sessions', () => {
    dashboard({ state: 'live', snapshot: snapshot([group({ sessions: [session({ name: 'calm', status: 'idle' })] })]) }, memoryNavigation('?view=needs-you'));
    const shown = emptyState(listBody());
    expect(shown.title).toBe('Nothing needs you right now');
    expect(shown.sentence).toBe('Sessions that are waiting for you, or asked you something, show here.');
    expect(names(shown.actions)).toEqual(['Show all sessions (button md)']);
    // No summary over it, which would only say "Nothing needs you" again (W31).
    expect(document.querySelector('.session-list .summary')).toBeNull();
    fireEvent.click(shown.actions[0]!);
    expect(rowNames()).toEqual(['calm']);
    expect(document.activeElement).toBe(listHeading());
    expect(document.querySelector('.session-list .summary')?.textContent).toBe('1 session·Nothing needs you');
  });

  it('has no summary over the no-sessions empty state, which would only say "0 sessions · Nothing needs you" (W31)', () => {
    dashboard({ state: 'live', snapshot: snapshot([]) });
    expect(emptyState().title).toBe('No Claude Code sessions under ~/code');
    expect(document.querySelector('.session-list .summary')).toBeNull();
  });

  it('keeps the summary over the no-match empty state, where it says what the filter hides', () => {
    dashboard({ state: 'live', snapshot: snapshot([group({ sessions: [session({ name: 'calm', status: 'idle' })] })]) });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter sessions' }), { target: { value: 'nothing-like-it' } });
    expect(emptyState().title).toBe('No sessions match');
    expect(document.querySelector('.session-list .summary')?.textContent).toBe('0 of 1 session·Nothing needs you');
  });

  it('the session view column with nothing open: "Select a session", and no action', () => {
    setWidth(1300);
    dashboard({ state: 'live', snapshot: mixedSnapshot() });
    const shown = emptyState(screen.getByRole('region', { name: 'Session' }));
    expect(shown.title).toBe('Select a session');
    expect(shown.sentence).toBe('Its conversation, terminal and actions open here.');
    expect(shown.actions).toEqual([]);
    expect(shown.element.querySelector('.empty-state-actions')).toBeNull();
  });

  it('renders names, roots and filter text as text, never markup', () => {
    dashboard({ state: 'live', snapshot: snapshot([], { roots: ['/Users/example/<b>code</b>'] }) });
    expect(emptyState().title).toBe('No Claude Code sessions under ~/<b>code</b>');
    expect(document.querySelector('.empty-state b')).toBeNull();
  });
});

describe("the session view's waiting and unlisted states", () => {
  const ID = '00000000-0000-4000-8000-0000000000e1';
  const snap = () => snapshot([group({ sessions: [session({ sessionId: ID, name: 'demo-waited' })] })]);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
  });

  it('opens a ?session= before the first snapshot in its waiting state, with Close, taking no focus', () => {
    const navigation = memoryNavigation(`?view=all&session=${ID}`);
    dashboard({ state: 'connecting' }, navigation);
    const view = screen.getByRole('dialog', { name: 'Session' });
    expect(view.id).toBe('session-view');
    expect(within(view).getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
    // Nothing more before --pw-delay-spinner.
    wait(499);
    expect(view.querySelector('.skeleton-bar')).toBeNull();
    expect(within(view).getByRole('status').textContent).toBe('');

    wait(1);
    expect(view.querySelector('.skeleton-heading')?.getAttribute('aria-hidden')).toBe('true');
    expect(view.querySelector('.skeleton-meta')?.getAttribute('aria-hidden')).toBe('true');
    expect(within(view).getByRole('status').textContent).toBe('Loading the session');

    wait(9_500);
    expect(within(view).getByRole('status').querySelector('.status-line')?.textContent).toBe('Still waiting for claude agents…');

    fireEvent.click(within(view).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(navigation.location.search).toBe('?view=all');
  });

  it('becomes the session once the first snapshot lists it, or the unlisted state if it does not', () => {
    const { update } = dashboard({ state: 'connecting' }, memoryNavigation(`?view=all&session=${ID}`));
    update({ state: 'live', snapshot: snap() });
    expect(screen.getByRole('dialog', { name: 'demo-waited' })).toBeTruthy();

    const other = dashboard({ state: 'connecting' }, memoryNavigation('?view=all&session=pitwall-test-unknown'));
    other.update({ state: 'live', snapshot: snap() });
    expect(screen.getByRole('dialog', { name: "This session isn't listed under these roots" })).toBeTruthy();
  });

  it('waits in the third column from 1,200 px, as a region', () => {
    setWidth(1300);
    dashboard({ state: 'connecting' }, memoryNavigation(`?view=all&session=${ID}`));
    const view = document.getElementById('session-view')!;
    expect(view.className).toContain('in-column');
    expect(view.getAttribute('role')).toBeNull();
    expect(screen.getAllByRole('region', { name: 'Session' })).toContain(view);
  });

  it('shows the unlisted state as an empty state whose title is the heading, with the id and the roots as text', () => {
    const { update } = dashboard({ state: 'connecting' }, memoryNavigation('?view=all&session=pitwall-test-<b>unknown</b>'));
    update({ state: 'live', snapshot: snap() });
    const view = screen.getByRole('dialog', { name: "This session isn't listed under these roots" });
    const heading = within(view).getByRole('heading', { level: 2 });
    expect(heading.className).toBe('empty-state-title');
    expect(view.getAttribute('aria-labelledby')).toBe(heading.id);
    const state = view.querySelector('.empty-state')!;
    expect(state.querySelector('svg')?.getAttribute('width')).toBe('24');
    expect(state.querySelector('.empty-state-sentence')?.textContent).toBe(
      'pitwall lists no session with the id pitwall-test-<b>unknown</b> under ~/code; it may have been removed, or run outside these roots.',
    );
    expect(state.querySelector('b')).toBeNull();
    expect(within(view.querySelector('header')!).getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(state.querySelector('button')).toBeNull();
  });
});

describe('the connection badge', () => {
  it('uses Spinner while connecting and reconnecting', () => {
    const spinner = render(<Spinner />).container.innerHTML;
    for (const state of ['connecting', 'reconnecting'] as const) {
      const { container, unmount } = render(<ConnectionBadge state={state} />);
      const lead = container.querySelector('.badge')?.firstElementChild;
      expect(lead?.outerHTML).toBe(spinner);
      unmount();
    }
    const live = render(<ConnectionBadge state="live" />).container;
    expect(live.querySelector('.spinner')).toBeNull();
    expect(live.querySelector('.status-dot')).toBeTruthy();
  });

  it('has no spinner of its own in the stylesheet: the badge rule makes Spinner take its text colour', () => {
    expect(styles).not.toMatch(/\.connection[^{]*\.spinner/);
    expect(styles).not.toMatch(/\.connection[^{]*::(before|after)/);
    expect(block(styles, /(?:^|\})\s*\.badge > \.spinner,\s*\.button > \.spinner\s*\{/)).toContain('color: inherit');
  });
});

// The conversation's failures, on the session view alone.

const SID = '00000000-0000-4000-8000-0000000000e2';
const API_KEY = 'k'.repeat(43);
const at = (second: number) => `2026-03-02T11:50:${String(second).padStart(2, '0')}.000Z`;
const you = (second: number): ConversationEntry => ({ kind: 'user', at: at(second), text: `prompt ${second}` });

type Answer = { page: ConversationPage } | { status: number; body?: unknown } | 'network' | 'never' | (() => Promise<Response>);
const page = (entries: ConversationEntry[], before?: string): Answer => ({ page: before === undefined ? { sessionId: SID, entries } : { sessionId: SID, entries, before } });
const status = (code: number, body?: unknown): Answer => (body === undefined ? { status: code } : { status: code, body });

/** A server that answers the newest page and the older ones from their own queues, the last answer repeating. */
function server(newest: Answer[], older: Answer[] = []) {
  const counts = { newest: 0, older: 0 };
  const respond = async (answer: Answer | undefined): Promise<Response> => {
    if (answer === undefined) throw new Error('no answer');
    if (answer === 'network') throw new Error('offline');
    if (answer === 'never') return new Promise<Response>(() => {});
    if (typeof answer === 'function') return answer();
    if ('page' in answer) return new Response(JSON.stringify(answer.page), { status: 200 });
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  };
  return vi.fn<FetchLike>(async (url) => {
    const isOlder = new URL(url, 'http://127.0.0.1').searchParams.has('before');
    const queue = isOlder ? older : newest;
    const at = isOlder ? counts.older++ : counts.newest++;
    return respond(queue[Math.min(at, queue.length - 1)]);
  });
}

/** A gate: an answer that waits until the test opens it. */
function gate(answer: Answer) {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const respond: Answer = async () => {
    await opened;
    if (typeof answer === 'object' && 'page' in answer) return new Response(JSON.stringify(answer.page), { status: 200 });
    return new Response(null, { status: (answer as { status: number }).status });
  };
  return { answer: respond, open: () => act(async () => open()) };
}

const settle = () => act(async () => {});

async function renderView(fetch: FetchLike, overrides: Partial<SessionSummary> = {}) {
  const api = createApiClient({ apiKey: API_KEY, fetch });
  let current = session({ sessionId: SID, name: 'demo-states', lastActivityAt: minutesAgo(5), ...overrides });
  let activity = Date.parse(current.lastActivityAt ?? minutesAgo(5));
  const ui = () => (
    <ApiContext.Provider value={api}>
      <SessionView session={current} listed onClose={() => {}} />
    </ApiContext.Provider>
  );
  const result = render(ui());
  await settle();
  const body = result.container.querySelector<HTMLElement>('.session-view-body')!;
  return {
    ...result,
    body,
    /** The session does something, so the view fetches the newest page again. */
    async refresh() {
      activity += 1000;
      current = { ...current, lastActivityAt: new Date(activity).toISOString() };
      result.rerender(ui());
      await settle();
    },
  };
}

const texts = (body: HTMLElement) => [...body.querySelectorAll('.entry-text')].map((text) => text.textContent);
const alerts = (body: HTMLElement) => [...body.querySelectorAll<HTMLElement>('.conversation-alert')];
const tryAgain = (scope: HTMLElement) => within(scope).getByRole('button', { name: /^(Try again|Trying again…)$/ });

describe("the conversation's status lines", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
  });

  const statusRegion = (body: HTMLElement) => body.querySelector<HTMLElement>('.conversation-status[role="status"]')!;

  it('says "Loading the conversation…" only after --pw-delay-spinner, then what is slow after --pw-delay-long', async () => {
    const { body } = await renderView(server(['never']));
    expect(statusRegion(body).textContent).toBe('');
    wait(500);
    expect(statusRegion(body).textContent).toBe('Loading the conversation…');
    wait(9_500);
    expect([...statusRegion(body).querySelectorAll('.status-line')].map((line) => line.textContent)).toEqual([
      'Loading the conversation…',
      'Still waiting for the transcript…',
    ]);
  });

  it('never shows it for a fast answer', async () => {
    const { body } = await renderView(server([page([you(1)])]));
    wait(10_000);
    expect(statusRegion(body).textContent).toBe('');
    expect(texts(body)).toEqual(['prompt 1']);
  });

  it('says "Nothing to show yet." and "No transcript for this session." as status lines', async () => {
    const empty = await renderView(server([page([])]));
    expect(statusRegion(empty.body).querySelector('.status-line')?.textContent).toBe('Nothing to show yet.');
    empty.unmount();
    const missing = await renderView(server([status(404)]));
    expect(statusRegion(missing.body).querySelector('.status-line')?.textContent).toBe('No transcript for this session.');
  });
});

describe("the conversation's errors", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  it('a first page that fails: a danger alert, "Couldn\'t load the conversation." with the status, and Try again', async () => {
    const retry = gate(page([you(1)]));
    const { body } = await renderView(server([status(500), retry.answer]));
    const [alert] = alerts(body);
    expect(alert?.className).toContain('danger');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.querySelector('.inline-alert-body')?.textContent).toBe("Couldn't load the conversation (HTTP 500).");
    // Never "nothing here".
    expect(body.textContent).not.toContain('Nothing to show yet.');

    const button = tryAgain(alert!);
    expect(button.className).toBe('button sm');
    expect(button.querySelector('svg')).toBeTruthy();
    fireEvent.click(button);
    // Busy while it's out, and the alert stays.
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toBe('Trying again…');
    expect(button.querySelector('.spinner')).toBeTruthy();
    fireEvent.click(button);
    button.focus();

    await retry.open();
    expect(alerts(body)).toEqual([]);
    expect(texts(body)).toEqual(['prompt 1']);
    // Its button has gone, so focus is on the conversation.
    expect(document.activeElement).toBe(body);
  });

  /** Counts the role="alert" elements added to `body`, each of which a screen reader announces. */
  function alertsAdded(body: HTMLElement) {
    const added: Element[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && node.getAttribute('role') === 'alert') added.push(node);
    });
    observer.observe(body, { childList: true, subtree: true });
    return { added, stop: () => observer.disconnect() };
  }

  it('a Try again that fails the same way again is a new alert, announced again, with focus on its Try again (W31)', async () => {
    const fetch = server([status(500), status(500), status(500)]);
    const { body } = await renderView(fetch);
    const first = alerts(body)[0]!;
    const said = first.querySelector('.inline-alert-body')?.textContent;
    const heard = alertsAdded(body);
    const button = tryAgain(first);
    button.focus();
    await act(async () => fireEvent.click(button));
    const second = alerts(body)[0]!;
    // The same words, so only a new element is announced.
    expect(second.querySelector('.inline-alert-body')?.textContent).toBe(said);
    expect(second).not.toBe(first);
    expect(second.getAttribute('role')).toBe('alert');
    expect(document.activeElement).toBe(tryAgain(second));
    await act(async () => fireEvent.click(tryAgain(second)));
    expect(alerts(body)[0]).not.toBe(second);
    expect(document.activeElement).toBe(tryAgain(alerts(body)[0]!));
    heard.stop();
    expect(heard.added).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('leaves focus where it is when Try again fails again with focus elsewhere', async () => {
    const { body } = await renderView(server([status(500), status(500)]));
    await act(async () => fireEvent.click(tryAgain(alerts(body)[0]!)));
    expect(document.activeElement).toBe(document.body);
  });

  it('re-announces a refresh that fails the same way only after Try again, never on each poll (W31)', async () => {
    const view = await renderView(server([page([you(1)]), status(500), status(500), status(500)]));
    await view.refresh();
    const first = alerts(view.body)[0]!;
    const said = first.querySelector('.inline-alert-body')?.textContent;
    // A later poll that fails the same way leaves the alert as it is.
    await view.refresh();
    expect(alerts(view.body)[0]).toBe(first);
    await act(async () => fireEvent.click(tryAgain(first)));
    const again = alerts(view.body)[0]!;
    expect(again).not.toBe(first);
    expect(again.querySelector('.inline-alert-body')?.textContent).toBe(said);
    expect(again.className).toContain('end');
  });

  it('makes a Load earlier that fails the same way again a new alert, with focus on its Try again (W31)', async () => {
    const { body } = await renderView(server([page([you(3)], 'cursor-1')], [status(500), status(500)]));
    await act(async () => fireEvent.click(within(body).getByRole('button', { name: 'Load earlier' })));
    const first = alerts(body)[0]!;
    const said = first.querySelector('.inline-alert-body')?.textContent;
    tryAgain(first).focus();
    await act(async () => fireEvent.click(tryAgain(first)));
    const second = alerts(body)[0]!;
    expect(second).not.toBe(first);
    expect(second.querySelector('.inline-alert-body')?.textContent).toBe(said);
    expect(document.activeElement).toBe(tryAgain(second));
  });

  it('a failed Try again leaves the alert and an idle Try again', async () => {
    const fetch = server([status(503), 'network']);
    const { body } = await renderView(fetch);
    await act(async () => fireEvent.click(tryAgain(alerts(body)[0]!)));
    const [alert] = alerts(body);
    // A network error has no status to give.
    expect(alert?.querySelector('.inline-alert-body')?.textContent).toBe("Couldn't load the conversation.");
    expect(tryAgain(alert!).getAttribute('aria-busy')).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("shows the server's reason after pitwall's sentence, as text", async () => {
    const { body } = await renderView(server([status(500, { error: 'A made-up <b>reason</b>.' })]));
    const [alert] = alerts(body);
    // The reason in place of the status, as the session actions give it.
    expect(alert?.querySelector('.inline-alert-body')?.textContent).toBe("Couldn't load the conversation. A made-up <b>reason</b>.");
    expect(alert?.querySelector('.alert-detail')?.textContent).toBe('A made-up <b>reason</b>.');
    expect(alert?.querySelector('b')).toBeNull();
  });

  it('"Couldn\'t load earlier messages." in Load earlier\'s place, a warning, with Try again that works and is busy meanwhile', async () => {
    const older = gate(page([you(1)]));
    const { body } = await renderView(server([page([you(3)], 'cursor-1')], [status(500), older.answer]));
    await act(async () => fireEvent.click(within(body).getByRole('button', { name: 'Load earlier' })));
    const [alert] = alerts(body);
    expect(alert?.className).toContain('warning');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.querySelector('.inline-alert-body')?.textContent).toBe("Couldn't load earlier messages (HTTP 500).");
    expect(within(body).queryByRole('button', { name: 'Load earlier' })).toBeNull();
    // What's shown is kept.
    expect(texts(body)).toEqual(['prompt 3']);

    fireEvent.click(tryAgain(alert!));
    expect(tryAgain(alert!).getAttribute('aria-busy')).toBe('true');
    tryAgain(alert!).focus();
    await older.open();
    expect(alerts(body)).toEqual([]);
    expect(texts(body)).toEqual(['prompt 1', 'prompt 3']);
    expect(document.activeElement).toBe(body);
  });

  it('"The transcript changed…" as a neutral notice, and the view stays at the top under it', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    const { body } = await renderView(server([page([you(3)], 'old'), page([you(7), you(8)], 'new')], [status(410)]));
    // Opened at the newest entry; the reader scrolls to the top for Load earlier.
    expect(body.scrollTop).toBe(1000);
    body.scrollTop = 0;
    fireEvent.scroll(body);
    await act(async () => fireEvent.click(within(body).getByRole('button', { name: 'Load earlier' })));
    const [notice] = alerts(body);
    expect(notice?.className).toContain('neutral');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.textContent).toBe('The transcript changed, so this starts again from its newest messages.');
    expect(texts(body)).toEqual(['prompt 7', 'prompt 8']);
    expect(body.scrollTop).toBe(0);
    // Above Load earlier, which carries on from the new page.
    const load = within(body).getByRole('button', { name: 'Load earlier' });
    expect(notice!.compareDocumentPosition(load) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps "The transcript changed…" while the entries it starts are shown, across refreshes and Load earlier, and drops it once they are replaced (W31)', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    const changed = 'The transcript changed, so this starts again from its newest messages.';
    const notice = (body: HTMLElement) => alerts(body).find((alert) => alert.textContent === changed);
    const view = await renderView(
      server(
        // The first page, the newest after the stale cursor, a refresh that overlaps it, then one that doesn't.
        [page([you(3)], 'old'), page([you(7), you(8)], 'new'), page([you(7), you(8), you(9)], 'new'), page([you(50), you(51)], 'later')],
        [status(410), page([you(5), you(6)])],
      ),
    );
    view.body.scrollTop = 0;
    fireEvent.scroll(view.body);
    await act(async () => fireEvent.click(within(view.body).getByRole('button', { name: 'Load earlier' })));
    expect(notice(view.body)).toBeTruthy();

    // A refresh that adds to what's shown keeps it.
    await view.refresh();
    expect(texts(view.body)).toEqual(['prompt 7', 'prompt 8', 'prompt 9']);
    expect(notice(view.body)).toBeTruthy();
    // So does Load earlier that works, from the new page's cursor.
    await act(async () => fireEvent.click(within(view.body).getByRole('button', { name: 'Load earlier' })));
    expect(texts(view.body)).toEqual(['prompt 5', 'prompt 6', 'prompt 7', 'prompt 8', 'prompt 9']);
    expect(notice(view.body)).toBeTruthy();

    // A newest page that replaces them, at the bottom, starts afresh: the notice goes.
    view.body.scrollTop = 600;
    fireEvent.scroll(view.body);
    await view.refresh();
    expect(texts(view.body)).toEqual(['prompt 50', 'prompt 51']);
    expect(notice(view.body)).toBeUndefined();
  });

  it('a refresh that fails keeps the entries, and says at the end that they may be out of date, with Try again', async () => {
    const retried = gate(page([you(1), you(2)]));
    const view = await renderView(server([page([you(1)]), status(500), retried.answer]));
    await view.refresh();
    expect(texts(view.body)).toEqual(['prompt 1']);
    const [alert] = alerts(view.body);
    expect(alert?.className).toContain('warning');
    expect(alert?.className).toContain('end');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.querySelector('.inline-alert-body')?.textContent).toBe("Couldn't refresh the conversation (HTTP 500), so it may be out of date.");
    // After the entries.
    const list = view.body.querySelector('.conversation')!;
    expect(list.compareDocumentPosition(alert!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(tryAgain(alert!));
    expect(tryAgain(alert!).getAttribute('aria-busy')).toBe('true');
    expect(texts(view.body)).toEqual(['prompt 1']);
    await retried.open();
    expect(alerts(view.body)).toEqual([]);
    expect(texts(view.body)).toEqual(['prompt 1', 'prompt 2']);
  });

  it('a later refresh that works clears it too, without Try again', async () => {
    const view = await renderView(server([page([you(1)]), status(502), page([you(1), you(2)])]));
    await view.refresh();
    expect(alerts(view.body)).toHaveLength(1);
    await view.refresh();
    expect(alerts(view.body)).toEqual([]);
    expect(texts(view.body)).toEqual(['prompt 1', 'prompt 2']);
  });

  it('a refresh that finds no transcript keeps the entries, with a neutral notice at the end', async () => {
    const view = await renderView(server([page([you(1)]), status(404)]));
    await view.refresh();
    expect(texts(view.body)).toEqual(['prompt 1']);
    const [notice] = alerts(view.body);
    expect(notice?.className).toContain('neutral');
    expect(notice?.textContent).toBe('The transcript is no longer available, so this is what it showed last.');
  });
});
