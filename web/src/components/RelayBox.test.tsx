import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { relayPath, type IndexSnapshot, type SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import type { ConnectionView } from '../connection.js';
import { group, minutesAgo, NOW, session, snapshot } from '../test/fixtures.js';
import { tooltipText } from '../test/tooltips.js';
import { Dashboard } from './Dashboard.js';
import { usesCommandKey } from './KeyCaps.js';

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
    // Behind an info button, so Tab reaches it, whose name is its tooltip.
    const info = within(box(view)).getByRole('button', { name: LIMITS });
    expect(info.hasAttribute('title')).toBe(false);
    expect(await tooltipText(info)).toBe(LIMITS);
    expect(textarea(view)).toBeTruthy();
    expect(textarea(view).getAttribute('rows')).toBe('1');
    // The class the placeholder rule in relay.css styles.
    expect(textarea(view).classList.contains('relay-text')).toBe(true);
  });

  it('says how to send, as key caps with words for screen readers, and links that to the text box', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }));
    const view = await openView();
    const help = box(view).querySelector('.relay-help-keys')!;
    expect([...help.querySelectorAll('kbd')].map((key) => key.textContent)).toEqual(usesCommandKey() ? ['⌘', '↵'] : ['Ctrl', '↵']);
    expect(help.querySelector('.key-caps-keys')?.getAttribute('aria-hidden')).toBe('true');
    expect(help.textContent).toContain(usesCommandKey() ? 'Command Enter to send' : 'Control Enter to send');
    expect(textarea(view).getAttribute('aria-describedby')).toBe(help.id);
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
    // In the message box: the conversation has a status of its own, for its count of new entries.
    expect(within(within(view).getByRole('region', { name: 'Message this session' })).getByRole('status').textContent).toBe(
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
    expect(alert.className).toContain('warning');
    expect(textarea(view).value).toBe('hello');
  });

  it('shows an uncertain exchange on the session as one to check', async () => {
    const relay = { sentAt: minutesAgo(3), status: 'uncertain' as const };
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }), snap(interactive({ relay })));
    const view = await openView();
    const line = box(view).querySelector('.relay-exchange-line') as HTMLElement;
    expect(line.textContent).toBe('Message from pitwall · 3m ago: may have reached it: check its conversation');
    expect(line.querySelector('.relay-exchange-status')?.className).toContain('tone-waiting');
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
    const off = () => send().getAttribute('aria-disabled') === 'true';
    expect(off()).toBe(true);
    fireEvent.change(textarea(view), { target: { value: ' \n ' } });
    expect(off()).toBe(true);
    fireEvent.change(textarea(view), { target: { value: 'x'.repeat(8193) } });
    expect(off()).toBe(true);
    // aria-disabled, not disabled: it can still be focused, and a press or ⌘↵ sends nothing.
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    fireEvent.keyDown(textarea(view), { key: 'Enter', metaKey: true });
    await settle();
    expect(textarea(view).getAttribute('aria-invalid')).toBe('true');
    const count = within(view).getByText('1 character over the 8,192 limit');
    expect(textarea(view).getAttribute('aria-describedby')?.split(' ')).toContain(count.id);
    fireEvent.change(textarea(view), { target: { value: 'x'.repeat(8192) } });
    expect(off()).toBe(false);
    expect(send().hasAttribute('aria-disabled')).toBe(false);
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
    const busy = within(view).getByRole('button', { name: 'Sending…' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(busy.querySelector('.spinner')?.getAttribute('aria-hidden')).toBe('true');
    // Read-only, not disabled, so it keeps focus and its text can still be selected.
    expect(textarea(view).readOnly).toBe(true);
    expect(textarea(view).disabled).toBe(false);
    fireEvent.click(busy);
    fireEvent.keyDown(textarea(view), { key: 'Enter', metaKey: true });
    expect(server.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
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
    // The note alone: the limits note is about sending, which it can't.
    expect(within(box(view)).queryByRole('img', { name: LIMITS })).toBeNull();
    expect(box(view).textContent).not.toContain(LIMITS);
  });

  it('shows the latest exchange and its reply, as text', async () => {
    const relay = { sentAt: minutesAgo(3), status: 'delivered' as const, reply: { at: minutesAgo(2), text: 'Done: <b>3 tests</b> pass\u001b[0m' } };
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }), snap(interactive({ relay })));
    const view = await openView();
    const exchange = box(view).querySelector('.relay-exchange') as HTMLElement;
    expect(exchange.textContent).toContain('Message from pitwall · 3m ago: delivered');
    expect(exchange.textContent).toContain('Reply: Done: <b>3 tests</b> pass');
    expect(exchange.querySelector('b')).toBeNull();
  });
});

describe('the row', () => {
  function row(name = NAME): HTMLElement {
    return screen.getByRole('button', { name }).closest('li') as HTMLElement;
  }

  it('has no Message button and no relay exchange: the session view has the box, with the exchange above it', async () => {
    const relay = { sentAt: minutesAgo(10), status: 'held' as const, reply: { at: minutesAgo(9), text: 'line one\nline two' } };
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }), snap(interactive({ relay })));

    expect(within(row()).queryByRole('button', { name: 'Message' })).toBeNull();
    expect(row().querySelector('.relay-exchange')).toBeNull();
    expect(row().textContent).not.toMatch(/Message from pitwall|line one/);

    const view = await openView();
    const note = box(view).querySelector('.relay-exchange') as HTMLElement;
    expect(note.textContent).toContain('Message from pitwall · 10m ago: held for approval in its terminal');
    expect(note.querySelector('.relay-reply')?.textContent).toBe('Reply: line one\nline two');
    expect(textarea(view)).toBeTruthy();
  });
});

