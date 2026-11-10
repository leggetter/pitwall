// The Usage view (W158): its place in the URL, reading the server's answer, its words and numbers, the
// dialog's figures, and the header's button in the app. Made-up figures, sessions and paths only.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { USAGE_PATH, type UsageTokens, type UsageView } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { group, session, snapshot } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { asUsageView, costText, parseUsage, tokenText, withUsage } from '../usage.js';
import { Dashboard } from './Dashboard.js';
import { UsageDialog } from './UsageDialog.js';

const tokens = (cost: number, extra: Partial<UsageTokens> = {}): UsageTokens => ({ calls: 10, input: 1200, cacheWrite: 34_000, cacheRead: 2_500_000, output: 5600, cost, ...extra });
const NAMED = '00000000-0000-4000-8000-0000000000a1';
const GONE = '00000000-0000-4000-8000-0000000000a2';

function view(overrides: Partial<UsageView> = {}): UsageView {
  return {
    window: { key: 'week', since: '2026-11-06T14:00:00.000Z', until: '2026-11-10T12:00:00.000Z', from: 'reset', bucket: 'day' },
    plan: { status: 'available', readAt: '2026-11-10T11:59:00.000Z', sevenDay: { usedPercentage: 42.4, resetsAt: '2026-11-13T14:00:00.000Z' }, fiveHour: null },
    costLabel: "API list price, a stand-in: how your plan's usage limits weigh tokens isn't published",
    totals: tokens(12.5),
    buckets: [
      { start: '2026-11-09T00:00:00.000Z', ...tokens(10), history: true },
      { start: '2026-11-10T00:00:00.000Z', ...tokens(2.5) },
    ],
    byRepo: { rows: [{ repo: '~/work/demo-app', sessions: 2, ...tokens(9) }], rest: { count: 3, ...tokens(1) } },
    bySession: {
      rows: [
        { sessionId: NAMED, repo: '~/work/demo-app', kind: 'main', model: 'claude-opus-5-5', subagentRuns: 2, subagentCost: 1.25, ...tokens(8) },
        { sessionId: GONE, repo: "pitwall's own: recap", kind: 'pitwall', model: 'claude-haiku-5-5', subagentRuns: 0, subagentCost: 0, ...tokens(0.001) },
      ],
    },
    byModel: [{ model: 'claude-opus-5-5', ...tokens(12) }],
    split: { main: { sessions: 2, ...tokens(9) }, subagent: { runs: 2, ...tokens(3.5) } },
    history: { days: 1, ...tokens(2.5) },
    scan: { at: '2026-11-10T11:59:58.000Z', files: 42, unreadable: 0, malformed: 0 },
    ...overrides,
  };
}

function fakeFetch(answer: (url: string) => Response | Promise<Response> = () => new Response(JSON.stringify(view()), { status: 200 })) {
  return vi.fn<FetchLike>(async (url) => (url.startsWith(USAGE_PATH) ? answer(url) : new Response('{}', { status: 404 })));
}

function renderDialog(fetch = fakeFetch()) {
  const api = createApiClient({ apiKey: 'k'.repeat(43), fetch });
  const onClose = vi.fn();
  const result = render(
    <ApiContext.Provider value={api}>
      <UsageDialog onClose={onClose} sessions={[session({ sessionId: NAMED, name: 'pitwall-test-named' })]} />
    </ApiContext.Provider>,
  );
  return { ...result, fetch, onClose };
}

const table = (name: string) => within(screen.getByRole('region', { name })).getByRole('table');
const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((cell) => cell.textContent);

afterEach(() => {
  vi.useRealTimers();
});

describe('its place in the URL', () => {
  it('is ?usage, added last and taken off, every other parameter kept as written', () => {
    expect(parseUsage('?view=all&usage')).toBe(true);
    expect(parseUsage('?session=x')).toBe(false);
    expect(withUsage('?view=all&session=abc', true)).toBe('?view=all&session=abc&usage');
    expect(withUsage('', true)).toBe('?usage');
    expect(withUsage('?usage&view=all', false)).toBe('?view=all');
    expect(withUsage('?usage', false)).toBe('');
  });
});

