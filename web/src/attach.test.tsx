import { describe, expect, it, vi } from 'vitest';
import { ATTACH_PATH, MAX_ATTACHED, PROTOCOL_VERSION, WS_CLOSE_TOO_MANY, WS_CLOSE_UNAUTHORIZED } from '../../src/shared/protocol.js';
import {
  attachSocketUrl,
  clampSize,
  endMessage,
  INPUT_CHUNK,
  inputChunks,
  parseAttachMessage,
  startAttach,
  type AttachOptions,
  type AttachStatus,
} from './attach.js';
import { computeProof } from './proof.js';
import { fakeSockets, type FakeSocket } from './test/fixtures.js';

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const SID = '00000000-0000-4000-8000-0000000000a1';
const nonce = (i = 0) => `${'n'.repeat(41)}${String(i).padStart(2, '0')}`;

function begin(overrides: Partial<AttachOptions> = {}) {
  const fake = fakeSockets();
  const statuses: AttachStatus[] = [];
  const output: Uint8Array[] = [];
  const proofs: Promise<string>[] = [];
  let size = { cols: 120, rows: 40 };
  const session = startAttach({
    url: attachSocketUrl('127.0.0.1:4517'),
    token: TOKEN,
    sessionId: SID,
    createSocket: fake.factory,
    size: () => size,
    onStatus: (status) => statuses.push(status),
    onOutput: (data) => output.push(data),
    prove: (token, n) => {
      const proof = computeProof(token, n);
      proofs.push(proof);
      return proof;
    },
    ...overrides,
  });
  const socket = fake.sockets[0] as FakeSocket;
  return {
    fake,
    socket,
    session,
    statuses,
    output,
    status: () => statuses.at(-1),
    sent: () => socket.sent.map((data) => JSON.parse(data) as Record<string, unknown>),
    setSize: (next: { cols: number; rows: number }) => {
      size = next;
    },
    async challenge(n = nonce()) {
      socket.open();
      socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: n });
      await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(0));
    },
    async ready() {
      await this.challenge();
      socket.receive({ type: 'ready' });
    },
    async attached() {
      await this.ready();
      socket.receive({ type: 'attached' });
    },
  };
}

function binary(socket: FakeSocket, text: string) {
  const bytes = new TextEncoder().encode(text);
  socket.onmessage?.(new MessageEvent('message', { data: bytes.buffer }));
}

