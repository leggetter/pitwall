import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, TRUST_PATH } from '../../../src/shared/protocol.js';
import { AttachContext, type AttachEnv } from '../attach.js';
import { computeProof } from '../proof.js';
import { fakeSockets, type FakeSocket } from '../test/fixtures.js';
import { TRUST_DECLINED, TRUST_DECLINED_RESUME, TRUST_FALLBACK, TRUST_INPUT, trustEndMessage, type TrustEnd } from '../trust.js';
import type { XtermOptions } from '../xterm.js';
import { Dialog } from './Dialog.js';
import type { TerminalHandle } from './Terminal.js';
import { isTabKey, TRUST_BUTTON, TRUST_HERE, TRUST_PROMPT_LINE, TRUSTED, TrustFolder } from './TrustFolder.js';

class FakeTerminal implements TerminalHandle {
  cols = 72;
  rows = 16;
  readonly screen: HTMLTextAreaElement;
  written: string[] = [];
  disposed = false;
  private listeners: ((data: string) => void)[] = [];
  constructor(container: HTMLElement) {
    this.screen = document.createElement('textarea');
    this.screen.className = 'fake-terminal';
    container.append(this.screen);
  }
  write(data: Uint8Array) {
    this.written.push(new TextDecoder().decode(data));
  }
  onData(listener: (data: string) => void) {
    this.listeners.push(listener);
  }
  paste(data: string) {
    this.type(data);
  }
  fit() {}
  focus() {
    this.screen.focus();
  }
  dispose() {
    this.disposed = true;
    this.screen.remove();
  }
  /** What xterm.js would send for a key or a paste. */
  type(data: string) {
    for (const listener of this.listeners) listener(data);
  }
}

const terminals: FakeTerminal[] = [];
const created: XtermOptions[] = [];
vi.mock('../xterm.js', () => ({
  createXterm: (container: HTMLElement, options: XtermOptions = {}) => {
    const terminal = new FakeTerminal(container);
    terminals.push(terminal);
    created.push(options);
    return terminal;
  },
}));

beforeEach(() => {
  terminals.length = 0;
  created.length = 0;
});

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const NONCE = 'n'.repeat(43);
const FOLDER = '/Users/example/code/demo-app';

function renderCard(options: { withEnv?: boolean; resume?: boolean } = {}) {
  const fake = fakeSockets();
  const env: AttachEnv = { token: TOKEN, createSocket: fake.factory, host: '127.0.0.1:4517' };
  const onTrusted = vi.fn();
  const onClose = vi.fn();
  const card = (
    <Dialog title="New session" onClose={onClose}>
      <p>Workspace not trusted.</p>
      <TrustFolder cwd={FOLDER} onTrusted={onTrusted} resume={options.resume ?? false} />
    </Dialog>
  );
  render(options.withEnv === false ? card : <AttachContext.Provider value={env}>{card}</AttachContext.Provider>);
  return { fake, onTrusted, onClose };
}

const sent = (socket: FakeSocket) => socket.sent.map((data) => JSON.parse(data) as Record<string, unknown>);
const settle = () => act(async () => {});

/** Presses the button and runs the server's side up to `started`. */
async function openPrompt(fake: ReturnType<typeof fakeSockets>): Promise<{ socket: FakeSocket; terminal: FakeTerminal }> {
  fireEvent.click(screen.getByRole('button', { name: TRUST_BUTTON }));
  await waitFor(() => expect(fake.sockets).toHaveLength(1));
  const socket = fake.last;
  act(() => {
    socket.open();
    socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: NONCE });
  });
  await waitFor(() => expect(socket.sent).toHaveLength(1));
  act(() => socket.receive({ type: 'ready' }));
  act(() => socket.receive({ type: 'started' }));
  return { socket, terminal: terminals.at(-1)! };
}