describe('reading the answer, and its words', () => {
  it('takes an answer of the shape it reads, and nothing else', () => {
    expect(asUsageView(view())).toBeDefined();
    expect(asUsageView({ ...view(), totals: { ...tokens(1), cacheRead: -1 } })).toBeUndefined();
    expect(asUsageView({ ...view(), window: { ...view().window, key: '365d' } })).toBeUndefined();
    expect(asUsageView({ ...view(), bySession: { rows: [{ ...tokens(1) }] } })).toBeUndefined();
    expect(asUsageView('nope')).toBeUndefined();
  });

  it('says tokens short and cost as an amount', () => {
    expect([tokenText(512), tokenText(999.6), tokenText(34_500), tokenText(120_400), tokenText(999_960), tokenText(1_250_000), tokenText(3_400_000_000), tokenText(12_000)]).toEqual([
      '512',
      '1.0K',
      '34.5K',
      '120K',
      '1.0M',
      '1.3M',
      '3.4B',
      '12.0K',
    ]);
    expect([costText(0), costText(0.001), costText(0.04), costText(12.345), costText(1234.5)]).toEqual(['$0', 'under $0.01', '$0.04', '$12.35', '$1,235']);
  });
});

describe('the dialog', () => {
  it('shows the plan’s week, the totals with cache reads and writes apart, and every breakdown, cost as an estimate', async () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Usage' });
    await within(dialog).findByText('42% used');
    expect(within(dialog).getByText(/^Resets /)).toBeTruthy();
    expect(dialog.textContent).toContain("Est. cost: API list price, a stand-in");
    expect(within(table('By day')).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Day', 'Est. cost', 'Input', 'Cache writes', 'Cache reads', 'Output']);
    const [kept] = within(table('By day')).getAllByRole('row').slice(1);
    expect(kept?.textContent).toContain('(kept total)');
    expect(cells(kept!)).toEqual(['$10.00', '1.2K', '34.0K', '2.5M', '5.6K']);
    expect(table('By day').querySelector('caption')?.textContent).toBe('By day');
    // The repo table has the rows left out summed, and the kept days' note.
    const repoRows = within(table('By repo')).getAllByRole('row');
    expect(repoRows.at(-1)?.textContent).toContain('3 more repos');
    expect(screen.getAllByText(/on 1 day whose transcripts Claude Code has deleted/)).toHaveLength(2);
    // A session by its name when it's listed, pitwall's own call by what it is.
    const sessionRows = within(table('By session')).getAllByRole('row').slice(1);
    // The row's header is the session's name alone; its details are a cell.
    expect(within(sessionRows[0]!).getByRole('rowheader').textContent).toBe('pitwall-test-named');
    expect(sessionRows[0]?.textContent).toContain('pitwall-test-named');
    expect(sessionRows[0]?.textContent).toContain('Opus 5.5');
    expect(sessionRows[0]?.textContent).toContain('sub-agents $1.25');
    expect(sessionRows[1]?.textContent).toContain("pitwall's own");
    expect(within(table('Main sessions and sub-agents')).getAllByRole('row')[2]?.textContent).toContain('Sub-agents (2 runs)');
    expect(within(table('By model')).getAllByRole('row')[1]?.textContent).toContain('Opus 5.5');
    expect(dialog.textContent).toContain('from 42 transcripts');
  });

  it('opens on This week, and a window tab asks for that window', async () => {
    const { fetch } = renderDialog();
    await screen.findByText('42% used');
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([`${USAGE_PATH}?window=week`]);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['This week', '24 hours', '14 days', '30 days']);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.click(tabs[3]!);
    await waitFor(() => expect(fetch.mock.calls.map(([url]) => url)).toContain(`${USAGE_PATH}?window=30d`));
    expect(screen.getAllByRole('tab')[3]?.getAttribute('aria-selected')).toBe('true');
    // Refresh asks again for the open window.
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === `${USAGE_PATH}?window=30d`)).toHaveLength(2));
  });

  it('says the plan’s week is unavailable, and why, and a failed read as an alert', async () => {
    const fetch = fakeFetch(() => new Response(JSON.stringify(view({ plan: { status: 'unavailable', readAt: '2026-11-10T11:59:00.000Z', reason: 'no-report' } })), { status: 200 }));
    renderDialog(fetch);
    await screen.findByText('Unavailable');
    expect(screen.getByRole('dialog').textContent).toContain('gave no plan figures');
    expect(screen.getByRole('dialog').querySelector('code')?.textContent).toBe('/usage');

    const failing = fakeFetch(() => new Response('{}', { status: 500 }));
    const second = renderDialog(failing);
    expect((await within(second.container.ownerDocument.body).findAllByRole('alert')).at(-1)?.textContent).toBe("Couldn't read your usage (HTTP 500).");
  });
});

