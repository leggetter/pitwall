// main()'s startup order, in this process, with the indexer, the relay and the
// server replaced: the token is scrubbed from process.env before anything that
// starts a child process exists, and a deleted current directory stops pitwall
// before any of them. The CLI as a process is tested in cli.test.ts.
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ calls: [] as { what: string; env: NodeJS.ProcessEnv; roots?: string[]; relayName?: string }[] }));

vi.mock('./index/index.js', () => ({
  startIndexer: vi.fn((options: { roots: string[]; relayName?: string }) => {
    seen.calls.push({ what: 'indexer', env: { ...process.env }, roots: options.roots, relayName: options.relayName });
    return { latest: () => undefined, subscribe: () => () => {}, conversation: async () => undefined, stop: () => {} };
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

// The browser opener. Replaced so that no test here can ever open a browser.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn(() => {
      seen.calls.push({ what: 'execFile', env: { ...process.env } });
      return { unref: () => {} };
    }),
  };
});

const { CWD_GONE_MESSAGE, fallbackPortMessage, fixedTokenNotice, main, USAGE } = await import('./cli.js');
const { RELAY_NAME } = await import('./server/relayPrompt.js');

const TOKEN = 'pitwall-test-token-0123456789abcdefghijklmnop';
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** What process.cwd() does once the directory it was in has been deleted. */
const gone = (): string => {
  throw Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), { code: 'ENOENT', errno: -2, syscall: 'uv_cwd' });
};

describe('main(): startup', () => {
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

  describe('when the current directory no longer exists', () => {
    it.each([
      ['an absolute root', [tmpdir()]],
      ['no roots', []],
    ])('with %s, prints one line and exits 1 before it prepares the launch directory or starts anything', async (_, roots) => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Opening is on, so a check in the wrong place would reach the launch directory and the opener.
      delete process.env.PITWALL_NO_OPEN;
      const home = join(tmpdir(), `pitwall-test-home-${process.pid}-${Date.now()}`);
      process.env.PITWALL_HOME = home;
      try {
        expect(await main(['--port', '0', ...roots], { cwd: gone })).toBe(1);

        expect(errors.mock.calls).toEqual([[`pitwall: ${CWD_GONE_MESSAGE}`]]);
        expect(CWD_GONE_MESSAGE).toBe('the current directory no longer exists. cd to one that does and run pitwall again.');
        expect(console.log).not.toHaveBeenCalled();
        expect(seen.calls).toEqual([]);
        expect(existsSync(home)).toBe(false);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });

    it('still prints --help and --version, which do not need it', async () => {
      expect(await main(['--help'], { cwd: gone })).toBe(0);
      expect(console.log).toHaveBeenCalledWith(USAGE);
      expect(await main(['--version'], { cwd: gone })).toBe(0);
      expect(console.log).toHaveBeenLastCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+/));
      expect(seen.calls).toEqual([]);
    });
  });

  describe('when the current directory exists, as before', () => {
    it('watches the current directory when no root is given', async () => {
      expect(await main(['--no-open', '--port', '0'])).toBe(0);
      expect(seen.calls.map((call) => call.what)).toEqual(['relay', 'indexer', 'server']);
      expect(seen.calls[1]?.roots).toEqual([process.cwd()]);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining(`Watching root: ${process.cwd()},`));
    });

    it("gives the indexer the relay's name, so a session's messages to it show in its conversation (W46)", async () => {
      expect(await main(['--no-open', '--port', '0', tmpdir()])).toBe(0);
      expect(seen.calls[1]).toMatchObject({ what: 'indexer', relayName: RELAY_NAME });
      expect(RELAY_NAME).toBe('pitwall-relay');
    });

    it('says a fallback port changes every run, and that --port keeps a pinned tab working', async () => {
      // The fake server listens on 45170, as the real one does on a free port when 4517 is busy.
      expect(await main(['--no-open', tmpdir()])).toBe(0);
      expect(console.log).toHaveBeenCalledWith(fallbackPortMessage(4517, 45170));
    });

    it('with PITWALL_TOKEN set, says once, on stderr, that the token is fixed, never with the token (W40)', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.env.PITWALL_TOKEN = TOKEN;
      delete process.env.PITWALL_OPEN_MARKER;
      expect(await main(['--no-open', '--port', '0', tmpdir()])).toBe(0);
      expect(errors.mock.calls).toEqual([[`pitwall: ${fixedTokenNotice()}`]]);
      expect(fixedTokenNotice()).toBe(
        'the token is fixed by PITWALL_TOKEN, so every run that uses it has the same one. Use this only on a single-user machine or for development.',
      );
      expect(JSON.stringify(errors.mock.calls)).not.toContain(TOKEN);
    });

    it('says nothing about a fixed token without PITWALL_TOKEN, with an empty one, or under npm run dev, which says it itself (W40)', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      delete process.env.PITWALL_TOKEN;
      expect(await main(['--no-open', '--port', '0', tmpdir()])).toBe(0);
      // Empty counts as unset, and isn't passed on.
      process.env.PITWALL_TOKEN = '';
      expect(await main(['--no-open', '--port', '0', tmpdir()])).toBe(0);
      expect(seen.calls.at(-1)?.env.PITWALL_TOKEN).toBeUndefined();
      process.env.PITWALL_TOKEN = TOKEN;
      process.env.PITWALL_OPEN_MARKER = join(tmpdir(), `pitwall-test-marker-${process.pid}`);
      expect(await main(['--no-open', '--port', '0', tmpdir()])).toBe(0);
      expect(errors).not.toHaveBeenCalled();
    });

    it('says nothing about the port when --port picked it', async () => {
      expect(await main(['--no-open', '--port', '0', tmpdir()])).toBe(0);
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('is busy'));
    });

    it('resolves a relative root against the directory it read', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
      try {
        await mkdir(join(dir, 'a'));
        expect(await main(['--no-open', '--port', '0', 'a'], { cwd: () => dir })).toBe(0);
        expect(seen.calls[1]?.roots).toEqual([join(dir, 'a')]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
