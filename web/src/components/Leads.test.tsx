// Leads and workers in the page (W218, docs/design-system.md, 4: Leads and workers): a lead's row with
// "Lead", its count and its caret; its workers indented under it, one from another repo named; the caret
// closing them, with the most urgent state on the lead's row, remembered in pitwall.leads.v1 through a
// reload; the pointer in a worker's own repo group; "under <lead>" in Needs you; the session view's
// menu items, their requests and a 409's words; Report to…'s dialog; Start a worker…'s New session; and
// a worker's "worker for <lead>" header. Made-up sessions only.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { leadBriefPath, relayPath, SPAWN_PATH, workerBriefPath, workerStartedPath, type IndexSnapshot, type PullRequestList } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import type { StorageSource } from '../groupState.js';
import { BRIEF_LABEL, BRIEF_WITHOUT, LEADS_STORAGE_KEY, MAKE_LEAD, NOT_A_LEAD, NOT_A_WORKER, REPORT_TO, reportedLinkLabel, START_WORKER } from '../leads.js';
import { memoryNavigation } from '../selection.js';
import { createShortcutsStore, ShortcutsStoreContext } from '../shortcuts.js';
import { group, minutesAgo, NOW, pr, prLink, prList, session, snapshot } from '../test/fixtures.js';
import { toastMessages } from '../test/toasts.js';
import { Dashboard } from './Dashboard.js';
import { REPORT_TO_CONFIRM, REPORT_TO_TITLE, TELL_WORKER_COPY, TELL_WORKER_NOT_NOW, TELL_WORKER_SEND, TELL_WORKER_TITLE } from './ReportToDialog.js';
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
const id = (n: number) => `00000000-0000-4000-8000-0000002181${String(n).padStart(2, '0')}`;