describe('startAttach', () => {
  it("opens a socket at the attach path on the page's server, for ArrayBuffer output", () => {
    const { socket } = begin();
    expect(socket.url).toBe(`ws://127.0.0.1:4517${ATTACH_PATH}`);
    expect((socket as FakeSocket & { binaryType?: string }).binaryType).toBe('arraybuffer');
  });

  it('answers the challenge with the HMAC proof, and never sends the token', async () => {
    const attach = begin();
    expect(attach.socket.sent).toEqual([]);
    await attach.challenge();
    expect(attach.sent()).toEqual([{ type: 'auth', proof: await computeProof(TOKEN, nonce()) }]);
    attach.socket.receive({ type: 'ready' });
    attach.socket.receive({ type: 'attached' });
    attach.session.input('typed');
    for (const data of attach.socket.sent) expect(data).not.toContain(TOKEN);
  });

  it('answers one challenge per socket', async () => {
    const attach = begin();
    await attach.challenge(nonce(1));
    attach.socket.receive({ type: 'challenge', version: PROTOCOL_VERSION, nonce: nonce(2) });
    await Promise.resolve();
    expect(attach.socket.sent).toHaveLength(1);
  });

  it.each([PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1])('sends no proof to a server on protocol version %i', async (version) => {
    const attach = begin();
    attach.socket.receive({ type: 'challenge', version, nonce: nonce() });
    expect(attach.socket.sent).toEqual([]);
    expect(attach.socket.closedByClient).toBe(true);
    expect(attach.status()).toEqual({
      kind: 'ended',
      end: { kind: 'error', error: expect.stringContaining(`protocol version ${version}, and this page speaks version ${PROTOCOL_VERSION}`) },
    });
  });

  it('ignores ready before the proof, then opens the session at the terminal size, clamped', async () => {
    const attach = begin();
    attach.socket.receive({ type: 'ready' });
    expect(attach.socket.sent).toEqual([]);
    attach.setSize({ cols: 900, rows: 1 });
    await attach.ready();
    expect(attach.sent().at(-1)).toEqual({ type: 'open', sessionId: SID, cols: 500, rows: 2 });
    expect(attach.status()).toEqual({ kind: 'connecting' });
  });

  it('becomes attached, and passes binary output on only once attached', async () => {
    const attach = begin();
    await attach.ready();
    binary(attach.socket, 'too early');
    attach.socket.receive({ type: 'attached' });
    expect(attach.status()).toEqual({ kind: 'attached' });
    binary(attach.socket, 'hello ✓');
    expect(attach.output.map((bytes) => new TextDecoder().decode(bytes))).toEqual(['hello ✓']);
  });

  describe('a session that is not running', () => {
    it('waits for confirmation on needs-restart, then opens again with restart: true at the current size', async () => {
      const attach = begin();
      await attach.ready();
      attach.socket.receive({ type: 'needs-restart' });
      expect(attach.status()).toEqual({ kind: 'confirm-restart' });
      expect(attach.sent()).toHaveLength(2);

      attach.setSize({ cols: 100, rows: 30 });
      attach.session.confirmRestart();
      expect(attach.sent().at(-1)).toEqual({ type: 'open', sessionId: SID, cols: 100, rows: 30, restart: true });
      expect(attach.status()).toEqual({ kind: 'connecting' });
      attach.socket.receive({ type: 'attached' });
      expect(attach.status()).toEqual({ kind: 'attached' });
    });

    it('never sends restart without confirmRestart(), and detach() declines', async () => {
      const attach = begin();
      await attach.ready();
      attach.socket.receive({ type: 'needs-restart' });
      attach.session.input('x');
      attach.session.resize(90, 30);
      attach.session.detach();
      expect(attach.sent().some((message) => message.restart === true)).toBe(false);
      expect(attach.socket.closedByClient).toBe(true);
      expect(attach.status()).toEqual({ kind: 'ended', end: { kind: 'detached' } });
    });

    it('ignores confirmRestart() when nothing asked for it', async () => {
      const attach = begin();
      await attach.attached();
      attach.session.confirmRestart();
      expect(attach.sent().filter((message) => message.type === 'open')).toHaveLength(1);
    });
  });

  describe('once attached', () => {
    it('sends input, in pieces of at most INPUT_CHUNK', async () => {
      const attach = begin();
      await attach.attached();
      attach.session.input('ls\r');
      const paste = 'p'.repeat(INPUT_CHUNK * 2 + 5);
      attach.session.input(paste);
      const inputs = attach.sent().filter((message) => message.type === 'input');
      expect(inputs.map((message) => (message.data as string).length)).toEqual([3, INPUT_CHUNK, INPUT_CHUNK, 5]);
      expect(inputs.slice(1).map((message) => message.data).join('')).toBe(paste);
    });

    it('sends a resize only when the clamped size changed', async () => {
      const attach = begin();
      await attach.attached();
      attach.session.resize(120, 40);
      attach.session.resize(100, 30);
      attach.session.resize(100.7, 30.2);
      attach.session.resize(0, 9999);
      expect(attach.sent().filter((message) => message.type === 'resize')).toEqual([
        { type: 'resize', cols: 100, rows: 30 },
        { type: 'resize', cols: 2, rows: 200 },
      ]);
    });

    it('sends neither input nor resize before it is attached', async () => {
      const attach = begin();
      await attach.ready();
      attach.session.input('early');
      attach.session.resize(90, 20);
      expect(attach.sent().map((message) => message.type)).toEqual(['auth', 'open']);
    });
  });

  describe('ending', () => {
    it('ends on exit, with the code', async () => {
      const attach = begin();
      await attach.attached();
      attach.socket.receive({ type: 'exit', code: 2 });
      expect(attach.status()).toEqual({ kind: 'ended', end: { kind: 'exit', code: 2 } });
      attach.socket.serverClose(1000);
      expect(attach.status()).toEqual({ kind: 'ended', end: { kind: 'exit', code: 2 } });
    });

    it("ends on an error, with the server's message", async () => {
      const attach = begin();
      await attach.ready();
      attach.socket.receive({ type: 'error', error: "That session isn't listed under pitwall's roots." });
      // As the server's own words, apart from the page's, so the notice can show them as its detail.
      expect(attach.status()).toEqual({ kind: 'ended', end: { kind: 'server', reason: "That session isn't listed under pitwall's roots." } });
    });

    it(`ends as too-many on close ${WS_CLOSE_TOO_MANY}, unauthorized on ${WS_CLOSE_UNAUTHORIZED}, and closed otherwise`, async () => {
      for (const [code, kind] of [
        [WS_CLOSE_TOO_MANY, 'too-many'],
        [WS_CLOSE_UNAUTHORIZED, 'unauthorized'],
        [1006, 'closed'],
      ] as const) {
        const attach = begin();
        await attach.challenge();
        attach.socket.serverClose(code);
        expect(attach.status()).toEqual({ kind: 'ended', end: { kind } });
      }
    });

    it('detach() closes the socket and ignores anything after', async () => {
      const attach = begin();
      await attach.attached();
      attach.session.detach();
      expect(attach.socket.closedByClient).toBe(true);
      expect(attach.socket.onmessage).toBeNull();
      expect(attach.status()).toEqual({ kind: 'ended', end: { kind: 'detached' } });
      const count = attach.statuses.length;
      attach.session.detach();
      expect(attach.statuses).toHaveLength(count);
    });

    it('ends with an error when the socket cannot be created', () => {
      const attach = begin({
        createSocket: () => {
          throw new Error('blocked');
        },
      });
      expect(attach.status()).toMatchObject({ kind: 'ended', end: { kind: 'error' } });
    });
  });
});