describe('TrustFolder (W214)', () => {
  it('shows nothing without the socket App provides, so the card has its command alone', () => {
    renderCard({ withEnv: false });
    expect(screen.queryByRole('button', { name: TRUST_BUTTON })).toBeNull();
    expect(screen.queryByText(TRUST_HERE.start)).toBeNull();
  });

  it("opens Claude Code's trust prompt for the folder, at the terminal's size, after the proof, with the line that says what it is", async () => {
    const { fake } = renderCard();
    expect(screen.getByText(TRUST_HERE.start)).toBeTruthy();
    const { socket, terminal } = await openPrompt(fake);
    expect(socket.url).toBe(`ws://127.0.0.1:4517${TRUST_PATH}`);
    expect(sent(socket)).toEqual([
      { type: 'auth', proof: await computeProof(TOKEN, NONCE) },
      { type: 'open', cwd: FOLDER, cols: 72, rows: 16 },
    ]);
    expect(JSON.stringify(socket.sent)).not.toContain(TOKEN);
    // The line describes the screen, which has focus, asked for with the button.
    const line = screen.getByText(TRUST_PROMPT_LINE);
    expect(created[0]?.describedBy).toBe(line.id);
    expect(document.activeElement).toBe(terminal.screen);
    // The PTY's output goes to the screen.
    act(() => socket.onmessage?.(new MessageEvent('message', { data: new TextEncoder().encode('Do you trust the files in this folder?').buffer })));
    expect(terminal.written).toEqual(['Do you trust the files in this folder?']);
  });

  it('sends only Up, Down, Enter and Esc: a typed character, a paste and any other key go nowhere', async () => {
    const { fake } = renderCard();
    const { socket, terminal } = await openPrompt(fake);
    const before = socket.sent.length;
    for (const data of ['y', '1', '\t', '\u001b[C', '\u0003', 'yes\r', '\u001b[200~\r\u001b[201~', 'claude --dangerously-skip-permissions\r']) terminal.type(data);
    terminal.paste('rm -rf ~\r');
    expect(socket.sent.length).toBe(before);
    for (const data of ['\u001b[A', '\u001bOA', '\u001b[B', '\u001bOB', '\r', '\u001b']) terminal.type(data);
    expect(sent(socket).slice(before)).toEqual([...TRUST_INPUT].map((data) => ({ type: 'input', data })));
  });

  it('leaves Tab to the page, so focus can leave the screen', async () => {
    const { fake } = renderCard();
    await openPrompt(fake);
    const leave = created[0]?.leaveKey;
    expect(leave).toBe(isTabKey);
    expect(isTabKey(new KeyboardEvent('keydown', { key: 'Tab' }))).toBe(true);
    expect(isTabKey(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))).toBe(true);
    expect(isTabKey(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true }))).toBe(false);
    expect(isTabKey(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(false);
  });

  it("keeps Escape in the screen for Claude Code: the dialog stays open, and Escape elsewhere still closes it", async () => {
    const { fake, onClose } = renderCard();
    const { terminal } = await openPrompt(fake);
    fireEvent.keyDown(terminal.screen, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes the socket and the terminal, puts the button back with focus, and trusts nothing', async () => {
    const { fake, onTrusted } = renderCard();
    const { socket, terminal } = await openPrompt(fake);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(socket.closedByClient).toBe(true);
    expect(terminal.disposed).toBe(true);
    expect(screen.queryByText(TRUST_PROMPT_LINE)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: TRUST_BUTTON }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(onTrusted).not.toHaveBeenCalled();
  });

  it('trusted: calls onTrusted once, closes the terminal and says the session is starting', async () => {
    const { fake, onTrusted } = renderCard();
    const { socket, terminal } = await openPrompt(fake);
    act(() => socket.receive({ type: 'outcome', outcome: 'trusted' }));
    // The server's close after the outcome changes nothing.
    act(() => socket.serverClose(1000));
    await settle();
    expect(onTrusted).toHaveBeenCalledTimes(1);
    expect(terminal.disposed).toBe(true);
    expect(screen.getByRole('status').textContent).toBe(TRUSTED.start);
  });

  it('trusted on Resume\'s card says it is resuming', async () => {
    const { fake, onTrusted } = renderCard({ resume: true });
    expect(screen.getByText(TRUST_HERE.resume)).toBeTruthy();
    const { socket } = await openPrompt(fake);
    act(() => socket.receive({ type: 'outcome', outcome: 'trusted' }));
    await settle();
    expect(onTrusted).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe(TRUSTED.resume);
  });

  it('declined: says so, starts nothing, and offers the button again, which opens a new terminal', async () => {
    const { fake, onTrusted } = renderCard();
    const { socket, terminal } = await openPrompt(fake);
    terminal.focus();
    act(() => socket.receive({ type: 'outcome', outcome: 'declined' }));
    await settle();
    expect(onTrusted).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe(TRUST_DECLINED);
    const again = screen.getByRole('button', { name: TRUST_BUTTON });
    expect(document.activeElement).toBe(again);
    fireEvent.click(again);
    await waitFor(() => expect(fake.sockets).toHaveLength(2));
    expect(terminals).toHaveLength(2);
  });

  const fallbacks: [string, (socket: FakeSocket) => void, string][] = [
    ['unclear', (socket) => socket.receive({ type: 'outcome', outcome: 'unclear' }), `pitwall couldn't tell whether Claude Code trusted this folder. ${TRUST_FALLBACK}`],
    [
      "the server's refusal, as its detail",
      (socket) => socket.receive({ type: 'error', error: "Another folder's trust prompt is open in pitwall. Close it first." }),
      `Couldn't open Claude Code's trust prompt. ${TRUST_FALLBACK} Another folder's trust prompt is open in pitwall. Close it first.`,
    ],
    ['a close with no message', (socket) => socket.serverClose(1006), `The connection to pitwall closed before Claude Code answered. ${TRUST_FALLBACK}`],
  ];
  for (const [what, end, text] of fallbacks) {
    it(`falls back to the command to copy: ${what}`, async () => {
      const { fake, onTrusted } = renderCard();
      const { socket, terminal } = await openPrompt(fake);
      act(() => end(socket));
      await settle();
      expect(onTrusted).not.toHaveBeenCalled();
      expect(terminal.disposed).toBe(true);
      expect(screen.getByRole('status').textContent).toBe(text);
      expect(within(screen.getByRole('dialog')).getByRole('button', { name: TRUST_BUTTON })).toBeTruthy();
    });
  }
});

