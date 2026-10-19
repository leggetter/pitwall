import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { relayPath, type IndexSnapshot, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import type { ConnectionView } from '../connection.js';
import { group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { Dashboard } from './Dashboard.js';

// Made-up sessions and messages only.

const API_KEY = 'k'.repeat(43);
const INTERACTIVE = '00000000-0000-4000-8000-0000000000a1';
const BG = '00000000-0000-4000-8000-0000000000b1';
const NAME = 'pitwall-test-interactive';
const LIMITS =
  "Starts a turn on that session's model. The session sees it as a message from another session, not from you, so it can't approve prompts.";

function interactive(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return session({ sessionId: INTERACTIVE, name: NAME, ...overrides });
}

function snap(target: SessionSummary = interactive()): IndexSnapshot {
  return snapshot([
    group({ sessions: [target, session({ sessionId: BG, name: 'pitwall-test-bg', kind: 'background', shortId: 'b3899da0', state: 'working' })] }),
  ]);
}

type Answer = { status: number; body?: unknown } | Error;

/** POSTs get the next answer; GETs (the conversation) get an empty page. */
function fakeServer(...answers: Answer[]) {
  let call = 0;
  return vi.fn<FetchLike>(async (url, init) => {
    if (init.method !== 'POST') {
      const sessionId = decodeURIComponent(/\/api\/sessions\/([^/]+)\//.exec(url)?.[1] ?? '');
      return new Response(JSON.stringify({ sessionId, entries: [] }), { status: 200 });
    }
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    if (!answer) throw new Error('no answer');
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? 'not json' : JSON.stringify(answer.body), { status: answer.status });
  });
}

const posts = (fetch: ReturnType<typeof fakeServer>) =>
  fetch.mock.calls.filter(([, init]) => init.method === 'POST').map(([url, init]) => ({ url, body: JSON.parse(String(init.body)) as unknown }));

function renderDashboard(fetch: FetchLike, first: IndexSnapshot = snap()) {
  const api = createApiClient({ apiKey: API_KEY, fetch });
  const ui = (s: IndexSnapshot) => {
    const view: ConnectionView = { state: 'live', snapshot: s };
    return (
      <ApiContext.Provider value={api}>
        <Dashboard view={view} />
      </ApiContext.Provider>
    );
  };
  const result = render(ui(first));
  for (const toggle of result.container.querySelectorAll<HTMLElement>('.group-toggle[aria-expanded="false"]')) fireEvent.click(toggle);
  return { ...result, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

const settle = () => act(async () => {});

async function openView(name = NAME): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name }));
  await settle();
  return screen.getByRole('dialog', { name });
}

function box(view: HTMLElement): HTMLElement {
  return within(view).getByRole('region', { name: 'Message this session' });
}

function textarea(view: HTMLElement): HTMLTextAreaElement {
  return within(view).getByRole('textbox', { name: `Message to ${NAME}` }) as HTMLTextAreaElement;
}

