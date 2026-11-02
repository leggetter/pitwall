import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  browserCommand,
  claimOpenMarker,
  currentDirectory,
  effectiveRoots,
  envFileProblem,
  fallbackPortMessage,
  FIXED_TOKEN_LINE,
  fixedTokenNotice,
  hasFixedToken,
  openInsteadHint,
  parseCliArgs,
  repeatsOnePiece,
  resolveRoots,
  resolveToken,
  resolveWebRoot,
  runningLines,
  TOKEN_MIN_DIFFERENT,
  USAGE,
  UsageError,
} from './cli.js';
import { DEFAULT_POLL_INTERVAL_MS, WS_PATH } from './shared/protocol.js';
import { pitwallOrigin, proofFor } from './test/proof.js';

describe('parseCliArgs', () => {
  it('defaults to no roots, the default port and opening the browser', () => {
    expect(parseCliArgs([], {})).toEqual({ kind: 'run', roots: [], open: true, prs: true });
  });

  it('takes several roots, --port and --no-open in any order', () => {
    expect(parseCliArgs(['a', '--port', '5000', 'b', '--no-open'], {})).toEqual({
      kind: 'run',
      roots: ['a', 'b'],
      port: 5000,
      open: false,
      prs: true,
    });
    expect(parseCliArgs(['--port=0', 'a'], {})).toEqual({ kind: 'run', roots: ['a'], port: 0, open: true, prs: true });
  });

  it('treats everything after -- as a root', () => {
    expect(parseCliArgs(['--', '--port'], {})).toEqual({ kind: 'run', roots: ['--port'], open: true, prs: true });
  });

  it('skips the browser when PITWALL_NO_OPEN=1', () => {
    expect(parseCliArgs([], { PITWALL_NO_OPEN: '1' })).toMatchObject({ open: false });
    expect(parseCliArgs([], { PITWALL_NO_OPEN: '0' })).toMatchObject({ open: true });
  });

  it('recognises --help, -h, --version and -v', () => {
    expect(parseCliArgs(['--help'], {})).toEqual({ kind: 'help' });
    expect(parseCliArgs(['-h', 'root'], {})).toEqual({ kind: 'help' });
    expect(parseCliArgs(['--version'], {})).toEqual({ kind: 'version' });
    expect(parseCliArgs(['-v'], {})).toEqual({ kind: 'version' });
  });

  it.each([['-1'], ['65536'], ['abc'], ['4517.5'], [''], ['0x10'], ['1e3']])('rejects --port %j', (port) => {
    expect(() => parseCliArgs(['--port', port], {})).toThrow(UsageError);
  });

  it('rejects --port without a value', () => {
    expect(() => parseCliArgs(['--port'], {})).toThrow(UsageError);
  });

  it('takes --interval in whole seconds from 1 to 300, as milliseconds', () => {
    expect(parseCliArgs(['--interval', '2', 'a'], {})).toEqual({ kind: 'run', roots: ['a'], intervalMs: 2000, open: true, prs: true });
    expect(parseCliArgs(['--interval=1'], {})).toMatchObject({ intervalMs: 1000 });
    expect(parseCliArgs(['--interval', '300'], {})).toMatchObject({ intervalMs: 300_000 });
    expect(parseCliArgs(['--interval', '010'], {})).toMatchObject({ intervalMs: 10_000 });
  });

  it('leaves the interval to the indexer default, 5 seconds, without --interval', () => {
    expect(parseCliArgs(['a'], {})).not.toHaveProperty('intervalMs');
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(5000);
  });

  it.each([['0'], ['301'], ['-1'], ['2.5'], ['abc'], [''], ['1e2'], ['0x10'], [' 5'], ['5s'], ['0005']])(
    'rejects --interval %j with a clear message',
    (interval) => {
      expect(() => parseCliArgs(['--interval', interval], {})).toThrow(UsageError);
      if (!interval.startsWith('-')) {
        expect(() => parseCliArgs(['--interval', interval], {})).toThrow(
          `--interval must be a whole number of seconds from 1 to 300, not "${interval}"`,
        );
      }
    },
  );

  it('rejects --interval without a value', () => {
    expect(() => parseCliArgs(['--interval'], {})).toThrow(UsageError);
  });

  it('mentions --interval and its default in the help', () => {
    expect(USAGE).toContain('[--interval <seconds>]');
    expect(USAGE).toMatch(/--interval <seconds> +How often to poll claude agents, in whole seconds\n +from 1 to 300\. Default 5\./);
  });

  it('warns in the help that reusing PITWALL_TOKEN keeps one token alive across runs', () => {
    expect(USAGE.replace(/\s+/g, ' ')).toContain('Reusing it keeps one token alive across runs');
  });

  it('turns pull requests off with --no-prs (M4, W93), anywhere among the roots', () => {
    expect(parseCliArgs(['a', '--no-prs', 'b'], {})).toEqual({ kind: 'run', roots: ['a', 'b'], open: true, prs: false });
    expect(parseCliArgs(['--no-prs', '--no-open'], {})).toMatchObject({ open: false, prs: false });
    expect(() => parseCliArgs(['--no-prs=1'], {})).toThrow(UsageError);
    expect(() => parseCliArgs(['--prs'], {})).toThrow(UsageError);
  });

  it('says in the help what --no-prs does, and that pitwall otherwise runs gh', () => {
    expect(USAGE).toContain('[--no-open] [--no-prs]');
    expect(USAGE.replace(/\s+/g, ' ')).toContain(
      "--no-prs Don't list your open pull requests, and never run gh. Without it, pitwall runs gh api graphql at start, every 3 minutes and on Refresh, for your open PRs on github.com. gh must be installed and logged in.",
    );
  });

  it('rejects unknown options', () => {
    expect(() => parseCliArgs(['--host', '0.0.0.0'], {})).toThrow(UsageError);
    expect(() => parseCliArgs(['--token', 'x'], {})).toThrow(UsageError);
  });

  it('takes --config <path> as given, and refuses it without a path (W103)', () => {
    expect(parseCliArgs(['--config', 'my.json', 'a'], {})).toEqual({ kind: 'run', roots: ['a'], config: 'my.json', open: true, prs: true });
    expect(parseCliArgs(['--config=~/p.json'], {})).toMatchObject({ config: '~/p.json' });
    expect(() => parseCliArgs(['--config'], {})).toThrow(UsageError);
    expect(() => parseCliArgs(['--config='], {})).toThrow(new UsageError('--config needs a path'));
  });

  it('says in the help where the config file is, its example, precedence, and that it never holds the token (W103)', () => {
    expect(USAGE).toContain('[--config <path>]');
    const help = USAGE.replace(/\s+/g, ' ');
    expect(help).toContain('--config <path> Read this config file instead of ~/.pitwall/config.json. It must exist.');
    expect(help).toContain("With --config, pitwall reads that file. Without it, pitwall reads config.json in ~/.pitwall, or in PITWALL_HOME when that's set, if it's there.");
    expect(help).toContain('On macOS and Linux, the file must be yours, and not writable by group or others.');
    expect(help).toContain('{ "path": "~/work", "github": { "owners": ["example-co"] } }');
    expect(help).toContain("Roots given as arguments replace the file's, and each keeps its \"github\" settings when it's the same directory as one in the file.");
    expect(help).toContain("It can't hold a token: PITWALL_TOKEN comes from the environment only, and GitHub's stays in gh.");
    expect(help).toContain('PITWALL_HOME Where config.json, launch files and attachments are, instead of ~/.pitwall.');
  });
});

describe('fallbackPortMessage', () => {
  it('says the port changes every run, and that --port keeps a pinned tab working', () => {
    expect(fallbackPortMessage(4517, 53122)).toBe(
      'pitwall: port 4517 is busy, so this run uses port 53122, which changes every time. ' +
        'A pinned pitwall tab needs the same port every run, so start pitwall with --port <n> to keep one working.',
    );
    expect(USAGE.replace(/\s+/g, ' ')).toContain('A pinned tab needs the same port every run, so give one with --port if 4517 is often busy.');
  });
});

describe('resolveRoots', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
    await mkdir(join(tmp, 'a'));
    await mkdir(join(tmp, 'b'));
    await writeFile(join(tmp, 'file'), '');
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('defaults to the current directory', () => {
    expect(resolveRoots([], tmp)).toEqual([tmp]);
  });

  it('resolves relative and absolute roots to absolute paths', () => {
    expect(resolveRoots(['a', join(tmp, 'b'), './a/../b'], tmp)).toEqual([join(tmp, 'a'), join(tmp, 'b'), join(tmp, 'b')]);
  });

  it('fails clearly for a root that does not exist', () => {
    expect(() => resolveRoots(['a', 'missing'], tmp)).toThrow(new UsageError(`root does not exist: ${join(tmp, 'missing')}`));
  });

  it('fails clearly for a root that is a file', () => {
    expect(() => resolveRoots(['file'], tmp)).toThrow(new UsageError(`root is not a directory: ${join(tmp, 'file')}`));
  });
});

describe('effectiveRoots (W103)', () => {
  let tmp: string;
  const file = '/home/example/.pitwall/config.json';
  const configured = (...paths: string[]) => ({ file, roots: paths.map((path, i) => ({ key: `roots[${i}]`, path, real: path })) });

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
    await mkdir(join(tmp, 'a'));
    await mkdir(join(tmp, 'b'));
    await writeFile(join(tmp, 'file'), '');
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("uses the arguments when there are any, replacing the file's roots", () => {
    expect(effectiveRoots(['a'], configured(join(tmp, 'b')), tmp)).toEqual([join(tmp, 'a')]);
  });

  it("uses the file's roots without arguments, in their order", () => {
    expect(effectiveRoots([], configured(join(tmp, 'b'), join(tmp, 'a')), tmp)).toEqual([join(tmp, 'b'), join(tmp, 'a')]);
  });

  it('uses the current directory with neither', () => {
    expect(effectiveRoots([], { file }, tmp)).toEqual([tmp]);
  });

  it("names the file's key when one of its roots isn't a directory", () => {
    expect(() => effectiveRoots([], configured(join(tmp, 'a'), join(tmp, 'file')), tmp)).toThrow(
      new UsageError(`root is not a directory: ${join(tmp, 'file')} ("roots[1]" in ${file})`),
    );
    expect(() => effectiveRoots([], configured(join(tmp, 'missing')), tmp)).toThrow(
      new UsageError(`root does not exist: ${join(tmp, 'missing')} ("roots[0]" in ${file})`),
    );
  });
});