describe('loading, refusing and switching', () => {
  it('says it’s loading, as a status, and a 429 as a wait', async () => {
    let answer: (response: Response) => void = () => {};
    const fetch = fakeFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
    renderDialog(fetch);
    expect(screen.getByRole('status').textContent).toContain('Loading this week…');
    await act(async () => answer(new Response('{}', { status: 429, headers: { 'Retry-After': '2' } })));
    expect(screen.getByRole('alert').textContent).toBe('pitwall is still reading your transcripts. Try again in 2 seconds.');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('never shows one window’s figures under another’s tab, loading or failed', async () => {
    const answers: Array<(response: Response) => void> = [];
    const fetch = fakeFetch(() => new Promise<Response>((resolve) => answers.push(resolve)));
    renderDialog(fetch);
    await act(async () => answers[0]!(new Response(JSON.stringify(view()), { status: 200 })));
    expect(screen.getByText('42% used')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('tab')[1]!);
    await waitFor(() => expect(answers).toHaveLength(2));
    expect(screen.queryByText('42% used')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Loading 24 hours…');
    await act(async () => answers[1]!(new Response('{}', { status: 500 })));
    expect(screen.getByRole('alert').textContent).toBe("Couldn't read your usage (HTTP 500).");
    expect(screen.queryByRole('table')).toBeNull();
    // A refresh of the same window keeps its figures while it loads.
    fireEvent.click(screen.getAllByRole('tab')[0]!);
    await waitFor(() => expect(answers).toHaveLength(3));
    await act(async () => answers[2]!(new Response(JSON.stringify(view()), { status: 200 })));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(answers).toHaveLength(4));
    expect(screen.getByText('42% used')).toBeTruthy();
  });

  it('says a window with no calls has none, rather than tables of zeros', async () => {
    const zero = { calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 };
    const empty = view({ totals: zero, buckets: [], byRepo: { rows: [] }, bySession: { rows: [] }, byModel: [], split: { main: { sessions: 0, ...zero }, subagent: { runs: 0, ...zero } } });
    delete empty.history;
    renderDialog(fakeFetch(() => new Response(JSON.stringify(empty), { status: 200 })));
    expect(await screen.findByText('No calls in this window.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('42% used')).toBeTruthy();
  });
});

describe('in the app', () => {
  it('opens from the header’s Usage button as ?usage, and Escape closes it, focus back on the button', async () => {
    const history = fakeHistory('?view=all');
    const fetch = fakeFetch();
    const api = createApiClient({ apiKey: 'k'.repeat(43), fetch });
    const snap = snapshot([group({ sessions: [session({ sessionId: NAMED, name: 'pitwall-test-named' })] })]);
    render(
      <ApiContext.Provider value={api}>
        <Dashboard view={{ state: 'live', snapshot: snap }} navigation={history.navigation} />
      </ApiContext.Provider>,
    );
    expect(fetch.mock.calls.filter(([url]) => url.startsWith(USAGE_PATH))).toHaveLength(0);
    const button = screen.getByRole('button', { name: 'Usage' });
    act(() => button.focus());
    fireEvent.click(button);
    expect(history.location.search).toBe('?view=all&usage');
    const dialog = screen.getByRole('dialog', { name: 'Usage' });
    await within(dialog).findByText('42% used');
    expect(within(table('By session')).getAllByRole('row')[1]?.textContent).toContain('pitwall-test-named');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Usage' })).toBeNull();
    expect(history.location.search).toBe('?view=all');
    expect(document.activeElement).toBe(button);
    // Back opens it again, as the URL says.
    history.back();
    expect(screen.getByRole('dialog', { name: 'Usage' })).toBeTruthy();
  });

  it('opens from a URL with ?usage', async () => {
    const history = fakeHistory('?view=all&usage');
    const api = createApiClient({ apiKey: 'k'.repeat(43), fetch: fakeFetch() });
    render(
      <ApiContext.Provider value={api}>
        <Dashboard view={{ state: 'live', snapshot: snapshot([group({ sessions: [session()] })]) }} navigation={history.navigation} />
      </ApiContext.Provider>,
    );
    expect(await screen.findByText('42% used')).toBeTruthy();
  });
});
