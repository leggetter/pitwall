import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, SPAWN_PATH, TRUST_PATH, type IndexSnapshot, type SessionSummary } from '../../../src/shared/protocol.js';
import actionsCss from '../actions.css?raw';
import { ApiContext, createApiClient, type FetchLike } from '../api.js';
import { AttachContext, type AttachEnv } from '../attach.js';
import type { ConnectionView } from '../connection.js';
import { directoryChoices, directoryProblem, modelProblem, nameProblem, promptProblem, rootOf } from '../spawn.js';
import { block, declarations, withoutComments } from '../test/css.js';
import { fakeSockets, group, NOW, session, snapshot, type FakeSocket } from '../test/fixtures.js';
import { chooseFirstDirectory } from '../test/newSession.js';
import { hover, unhover } from '../test/tooltips.js';
import { Dashboard } from './Dashboard.js';
import dialogCss from './Dialog.css?raw';
import { NO_TRUST_COMMAND_TEXT, TRUST_TEXT } from './NewSessionDialog.js';
import { TRUST_BUTTON, TRUST_HERE, TRUST_PROMPT_LINE, TRUSTED } from './TrustFolder.js';

// The trust terminal's xterm.js (W214): a textarea that takes focus, and nothing else.
vi.mock('../xterm.js', () => ({
  createXterm: (container: HTMLElement) => {
    const screen = document.createElement('textarea');
    container.append(screen);
    return { cols: 72, rows: 16, write() {}, onData() {}, paste() {}, fit() {}, focus: () => screen.focus(), dispose: () => screen.remove() };
  },
}));

// Made-up sessions and directories only.

const API_KEY = 'k'.repeat(43);
const ROOT = '/Users/example/code';
const REPO = '/Users/example/code/demo-app';
const OTHER_REPO = '/Users/example/code/demo-api';

function snap(sessions: SessionSummary[] = [session({ name: 'demo-docs' })]): IndexSnapshot {
  return snapshot([
    group({ key: REPO, label: 'demo-app', sessions }),
    group({ key: OTHER_REPO, label: 'demo-api', sessions: [session({ name: 'demo-api-work', cwd: OTHER_REPO })] }),
    // A worktree grouped under a main repo outside the root: not offered.
    group({ key: '/srv/elsewhere/repo', label: '/srv/elsewhere/repo', sessions: [session({ name: 'demo-elsewhere', cwd: `${REPO}/wt` })] }),
  ]);
}

type Answer = { status: number; body?: unknown };

/** A fake server: POSTs get the next answer; GETs (the session view's conversation) get an empty page. */
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
    return new Response(answer.body === undefined ? 'not json' : JSON.stringify(answer.body), { status: answer.status });
  });
}

function posts(fetch: ReturnType<typeof fakeServer>) {
  return fetch.mock.calls
    .filter(([, init]) => init.method === 'POST')
    .map(([url, init]) => ({ url, body: JSON.parse(String(init.body)) as unknown, headers: init.headers as Record<string, string> }));
}

function renderDashboard(fetch: FetchLike | undefined, first: IndexSnapshot = snap(), env?: AttachEnv) {
  const api = fetch ? createApiClient({ apiKey: API_KEY, fetch }) : undefined;
  const ui = (s: IndexSnapshot) => {
    const view: ConnectionView = { state: 'live', snapshot: s };
    const dashboard = <Dashboard view={view} />;
    return <ApiContext.Provider value={api}>{env ? <AttachContext.Provider value={env}>{dashboard}</AttachContext.Provider> : dashboard}</ApiContext.Provider>;
  };
  const result = render(ui(first));
  return { ...result, update: (next: IndexSnapshot) => result.rerender(ui(next)) };
}

/** App's socket, for Trust this folder… (W214). */
function trustEnv() {
  const sockets = fakeSockets();
  const env: AttachEnv = { token: 'pitwall-test-token-0123456789abcdefghijklmnop', createSocket: sockets.factory, host: '127.0.0.1:4517' };
  return { env, sockets };
}

/** Presses Trust this folder… and runs the server's side up to `started`. */
async function openTrust(alert: HTMLElement, sockets: ReturnType<typeof fakeSockets>): Promise<FakeSocket> {
  const before = sockets.sockets.length;
  fireEvent.click(within(alert).getByRole('button', { name: TRUST_BUTTON }));
  await waitFor(() => expect(sockets.sockets).toHaveLength(before + 1));
  const socket = sockets.last;
  expect(socket.url).toBe(`ws://127.0.0.1:4517${TRUST_PATH}`);
  act(() => {
    socket.open();
    socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: 'n'.repeat(43) });
  });
  await waitFor(() => expect(socket.sent).toHaveLength(1));
  act(() => socket.receive({ type: 'ready' }));
  act(() => socket.receive({ type: 'started' }));
  return socket;
}