/** An error shaped like the one process.cwd() throws, from libuv's uv_cwd. */
function cwdError(code: string, errno: number, syscall = 'uv_cwd'): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: no such file or directory, ${syscall}`), { code, errno, syscall });
}

describe('currentDirectory', () => {
  it('returns the current directory when it exists', () => {
    expect(currentDirectory(() => '/home/someone/project')).toBe('/home/someone/project');
    expect(currentDirectory()).toBe(process.cwd());
  });

  it('returns undefined when the current directory has been deleted: ENOENT from uv_cwd', () => {
    expect(
      currentDirectory(() => {
        throw cwdError('ENOENT', -2);
      }),
    ).toBeUndefined();
  });

  it('throws any other failure as it was', () => {
    const denied = cwdError('EACCES', -13);
    expect(() =>
      currentDirectory(() => {
        throw denied;
      }),
    ).toThrow(denied);
    // ENOENT from another call isn't the current directory going away.
    const stat = cwdError('ENOENT', -2, 'stat');
    expect(() =>
      currentDirectory(() => {
        throw stat;
      }),
    ).toThrow(stat);
    expect(() =>
      currentDirectory(() => {
        throw 'not an error';
      }),
    ).toThrow('not an error');
  });
});

describe('resolveToken', () => {
  it('generates 32 random bytes as base64url', () => {
    const a = resolveToken({});
    const b = resolveToken({});
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it('uses PITWALL_TOKEN when it is set and valid', () => {
    const token = 'pitwall-test-token-0123456789abcd';
    expect(resolveToken({ PITWALL_TOKEN: token })).toBe(token);
  });

  it('rejects a PITWALL_TOKEN shorter than 32 characters', () => {
    expect(() => resolveToken({ PITWALL_TOKEN: 'a'.repeat(31) })).toThrow(/at least 32 characters/);
    expect(() => resolveToken({ PITWALL_TOKEN: 'a' })).toThrow(/at least 32 characters/);
  });

  it('takes an empty PITWALL_TOKEN as unset: a new random token, and not a fixed one (W40)', () => {
    const a = resolveToken({ PITWALL_TOKEN: '' });
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(resolveToken({ PITWALL_TOKEN: '' })).not.toBe(a);
    expect(hasFixedToken({ PITWALL_TOKEN: '' })).toBe(false);
    expect(hasFixedToken({})).toBe(false);
    expect(hasFixedToken({ PITWALL_TOKEN: 'pitwall-test-token-0123456789abcd' })).toBe(true);
  });

  it('rejects a PITWALL_TOKEN with characters outside base64url', () => {
    expect(() => resolveToken({ PITWALL_TOKEN: `${'a'.repeat(32)}&calc` })).toThrow(UsageError);
    expect(() => resolveToken({ PITWALL_TOKEN: `${'a'.repeat(32)}\r\nX: y` })).toThrow(UsageError);
  });

  it('does not take npm run dev’s own token for one dev run as fixed (PITWALL_TOKEN_PER_RUN=1 with PITWALL_OPEN_MARKER, W51)', () => {
    const token = 'pitwall-test-token-0123456789abcd';
    const marker = '/Users/example/tmp/pitwall-dev-abc/opened';
    expect(hasFixedToken({ PITWALL_TOKEN: token, PITWALL_TOKEN_PER_RUN: '1', PITWALL_OPEN_MARKER: marker })).toBe(false);
    expect(hasFixedToken({ PITWALL_TOKEN: token, PITWALL_TOKEN_PER_RUN: '0', PITWALL_OPEN_MARKER: marker })).toBe(true);
    expect(hasFixedToken({ PITWALL_TOKEN: token, PITWALL_TOKEN_PER_RUN: '', PITWALL_OPEN_MARKER: marker })).toBe(true);
    // It doesn't change which token is used.
    expect(resolveToken({ PITWALL_TOKEN: token, PITWALL_TOKEN_PER_RUN: '1', PITWALL_OPEN_MARKER: marker })).toBe(token);
  });

  it('ignores PITWALL_TOKEN_PER_RUN=1 set by hand, without PITWALL_OPEN_MARKER: a token from the environment is fixed (W58)', () => {
    const token = 'pitwall-test-token-0123456789abcd';
    expect(hasFixedToken({ PITWALL_TOKEN: token, PITWALL_TOKEN_PER_RUN: '1' })).toBe(true);
    // An empty marker counts as unset, as main() reads it.
    expect(hasFixedToken({ PITWALL_TOKEN: token, PITWALL_TOKEN_PER_RUN: '1', PITWALL_OPEN_MARKER: '' })).toBe(true);
    // It never makes an empty token fixed.
    expect(hasFixedToken({ PITWALL_TOKEN: '', PITWALL_TOKEN_PER_RUN: '1' })).toBe(false);
  });

  describe('an obviously weak PITWALL_TOKEN (W51)', () => {
    it.each([
      ['32 zeros', '0'.repeat(32)],
      ['one character and another at the end', `${'a'.repeat(42)}b`],
      ['seven different characters, in no pattern', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabcdefg'],
    ])('refuses %s: fewer than 8 different characters, without quoting it', (_, weak) => {
      expect(TOKEN_MIN_DIFFERENT).toBe(8);
      expect(() => resolveToken({ PITWALL_TOKEN: weak })).toThrow(new UsageError('PITWALL_TOKEN must have at least 8 different characters'));
    });

    it.each([
      ['a word, again and again', 'changeme-changeme-changeme-changeme'],
      ['the hex digits twice', '0123456789abcdef0123456789abcdef'],
      ['a piece whose last copy is cut short', 'pitwall-test-pitwall-test-pitwall-tes'],
      ['two halves alike', 'abcdefghijklmnopqrstuabcdefghijklmnopqrstu'],
    ])('refuses %s: one piece repeated, without quoting it', (_, weak) => {
      expect(() => resolveToken({ PITWALL_TOKEN: weak })).toThrow(new UsageError('PITWALL_TOKEN must not be one piece repeated, as in abcabcabc'));
    });

    it('accepts a token at the edge of the rule: 8 different characters, and no piece repeated', () => {
      const edge = `abcdefgh${'a'.repeat(24)}`;
      expect(resolveToken({ PITWALL_TOKEN: edge })).toBe(edge);
      // A piece repeated with something after it is no longer one piece repeated.
      const almost = `${'changeme-'.repeat(4)}x`;
      expect(resolveToken({ PITWALL_TOKEN: almost })).toBe(almost);
    });

    it('accepts every token .env.example’s command and the CLI make: 32 random bytes as base64url', () => {
      // The command in .env.example and the CLI's own per-run token are the same expression, and npm run
      // dev passes its per-run token through this check in the CLI it starts. 20,000 of each kind.
      for (let i = 0; i < 20_000; i++) {
        const made = randomBytes(32).toString('base64url');
        expect(resolveToken({ PITWALL_TOKEN: made })).toBe(made);
        const perRun = resolveToken({});
        expect(resolveToken({ PITWALL_TOKEN: perRun })).toBe(perRun);
      }
    });

    it('accepts random hex tokens too, as from openssl rand -hex 32 or 16, which have at most 16 different characters', () => {
      for (let i = 0; i < 5_000; i++) {
        for (const made of [randomBytes(32).toString('hex'), randomBytes(16).toString('hex')]) {
          expect(resolveToken({ PITWALL_TOKEN: made })).toBe(made);
        }
      }
    });

    it('says in the help what it accepts, and where to see how to make one', () => {
      expect(USAGE.replace(/\s+/g, ' ')).toContain(
          'At least 32 characters from A-Z, a-z, 0-9, "-" and "_", with at least 8 different ones, and not one piece repeated (abcabc...). The pitwall repo\'s .env.example shows how to make a random one.',
      );
    });
  });
});

describe('repeatsOnePiece', () => {
  it.each([['aa'], ['abab'], ['abcabcab'], ['xyzxyzx'], ['aaaaaaaaab'.repeat(3)]])('finds a piece repeated in %j', (text) => {
    expect(repeatsOnePiece(text)).toBe(true);
  });

  it.each([[''], ['a'], ['ab'], ['aab'], ['abcab'], ['abcdabc'], ['aaaaaaaaab']])('finds none in %j', (text) => {
    expect(repeatsOnePiece(text)).toBe(false);
  });

  it('agrees with a check of every period, for many short strings', () => {
    const naive = (text: string) => {
      for (let p = 1; p <= text.length / 2; p++) {
        if ([...text].every((char, i) => i < p || char === text[i - p])) return true;
      }
      return false;
    };
    for (let i = 0; i < 5_000; i++) {
      const text = Array.from({ length: 1 + (i % 12) }, () => 'ab'[randomBytes(1)[0]! % 2]).join('');
      expect(repeatsOnePiece(text), text).toBe(naive(text));
    }
  });

  it('takes linear time on a long value, such as a megabyte of one character and another', () => {
    const started = performance.now();
    expect(repeatsOnePiece(`${'a'.repeat(1 << 20)}b`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('what the CLI prints with each kind of token (W51)', () => {
  const token = 'pitwall-test-token-0123456789abcdefghij';

  it('prints a per-run token’s link, as it always has', () => {
    expect(runningLines('http://127.0.0.1:4517', token, false)).toEqual([`pitwall is running at http://127.0.0.1:4517/#token=${token}`]);
    expect(openInsteadHint(false)).toBe('Open the URL above instead.');
  });

  it('prints a fixed token’s address alone, and says where the token is', () => {
    expect(runningLines('http://127.0.0.1:4517', token, true)).toEqual([
      'pitwall is running at http://127.0.0.1:4517/',
      "The token is the one in PITWALL_TOKEN, so it isn't printed. A tab that has it reconnects by itself; for a new tab, add #token= and that token to the address.",
    ]);
    expect(runningLines('http://127.0.0.1:4517', token, true)[1]).toBe(FIXED_TOKEN_LINE);
    expect(runningLines('http://127.0.0.1:4517', token, true).join('\n')).not.toContain(token);
    expect(openInsteadHint(true)).toBe('Open the URL above instead, and add #token= and your PITWALL_TOKEN to it.');
  });
});