/** A lead in app with a worker in app and one in docs that needs you; a plain session; a lead you marked in docs. */
function snap(): IndexSnapshot {
  const lead = session({ sessionId: id(1), name: 'design', cwd: `${ROOT}/app`, lastActivityAt: minutesAgo(2), lead: { workers: [id(2), id(3)] } });
  const spike = session({ sessionId: id(2), name: 'spike', cwd: `${ROOT}/app`, lastActivityAt: minutesAgo(5), workerOf: { lead: id(1), how: 'started' } });
  const fix = session({ sessionId: id(3), name: 'docs fix', cwd: `${ROOT}/docs`, status: 'waiting', waitingFor: 'permission prompt', lastActivityAt: minutesAgo(1), workerOf: { lead: id(1), how: 'reported' } });
  const notes = session({ sessionId: id(4), name: 'notes', cwd: `${ROOT}/app`, lastActivityAt: minutesAgo(3) });
  const marked = session({ sessionId: id(5), name: 'planner', cwd: `${ROOT}/docs`, lastActivityAt: minutesAgo(4), lead: { workers: [], marked: true } });
  return snapshot([
    group({ key: `${ROOT}/app`, label: 'app', sessions: [lead, spike, notes] }),
    group({ key: `${ROOT}/docs`, label: 'docs', sessions: [fix, marked] }),
  ]);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeServer(answer: { status: number; body: unknown } = { status: 200, body: { ok: true } }) {
  return vi.fn<FetchLike>(async (_url, init) => (init.method === 'POST' ? json(answer.status, answer.body) : json(200, { entries: [] })));
}

const posts = (fetch: { mock: { calls: Parameters<FetchLike>[] } }) => fetch.mock.calls.filter(([, init]) => init.method === 'POST').map(([url, init]) => [url, JSON.parse(String(init.body))]);

function memory(initial: Record<string, string> = {}) {
  const items = new Map<string, string>(Object.entries(initial));
  const source: StorageSource = () => ({ getItem: (name) => items.get(name) ?? null, setItem: (name, value) => void items.set(name, value) });
  return { items, source };
}

function renderDashboard(search: string, options: { fetch?: Mock<FetchLike>; storage?: ReturnType<typeof memory>; snapshot?: IndexSnapshot; prs?: PullRequestList } = {}) {
  const fetch = options.fetch ?? fakeServer();
  const store = options.storage ?? memory();
  const api = createApiClient({ apiKey: 'pitwall-test-key', fetch });
  const shortcuts = createShortcutsStore({ storage: memory().source, events: { addEventListener: () => {} } });
  const result = render(
    <ApiContext.Provider value={api}>
      <ShortcutsStoreContext.Provider value={shortcuts}>
        <Dashboard view={{ state: 'live', snapshot: options.snapshot ?? snap(), ...(options.prs ? { prs: options.prs } : {}) }} navigation={memoryNavigation(search)} storage={store.source} />
      </ShortcutsStoreContext.Provider>
    </ApiContext.Provider>,
  );
  return { ...result, fetch, store };
}

const settle = () => act(async () => {});
const main = () => screen.getByRole('main');
const row = (name: string) => within(main()).getByRole('button', { name }).closest('li.session') as HTMLElement;
const caret = (name: string) => within(main()).getByRole('button', { name: `Workers of ${name}` });
const workersList = () => main().querySelector<HTMLElement>('ul.lead-workers');
const view = () => document.getElementById('session-view') ?? undefined;
const menuLabels = () => {
  fireEvent.click(within(view()!).getByRole('button', { name: 'Session actions' }));
  const labels = screen.getAllByRole('menuitem').map((item) => item.textContent ?? '');
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  return labels;
};
const choose = (label: string) => {
  fireEvent.click(within(view()!).getByRole('button', { name: 'Session actions' }));
  fireEvent.click(screen.getByRole('menuitem', { name: label }));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('the list', () => {
  it("shows a lead's row with Lead and its count, and its workers under it, the one from docs named", async () => {
    renderDashboard(`?repo=${ROOT}/app`);
    await settle();
    const lead = row('design');
    expect(lead.querySelector('.session-lead-badge')?.textContent).toBe('Lead');
    expect(lead.querySelector('.session-lead-workers')?.textContent).toBe('2 workers');
    expect(caret('design').getAttribute('aria-expanded')).toBe('true');
    expect(caret('design').getAttribute('aria-controls')).toBe(workersList()?.id);
    const workers = within(workersList()!).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(workers).toEqual(['spike', 'docs fix']);
    expect(row('docs fix').querySelector('.session-group')?.textContent).toBe('docs');
    expect(row('spike').querySelector('.session-group')).toBeNull();
    // Not also a row of its own.
    expect(within(main()).getAllByRole('button', { name: 'spike' })).toHaveLength(1);
  });

  it('closes and opens the workers from the caret, says what needs you while closed, and remembers it through a reload', async () => {
    const storage = memory();
    const first = renderDashboard(`?repo=${ROOT}/app`, { storage });
    await settle();
    fireEvent.click(caret('design'));
    expect(caret('design').getAttribute('aria-expanded')).toBe('false');
    expect(workersList()?.hidden).toBe(true);
    expect(row('design').querySelector('.session-lead-workers')?.textContent).toBe('2 workers, 1 needs you');
    expect(JSON.parse(storage.items.get(LEADS_STORAGE_KEY) ?? '{}')).toEqual({ v: 1, closed: [id(1)] });
    first.unmount();
    renderDashboard(`?repo=${ROOT}/app`, { storage });
    await settle();
    expect(caret('design').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(caret('design'));
    expect(workersList()?.hidden).toBe(false);
    expect(JSON.parse(storage.items.get(LEADS_STORAGE_KEY) ?? '{}')).toEqual({ v: 1, closed: [] });
  });

  it('renders every lead open when storage throws', async () => {
    const throwing = memory();
    throwing.source = () => {
      throw new Error('blocked');
    };
    renderDashboard(`?repo=${ROOT}/app`, { storage: throwing });
    await settle();
    expect(caret('design').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(caret('design'));
    expect(caret('design').getAttribute('aria-expanded')).toBe('false');
  });

  it("leaves a pointer in the worker's own repo group, and a lead you marked says No workers, with no caret", async () => {
    renderDashboard(`?repo=${ROOT}/docs`);
    await settle();
    const pointer = main().querySelector('[data-lead-pointer]');
    expect(pointer?.textContent).toBe('docs fix↳ under design (app)');
    expect(row('planner').querySelector('.session-lead-workers')?.textContent).toBe('No workers');
    expect(within(main()).queryByRole('button', { name: 'Workers of planner' })).toBeNull();
  });

  it("keeps a finished lead in its repo's current rows when its finished worker in another repo owns an open PR (the fix check's N1)", async () => {
    const open = pr({ number: 21, repoLabel: 'example/docs' });
    const lead = session({ sessionId: id(1), name: 'design', cwd: `${ROOT}/app`, finished: true, alive: false, lastActivityAt: minutesAgo(20), lead: { workers: [id(3)] } });
    const fix = session({ sessionId: id(3), name: 'docs fix', cwd: `${ROOT}/docs`, finished: true, alive: false, lastActivityAt: minutesAgo(10), workerOf: { lead: id(1), how: 'reported' }, prLinks: [prLink('opened', open, 10)] });
    const notes = session({ sessionId: id(4), name: 'notes', cwd: `${ROOT}/app`, lastActivityAt: minutesAgo(3) });
    const s = snapshot([group({ key: `${ROOT}/app`, label: 'app', sessions: [lead, notes] }), group({ key: `${ROOT}/docs`, label: 'docs', sessions: [fix] })]);
    renderDashboard(`?repo=${ROOT}/app`, { snapshot: s, prs: prList([open]) });
    await settle();
    // Not folded into the collapsed Finished section: the lead and its worker are rows you can see.
    expect(row('design').closest('[hidden]')).toBeNull();
    expect(within(workersList()!).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['docs fix']);
    expect(main().querySelector('.finished-toggle')).toBeNull();
  });

  it('says which lead a worker is under in Needs you', async () => {
    renderDashboard('?view=needs-you');
    await settle();
    expect(row('docs fix').querySelector('.session-group')?.textContent).toBe('docs · under design');
    expect(main().querySelector('[data-lead-pointer]')).toBeNull();
  });

  it('has no pointers in All sessions', async () => {
    renderDashboard('?view=all');
    await settle();
    expect(main().querySelector('[data-lead-pointer]')).toBeNull();
    expect(within(workersList()!).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['spike', 'docs fix']);
  });
});

describe('the session view', () => {
  it("says which lead a worker works for, a link to the lead's view", async () => {
    renderDashboard(`?repo=${ROOT}/app&session=${id(2)}`);
    await settle();
    const line = view()!.querySelector('[data-worker-for]');
    expect(line?.textContent).toBe('worker for design');
    fireEvent.click(within(line as HTMLElement).getByRole('button', { name: 'design' }));
    await settle();
    expect(view()?.querySelector('.session-view-name')?.textContent).toBe('design');
  });

  it('offers each kind of session its items', async () => {
    renderDashboard(`?repo=${ROOT}/app&session=${id(1)}`);
    await settle();
    expect(menuLabels()).toEqual(expect.arrayContaining([START_WORKER, NOT_A_LEAD]));
    expect(menuLabels()).not.toContain(MAKE_LEAD);
  });

  it('Make lead posts { on: true } and says so; Not a worker posts { lead: null }', async () => {
    const { fetch } = renderDashboard(`?repo=${ROOT}/app&session=${id(4)}`);
    await settle();
    expect(menuLabels()).toEqual(expect.arrayContaining([MAKE_LEAD, REPORT_TO]));
    choose(MAKE_LEAD);
    await settle();
    expect(posts(fetch)).toEqual([[`/api/sessions/${id(4)}/lead`, { on: true }]]);
    expect(toastMessages()).toContain('notes is a lead.');
  });

  it("shows a 409's error as it is", async () => {
    const fetch = fakeServer({ status: 409, body: { ok: false, error: 'It’s a lead itself. Choose Not a lead on it first.' } });
    renderDashboard(`?repo=${ROOT}/app&session=${id(2)}`, { fetch });
    await settle();
    choose(NOT_A_WORKER);
    await settle();
    expect(posts(fetch)).toEqual([[`/api/sessions/${id(2)}/worker`, { lead: null }]]);
    expect(toastMessages()).toContain('It’s a lead itself. Choose Not a lead on it first.');
  });

  it('Report to… lists the leads in a radio group and posts the one picked; a refusal shows in the dialog', async () => {
    const fetch = fakeServer({ status: 409, body: { ok: false, error: 'That lead isn’t in pitwall’s list.' } });
    renderDashboard(`?repo=${ROOT}/app&session=${id(4)}`, { fetch });
    await settle();
    choose(REPORT_TO);
    await settle();
    const dialog = screen.getByRole('dialog', { name: REPORT_TO_TITLE });
    const radios = within(dialog).getAllByRole('radio');
    expect(radios.map((radio) => radio.closest('.radio-option')?.querySelector('label')?.textContent)).toEqual(['design', 'planner']);
    fireEvent.click(radios[1]!);
    fireEvent.click(within(dialog).getByRole('button', { name: REPORT_TO_CONFIRM }));
    await settle();
    expect(posts(fetch)).toEqual([[`/api/sessions/${id(4)}/worker`, { lead: id(5) }]]);
    expect(within(dialog).getByRole('alert').textContent).toBe('That lead isn’t in pitwall’s list.');
  });

  it('Start a worker… opens New session for the lead', async () => {
    renderDashboard(`?repo=${ROOT}/app&session=${id(1)}`);
    await settle();
    choose(START_WORKER);
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'New session' });
    expect(dialog.textContent).toContain('For: design');
  });

  it("starting it tells the server which job is the lead's worker", async () => {
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      if (init.method !== 'POST') return json(200, { entries: [] });
      if (url === SPAWN_PATH) return json(201, { ok: true, shortId: 'a1b2c3d4', name: 'helper' });
      return json(200, { ok: true });
    });
    renderDashboard(`?repo=${ROOT}/app&session=${id(1)}`, { fetch });
    await settle();
    choose(START_WORKER);
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: 'A made-up task for the worker' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(posts(fetch).some(([url]) => url === workerStartedPath(id(1)))).toBe(true));
    expect(posts(fetch).find(([url]) => url === workerStartedPath(id(1)))).toEqual([workerStartedPath(id(1)), { shortId: 'a1b2c3d4' }]);
  });
});

