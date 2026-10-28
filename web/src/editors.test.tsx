// Open in an editor (W72): the editor list, fetched once after authenticating; the request that
// opens a session's directory; the session view's actions menu with none, one and two editors; and
// the toasts. Made-up sessions only, and a fake fetch: nothing reaches a server or opens an editor.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EDITORS_PATH, openInEditorPath, PROTOCOL_VERSION, type Editor, type IndexSnapshot, type SessionSummary } from '../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from './api.js';
import { App } from './App.js';
import { Dashboard } from './components/Dashboard.js';
import type { ConnectionView } from './connection.js';
import { EditorsContext, openInEditor, openToast, parseEditorList } from './editors.js';
import { fakeSockets, group, NOW, session, snapshot, type FakeSocket } from './test/fixtures.js';
import { toastMessages, toastSaying } from './test/toasts.js';
import { descriptionOf } from './test/tooltips.js';
import { TOKEN_STORAGE_KEY } from './token.js';

const API_KEY = 'k'.repeat(43);
const BG = '00000000-0000-4000-8000-0000000000b1';
const INTERACTIVE = '00000000-0000-4000-8000-0000000000a1';
const ENDED = '00000000-0000-4000-8000-0000000000e1';
const GONE = '00000000-0000-4000-8000-0000000000c1';

const VSCODE: Editor = { id: 'vscode', label: 'VS Code' };
const CURSOR: Editor = { id: 'cursor', label: 'Cursor' };

const json = (status: number, body?: unknown) => new Response(body === undefined ? 'not json' : JSON.stringify(body), { status });

describe('parseEditorList', () => {
  it('keeps each known id once, in order, with its label', () => {
    expect(parseEditorList({ editors: [VSCODE, CURSOR] })).toEqual([VSCODE, CURSOR]);
    expect(parseEditorList({ editors: [] })).toEqual([]);
  });

  it("drops ids it doesn't know, repeats and labels that aren't short text", () => {
    const body = { editors: [{ id: 'vim', label: 'Vim' }, CURSOR, { id: 'cursor', label: 'Cursor again' }, { id: 'vscode', label: '' }, { id: 'vscode', label: 'x'.repeat(41) }, null, 'vscode'] };
    expect(parseEditorList(body)).toEqual([CURSOR]);
  });

  it("is undefined for an answer that isn't an EditorList", () => {
    for (const body of [null, [], 'editors', { editors: 'vscode' }, {}]) expect(parseEditorList(body), JSON.stringify(body)).toBeUndefined();
  });
});