describe('envFileProblem (W51)', () => {
  const file = '/Users/example/code/pitwall/.env';
  const stats = (mode: number, uid = 501, isFile = true) => ({ mode: 0o100000 | mode, uid, isFile: () => isFile });

  it('accepts a file of yours that only you can read and write', () => {
    expect(envFileProblem(file, stats(0o600), { platform: 'darwin', uid: 501 })).toBeUndefined();
    expect(envFileProblem(file, stats(0o400), { platform: 'linux', uid: 501 })).toBeUndefined();
  });

  it.each([[0o644], [0o640], [0o604], [0o620], [0o602], [0o660], [0o666], [0o777]])('refuses mode %o, saying chmod 600', (mode) => {
    expect(envFileProblem(file, stats(mode), { platform: 'darwin', uid: 501 })).toBe(
      `${file} can be read or changed by other users (mode ${mode.toString(8)}), and it can hold PITWALL_TOKEN. Run chmod 600 ${file}, then run npm run dev again.`,
    );
  });

  it('refuses a file another user owns, even at 0600', () => {
    expect(envFileProblem(file, stats(0o600, 502), { platform: 'darwin', uid: 501 })).toBe(
      `${file} belongs to another user (uid 502). npm run dev reads a .env only when it's yours, since it can hold PITWALL_TOKEN.`,
    );
  });

  it('refuses something that is not a file, such as a directory or a FIFO', () => {
    expect(envFileProblem(file, stats(0o700, 501, false), { platform: 'darwin', uid: 501 })).toBe(
      `${file} is not a file. Move it aside, then run npm run dev again.`,
    );
  });

  it('checks only that it is a file on Windows, which has no POSIX modes', () => {
    expect(envFileProblem(file, stats(0o666, 0), { platform: 'win32' })).toBeUndefined();
    expect(envFileProblem(file, stats(0o666, 0, false), { platform: 'win32' })).toBeDefined();
  });
});

describe('resolveWebRoot', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
    await mkdir(join(tmp, 'dist', 'web'), { recursive: true });
    await mkdir(join(tmp, 'src'));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('uses web/ next to the built cli.js', () => {
    expect(resolveWebRoot(join(tmp, 'dist', 'cli.js'))).toBe(join(tmp, 'dist', 'web'));
  });

  it('falls back to <repo>/dist/web for src/cli.ts', () => {
    expect(resolveWebRoot(join(tmp, 'src', 'cli.ts'))).toBe(join(tmp, 'dist', 'web'));
  });
});

describe('browserCommand', () => {
  const file = '/home/someone/.pitwall/launch-4517-0123456789abcdef01234567.html';

  it('opens a file with open, xdg-open or cmd /c start', () => {
    expect(browserCommand(file, 'darwin')).toEqual(['open', [file]]);
    expect(browserCommand(file, 'linux')).toEqual(['xdg-open', [file]]);
    expect(browserCommand(file, 'win32')).toEqual(['cmd', ['/c', 'start', '', file]]);
  });
});

describe('claimOpenMarker', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('creates the marker once: the first call claims it, later calls do not', () => {
    const marker = join(tmp, 'opened');
    expect(claimOpenMarker(marker)).toBe(true);
    expect(existsSync(marker)).toBe(true);
    expect(claimOpenMarker(marker)).toBe(false);
  });

  it('does not claim a marker it cannot create', () => {
    expect(claimOpenMarker(join(tmp, 'missing', 'opened'))).toBe(false);
  });
});

/**
 * A stand-in for `claude`, put first on the CLI's PATH so the real indexer
 * never runs the real one. It prints an empty session list and records, next
 * to itself, whether PITWALL_TOKEN reached it, and one line per call.
 */
const FAKE_CLAUDE = `#!/bin/sh
if [ -n "\${PITWALL_TOKEN+set}" ]; then echo set; else echo unset; fi > "$(dirname "$0")/token-seen"
echo call >> "$(dirname "$0")/calls"
echo '[]'
`;

/**
 * A stand-in for `gh` (M4, W93), put first on the PATH of every CLI these tests
 * start, directly or through npm run dev, beside the fake claude, so the PR
 * poller never runs the real one, which would reach GitHub with the user's
 * login: noClaude.ts can't see a process the CLI starts. It
 * records its arguments, NUL-separated, in gh-args-<search>, and what it saw
 * of its environment, next to itself, then prints the answer to that search
 * (W101): one made-up PR of yours, one that asks your review by name, and no
 * mention.
 */
const FAKE_GH = `#!/bin/sh
search=
for arg in "$@"; do
  case "$arg" in
    q=*review-requested:@me*) search=review-requested ;;
    q=*mentions:@me*) search=mentioned ;;
    q=*author:@me*) search=authored ;;
  esac
done
printf '%s\\0' "$@" > "$(dirname "$0")/gh-args-$search"
{
  echo "GH_PROMPT_DISABLED=\${GH_PROMPT_DISABLED-unset}"
  echo "GH_NO_UPDATE_NOTIFIER=\${GH_NO_UPDATE_NOTIFIER-unset}"
  if [ -n "\${PITWALL_TOKEN+set}" ]; then echo "PITWALL_TOKEN=set"; else echo "PITWALL_TOKEN=unset"; fi
} > "$(dirname "$0")/gh-env"
case "$search" in
  authored) echo '{"data":{"viewer":{"login":"pitwall-test-viewer"},"search":{"issueCount":1,"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"url":"https://github.com/example/demo-app/pull/7","number":7,"title":"Add a demo feature","isDraft":false,"createdAt":"2026-10-01T09:00:00Z","updatedAt":"2026-10-20T09:00:00Z","headRefName":"feature/demo","headRepository":{"nameWithOwner":"example/demo-app"},"repository":{"nameWithOwner":"example/demo-app"},"reviewDecision":null,"mergeable":"MERGEABLE","commits":{"nodes":[{"commit":{"statusCheckRollup":null}}]}}]}}}' ;;
  review-requested) echo '{"data":{"viewer":{"login":"pitwall-test-viewer"},"search":{"issueCount":1,"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[{"url":"https://github.com/example/demo-app/pull/8","number":8,"title":"Review a demo feature","isDraft":false,"createdAt":"2026-10-01T09:00:00Z","updatedAt":"2026-10-21T09:00:00Z","headRefName":"feature/review","headRepository":{"nameWithOwner":"example/demo-app"},"repository":{"nameWithOwner":"example/demo-app"},"reviewDecision":"REVIEW_REQUIRED","mergeable":"MERGEABLE","commits":{"nodes":[{"commit":{"statusCheckRollup":null}}]},"reviewRequests":{"nodes":[{"requestedReviewer":{"__typename":"User","login":"pitwall-test-viewer"}}]}}]}}}' ;;
  *) echo '{"data":{"viewer":{"login":"pitwall-test-viewer"},"search":{"issueCount":0,"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}' ;;
esac
`;

/**
 * Stand-ins for `open` (macOS) and `xdg-open` (Linux), first on the CLI's PATH
 * so no test ever opens a real browser. Each call writes what it saw of its
 * environment to $PWTEST_OPEN_LOG.env, then appends its argument count and
 * each argument, one per line, to $PWTEST_OPEN_LOG. Not PITWALL_*, which
 * childEnvironment() keeps from the opener (W98).
 */
const FAKE_OPENER = `#!/bin/sh
{
  printf 'PATH=%s\\n' "$PATH"
  if [ -n "\${PITWALL_HOME+set}" ]; then echo "PITWALL_HOME=set"; else echo "PITWALL_HOME=unset"; fi
  if [ -n "\${PITWALL_NO_OPEN+set}" ]; then echo "PITWALL_NO_OPEN=set"; else echo "PITWALL_NO_OPEN=unset"; fi
} > "\${PWTEST_OPEN_LOG:?}.env"
printf '%s\\n' "$#" "$@" >> "\${PWTEST_OPEN_LOG:?}"
`;

/** Each recorded call of the fake opener, as its list of arguments. */
async function openerCalls(log: string): Promise<string[][]> {
  const lines = (await readFile(log, 'utf8').catch(() => '')).split('\n');
  const calls: string[][] = [];
  for (let i = 0; i < lines.length && lines[i] !== ''; ) {
    const count = Number(lines[i]);
    calls.push(lines.slice(i + 1, i + 1 + count));
    i += 1 + count;
  }
  return calls;
}