describe('the message box’s rules (W24)', () => {
  it('keeps focus in the text box after ⌘↵, and brings it back there from Send', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }));
    const view = await openView();
    textarea(view).focus();
    fireEvent.change(textarea(view), { target: { value: 'one' } });
    fireEvent.keyDown(textarea(view), { key: 'Enter', metaKey: true });
    await settle();
    expect(document.activeElement).toBe(textarea(view));

    fireEvent.change(textarea(view), { target: { value: 'two' } });
    const send = within(view).getByRole('button', { name: 'Send' });
    send.focus();
    fireEvent.click(send);
    await settle();
    expect(document.activeElement).toBe(textarea(view));
  });

  it('leaves focus alone when it was moved elsewhere while the message was being sent', async () => {
    let answer: (response: Response) => void = () => {};
    const server = vi.fn<FetchLike>(async (_url, init) =>
      init.method === 'POST'
        ? new Promise<Response>((resolve) => (answer = resolve))
        : new Response(JSON.stringify({ sessionId: INTERACTIVE, entries: [] }), { status: 200 }),
    );
    renderDashboard(server);
    const view = await openView();
    await sendFrom(view, 'hello');
    const heading = within(view).getByRole('heading', { level: 2 });
    heading.focus();
    answer(new Response(JSON.stringify({ status: 'delivered' }), { status: 200 }));
    await settle();
    expect(document.activeElement).toBe(heading);
  });

  it('never loses a draft to Escape, wherever focus is in the view, and closes the view once the draft is gone', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }));
    const view = await openView();
    fireEvent.change(textarea(view), { target: { value: 'draft' } });
    const heading = within(view).getByRole('heading', { level: 2 });
    heading.focus();
    fireEvent.keyDown(heading, { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: NAME })).toBe(view);
    expect(textarea(view).value).toBe('draft');

    fireEvent.change(textarea(view), { target: { value: '' } });
    fireEvent.keyDown(heading, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('counts a whitespace-only draft as a draft, so Escape keeps it too', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }));
    const view = await openView();
    fireEvent.change(textarea(view), { target: { value: '  ' } });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: NAME })).toBe(view);
  });

  it('shows the character count only from 80 % of the limit, then how far over it is', async () => {
    renderDashboard(fakeServer({ status: 200, body: { status: 'delivered' } }));
    const view = await openView();
    const count = () => box(view).querySelector('.relay-count');
    const type = (length: number) => fireEvent.change(textarea(view), { target: { value: 'x'.repeat(length) } });
    type(6553);
    expect(count()).toBeNull();
    type(6554);
    expect(count()?.textContent).toBe('6,554 / 8,192');
    expect(count()?.className).toBe('relay-count');
    type(8192);
    expect(count()?.textContent).toBe('8,192 / 8,192');
    type(8193);
    expect(count()?.textContent).toBe('1 character over the 8,192 limit');
    expect(count()?.className).toBe('relay-count over');
    type(8200);
    expect(count()?.textContent).toBe('8 characters over the 8,192 limit');
    // What's sent, without the whitespace after it, is what's counted.
    fireEvent.change(textarea(view), { target: { value: `${'x'.repeat(8192)}\n\n  ` } });
    expect(count()?.textContent).toBe('8,192 / 8,192');
    expect(within(view).getByRole('button', { name: 'Send' }).hasAttribute('aria-disabled')).toBe(false);
  });

  it.each([
    ['delivered', 'status', 'success'],
    ['held', 'alert', 'warning'],
    ['uncertain', 'alert', 'warning'],
    ['refused', 'alert', 'danger'],
    ['failed', 'alert', 'danger'],
  ] as const)('shows %s as an inline alert with role="%s", in the %s tone', async (status, role, tone) => {
    renderDashboard(fakeServer({ status: 200, body: { status, detail: 'A made-up detail.' } }));
    const view = await openView();
    await sendFrom(view, 'hello');
    const result = box(view).querySelector('.relay-result')!;
    expect(result.getAttribute('role')).toBe(role);
    expect(result.className).toBe(`inline-alert ${tone} relay-result`);
    // The server's detail is in code style, after pitwall's own sentence; delivered has none.
    expect(result.querySelector('.alert-detail')?.textContent).toBe(status === 'delivered' ? undefined : 'A made-up detail.');
  });

  it('shows pitwall’s own failure, before the relay answered, as a danger alert', async () => {
    renderDashboard(fakeServer(new TypeError('network down')));
    const view = await openView();
    await sendFrom(view, 'hello');
    const result = box(view).querySelector('.relay-result')!;
    expect(result.getAttribute('role')).toBe('alert');
    expect(result.className).toContain('danger');
  });

  it('shows the reply once: not in the footer when the conversation already has it', async () => {
    const replyText = 'The export job retries three times now, and every test passes.';
    const relay = { sentAt: minutesAgo(3), status: 'delivered' as const, reply: { at: minutesAgo(2), text: replyText } };
    const entries = [
      { kind: 'assistant', at: minutesAgo(10), text: 'Earlier, before the message.' },
      { kind: 'assistant', at: minutesAgo(2), text: `Replying now.\n${replyText}` },
    ];
    const server = vi.fn<FetchLike>(async (_url, init) =>
      init.method === 'POST'
        ? new Response(JSON.stringify({ status: 'delivered' }), { status: 200 })
        : new Response(JSON.stringify({ sessionId: INTERACTIVE, entries }), { status: 200 }),
    );
    renderDashboard(server, snap(interactive({ relay })));
    const view = await openView();
    await settle();
    expect(box(view).querySelector('.relay-exchange-line')?.textContent).toBe('Message from pitwall · 3m ago: delivered');
    expect(box(view).querySelector('.relay-reply')).toBeNull();
  });
});