describe('openInEditor', () => {
  const api = (fetch: FetchLike) => createApiClient({ apiKey: API_KEY, fetch });

  it('POSTs { editor } alone to openInEditorPath(), with the apiKey, and is opened on { ok: true }', async () => {
    const fetch = vi.fn<FetchLike>(async () => json(200, { ok: true }));
    expect(await openInEditor(api(fetch), BG, 'cursor')).toEqual({ kind: 'opened' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(openInEditorPath(BG));
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ editor: 'cursor' });
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("is refused with the server's words, or failed with the status when it gave none", async () => {
    const error = "Cursor didn't open. If it has moved, restart pitwall so it looks again.";
    expect(await openInEditor(api(async () => json(502, { ok: false, error })), BG, 'cursor')).toEqual({ kind: 'refused', error });
    expect(await openInEditor(api(async () => json(500)), BG, 'cursor')).toEqual({ kind: 'failed', status: 500 });
    expect(await openInEditor(api(async () => json(200, { ok: 'yes' })), BG, 'cursor')).toEqual({ kind: 'failed', status: 200 });
    expect(await openInEditor(api(async () => Promise.reject(new TypeError('offline'))), BG, 'cursor')).toEqual({ kind: 'failed' });
  });

  it("is refused with the server's words for a 429, which say when to try again, and keeps Retry-After when it gave none (W87)", async () => {
    const error = 'pitwall opens at most 10 directories in an editor every 60 seconds. Try again in 42s.';
    const limited = (body?: unknown) => async () => new Response(body === undefined ? 'not json' : JSON.stringify(body), { status: 429, headers: { 'Retry-After': '42' } });
    expect(await openInEditor(api(limited({ ok: false, error })), BG, 'cursor')).toEqual({ kind: 'refused', error });
    expect(await openInEditor(api(limited()), BG, 'cursor')).toEqual({ kind: 'failed', status: 429, retryAfter: 42 });
    expect(openToast('pitwall-test-bg', CURSOR, { kind: 'refused', error })).toEqual({ tone: 'error', message: `Couldn't open pitwall-test-bg's directory in Cursor. ${error}` });
    expect(openToast('pitwall-test-bg', CURSOR, { kind: 'failed', status: 429, retryAfter: 42 })).toEqual({
      tone: 'error',
      message: "Couldn't open pitwall-test-bg's directory in Cursor (HTTP 429). Try again in 42 seconds.",
    });
    expect(openToast('pitwall-test-bg', CURSOR, { kind: 'failed', status: 429, retryAfter: 1 })?.message).toBe("Couldn't open pitwall-test-bg's directory in Cursor (HTTP 429). Try again in 1 second.");
  });

  it('has a toast for each outcome, naming the session and the editor, and none for unauthorized', () => {
    expect(openToast('pitwall-test-bg', CURSOR, { kind: 'opened' })).toEqual({ tone: 'success', message: "Opened pitwall-test-bg's directory in Cursor." });
    expect(openToast('pitwall-test-bg', VSCODE, { kind: 'refused', error: 'Its directory, /tmp/x, no longer exists.' })).toEqual({
      tone: 'error',
      message: "Couldn't open pitwall-test-bg's directory in VS Code. Its directory, /tmp/x, no longer exists.",
    });
    expect(openToast('pitwall-test-bg', CURSOR, { kind: 'failed', status: 502 })).toEqual({ tone: 'error', message: "Couldn't open pitwall-test-bg's directory in Cursor (HTTP 502)." });
    expect(openToast('pitwall-test-bg', CURSOR, { kind: 'failed' })).toEqual({ tone: 'error', message: "Couldn't open pitwall-test-bg's directory in Cursor." });
    expect(openToast('pitwall-test-bg', CURSOR, { kind: 'unauthorized' })).toBeUndefined();
  });
});

describe('the app', () => {
  const KEY_A = 'a'.repeat(43);
  const KEY_B = 'b'.repeat(43);
  const nonce = (i: number) => `${'n'.repeat(41)}${String(i).padStart(2, '0')}`;

  async function handshake(socket: FakeSocket, apiKey: string, n: string) {
    act(() => {
      socket.open();
      socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: n });
    });
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    act(() => socket.receive({ type: 'authenticated', apiKey }));
  }

  it('GETs the editor list once it has authenticated, with the apiKey, and not again after a reconnect', async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, 'stored');
    const fetch = vi.fn<FetchLike>(async () => json(200, { editors: [CURSOR] }));
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} fetch={fetch} />);
    act(() => fake.last.open());
    await act(async () => {});
    expect(fetch).not.toHaveBeenCalled();

    await handshake(fake.last, KEY_A, nonce(1));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(EDITORS_PATH);
    expect(init.method).toBeUndefined();
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY_A}`);

    act(() => fake.last.serverClose(1001));
    await waitFor(() => expect(fake.sockets).toHaveLength(2), { timeout: 3_000 });
    await handshake(fake.last, KEY_B, nonce(2));
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------- the actions menu

function background(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return session({ sessionId: BG, name: 'pitwall-test-bg', kind: 'background', shortId: 'b3899da0', state: 'working', ...overrides });
}

function snap(sessions: SessionSummary[] = [background()]): IndexSnapshot {
  return snapshot([
    group({
      sessions: [
        ...sessions,
        session({ sessionId: INTERACTIVE, name: 'pitwall-test-interactive' }),
        session({ sessionId: ENDED, name: 'pitwall-test-ended', ended: true, finished: true, alive: false, pid: undefined, status: undefined }),
        background({ sessionId: GONE, name: 'pitwall-test-gone', shortId: 'c0ffee12', cwdMissing: true }),
      ],
    }),
  ]);
}

/** Opens get the next answer; the conversation gets an empty page. */
function fakeServer(...answers: Array<{ status: number; body?: unknown } | 'hold'>) {
  let call = 0;
  const held: Array<() => void> = [];
  const fetch = vi.fn<FetchLike>(async (url, init) => {
    if (init.method !== 'POST') {
      const sessionId = decodeURIComponent(/\/api\/sessions\/([^/]+)\//.exec(url)?.[1] ?? '');
      return json(200, { sessionId, entries: [] });
    }
    const answer = answers[Math.min(call, answers.length - 1)] ?? { status: 200, body: { ok: true } };
    call += 1;
    if (answer === 'hold') {
      await new Promise<void>((resolve) => held.push(resolve));
      return json(200, { ok: true });
    }
    return json(answer.status, answer.body);
  });
  return Object.assign(fetch, { held });
}

const posts = (fetch: ReturnType<typeof fakeServer>) => fetch.mock.calls.filter(([, init]) => init.method === 'POST').map(([url, init]) => [url, JSON.parse(String(init.body))]);

function renderDashboard(editors: readonly Editor[], fetch: FetchLike = fakeServer(), first: IndexSnapshot = snap()) {
  const api = createApiClient({ apiKey: API_KEY, fetch });
  const ui = (s: IndexSnapshot) => {
    const view: ConnectionView = { state: 'live', snapshot: s };
    return (
      <ApiContext.Provider value={api}>
        <EditorsContext.Provider value={editors}>
          <Dashboard view={view} />
        </EditorsContext.Provider>
      </ApiContext.Provider>
    );
  };
  const result = render(ui(first));
  return { ...result, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

const settle = () => act(async () => {});

/** Opens the session list's Finished section, where ended sessions are. */
async function openFinished() {
  const toggle = screen.getByRole('main').querySelector<HTMLButtonElement>('.finished-toggle');
  if (toggle?.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
  await settle();
}

async function openView(name: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name }));
  await settle();
  return screen.getByRole('dialog', { name });
}

/** Opens the view's actions menu, and returns its items' names in order, with "—" for a separator. */
function openMenu(view: HTMLElement): string[] {
  if (!within(view).queryByRole('menu')) fireEvent.click(within(view).getByRole('button', { name: 'Session actions' }));
  const menu = within(view).getByRole('menu', { name: 'Session actions' });
  return [...menu.children].map((child) => (child.getAttribute('role') === 'separator' ? '—' : (child.textContent ?? '')));
}

function choose(view: HTMLElement, label: string) {
  openMenu(view);
  fireEvent.click(within(view).getByRole('menuitem', { name: label }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('the actions menu', () => {
  it('has Open in VS Code and Open in Cursor after the copies, with two editors found', async () => {
    renderDashboard([VSCODE, CURSOR]);
    const view = await openView('pitwall-test-bg');
    expect(openMenu(view)).toEqual(['Copy session ID', 'Copy attach command', '—', 'Open in VS Code', 'Open in Cursor', '—', 'Stop session', 'Remove session']);
  });

  it('has the one found, with one', async () => {
    renderDashboard([CURSOR]);
    const view = await openView('pitwall-test-bg');
    expect(openMenu(view)).toEqual(['Copy session ID', 'Copy attach command', '—', 'Open in Cursor', '—', 'Stop session', 'Remove session']);
  });

  it('has neither, and no separator for them, with none found', async () => {
    renderDashboard([]);
    const view = await openView('pitwall-test-bg');
    expect(openMenu(view)).toEqual(['Copy session ID', 'Copy attach command', '—', 'Stop session', 'Remove session']);
  });

  it('has them for an interactive session', async () => {
    renderDashboard([CURSOR]);
    expect(openMenu(await openView('pitwall-test-interactive'))).toEqual(['Copy session ID', '—', 'Open in Cursor', '—', 'Stop session']);
  });

  it('has them for an ended session, whose directory may still be there, before Resume in background', async () => {
    renderDashboard([CURSOR]);
    await openFinished();
    expect(openMenu(await openView('pitwall-test-ended'))).toEqual(['Copy session ID', 'Copy resume command', '—', 'Open in Cursor', '—', 'Resume in background']);
  });

  it("doesn't have them when the session's directory has gone", async () => {
    renderDashboard([VSCODE, CURSOR]);
    const menu = openMenu(await openView('pitwall-test-gone'));
    expect(menu).toEqual(['Copy session ID', 'Copy attach command', '—', 'Stop session', 'Remove session']);
  });

  it("doesn't have them once it's no longer listed", async () => {
    const { update } = renderDashboard([VSCODE, CURSOR]);
    const view = await openView('pitwall-test-bg');
    expect(openMenu(view)).toContain('Open in Cursor');
    fireEvent.keyDown(within(view).getByRole('menu'), { key: 'Escape' });
    update(snapshot([group({ sessions: [session({ sessionId: INTERACTIVE, name: 'pitwall-test-interactive' })] })]));
    await settle();
    expect(openMenu(view)).not.toContain('Open in Cursor');
    expect(openMenu(view)).not.toContain('Open in VS Code');
  });
});

describe('opening', () => {
  it("POSTs the editor to the session's open path, then says so in a success toast", async () => {
    const fetch = fakeServer({ status: 200, body: { ok: true } });
    renderDashboard([VSCODE, CURSOR], fetch);
    const view = await openView('pitwall-test-bg');
    choose(view, 'Open in Cursor');
    await waitFor(() => expect(toastMessages()).toEqual(["Opened pitwall-test-bg's directory in Cursor."]));
    expect(posts(fetch)).toEqual([[openInEditorPath(BG), { editor: 'cursor' }]]);
    expect(toastSaying("Opened pitwall-test-bg's directory in Cursor.").className).toContain('success');
  });

  it("says why it didn't open in an error toast, in the server's words after pitwall's sentence", async () => {
    const error = "Cursor didn't open. If it has moved, restart pitwall so it looks again.";
    renderDashboard([CURSOR], fakeServer({ status: 502, body: { ok: false, error } }));
    const view = await openView('pitwall-test-bg');
    choose(view, 'Open in Cursor');
    const message = `Couldn't open pitwall-test-bg's directory in Cursor. ${error}`;
    await waitFor(() => expect(toastMessages()).toEqual([message]));
    expect(toastSaying(message).className).toContain('error');
  });

  it("says when to try again past the opens a minute, in the server's words, and the item works again (W87)", async () => {
    const error = 'pitwall opens at most 10 directories in an editor every 60 seconds. Try again in 42s.';
    const fetch = fakeServer({ status: 429, body: { ok: false, error } }, { status: 200, body: { ok: true } });
    renderDashboard([CURSOR], fetch);
    const view = await openView('pitwall-test-bg');
    choose(view, 'Open in Cursor');
    const message = `Couldn't open pitwall-test-bg's directory in Cursor. ${error}`;
    await waitFor(() => expect(toastMessages()).toEqual([message]));
    expect(toastSaying(message).className).toContain('error');
    choose(view, 'Open in Cursor');
    await waitFor(() => expect(toastMessages()).toContain("Opened pitwall-test-bg's directory in Cursor."));
    expect(posts(fetch)).toHaveLength(2);
  });

  it('gives the status when the server gave no reason', async () => {
    renderDashboard([VSCODE], fakeServer({ status: 500 }));
    const view = await openView('pitwall-test-bg');
    choose(view, 'Open in VS Code');
    await waitFor(() => expect(toastMessages()).toEqual(["Couldn't open pitwall-test-bg's directory in VS Code (HTTP 500)."]));
  });

  it('turns both items off while one is out, saying why, so a second press sends nothing', async () => {
    const fetch = fakeServer('hold');
    renderDashboard([VSCODE, CURSOR], fetch);
    const view = await openView('pitwall-test-bg');
    choose(view, 'Open in Cursor');
    await settle();
    openMenu(view);
    for (const label of ['Open in VS Code', 'Open in Cursor']) {
      const item = within(view).getByRole('menuitem', { name: label });
      expect(item.getAttribute('aria-disabled'), label).toBe('true');
      expect(descriptionOf(item)).toBe('Wait for the editor to open.');
    }
    fireEvent.click(within(view).getByRole('menuitem', { name: 'Open in VS Code' }));
    await settle();
    expect(posts(fetch)).toHaveLength(1);
    await act(async () => fetch.held.splice(0).forEach((release) => release()));
    await waitFor(() => expect(toastMessages()).toEqual(["Opened pitwall-test-bg's directory in Cursor."]));
    expect(within(view).getByRole('menuitem', { name: 'Open in VS Code' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('still says how it went when the view has gone meanwhile', async () => {
    const fetch = fakeServer('hold');
    renderDashboard([CURSOR], fetch);
    const view = await openView('pitwall-test-bg');
    choose(view, 'Open in Cursor');
    await settle();
    fireEvent.click(within(view).getByRole('button', { name: 'Close' }));
    await settle();
    expect(screen.queryByRole('dialog', { name: 'pitwall-test-bg' })).toBeNull();
    await act(async () => fetch.held.splice(0).forEach((release) => release()));
    await waitFor(() => expect(toastMessages()).toEqual(["Opened pitwall-test-bg's directory in Cursor."]));
  });
});