// W218 piece 2: the paragraph a worker is given about its lead, and its reports. Made-up text only.
const BRIEF = 'A made-up paragraph: you work for the lead named design. Report to it with SendMessage.';
type Answer = { status: number; body: unknown };
const briefOk: Answer = { status: 200, body: { ok: true, leadId: id(1), leadName: 'design', text: BRIEF } };

/** A server that answers the two paragraph GETs, the relay and the spawn, and { ok: true } to other POSTs. */
function briefServer(answers: { brief?: Answer; relay?: Answer; post?: Answer } = {}) {
  return vi.fn<FetchLike>(async (url, init) => {
    const brief = answers.brief ?? briefOk;
    if (init.method !== 'POST') return url.endsWith('/lead-brief') || url.endsWith('/worker-brief') ? json(brief.status, brief.body) : json(200, { entries: [] });
    if (url === SPAWN_PATH) return json(201, { ok: true, shortId: 'a1b2c3d4', name: 'helper' });
    if (url.endsWith('/relay')) return json(answers.relay?.status ?? 200, answers.relay?.body ?? { status: 'delivered' });
    return json(answers.post?.status ?? 200, answers.post?.body ?? { ok: true });
  });
}

const gets = (fetch: { mock: { calls: Parameters<FetchLike>[] } }) => fetch.mock.calls.filter(([, init]) => init.method !== 'POST').map(([url]) => url);