const settle = () => act(async () => {});

/**
 * New session from the header. These tests start in All sessions, a view, where it opens with no
 * directory chosen (W147), so it chooses the first, as a person would, unless `choose` is false.
 */
function openDialog({ choose = true }: { choose?: boolean } = {}): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'New session' }));
  const dialog = screen.getByRole('dialog', { name: 'New session' });
  if (choose) chooseFirstDirectory(dialog);
  return dialog;
}

/** Fills in a first prompt and returns the dialog, for a submit. */
function fill2(dialog: HTMLElement): HTMLElement {
  fill(dialog, { prompt: 'Reply with: ready' });
  return dialog;
}

function fill(dialog: HTMLElement, fields: { prompt?: string; name?: string }) {
  if (fields.prompt !== undefined) fireEvent.change(within(dialog).getByLabelText('First prompt'), { target: { value: fields.prompt } });
  if (fields.name !== undefined) fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: fields.name } });
}

const directory = (dialog: HTMLElement) => within(dialog).getByRole('combobox', { name: 'Directory' }) as HTMLInputElement;

/** Types `text` in Directory, then accepts the first option it offers, which typing highlights, with Enter (W142). */
function chooseDirectory(dialog: HTMLElement, text: string) {
  const input = directory(dialog);
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

async function submit(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
  await settle();
}

const started = { status: 201, body: { ok: true, shortId: 'c0ffee12', name: 'pitwall-test-spawn' } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

describe('New session: the dialog', () => {
  it('opens from the header, with the directory picker focused, offering the groups under a root, then the roots', () => {
    renderDashboard(fakeServer(started));
    const dialog = openDialog({ choose: false });

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const picker = directory(dialog);
    expect(document.activeElement).toBe(picker);
    // From All sessions, a view, no directory is chosen (W147): the field shows its placeholder.
    expect(picker.value).toBe('');
    expect(picker.placeholder).toBe('~/code/…');
    fireEvent.click(picker);
    // This fake server has no directory list: the groups' directories and the root alone.
    expect(within(within(dialog).getByRole('listbox', { name: 'Directories' })).getAllByRole('option').map((option) => option.textContent)).toEqual([
      '~/code/demo-app',
      '~/code/demo-api',
      '~/code',
    ]);
    expect(within(dialog).getByText('Under ~/code.')).toBeTruthy();
  });

  it('closes with Cancel and with Escape, and gives focus back to the button', () => {
    renderDashboard(fakeServer(started));
    const button = screen.getByRole('button', { name: 'New session' });
    button.focus();
    fireEvent.click(within(openDialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);

    const dialog = openDialog();
    fireEvent.keyDown(within(dialog).getByLabelText('First prompt'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);

    fireEvent.click(within(openDialog()).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('has a header with the title, the intro and Close, a body, and a footer with ⌘ ↵, Cancel and Start session', async () => {
    renderDashboard(fakeServer(started));
    const dialog = openDialog();

    expect(dialog.querySelector('.dialog-title')?.textContent).toBe('New session');
    // The intro is the dialog's description.
    const intro = document.getElementById(dialog.getAttribute('aria-describedby') ?? '');
    expect(intro?.textContent).toBe('Starts a background session with claude --bg, which you can open from the list.');
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(close.closest('.dialog-head')).toBeTruthy();
    // Its name is its tooltip, which has Escape's key cap after it.
    const tip = await hover(close);
    expect(tip?.querySelector('.tooltip-text')?.textContent).toBe('Close');
    expect(tip?.querySelector('.key-caps')?.textContent).toBe('EscEscape');
    unhover(close);
    const foot = dialog.querySelector('.dialog-foot')!;
    expect(foot.querySelector('.dialog-foot-meta')?.textContent).toMatch(/^(Command|Control) Enter to start$|to start$/);
    expect([...foot.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Cancel', 'Start session']);
  });

  it('traps Tab inside, from the last control to the first and back', () => {
    renderDashboard(fakeServer(started));
    const dialog = openDialog();
    const close = within(dialog).getByRole('button', { name: 'Close' });
    const start = within(dialog).getByRole('button', { name: 'Start session' });

    start.focus();
    fireEvent.keyDown(start, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(start);
  });

  it('starts the session with ⌘ Enter or Ctrl Enter from any field, and Enter alone in the prompt adds a line', async () => {
    const server = fakeServer(started, started);
    renderDashboard(server);
    let dialog = openDialog();
    fill(dialog, { prompt: 'first' });
    fireEvent.keyDown(within(dialog).getByLabelText('First prompt'), { key: 'Enter' });
    await settle();
    expect(posts(server)).toEqual([]);
    fireEvent.keyDown(within(dialog).getByLabelText('First prompt'), { key: 'Enter', metaKey: true });
    await settle();
    expect(posts(server).map((post) => post.body)).toEqual([{ cwd: REPO, prompt: 'first' }]);

    dialog = openDialog();
    fill(dialog, { prompt: 'second' });
    fireEvent.keyDown(within(dialog).getByLabelText('Directory'), { key: 'Enter', ctrlKey: true });
    await settle();
    expect(posts(server)).toHaveLength(2);
  });

  it('⌘ Enter checks the fields like Start session does, and puts focus on the first problem', async () => {
    const server = fakeServer(started);
    renderDashboard(server);
    const dialog = openDialog();
    fill(dialog, { name: '-bad', prompt: '' });
    fireEvent.keyDown(within(dialog).getByLabelText('Directory'), { key: 'Enter', metaKey: true });
    await settle();
    const name = within(dialog).getByLabelText(/^Name/);
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(name.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/^Letters, digits/);
    expect(within(dialog).getByLabelText('First prompt').getAttribute('aria-invalid')).toBe('true');
    expect(posts(server)).toEqual([]);
  });

  it('shows no problems until the first submit, then follows the typing', async () => {
    renderDashboard(fakeServer(started));
    const dialog = openDialog();
    fill(dialog, { name: '-bad' });
    expect(dialog.querySelector('.field-problem')).toBeNull();
    expect(within(dialog).getByLabelText(/^Name/).hasAttribute('aria-invalid')).toBe(false);

    await submit(dialog);
    expect(within(dialog).getByText(/^Letters, digits/)).toBeTruthy();
    fill(dialog, { name: 'good' });
    expect(within(dialog).queryByText(/^Letters, digits/)).toBeNull();
    fill(dialog, { name: 'bad;' });
    expect(within(dialog).getByText(/^Letters, digits/)).toBeTruthy();
  });

  it('closes on a click on the backdrop only while nothing has been typed', () => {
    renderDashboard(fakeServer(started));
    const button = screen.getByRole('button', { name: 'New session' });
    button.focus();
    // Choosing a directory is a change, as typing is, so this one leaves Directory as it opened.
    let dialog = openDialog({ choose: false });
    const backdrop = () => document.querySelector('.dialog-backdrop')!;
    // A click inside the card isn't one on the backdrop.
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(screen.getByRole('dialog', { name: 'New session' })).toBe(dialog);

    fill(dialog, { prompt: 'a draft' });
    fireEvent.pointerDown(backdrop());
    fireEvent.click(backdrop());
    expect(screen.getByRole('dialog', { name: 'New session' })).toBe(dialog);

    fill(dialog, { prompt: '' });
    fireEvent.pointerDown(backdrop());
    fireEvent.click(backdrop());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);

    // A press that starts in the card and ends on the backdrop, as when selecting text, isn't a click on it.
    dialog = openDialog({ choose: false });
    fireEvent.pointerDown(dialog);
    fireEvent.click(backdrop());
    expect(screen.getByRole('dialog', { name: 'New session' })).toBe(dialog);
  });

  it('sits at --pw-z-backdrop and --pw-z-dialog, as wide as --pw-dialog-md, at most the window less 96 px tall', () => {
    const css = withoutComments(dialogCss);
    const backdrop = new Map(declarations(block(css, /\.dialog-backdrop\s*\{/)));
    expect(backdrop.get('z-index')).toBe('var(--pw-z-backdrop)');
    expect(backdrop.get('background')).toBe('var(--pw-backdrop)');
    expect(backdrop.get('padding')).toBe('var(--pw-space-12) var(--pw-space-4)');
    const card = declarations(block(css, /\n\.dialog\s*\{/));
    expect(new Map(card).get('z-index')).toBe('var(--pw-z-dialog)');
    expect(new Map(card).get('width')).toBe('min(var(--pw-dialog-md), 100%)');
    expect(card.filter(([property]) => property === 'max-height').map(([, value]) => value)).toContain('calc(100dvh - 2 * var(--pw-space-12))');
    // The old modal's z-index, equal to --pw-z-panel, is gone.
    expect(withoutComments(actionsCss)).not.toMatch(/modal|z-index:\s*20/);
  });

  it("isn't offered before the first snapshot", () => {
    render(<Dashboard view={{ state: 'connecting', snapshot: undefined }} />);
    expect(screen.queryByRole('button', { name: 'New session' })).toBeNull();
  });
});

describe('New session: starting one', () => {
  it('posts the directory, prompt, name and model with the apiKey, closes, and opens the session once it is listed', async () => {
    const server = fakeServer(started);
    const { update } = renderDashboard(server);
    const dialog = openDialog();
    chooseDirectory(dialog, 'api');
    expect(directory(dialog).value).toBe('~/code/demo-api');
    fill(dialog, { prompt: 'Reply with: ready', name: 'pitwall-test-spawn' });
    fireEvent.change(within(dialog).getByLabelText(/^Model/), { target: { value: 'haiku' } });
    await submit(dialog);

    expect(posts(server)).toEqual([
      {
        url: SPAWN_PATH,
        body: { cwd: OTHER_REPO, prompt: 'Reply with: ready', name: 'pitwall-test-spawn', model: 'haiku' },
        headers: expect.objectContaining({ Authorization: `Bearer ${API_KEY}` }),
      },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
    // A toast, in the stack's live region, which was there before it (4: Toasts), not a page alert.
    const toast = screen.getByText('Started pitwall-test-spawn. Its view opens when it shows up in the list.');
    expect(toast.closest('.toasts')?.getAttribute('aria-live')).toBe('polite');
    expect(toast.closest('.session-list-alerts')).toBeNull();

    const spawned = session({ name: 'pitwall-test-spawn', kind: 'background', shortId: 'c0ffee12', state: 'working', cwd: OTHER_REPO });
    update(snap([session({ name: 'demo-docs' }), spawned]));
    await settle();
    expect(screen.getByRole('dialog', { name: 'pitwall-test-spawn' })).toBeTruthy();
  });

  it("started from the no-sessions empty state, focuses the new session's heading once it's listed, since the button it came from has gone (W31)", async () => {
    const server = fakeServer(started);
    const { update } = renderDashboard(server, snapshot([]));
    const fromEmpty = within(screen.getByRole('main')).getByRole('button', { name: 'New session' });
    // A click focuses the button it's on, as a browser's does.
    fromEmpty.focus();
    fireEvent.click(fromEmpty);
    const dialog = screen.getByRole('dialog', { name: 'New session' });
    chooseFirstDirectory(dialog);
    fill(dialog, { prompt: 'Reply with: ready' });
    await submit(dialog);
    expect(document.activeElement).toBe(fromEmpty);

    const spawned = session({ name: 'pitwall-test-spawn', kind: 'background', shortId: 'c0ffee12', state: 'working', cwd: REPO });
    update(snapshot([group({ key: REPO, label: 'demo-app', sessions: [spawned] })]));
    await settle();
    const view = screen.getByRole('dialog', { name: 'pitwall-test-spawn' });
    expect(document.activeElement).toBe(document.getElementById(view.getAttribute('aria-labelledby')!));
  });

  it('started from the header, leaves focus on its New session button when the view opens', async () => {
    const server = fakeServer(started);
    const { update } = renderDashboard(server);
    const header = within(document.querySelector<HTMLElement>('.app-header')!).getByRole('button', { name: 'New session' });
    header.focus();
    await submit(fill2(openDialog()));
    expect(document.activeElement).toBe(header);
    const spawned = session({ name: 'pitwall-test-spawn', kind: 'background', shortId: 'c0ffee12', state: 'working', cwd: REPO });
    update(snap([session({ name: 'demo-docs' }), spawned]));
    await settle();
    expect(screen.getByRole('dialog', { name: 'pitwall-test-spawn' })).toBeTruthy();
    expect(document.activeElement).toBe(header);
  });

  it('leaves out an empty name and the default model, and uses a typed directory and model', async () => {
    const server = fakeServer(started, started);
    renderDashboard(server);
    let dialog = openDialog();
    fill(dialog, { prompt: 'first' });
    await submit(dialog);

    dialog = openDialog();
    fireEvent.change(directory(dialog), { target: { value: `  ${ROOT}/new-thing  ` } });
    fireEvent.change(within(dialog).getByLabelText(/^Model/), { target: { value: '\u0000other' } });
    fireEvent.change(within(dialog).getByLabelText('Model alias or full name'), { target: { value: 'claude-haiku-4-5' } });
    fill(dialog, { prompt: 'second' });
    await submit(dialog);

    expect(posts(server).map((post) => post.body)).toEqual([
      // Before the profiles have loaded (this fake server has none), Build by name, which the server always has.
      { cwd: REPO, prompt: 'first' },
      { cwd: `${ROOT}/new-thing`, prompt: 'second', model: 'claude-haiku-4-5' },
    ]);
  });

  it("says what's wrong before sending: no prompt, a bad name, a path outside the roots, a bad model", async () => {
    const server = fakeServer(started);
    renderDashboard(server);
    const dialog = openDialog();
    await submit(dialog);
    expect(within(dialog).getByText('Write the first prompt.')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByLabelText('First prompt'));

    fill(dialog, { prompt: 'go', name: 'bad;name' });
    await submit(dialog);
    expect(within(dialog).queryByText('Write the first prompt.')).toBeNull();
    expect(within(dialog).getByText(/Letters, digits, spaces/)).toBeTruthy();

    fill(dialog, { name: '' });
    fireEvent.change(directory(dialog), { target: { value: '' } });
    await submit(dialog);
    expect(within(dialog).getByText('Choose a directory.')).toBeTruthy();
    for (const [path, problem] of [
      ['code/demo-app', 'Use an absolute path, or one that starts with ~/.'],
      ['~/elsewhere/demo-app', 'Use a directory under ~/code.'],
      ['/Users/example/codex', 'Use a directory under ~/code.'],
      ['/etc', 'Use a directory under ~/code.'],
    ]) {
      fireEvent.change(directory(dialog), { target: { value: path } });
      expect(within(dialog).getByText(problem as string)).toBeTruthy();
    }
    fireEvent.change(directory(dialog), { target: { value: `${REPO}/sub` } });

    fireEvent.change(within(dialog).getByLabelText(/^Model/), { target: { value: '\u0000other' } });
    await submit(dialog);
    expect(within(dialog).getByText('Type a model alias, or choose the default.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Model alias or full name'), { target: { value: 'opus 4' } });
    expect(within(dialog).getByText(/A Claude Code alias, such as sonnet/)).toBeTruthy();

    expect(posts(server)).toEqual([]);
  });

  it('shows "Starting…" and ignores Escape and a second submit while the request is out', async () => {
    let answer: (response: Response) => void = () => {};
    const server = vi.fn<FetchLike>(() => new Promise<Response>((resolve) => (answer = resolve)));
    renderDashboard(server);
    const dialog = openDialog();
    fill(dialog, { prompt: 'go' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await settle();

    // Busy, and Cancel aria-disabled: both stay focusable, and neither does anything.
    const busy = within(dialog).getByRole('button', { name: 'Starting…' }) as HTMLButtonElement;
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(busy.disabled).toBe(false);
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    expect(cancel.getAttribute('aria-disabled')).toBe('true');
    expect(cancel.disabled).toBe(false);
    // Every other control is aria-disabled too, and keeps what it has.
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(close.getAttribute('aria-disabled')).toBe('true');
    const prompt = within(dialog).getByLabelText('First prompt') as HTMLTextAreaElement;
    for (const field of [within(dialog).getByLabelText('Directory'), within(dialog).getByLabelText(/^Name/), within(dialog).getByLabelText(/^Model/), within(dialog).getByLabelText(/^Effort/), prompt]) {
      expect(field.getAttribute('aria-disabled')).toBe('true');
    }
    expect(prompt.readOnly).toBe(true);
    fireEvent.change(prompt, { target: { value: 'changed' } });
    expect(prompt.value).toBe('go');
    fireEvent.click(cancel);
    fireEvent.click(close);
    fireEvent.click(busy);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.keyDown(prompt, { key: 'Enter', metaKey: true });
    fireEvent.pointerDown(document.querySelector('.dialog-backdrop')!);
    fireEvent.click(document.querySelector('.dialog-backdrop')!);
    fireEvent.submit(dialog.querySelector('form')!);
    expect(screen.getByRole('dialog', { name: 'New session' })).toBe(dialog);
    // One POST: the dialog's other request is its GET of the defaults for sessions (W119).
    expect(server.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);

    answer(new Response(JSON.stringify(started.body), { status: 201 }));
    await settle();
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
  });

  it('styles its fields and the first prompt’s textarea with the placeholder rule in actions.css', () => {
    renderDashboard(fakeServer(started));
    const dialog = openDialog();
    expect(within(dialog).getByLabelText('First prompt').classList.contains('field-input')).toBe(true);
    expect((within(dialog).getByPlaceholderText('Claude Code names it from the prompt') as HTMLInputElement).classList.contains('field-input')).toBe(true);
  });

  it('keeps the session view behind it open on Escape', async () => {
    renderDashboard(fakeServer(started));
    fireEvent.click(screen.getByRole('button', { name: 'demo-docs' }));
    await settle();
    const view = screen.getByRole('dialog', { name: 'demo-docs' });
    const dialog = openDialog();
    fireEvent.keyDown(within(dialog).getByLabelText('First prompt'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'demo-docs' })).toBe(view);
  });
});

describe('New session: when it is refused', () => {
  const untrusted = {
    status: 422,
    body: {
      ok: false,
      error: `Workspace not trusted. Run \`claude\` in ${REPO} once and accept the trust prompt, then retry.`,
      hint: `cd ${REPO} && claude`,
    },
  };

  it("shows Claude Code's untrusted-workspace error, and the command to run with a copy button", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderDashboard(fakeServer(untrusted), snap(), trustEnv().env);
    const dialog = openDialog();
    fill(dialog, { prompt: 'go' });
    await submit(dialog);

    // An inline danger alert at the end of the body (4: Dialogs), not a banner.
    const alert = within(dialog).getByRole('alert');
    expect(alert.className).toBe('inline-alert danger spawn-failure');
    expect(dialog.querySelector('.banner')).toBeNull();
    expect(alert.textContent).toContain(`Couldn't start the session. ${untrusted.body.error}`);
    expect(within(alert).getByText(untrusted.body.error).className).toBe('alert-detail');
    expect(within(alert).getByText(TRUST_TEXT)).toBeTruthy();
    // The command chip: the whole command, in two parts for the middle ellipsis.
    const chip = alert.querySelector('code.command-chip')!;
    expect(chip.textContent).toBe(`cd ${REPO} && claude`);
    const copy = within(alert).getByRole('button', { name: 'Copy command' });
    expect(chip.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Then Trust this folder…, after the command (W214): the alert's whole text, in order.
    const trust = within(alert).getByRole('button', { name: TRUST_BUTTON });
    expect(copy.compareDocumentPosition(trust) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.textContent).toBe(`Couldn't start the session. ${untrusted.body.error}${TRUST_TEXT}${chip.textContent}${copy.textContent}${TRUST_HERE.start}${TRUST_BUTTON}`);
    fireEvent.click(copy);
    await settle();
    expect(writeText).toHaveBeenCalledWith(`cd ${REPO} && claude`);
    expect(screen.getByText('Copied').closest('.toasts')).toBeTruthy();
    // Still open, so the user can trust the directory and try again.
    expect(screen.getByRole('dialog', { name: 'New session' })).toBe(dialog);
  });

  it("says in its own words, not in code style, why there's no command when an untrusted directory's 422 has no hint, as for a path with a ' or \\ (W87)", async () => {
    const error = `Workspace not trusted. Run \`claude\` in ${REPO} once and accept the trust prompt, then retry.`;
    renderDashboard(fakeServer({ status: 422, body: { ok: false, error } }, { status: 409, body: { ok: false, error: 'Something else.' } }), snap(), trustEnv().env);
    const dialog = openDialog();
    fill(dialog, { prompt: 'go' });
    await submit(dialog);
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toBe(`Couldn't start the session. ${error}${NO_TRUST_COMMAND_TEXT}`);
    // Claude Code's line in code style, pitwall's sentence after it as text, its ' and \\ as literal values.
    expect(alert.querySelector('.alert-detail')?.textContent).toBe(error);
    const sentence = alert.querySelector('p.spawn-trust');
    expect(sentence?.textContent).toBe(NO_TRUST_COMMAND_TEXT);
    expect(sentence?.closest('.alert-detail')).toBeNull();
    expect([...(sentence?.querySelectorAll('code') ?? [])].map((code) => code.textContent)).toEqual(["'", '\\']);
    expect(within(alert).queryByText(TRUST_TEXT)).toBeNull();
    expect(alert.querySelector('.command-chip')).toBeNull();
    expect(within(alert).queryByRole('button', { name: 'Copy command' })).toBeNull();
    // No command, no Trust this folder… either: the server would refuse the folder (W214).
    expect(within(alert).queryByRole('button', { name: TRUST_BUTTON })).toBeNull();

    // Only for a 422: any other refusal without a command has the reason alone.
    await submit(dialog);
    expect(within(dialog).getByRole('alert').textContent).toBe("Couldn't start the session. Something else.");
  });

  it('shows any other error without a command, and a status when the answer is not JSON', async () => {
    renderDashboard(fakeServer({ status: 429, body: { ok: false, error: 'Another session is still starting. Try again in a moment.' } }, { status: 500 }));
    const dialog = openDialog();
    fill(dialog, { prompt: 'go' });
    await submit(dialog);
    const alert = within(dialog).getByRole('alert');
    expect(alert.textContent).toBe("Couldn't start the session. Another session is still starting. Try again in a moment.");
    expect(within(alert).queryByRole('button', { name: 'Copy command' })).toBeNull();

    await submit(dialog);
    expect(within(dialog).getByRole('alert').textContent).toBe("Couldn't start the session (HTTP 500).");
  });
});

describe('New session: Trust this folder… (W214)', () => {
  const untrusted = {
    status: 422,
    body: {
      ok: false,
      error: `Workspace not trusted. Run \`claude\` in ${REPO} once and accept the trust prompt, then retry.`,
      hint: `cd ${REPO} && claude`,
    },
  };

  it('opens the prompt for the folder the request named, and once trusted sends the same request again, once, which starts the session', async () => {
    const { env, sockets } = trustEnv();
    const fetch = fakeServer(untrusted, started);
    renderDashboard(fetch, snap(), env);
    const dialog = openDialog();
    fill(dialog, { prompt: 'go', name: 'pitwall-test-trust' });
    await submit(dialog);
    const socket = await openTrust(within(dialog).getByRole('alert'), sockets);
    expect(JSON.parse(socket.sent[1]!)).toEqual({ type: 'open', cwd: REPO, cols: 72, rows: 16 });
    expect(within(dialog).getByText(TRUST_PROMPT_LINE)).toBeTruthy();
    // Escape in the prompt is Claude Code's: the dialog stays open.
    fireEvent.keyDown(dialog.querySelector('.trust-folder-screen textarea')!, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'New session' })).toBe(dialog);

    act(() => socket.receive({ type: 'outcome', outcome: 'trusted' }));
    await settle();
    const sent = posts(fetch);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.url).toBe(SPAWN_PATH);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
    // Started: the dialog closes, as for any start.
    expect(screen.queryByRole('dialog', { name: 'New session' })).toBeNull();
    expect(sockets.sockets).toHaveLength(1);
  });

  it('a second 422 after trusted brings the card back with the button, and opens nothing by itself', async () => {
    const { env, sockets } = trustEnv();
    const fetch = fakeServer(untrusted, untrusted);
    renderDashboard(fetch, snap(), env);
    const dialog = openDialog();
    fill(dialog, { prompt: 'go' });
    await submit(dialog);
    const socket = await openTrust(within(dialog).getByRole('alert'), sockets);
    act(() => socket.receive({ type: 'outcome', outcome: 'trusted' }));
    await settle();
    expect(posts(fetch)).toHaveLength(2);
    const alert = within(dialog).getByRole('alert');
    expect(within(alert).getByRole('button', { name: TRUST_BUTTON })).toBeTruthy();
    expect(within(alert).queryByText(TRUSTED.start)).toBeNull();
    await settle();
    expect(posts(fetch)).toHaveLength(2);
    expect(sockets.sockets).toHaveLength(1);
  });

  it('declined: says so in the card and sends nothing again', async () => {
    const { env, sockets } = trustEnv();
    const fetch = fakeServer(untrusted, started);
    renderDashboard(fetch, snap(), env);
    const dialog = openDialog();
    fill(dialog, { prompt: 'go' });
    await submit(dialog);
    const socket = await openTrust(within(dialog).getByRole('alert'), sockets);
    act(() => socket.receive({ type: 'outcome', outcome: 'declined' }));
    await settle();
    expect(posts(fetch)).toHaveLength(1);
    expect(dialog.querySelector('.trust-folder-notice')?.getAttribute('role')).toBe('status');
    expect(dialog.querySelector('.trust-folder-notice')?.textContent).toBe(
      "Claude Code didn't trust this folder, so the session wasn't started. You can try again, or choose another folder.",
    );
    expect(within(dialog).getByRole('button', { name: TRUST_BUTTON })).toBeTruthy();
  });
});

describe('spawn helpers', () => {
  it('directoryChoices dedupes, keeps group order, and drops groups outside the roots', () => {
    const s = snapshot(
      [
        group({ key: '/r/b', label: 'b', sessions: [] }),
        group({ key: '/r/a', label: 'a', sessions: [] }),
        group({ key: '/r/a', label: 'a', root: '/r2', sessions: [] }),
        group({ key: '/other/x', label: 'x', sessions: [] }),
      ],
      { roots: ['/r', '/r2'] },
    );
    expect(directoryChoices(s).map((choice) => choice.path)).toEqual(['/r/b', '/r/a', '/r', '/r2']);
  });

  it('the field checks match the server rules', () => {
    expect(directoryProblem('/r', ['/r'])).toBeUndefined();
    expect(directoryProblem('/r/', ['/r'])).toBeUndefined();
    expect(directoryProblem('/r/x/y', ['/q', '/r'])).toBeUndefined();
    expect(directoryProblem('/rx', ['/r'])).toMatch(/under/);
    expect(directoryProblem('/r/\u0007', ['/r'])).toMatch(/control/);
    for (const name of ['', 'pitwall-test-spawn', 'Fix the docs 2.0', '_x', 'x'.repeat(64)]) expect(nameProblem(name), name).toBeUndefined();
    for (const name of ['-h', ' x', 'x ', 'a;b', 'naïve', 'x'.repeat(65)]) expect(nameProblem(name), name).toBeDefined();
    for (const model of ['', 'haiku', 'fable', 'opusplan', 'sonnet[1m]', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-5-5']) expect(modelProblem(model), model).toBeUndefined();
    for (const model of ['-x', 'opus 4', 'x'.repeat(40), 'claude-gpt-5', 'claude-opus', 'claude-opus-5-5 --x']) expect(modelProblem(model), model).toBeDefined();
    expect(promptProblem(' \n')).toBeDefined();
    expect(promptProblem('x'.repeat(16_384))).toBeUndefined();
    expect(promptProblem('x'.repeat(16_385))).toBeDefined();
  });

  it("with a root tab open, offers that tab's directories alone, then its root (W38)", () => {
    const s = snapshot(
      [
        group({ key: '/r/b', label: 'b', root: '/r', sessions: [] }),
        group({ key: '/r2/a', label: 'a', root: '/r2', sessions: [] }),
        group({ key: '/r/a', label: 'a', root: '/r2', sessions: [] }),
      ],
      { roots: ['/r', '/r2'] },
    );
    expect(directoryChoices(s, '/r').map((choice) => choice.path)).toEqual(['/r/b', '/r']);
    // A group the index put under /r2 whose key is under /r (a worktree's main repo) isn't /r2's to offer.
    expect(directoryChoices(s, '/r2').map((choice) => choice.path)).toEqual(['/r2/a', '/r2']);
  });

  it("places a directory under the longest root that holds it, as the index does, and keeps a typed one in the open tab (W38)", () => {
    expect(rootOf('/a/b/c', ['/a', '/a/b'])).toBe('/a/b');
    expect(rootOf('/a/bc', ['/a', '/a/b'])).toBe('/a');
    expect(rootOf('/a/b/', ['/a/b', '/a'])).toBe('/a/b');
    expect(rootOf('/z', ['/a'])).toBeUndefined();
    expect(directoryProblem('/a/x', ['/a', '/a/b'], '/a')).toBeUndefined();
    expect(directoryProblem('/a/b/x', ['/a', '/a/b'], '/a')).toBe('Use a directory under /a. /a/b has its own tab.');
    expect(directoryProblem('/a/b/x', ['/a', '/a/b'], '/a/b')).toBeUndefined();
    expect(directoryProblem('/q/x', ['/a', '/q'], '/a')).toBe('Use a directory under /a. /q has its own tab.');
    expect(directoryProblem('/elsewhere', ['/a', '/q'], '/a')).toBe('Use a directory under /a.');
    expect(directoryProblem('relative', ['/a', '/q'], '/a')).toMatch(/absolute/);
  });
});