describe('trustEndMessage (W214)', () => {
  it('has a line for each close code, and none for Cancel or trusted', () => {
    const ends: [TrustEnd, string | undefined][] = [
      [{ kind: 'outcome', outcome: 'declined' }, TRUST_DECLINED],
      [{ kind: 'busy' }, "Another folder's trust prompt is open in pitwall. Close it first."],
      [{ kind: 'try-again' }, "pitwall couldn't open the trust prompt just now. Try again in a moment, or run the command above."],
      [{ kind: 'spawn-failed' }, `pitwall couldn't start claude for the trust prompt. ${TRUST_FALLBACK}`],
      [{ kind: 'outcome', outcome: 'trusted' }, undefined],
      [{ kind: 'cancelled' }, undefined],
    ];
    for (const [end, text] of ends) expect(trustEndMessage(end)?.text).toBe(text);
    expect(trustEndMessage({ kind: 'outcome', outcome: 'declined' }, true)?.text).toBe(TRUST_DECLINED_RESUME);
    expect(trustEndMessage({ kind: 'unauthorized' })?.text).toContain('pitwall refused the sign-in proof.');
  });

  it('turns the close codes into those ends', async () => {
    const { startTrust } = await import('../trust.js');
    const cases: [number, TrustEnd['kind']][] = [
      [4401, 'unauthorized'],
      [4429, 'busy'],
      [1013, 'try-again'],
      [1011, 'spawn-failed'],
      [1000, 'closed'],
    ];
    for (const [code, kind] of cases) {
      const fake = fakeSockets();
      const statuses: string[] = [];
      startTrust({
        url: 'ws://127.0.0.1:4517/trust',
        token: TOKEN,
        cwd: FOLDER,
        size: () => ({ cols: 80, rows: 24 }),
        createSocket: fake.factory,
        onStatus: (status) => statuses.push(status.kind === 'ended' ? status.end.kind : status.kind),
        onOutput: () => {},
      });
      fake.last.serverClose(code);
      expect(statuses).toEqual(['connecting', kind]);
    }
  });
});
