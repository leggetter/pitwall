// The message box's draft through a reload (W44): kept in the tab's sessionStorage under
// pitwall.draft.v1:<sessionId>, one per conversation, written as it's typed and cleared by the rule
// that clears the box; a send that was out when the page went comes back with a warning; storage that
// throws leaves the box working from memory; and the view's guards hold a restored draft as they hold
// a typed one. A reload is the dashboard unmounted and rendered again on the same URL, as the page
// would be. Made-up sessions and messages only.

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexSnapshot, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import type { ConnectionView } from '../connection.js';
import { draftKey } from '../drafts.js';
import type { StorageSource } from '../groupState.js';
import { group, NOW, session, snapshot } from '../test/fixtures.js';
import { fakeHistory } from '../test/history.js';
import { descriptionOf } from '../test/tooltips.js';
import { Dashboard } from './Dashboard.js';

const API_KEY = 'k'.repeat(43);
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000a2';
const BG = '00000000-0000-4000-8000-0000000000b1';
const NAME_A = 'pitwall-test-a';
const NAME_B = 'pitwall-test-b';
const DRAFT = 'A made-up draft for a.\nIt has two lines.';
const CHECK = 'Check its conversation before sending again.';

function sessions(overrides: Partial<SessionSummary> = {}): SessionSummary[] {
  return [
    session({ sessionId: A, name: NAME_A, ...overrides }),
    session({ sessionId: B, name: NAME_B }),
    session({ sessionId: BG, name: 'pitwall-test-bg', kind: 'background', shortId: 'b3899da0', state: 'working', status: undefined }),
  ];
}
const snap = (list: SessionSummary[] = sessions()): IndexSnapshot => snapshot([group({ sessions: list })]);

type Answer = { status: number; body?: unknown } | Error | 'hang';

/** POSTs get the next answer, the last one again after that; GETs (the conversation) an empty page. */
function fakeServer(...answers: Answer[]) {
  let call = 0;
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method !== 'POST') {
      const sessionId = decodeURIComponent(/\/api\/sessions\/([^/]+)\//.exec(url)?.[1] ?? '');
      return new Response(JSON.stringify({ sessionId, entries: [] }), { status: 200 });
    }
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (answer === undefined) throw new Error('no answer');
    if (answer === 'hang') return new Promise<Response>(() => {});
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? 'not json' : JSON.stringify(answer.body), { status: answer.status });
  });
}
const posts = (fetch: ReturnType<typeof fakeServer>) => fetch.mock.calls.filter(([, init]) => init.method === 'POST');

/** Where the dashboard keeps its own UI state: never the drafts, which are the tab's sessionStorage. */
function memory(): StorageSource {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
  return () => storage;
}

/** The page, at `search`. `reload()` unmounts it and renders it again at the URL it's at now, as a reload would. */
function renderPage(fetch: FetchLike, first: IndexSnapshot = snap(), search = '?view=all') {
  let history = fakeHistory(search);
  const api = createApiClient({ apiKey: API_KEY, fetch });
  const storage = memory();
  const ui = (s: IndexSnapshot) => {
    const view: ConnectionView = { state: 'live', snapshot: s };
    return (
      <ApiContext.Provider value={api}>
        <Dashboard view={view} navigation={history.navigation} storage={storage} />
      </ApiContext.Provider>
    );
  };
  let result = render(ui(first));
  let shown = first;
  return {
    get history() {
      return history;
    },
    update: (next: IndexSnapshot) => {
      shown = next;
      result.rerender(ui(next));
    },
    reload: async (next: IndexSnapshot = shown) => {
      const at = history.location.search;
      result.unmount();
      history = fakeHistory(at);
      shown = next;
      result = render(ui(next));
      await settle();
    },
  };
}

const settle = () => act(async () => {});

function press(key: string, target: Element | null = document.activeElement): boolean {
  let unhandled = true;
  act(() => {
    unhandled = fireEvent.keyDown(target ?? document.body, { key });
  });
  return unhandled;
}