async function sendFrom(view: HTMLElement, text: string) {
  fireEvent.change(textarea(view), { target: { value: text } });
  fireEvent.click(within(view).getByRole('button', { name: 'Send' }));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('the message box', () => {
  it('is in an interactive session’s view, says what it costs and that it can’t approve prompts', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }));
    const view = await openView();
    expect(within(box(view)).getByText(LIMITS)).toBeTruthy();
    expect(textarea(view)).toBeTruthy();
  });

  it('isn’t in a background session’s view', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }));
    const view = await openView('pitwall-test-bg');
    expect(within(view).queryByRole('region', { name: 'Message this session' })).toBeNull();
  });

  it('sends the text as typed, without blank lines before it or whitespace after it, and says it was delivered', async () => {
    const server = fakeServer({ status: 200, body: { status: 'delivered' } });
    renderDashboard(server);
    const view = await openView();
    const text = '  Please run the tests.\n<b>not markup</b> &  "quotes"';
    await sendFrom(view, `\n \n${text} \n\n`);
    expect(posts(server)).toEqual([{ url: relayPath(INTERACTIVE), body: { text } }]);
    const call = server.mock.calls.find(([, init]) => init.method === 'POST');
    expect((call?.[1].headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(within(view).getByRole('status').textContent).toBe(
      "Delivered. It's in the session's inbox: it reads it at its next step, or starts a turn if it's idle.",
    );
    expect(textarea(view).value).toBe('');
  });

  it('says a held message waits for approval in that session’s own terminal', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'held', detail: 'Held by that session.' } }));
    const view = await openView();
    await sendFrom(view, 'hello');
    expect(within(view).getByRole('alert').textContent).toBe(
      "Held for approval in that session's own terminal. It isn't delivered until it's approved there. Held by that session.",
    );
  });

  it('says a refused message was refused', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'refused', detail: 'Refused by its settings.' } }));
    const view = await openView();
    await sendFrom(view, 'hello');
    expect(within(view).getByRole('alert').textContent).toBe(
      "Refused: that session's settings don't accept messages from other sessions. Refused by its settings.",
    );
  });

  it('says why a message wasn’t sent, as text, and keeps the draft', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'failed', detail: 'Ambiguous name: 2 running sessions are named <x>\u001b[31m.' } }));
    const view = await openView();
    await sendFrom(view, 'hello');
    const alert = within(view).getByRole('alert');
    expect(alert.textContent).toBe('Not sent. Ambiguous name: 2 running sessions are named <x>.');
    expect(alert.querySelector('x')).toBeNull();
    expect(textarea(view).value).toBe('hello');
  });

  it('says a message that may have been sent may have reached the session, and keeps the draft', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'uncertain', detail: 'The relay stopped (exit code 1). It may have reached the session.' } }));
    const view = await openView();
    await sendFrom(view, 'hello');
    const alert = within(view).getByRole('alert');
    expect(alert.textContent).toBe(
      'May have reached the session. Check its conversation before sending again. The relay stopped (exit code 1). It may have reached the session.',
    );
    expect(alert.className).toContain('tone-waiting');
    expect(textarea(view).value).toBe('hello');
  });

  it('shows an uncertain exchange on the session as one to check', async () => {
    const relay = { sentAt: minutesAgo(3), status: 'uncertain' as const };
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }), snap(interactive({ relay })));
    const view = await openView();
    const line = within(box(view)).getByText('Message from pitwall').closest('.relay-exchange-line') as HTMLElement;
    expect(line.textContent).toBe('Message from pitwall 3m ago: may have reached it: check its conversation');
    expect(line.className).toContain('tone-waiting');
  });

  it('shows the server’s detail for a refused request, such as 409 or 429', async () => {
    renderDashboard(
      fakeServer(
        { status: 409, body: { status: 'failed', detail: "That session isn't running, so there's nothing to message." } },
        { status: 429, body: { status: 'failed', detail: 'The relay is busy with other messages. Try again in a moment.' } },
      ),
    );
    const view = await openView();
    await sendFrom(view, 'hello');
    expect(within(view).getByRole('alert').textContent).toBe("Not sent. That session isn't running, so there's nothing to message.");
    await sendFrom(view, 'hello');
    expect(within(view).getByRole('alert').textContent).toBe('Not sent. The relay is busy with other messages. Try again in a moment.');
  });

  it('says when pitwall itself couldn’t be reached, or answered something else', async () => {
    renderDashboard(fakeServer(new TypeError('network down'), { status: 500 }));
    const view = await openView();
    await sendFrom(view, 'hello');
    expect(within(view).getByRole('alert').textContent).toBe("Couldn't reach pitwall, so it may not have been sent.");
    await sendFrom(view, 'hello');
    expect(within(view).getByRole('alert').textContent).toBe('pitwall answered 500, so it may not have been sent.');
  });

  it('can’t send nothing, only whitespace, or more than 8,192 characters', async () => {
    const server = fakeServer({ status: 200, body: { status: 'delivered' } });
    renderDashboard(server);
    const view = await openView();
    const send = () => within(view).getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    fireEvent.change(textarea(view), { target: { value: ' \n ' } });
    expect(send().disabled).toBe(true);
    fireEvent.change(textarea(view), { target: { value: 'x'.repeat(8193) } });
    expect(send().disabled).toBe(true);
    expect(textarea(view).getAttribute('aria-invalid')).toBe('true');
    expect(within(view).getByText('1 characters over the 8192 limit')).toBeTruthy();
    fireEvent.change(textarea(view), { target: { value: 'x'.repeat(8192) } });
    expect(send().disabled).toBe(false);
    expect(posts(server)).toEqual([]);
  });

  it('sends with Cmd or Ctrl+Enter', async () => {
    const server = fakeServer({ status: 200, body: { status: 'delivered' } });
    renderDashboard(server);
    const view = await openView();
    fireEvent.change(textarea(view), { target: { value: 'one' } });
    fireEvent.keyDown(textarea(view), { key: 'Enter', metaKey: true });
    await settle();
    fireEvent.change(textarea(view), { target: { value: 'two' } });
    fireEvent.keyDown(textarea(view), { key: 'Enter', ctrlKey: true });
    await settle();
    fireEvent.change(textarea(view), { target: { value: 'three' } });
    fireEvent.keyDown(textarea(view), { key: 'Enter' });
    await settle();
    expect(posts(server).map((post) => post.body)).toEqual([{ text: 'one' }, { text: 'two' }]);
  });

  it('shows the send in progress, and allows nothing else meanwhile', async () => {
    let answer: (response: Response) => void = () => {};
    const server = vi.fn<FetchLike>(async (_url, init) =>
      init.method === 'POST'
        ? new Promise<Response>((resolve) => (answer = resolve))
        : new Response(JSON.stringify({ sessionId: INTERACTIVE, entries: [] }), { status: 200 }),
    );
    renderDashboard(server);
    const view = await openView();
    await sendFrom(view, 'hello');
    expect((within(view).getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(textarea(view).disabled).toBe(true);
    answer(new Response(JSON.stringify({ status: 'delivered' }), { status: 200 }));
    await settle();
    expect(within(view).getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('keeps the view open on Escape while there’s a draft', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }));
    const view = await openView();
    fireEvent.change(textarea(view), { target: { value: 'draft' } });
    fireEvent.keyDown(textarea(view), { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: NAME })).toBe(view);
    fireEvent.change(textarea(view), { target: { value: '' } });
    fireEvent.keyDown(textarea(view), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says a session that isn’t running can’t be messaged', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }), snap(interactive({ alive: false, pid: undefined, status: undefined })));
    const view = await openView();
    expect(within(box(view)).getByText("It isn't running, so it can't be messaged.")).toBeTruthy();
    expect(within(view).queryByRole('textbox')).toBeNull();
  });

  it('shows the latest exchange and its reply, as text', async () => {
    const relay = { sentAt: minutesAgo(3), status: 'delivered' as const, reply: { at: minutesAgo(2), text: 'Done: <b>3 tests</b> pass\u001b[0m' } };
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }), snap(interactive({ relay })));
    const view = await openView();
    const exchange = within(box(view)).getByText('Message from pitwall').closest('.relay-exchange') as HTMLElement;
    expect(exchange.textContent).toContain('Message from pitwall 3m ago: delivered');
    expect(exchange.textContent).toContain('Reply Done: <b>3 tests</b> pass');
    expect(exchange.querySelector('b')).toBeNull();
  });
});

