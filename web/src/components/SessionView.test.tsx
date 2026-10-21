import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conversationPath,
  PROTOCOL_VERSION,
  type ConversationEntry,
  type ConversationPage,
  type IndexSnapshot,
  type SessionSummary,
} from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { App } from '../App.js';
import type { ConnectionView } from '../connection.js';
import { fakeSockets, group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { tooltipText } from '../test/tooltips.js';
import { TOKEN_STORAGE_KEY } from '../token.js';
import { Dashboard } from './Dashboard.js';
import { FINISHED_ASKED_HINT, STALE_HINT } from './SessionRow.js';
import { SessionView } from './SessionView.js';

// Made-up sessions and conversations only.

const SID = '00000000-0000-4000-8000-0000000000d1';
const API_KEY = 'k'.repeat(43);
const at = (second: number) => `2026-03-02T11:50:${String(second).padStart(2, '0')}.000Z`;
const prompt = (second: number, text = `prompt ${second}`): ConversationEntry => ({ kind: 'user', at: at(second), text });

function target(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return session({
    sessionId: SID,
    name: 'demo-docs',
    title: 'Update the getting started guide',
    cwd: '/Users/example/code/demo-app/docs',
    lastActivityAt: minutesAgo(5),
    ...overrides,
  });
}

const snap = (s: SessionSummary = target()): IndexSnapshot => snapshot([group({ sessions: [s, session({ name: 'demo-other' })] })]);

/** What the fake server answers: a page, or a bare status. */
type Answer = { page: ConversationPage } | { status: number };

const ok = (entries: ConversationEntry[], before?: string): Answer => {
  const page: ConversationPage = { sessionId: SID, entries };
  if (before !== undefined) page.before = before;
  return { page };
};
const status = (code: number): Answer => ({ status: code });

/** A fetch that answers each call with the next answer, then the last one again. */
function fakeServer(...answers: Answer[]) {
  let call = 0;
  return vi.fn<FetchLike>(async () => {
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (!answer) throw new Error('no answer');
    return 'page' in answer ? new Response(JSON.stringify(answer.page), { status: 200 }) : new Response(null, { status: answer.status });
  });
}

/** The before cursor of each request the fake server got, undefined for the newest page. */
function cursorsOf(fetch: ReturnType<typeof fakeServer>): (string | undefined)[] {
  return fetch.mock.calls.map(([url]) => new URL(url, 'http://127.0.0.1').searchParams.get('before') ?? undefined);
}

/** Renders the dashboard with the app's API client over `fetch`, already holding an apiKey. Without `fetch`, there's no client. */
function renderDashboard(fetch: FetchLike | undefined, first: IndexSnapshot = snap()) {
  const api = fetch ? createApiClient({ apiKey: API_KEY, fetch }) : undefined;
  const ui = (s: IndexSnapshot) => {
    const view: ConnectionView = { state: 'live', snapshot: s };
    return (
      <ApiContext.Provider value={api}>
        <Dashboard view={view} />
      </ApiContext.Provider>
    );
  };
  const result = render(ui(first));
  return { ...result, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

/** Lets the requests' promises settle. */
const settle = () => act(async () => {});

/** Waits for the next animation frame. */
const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

async function openView(name = 'demo-docs'): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name }));
  await settle();
  return screen.getByRole('dialog');
}