const view = () => (document.getElementById('session-view') as HTMLElement | null) ?? undefined;
const viewName = () => view()?.querySelector('.session-view-name')?.textContent ?? undefined;
const rowButton = (name: string) => within(screen.getByRole('main')).getByRole('button', { name });
const textarea = (name = NAME_A) => within(view()!).getByRole('textbox', { name: `Message to ${name}` }) as HTMLTextAreaElement;
const sendButton = () => within(view()!).getByRole('button', { name: 'Send' });
const unsure = () => view()?.querySelector('.relay-unsure') ?? null;
const heading = () => document.getElementById(view()!.getAttribute('aria-labelledby')!)!;
// The tab's real sessionStorage, which the steps below read and write directly, even while the page's
// window.sessionStorage is replaced by one that fails.
const tab = window.sessionStorage;
const stored = (sessionId = A) => {
  const raw = tab.getItem(draftKey(sessionId));
  return raw === null ? null : (JSON.parse(raw) as unknown);
};
const keep = (value: unknown, sessionId = A) => tab.setItem(draftKey(sessionId), JSON.stringify(value));
const draftKeys = () => Object.keys(tab).filter((key) => key.startsWith('pitwall.draft.'));

/** What window.sessionStorage was before a test replaced it, put back after each. */
const ownSessionStorage = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
/**
 * The tab's storage with some of its methods replaced. A plain object: one made with the real
 * storage as its prototype would hand every property set on it to that storage, as a named item.
 */
function storageLike(methods: Partial<Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>>): Storage {
  const like = {
    getItem: (key: string) => tab.getItem(key),
    setItem: (key: string, value: string) => tab.setItem(key, value),
    removeItem: (key: string) => tab.removeItem(key),
    clear: () => tab.clear(),
    key: (index: number) => tab.key(index),
    get length() {
      return tab.length;
    },
    ...methods,
  };
  return like as Storage;
}

/** Replaces the page's window.sessionStorage, as a browser that blocks it, or fills up, would. */
function failSessionStorage(get: () => Storage): void {
  Object.defineProperty(window, 'sessionStorage', { configurable: true, get });
}

async function open(name = NAME_A) {
  fireEvent.click(rowButton(name));
  await settle();
}

function type(value: string, name = NAME_A) {
  fireEvent.change(textarea(name), { target: { value } });
}

async function sendDraft(value: string) {
  type(value);
  fireEvent.click(sendButton());
  await settle();
}

/** The window's width, which the layout follows. */
function setWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  if (ownSessionStorage) Object.defineProperty(window, 'sessionStorage', ownSessionStorage);
  else delete (window as { sessionStorage?: Storage }).sessionStorage;
});

describe('a draft, through a reload (W44)', () => {
  it('is back after a reload with ?session= open, and another session’s box is empty', async () => {
    const page = renderPage(fakeServer({ status: 200, body: { status: 'delivered' } }));
    await open();
    type(DRAFT);
    await page.reload();
    expect(page.history.location.search).toContain(`session=${A}`);
    expect(viewName()).toBe(NAME_A);
    expect(textarea().value).toBe(DRAFT);

    fireEvent.click(within(view()!).getByRole('button', { name: 'Close' }));
    await settle();
    await open(NAME_B);
    expect(textarea(NAME_B).value).toBe('');
    expect(draftKeys()).toEqual([draftKey(A)]);
  });

  it('is back when its session is opened again later in the tab, after Close', async () => {
    renderPage(fakeServer({ status: 200, body: { status: 'delivered' } }));
    await open();
    type(DRAFT);
    fireEvent.click(within(view()!).getByRole('button', { name: 'Close' }));
    await settle();
    expect(view()).toBeUndefined();
    await open();
    expect(textarea().value).toBe(DRAFT);
  });

  it('never shows in another session’s box: each conversation has its own', async () => {
    keep({ v: 1, text: 'A made-up draft for b.' }, B);
    renderPage(fakeServer({ status: 200, body: { status: 'delivered' } }), snap(), `?view=all&session=${A}`);
    await settle();
    expect(textarea().value).toBe('');
    type(DRAFT);
    expect(stored(A)).toEqual({ v: 1, text: DRAFT });
    expect(stored(B)).toEqual({ v: 1, text: 'A made-up draft for b.' });
  });

  it('is written on each change, in the same event, and removed when the box empties', async () => {
    renderPage(fakeServer({ status: 200, body: { status: 'delivered' } }));
    await open();
    type('A');
    expect(stored()).toEqual({ v: 1, text: 'A' });
    type('A m');
    expect(stored()).toEqual({ v: 1, text: 'A m' });
    // Whitespace alone is a draft, as Escape treats it.
    type('  ');
    expect(stored()).toEqual({ v: 1, text: '  ' });
    type('');
    expect(stored()).toBeNull();
    expect(draftKeys()).toEqual([]);
  });

  it.each([
    ['delivered', undefined],
    ['held', 'Held by that session.'],
    ['refused', 'Refused by its settings.'],
  ])('is removed when the message is %s, as the box clears, and a reload brings nothing back', async (status, detail) => {
    const page = renderPage(fakeServer({ status: 200, body: detail === undefined ? { status } : { status, detail } }));
    await open();
    await sendDraft(DRAFT);
    expect(textarea().value).toBe('');
    expect(stored()).toBeNull();
    await page.reload();
    expect(textarea().value).toBe('');
    expect(unsure()).toBeNull();
  });

  it('is kept, with nothing to warn about, when the relay says it wasn’t sent, or pitwall refused the request', async () => {
    const page = renderPage(fakeServer({ status: 200, body: { status: 'failed', detail: 'No live session has that name.' } }, { status: 403 }));
    await open();
    await sendDraft(DRAFT);
    expect(stored()).toEqual({ v: 1, text: DRAFT });
    await sendDraft(DRAFT);
    expect(within(view()!).getByRole('alert').textContent).toBe('Not sent: pitwall refused the request (HTTP 403).');
    expect(stored()).toEqual({ v: 1, text: DRAFT });
    await page.reload();
    expect(textarea().value).toBe(DRAFT);
    expect(unsure()).toBeNull();
  });

  it.each([
    ["the relay's uncertain", { status: 200, body: { status: 'uncertain', detail: 'The relay stopped.' } }],
    ["pitwall's no answer", new TypeError('network down')],
    ['a server error', { status: 502 }],
  ] as const)('is kept, with when it went, when it may have reached the session: %s', async (_, answer) => {
    renderPage(fakeServer(answer));
    await open();
    await sendDraft(DRAFT);
    expect(textarea().value).toBe(DRAFT);
    expect(stored()).toEqual({ v: 1, text: DRAFT, send: { at: new Date(NOW).toISOString(), state: 'uncertain' } });
  });
});