/** Report to… on notes, to design, through to the second step. */
async function reportNotes(options: { fetch: Mock<FetchLike>; snapshot?: IndexSnapshot }) {
  renderDashboard(`?repo=${ROOT}/app&session=${id(4)}`, options);
  await settle();
  choose(REPORT_TO);
  await settle();
  const first = screen.getByRole('dialog', { name: REPORT_TO_TITLE });
  fireEvent.click(within(first).getByRole('button', { name: REPORT_TO_CONFIRM }));
  return screen.findByRole('dialog', { name: TELL_WORKER_TITLE });
}

/** The snapshot, with notes as a running background session. */
function snapWithBackgroundNotes(): IndexSnapshot {
  const base = snap();
  return { ...base, groups: base.groups.map((g) => ({ ...g, sessions: g.sessions.map((s) => (s.sessionId === id(4) ? { ...s, kind: 'background' as const, shortId: 'bg218a' } : s)) })) };
}

describe("the worker's paragraph (W218 piece 2)", () => {
  it('Start a worker… shows the paragraph above the fields and sends the lead with the prompt, never the text', async () => {
    const fetch = briefServer();
    renderDashboard(`?repo=${ROOT}/app&session=${id(1)}`, { fetch });
    await settle();
    choose(START_WORKER);
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    await waitFor(() => expect(dialog.querySelector('[data-worker-brief="ok"]')).not.toBeNull());
    expect(gets(fetch)).toContain(leadBriefPath(id(1)));
    const notice = dialog.querySelector('[data-worker-brief="ok"]')!;
    expect(notice.textContent).toContain(BRIEF_LABEL);
    expect(notice.querySelector('.worker-brief-text')?.textContent).toBe(BRIEF);
    fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: 'A made-up task for the worker' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(posts(fetch).some(([url]) => url === SPAWN_PATH)).toBe(true));
    const [, body] = posts(fetch).find(([url]) => url === SPAWN_PATH)!;
    expect(body.lead).toBe(id(1));
    expect(JSON.stringify(body)).not.toContain('Report to it');
  });

  it("Start a worker… says why there's no paragraph after a refusal, and starts the worker without a lead", async () => {
    const fetch = briefServer({ brief: { status: 409, body: { ok: false, error: 'Another running session is named design.' } } });
    renderDashboard(`?repo=${ROOT}/app&session=${id(1)}`, { fetch });
    await settle();
    choose(START_WORKER);
    const dialog = await screen.findByRole('dialog', { name: 'New session' });
    await waitFor(() => expect(dialog.querySelector('[data-worker-brief="refused"]')).not.toBeNull());
    expect(dialog.querySelector('[data-worker-brief="refused"]')?.textContent).toContain(`Another running session is named design. ${BRIEF_WITHOUT}`);
    fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: 'A made-up task for the worker' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await waitFor(() => expect(posts(fetch).some(([url]) => url === SPAWN_PATH)).toBe(true));
    expect(posts(fetch).find(([url]) => url === SPAWN_PATH)![1]).not.toHaveProperty('lead');
  });

  it("Report to…'s second step sends the server's paragraph through the relay only on Send", async () => {
    const fetch = briefServer();
    const dialog = await reportNotes({ fetch });
    await waitFor(() => expect(dialog.querySelector('.worker-brief-text')?.textContent).toBe(BRIEF));
    expect(gets(fetch)).toContain(workerBriefPath(id(4)));
    expect(posts(fetch).map(([url]) => url)).toEqual([`/api/sessions/${id(4)}/worker`]);
    expect(within(dialog).queryByRole('button', { name: TELL_WORKER_COPY })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: TELL_WORKER_SEND }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: TELL_WORKER_TITLE })).toBeNull());
    expect(posts(fetch)).toEqual([
      [`/api/sessions/${id(4)}/worker`, { lead: id(1) }],
      [relayPath(id(4)), { text: BRIEF }],
    ]);
    expect(toastMessages()).toContain('Sent to notes.');
  });

  it('Not now closes the second step and sends nothing', async () => {
    const fetch = briefServer();
    const dialog = await reportNotes({ fetch });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: TELL_WORKER_SEND })).toBeTruthy());
    fireEvent.click(within(dialog).getByRole('button', { name: TELL_WORKER_NOT_NOW }));
    await settle();
    expect(screen.queryByRole('dialog', { name: TELL_WORKER_TITLE })).toBeNull();
    expect(posts(fetch).map(([url]) => url)).toEqual([`/api/sessions/${id(4)}/worker`]);
  });

  it('a background session gets the text and Copy message, with no Send', async () => {
    const fetch = briefServer();
    const dialog = await reportNotes({ fetch, snapshot: snapWithBackgroundNotes() });
    await waitFor(() => expect(dialog.querySelector('.worker-brief-text')?.textContent).toBe(BRIEF));
    expect(dialog.textContent).toContain('background session, which takes messages only in its terminal');
    expect(within(dialog).getByRole('button', { name: TELL_WORKER_COPY })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: TELL_WORKER_SEND })).toBeNull();
    expect(posts(fetch).some(([url]) => url === relayPath(id(4)))).toBe(false);
  });

  it("shows the server's refusal as it is, with nothing to send", async () => {
    const fetch = briefServer({ brief: { status: 409, body: { ok: false, error: 'pitwall can’t name the lead it reports to.' } } });
    const dialog = await reportNotes({ fetch });
    await waitFor(() => expect(dialog.querySelector('.tell-worker-refused')).not.toBeNull());
    expect(dialog.querySelector('.tell-worker-refused')?.textContent).toBe('pitwall can’t name the lead it reports to.');
    expect(within(dialog).queryByRole('button', { name: TELL_WORKER_SEND })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeTruthy();
  });

  it('a relay that fails says so in the dialog and keeps Send', async () => {
    const fetch = briefServer({ relay: { status: 200, body: { status: 'failed', detail: 'The made-up socket closed.' } } });
    const dialog = await reportNotes({ fetch });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: TELL_WORKER_SEND })).toBeTruthy());
    fireEvent.click(within(dialog).getByRole('button', { name: TELL_WORKER_SEND }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('Not sent. The made-up socket closed.'));
    expect(within(dialog).getByRole('button', { name: TELL_WORKER_SEND })).toBeTruthy();
  });
});