/** Each entry's text, and each tool call's line, folded or not, in order. */
function texts(view: HTMLElement): string[] {
  return [...view.querySelectorAll('.entry-text, .tool-call-text')].map((element) => element.textContent ?? '');
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('SessionView: opening and closing', () => {
  it("opens from the session's name, with its name and title, kind, status, directory and last activity", async () => {
    const server = fakeServer(ok([prompt(1)]));
    renderDashboard(server);
    expect(screen.queryByRole('dialog')).toBeNull();

    const view = await openView();

    expect(view.getAttribute('aria-labelledby')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'demo-docs · Update the getting started guide' })).toBe(view);
    expect(within(view).getByText('Interactive')).toBeTruthy();
    // Idle has no badge in the list, but the view shows it.
    expect(within(view).getByText('Idle').closest('.badge')?.getAttribute('data-status')).toBe('idle');
    expect(view.id).toBe('session-view');
    expect(view.querySelector('.session-view-path')?.textContent).toBe('~/code/demo-app/docs');
    // The whole path, home and all, and the absolute time, in tooltips.
    expect(await tooltipText(view.querySelector('.session-view-path')!)).toBe('/Users/example/code/demo-app/docs');
    expect(await tooltipText(within(view).getByText('Active 5m ago'))).toMatch(/2026/);
    expect(texts(view)).toEqual(['prompt 1']);
    expect(cursorsOf(server)).toEqual([undefined]);
    expect(server.mock.calls[0]![0]).toBe(conversationPath(SID));
    // The heading takes focus, not Close (6.1, item 8).
    const heading = within(view).getByRole('heading', { level: 2 });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('opens from a click anywhere on the row, but not from a click that ends a text selection', async () => {
    const { container } = renderDashboard(fakeServer(ok([prompt(1)])));
    const row = screen.getByRole('heading', { level: 3, name: 'demo-docs' }).closest('li')!;

    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'run the' } as Selection);
    fireEvent.click(row.querySelector('.session-what')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    selection.mockRestore();

    fireEvent.click(row.querySelector('.session-what')!);
    await settle();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(container.querySelector('.session.open')).toBe(row);
  });

  it('closes with its button and with Escape, and gives focus back to the row', async () => {
    renderDashboard(fakeServer(ok([prompt(1)])));
    const name = screen.getByRole('button', { name: 'demo-docs' });

    fireEvent.click(within(await openView()).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Over the list, after a frame, so the row is there to take it.
    await nextFrame();
    expect(document.activeElement).toBe(name);

    await openView();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await nextFrame();
    expect(document.activeElement).toBe(name);
  });

  it("switches to another session's view when another row is opened", async () => {
    const server = fakeServer(ok([prompt(1)]));
    renderDashboard(server);
    await openView('demo-docs');
    const view = await openView('demo-other');
    expect(within(view).getByRole('heading', { level: 2 }).textContent).toBe('demo-other');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('waits for an apiKey while connecting, and abandons the request when closed', async () => {
    const fetch = fakeServer(ok([prompt(1)]));
    const api = createApiClient({ fetch });
    render(
      <ApiContext.Provider value={api}>
        <Dashboard view={{ state: 'connecting', snapshot: snap() }} />
      </ApiContext.Provider>,
    );
    const view = await openView();
    // After --pw-delay-spinner.
    await waitFor(() => expect(within(view).getByText('Loading the conversation…')).toBeTruthy());

    fireEvent.click(within(view).getByRole('button', { name: 'Close' }));
    await act(async () => api.keys.set(API_KEY));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says when there is no API client, as when the dashboard is rendered alone', async () => {
    renderDashboard(undefined);
    expect(within(await openView()).getByText("The conversation can't be loaded here.")).toBeTruthy();
  });
});

describe('SessionView: the conversation', () => {
  it('renders text as text, never as markup, and keeps line breaks', async () => {
    const html = '<b>bold</b> <img src=x onerror="alert(1)"> <script>alert(2)</script>';
    renderDashboard(fakeServer(ok([{ kind: 'assistant', at: at(1), text: `${html}\nsecond line` }])));
    const view = await openView();

    const text = view.querySelector('.entry-assistant .entry-text')!;
    expect(text.textContent).toBe(`${html}\nsecond line`);
    expect(view.querySelector('b, img, script')).toBeNull();
    expect(text.innerHTML).toContain('&lt;b&gt;');
  });

  it('labels prompts and replies, folds tool calls in a row, names cross-session senders, and mutes notices (more in Conversation.test.tsx)', async () => {
    renderDashboard(
      fakeServer(
        ok([
          prompt(1, 'run the tests'),
          { kind: 'tool', at: at(2), text: 'Bash: npm test', toolName: 'Bash', toolError: true },
          { kind: 'tool', at: at(3), text: 'Read: /w/a.ts', toolName: 'Read', toolError: false },
          { kind: 'assistant', at: at(4), text: 'One test fails.' },
          { kind: 'cross-session', at: at(5), text: 'Please review PR 4.', from: 'pitwall-test-sup' },
          { kind: 'cross-session', at: at(6), text: 'ping' },
          { kind: 'notice', at: at(7), text: 'Conversation compacted', truncated: true },
        ]),
      ),
    );
    const view = await openView();
    const items = [...view.querySelectorAll<HTMLElement>('.conversation > li')];

    expect(items.map((item) => item.className)).toEqual([
      'entry entry-user',
      'entry entry-fold',
      'entry entry-assistant',
      'entry entry-cross-session',
      'entry entry-cross-session',
      'entry entry-notice',
    ]);
    expect(items[0]!.querySelector('.entry-speaker')?.textContent).toMatch(/^You · /);
    expect(within(items[1]!).getByRole('button', { name: '2 tool calls, 1 error' }).getAttribute('aria-expanded')).toBe('false');
    expect(items[2]!.querySelector('.entry-speaker')?.textContent).toMatch(/^Claude · /);
    expect(items[3]!.querySelector('.entry-speaker')?.textContent).toMatch(/^From pitwall-test-sup · /);
    expect(items[4]!.querySelector('.entry-speaker')?.textContent).toMatch(/^From another session · /);
    expect(items[5]!.querySelector('.entry-speaker')).toBeNull();
    expect(within(items[5]!).getByText('Cut short.')).toBeTruthy();
    expect(texts(view)).toEqual(['run the tests', 'Bash: npm test', 'Read: /w/a.ts', 'One test fails.', 'Please review PR 4.', 'ping', 'Conversation compacted']);
  });

  it('loads earlier pages with the cursor, above the ones shown, until there are none', async () => {
    const server = fakeServer(ok([prompt(3), prompt(4)], 'cursor-1'), ok([prompt(1), prompt(2)], 'cursor-2'), ok([prompt(0)]));
    renderDashboard(server);
    const view = await openView();
    expect(texts(view)).toEqual(['prompt 3', 'prompt 4']);

    await act(async () => fireEvent.click(within(view).getByRole('button', { name: 'Load earlier' })));
    expect(cursorsOf(server).at(-1)).toBe('cursor-1');
    expect(texts(view)).toEqual(['prompt 1', 'prompt 2', 'prompt 3', 'prompt 4']);

    await act(async () => fireEvent.click(within(view).getByRole('button', { name: 'Load earlier' })));
    expect(cursorsOf(server).at(-1)).toBe('cursor-2');
    expect(texts(view)).toEqual(['prompt 0', 'prompt 1', 'prompt 2', 'prompt 3', 'prompt 4']);
    expect(within(view).queryByRole('button', { name: 'Load earlier' })).toBeNull();
  });

  it('starts again from the newest page when the cursor is stale', async () => {
    const server = fakeServer(ok([prompt(3)], 'old-cursor'), status(410), ok([prompt(7), prompt(8)], 'new-cursor'));
    renderDashboard(server);
    const view = await openView();

    await act(async () => fireEvent.click(within(view).getByRole('button', { name: 'Load earlier' })));

    expect(cursorsOf(server)).toEqual([undefined, 'old-cursor', undefined]);
    expect(texts(view)).toEqual(['prompt 7', 'prompt 8']);
    expect(within(view).getByText('The transcript changed, so this starts again from its newest messages.')).toBeTruthy();
    expect(within(view).getByRole('button', { name: 'Load earlier' })).toBeTruthy();
  });

  it('says when earlier messages could not be loaded, and keeps what it shows', async () => {
    renderDashboard(fakeServer(ok([prompt(3)], 'c'), status(500)));
    const view = await openView();
    await act(async () => fireEvent.click(within(view).getByRole('button', { name: 'Load earlier' })));
    expect(within(view).getByRole('alert').textContent).toBe("Couldn't load earlier messages (HTTP 500).Try again");
    expect(texts(view)).toEqual(['prompt 3']);
  });

  it("fetches the newest page again when the session's activity moves, and merges it without duplicates", async () => {
    const server = fakeServer(
      ok([prompt(1), { kind: 'assistant', at: at(2), text: 'Part one.' }, { kind: 'tool', at: at(3), text: 'Bash: npm test', toolName: 'Bash' }]),
      ok([
        { kind: 'assistant', at: at(2), text: 'Part one.\nPart two.' },
        { kind: 'tool', at: at(3), text: 'Bash: npm test', toolName: 'Bash', toolError: true },
        prompt(4),
      ]),
    );
    const { update } = renderDashboard(server);
    const view = await openView();
    expect(texts(view)).toEqual(['prompt 1', 'Part one.', 'Bash: npm test']);

    // A snapshot that changes something else doesn't refetch.
    update(snap(target({ status: 'busy' })));
    await settle();
    expect(server).toHaveBeenCalledTimes(1);
    expect(within(view).getByText('Busy')).toBeTruthy();

    update(snap(target({ status: 'busy', lastActivityAt: minutesAgo(0) })));
    await settle();
    expect(server).toHaveBeenCalledTimes(2);
    expect(texts(view)).toEqual(['prompt 1', 'Part one.\nPart two.', 'Bash: npm test', 'prompt 4']);
    expect(within(view.querySelector('.entry-tool.has-error')!).getByText('error').closest('.badge-subtle-danger')).toBeTruthy();
  });

  it('replaces the entries when the newest page no longer overlaps them', async () => {
    const server = fakeServer(ok([prompt(1)]), ok([prompt(50), prompt(51)], 'c'));
    const { update } = renderDashboard(server);
    const view = await openView();
    update(snap(target({ lastActivityAt: minutesAgo(0) })));
    await settle();
    expect(texts(view)).toEqual(['prompt 50', 'prompt 51']);
    expect(within(view).getByRole('button', { name: 'Load earlier' })).toBeTruthy();
  });

  it('follows new entries when scrolled to the bottom, and keeps the place otherwise', async () => {
    let scrollHeight = 1000;
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => scrollHeight);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    const server = fakeServer(ok([prompt(1)]), ok([prompt(1), prompt(2)]), ok([prompt(1), prompt(2), prompt(3)]));
    const { update } = renderDashboard(server);
    const view = await openView();
    const body = view.querySelector<HTMLElement>('.session-view-body')!;
    expect(body.scrollTop).toBe(1000);

    // At the bottom: new entries are followed.
    body.scrollTop = 600;
    fireEvent.scroll(body);
    scrollHeight = 1200;
    update(snap(target({ lastActivityAt: minutesAgo(1) })));
    await settle();
    expect(body.scrollTop).toBe(1200);

    // Scrolled up: the place is kept.
    body.scrollTop = 100;
    fireEvent.scroll(body);
    scrollHeight = 1400;
    update(snap(target({ lastActivityAt: minutesAgo(0) })));
    await settle();
    expect(body.scrollTop).toBe(100);
  });

  it('says when the session has no transcript, and offers a retry when loading failed', async () => {
    const first = renderDashboard(fakeServer(status(404)));
    expect(within(await openView()).getByText('No transcript for this session.')).toBeTruthy();
    first.unmount();

    const retried = fakeServer(status(500), ok([prompt(1)]));
    renderDashboard(retried);
    const view = await openView();
    await act(async () => fireEvent.click(within(view).getByRole('button', { name: 'Try again' })));
    expect(texts(view)).toEqual(['prompt 1']);
  });

  it('keeps showing a session that left the snapshot, and says so', async () => {
    const { update } = renderDashboard(fakeServer(ok([prompt(1)])));
    const view = await openView();
    update(snapshot([group({ sessions: [session({ name: 'demo-other' })] })]));
    await settle();
    expect(screen.getByRole('dialog')).toBe(view);
    expect(within(view).getByText('This session is no longer listed, so this is what it showed last.')).toBeTruthy();
    expect(texts(view)).toEqual(['prompt 1']);
  });
});

describe('SessionView: the badges a row has, with their explanations (W31)', () => {
  const lineTwo = () => document.querySelector<HTMLElement>('.session-view-meta')!;
  const badges = () => [...lineTwo().querySelectorAll('.badge')].map((badge) => badge.textContent);

  it('shows Stale after the status, with an info button whose name is its explanation, so the keyboard reaches it', async () => {
    const stale = target({ kind: 'background', shortId: 'pt0d1', state: 'blocked', status: undefined, stale: true, waitingFor: 'a made-up question' });
    render(<SessionView session={stale} listed onClose={() => {}} />);
    expect(badges()).toEqual(['Blocked: a made-up question', 'Stale']);
    const info = within(lineTwo()).getByRole('button', { name: STALE_HINT });
    expect(info.closest('.session-view-badge')?.querySelector('.badge')?.textContent).toBe('Stale');
    expect(info.tabIndex).toBe(0);
    expect(await tooltipText(info)).toBe(STALE_HINT);
  });

  it('shows a finished session’s Asked you, outlined, with its explanation the same way', () => {
    const finished = target({ kind: 'background', shortId: 'pt0d1', state: 'done', status: undefined, alive: false, pid: undefined, finished: true, askedYou: { reason: 'open-questions', excerpt: 'A made-up question?' } });
    render(<SessionView session={finished} listed onClose={() => {}} />);
    expect(badges()).toEqual(['Done', 'Asked you']);
    expect(lineTwo().querySelector('.badge-outline')?.textContent).toBe('Asked you');
    expect(within(lineTwo()).getByRole('button', { name: FINISHED_ASKED_HINT })).toBeTruthy();
  });

  it('shows neither for a session that is neither stale nor finished', () => {
    render(<SessionView session={target({ askedYou: { reason: 'open-questions', excerpt: 'A made-up question?' } })} listed onClose={() => {}} />);
    expect(badges()).toEqual(['Asked you']);
    expect(lineTwo().querySelector('.session-view-badge')).toBeNull();
  });
});

describe('SessionView: the /bg note', () => {
  it("is an info button after an interactive session's kind, named and tooltipped with how /bg lets pitwall drive it fully", async () => {
    renderDashboard(fakeServer(ok([])));
    const view = await openView();
    const note = 'Typing /bg in its terminal moves it to the background, so pitwall can drive it fully.';
    // A button, so Tab reaches it, whose name is its tooltip.
    const info = within(view).getByRole('button', { name: note });
    expect(info.tabIndex).toBe(0);
    expect(info.hasAttribute('title')).toBe(false);
    expect(await tooltipText(info)).toBe(note);
    expect(info.closest('.session-view-kind')?.textContent).toBe('Interactive');
  });

  it('is not shown for a background session', async () => {
    renderDashboard(fakeServer(ok([])), snap(target({ kind: 'background', shortId: 'bg1234', state: 'done', status: undefined })));
    const view = await openView();
    expect(within(view).queryByRole('button', { name: /moves it to the background/ })).toBeNull();
    expect(view.querySelector('.session-view-kind')?.textContent).toBe('Background');
    expect(within(view).getByText('Nothing to show yet.')).toBeTruthy();
  });
});

describe('SessionView: the message box at the foot', () => {
  /** Whether `a` comes before `b` in the document. */
  const precedes = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  /** GETs, the conversation, answer with `entries`; POSTs, the relay, with delivered. */
  function chatServer(entries: ConversationEntry[]) {
    return vi.fn<FetchLike>(
      async (_url, init) =>
        new Response(JSON.stringify(init.method === 'POST' ? { status: 'delivered' } : { sessionId: SID, entries }), { status: 200 }),
    );
  }

  it('comes after the conversation, outside the header, with the latest exchange and the send result just above the text box', async () => {
    const relay = { sentAt: minutesAgo(3), status: 'delivered' as const, reply: { at: minutesAgo(2), text: 'All three fixed.' } };
    renderDashboard(chatServer([prompt(1), { kind: 'assistant', at: at(2), text: 'The newest reply.' }]), snap(target({ relay })));
    const view = await openView();
    const header = view.querySelector('header')!;
    const body = view.querySelector<HTMLElement>('.session-view-body')!;
    const box = within(view).getByRole('region', { name: 'Message this session' });
    const textbox = within(box).getByRole('textbox', { name: 'Message to demo-docs' });

    expect(header.contains(box)).toBe(false);
    expect(body.contains(box)).toBe(false);
    expect(precedes(body, box)).toBe(true);
    expect(view.lastElementChild).toBe(box.closest('.session-view-foot'));
    expect(precedes(within(body).getByText('The newest reply.'), textbox)).toBe(true);

    fireEvent.change(textbox, { target: { value: 'hello' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Send' }));
    await settle();
    const exchange = box.querySelector('.relay-exchange')!;
    const result = within(box).getByRole('status');
    expect(precedes(exchange, result)).toBe(true);
    expect(precedes(result, textbox)).toBe(true);
  });

  it('goes when the session is no longer listed, and is not there for a background session', async () => {
    const first = renderDashboard(fakeServer(ok([prompt(1)])));
    const view = await openView();
    expect(view.querySelector('.session-view-foot')).toBeTruthy();
    first.update(snapshot([group({ sessions: [session({ name: 'demo-other' })] })]));
    await settle();
    expect(view.querySelector('.session-view-foot')).toBeNull();
    first.unmount();

    renderDashboard(fakeServer(ok([prompt(1)])), snap(target({ kind: 'background', shortId: 'bg1234', state: 'done', status: undefined })));
    expect((await openView()).querySelector('.session-view-foot')).toBeNull();
  });

  it('stays at the bottom when the box below the conversation grows, and keeps the place when scrolled up', async () => {
    const observed: { callback: ResizeObserverCallback; target?: Element }[] = [];
    class FakeResizeObserver {
      private entry: { callback: ResizeObserverCallback; target?: Element };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback };
        observed.push(this.entry);
      }
      observe(target: Element) {
        this.entry.target = target;
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    try {
      let clientHeight = 400;
      vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => clientHeight);
      renderDashboard(fakeServer(ok([prompt(1)])));
      const view = await openView();
      const body = view.querySelector<HTMLElement>('.session-view-body')!;
      const resized = () =>
        act(() => {
          for (const entry of observed) if (entry.target === body) entry.callback([], entry as unknown as ResizeObserver);
        });

      // At the bottom, as a browser leaves it, when a send's result makes the box taller and the conversation shorter.
      body.scrollTop = 600;
      fireEvent.scroll(body);
      clientHeight = 340;
      resized();
      expect(body.scrollTop).toBe(1000);

      // Scrolled up to read: the place is kept.
      body.scrollTop = 100;
      fireEvent.scroll(body);
      clientHeight = 300;
      resized();
      expect(body.scrollTop).toBe(100);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('SessionView in the app', () => {
  const TOKEN = 'pitwall-test-token-NEVER-SENT-0123456789abcdef';
  const KEY_A = 'a'.repeat(43);
  const KEY_B = 'b'.repeat(43);
  const authorization = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;
  const pageBody = (text: string) => new Response(JSON.stringify({ sessionId: SID, entries: [prompt(1, text)] }), { status: 200 });

  /** Challenges the socket, waits for the page's proof, then accepts it with `apiKey`. */
  async function handshake(socket: ReturnType<typeof fakeSockets>['last'], apiKey: string, nonce: string) {
    act(() => {
      socket.open();
      socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce });
    });
    await waitFor(() => expect(socket.sent).toHaveLength(1));
    act(() => socket.receive({ type: 'authenticated', apiKey }));
  }

  async function appWithSession(fetch: FetchLike) {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    const fake = fakeSockets();
    render(<App createSocket={fake.factory} fetch={fetch} />);
    await handshake(fake.last, KEY_A, `${'n'.repeat(41)}01`);
    act(() => fake.last.receive({ type: 'snapshot', snapshot: snap() }));
    return fake;
  }

  it("fetches pages through the app's API client with the apiKey, never the token", async () => {
    const fetch = vi.fn<FetchLike>(async () => pageBody('from the server'));
    await appWithSession(fetch);

    const view = await openView();

    expect(fetch).toHaveBeenCalledWith(conversationPath(SID), {
      headers: { Authorization: `Bearer ${KEY_A}` },
      cache: 'no-store',
      // Aborted when the view closes.
      signal: expect.any(AbortSignal),
    });
    expect(texts(view)).toEqual(['from the server']);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).not.toContain(TOKEN);
      expect(JSON.stringify(init)).not.toContain(TOKEN);
    }
  });

  it('takes a 401 as a stale apiKey: the client reconnects and retries, and the token is never rejected', async () => {
    const fetch = vi.fn<FetchLike>(async (_url, init) =>
      authorization(init) === `Bearer ${KEY_A}` ? new Response(null, { status: 401 }) : pageBody('fetched with the fresh key'),
    );
    const fake = await appWithSession(fetch);

    fireEvent.click(screen.getByRole('button', { name: 'demo-docs' }));
    await waitFor(() => expect(fake.sockets).toHaveLength(2));
    await handshake(fake.last, KEY_B, `${'n'.repeat(41)}02`);

    await waitFor(() => expect(texts(screen.getByRole('dialog'))).toEqual(['fetched with the fresh key']));
    expect(fetch.mock.calls.map(([, init]) => authorization(init))).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
    expect(screen.queryByText(/Token rejected/)).toBeNull();
  });
});
