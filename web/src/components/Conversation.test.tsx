// The conversation (W27, docs/design-system.md, 4: Conversation): each kind of entry and its speaker
// line, folded tool calls and their state across refreshes and "Load earlier", Load earlier's busy
// state and the place it holds, and following new entries: at the bottom, scrolled up with the
// "Jump to latest" bar and its announcement, and under reduced motion. Made-up conversations only.

import { act, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationEntry, ConversationPage, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { AttachContext } from '../attach.js';
import { absoluteTime, clockTime } from '../format.js';
import { NOW, fakeSockets, minutesAgo, session } from '../test/fixtures.js';
import { hover, pass, shownTooltip, tooltipText, unhover } from '../test/tooltips.js';
import { SessionView } from './SessionView.js';

// The Terminal tab's xterm.js, for the tests that open it: it only needs to exist.
vi.mock('../xterm.js', () => ({
  createXterm: () => ({ cols: 80, rows: 24, write() {}, onData() {}, fit() {}, focus() {}, dispose() {} }),
}));

const SID = '00000000-0000-4000-8000-0000000000c7';
const API_KEY = 'k'.repeat(43);
const at = (second: number) => `2026-03-02T11:50:${String(second).padStart(2, '0')}.000Z`;
const you = (second: number, text = `prompt ${second}`): ConversationEntry => ({ kind: 'user', at: at(second), text });
const claude = (second: number, text = `reply ${second}`): ConversationEntry => ({ kind: 'assistant', at: at(second), text });
const tool = (second: number, text: string, toolError = false): ConversationEntry => ({
  kind: 'tool',
  at: at(second),
  text,
  toolName: text.split(':')[0] ?? 'Bash',
  ...(toolError ? { toolError } : {}),
});

const page = (entries: ConversationEntry[], before?: string): ConversationPage =>
  before === undefined ? { sessionId: SID, entries } : { sessionId: SID, entries, before };
const json = (body: ConversationPage) => new Response(JSON.stringify(body), { status: 200 });

/** A fake server whose newest page, and the older page behind each cursor, the test sets as it goes. */
function fakeServer(first: ConversationPage) {
  let newest = first;
  const older = new Map<string, () => Promise<Response>>();
  const fetch = vi.fn<FetchLike>(async (url) => {
    const before = new URL(url, 'http://127.0.0.1').searchParams.get('before');
    if (before === null) return json(newest);
    const answer = older.get(before);
    return answer ? answer() : new Response(null, { status: 410 });
  });
  return {
    fetch,
    newest(next: ConversationPage) {
      newest = next;
    },
    older(cursor: string, next: ConversationPage) {
      older.set(cursor, async () => json(next));
    },
    /** An older page that waits until the test lets it through. */
    olderLater(cursor: string, next: ConversationPage): () => Promise<void> {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      older.set(cursor, async () => {
        await gate;
        return json(next);
      });
      return async () => {
        release();
        await settle();
      };
    },
  };
}

const settle = () => act(async () => {});

function target(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return session({ sessionId: SID, name: 'demo-conversation', lastActivityAt: minutesAgo(5), ...overrides });
}

/** The session view alone, over the app's API client and `server`. `refresh` moves the session's activity, which fetches the newest page again. */
async function renderView(server: ReturnType<typeof fakeServer>, overrides: Partial<SessionSummary> = {}) {
  const api = createApiClient({ apiKey: API_KEY, fetch: server.fetch });
  let current = target(overrides);
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
    async refresh() {
      activity += 1000;
      current = { ...current, lastActivityAt: new Date(activity).toISOString() };
      result.rerender(ui());
      await settle();
    },
  };
}