describe('a send that was out when the page went (W44)', () => {
  it('is kept as out, with its time, before the request goes', async () => {
    renderPage(fakeServer('hang'));
    await open();
    type(DRAFT);
    fireEvent.click(sendButton());
    expect(stored()).toEqual({ v: 1, text: DRAFT, send: { at: new Date(NOW).toISOString(), state: 'out' } });
    await settle();
    expect(within(view()!).getByRole('button', { name: 'Sending…' })).toBeTruthy();
  });

  it('comes back after a reload with the draft and a warning to check before sending it again, and sends nothing by itself', async () => {
    const server = fakeServer('hang');
    const page = renderPage(server);
    await open();
    await sendDraft(DRAFT);
    expect(posts(server)).toHaveLength(1);
    vi.setSystemTime(NOW + 2 * 60_000);
    await page.reload();
    expect(textarea().value).toBe(DRAFT);
    const note = unsure() as HTMLElement;
    expect(note.textContent).toBe(
      `pitwall started sending this 2m ago, but the page reloaded or the view closed before it had an answer, so it may have reached the session. ${CHECK}`,
    );
    // The uncertain look, a warning, with no role: it was there when the box appeared.
    expect(note.className).toBe('inline-alert warning relay-result relay-unsure');
    expect(note.hasAttribute('role')).toBe(false);
    expect(note.querySelector('time')?.getAttribute('datetime')).toBe(new Date(NOW).toISOString());
    // Read with the text box, before anything else that describes it.
    const describedBy = textarea().getAttribute('aria-describedby')!.split(' ');
    expect(document.getElementById(describedBy[0]!)?.textContent).toBe(note.textContent);
    // Send is as it is for any draft: no easier, and nothing went out by itself.
    expect(sendButton().hasAttribute('aria-disabled')).toBe(false);
    expect(within(view()!).queryByRole('button', { name: /again|resend/i })).toBeNull();
    expect(posts(server)).toHaveLength(1);
    // Still there, and still saying so, after another reload.
    await page.reload();
    expect(unsure()?.textContent).toContain('pitwall started sending this 2m ago');
  });

  it('goes once the draft is edited, here and in storage', async () => {
    const page = renderPage(fakeServer('hang'));
    await open();
    await sendDraft(DRAFT);
    await page.reload();
    expect(unsure()).not.toBeNull();
    type(`${DRAFT} Edited.`);
    expect(unsure()).toBeNull();
    expect(stored()).toEqual({ v: 1, text: `${DRAFT} Edited.` });
    expect(textarea().getAttribute('aria-describedby')!.split(' ')).toHaveLength(1);
    await page.reload();
    expect(unsure()).toBeNull();
  });

  it('goes once the draft is sent again, which is kept as out from its own time', async () => {
    let answer: (response: Response) => void = () => {};
    let call = 0;
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      if (init.method !== 'POST') return new Response(JSON.stringify({ sessionId: A, entries: [] }), { status: 200 });
      call += 1;
      return call === 1 ? new Promise<Response>(() => {}) : new Promise<Response>((resolve) => (answer = resolve));
    });
    const page = renderPage(fetch);
    await open();
    await sendDraft(DRAFT);
    vi.setSystemTime(NOW + 5 * 60_000);
    await page.reload();
    expect(unsure()).not.toBeNull();
    fireEvent.click(sendButton());
    await settle();
    expect(unsure()).toBeNull();
    expect(stored()).toEqual({ v: 1, text: DRAFT, send: { at: new Date(NOW + 5 * 60_000).toISOString(), state: 'out' } });
    answer(new Response(JSON.stringify({ status: 'delivered' }), { status: 200 }));
    await settle();
    expect(stored()).toBeNull();
    expect(textarea().value).toBe('');
  });

  it('comes back the same way when the view closed while it was out, opened again later in the tab', async () => {
    renderPage(fakeServer('hang'));
    await open();
    await sendDraft(DRAFT);
    fireEvent.click(within(view()!).getByRole('button', { name: 'Close' }));
    await settle();
    await open();
    expect(textarea().value).toBe(DRAFT);
    expect(unsure()?.textContent).toContain('pitwall started sending this just now, but the page reloaded or the view closed');
  });

  it('after an uncertain answer, then a reload: the same warning, in its own words', async () => {
    const page = renderPage(fakeServer({ status: 200, body: { status: 'uncertain', detail: 'The relay stopped.' } }));
    await open();
    await sendDraft(DRAFT);
    vi.setSystemTime(NOW + 3 * 60_000);
    await page.reload();
    expect(textarea().value).toBe(DRAFT);
    expect(unsure()?.textContent).toBe(`pitwall tried to send this 3m ago and couldn't tell whether it reached the session. ${CHECK}`);
    expect(unsure()?.className).toContain('warning');
  });
});

