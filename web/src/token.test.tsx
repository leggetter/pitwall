import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LinkCodes } from '../../src/server/linkCodes.js';
import { linkConfirmMac } from '../../src/server/security.js';
import {
  answerLinkRequests,
  askForToken,
  LINK_RATE_MAX,
  linkCodeHash,
  LinkConfirmer,
  pageLinkCode,
  sealToken,
  useLinkedToken,
  type ChannelFactory,
  type ChannelLike,
} from './tokenLink.js';
import { parseHashToken, takeToken, TOKEN_STORAGE_KEY, type TokenEnv } from './token.js';

function fakeEnv(hash: string, stored: Record<string, string> = {}) {
  const storage = new Map(Object.entries(stored));
  const env = {
    location: { hash, pathname: '/', search: '' },
    history: { state: null, replaceState: vi.fn() },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
  } satisfies TokenEnv;
  return { env, storage };
}

describe('parseHashToken', () => {
  it('reads the token and leaves nothing behind', () => {
    expect(parseHashToken('#token=abc123')).toEqual({ token: 'abc123', rest: '' });
  });

  it('keeps other fragment parameters', () => {
    expect(parseHashToken('#token=abc123&view=all')).toEqual({ token: 'abc123', rest: '#view=all' });
  });

  it('reports no token when the fragment has none', () => {
    expect(parseHashToken('')).toEqual({ token: undefined, rest: '' });
    expect(parseHashToken('#view=all')).toEqual({ token: undefined, rest: '#view=all' });
  });
});