async function waitUntil(condition: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Holds a free port on 127.0.0.1, as a process squatting on pitwall's port would. */
async function squat(): Promise<{ port: number; close(): Promise<void> }> {
  const squatter = createNetServer((socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'));
  squatter.listen(0, '127.0.0.1');
  await once(squatter, 'listening');
  return {
    port: (squatter.address() as AddressInfo).port,
    close: () => new Promise((resolve) => squatter.close(() => resolve())),
  };
}

/** A port that was free a moment ago. */
async function freePort(): Promise<number> {
  const probe = await squat();
  await probe.close();
  return probe.port;
}

describe('pitwall (the process)', () => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const token = 'pitwall-test-token-0123456789abcdefghij';
  let tmp: string;
  let bin: string;

  let n = 0;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
    bin = join(tmp, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    await writeFile(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    await writeFile(join(bin, 'open'), FAKE_OPENER, { mode: 0o755 });
    await writeFile(join(bin, 'xdg-open'), FAKE_OPENER, { mode: 0o755 });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** A fresh path under the temp directory, for a PITWALL_HOME, an opener log or a marker. */
  const fresh = (name: string) => join(tmp, `${name}-${++n}`);

  /**
   * Runs the CLI with the fake claude, the fake gh and the fake openers first on PATH. It
   * doesn't open a browser unless the test sets PITWALL_NO_OPEN to 0, and its
   * PITWALL_HOME is always a temp directory, never the real ~/.pitwall.
   */
  function run(args: string[], env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      env: {
        ...process.env,
        PITWALL_NO_OPEN: '1',
        PITWALL_HOME: fresh('home'),
        PWTEST_OPEN_LOG: fresh('opened'),
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        ...env,
      },
    });
  }

  async function exited(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const [code] = (await once(child, 'exit')) as [number | null];
    return { code, stdout, stderr };
  }

  /**
   * Starts the CLI on a free port and waits for it to print its URL and roots.
   * The token is the fixed `token` unless `env` says otherwise; an empty
   * PITWALL_TOKEN gives a per-run one. `printedToken` is the token in the
   * printed link, if there is one.
   */
  async function start(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
    const child = run(['--port', '0', ...args, tmp], { PITWALL_TOKEN: token, ...env });
    const result = exited(child);
    let stdout = '';
    const [, url, printedToken] = await new Promise<RegExpExecArray>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const match = /running at (http:\/\/127\.0\.0\.1:\d+)\/(?:#token=(\S+))?\n/.exec(stdout);
        if (match && stdout.includes('Watching')) resolve(match);
      });
      child.on('exit', () => reject(new Error(`exited early: ${stdout}`)));
    });
    return { child, result, stdout, url: url as string, printedToken };
  }

  /**
   * The snapshot, once the first poll has finished. Until then the server
   * answers 503. Polls until it's ready, so the test doesn't depend on how
   * quickly the fake claude and the indexer run on a loaded machine.
   */
  async function firstSnapshot(url: string, bearer: string = token): Promise<Response> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const res = await fetch(`${url}/api/snapshot`, { headers: { authorization: `Bearer ${bearer}` } });
      if (res.status !== 503 || Date.now() > deadline) return res;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('exits 1 with a clear message for a root that does not exist', async () => {
    const missing = join(tmp, 'missing');
    const result = await exited(run([missing]));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`pitwall: root does not exist: ${missing}`);
  });

  it('exits 1 for a short PITWALL_TOKEN', async () => {
    const result = await exited(run([tmp], { PITWALL_TOKEN: 'short' }));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PITWALL_TOKEN must be at least 32 characters');
  });

  it('prints the usage for --help', async () => {
    const result = await exited(run(['--help']));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: pitwall [root...]');
    expect(result.stdout).toContain('--interval <seconds>');
    expect(result.stdout).toContain('--no-prs');
  });

  it('exits 1 with a clear message for an --interval out of range', async () => {
    const result = await exited(run(['--interval', '0', tmp]));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('pitwall: --interval must be a whole number of seconds from 1 to 300, not "0"');
  });

  it('with a fixed token, starts, prints the URL without the token, and the roots, serves, and exits 0 on SIGTERM (W51)', async () => {
    const { child, result, stdout, url, printedToken } = await start();
    expect(printedToken).toBeUndefined();
    expect(stdout).toContain(`pitwall is running at ${url}/\n${FIXED_TOKEN_LINE}\nWatching root: ${tmp}`);

    expect((await fetch(`${url}/api/snapshot`)).status).toBe(401);
    const res = await firstSnapshot(url);
    expect(res.status).toBe(200);
    // The fake claude's empty list, not whatever the real one would report.
    expect(await res.json()).toMatchObject({ groups: [], source: { ok: true } });

    child.kill('SIGTERM');
    const output = await result;
    expect(output.code).toBe(0);
    // Not on stdout or stderr, from start to exit: it would outlive the run wherever it was copied.
    expect(output.stdout).not.toContain(token);
    expect(output.stderr).not.toContain(token);
    expect(output.stderr).toBe(`pitwall: ${fixedTokenNotice()}\n`);
  }, 30_000);

  it('with a per-run token, prints the URL with it, as before, and the token works', async () => {
    const { child, result, stdout, url, printedToken } = await start([], { PITWALL_TOKEN: '' });
    expect(printedToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(printedToken).not.toBe(token);
    expect(stdout).toContain(`pitwall is running at ${url}/#token=${printedToken}\nWatching root: ${tmp}`);
    expect(stdout).not.toContain('PITWALL_TOKEN');
    expect((await firstSnapshot(url, printedToken)).status).toBe(200);

    child.kill('SIGTERM');
    const output = await result;
    expect(output.code).toBe(0);
    expect(output.stderr).not.toContain('fixed');
  }, 30_000);

  it('with PITWALL_TOKEN_PER_RUN=1 set by hand, without PITWALL_OPEN_MARKER, still takes the token as fixed and never prints it (W58)', async () => {
    const { child, result, stdout, url, printedToken } = await start([], { PITWALL_TOKEN_PER_RUN: '1', PITWALL_OPEN_MARKER: undefined });
    expect(printedToken).toBeUndefined();
    expect(stdout).toContain(`pitwall is running at ${url}/\n${FIXED_TOKEN_LINE}\nWatching root: ${tmp}`);

    child.kill('SIGTERM');
    const output = await result;
    expect(output.code).toBe(0);
    expect(output.stdout + output.stderr).not.toContain(token);
    expect(output.stderr).toBe(`pitwall: ${fixedTokenNotice()}\n`);
  }, 30_000);

  it('exits 1 for an obviously weak PITWALL_TOKEN, without printing it (W51)', async () => {
    for (const weak of ['0'.repeat(32), 'changeme-changeme-changeme-changeme']) {
      const result = await exited(run([tmp], { PITWALL_TOKEN: weak }));
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/^pitwall: PITWALL_TOKEN must (have at least 8 different characters|not be one piece repeated, as in abcabcabc)\n/);
      expect(result.stderr + result.stdout).not.toContain(weak);
      expect(result.stdout).not.toContain('running at');
    }
  }, 30_000);

  it('polls every 5 seconds by default, and says so', async () => {
    const { child, result, stdout } = await start();
    expect(stdout).toContain(`Watching root: ${tmp}, polling every 5s`);
    child.kill('SIGTERM');
    expect((await result).code).toBe(0);
  }, 30_000);

  it('passes --interval to the indexer, which polls that often', async () => {
    const calls = join(bin, 'calls');
    await rm(calls, { force: true });
    const { child, result, stdout, url } = await start(['--interval', '1']);
    expect(stdout).toContain('polling every 1s');
    expect((await firstSnapshot(url)).status).toBe(200);
    // Three polls take about 2 s at 1 s apart. At the 5 s default they would take 10 s.
    const started = Date.now();
    const count = async () => (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    while ((await count()) < 3 && Date.now() - started < 6_000) await new Promise((r) => setTimeout(r, 100));
    expect(await count()).toBeGreaterThanOrEqual(3);
    expect(Date.now() - started).toBeLessThan(6_000);

    child.kill('SIGTERM');
    expect((await result).code).toBe(0);
  }, 30_000);

  /** GET /api/prs, once `ready` says the list is what the test waits for. */
  async function prsWhen(url: string, ready: (list: { fetchedAt?: string; source: { ok: boolean } }) => boolean): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const res = await fetch(`${url}/api/prs`, { headers: { authorization: `Bearer ${token}` } });
      const list = (await res.json()) as { fetchedAt?: string; source: { ok: boolean } };
      if (ready(list) || Date.now() > deadline) return list;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('fetches your open PRs at start with gh api graphql, one call per search, -f fields only, never prompting, without the token (M4, W93, W101)', async () => {
    const searches = ['authored', 'review-requested', 'mentioned'];
    for (const search of searches) await rm(join(bin, `gh-args-${search}`), { force: true });
    await rm(join(bin, 'gh-env'), { force: true });
    const { child, result, url } = await start();
    const list = await prsWhen(url, (list) => list.fetchedAt !== undefined);
    expect(list).toMatchObject({
      source: { ok: true },
      refreshing: false,
      prs: [
        { repo: 'example/demo-app', number: 8, url: 'https://github.com/example/demo-app/pull/8', relation: 'review-requested', reviewRequest: { via: 'direct' } },
        { repo: 'example/demo-app', number: 7, url: 'https://github.com/example/demo-app/pull/7', relation: 'authored' },
      ],
    });

    const q = {
      authored: 'q=is:pr is:open author:@me archived:false sort:updated-desc',
      'review-requested': 'q=is:pr is:open review-requested:@me -author:@me archived:false sort:updated-desc',
      mentioned: 'q=is:pr is:open mentions:@me -author:@me archived:false sort:updated-desc',
    } as Record<string, string>;
    for (const search of searches) {
      const args = (await readFile(join(bin, `gh-args-${search}`), 'utf8')).split('\0').slice(0, -1);
      expect(args.slice(0, 4), search).toEqual(['api', 'graphql', '--hostname', 'github.com']);
      expect(args.filter((arg) => arg.startsWith('-')), search).toEqual(['--hostname', '-f', '-f']);
      expect(args, search).toContain(q[search]);
    }
    expect((await readFile(join(bin, 'gh-env'), 'utf8')).split('\n')).toEqual(['GH_PROMPT_DISABLED=1', 'GH_NO_UPDATE_NOTIFIER=1', 'PITWALL_TOKEN=unset', '']);

    child.kill('SIGTERM');
    expect((await result).code).toBe(0);
  }, 30_000);

  it('with --no-prs, never runs gh, and serves the off list', async () => {
    for (const search of ['authored', 'review-requested', 'mentioned']) await rm(join(bin, `gh-args-${search}`), { force: true });
    const { child, result, url } = await start(['--no-prs']);
    expect((await firstSnapshot(url)).status).toBe(200);
    const list = await prsWhen(url, () => true);
    expect(list).toEqual({ source: { ok: false, reason: 'off', error: 'Pull requests are off: pitwall was started with --no-prs.' }, refreshing: false, prs: [] });
    // Long enough for a fetch at start to have run the fake gh, as the test above shows it does.
    await new Promise((r) => setTimeout(r, 500));
    for (const search of ['authored', 'review-requested', 'mentioned']) expect(existsSync(join(bin, `gh-args-${search}`))).toBe(false);

    child.kill('SIGTERM');
    expect((await result).code).toBe(0);
  }, 30_000);

  it('removes PITWALL_TOKEN from its environment before it runs claude', async () => {
    await rm(join(bin, 'token-seen'), { force: true });
    const { child, result, url } = await start();
    expect((await firstSnapshot(url)).status).toBe(200);
    // The first poll has run the fake claude, which wrote down what it saw.
    expect((await readFile(join(bin, 'token-seen'), 'utf8')).trim()).toBe('unset');

    child.kill('SIGTERM');
    expect((await result).code).toBe(0);
  }, 30_000);

  describe('opening the browser through a launch file', () => {
    /** Starts the CLI with opening on, and waits for the fake opener's first call. */
    async function startOpening(env: NodeJS.ProcessEnv = {}) {
      const home = fresh('home');
      const log = fresh('opened');
      const started = await start([], { PITWALL_NO_OPEN: '0', PITWALL_HOME: home, PWTEST_OPEN_LOG: log, ...env });
      await waitUntil(async () => (await openerCalls(log)).length > 0);
      return { ...started, home, log };
    }

    it('gives the opener a launch file path with no token in it, and the file sends the browser on', async () => {
      const { child, result, url, home, log, stdout } = await startOpening();
      const calls = await openerCalls(log);
      expect(calls).toHaveLength(1);
      const [args] = calls;
      expect(args).toHaveLength(1);
      const file = args![0]!;
      const port = new URL(url).port;
      expect(file).toMatch(new RegExp(`^${home}/launch-${port}-[0-9a-f]{24}\\.html$`));
      expect(file).not.toContain(token);

      // Only this user can read it, in a directory only this user can enter.
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const page = await readFile(file, 'utf8');
      // The launch file is the one place a fixed token is written (D7).
      expect(page).toContain(`location.replace("${url}/#token=${token}")`);
      expect(page).toContain(`<meta http-equiv="refresh" content="0; url=${url}/#token=${token}">`);
      // stdout, the user's own terminal, has the address, without the fixed token (W51).
      expect(stdout).toContain(`running at ${url}/\n`);

      child.kill('SIGTERM');
      const output = await result;
      expect(output.code).toBe(0);
      expect(output.stdout + output.stderr).not.toContain(token);
      expect(existsSync(file)).toBe(false);
    }, 30_000);

    // W96's finding (W98): an empty or relative PATH entry would find `open` in the directory pitwall started in.
    it('gives the opener the environment every child gets: no PITWALL_ variables, and only the absolute directories on PATH, ~/ expanded', async () => {
      const path = `${bin}${delimiter}${delimiter}.${delimiter}relative-bin${delimiter}~/pwtest-bin${delimiter}${process.env.PATH ?? ''}${delimiter}`;
      const { child, result, log } = await startOpening({ PATH: path });
      const seen = await readFile(`${log}.env`, 'utf8');
      // Two the CLI keeps in its own environment: what it was started with, never deleted.
      expect(seen).toContain('PITWALL_HOME=unset\n');
      expect(seen).toContain('PITWALL_NO_OPEN=unset\n');
      const entries = /^PATH=(.*)$/m.exec(seen)?.[1]?.split(delimiter) ?? [];
      expect(entries[0]).toBe(bin);
      expect(entries[1]).toBe(join(homedir(), 'pwtest-bin'));
      expect(entries.filter((entry) => !isAbsolute(entry))).toEqual([]);
      // As bash reads them: `~` and `~/...` are the home directory, and any other relative or empty entry is dropped.
      const home = (entry: string) => (entry === '~' ? homedir() : entry.startsWith('~/') ? `${homedir()}${entry.slice(1)}` : entry);
      expect(entries).toEqual(path.split(delimiter).map(home).filter((entry) => isAbsolute(entry)));

      child.kill('SIGTERM');
      expect((await result).code).toBe(0);
    }, 30_000);

    it('deletes the launch file on SIGINT too', async () => {
      const { child, result, log } = await startOpening();
      const file = (await openerCalls(log))[0]![0]!;
      expect(existsSync(file)).toBe(true);
      child.kill('SIGINT');
      expect((await result).code).toBe(0);
      expect(existsSync(file)).toBe(false);
    }, 30_000);

    it('deletes the launch file on SIGHUP, when the terminal closes', async () => {
      const { child, result, log } = await startOpening();
      const file = (await openerCalls(log))[0]![0]!;
      expect(existsSync(file)).toBe(true);
      child.kill('SIGHUP');
      expect((await result).code).toBe(0);
      expect(existsSync(file)).toBe(false);
    }, 30_000);

    /** What the page does once the launch file has sent it on: answers the challenge with a proof. Resolves once authenticated. */
    async function authenticate(url: string, withToken: string): Promise<WebSocket> {
      const port = Number(new URL(url).port);
      const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { origin: pitwallOrigin(port) });
      const replies: { type: string; nonce?: string }[] = [];
      ws.on('message', (data) => {
        const message = JSON.parse(String(data)) as { type: string; nonce?: string };
        replies.push(message);
        if (message.type === 'challenge') ws.send(JSON.stringify({ type: 'auth', proof: proofFor(withToken, message.nonce!, pitwallOrigin(port)) }));
      });
      await waitUntil(() => replies.some((message) => message.type === 'authenticated'));
      return ws;
    }

    it('with a per-run token, deletes the launch file as soon as a page authenticates, while it keeps running', async () => {
      const { child, result, log, url, printedToken } = await startOpening({ PITWALL_TOKEN: '' });
      const file = (await openerCalls(log))[0]![0]!;
      expect(existsSync(file)).toBe(true);
      expect(await readFile(file, 'utf8')).toContain(`#token=${printedToken}`);

      const ws = await authenticate(url, printedToken!);
      await waitUntil(() => !existsSync(file));
      ws.close();

      expect(child.exitCode).toBeNull();
      child.kill('SIGTERM');
      expect((await result).code).toBe(0);
    }, 30_000);

    it('with a fixed token, keeps the launch file when a page authenticates, so a pinned tab can’t take it from a new one, and deletes it on exit (W51)', async () => {
      const { child, result, log, url } = await startOpening();
      const file = (await openerCalls(log))[0]![0]!;
      expect(existsSync(file)).toBe(true);

      // A pinned tab that already has the token reconnects first; then a second page, as a new tab would.
      const pinned = await authenticate(url, token);
      const another = await authenticate(url, token);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(file)).toBe(true);
      expect(await readFile(file, 'utf8')).toContain(`#token=${token}`);
      pinned.close();
      another.close();

      expect(child.exitCode).toBeNull();
      child.kill('SIGTERM');
      expect((await result).code).toBe(0);
      expect(existsSync(file)).toBe(false);
    }, 30_000);

    it('with PITWALL_TOKEN_PER_RUN=1 set by hand, without the marker, keeps a fixed token’s launch file when a page authenticates (W58)', async () => {
      const { child, result, log, url } = await startOpening({ PITWALL_TOKEN_PER_RUN: '1', PITWALL_OPEN_MARKER: undefined });
      const file = (await openerCalls(log))[0]![0]!;
      expect(existsSync(file)).toBe(true);

      const ws = await authenticate(url, token);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(existsSync(file)).toBe(true);
      ws.close();

      child.kill('SIGTERM');
      expect((await result).code).toBe(0);
      expect(existsSync(file)).toBe(false);
    }, 30_000);

    it('says what to open instead when the browser can’t be opened: the link, or with a fixed token, the address and the token (W51)', async () => {
      // Openers that fail, first on the CLI's PATH.
      const failing = fresh('failing-bin');
      await mkdir(failing);
      for (const name of ['open', 'xdg-open']) await writeFile(join(failing, name), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
      const path = `${failing}${delimiter}${bin}${delimiter}${process.env.PATH ?? ''}`;

      for (const fixed of [true, false]) {
        const child = run(['--port', '0', tmp], { PITWALL_TOKEN: fixed ? token : '', PITWALL_NO_OPEN: '0', PATH: path });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        await waitUntil(() => stderr.includes("couldn't open a browser"));
        child.kill('SIGTERM');
        const [code] = (await once(child, 'exit')) as [number | null];
        expect(code).toBe(0);
        expect(stderr).toMatch(new RegExp(`pitwall: couldn't open a browser \\(.*\\)\\. ${openInsteadHint(fixed).replace(/[.]/g, '\\.')}\n`));
        if (fixed) expect(stdout + stderr).not.toContain(token);
        else expect(stdout).toMatch(/running at http:\/\/127\.0\.0\.1:\d+\/#token=[A-Za-z0-9_-]{43}\n/);
      }
    }, 30_000);

    it('deletes launch files more than 24 hours old when it starts, and keeps newer ones', async () => {
      const home = fresh('home');
      await mkdir(home, { mode: 0o700 });
      const old = join(home, 'launch-4517-aaaaaaaaaaaaaaaaaaaaaaaa.html');
      const recent = join(home, 'launch-4517-bbbbbbbbbbbbbbbbbbbbbbbb.html');
      await writeFile(old, 'old');
      await writeFile(recent, 'recent');
      const twoDaysAgo = (Date.now() - 48 * 3600_000) / 1000;
      await utimes(old, twoDaysAgo, twoDaysAgo);

      const { child, result } = await startOpening({ PITWALL_HOME: home });
      expect(existsSync(old)).toBe(false);
      expect(existsSync(recent)).toBe(true);
      child.kill('SIGTERM');
      await result;
    }, 30_000);

    it.skipIf(process.platform === 'win32')('refuses a symlinked PITWALL_HOME: exit 1 before listening, nothing opened', async () => {
      const target = fresh('target');
      await mkdir(target, { mode: 0o700 });
      const link = fresh('link');
      await symlink(target, link);
      const log = fresh('opened');
      const result = await exited(run(['--port', '0', tmp], { PITWALL_NO_OPEN: '0', PITWALL_HOME: link, PWTEST_OPEN_LOG: log }));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`pitwall: ${link} is a symbolic link.`);
      expect(result.stdout).not.toContain('running at');
      expect(await openerCalls(log)).toEqual([]);
    }, 30_000);

    it.skipIf(process.platform === 'win32')('refuses a PITWALL_HOME with mode 0755, and leaves its mode alone', async () => {
      const home = fresh('home');
      await mkdir(home);
      await chmod(home, 0o755);
      const log = fresh('opened');
      const result = await exited(run(['--port', '0', tmp], { PITWALL_NO_OPEN: '0', PITWALL_HOME: home, PWTEST_OPEN_LOG: log }));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`pitwall: ${home} can be read or entered by other users (mode 755). Run chmod 700 ${home}`);
      expect(result.stdout).not.toContain('running at');
      expect(statSync(home).mode & 0o777).toBe(0o755);
      expect(await openerCalls(log)).toEqual([]);
    }, 30_000);

    it('leaves PITWALL_HOME alone with --no-open', async () => {
      const home = fresh('home');
      const { child, result } = await start(['--no-open'], { PITWALL_NO_OPEN: '0', PITWALL_HOME: home });
      expect(existsSync(home)).toBe(false);
      child.kill('SIGTERM');
      expect((await result).code).toBe(0);
    }, 30_000);
  });

  describe('dev readiness: PITWALL_OPEN_MARKER', () => {
    it('opens once per marker: a restart with the same marker opens nothing', async () => {
      const marker = fresh('marker');
      const log = fresh('opened');
      const home = fresh('home');
      const env = { PITWALL_NO_OPEN: '0', PITWALL_HOME: home, PWTEST_OPEN_LOG: log, PITWALL_OPEN_MARKER: marker };

      const first = await start([], env);
      await waitUntil(async () => (await openerCalls(log)).length > 0);
      expect(existsSync(marker)).toBe(true);
      first.child.kill('SIGTERM');
      expect((await first.result).code).toBe(0);

      // What tsx watch does on a change: the same command and environment, a new process.
      const second = await start([], env);
      expect((await firstSnapshot(second.url)).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 300));
      second.child.kill('SIGTERM');
      expect((await second.result).code).toBe(0);

      const calls = await openerCalls(log);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toHaveLength(1);
      expect(calls[0]![0]).not.toContain(token);
    }, 30_000);

    it('opens nothing when a squatter holds the port: the CLI exits 1 and leaves the marker for a real start', async () => {
      const squatter = await squat();
      try {
        const marker = fresh('marker');
        const log = fresh('opened');
        const result = await exited(
          run(['--port', String(squatter.port), tmp], {
            PITWALL_TOKEN: token,
            PITWALL_NO_OPEN: '0',
            PWTEST_OPEN_LOG: log,
            PITWALL_OPEN_MARKER: marker,
          }),
        );
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(`port ${squatter.port} on 127.0.0.1 is already in use`);
        expect(existsSync(marker)).toBe(false);
        expect(await openerCalls(log)).toEqual([]);
      } finally {
        await squatter.close();
      }
    }, 30_000);
  });
});

