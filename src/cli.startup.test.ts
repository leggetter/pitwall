// main()'s startup order, in this process, with the indexer, the relay and the
// server replaced: the token is scrubbed from process.env before anything that
// starts a child process exists. The CLI as a process is tested in cli.test.ts.
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ calls: [] as { what: string; env: NodeJS.ProcessEnv }[] }));

vi.mock('./index/index.js', () => ({
  startIndexer: vi.fn(() => {
    seen.calls.push({ what: 'indexer', env: { ...process.env } });
    return { latest: () => undefined, subscribe: () => () => {}, lastMessage: () => undefined, conversation: async () => undefined, stop: () => {} };
  }),
}));

vi.mock('./server/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./server/index.js')>();
  return {
    ...actual,
    createRelayManager: vi.fn(() => {
      seen.calls.push({ what: 'relay', env: { ...process.env } });
      return { isRelay: () => false, exchange: () => undefined, close: async () => {} };
    }),
    startServer: vi.fn(async () => {
      seen.calls.push({ what: 'server', env: { ...process.env } });
      return { url: 'http://127.0.0.1:45170', port: 45170, close: async () => {} };
    }),
  };
});

const { main } = await import('./cli.js');

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

describe('main(): the startup scrub', () => {
  const saved = { ...process.env };
  let listeners: Map<string, Function[]>;

  beforeEach(() => {
    seen.calls.length = 0;
    listeners = new Map(SIGNALS.map((signal) => [signal, process.listeners(signal)]));
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    // main() adds signal handlers to this process; take them off again.
    for (const signal of SIGNALS) {
      for (const listener of process.listeners(signal)) {
        if (!listeners.get(signal)?.includes(listener)) process.off(signal, listener as () => void);
      }
    }
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    vi.restoreAllMocks();
  });

  it('removes every variable holding the token before the relay, the indexer and the server are created', async () => {
    process.env.PITWALL_TOKEN = TOKEN;
    process.env.PITWALL_TEST_HEADER = `Bearer ${TOKEN}`;
    process.env.SOME_WRAPPER_COPY = `x${TOKEN}y`;
    process.env.PITWALL_TEST_UNRELATED = 'kept';

    expect(await main(['--no-open', '--port', '0', tmpdir()])).toBe(0);

    expect(seen.calls.map((call) => call.what)).toEqual(['relay', 'indexer', 'server']);
    for (const { what, env } of seen.calls) {
      expect(env.PITWALL_TOKEN, what).toBeUndefined();
      expect(env.PITWALL_TEST_HEADER, what).toBeUndefined();
      expect(env.SOME_WRAPPER_COPY, what).toBeUndefined();
      expect(env.PITWALL_TEST_UNRELATED, what).toBe('kept');
      expect(JSON.stringify(env), what).not.toContain(TOKEN);
    }
  });
});