describe('storage that fails (W44)', () => {
  const blocked = () => new DOMException('The operation is insecure.', 'SecurityError');

  it('leaves the box working from memory, with no notice and no error, when sessionStorage can’t be reached at all', async () => {
    const errors = vi.spyOn(console, 'error');
    failSessionStorage(() => {
      throw blocked();
    });
    const page = renderPage(fakeServer({ status: 200, body: { status: 'failed', detail: 'Not today.' } }, { status: 200, body: { status: 'delivered' } }));
    await open();
    expect(textarea().value).toBe('');
    type(DRAFT);
    expect(textarea().value).toBe(DRAFT);
    await sendDraft(DRAFT);
    expect(textarea().value).toBe(DRAFT);
    await sendDraft(DRAFT);
    expect(textarea().value).toBe('');
    expect(view()!.querySelector('.relay-box')!.textContent).not.toMatch(/stor|reload/i);
    expect(errors).not.toHaveBeenCalled();
    // As before W44, a reload then brings nothing back.
    type(DRAFT);
    await page.reload();
    expect(textarea().value).toBe('');
  });

  it('reads no draft when getItem throws, and still keeps one when it can write', async () => {
    keep({ v: 1, text: DRAFT });
    failSessionStorage(() =>
      storageLike({
        getItem: () => {
          throw blocked();
        },
      }),
    );
    renderPage(fakeServer({ status: 200, body: { status: 'delivered' } }));
    await open();
    expect(textarea().value).toBe('');
    type('Typed again.');
    expect(stored()).toEqual({ v: 1, text: 'Typed again.' });
  });

  it('keeps typing and sending when a write throws, as over quota, and leaves no older copy to come back', async () => {
    keep({ v: 1, text: 'An older copy.' });
    const errors = vi.spyOn(console, 'error');
    failSessionStorage(() =>
      storageLike({
        setItem: (key: string, value: string) => {
          if (key.startsWith('pitwall.draft.')) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          tab.setItem(key, value);
        },
      }),
    );
    const page = renderPage(fakeServer({ status: 200, body: { status: 'delivered' } }));
    await open();
    expect(textarea().value).toBe('An older copy.');
    type('The newer copy.');
    expect(textarea().value).toBe('The newer copy.');
    expect(stored()).toBeNull();
    await page.reload();
    expect(textarea().value).toBe('');
    await sendDraft(DRAFT);
    expect(textarea().value).toBe('');
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('the view’s guards, with a restored draft (W44)', () => {
  it('hold it as they hold a typed one: Escape keeps the view, and j and k don’t change session', async () => {
    keep({ v: 1, text: DRAFT });
    const page = renderPage(fakeServer({ status: 200, body: { status: 'delivered' } }), snap(), `?view=all&session=${A}`);
    await settle();
    expect(textarea().value).toBe(DRAFT);
    const entries = [...page.history.entries];
    press('Escape', document.body);
    await settle();
    expect(viewName()).toBe(NAME_A);
    (document.activeElement as HTMLElement | null)?.blur();
    expect(press('j', document.body)).toBe(true);
    expect(press('k', document.body)).toBe(true);
    await settle();
    expect(viewName()).toBe(NAME_A);
    expect(page.history.entries).toEqual(entries);
    expect(textarea().value).toBe(DRAFT);

    // Cleared, they work again.
    type('');
    press('Escape', heading());
    await settle();
    expect(view()).toBeUndefined();
  });

  it('hold it below 1,200 px, where / would close the view over the list', async () => {
    setWidth(1100);
    keep({ v: 1, text: DRAFT });
    renderPage(fakeServer({ status: 200, body: { status: 'delivered' } }), snap(), `?view=all&session=${A}`);
    await settle();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(press('/', document.body)).toBe(true);
    await settle();
    expect(viewName()).toBe(NAME_A);
    expect(textarea().value).toBe(DRAFT);
  });

  it('show the kept note when a restored draft’s session has stopped running', async () => {
    keep({ v: 1, text: DRAFT });
    renderPage(fakeServer({ status: 200, body: { status: 'delivered' } }), snap(sessions({ alive: false, pid: undefined, status: undefined })), `?view=all&session=${A}`);
    await settle();
    expect(textarea().value).toBe(DRAFT);
    expect(view()!.querySelector('.relay-kept')?.textContent).toBe("It isn't running any more, so this can't be sent. Your text stays here until you clear it.");
    expect(descriptionOf(sendButton())).toBe("It isn't running, so it can't be messaged.");
  });

  it('keep the footer for it in a view opened again after its session left the list, with that note', async () => {
    const page = renderPage(fakeServer({ status: 200, body: { status: 'delivered' } }));
    await open();
    type(DRAFT);
    page.update(snap(sessions().filter((s) => s.sessionId !== A)));
    await settle();
    fireEvent.click(within(view()!).getByRole('button', { name: 'Close' }));
    await settle();
    expect(view()).toBeUndefined();
    page.history.back();
    await settle();
    expect(viewName()).toBe(NAME_A);
    expect(view()!.querySelector('.session-view-head')?.textContent).toContain('This session is no longer listed');
    expect(textarea().value).toBe(DRAFT);
    expect(view()!.querySelector('.relay-kept')?.textContent).toBe("It's no longer listed, so this can't be sent. Your text stays here until you clear it.");
    // And Escape still keeps it.
    press('Escape', document.body);
    await settle();
    expect(viewName()).toBe(NAME_A);
  });
});

describe('where the text goes (W44)', () => {
  it('nowhere but its own key: not localStorage, not the URL', async () => {
    const page = renderPage(fakeServer({ status: 200, body: { status: 'failed', detail: 'Not today.' } }), snap(), '?view=all');
    await open();
    type(DRAFT);
    await sendDraft(DRAFT);
    const urls = [...page.history.entries];
    await page.reload();
    expect(textarea().value).toBe(DRAFT);
    expect(window.localStorage.length).toBe(0);
    expect(draftKeys()).toEqual([draftKey(A)]);
    expect(Object.keys(tab).filter((key) => tab.getItem(key)?.includes('made-up draft'))).toEqual([draftKey(A)]);
    expect([...urls, ...page.history.entries].some((entry) => /draft|made-up/i.test(decodeURIComponent(entry)))).toBe(false);
  });

  it('isn’t pruned when its session is missing from a snapshot, as after a failed poll', async () => {
    const page = renderPage(fakeServer({ status: 200, body: { status: 'delivered' } }));
    await open();
    type(DRAFT);
    page.update(snapshot([]));
    await settle();
    expect(stored()).toEqual({ v: 1, text: DRAFT });
    await page.reload(snap());
    expect(textarea().value).toBe(DRAFT);
  });
});