/** tsx's loader, from this repo, for a process whose cwd is elsewhere. */
const TSX_LOADER = pathToFileURL(fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))).href;

/**
 * Stand-ins for the two watchers `npm run dev` starts, first on its PATH.
 * - `vite` waits to be stopped. With $PWTEST_VITE_ENV_LOG set, it first
 *   writes there the names of the variables it was given, never their values.
 *   (Not a PITWALL_ name, since those mustn't reach it.)
 * - `tsx` does what `tsx watch src/cli.ts ...` does on one file change: runs
 *   the real CLI, then stops it and runs it again, passing on what the CLI
 *   prints on stdout. It logs to $PITWALL_TEST_DEV_LOG its arguments, the
 *   marker it was given, and when the restarted CLI is up.
 * Both also stop if dev.ts goes away without stopping them, so a failed test
 * leaves nothing running.
 */
const FAKE_VITE = `#!${process.execPath}
if (process.env.PWTEST_VITE_ENV_LOG) require('node:fs').appendFileSync(process.env.PWTEST_VITE_ENV_LOG, JSON.stringify(Object.keys(process.env)) + '\\n');
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 200);
`;

const FAKE_TSX = `#!${process.execPath}
const { spawn } = require('node:child_process');
const { appendFileSync, existsSync } = require('node:fs');
const log = (line) => appendFileSync(process.env.PITWALL_TEST_DEV_LOG, line + '\\n');
const args = process.argv.slice(2);
log('args ' + JSON.stringify(args));
log('marker ' + process.env.PITWALL_OPEN_MARKER);
const cliArgs = args.filter((arg) => arg !== 'watch' && !arg.startsWith('--clear-screen'));
let child;
function startCli() {
  child = spawn(process.execPath, ['--import', ${JSON.stringify(TSX_LOADER)}, ...cliArgs], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      out += chunk;
      if (out.includes('Watching')) resolve();
    });
    child.on('exit', (code) => reject(new Error('the CLI exited with ' + code + ': ' + out)));
  });
}
const stopCli = () => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  child.removeAllListeners('exit');
  child.once('exit', resolve);
  child.kill('SIGTERM');
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stopCli().then(() => process.exit(0)));
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) stopCli().then(() => process.exit(0)); }, 200);
(async () => {
  await startCli();
  for (let i = 0; i < 200 && !existsSync(process.env.PITWALL_OPEN_MARKER); i++) await sleep(25);
  await stopCli();
  log('restarting');
  await startCli();
  log('restarted');
})().catch((error) => {
  log('failed ' + error.message);
  process.exit(1);
});
`;

