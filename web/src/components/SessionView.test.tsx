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
import { AttachContext, type AttachEnv } from '../attach.js';
import type { ConnectionView } from '../connection.js';
import { fakeSockets, group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { tooltipText } from '../test/tooltips.js';
import { TOKEN_STORAGE_KEY } from '../token.js';
import { Dashboard } from './Dashboard.js';
import { FINISHED_ASKED_HINT, STALE_HINT } from './SessionRow.js';
import { BACKGROUND_NOTES, CWD_MISSING_HINT, CWD_MISSING_NOTES, cwdMissingNote, EXIT_COMMAND, SessionView, WAITING_NOTES, waitingNote } from './SessionView.js';

// Made-up sessions and conversations only.

// The Terminal tab's xterm.js, for the tests that open it: it only needs to exist.
vi.mock('../xterm.js', () => ({
  createXterm: () => ({ cols: 80, rows: 24, write() {}, onData() {}, fit() {}, focus() {}, dispose() {} }),
}));

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

describe('SessionView: Back to sessions (W31)', () => {
  it('is a ghost Button with the back icon at 600 px and narrower, in place of Close, saying Escape does the same', () => {
    render(<SessionView session={target()} listed onClose={() => {}} compact />);
    const back = screen.getByRole('button', { name: 'Back to sessions' });
    expect(back.className).toBe('button ghost md session-view-back');
    expect(back.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(back.getAttribute('aria-keyshortcuts')).toBe('Escape');
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});

describe('SessionView: the /bg note', () => {
  it("is an info button after an interactive session's kind, named and tooltipped with how /bg lets pitwall attach to it and stop it", async () => {
    renderDashboard(fakeServer(ok([])));
    const view = await openView();
    const note = 'Typing /bg in its terminal moves it to the background, so pitwall can attach to it and stop it.';
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

describe('SessionView: notes that say what to do (W47)', () => {
  const GONE_DIR = '/Users/example/code/demo-app/.claude/worktrees/pitwall-test-gone';
  const interactive = (overrides: Partial<SessionSummary> = {}) => target({ cwd: GONE_DIR, cwdMissing: true, ...overrides });
  const background = (overrides: Partial<SessionSummary> = {}) =>
    target({ kind: 'background', shortId: 'pt0d47', state: 'working', status: undefined, cwd: GONE_DIR, cwdMissing: true, ...overrides });
  const finished = (state: 'done' | 'stopped' | 'failed', overrides: Partial<SessionSummary> = {}) =>
    background({ state, alive: false, pid: undefined, finished: true, ...overrides });

  /** An attach env whose sockets are counted, so a test can say nothing attached. */
  function attachEnv() {
    const sockets = fakeSockets();
    const env: AttachEnv = { token: 'pitwall-test-token', host: '127.0.0.1:4517', createSocket: sockets.factory };
    return { env, sockets: sockets.sockets };
  }

  function renderView(s: SessionSummary, { listed = true, env }: { listed?: boolean; env?: AttachEnv } = {}) {
    const ui = (shown: SessionSummary) => {
      const view = <SessionView session={shown} listed={listed} onClose={() => {}} />;
      return env ? <AttachContext.Provider value={env}>{view}</AttachContext.Provider> : view;
    };
    const result = render(ui(s));
    return { ...result, view: result.container.querySelector<HTMLElement>('.session-view')!, update: (next: SessionSummary) => result.rerender(ui(next)) };
  }

  const head = (view: HTMLElement) => view.querySelector<HTMLElement>('.session-view-head')!;
  const cwdNote = (view: HTMLElement) => view.querySelector<HTMLElement>('.session-view-cwd-note');
  const waitNote = (view: HTMLElement) => view.querySelector<HTMLElement>('.session-view-waiting-note');
  const badgeText = (view: HTMLElement) => view.querySelector('.session-view-meta .badge')?.textContent;
  const footNote = (view: HTMLElement) => view.querySelector<HTMLElement>('.session-view-foot .session-view-note');

  /** The innermost elements whose whole text is `text`: one, when it's read once. */
  const holding = (view: HTMLElement, text: string) =>
    [...view.querySelectorAll('*')].filter((element) => element.textContent === text && ![...element.children].some((child) => child.textContent === text));

  /** Opens the actions menu and reads whether `label` is there and on. */
  function menuItem(view: HTMLElement, label: string): 'on' | 'off' | 'absent' {
    fireEvent.click(within(view).getByRole('button', { name: 'Session actions' }));
    const item = within(view).queryByRole('menuitem', { name: label });
    const state = !item ? 'absent' : item.getAttribute('aria-disabled') === 'true' ? 'off' : 'on';
    fireEvent.keyDown(within(view).getByRole('menu'), { key: 'Escape' });
    return state;
  }

  describe('the directory that has gone', () => {
    it('keeps line 2 as it was: "Directory no longer exists", its own item, with its tooltip', async () => {
      const { view } = renderView(interactive());
      const missing = view.querySelector<HTMLElement>('.session-view-meta > .session-view-missing')!;
      expect(missing.textContent).toBe('Directory no longer exists');
      expect(await tooltipText(missing)).toBe(CWD_MISSING_HINT);
    });

    it('says an interactive session is still running in its terminal, and that /exit there ends it, in code style', () => {
      const { view } = renderView(interactive());
      const note = cwdNote(view)!;
      expect(note.textContent).toBe("It's still running in its terminal, so it's listed. Type /exit there to end it.");
      expect(note.textContent).toBe(CWD_MISSING_NOTES.interactive);
      expect([...note.querySelectorAll('code')].map((code) => code.textContent)).toEqual([EXIT_COMMAND]);
      // A line of its own, right under line 2, in the header.
      expect(note.tagName).toBe('P');
      expect(note.previousElementSibling).toBe(view.querySelector('.session-view-meta'));
      expect(head(view).contains(note)).toBe(true);
      // pitwall can't end it: Stop session is there, and off (W40).
      expect(menuItem(view, 'Stop session')).toBe('off');
    });

    it('says the same while it waits on you or is busy', () => {
      for (const status of ['waiting', 'busy', 'idle'] as const) {
        const { view, unmount } = renderView(interactive({ status, ...(status === 'waiting' ? { waitingFor: 'a made-up question' } : {}) }));
        expect(cwdNote(view)?.textContent).toBe(CWD_MISSING_NOTES.interactive);
        unmount();
      }
    });

    it('says a running background session is still running, and that Stop session ends it, which is on', () => {
      for (const s of [background(), background({ state: 'blocked', stale: true }), background({ state: 'done' })]) {
        const { view, unmount } = renderView(s);
        expect(cwdNote(view)?.textContent).toBe("It's still running, so it's listed. Stop session, in the actions menu, ends it.");
        expect(cwdNote(view)?.querySelector('code')).toBeNull();
        expect(menuItem(view, 'Stop session')).toBe('on');
        unmount();
      }
    });

    it.each(['done', 'stopped', 'failed'] as const)('says a %s background session isn’t running, and that Remove session takes it off the list, which is on', (state) => {
      const { view } = renderView(finished(state));
      expect(cwdNote(view)?.textContent).toBe("It isn't running. Remove session, in the actions menu, takes it off the list.");
      expect(menuItem(view, 'Remove session')).toBe('on');
      expect(menuItem(view, 'Stop session')).toBe('off');
    });

    it('says the same of a background session whose process exited before it finished, or whose state is unknown', () => {
      for (const s of [background({ state: 'blocked', alive: false, pid: undefined, stale: true }), background({ state: 'working', alive: false, pid: undefined }), background({ state: undefined, alive: false, pid: undefined })]) {
        const { view, unmount } = renderView(s);
        expect(cwdNote(view)?.textContent).toBe(CWD_MISSING_NOTES.notRunning);
        expect(menuItem(view, 'Remove session')).toBe('on');
        unmount();
      }
    });

    it('changes with the session: stopped while open, it says Remove session', () => {
      const { view, update } = renderView(background());
      expect(cwdNote(view)?.textContent).toBe(CWD_MISSING_NOTES.running);
      update(finished('stopped'));
      expect(cwdNote(view)?.textContent).toBe(CWD_MISSING_NOTES.notRunning);
    });

    it("leaves it plain for an interactive session that isn't running, and for any session no longer listed, whose menu has neither action", () => {
      const quiet = interactive({ alive: false, pid: undefined, status: undefined });
      const { view, unmount } = renderView(quiet);
      expect(view.querySelector('.session-view-missing')?.textContent).toBe('Directory no longer exists');
      expect(cwdNote(view)).toBeNull();
      unmount();

      for (const s of [interactive(), background(), finished('done')]) {
        const gone = renderView(s, { listed: false });
        expect(gone.view.querySelector('.session-view-missing')?.textContent).toBe('Directory no longer exists');
        expect(cwdNote(gone.view)).toBeNull();
        expect(head(gone.view).textContent).toContain('This session is no longer listed');
        expect(menuItem(gone.view, 'Stop session')).toBe('absent');
        expect(menuItem(gone.view, 'Remove session')).toBe('absent');
        gone.unmount();
      }
      expect(cwdMissingNote(quiet, true)).toBeUndefined();
    });

    it('says nothing for a session whose directory is there', () => {
      for (const s of [target(), target({ kind: 'background', shortId: 'pt0d48', state: 'working', status: undefined })]) {
        const { view, unmount } = renderView(s);
        expect(view.querySelector('.session-view-missing')).toBeNull();
        expect(cwdNote(view)).toBeNull();
        unmount();
      }
    });
  });

  describe('while it waits on you', () => {
    const waitingTty = (overrides: Partial<SessionSummary> = {}) => target({ status: 'waiting', waitingFor: 'input needed', ...overrides });
    const waitingJob = (overrides: Partial<SessionSummary> = {}) =>
      target({ kind: 'background', shortId: 'pt0d49', state: 'working', status: 'waiting', waitingFor: 'permission prompt', ...overrides });

    it("says to answer an interactive session in its terminal, which pitwall can't do, and that a message sent below waits", () => {
      const { view } = renderView(waitingTty());
      const note = waitNote(view)!;
      expect(note.textContent).toBe("Answer it in its terminal: pitwall can't, and a message sent below waits until you do.");
      expect(note.textContent).toBe(WAITING_NOTES.interactive);
      // Under line 2, whose badge says it's waiting and on what; the note doesn't say it again.
      expect(badgeText(view)).toBe('Waiting: input needed');
      expect(note.previousElementSibling).toBe(view.querySelector('.session-view-meta'));
      expect(note.textContent).not.toMatch(/waiting|input needed/i);
      // The message box is still there, below, as the note says.
      expect(view.querySelector('.session-view-foot > .relay-box')).toBeTruthy();
    });

    it('says to answer a background session in its Terminal tab, which attaches, with no button, and attaches nothing by itself', () => {
      const { env, sockets } = attachEnv();
      const { view } = renderView(waitingJob(), { env });
      const note = waitNote(view)!;
      expect(note.textContent).toBe('Answer it in its Terminal tab, which attaches to it.');
      expect(note.textContent).toBe(WAITING_NOTES.background);
      expect(badgeText(view)).toBe('Waiting: permission prompt');
      expect(note.textContent).not.toMatch(/waiting|permission prompt/i);
      expect(within(head(view)).queryAllByRole('button').map((button) => button.textContent)).not.toContain('Terminal');
      expect(note.querySelectorAll('button, a')).toHaveLength(0);
      expect(within(view).getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('false');
      expect(sockets).toHaveLength(0);
    });

    it('says the same for a background job that is blocked, which Claude Code reports with status idle, but not a stale one', () => {
      const { env } = attachEnv();
      const blocked = renderView(waitingJob({ state: 'blocked', status: 'idle', waitingFor: 'a made-up question' }), { env });
      expect(badgeText(blocked.view)).toBe('Blocked: a made-up question');
      expect(waitNote(blocked.view)?.textContent).toBe(WAITING_NOTES.background);
      blocked.unmount();
      const stale = renderView(waitingJob({ state: 'blocked', status: 'idle', stale: true }), { env });
      expect(waitNote(stale.view)).toBeNull();
    });

    it("says the same for a job whose own line says what it needs (W69), but nothing for one whose context needs nothing", () => {
      const { env } = attachEnv();
      const asks = renderView(waitingJob({ state: 'blocked', status: 'idle', waitingFor: undefined, needsYou: { reason: 'claude-code', text: 'Tea or coffee?' } }), { env });
      expect(badgeText(asks.view)).toBe('Blocked');
      expect(waitNote(asks.view)?.textContent).toBe(WAITING_NOTES.background);
      asks.unmount();
      // Resumed, with Claude Code's "send a prompt to start": Idle, as its process is, and no note.
      const placeholder = renderView(waitingJob({ state: 'blocked', status: 'idle', waitingFor: undefined, needsYou: undefined }), { env });
      expect(badgeText(placeholder.view)).toBe('Idle');
      expect(waitNote(placeholder.view)).toBeNull();
      placeholder.unmount();
      // Restarted from pitwall: it waits for your prompt, with nothing to answer.
      const restarted = renderView(waitingJob({ state: 'working', status: 'busy', waitingFor: undefined, needsYou: { reason: 'restarted' } }), { env });
      expect(badgeText(restarted.view)).toBe('Waiting for your prompt');
      expect(waitNote(restarted.view)).toBeNull();
    });

    it("shows what it's waiting on as Claude Code gives it, as text, in the badge alone", () => {
      const odd = '<b>made-up</b> dialog: "Pick one" & more';
      const { view } = renderView(waitingTty({ waitingFor: odd }));
      expect(badgeText(view)).toBe(`Waiting: ${odd}`);
      expect(view.querySelector('.session-view-meta b')).toBeNull();
      expect(holding(view, `Waiting: ${odd}`)).toHaveLength(1);
      expect(waitNote(view)?.textContent).toBe(WAITING_NOTES.interactive);
      // And with no reason at all, the badge is just "Waiting", and the note the same.
      const bare = renderView(waitingTty({ waitingFor: undefined }));
      expect(badgeText(bare.view)).toBe('Waiting');
      expect(waitNote(bare.view)?.textContent).toBe(WAITING_NOTES.interactive);
    });

    it("says nothing when it isn't waiting, isn't running, is no longer listed, or, for a background one, can't be attached", () => {
      const { env } = attachEnv();
      const quiet: [SessionSummary, boolean, AttachEnv | undefined][] = [
        [target({ status: 'idle' }), true, env],
        [target({ status: 'busy' }), true, env],
        [target({ askedYou: { reason: 'question', excerpt: 'A made-up question?' } }), true, env],
        [waitingTty({ alive: false, pid: undefined }), true, env],
        [waitingTty(), false, env],
        [waitingJob(), false, env],
        [waitingJob(), true, undefined],
        [waitingJob({ state: 'blocked', status: undefined, alive: false, pid: undefined }), true, env],
      ];
      for (const [s, listed, attach] of quiet) {
        const { view, unmount } = renderView(s, { listed, ...(attach ? { env: attach } : {}) });
        expect(waitNote(view)).toBeNull();
        unmount();
      }
      expect(waitingNote(waitingJob(), true, false)).toBeUndefined();
      expect(waitingNote(waitingJob(), true, true)).toBe(WAITING_NOTES.background);
    });

    it('comes and goes with the status, and sits above the directory note when both apply', () => {
      const { view, update } = renderView(waitingTty({ cwd: GONE_DIR, cwdMissing: true }));
      expect([...head(view).querySelectorAll('p')].map((p) => p.className)).toEqual(['session-view-waiting-note', 'session-view-cwd-note']);
      expect(waitNote(view)?.previousElementSibling).toBe(view.querySelector('.session-view-meta'));
      update(waitingTty({ cwd: GONE_DIR, cwdMissing: true, status: 'busy', waitingFor: undefined }));
      expect(waitNote(view)).toBeNull();
      expect(cwdNote(view)?.textContent).toBe(CWD_MISSING_NOTES.interactive);
    });
  });

  describe("a background session's footer", () => {
    it('says to type to a running one in its Terminal tab, which attaches, with no button and no message box, and attaches nothing by itself', () => {
      const { env, sockets } = attachEnv();
      const { view } = renderView(background({ cwdMissing: undefined, cwd: '/Users/example/code/demo-app' }), { env });
      const foot = view.querySelector<HTMLElement>('.session-view-foot')!;
      expect(footNote(view)?.textContent).toBe('To message it, type in its Terminal tab, which attaches to it.');
      expect(footNote(view)?.textContent).toBe(BACKGROUND_NOTES.running);
      // Where the message box would be: last in the view, after the body.
      expect(view.lastElementChild).toBe(foot);
      expect(foot.children).toHaveLength(1);
      // Opening the Terminal tab attaches, so nothing here opens it (D9).
      expect(within(foot).queryAllByRole('button')).toEqual([]);
      expect(within(foot).queryAllByRole('link')).toEqual([]);
      expect(within(view).queryByRole('textbox')).toBeNull();
      expect(within(view).queryByRole('region', { name: 'Message this session' })).toBeNull();
      expect(within(view).getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('false');
      expect(sockets).toHaveLength(0);
    });

    it('goes while the Terminal tab is open, which selecting attaches by itself, and comes back on Conversation', async () => {
      const { env, sockets } = attachEnv();
      const { view } = renderView(background(), { env });
      expect(footNote(view)?.textContent).toBe(BACKGROUND_NOTES.running);

      // Why the note has no button to open the tab: selecting it is what attaches (D9).
      fireEvent.click(within(view).getByRole('tab', { name: 'Terminal' }));
      await settle();
      expect(sockets).toHaveLength(1);
      expect(view.querySelector('.session-view-foot')).toBeNull();

      fireEvent.click(within(view).getByRole('tab', { name: 'Conversation' }));
      await settle();
      expect(footNote(view)?.textContent).toBe(BACKGROUND_NOTES.running);
      expect(sockets[0]!.closedByClient).toBe(true);
    });

    it('says a finished one asks before restarting, when its Terminal tab opens', () => {
      const { env, sockets } = attachEnv();
      for (const s of [finished('done'), finished('failed'), background({ state: 'blocked', alive: false, pid: undefined, stale: true })]) {
        const { view, unmount } = renderView(s, { env });
        expect(footNote(view)?.textContent).toBe('To message it, open its Terminal tab, which asks before restarting it.');
        expect(footNote(view)?.textContent).toBe(BACKGROUND_NOTES.notRunning);
        unmount();
      }
      expect(sockets).toHaveLength(0);
    });

    it('changes with the session: stopped while open, it says the tab asks first', () => {
      const { env } = attachEnv();
      const { view, update } = renderView(background(), { env });
      expect(footNote(view)?.textContent).toBe(BACKGROUND_NOTES.running);
      update(finished('stopped'));
      expect(footNote(view)?.textContent).toBe(BACKGROUND_NOTES.notRunning);
    });

    it("isn't there once it's no longer listed, or where it can't be attached, as the Terminal tab's tooltip says", () => {
      const { env } = attachEnv();
      const gone = renderView(background(), { listed: false, env });
      expect(gone.view.querySelector('.session-view-foot')).toBeNull();
      gone.unmount();
      const unattachable = renderView(background());
      expect(unattachable.view.querySelector('.session-view-foot')).toBeNull();
      expect(within(unattachable.view).getByRole('tab', { name: 'Terminal' }).getAttribute('aria-disabled')).toBe('true');
    });

    it('leaves an interactive session’s footer as it was: the message box, and no note', () => {
      const { env } = attachEnv();
      for (const s of [target(), interactive(), target({ alive: false, pid: undefined, status: undefined })]) {
        const { view, unmount } = renderView(s, { env });
        expect(view.querySelector('.session-view-foot > .relay-box')).toBeTruthy();
        expect(footNote(view)).toBeNull();
        for (const note of Object.values(BACKGROUND_NOTES)) expect(view.textContent).not.toContain(note);
        unmount();
      }
    });
  });

  describe('for screen readers', () => {
    it('reads each note once, in place, as plain text: no live region, no name or description that repeats it', () => {
      const { env } = attachEnv();
      const cases: [SessionSummary, string[]][] = [
        [interactive(), [CWD_MISSING_NOTES.interactive]],
        [background(), [CWD_MISSING_NOTES.running, BACKGROUND_NOTES.running]],
        [finished('done'), [CWD_MISSING_NOTES.notRunning, BACKGROUND_NOTES.notRunning]],
        [interactive({ status: 'waiting', waitingFor: 'input needed' }), [WAITING_NOTES.interactive, CWD_MISSING_NOTES.interactive]],
        [background({ status: 'waiting', waitingFor: 'permission prompt' }), [WAITING_NOTES.background, CWD_MISSING_NOTES.running, BACKGROUND_NOTES.running]],
      ];
      for (const [s, notes] of cases) {
        const { view, unmount } = renderView(s, { env });
        for (const note of notes) {
          const found = holding(view, note);
          expect(found).toHaveLength(1);
          const element = found[0]!;
          expect(element.tagName).toBe('P');
          expect(element.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull();
          expect(element.hasAttribute('id')).toBe(false);
          for (const named of view.querySelectorAll('[aria-label], [title]')) {
            expect(`${named.getAttribute('aria-label') ?? ''}${named.getAttribute('title') ?? ''}`).not.toContain(note);
          }
        }
        // "Directory no longer exists" once, and the note doesn't repeat it.
        expect(holding(view, 'Directory no longer exists')).toHaveLength(1);
        expect(cwdNote(view)?.textContent).not.toContain('no longer exists');
        // The footer has no role or name of its own, and the Terminal tab is still just "Terminal", described by nothing.
        const foot = view.querySelector<HTMLElement>('.session-view-foot')!;
        for (const attribute of ['role', 'aria-label', 'aria-labelledby', 'aria-describedby']) expect(foot.hasAttribute(attribute)).toBe(false);
        if (s.kind === 'background') expect(within(view).getByRole('tab', { name: 'Terminal' }).hasAttribute('aria-describedby')).toBe(false);
        unmount();
      }
    });
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
    expect(screen.queryByText(/rejected this tab's token/)).toBeNull();
  });
});