describe("a worker's reports (W218 piece 2)", () => {
  const reportedAt = minutesAgo(7);
  function snapReported(): IndexSnapshot {
    const base = snap();
    return { ...base, groups: base.groups.map((g) => ({ ...g, sessions: g.sessions.map((s) => (s.sessionId === id(2) ? { ...s, workerOf: { lead: id(1), how: 'started' as const, reportedAt } } : s)) })) };
  }

  it("shows reported HH:MM on the worker's row, and none on a worker that hasn't reported", async () => {
    renderDashboard(`?repo=${ROOT}/app`, { snapshot: snapReported() });
    await settle();
    const link = row('spike').querySelector<HTMLElement>(`[data-reported="${id(2)}"]`)!;
    expect(link.textContent).toMatch(/^reported \d{1,2}:\d{2}/);
    expect(link.querySelector('time')?.getAttribute('dateTime')).toBe(reportedAt);
    expect(link.getAttribute('aria-label')).toBe(reportedLinkLabel(link.querySelector('time')!.textContent!));
    expect(main().querySelector(`[data-reported="${id(3)}"]`)).toBeNull();
  });

  it('opens the worker on its Conversation tab', async () => {
    renderDashboard(`?repo=${ROOT}/app`, { snapshot: snapReported() });
    await settle();
    fireEvent.click(row('spike').querySelector<HTMLElement>(`[data-reported="${id(2)}"]`)!);
    await settle();
    expect(view()?.querySelector('.session-view-name')?.textContent).toBe('spike');
    expect(within(view()!).getByRole('tab', { name: /Conversation/ }).getAttribute('aria-selected')).toBe('true');
  });
});