describe('npm run dev (scripts/dev.ts)', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const devScript = join(repo, 'scripts', 'dev.ts');
  let tmp: string;
  let bin: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
    bin = join(tmp, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    await writeFile(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    await writeFile(join(bin, 'open'), FAKE_OPENER, { mode: 0o755 });
    await writeFile(join(bin, 'xdg-open'), FAKE_OPENER, { mode: 0o755 });
    await writeFile(join(bin, 'vite'), FAKE_VITE, { mode: 0o755 });
    await writeFile(join(bin, 'tsx'), FAKE_TSX, { mode: 0o755 });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function dev(port: number, files: { log: string; devLog: string; home: string }): ChildProcessWithoutNullStreams {
    return spawn(process.execPath, ['--import', 'tsx', devScript, tmp], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        PITWALL_DEV_PORT: String(port),
        PITWALL_NO_OPEN: '0',
        PITWALL_HOME: files.home,
        PWTEST_OPEN_LOG: files.log,
        PITWALL_TEST_DEV_LOG: files.devLog,
      },
    });
  }

  const files = (name: string) => ({ log: join(tmp, `${name}-opened`), devLog: join(tmp, `${name}-dev.log`), home: join(tmp, `${name}-home`) });

  it('with a squatter already on the port, exits 1 and opens nothing', async () => {
    const squatter = await squat();
    try {
      const paths = files('squatted');
      const child = dev(squatter.port, paths);
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const [code] = (await once(child, 'exit')) as [number | null];
      expect(code).toBe(1);
      expect(stderr).toContain(`pitwall dev: port ${squatter.port} on 127.0.0.1 is already in use`);
      // Neither watcher started, so no CLI ran, and nothing was opened.
      expect(existsSync(paths.devLog)).toBe(false);
      expect(await openerCalls(paths.log)).toEqual([]);
    } finally {
      await squatter.close();
    }
  }, 30_000);

  it('opens the browser exactly once across a restart, through a launch file, with the token kept off the command line', async () => {
    const port = await freePort();
    const paths = files('normal');
    const child = dev(port, paths);
    const devLog = async () => readFile(paths.devLog, 'utf8').catch(() => '');
    // What a CLI said when it couldn't open the browser, for the message if it wasn't opened. Those lines have
    // the launch file's path, never the token.
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    try {
      await waitUntil(async () => /^(restarted|failed)/m.test(await devLog()), 45_000);
      expect(await devLog()).not.toMatch(/^failed/m);
      // The restarted CLI found the marker, so it wrote no launch file: it opens no second tab. It decides that
      // before it says it's watching, which is when the fake tsx logs `restarted`. The first CLI's launch file went
      // when it exited.
      expect((await readdir(paths.home)).filter((name) => name.startsWith('launch-'))).toEqual([]);
      // The first CLI's opener is a process of its own, which is often still starting when the restarted CLI is up,
      // and later still on a loaded machine. So its call is waited for by the clock, not for a fixed 500 ms (W61).
      await waitUntil(async () => (await openerCalls(paths.log)).length > 0, 10_000).catch(() => undefined);
      // And no second call comes in the next half second.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const calls = await openerCalls(paths.log);
      const said = stderr
        .split('\n')
        .filter((line) => line.startsWith("pitwall: couldn't"))
        .join('\n');
      expect(calls, said === '' ? 'the opener calls, waited for up to 10 s' : `the opener calls, where a CLI said:\n${said}`).toHaveLength(1);
      expect(calls[0]).toHaveLength(1);
      expect(calls[0]![0]).toMatch(new RegExp(`^${paths.home}/launch-${port}-[0-9a-f]{24}\\.html$`));

      const log = await devLog();
      const args = JSON.parse(/^args (.*)$/m.exec(log)![1]!) as string[];
      expect(args).toEqual(['watch', '--clear-screen=false', 'src/cli.ts', '--port', String(port), tmp]);
      const marker = /^marker (.*)$/m.exec(log)![1]!;
      expect(existsSync(marker)).toBe(true);

      child.kill('SIGTERM');
      const [code] = (await once(child, 'exit')) as [number | null];
      expect(code).toBe(0);
      // The marker's private directory goes with the dev run.
      expect(existsSync(marker)).toBe(false);
    } finally {
      // On a failure, stop it the way Ctrl-C would, so it still removes its temp directory.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const killer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        await once(child, 'exit');
        clearTimeout(killer);
      }
    }
  }, 60_000);
});

/**
 * A stand-in for `tsx watch src/cli.ts`, for the fixed-token tests: it notes the SHA-256 of the
 * PITWALL_TOKEN it was given, never the token, and its PITWALL_TOKEN_PER_RUN, then waits to be
 * stopped.
 */
const FAKE_TSX_TOKEN = `#!${process.execPath}
const { createHash } = require('node:crypto');
const { appendFileSync } = require('node:fs');
const token = process.env.PITWALL_TOKEN ?? '';
appendFileSync(process.env.PITWALL_TEST_DEV_LOG, 'per-run ' + (process.env.PITWALL_TOKEN_PER_RUN ?? 'unset') + '\\n');
appendFileSync(process.env.PITWALL_TEST_DEV_LOG, 'token ' + createHash('sha256').update(token).digest('hex') + ' ' + token.length + '\\n');
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(0); }, 200);
`;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * A copy of the repo's layout for one dev run, at `root`: scripts/dev.ts copied, src/ and
 * node_modules/ linked to the real ones, and a .env holding `env` when it's given, at `mode`
 * (default 0600). So a .env of the real repo never reaches these tests.
 */
async function devLayout(root: string, env?: string, mode = 0o600): Promise<string> {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await copyFile(join(repo, 'scripts', 'dev.ts'), join(root, 'scripts', 'dev.ts'));
  await symlink(join(repo, 'src'), join(root, 'src'));
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'));
  // As the repo's own package.json says, so tsx loads dev.ts as a module.
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  if (env !== undefined) {
    await writeFile(join(root, '.env'), env, { mode });
    // Exactly, whatever the umask.
    await chmod(join(root, '.env'), mode);
  }
  return root;
}