describe('the row', () => {
  function row(name = NAME): HTMLElement {
    return screen.getByRole('button', { name }).closest('li') as HTMLElement;
  }

  it('has a Message quick action that opens the view with the box focused', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    fireEvent.click(within(row()).getByRole('button', { name: 'Message' }));
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    const view = screen.getByRole('dialog', { name: NAME });
    expect(document.activeElement).toBe(textarea(view));
  });

  it('focuses the box when the view is already open', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }));
    const view = await openView();
    expect(document.activeElement).not.toBe(textarea(view));
    fireEvent.click(within(row()).getByRole('button', { name: 'Message' }));
    expect(document.activeElement).toBe(textarea(view));
  });

  it('has no Message action for a background session, or one that isn’t running', () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }), snap(interactive({ alive: false, pid: undefined, status: undefined })));
    expect(within(row()).queryByRole('button', { name: 'Message' })).toBeNull();
    expect(within(row('pitwall-test-bg')).queryByRole('button', { name: 'Message' })).toBeNull();
  });

  it('shows the latest exchange and its reply, as text', () => {
    const relay = { sentAt: minutesAgo(10), status: 'held' as const, reply: { at: minutesAgo(9), text: 'line one\nline two' } };
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }), snap(interactive({ relay })));
    const note = row().querySelector('.relay-exchange') as HTMLElement;
    expect(note.textContent).toContain('Message from pitwall 10m ago: held for approval in its terminal');
    expect(within(note).getByText(/line one/).textContent).toBe('Reply line one\nline two');
  });

  it('shows nothing about the relay for a session that was never messaged', () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }));
    expect(row().querySelector('.relay-exchange')).toBeNull();
  });
});