describe('endMessage', () => {
  it('says what happened, in a short notice', () => {
    expect(endMessage({ kind: 'too-many' })).toEqual({ text: `${MAX_ATTACHED} sessions are already attached; detach one first.` });
    expect(endMessage({ kind: 'too-many' })).toEqual({ text: '4 sessions are already attached; detach one first.' });
    expect(endMessage({ kind: 'exit', code: 0 })).toEqual({ text: 'claude attach ended.' });
    expect(endMessage({ kind: 'exit', code: 1 })).toEqual({ text: 'claude attach ended with exit code 1.' });
    // The page's own words are its text; the server's are the detail, apart from it (W31).
    expect(endMessage({ kind: 'error', error: 'the page made up this reason.' })).toEqual({ text: "Couldn't attach: the page made up this reason." });
    expect(endMessage({ kind: 'server', reason: 'A made-up reason from the server.' })).toEqual({ text: "Couldn't attach:", detail: 'A made-up reason from the server.' });
    expect(endMessage({ kind: 'detached' })).toBeUndefined();
  });
});

describe('inputChunks', () => {
  it('keeps short input whole, and splits long input', () => {
    expect(inputChunks('abc')).toEqual(['abc']);
    expect(inputChunks('abcdef', 4)).toEqual(['abcd', 'ef']);
    expect(inputChunks('')).toEqual([]);
  });

  it('never splits a surrogate pair', () => {
    const text = `ab${'😀'.repeat(3)}`;
    const chunks = inputChunks(text, 3);
    expect(chunks.join('')).toBe(text);
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const chunk of chunks) expect(loneSurrogate.test(chunk), JSON.stringify(chunk)).toBe(false);
  });
});

describe('clampSize', () => {
  it('clamps to 2-500 columns and 2-200 rows, whole numbers', () => {
    expect(clampSize(80, 24)).toEqual({ cols: 80, rows: 24 });
    expect(clampSize(1, 1)).toEqual({ cols: 2, rows: 2 });
    expect(clampSize(1000, 1000)).toEqual({ cols: 500, rows: 200 });
    expect(clampSize(80.9, Number.NaN)).toEqual({ cols: 80, rows: 2 });
  });
});

describe('parseAttachMessage', () => {
  it('parses the messages the contract defines', () => {
    expect(parseAttachMessage(JSON.stringify({ type: 'challenge', version: 2, nonce: nonce() }))).toEqual({
      type: 'challenge',
      version: 2,
      nonce: nonce(),
    });
    for (const type of ['ready', 'needs-restart', 'attached'] as const) expect(parseAttachMessage(JSON.stringify({ type }))).toEqual({ type });
    expect(parseAttachMessage(JSON.stringify({ type: 'exit', code: 0 }))).toEqual({ type: 'exit', code: 0 });
    expect(parseAttachMessage(JSON.stringify({ type: 'exit', code: null }))).toEqual({ type: 'exit', code: null });
    expect(parseAttachMessage(JSON.stringify({ type: 'error', error: 'no' }))).toEqual({ type: 'error', error: 'no' });
  });

  it('ignores anything else', () => {
    for (const message of [
      { type: 'challenge', version: 2, nonce: 'short' },
      { type: 'exit', code: '0' },
      { type: 'exit' },
      { type: 'error' },
      { type: 'snapshot', snapshot: {} },
    ]) {
      expect(parseAttachMessage(JSON.stringify(message)), JSON.stringify(message)).toBeUndefined();
    }
    expect(parseAttachMessage('not json')).toBeUndefined();
    expect(parseAttachMessage(new ArrayBuffer(2))).toBeUndefined();
  });
});