describe('npm run dev: a fixed token (W40)', () => {
  const FIXED = 'pitwall-test-fixed-token-0123456789abcdefghij';
  const FROM_FILE = 'pitwall-test-dotenv-token-0123456789abcdefghij';
  let tmp: string;
  let bin: string;
  let n = 0;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
    bin = join(tmp, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'vite'), FAKE_VITE, { mode: 0o755 });
    await writeFile(join(bin, 'tsx'), FAKE_TSX_TOKEN, { mode: 0o755 });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const layout = (env?: string, mode?: number) => devLayout(join(tmp, `repo-${++n}`), env, mode);

  /**
   * Runs the layout's dev.ts in `cwd`, with PITWALL_TOKEN only when `token` is given, and `extra`
   * in its environment, and stops it once its watcher has started.
   */
  async function devRun(
    root: string,
    { token, cwd = tmp, extra = {}, alsoWaitFor }: { token?: string; cwd?: string; extra?: NodeJS.ProcessEnv; alsoWaitFor?: string } = {},
  ) {
    const devLog = join(tmp, `dev-${++n}.log`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      PITWALL_DEV_PORT: String(await freePort()),
      PITWALL_TEST_DEV_LOG: devLog,
      ...extra,
    };
    delete env.PITWALL_TOKEN;
    if (token !== undefined) env.PITWALL_TOKEN = token;
    // tsx from this repo, so the run's own cwd can be anywhere.
    const child = spawn(process.execPath, ['--import', TSX_LOADER, join(root, 'scripts', 'dev.ts')], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = once(child, 'exit') as Promise<[number | null]>;
    const log = () => readFile(devLog, 'utf8').catch(() => '');
    const started = await Promise.race([
      waitUntil(async () => /^token /m.test(await log()) && (alsoWaitFor === undefined || existsSync(alsoWaitFor)), 30_000).then(() => true),
      exited.then(() => false),
    ]);
    if (started) {
      child.kill('SIGTERM');
      await exited;
    }
    const [code] = await exited;
    const seen = /^token ([0-9a-f]{64}) (\d+)$/m.exec(await log());
    const perRun = /^per-run (.*)$/m.exec(await log())?.[1];
    return { code, stdout, stderr, started, hash: seen?.[1], length: Number(seen?.[2]), perRun };
  }

  it('without PITWALL_TOKEN, mints a random token for the run, and says nothing about it', async () => {
    const run = await devRun(await layout());
    expect(run.started).toBe(true);
    expect(run.length).toBe(43);
    expect(run.stderr + run.stdout).not.toContain('fixed');
  }, 60_000);

  it('uses PITWALL_TOKEN from the environment, and says so in one line, without the token', async () => {
    const run = await devRun(await layout(), { token: FIXED });
    expect(run.hash).toBe(sha256(FIXED));
    expect(run.stderr).toBe(`pitwall dev: ${fixedTokenNotice()}\n`);
    expect(run.stderr + run.stdout).not.toContain(FIXED);
  }, 60_000);

  it('uses PITWALL_TOKEN from the repo’s own .env, found from the script, and says it came from there', async () => {
    const run = await devRun(await layout(`# made up\nPITWALL_TOKEN=${FROM_FILE}\n`));
    expect(run.hash).toBe(sha256(FROM_FILE));
    expect(run.stderr).toBe(`pitwall dev: ${fixedTokenNotice('.env')}\n`);
    expect(run.stderr + run.stdout).not.toContain(FROM_FILE);
  }, 60_000);

  it('lets the environment win over .env', async () => {
    const run = await devRun(await layout(`PITWALL_TOKEN=${FROM_FILE}\n`), { token: FIXED });
    expect(run.hash).toBe(sha256(FIXED));
    expect(run.stderr).toBe(`pitwall dev: ${fixedTokenNotice()}\n`);
  }, 60_000);

  it('ignores a .env in the current directory', async () => {
    const elsewhere = join(tmp, `elsewhere-${++n}`);
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, '.env'), `PITWALL_TOKEN=${FROM_FILE}\n`);
    const run = await devRun(await layout(), { cwd: elsewhere });
    expect(run.started).toBe(true);
    expect(run.hash).not.toBe(sha256(FROM_FILE));
    expect(run.length).toBe(43);
    expect(run.stderr + run.stdout).not.toContain('fixed');
  }, 60_000);

  it.each([
    ['in the environment', { token: '' }, undefined],
    ['in .env, as .env.example has it', {}, 'PITWALL_TOKEN=\n'],
    ['in both', { token: '' }, 'PITWALL_TOKEN=\n'],
  ] as const)('takes an empty PITWALL_TOKEN %s as unset: a random token for the run, and nothing about a fixed one', async (_, options, env) => {
    const run = await devRun(await layout(env), options);
    expect(run.started).toBe(true);
    expect(run.length).toBe(43);
    expect(run.stderr + run.stdout).not.toContain('fixed');
  }, 60_000);

  it('lets .env set PITWALL_TOKEN when the environment has it empty', async () => {
    const run = await devRun(await layout(`PITWALL_TOKEN=${FROM_FILE}\n`), { token: '' });
    expect(run.hash).toBe(sha256(FROM_FILE));
    expect(run.stderr).toBe(`pitwall dev: ${fixedTokenNotice('.env')}\n`);
  }, 60_000);

  it.each([
    ['too short, from the environment', { token: 'short' }, undefined, 'pitwall dev: PITWALL_TOKEN must be at least 32 characters\n'],
    ['with other characters, from the environment', { token: `${FIXED}!` }, undefined, 'pitwall dev: PITWALL_TOKEN may only contain A-Z, a-z, 0-9, "-" and "_"\n'],
    ['too short, from .env', {}, 'PITWALL_TOKEN=short\n', 'pitwall dev: PITWALL_TOKEN must be at least 32 characters (from '],
  ] as const)('refuses a PITWALL_TOKEN that is %s, with the CLI’s message, and starts nothing', async (_, options, env, message) => {
    const run = await devRun(await layout(env), options);
    expect(run.code).toBe(1);
    expect(run.started).toBe(false);
    expect(run.stderr.startsWith(message)).toBe(true);
    if ('token' in options && options.token) expect(run.stderr).not.toContain(options.token);
  }, 60_000);

  it.each([
    ['32 zeros, from the environment', { token: '0'.repeat(32) }, undefined, 'pitwall dev: PITWALL_TOKEN must have at least 8 different characters\n'],
    ['a word repeated, from .env', {}, `PITWALL_TOKEN=${'changeme-'.repeat(5)}\n`, 'pitwall dev: PITWALL_TOKEN must not be one piece repeated, as in abcabcabc (from '],
  ] as const)('refuses an obviously weak PITWALL_TOKEN, %s, without printing it, and starts nothing (W51)', async (_, options, env, message) => {
    const run = await devRun(await layout(env), options);
    expect(run.code).toBe(1);
    expect(run.started).toBe(false);
    expect(run.stderr.startsWith(message)).toBe(true);
    expect(run.stderr + run.stdout).not.toContain('0'.repeat(32));
    expect(run.stderr + run.stdout).not.toContain('changeme-');
  }, 60_000);

  it('marks the token it makes for the run as per-run, and a fixed one never, even when the environment says so (W51)', async () => {
    const minted = await devRun(await layout());
    expect(minted.perRun).toBe('1');
    const fixed = await devRun(await layout(), { token: FIXED, extra: { PITWALL_TOKEN_PER_RUN: '1' } });
    expect(fixed.hash).toBe(sha256(FIXED));
    expect(fixed.perRun).toBe('unset');
    expect(fixed.stderr).toBe(`pitwall dev: ${fixedTokenNotice()}\n`);
    const fromFile = await devRun(await layout(`PITWALL_TOKEN=${FROM_FILE}\n`));
    expect(fromFile.perRun).toBe('unset');
  }, 60_000);

  it('never takes PITWALL_TOKEN_PER_RUN from a .env: a fixed token stays fixed, and the token it makes is still per-run (W58)', async () => {
    // A 0600 .env holding a made-up token and the mark.
    const fromFile = await devRun(await layout(`# made up\nPITWALL_TOKEN=${FROM_FILE}\nPITWALL_TOKEN_PER_RUN=1\n`));
    expect(fromFile.hash).toBe(sha256(FROM_FILE));
    expect(fromFile.perRun).toBe('unset');
    expect(fromFile.stderr).toBe(`pitwall dev: ${fixedTokenNotice('.env')}\n`);
    expect(fromFile.stderr + fromFile.stdout).not.toContain(FROM_FILE);
    // A token from the environment, with the mark in the .env.
    const fromEnvironment = await devRun(await layout('PITWALL_TOKEN_PER_RUN=1\n'), { token: FIXED });
    expect(fromEnvironment.hash).toBe(sha256(FIXED));
    expect(fromEnvironment.perRun).toBe('unset');
    expect(fromEnvironment.stderr).toBe(`pitwall dev: ${fixedTokenNotice()}\n`);
    // No token anywhere: the one this run makes is marked, by dev itself.
    const minted = await devRun(await layout('PITWALL_TOKEN_PER_RUN=1\n'));
    expect(minted.length).toBe(43);
    expect(minted.perRun).toBe('1');
    expect(minted.stderr + minted.stdout).not.toContain('fixed');
  }, 60_000);

  describe('the .env’s mode and owner (W51)', () => {
    it.each([[0o644], [0o640], [0o604], [0o660], [0o620]])('refuses a .env at mode %o, saying chmod 600, without showing what is in it, and starts nothing', async (mode) => {
      const root = await layout(`PITWALL_TOKEN=${FROM_FILE}\nPWTEST_OTHER=made-up-value-in-the-file\n`, mode);
      const run = await devRun(root);
      expect(run.code).toBe(1);
      expect(run.started).toBe(false);
      // dev.ts names the file from its own real path, so a symlinked temp directory shows resolved.
      const file = join(realpathSync(root), '.env');
      expect(run.stderr).toBe(
        `pitwall dev: ${file} can be read or changed by other users (mode ${mode.toString(8)}), and it can hold PITWALL_TOKEN. Run chmod 600 ${file}, then run npm run dev again.\n`,
      );
      expect(run.stderr + run.stdout).not.toContain(FROM_FILE);
      expect(run.stderr + run.stdout).not.toContain('made-up-value');
      // Left as it was: pitwall never changes the mode itself.
      expect(statSync(join(root, '.env')).mode & 0o777).toBe(mode);
    }, 60_000);

    it('refuses a loose .env even when the environment has the token, since its other variables would still be read', async () => {
      const run = await devRun(await layout(`PITWALL_TOKEN=${FROM_FILE}\n`, 0o644), { token: FIXED });
      expect(run.code).toBe(1);
      expect(run.started).toBe(false);
      expect(run.stderr).toContain('Run chmod 600 ');
      expect(run.stderr + run.stdout).not.toContain(FIXED);
      expect(run.stderr + run.stdout).not.toContain(FROM_FILE);
    }, 60_000);

    it('reads a .env at 0600 or 0400', async () => {
      for (const mode of [0o600, 0o400]) {
        const run = await devRun(await layout(`PITWALL_TOKEN=${FROM_FILE}\n`, mode));
        expect(run.started).toBe(true);
        expect(run.hash).toBe(sha256(FROM_FILE));
      }
    }, 60_000);

    it('refuses a .env that is a directory, rather than reading it', async () => {
      const root = await layout();
      await mkdir(join(root, '.env'), { mode: 0o700 });
      const run = await devRun(root);
      expect(run.code).toBe(1);
      expect(run.started).toBe(false);
      expect(run.stderr).toBe(`pitwall dev: ${join(realpathSync(root), '.env')} is not a file. Move it aside, then run npm run dev again.\n`);
    }, 60_000);
  });

  it('gives Vite the environment pitwall gives any child: no PITWALL_* variable, and nothing holding the token (W48 F7)', async () => {
    const viteLog = join(tmp, `vite-env-${++n}.log`);
    const run = await devRun(await layout(`PITWALL_TOKEN=${FROM_FILE}\nPWTEST_FROM_FILE=kept\n`), {
      extra: { PWTEST_VITE_ENV_LOG: viteLog, PWTEST_COPY: `Bearer ${FROM_FILE}`, PWTEST_KEPT: 'kept', PITWALL_NO_OPEN: '1' },
      alsoWaitFor: viteLog,
    });
    expect(run.started).toBe(true);
    const names = JSON.parse((await readFile(viteLog, 'utf8')).split('\n')[0]!) as string[];
    expect(names.filter((name) => /^pitwall_/i.test(name))).toEqual([]);
    expect(names).not.toContain('PWTEST_COPY');
    expect(names).toEqual(expect.arrayContaining(['PATH', 'PWTEST_KEPT', 'PWTEST_FROM_FILE', 'PWTEST_VITE_ENV_LOG']));
  }, 60_000);
});