describe('takeToken', () => {
  it('stores the token from the fragment and removes it from the address bar', () => {
    const { env, storage } = fakeEnv('#token=abc123');

    expect(takeToken(env)).toBe('abc123');
    expect(storage.get(TOKEN_STORAGE_KEY)).toBe('abc123');
    expect(env.history.replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('falls back to the stored token when the fragment has none', () => {
    const { env } = fakeEnv('', { [TOKEN_STORAGE_KEY]: 'stored-token' });

    expect(takeToken(env)).toBe('stored-token');
    expect(env.history.replaceState).not.toHaveBeenCalled();
  });

  it('prefers a new token in the fragment over the stored one', () => {
    const { env, storage } = fakeEnv('#token=fresh', { [TOKEN_STORAGE_KEY]: 'old' });

    expect(takeToken(env)).toBe('fresh');
    expect(storage.get(TOKEN_STORAGE_KEY)).toBe('fresh');
  });

  it('returns null when there is no token anywhere', () => {
    expect(takeToken(fakeEnv('').env)).toBeNull();
  });

  it('cleans an empty token out of the address bar and returns null', () => {
    const { env } = fakeEnv('#token=');

    expect(takeToken(env)).toBeNull();
    expect(env.history.replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('still returns the fragment token when storage is unavailable', () => {
    const { env } = fakeEnv('#token=abc123');
    env.sessionStorage.setItem = () => {
      throw new Error('storage disabled');
    };

    expect(takeToken(env)).toBe('abc123');
  });

  it('works against the real window: the token leaves the URL and lands in sessionStorage', () => {
    window.history.replaceState(null, '', '/?x=1#token=abc123');

    expect(takeToken()).toBe('abc123');
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain('abc123');
    expect(window.location.search).toBe('?x=1');
    expect(window.sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe('abc123');
  });
});

// A pitwall link opened in a new tab (W175, D7): the token moves between tabs on a BroadcastChannel.
describe('a pitwall link in a new tab (W175)', () => {
  const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';

  /** One BroadcastChannel name: every channel object hears what the others post, not its own, and the log keeps it all. */
  function bus() {
    const channels = new Set<ChannelLike>();
    const log: unknown[] = [];
    const make: ChannelFactory = () => {
      const channel: ChannelLike = {
        onmessage: null,
        postMessage(message) {
          log.push(message);
          const copy = JSON.parse(JSON.stringify(message)) as unknown;
          for (const other of channels) if (other !== channel) setTimeout(() => other.onmessage?.({ data: copy }), 0);
        },
        close() {
          channels.delete(channel);
        },
      };
      channels.add(channel);
      return channel;
    };
    return { make, log };
  }

  /** The server's side: the codes it issued, as a signed-in tab's confirm reaches them. */
  function server(mac: (hash: string, code: string) => string = (hash, code) => linkConfirmMac(TOKEN, hash, code, location.origin)) {
    const codes = new LinkCodes();
    const confirm = vi.fn(async (hash: string) => {
      const code = codes.redeem(hash);
      return code === undefined ? undefined : { code, mac: mac(hash, code) };
    });
    return { codes, confirm, confirmer: { confirm } };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

  it('gives a tab with no token the token from a tab that has it, and stores it as the launch file would', async () => {
    const { make, log } = bus();
    const { codes, confirmer } = server();
    const stop = answerLinkRequests({ token: TOKEN, confirmer, channel: make });
    const stored: string[] = [];

    const token = await askForToken({ code: codes.issue(), channel: make, store: (value) => stored.push(value), timeoutMs: 1000 });

    expect(token).toBe(TOKEN);
    expect(stored).toEqual([TOKEN]);
    // Nothing on the channel, the request or the answer, holds the token or the code in the clear.
    expect(JSON.stringify(log)).not.toContain(TOKEN);
    stop();
  });

  it('seals nothing, and broadcasts nothing, when the confirmation has no MAC, or one from a server that does not know the token', async () => {
    for (const mac of [() => '', () => linkConfirmMac('a-token-it-guessed', 'x', 'y', location.origin), (hash: string, code: string) => linkConfirmMac(TOKEN, hash, code, 'http://127.0.0.1:1')]) {
      const { make, log } = bus();
      const { codes, confirm, confirmer } = server(mac);
      const stop = answerLinkRequests({ token: TOKEN, confirmer, channel: make });

      expect(await askForToken({ code: codes.issue(), channel: make, timeoutMs: 60 })).toBeNull();

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(log.filter((message) => (message as { type?: string }).type === 'link-answer')).toEqual([]);
      stop();
    }
  });

  it('shows the sign-in notice when no tab answers in time', async () => {
    const { make } = bus();
    const { codes } = server();

    expect(await askForToken({ code: codes.issue(), channel: make, timeoutMs: 40 })).toBeNull();
  });

  it('asks nothing of a page with no code, or a browser with no channel', async () => {
    const { make, log } = bus();
    expect(await askForToken({ code: null, channel: make, timeoutMs: 20 })).toBeNull();
    expect(await askForToken({ code: server().codes.issue(), channel: undefined, timeoutMs: 20 })).toBeNull();
    expect(log).toEqual([]);
  });

  it('blanks the page tag once it has read the code, and still asks once', async () => {
    const { make, log } = bus();
    const { codes } = server();
    const meta = document.createElement('meta');
    meta.name = 'pitwall-link';
    meta.content = codes.issue();
    document.head.append(meta);
    try {
      const { result } = renderHook(() => useLinkedToken(true, make));
      expect(result.current.asking).toBe(true);
      await tick();
      expect(meta.getAttribute('content')).toBe('');
      expect(pageLinkCode()).toBeNull();
      expect(log.filter((message) => (message as { type?: string }).type === 'link-request')).toHaveLength(1);
    } finally {
      meta.remove();
    }
  });

  it('does not ask when the tab has a token', () => {
    const { make, log } = bus();
    const { result } = renderHook(() => useLinkedToken(false, make));

    expect(result.current).toEqual({ token: null, asking: false });
    expect(log).toEqual([]);
  });

  it('ignores an answer that is not for this page: another hash, or a key that is not its code', async () => {
    const { make } = bus();
    const { codes } = server();
    const code = codes.issue();
    const mine = await linkCodeHash(code);
    const other = server().codes.issue();
    const otherHash = await linkCodeHash(other);
    const channel = make();

    const asking = askForToken({ code, channel: make, timeoutMs: 150 });
    await tick();
    channel.postMessage(await sealToken('someone-elses-token', other, otherHash));
    // The right hash, but sealed under a code this page doesn't hold, as a page that saw the hash on the channel would send.
    channel.postMessage(await sealToken('attackers-token', other, mine));
    channel.postMessage({ type: 'link-answer', hash: mine, iv: 'x', data: 'y' });
    channel.postMessage('nonsense');

    expect(await asking).toBeNull();
  });

  it('gets no answer for a code the server never issued', async () => {
    const { make } = bus();
    const { confirm, confirmer } = server();
    answerLinkRequests({ token: TOKEN, confirmer, channel: make });

    // A page another process served, with a code of its own making.
    const forged = new LinkCodes().issue();

    expect(await askForToken({ code: forged, channel: make, timeoutMs: 100 })).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('gets no answer for a code that was already used', async () => {
    const { make } = bus();
    const { codes, confirmer } = server();
    answerLinkRequests({ token: TOKEN, confirmer, channel: make });
    const code = codes.issue();
    expect(await askForToken({ code, channel: make, timeoutMs: 1000 })).toBe(TOKEN);

    // The same code again, as a replayed request would be.
    expect(await askForToken({ code, channel: make, timeoutMs: 100 })).toBeNull();
  });

  it('answers a request once even when the same hash is posted again', async () => {
    const { make, log } = bus();
    const { codes, confirm, confirmer } = server();
    answerLinkRequests({ token: TOKEN, confirmer, channel: make });
    const code = codes.issue();
    const hash = await linkCodeHash(code);
    const channel = make();

    channel.postMessage({ type: 'link-request', hash });
    channel.postMessage({ type: 'link-request', hash });
    await tick();
    await tick();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(log.filter((message) => (message as { type: string }).type === 'link-answer')).toHaveLength(1);
  });

  it('gives the token once when two tabs hold it and both hear the request', async () => {
    const { make, log } = bus();
    const { codes, confirmer } = server();
    answerLinkRequests({ token: TOKEN, confirmer, channel: make });
    answerLinkRequests({ token: TOKEN, confirmer, channel: make });

    expect(await askForToken({ code: codes.issue(), channel: make, timeoutMs: 1000 })).toBe(TOKEN);
    await tick();

    expect(log.filter((message) => (message as { type: string }).type === 'link-answer')).toHaveLength(1);
  });

  it('does not answer while its WebSocket is not signed in', async () => {
    const { make } = bus();
    const { codes } = server();
    const confirmer = new LinkConfirmer(50);
    answerLinkRequests({ token: TOKEN, confirmer, channel: make });

    // Never opened: no socket to confirm on.
    expect(await askForToken({ code: codes.issue(), channel: make, timeoutMs: 100 })).toBeNull();
  });

  it('answers a request that is not a valid hash with nothing, and no more than a few a moment', async () => {
    const { make, log } = bus();
    const { confirm, confirmer } = server();
    let now = 1_000;
    answerLinkRequests({ token: TOKEN, confirmer, channel: make, now: () => now });
    const channel = make();

    channel.postMessage({ type: 'link-request', hash: 'short' });
    channel.postMessage({ type: 'link-request' });
    channel.postMessage({ type: 'link-request', hash: 42 });
    for (let i = 0; i < LINK_RATE_MAX + 5; i += 1) channel.postMessage({ type: 'link-request', hash: `${String(i).padStart(2, '0')}${'a'.repeat(41)}` });
    await tick();

    expect(confirm).toHaveBeenCalledTimes(LINK_RATE_MAX);
    expect(log.some((message) => (message as { type: string }).type === 'link-answer')).toBe(false);
    now += 20_000;
    channel.postMessage({ type: 'link-request', hash: 'z'.repeat(43) });
    await tick();
    expect(confirm).toHaveBeenCalledTimes(LINK_RATE_MAX + 1);
  });
});

describe('LinkConfirmer', () => {
  it('sends the hash on the signed-in socket and resolves with the code the server returns', async () => {
    const confirmer = new LinkConfirmer(1000);
    const sent: unknown[] = [];
    confirmer.open((message) => sent.push(message));

    const asked = confirmer.confirm('h');
    expect(sent).toEqual([{ type: 'link-confirm', hash: 'h' }]);
    confirmer.handle({ type: 'link-confirmed', hash: 'h', code: 'c', mac: 'm' });

    expect(await asked).toEqual({ code: 'c', mac: 'm' });
  });

  it('resolves undefined when the server denies, the socket closes, or it never answers', async () => {
    const confirmer = new LinkConfirmer(30);
    confirmer.open(() => {});

    const denied = confirmer.confirm('a');
    confirmer.handle({ type: 'link-denied', hash: 'a' });
    expect(await denied).toBeUndefined();

    const closed = confirmer.confirm('b');
    confirmer.close();
    expect(await closed).toBeUndefined();

    confirmer.open(() => {});
    expect(await confirmer.confirm('c')).toBeUndefined();
    // Closed, there is no socket to ask on at all.
    confirmer.close();
    expect(await confirmer.confirm('d')).toBeUndefined();
  });

  it('ignores a reply nobody asked for', () => {
    const confirmer = new LinkConfirmer();
    expect(() => confirmer.handle({ type: 'link-confirmed', hash: 'x', code: 'y', mac: 'm' })).not.toThrow();
  });
});

describe('pageLinkCode', () => {
  it('reads a well-formed code from the page tag, and nothing else', () => {
    const doc = (content: string | null) => ({ querySelector: () => (content === null ? null : { getAttribute: () => content }) }) as unknown as Document;
    const code = new LinkCodes().issue();

    expect(pageLinkCode(doc(code))).toBe(code);
    expect(pageLinkCode(doc(''))).toBeNull();
    expect(pageLinkCode(doc('not a code'))).toBeNull();
    expect(pageLinkCode(doc(null))).toBeNull();
  });
});