/** The list's own items, in order: entries and folds. */
const rows = (body: HTMLElement) => [...body.querySelectorAll<HTMLElement>('.conversation > li')];
const folds = (body: HTMLElement) => [...body.querySelectorAll<HTMLButtonElement>('.fold-toggle')];
const lines = (element: Element) => [...element.querySelectorAll('.tool-call-text')].map((line) => line.textContent);
const bar = (body: HTMLElement) => within(body).queryByRole('button', { name: /Jump to latest$/ });
const announced = (body: HTMLElement) => body.querySelector('.visually-hidden[role="status"]')?.textContent;

/** scrollHeight and clientHeight as a laid-out page would have them; happy-dom has no layout. */
function layout(initial: { scrollHeight: number; clientHeight: number }) {
  const sizes = { ...initial };
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => sizes.scrollHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => sizes.clientHeight);
  return sizes;
}

/** The reader scrolls the body to `top`. */
function scrollTo(body: HTMLElement, top: number) {
  body.scrollTop = top;
  fireEvent.scroll(body);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('Conversation: entries', () => {
  it('lists every kind of entry oldest first, each text entry with its speaker line and time, the time whole in a tooltip', async () => {
    const entries: ConversationEntry[] = [
      you(1, 'Add a retry to the export job.'),
      claude(2, 'Reading the job first.'),
      { kind: 'cross-session', at: at(3), from: 'pitwall-test-reviewer', text: 'Please log each retry.' },
      { kind: 'cross-session', at: at(4), text: 'ping' },
      { kind: 'notice', at: at(5), text: 'Conversation compacted.' },
      { ...claude(6, 'A long reply'), truncated: true },
      { kind: 'user', text: 'A prompt with no time.' },
    ];
    const { body } = await renderView(fakeServer(page(entries)));
    const list = body.querySelector('.conversation')!;
    expect(list.tagName).toBe('OL');
    const items = rows(body);
    expect(items.map((item) => item.className)).toEqual([
      'entry entry-user',
      'entry entry-assistant',
      'entry entry-cross-session',
      'entry entry-cross-session',
      'entry entry-notice',
      'entry entry-assistant',
      'entry entry-user',
    ]);
    const speaker = (item: HTMLElement) => item.querySelector('.entry-speaker')?.textContent;
    expect(speaker(items[0]!)).toBe(`You · ${clockTime(at(1))}`);
    expect(speaker(items[1]!)).toBe(`Claude · ${clockTime(at(2))}`);
    expect(speaker(items[2]!)).toBe(`From pitwall-test-reviewer · ${clockTime(at(3))}`);
    expect(speaker(items[3]!)).toBe(`From another session · ${clockTime(at(4))}`);
    // A notice has no speaker, and a time only goes with one.
    expect(items[4]!.querySelector('.entry-speaker, time')).toBeNull();
    expect(speaker(items[6]!)).toBe('You');
    // The time of day alone, from the user's locale, always on screen; the instant in datetime.
    expect(clockTime(at(1))).toMatch(/\d{1,2}[:.]\d{2}/);
    const time = items[0]!.querySelector('time')!;
    expect(time.getAttribute('datetime')).toBe(at(1));
    expect(time.closest('.entry-time')).toBeTruthy();
    expect(await tooltipText(time)).toBe(absoluteTime(at(1)));
    // Cut short: a trailing note, after the text.
    expect(items[5]!.lastElementChild?.className).toBe('entry-cut');
    expect(items[5]!.lastElementChild?.textContent).toBe('Cut short.');
    expect(body.querySelectorAll('.entry-cut')).toHaveLength(1);
  });

  it('renders markup in text, senders, notices and tool calls as text, never as elements', async () => {
    const html = '<b>bold</b> <img src=x onerror="alert(1)"> <script>alert(2)</script>';
    const { body } = await renderView(
      fakeServer(
        page([
          you(1, html),
          { kind: 'cross-session', at: at(2), from: `<i>${html}</i>`, text: html },
          { kind: 'notice', at: at(3), text: html },
          tool(4, `Bash: echo '${html}'`),
          claude(5),
          tool(6, `Read: ${html}`),
          tool(7, `Grep: ${html}`, true),
        ]),
      ),
    );
    expect(body.querySelector('b, i, img, script')).toBeNull();
    expect([...body.querySelectorAll('.entry-text')].map((text) => text.textContent)).toEqual([html, html, html, 'reply 5']);
    expect(body.querySelectorAll('.entry-speaker')[1]!.textContent?.startsWith(`From <i>${html}</i> · `)).toBe(true);
    expect(lines(body)).toEqual([`Bash: echo '${html}'`, `Read: ${html}`, `Grep: ${html}`]);
    expect(body.querySelector('.entry-text')!.innerHTML).toContain('&lt;b&gt;');
  });

  it('opens scrolled to the newest entry', async () => {
    layout({ scrollHeight: 2400, clientHeight: 400 });
    const { body } = await renderView(fakeServer(page(Array.from({ length: 30 }, (_, i) => you(i)))));
    expect(body.scrollTop).toBe(2400);
  });
});

describe('Conversation: folded tool calls', () => {
  const entries = (): ConversationEntry[] => [
    tool(1, 'Read: src/export/job.ts'),
    claude(2),
    tool(3, 'Read: src/export/retry.ts'),
    tool(4, 'Bash: npm test -- export', true),
    tool(5, 'Bash: npm test', true),
    you(6),
    tool(7, 'Grep: retry in src'),
    tool(8, 'Edit: src/export/job.ts'),
    claude(9),
    tool(10, 'Bash: npm run build'),
  ];

  it('folds two or more calls in a row into one toggle, with its error count, and leaves a call on its own unfolded', async () => {
    const { body } = await renderView(fakeServer(page(entries())));
    expect(rows(body).map((item) => item.className)).toEqual([
      'entry entry-tool',
      'entry entry-assistant',
      'entry entry-fold',
      'entry entry-user',
      'entry entry-fold',
      'entry entry-assistant',
      'entry entry-tool',
    ]);
    const [withErrors, clean] = folds(body);
    // A real button, named by its label and its error count, that controls its calls' list.
    expect(withErrors!.tagName).toBe('BUTTON');
    expect(withErrors!.type).toBe('button');
    expect(within(body).getByRole('button', { name: '3 tool calls, 2 errors' })).toBe(withErrors);
    expect(withErrors!.querySelector('.badge-subtle-danger')?.textContent).toBe('2 errors');
    expect(within(body).getByRole('button', { name: '2 tool calls' })).toBe(clean);
    expect(clean!.querySelector('.badge')).toBeNull();
    for (const fold of [withErrors!, clean!]) {
      expect(fold.getAttribute('aria-expanded')).toBe('false');
      const list = document.getElementById(fold.getAttribute('aria-controls')!)!;
      expect(list.tagName).toBe('OL');
      expect(list.hidden).toBe(true);
    }
    // A call on its own is one line, with no toggle.
    expect(lines(rows(body)[0]!)).toEqual(['Read: src/export/job.ts']);
    expect(rows(body)[0]!.querySelector('button')).toBeNull();

    fireEvent.click(withErrors!);
    expect(withErrors!.getAttribute('aria-expanded')).toBe('true');
    const list = document.getElementById(withErrors!.getAttribute('aria-controls')!)!;
    expect(list.hidden).toBe(false);
    expect(lines(list)).toEqual(['Read: src/export/retry.ts', 'Bash: npm test -- export', 'Bash: npm test']);
    // Each failed call has its own error badge.
    expect([...list.children].map((call) => call.querySelector('.badge-subtle-danger')?.textContent ?? null)).toEqual([null, 'error', 'error']);
    expect(clean!.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(withErrors!);
    expect(withErrors!.getAttribute('aria-expanded')).toBe('false');
    expect(list.hidden).toBe(true);
  });

  it('says "1 error" for one, and puts a cut-off line whole in a tooltip, only when it is cut', async () => {
    const long = `Bash: ${'x'.repeat(300)}`;
    const { body } = await renderView(fakeServer(page([tool(1, 'Read: a.ts'), tool(2, long, true)])));
    expect(within(body).getByRole('button', { name: '2 tool calls, 1 error' })).toBeTruthy();
    fireEvent.click(folds(body)[0]!);
    const [short, cut] = [...body.querySelectorAll<HTMLElement>('.tool-call-text')];
    // happy-dom has no layout: give the long line more content than room.
    Object.defineProperty(cut!, 'scrollWidth', { configurable: true, value: 900 });
    Object.defineProperty(cut!, 'clientWidth', { configurable: true, value: 300 });
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ overflowX: 'hidden', getPropertyValue: () => '' }) as unknown as CSSStyleDeclaration);
    expect(cut!.hasAttribute('title')).toBe(false);
    expect((await hover(cut!))?.querySelector('.tooltip-text')?.textContent).toBe(long);
    unhover(cut!);
    await pass(0);
    expect(await hover(short!)).toBeNull();
    unhover(short!);
    expect(shownTooltip()).toBeNull();
  });

  it('stays open or closed across a refresh, and a call joining the newest fold keeps it open', async () => {
    // Two folds, the second the newest thing in the conversation.
    const base = () => entries().slice(0, 8);
    const server = fakeServer(page(base()));
    const view = await renderView(server);
    const [first, second] = folds(view.body);
    fireEvent.click(first!);

    // The same calls, one of them now with its result: nothing changes.
    const withResult = () => base().map((entry, index) => (index === 6 ? { ...entry, toolError: true } : entry));
    server.newest(page(withResult()));
    await view.refresh();
    expect(folds(view.body).map((fold) => fold.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
    expect(folds(view.body)[1]!.getAttribute('aria-label')).toBe('2 tool calls, 1 error');

    // The newest fold opened, then a call joins it.
    fireEvent.click(second!);
    server.newest(page([...withResult(), tool(9, 'Bash: npm test')]));
    await view.refresh();
    expect(folds(view.body).map((fold) => [fold.textContent, fold.getAttribute('aria-expanded')])).toEqual([
      ['3 tool calls2 errors', 'true'],
      ['3 tool calls1 error', 'true'],
    ]);
    expect(lines(document.getElementById(folds(view.body)[1]!.getAttribute('aria-controls')!)!)).toEqual([
      'Grep: retry in src',
      'Edit: src/export/job.ts',
      'Bash: npm test',
    ]);

    // Closed again, it stays closed.
    fireEvent.click(folds(view.body)[0]!);
    await view.refresh();
    expect(folds(view.body).map((fold) => fold.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
  });

  it('stays open across Load earlier, even when older calls join it at its start, and a closed one stays closed', async () => {
    const server = fakeServer(page([tool(10, 'Read: b.ts'), tool(11, 'Read: c.ts'), claude(12), tool(13, 'Bash: ls'), tool(14, 'Bash: pwd')], 'c1'));
    server.older('c1', page([you(1), tool(2, 'Read: a.ts', true)]));
    const view = await renderView(server);
    fireEvent.click(folds(view.body)[0]!);

    fireEvent.click(within(view.body).getByRole('button', { name: 'Load earlier' }));
    await settle();

    const [joined, closed] = folds(view.body);
    expect(joined!.getAttribute('aria-label')).toBe('3 tool calls, 1 error');
    expect(joined!.getAttribute('aria-expanded')).toBe('true');
    expect(lines(document.getElementById(joined!.getAttribute('aria-controls')!)!)).toEqual(['Read: a.ts', 'Read: b.ts', 'Read: c.ts']);
    expect(closed!.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('Conversation: Load earlier', () => {
  it('is an outline sm button at the top, busy while it loads, and holds the place as older entries arrive above', async () => {
    // 200 px an entry, and 600 px for the rest, as laid out: two entries make 1,000 px.
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return 600 + this.querySelectorAll('.conversation > li').length * 200;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    const server = fakeServer(page([you(10), claude(11)], 'c1'));
    const release = server.olderLater('c1', page([you(1), claude(2), you(3)]));
    const { body } = await renderView(server);

    const button = within(body).getByRole('button', { name: 'Load earlier' });
    expect(body.firstElementChild).toBe(button);
    expect(button.className).toBe('button sm load-earlier');
    // The reader has scrolled up to it.
    scrollTo(body, 40);
    fireEvent.click(button);
    await settle();
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toBe('Loading earlier…');
    // Clicking again while it's busy asks for nothing more.
    fireEvent.click(button);
    expect(server.fetch).toHaveBeenCalledTimes(2);

    // Three entries arrive above: 600 px more. The entries the reader was looking at stay where they were.
    expect(body.scrollHeight).toBe(1000);
    await release();
    expect(body.scrollHeight).toBe(1600);
    expect(body.scrollTop).toBe(640);
    expect(within(body).queryByRole('button', { name: 'Load earlier' })).toBeNull();
    expect([...body.querySelectorAll('.entry-text')].map((text) => text.textContent)).toEqual(['prompt 1', 'reply 2', 'prompt 3', 'prompt 10', 'reply 11']);
  });
});

describe('Conversation: following new entries', () => {
  /** A conversation of `count` prompts, newest page only. */
  const prompts = (count: number) => Array.from({ length: count }, (_, i) => you(i));

  /** Counts the times the announcement's text changes, which is what a screen reader reads out. */
  function announcements(body: HTMLElement) {
    const region = body.querySelector('.visually-hidden[role="status"]')!;
    const said: string[] = [];
    const observer = new MutationObserver(() => {
      const text = region.textContent ?? '';
      if (text !== '' && text !== said.at(-1)) said.push(text);
    });
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    return { said, stop: () => observer.disconnect() };
  }

  it('at the bottom, keeps it at the bottom: no bar, and nothing announced', async () => {
    const sizes = layout({ scrollHeight: 1000, clientHeight: 400 });
    const server = fakeServer(page(prompts(3)));
    const view = await renderView(server);
    expect(view.body.scrollTop).toBe(1000);
    // Within 24 px of the bottom counts.
    scrollTo(view.body, 580);
    server.newest(page(prompts(5)));
    sizes.scrollHeight = 1200;
    await view.refresh();
    expect(view.body.scrollTop).toBe(1200);
    expect(bar(view.body)).toBeNull();
    expect(announced(view.body)).toBe('');
  });

  it('scrolled up, keeps the place, counts what arrived, shows the bar, and announces the count once per batch', async () => {
    const sizes = layout({ scrollHeight: 1000, clientHeight: 400 });
    const server = fakeServer(page([...prompts(3), claude(20, 'Part one.')]));
    const view = await renderView(server);
    scrollTo(view.body, 100);
    const heard = announcements(view.body);

    server.newest(page([...prompts(3), claude(20, 'Part one.'), you(21), you(22)]));
    sizes.scrollHeight = 1300;
    await view.refresh();
    expect(view.body.scrollTop).toBe(100);
    const shown = bar(view.body)!;
    expect(shown.textContent).toBe('2 new · Jump to latest');
    expect(shown.tagName).toBe('BUTTON');
    expect(shown.closest('.jump-latest')?.parentElement).toBe(view.body);
    expect(announced(view.body)).toBe('2 new');

    // A message that grew, and nothing else, is nothing new.
    server.newest(page([...prompts(3), claude(20, 'Part one.\nPart two.'), you(21), you(22)]));
    await view.refresh();
    expect(bar(view.body)!.textContent).toBe('2 new · Jump to latest');

    server.newest(page([...prompts(3), claude(20, 'Part one.\nPart two.'), you(21), you(22), you(23)]));
    await view.refresh();
    expect(bar(view.body)!.textContent).toBe('3 new · Jump to latest');
    await settle();
    heard.stop();
    // Once per batch, as a count, never per entry and never their text.
    expect(heard.said).toEqual(['2 new', '3 new']);
  });

  it('jumps to the latest smoothly, then goes, with focus on the bar moved to the conversation', async () => {
    const sizes = layout({ scrollHeight: 1000, clientHeight: 400 });
    const server = fakeServer(page(prompts(3)));
    const view = await renderView(server);
    scrollTo(view.body, 100);
    server.newest(page(prompts(4)));
    sizes.scrollHeight = 1200;
    await view.refresh();
    const scroll = vi.fn();
    view.body.scrollTo = scroll as unknown as HTMLElement['scrollTo'];

    const shown = bar(view.body)!;
    shown.focus();
    fireEvent.click(shown);
    await settle();
    expect(scroll).toHaveBeenCalledWith({ top: 1200, behavior: 'smooth' });
    expect(bar(view.body)).toBeNull();
    expect(announced(view.body)).toBe('');
    expect(document.activeElement).toBe(view.body);

    // On its way down, the positions it passes through aren't the reader's: a batch arriving meanwhile is followed.
    scrollTo(view.body, 700);
    server.newest(page(prompts(5)));
    sizes.scrollHeight = 1400;
    await view.refresh();
    expect(view.body.scrollTop).toBe(1400);
    expect(bar(view.body)).toBeNull();
  });

  it("doesn't animate the jump under reduced motion", async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query }) as MediaQueryList);
    const sizes = layout({ scrollHeight: 1000, clientHeight: 400 });
    const server = fakeServer(page(prompts(3)));
    const view = await renderView(server);
    scrollTo(view.body, 100);
    server.newest(page(prompts(4)));
    sizes.scrollHeight = 1200;
    await view.refresh();
    const scroll = vi.fn();
    view.body.scrollTo = scroll as unknown as HTMLElement['scrollTo'];
    fireEvent.click(bar(view.body)!);
    expect(scroll).toHaveBeenCalledWith({ top: 1200, behavior: 'auto' });

    // And the reader's own scrolling counts at once: scrolled up, new entries are counted again.
    scrollTo(view.body, 300);
    server.newest(page(prompts(5)));
    await view.refresh();
    expect(bar(view.body)!.textContent).toBe('1 new · Jump to latest');
  });

  it('goes when the reader gets to the bottom by any other means: scrolling there, or a fold closing above', async () => {
    const sizes = layout({ scrollHeight: 1000, clientHeight: 400 });
    const server = fakeServer(page([tool(1, 'Read: a.ts'), tool(2, 'Read: b.ts'), ...prompts(3)]));
    const view = await renderView(server);
    scrollTo(view.body, 100);
    server.newest(page([tool(1, 'Read: a.ts'), tool(2, 'Read: b.ts'), ...prompts(4)]));
    sizes.scrollHeight = 1200;
    await view.refresh();
    expect(bar(view.body)).toBeTruthy();

    scrollTo(view.body, 790);
    expect(bar(view.body)).toBeNull();

    // Scrolled up again, more arrives; then a fold that was open closes, and the end is in view without a scroll.
    fireEvent.click(folds(view.body)[0]!);
    scrollTo(view.body, 500);
    server.newest(page([tool(1, 'Read: a.ts'), tool(2, 'Read: b.ts'), ...prompts(5)]));
    sizes.scrollHeight = 1400;
    await view.refresh();
    expect(bar(view.body)!.textContent).toBe('1 new · Jump to latest');
    sizes.scrollHeight = 900;
    fireEvent.click(folds(view.body)[0]!);
    expect(bar(view.body)).toBeNull();
  });
});

describe('Conversation: across the Terminal tab (W29)', () => {
  /**
   * Layout as a browser has it: a hidden panel (display: none, behind the Terminal tab) has no size,
   * and the browser may drop its scroll position. ResizeObserver fires as it hides and shows.
   */
  function browserLayout(initial: { scrollHeight: number; clientHeight: number }) {
    const sizes = { ...initial };
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.closest('[hidden]') ? 0 : sizes.scrollHeight;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.closest('[hidden]') ? 0 : sizes.clientHeight;
    });
    const callbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const resized = () => act(() => callbacks.forEach((callback) => callback([], {} as ResizeObserver)));
    return { sizes, resized };
  }

  /** A background session's view, which can attach, so its Terminal tab opens. */
  async function renderBackground(server: ReturnType<typeof fakeServer>) {
    const api = createApiClient({ apiKey: API_KEY, fetch: server.fetch });
    const env = { token: 'pitwall-test-token', host: '127.0.0.1:4517', createSocket: fakeSockets().factory };
    let current = target({ kind: 'background', shortId: 'bg00c7', state: 'working' });
    let activity = Date.parse(current.lastActivityAt ?? minutesAgo(5));
    const ui = () => (
      <ApiContext.Provider value={api}>
        <AttachContext.Provider value={env}>
          <SessionView session={current} listed onClose={() => {}} />
        </AttachContext.Provider>
      </ApiContext.Provider>
    );
    const result = render(ui());
    await settle();
    const body = result.container.querySelector<HTMLElement>('.session-view-body')!;
    const tab = (name: string) => within(result.container).getByRole('tab', { name: new RegExp(`^${name}`) });
    return {
      body,
      async open(name: 'Conversation' | 'Terminal') {
        fireEvent.click(tab(name));
        await settle();
      },
      async refresh() {
        activity += 1000;
        current = { ...current, lastActivityAt: new Date(activity).toISOString() };
        result.rerender(ui());
        await settle();
      },
    };
  }

  const prompts = (count: number) => Array.from({ length: count }, (_, i) => you(i));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps a scrolled-up place, even when the browser drops it while the panel is hidden', async () => {
    const { resized } = browserLayout({ scrollHeight: 1000, clientHeight: 400 });
    const view = await renderBackground(fakeServer(page(prompts(6))));
    expect(view.body.scrollTop).toBe(1000);
    scrollTo(view.body, 100);

    await view.open('Terminal');
    expect(view.body.hidden).toBe(true);
    // Hidden, it has no size, and the browser may reset its scroll position.
    view.body.scrollTop = 0;
    resized();

    await view.open('Conversation');
    expect(view.body.hidden).toBe(false);
    expect(view.body.scrollTop).toBe(100);
    resized();
    expect(view.body.scrollTop).toBe(100);
    expect(bar(view.body)).toBeNull();
  });

  it('keeps the place, and counts what arrived while the Terminal tab was open', async () => {
    const { sizes, resized } = browserLayout({ scrollHeight: 1000, clientHeight: 400 });
    const server = fakeServer(page(prompts(6)));
    const view = await renderBackground(server);
    scrollTo(view.body, 100);

    await view.open('Terminal');
    view.body.scrollTop = 0;
    resized();
    server.newest(page(prompts(8)));
    sizes.scrollHeight = 1200;
    await view.refresh();

    await view.open('Conversation');
    resized();
    expect(view.body.scrollTop).toBe(100);
    expect(bar(view.body)!.textContent).toBe('2 new · Jump to latest');
  });

  it('at the bottom, comes back at the bottom, with what arrived meanwhile', async () => {
    const { sizes, resized } = browserLayout({ scrollHeight: 1000, clientHeight: 400 });
    const server = fakeServer(page(prompts(6)));
    const view = await renderBackground(server);
    expect(view.body.scrollTop).toBe(1000);

    await view.open('Terminal');
    view.body.scrollTop = 0;
    resized();
    server.newest(page(prompts(8)));
    sizes.scrollHeight = 1200;
    await view.refresh();

    await view.open('Conversation');
    expect(view.body.scrollTop).toBe(1200);
    resized();
    expect(view.body.scrollTop).toBe(1200);
    expect(bar(view.body)).toBeNull();
  });
});