describe('npm run dev: what the CLI prints on every restart (W51)', () => {
  const FIXED = 'pitwall-test-fixed-token-0123456789abcdefghij';
  const FROM_FILE = 'pitwall-test-dotenv-token-0123456789abcdefghij';
  let tmp: string;
  let bin: string;
  let n = 0;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
    bin = join(tmp, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    await writeFile(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    await writeFile(join(bin, 'open'), FAKE_OPENER, { mode: 0o755 });
    await writeFile(join(bin, 'xdg-open'), FAKE_OPENER, { mode: 0o755 });
    await writeFile(join(bin, 'vite'), FAKE_VITE, { mode: 0o755 });
    await writeFile(join(bin, 'tsx'), FAKE_TSX, { mode: 0o755 });
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /**
   * Runs a layout's dev.ts, from the layout itself as npm run dev does, so src/cli.ts resolves, with
   * the restarting stand-in for tsx watch, until the restarted CLI is up. Then stops it, and returns
   * everything it printed.
   */
  async function devRestart(env?: string, token?: string) {
    const root = await devLayout(join(tmp, `repo-${++n}`), env);
    const port = await freePort();
    const devLog = join(tmp, `dev-${++n}.log`);
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      PITWALL_DEV_PORT: String(port),
      PITWALL_NO_OPEN: '0',
      PITWALL_HOME: join(tmp, `home-${++n}`),
      PWTEST_OPEN_LOG: join(tmp, `opened-${n}`),
      PITWALL_TEST_DEV_LOG: devLog,
    };
    delete childEnv.PITWALL_TOKEN;
    delete childEnv.PITWALL_TOKEN_PER_RUN;
    if (token !== undefined) childEnv.PITWALL_TOKEN = token;
    const child = spawn(process.execPath, ['--import', TSX_LOADER, join(root, 'scripts', 'dev.ts'), tmp], { cwd: root, env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const devLogText = async () => readFile(devLog, 'utf8').catch(() => '');
    try {
      await waitUntil(async () => /^(restarted|failed)/m.test(await devLogText()), 45_000);
      expect(await devLogText()).not.toMatch(/^failed/m);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const killer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        await once(child, 'exit');
        clearTimeout(killer);
      }
    }
    return { port, stdout, stderr };
  }

  it('without PITWALL_TOKEN, prints the dev run’s own token with the URL, the same on every restart, as before', async () => {
    const { port, stdout, stderr } = await devRestart();
    const printed = [...stdout.matchAll(new RegExp(`^pitwall is running at http://127\\.0\\.0\\.1:${port}/#token=([A-Za-z0-9_-]{43})$`, 'gm'))].map((m) => m[1]);
    expect(printed).toHaveLength(2);
    expect(printed[1]).toBe(printed[0]);
    expect(stdout).not.toContain(FIXED_TOKEN_LINE);
    expect(stderr).not.toContain('fixed');
  }, 60_000);

  it.each([
    ['from the environment', undefined, FIXED],
    ['from .env', `PITWALL_TOKEN=${FROM_FILE}\n`, undefined],
    ['from a 0600 .env that also says PITWALL_TOKEN_PER_RUN=1 (W58)', `# made up\nPITWALL_TOKEN=${FROM_FILE}\nPITWALL_TOKEN_PER_RUN=1\n`, undefined],
  ] as const)('with a fixed token %s, prints the address without it on every restart, and the token nowhere', async (_, env, token) => {
    const secret = token ?? FROM_FILE;
    const { port, stdout, stderr } = await devRestart(env, token);
    const lines = stdout.split('\n');
    expect(lines.filter((line) => line === `pitwall is running at http://127.0.0.1:${port}/`)).toHaveLength(2);
    expect(lines.filter((line) => line === FIXED_TOKEN_LINE)).toHaveLength(2);
    expect(stdout).not.toContain('#token=' + secret.slice(0, 4));
    expect(stdout + stderr).not.toContain(secret);
    // Said once, by npm run dev, not by each restart.
    expect(stderr.split('\n').filter((line) => line.includes('the token is fixed'))).toEqual([
      `pitwall dev: ${fixedTokenNotice(env === undefined ? undefined : '.env')}`,
    ]);
  }, 60_000);
});

describe('pitwall (the process): PITWALL_TOKEN comes from the environment only (W40)', () => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const FROM_FILE = 'pitwall-test-dotenv-token-0123456789abcdefghij';
  const FIXED = 'pitwall-test-fixed-token-0123456789abcdefghij';
  let tmp: string;
  let bin: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'pitwall-test-'));
    bin = join(tmp, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    await writeFile(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    // A .env where the CLI runs, as someone else's repo might have.
    await writeFile(join(tmp, '.env'), `PITWALL_TOKEN=${FROM_FILE}\n`);
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  /** Starts the CLI in `tmp`, which holds a .env, and returns its output once it's running, then stops it. */
  async function started(token?: string) {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, PITWALL_NO_OPEN: '1', PITWALL_HOME: join(tmp, 'home') };
    delete env.PITWALL_TOKEN;
    delete env.PITWALL_OPEN_MARKER;
    if (token !== undefined) env.PITWALL_TOKEN = token;
    const child = spawn(process.execPath, ['--import', TSX_LOADER, cli, '--port', '0', tmp], { cwd: tmp, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    await waitUntil(() => stdout.includes('Watching'), 30_000);
    child.kill('SIGTERM');
    const [code] = (await once(child, 'exit')) as [number | null];
    const printed = /running at http:\/\/127\.0\.0\.1:\d+\/#token=(\S+)/.exec(stdout)?.[1];
    return { code, stdout, stderr, printed };
  }

  it('never loads a .env from the current directory: the token is a new random one, and nothing says it is fixed', async () => {
    const run = await started();
    expect(run.code).toBe(0);
    expect(run.printed).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(run.printed).not.toBe(FROM_FILE);
    expect(run.stderr).not.toContain('fixed');
  }, 30_000);

  it('with PITWALL_TOKEN empty, takes it as unset: a new random token, and nothing says it is fixed', async () => {
    const run = await started('');
    expect(run.code).toBe(0);
    expect(run.printed).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(run.stderr).not.toContain('fixed');
  }, 30_000);

  it('with PITWALL_TOKEN set, prints one line saying the token is fixed, and never the token', async () => {
    const run = await started(FIXED);
    expect(run.code).toBe(0);
    expect(run.printed).toBeUndefined();
    expect(run.stderr).toBe(`pitwall: ${fixedTokenNotice()}\n`);
    // Neither the warning nor the URL line carries it (W51).
    expect(run.stdout).toMatch(new RegExp(`^pitwall is running at http://127\\.0\\.0\\.1:\\d+/\n${FIXED_TOKEN_LINE.replace(/[.;#]/g, '\\$&')}\nWatching root: `));
    expect(run.stdout + run.stderr).not.toContain(FIXED);
  }, 30_000);
});

describe('.env.example (W40)', () => {
  it('names PITWALL_TOKEN with no value, says it is for a single-user machine or development, and how to make one', async () => {
    const text = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
    expect(text.split('\n').filter((line) => line !== '' && !line.startsWith('#'))).toEqual(['PITWALL_TOKEN=']);
    expect(text.replace(/\s*\n#\s*/g, ' ')).toContain('Use this only on a single-user machine or for development.');
    expect(text).toContain('never reads a .env');
    expect(text.replace(/\s*\n#\s*/g, ' ')).toContain('Left empty, as here, it counts as unset');
    // npm run dev refuses a .env that others can read (W51), and a copy starts at the umask's 0644.
    expect(text).toMatch(/^#\s+chmod 600 \.env$/m);
    expect(text.replace(/\s*\n#\s*/g, ' ')).toContain('with at least 8 different ones, and not one piece repeated (abcabc...)');
    expect(text.replace(/\s*\n#\s*/g, ' ')).toContain('pitwall never prints a fixed token');
    // Its command makes a token the CLI accepts.
    const command = /node -e "(.*)"/.exec(text)![1]!;
    const made = execFileSync(process.execPath, ['-e', command], { encoding: 'utf8' }).trim();
    expect(made).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(resolveToken({ PITWALL_TOKEN: made })).toBe(made);
  });
});
