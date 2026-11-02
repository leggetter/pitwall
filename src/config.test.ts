// The config file (W103, D24). Every test uses its own temp PITWALL_HOME or file: none reads or
// writes the real ~/.pitwall/config.json.
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE_NAME,
  CONFIG_MAX_BYTES,
  ConfigError,
  configFileProblem,
  configPath,
  expandHome,
  jsonErrorAt,
  loadConfig,
  ownersByRoot,
  parseConfig,
  readCapped,
  stripJsonComments,
  UnendingComment,
} from './config.js';
import { resolveRoots as indexRoots } from './index/roots.js';

const FILE = '/home/example/.pitwall/config.json';
const HOME = '/home/example';
/** No path exists, so each resolves to itself, as the index's roots do when realpath fails. */
const noRealpath = (path: string): string => {
  throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
};
const parse = (text: string) => parseConfig(text, FILE, { home: HOME, realpath: noRealpath });
const fails = (text: string) => () => parse(text);

describe('stripJsonComments', () => {
  it('removes // and /* */ comments, keeping line breaks so positions still point into the file', () => {
    const text = '{ // a comment\n  "a": 1, /* another\n one */ "b": 2 }';
    const stripped = stripJsonComments(text);
    expect(stripped).toHaveLength(text.length);
    expect(stripped.split('\n')).toHaveLength(3);
    expect(JSON.parse(stripped)).toEqual({ a: 1, b: 2 });
  });

  it('keeps comment-like text inside strings', () => {
    const text = '{ "url": "https://example.com/a//b", "glob": "/* not a comment */", "q": "say \\"// hi\\"" }';
    expect(JSON.parse(stripJsonComments(text))).toEqual({ url: 'https://example.com/a//b', glob: '/* not a comment */', q: 'say "// hi"' });
  });

  it('removes trailing commas before ] and }, even with a comment between', () => {
    expect(JSON.parse(stripJsonComments('{ "a": [1, 2,], "b": { "c": 3, }, }'))).toEqual({ a: [1, 2], b: { c: 3 } });
    expect(JSON.parse(stripJsonComments('[1, // last\n]'))).toEqual([1]);
    expect(JSON.parse(stripJsonComments('[1, /* x */ ]'))).toEqual([1]);
  });

  it('keeps a comma inside a string, and one that is not trailing', () => {
    expect(JSON.parse(stripJsonComments('{ "a": ",]", "b": ",}", }'))).toEqual({ a: ',]', b: ',}' });
  });

  it('leaves a comma after [, { or another comma for JSON.parse to refuse', () => {
    expect(() => JSON.parse(stripJsonComments('[,]'))).toThrow();
    expect(() => JSON.parse(stripJsonComments('{,}'))).toThrow();
    expect(() => JSON.parse(stripJsonComments('[1,,]'))).toThrow();
  });

  it('takes a byte order mark', () => {
    expect(JSON.parse(stripJsonComments('\uFEFF{ "a": 1 }'))).toEqual({ a: 1 });
  });

  it('refuses a /* comment that never ends, saying where it starts', () => {
    expect(() => stripJsonComments('{ "a": 1 /* oops')).toThrow(UnendingComment);
    expect(() => stripJsonComments('{ "a": 1 /* oops')).toThrow(expect.objectContaining({ at: 9 }));
  });

  it('takes a // comment on the last line, with no line break after it', () => {
    expect(JSON.parse(stripJsonComments('{ "a": 1 } // done'))).toEqual({ a: 1 });
  });
});

describe('expandHome', () => {
  it('expands ~ and a leading ~/ only', () => {
    expect(expandHome('~', HOME)).toBe(HOME);
    expect(expandHome('~/work', HOME)).toBe('/home/example/work');
    expect(expandHome('~other/work', HOME)).toBe('~other/work');
    expect(expandHome('/abs/~/x', HOME)).toBe('/abs/~/x');
  });
});

describe('parseConfig', () => {
  it('reads the example: a path string, and an object with github.owners', () => {
    const { roots, warnings } = parse(`{
      // Phil's two roots
      "roots": [
        "~/oss",
        { "path": "~/work", "github": { "owners": ["Example-Co", "example-co", "other_shortcode"] } },
      ],
    }`);
    expect(warnings).toEqual([]);
    expect(roots).toEqual([
      { key: 'roots[0]', path: '/home/example/oss', real: '/home/example/oss' },
      { key: 'roots[1]', path: '/home/example/work', real: '/home/example/work', owners: ['example-co', 'other_shortcode'] },
    ]);
  });

  it('takes "all" and "none", an absolute path and ~ alone, and normalizes the path', () => {
    const { roots } = parse('{ "roots": [ { "path": "~", "github": { "owners": "all" } }, { "path": "/srv/./code/", "github": { "owners": "none" } } ] }');
    expect(roots).toEqual([
      { key: 'roots[0]', path: HOME, real: HOME, owners: 'all' },
      { key: 'roots[1]', path: '/srv/code', real: '/srv/code', owners: 'none' },
    ]);
  });

  it('leaves owners out for a root without github, or with a github that has no owners', () => {
    const { roots } = parse('{ "roots": [ { "path": "/a" }, { "path": "/b", "github": {} } ] }');
    expect(roots?.map((root) => root.owners)).toEqual([undefined, undefined]);
  });

  it('has no roots for a file without "roots", or an empty object', () => {
    expect(parse('{}')).toEqual({ warnings: [] });
    expect(parse('// nothing yet\n{ }')).toEqual({ warnings: [] });
  });

  it('warns about each unknown key, at any level, naming it and the file, and reads the rest', () => {
    const { roots, warnings } = parse('{ "port": 4600, "roots": [ { "path": "/a", "label": "A", "github": { "owners": "all", "teams": [] } } ] }');
    expect(roots).toHaveLength(1);
    expect(warnings).toEqual([
      `${FILE}: unknown key "port", ignored. A newer pitwall may use it.`,
      `${FILE}: unknown key "roots[0].label", ignored. A newer pitwall may use it.`,
      `${FILE}: unknown key "roots[0].github.teams", ignored. A newer pitwall may use it.`,
    ]);
  });

  describe('refuses a token anywhere, saying PITWALL_TOKEN comes from the environment only (D24)', () => {
    it.each([
      ['{ "token": "x" }', 'token'],
      ['{ "PITWALL_TOKEN": "x" }', 'PITWALL_TOKEN'],
      ['{ "roots": ["/a"], "githubToken": "x" }', 'githubToken'],
      ['{ "roots": [ { "path": "/a", "github": { "api-token": "x" } } ] }', 'roots[0].github.api-token'],
      ['{ "future": [ { "deep": { "Token": 1 } } ] }', 'future[0].deep.Token'],
    ])('%s', (text, key) => {
      expect(fails(text)).toThrow(
        new ConfigError(
          `${FILE}: the key "${key}" is named like a token, and pitwall never reads one from a file: PITWALL_TOKEN comes from the environment only. Remove it from the file.`,
        ),
      );
    });

    it('never quotes its value', () => {
      expect(fails('{ "token": "pitwall-test-secret-value" }')).toThrow(expect.objectContaining({ message: expect.not.stringContaining('pitwall-test-secret-value') }));
    });

    it('but not a key that only has "token" inside it, such as a future maxTokens', () => {
      expect(parse('{ "maxTokens": 10, "tokenizer": "x" }').warnings).toHaveLength(2);
    });

    it('before anything else, so a token never sits beside a value that would only warn', () => {
      expect(fails('{ "roots": 1, "token": "x" }')).toThrow(/is named like a token/);
    });
  });

  describe('stops with a ConfigError naming the key and the file', () => {
    it.each([
      ['not JSON', '{ "roots": [ }', `${FILE} isn't valid JSON at line 1, column 14. Comments and trailing commas are allowed.`],
      ['an unterminated comment', '{\n  /* ', `${FILE}: the /* comment at line 2, column 3 never ends`],
      ['a list at the top', '["/a"]', `${FILE} must hold a JSON object, such as { "roots": ["~/code"] }`],
      ['null at the top', 'null', `${FILE} must hold a JSON object, such as { "roots": ["~/code"] }`],
      ['roots not a list', '{ "roots": "~/work" }', `${FILE}: "roots" must be a list of roots, each a path or { "path": ... }`],
      ['roots empty', '{ "roots": [] }', `${FILE}: "roots" is empty. List at least one root, or leave "roots" out to watch the current directory.`],
      ['a root that is a number', '{ "roots": [1] }', `${FILE}: "roots[0]" must be a path or { "path": ... }, not a number`],
      ['a root that is a list', '{ "roots": [["/a"]] }', `${FILE}: "roots[0]" must be a path or { "path": ... }, not a list`],
      ['a root with no path', '{ "roots": [ { "github": {} } ] }', `${FILE}: "roots[0].path" is missing: each root needs a path`],
      ['a path that is not a string', '{ "roots": [ { "path": true } ] }', `${FILE}: "roots[0].path" must be a path, not true or false`],
      ['an empty path', '{ "roots": [""] }', `${FILE}: "roots[0]" must be a path, not an empty string`],
      ['a relative path', '{ "roots": ["/a", "code"] }', `${FILE}: "roots[1]" must be an absolute path, ~, or a path starting with ~/`],
      ['a ./ path', '{ "roots": [ { "path": "./code" } ] }', `${FILE}: "roots[0].path" must be an absolute path, ~, or a path starting with ~/`],
      ['~user', '{ "roots": ["~other/code"] }', `${FILE}: "roots[0]" must be an absolute path, ~, or a path starting with ~/`],
      ['github not an object', '{ "roots": [ { "path": "/a", "github": "all" } ] }', `${FILE}: "roots[0].github" must be an object, such as { "owners": ["example-co"] }, not a string`],
      ['owners a bare owner', '{ "roots": [ { "path": "/a", "github": { "owners": "example-co" } } ] }', `${FILE}: "roots[0].github.owners" must be a list of GitHub owners, "all" or "none", not a string`],
      ['owners null', '{ "roots": [ { "path": "/a", "github": { "owners": null } } ] }', `${FILE}: "roots[0].github.owners" must be a list of GitHub owners, "all" or "none", not null`],
      ['owners empty', '{ "roots": [ { "path": "/a", "github": { "owners": [] } } ] }', `${FILE}: "roots[0].github.owners" is empty. Use "none" for this root's own clones only.`],
      ['an owner with a slash', '{ "roots": [ { "path": "/a", "github": { "owners": ["ok", "example/repo"] } } ] }', `${FILE}: "roots[0].github.owners[1]" must be a GitHub user or organization name: letters, digits, - and _, starting with a letter or digit, at most 100 characters`],
      ['an owner starting with -', '{ "roots": [ { "path": "/a", "github": { "owners": ["-x"] } } ] }', `${FILE}: "roots[0].github.owners[0]" must be a GitHub user or organization name: letters, digits, - and _, starting with a letter or digit, at most 100 characters`],
      ['an owner that is a number', '{ "roots": [ { "path": "/a", "github": { "owners": [7] } } ] }', `${FILE}: "roots[0].github.owners[0]" must be a GitHub user or organization name, such as "example-co", not a number`],
      ['the same root twice', '{ "roots": ["~/work", { "path": "/home/example/work/" }] }', `${FILE}: "roots[1]" is the same directory as "roots[0]", "/home/example/work". List each root once.`],
      [
        'two roots with "all"',
        '{ "roots": [ { "path": "/a", "github": { "owners": "all" } }, { "path": "/b", "github": { "owners": "all" } } ] }',
        `${FILE}: "roots[1].github.owners" is "all", and so is "roots[0].github.owners". Only one root can take the owners no other root lists.`,
      ],
      [
        'an owner on two roots, in any case',
        '{ "roots": [ { "path": "/a", "github": { "owners": ["example-co"] } }, { "path": "/b", "github": { "owners": ["Example-Co"] } } ] }',
        `${FILE}: "roots[1].github.owners" lists "example-co", and so does "roots[0].github.owners". An owner can belong to one root only.`,
      ],
    ])('%s', (_, text, message) => {
      let thrown: unknown;
      try {
        parse(text);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as Error).message.startsWith(message)).toBe(true);
    });

    it('quotes a key with control characters escaped, and cuts a long one short', () => {
      expect(parse('{ "odd\\u001b[31m": 1 }').warnings).toEqual([`${FILE}: unknown key "odd\\u001b[31m", ignored. A newer pitwall may use it.`]);
      expect(parse(`{ "${'k'.repeat(500)}": 1 }`).warnings[0]).toMatch(/unknown key "k{76}\.\.\.", ignored/);
    });

    it('quotes the real path of a root listed twice, so a control character in it is escaped', () => {
      expect(fails('{ "roots": ["/a\\u001bb", "/a\\u001bb/"] }')).toThrow('is the same directory as "roots[0]", "/a\\u001bb". List each root once.');
    });

    it('says where invalid JSON is, as a line and column in the file as written', () => {
      expect(fails('{\n  // a comment\n  "roots": ["/a"] "x"\n}')).toThrow(`${FILE} isn't valid JSON at line 3, column 19. Comments and trailing commas are allowed.`);
    });
  });

  it('takes a list owner beside "all" on another root: a listed owner wins over "all"', () => {
    const { roots } = parse('{ "roots": [ { "path": "/a", "github": { "owners": "all" } }, { "path": "/b", "github": { "owners": ["example-co"] } } ] }');
    expect(roots?.map((root) => root.owners)).toEqual(['all', ['example-co']]);
  });
});

describe('the config file on disk', () => {
  let tmp: string;
  let n = 0;
  const uid = process.getuid?.();

  beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pitwall-test-config-')));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A fresh PITWALL_HOME, with config.json holding `text` at `mode` when it's given. */
  function home(text?: string, mode = 0o600): { env: NodeJS.ProcessEnv; file: string; dir: string } {
    const dir = join(tmp, `home-${++n}`);
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, CONFIG_FILE_NAME);
    if (text !== undefined) {
      writeFileSync(file, text, { mode });
      // Exactly, whatever the umask.
      chmodSync(file, mode);
    }
    return { env: { PITWALL_HOME: dir }, file, dir };
  }

  it('is config.json in PITWALL_HOME, ~/.pitwall without it, or --config resolved against the current directory', () => {
    expect(configPath({ cwd: '/w', env: { PITWALL_HOME: '/p' } })).toBe('/p/config.json');
    expect(configPath({ cwd: '/w', env: {}, home: HOME })).toBe('/home/example/.pitwall/config.json');
    expect(configPath({ cwd: '/w', env: { PITWALL_HOME: '/p' }, file: 'my.json' })).toBe('/w/my.json');
    expect(configPath({ cwd: '/w', env: {}, file: '~/my.json', home: HOME })).toBe('/home/example/my.json');
  });

  it('is fine when the default file is missing: no roots, no warnings', () => {
    const { env, file } = home();
    expect(loadConfig({ cwd: tmp, env })).toEqual({ file, found: false, warnings: [] });
  });

  it('is fine when PITWALL_HOME itself is missing', () => {
    const env = { PITWALL_HOME: join(tmp, 'never-made') };
    expect(loadConfig({ cwd: tmp, env })).toMatchObject({ found: false });
  });

  it('is an error when the --config file is missing', () => {
    const { env } = home();
    const missing = join(tmp, 'missing.json');
    expect(() => loadConfig({ cwd: tmp, env, file: missing })).toThrow(new ConfigError(`the config file ${missing} does not exist (--config)`));
  });

  it('reads --config instead of the default, relative to the current directory', () => {
    const { env } = home('{ "roots": ["/default"] }');
    const dir = join(tmp, `cwd-${++n}`);
    mkdirSync(dir);
    writeFileSync(join(dir, 'other.json'), '{ "roots": ["/other"] }', { mode: 0o600 });
    chmodSync(join(dir, 'other.json'), 0o600);
    const loaded = loadConfig({ cwd: dir, env, file: 'other.json' });
    expect(loaded).toMatchObject({ file: join(dir, 'other.json'), found: true });
    expect(loaded.roots?.map((root) => root.path)).toEqual(['/other']);
  });

  it('reads a file of yours, expanding ~ and resolving real paths', () => {
    const real = join(tmp, `real-${++n}`);
    mkdirSync(real);
    const link = join(tmp, `link-${n}`);
    symlinkSync(real, link);
    const { env, file } = home(`{ "roots": ["~/code", { "path": "${link}", "github": { "owners": "none" } }] }`, 0o644);
    const loaded = loadConfig({ cwd: tmp, env, home: '/home/example' });
    expect(loaded.file).toBe(file);
    expect(loaded.roots).toEqual([
      { key: 'roots[0]', path: '/home/example/code', real: '/home/example/code' },
      { key: 'roots[1]', path: link, real, owners: 'none' },
    ]);
  });

  it('follows a symbolic link to the file, as a dotfiles repo might have it', () => {
    const target = join(tmp, `dotfiles-${++n}.json`);
    writeFileSync(target, '{ "roots": ["/a"] }', { mode: 0o600 });
    chmodSync(target, 0o600);
    const { env, file } = home();
    symlinkSync(target, file);
    expect(loadConfig({ cwd: tmp, env }).roots?.map((root) => root.path)).toEqual(['/a']);
  });

  describe.skipIf(process.platform === 'win32')('permissions, checked on the open file (POSIX)', () => {
    it.each([[0o664], [0o620], [0o646], [0o602], [0o666], [0o777]])('refuses mode %o, writable by group or others', (mode) => {
      const { env, file } = home('{ "roots": ["/a"] }', mode);
      expect(() => loadConfig({ cwd: tmp, env })).toThrow(
        new ConfigError(
          `the config file ${file} can be changed by other users (mode ${mode.toString(8)}), and it decides which directories pitwall reads. Run chmod go-w ${file}, then run pitwall again.`,
        ),
      );
    });

    it.each([[0o600], [0o644], [0o640], [0o400]])('reads mode %o: others may read it, since it holds no secret', (mode) => {
      const { env } = home('{ "roots": ["/a"] }', mode);
      expect(loadConfig({ cwd: tmp, env }).found).toBe(true);
    });

    it('refuses a file another user owns, through the open file', () => {
      const { env, file } = home('{ "roots": ["/a"] }');
      const other = (uid ?? 501) + 1;
      expect(() => loadConfig({ cwd: tmp, env, context: { uid: other } })).toThrow(
        new ConfigError(
          `the config file ${file} belongs to another user (uid ${uid}). pitwall reads a config file only when it's yours, since it decides which directories pitwall reads.`,
        ),
      );
    });

    it('checks the file a symbolic link points to, not the link', () => {
      const target = join(tmp, `loose-${++n}.json`);
      writeFileSync(target, '{}');
      chmodSync(target, 0o666);
      const { env, file } = home();
      symlinkSync(target, file);
      expect(() => loadConfig({ cwd: tmp, env })).toThrow(/can be changed by other users \(mode 666\)/);
    });
  });

  it('refuses a directory in its place', () => {
    const { env, file } = home();
    mkdirSync(file);
    expect(() => loadConfig({ cwd: tmp, env })).toThrow(new ConfigError(`the config file ${file} is not a file. Move it aside, then run pitwall again.`));
  });

  it('refuses a file bigger than a config file needs', () => {
    const { env, file } = home(`{ "roots": ["/a"] }${' '.repeat(CONFIG_MAX_BYTES)}`);
    expect(() => loadConfig({ cwd: tmp, env })).toThrow(new ConfigError(`the config file ${file} is over ${CONFIG_MAX_BYTES} bytes, far more than a config file needs`));
  });

  it('names the file in a bad value’s message, and returns the warnings', () => {
    const bad = home('{ "roots": ["code"] }');
    expect(() => loadConfig({ cwd: tmp, env: bad.env })).toThrow(`${bad.file}: "roots[0]" must be an absolute path, ~, or a path starting with ~/`);
    const odd = home('{ "port": 1, "roots": ["/a"] }');
    expect(loadConfig({ cwd: tmp, env: odd.env }).warnings).toEqual([`${odd.file}: unknown key "port", ignored. A newer pitwall may use it.`]);
  });
});

describe('configFileProblem', () => {
  const stats = (mode: number, uid = 501, isFile = true) => ({ mode: 0o100000 | mode, uid, isFile: () => isFile });

  it('checks only that it is a file on Windows, which has no POSIX modes', () => {
    expect(configFileProblem(FILE, stats(0o666, 0), { platform: 'win32' })).toBeUndefined();
    expect(configFileProblem(FILE, stats(0o666, 0, false), { platform: 'win32' })).toBeDefined();
  });

  it('accepts any owner when the uid is unknown', () => {
    expect(configFileProblem(FILE, stats(0o600, 0), { platform: 'linux', uid: undefined })).toBeUndefined();
  });
});

describe('ownersByRoot (for W105)', () => {
  const config = parse(`{ "roots": [
    { "path": "/r/work", "github": { "owners": ["example-co"] } },
    { "path": "/r/oss", "github": { "owners": "all" } },
    "/r/plain",
  ] }`);
  // /r/link is a link to /r/work; everything else is its own real path.
  const realpath = (path: string) => (path === '/r/link' ? '/r/work' : path);

  it('keys each configured root with github.owners by its real path', () => {
    expect(ownersByRoot(config, ['/r/work', '/r/oss', '/r/plain'], realpath)).toEqual(
      new Map<string, unknown>([
        ['/r/work', ['example-co']],
        ['/r/oss', 'all'],
      ]),
    );
  });

  it('gives a root given as an argument its configured settings when its real path is a configured root’s', () => {
    expect(ownersByRoot(config, ['/r/link'], realpath)).toEqual(new Map([['/r/work', ['example-co']]]));
  });

  it('leaves out a root the file doesn’t configure, so its owners are inferred from its clones', () => {
    expect(ownersByRoot(config, ['/r/elsewhere', '/r/plain'], realpath)).toEqual(new Map());
  });

  it('is empty with no config file', () => {
    expect(ownersByRoot({}, ['/r/work'], realpath)).toEqual(new Map());
  });
});

describe('jsonErrorAt', () => {
  it('is -1 for valid JSON of every kind', () => {
    for (const text of ['{}', '[]', ' { "a": [1, -2.5e+3, 0, true, false, null, "x\\n\\u00e9\\"\\\\"], "b": {} } ', '"s"', '7']) {
      expect(jsonErrorAt(text), text).toBe(-1);
    }
  });

  it('finds the offset V8 reports, where V8 reports one', () => {
    for (const text of ['{"a" 1}', '{"a":1 }}', '{"a":-}', '{"a":"\u0001"}', '{"a":"\\x"}', '{ 1: 2 }', '{"a":1,}', '[1 2]']) {
      let v8: number | undefined;
      try {
        JSON.parse(text);
      } catch (error) {
        const at = /at position (\d+)/.exec((error as Error).message)?.[1];
        v8 = at === undefined ? undefined : Number(at);
      }
      if (v8 !== undefined) expect(jsonErrorAt(text), text).toBe(v8);
      else expect(jsonErrorAt(text), text).toBeGreaterThanOrEqual(0);
    }
  });

  it('finds where V8 says only "Unexpected token", which quotes the text instead', () => {
    expect(jsonErrorAt('{ "token": pitwall-test-SECRET }')).toBe(11);
    expect(jsonErrorAt('[1,]')).toBe(3);
    expect(jsonErrorAt('{"a":tr}')).toBe(5);
  });

  it('puts an error at the end at the text’s length', () => {
    expect(jsonErrorAt('{ "roots": [')).toBe(12);
    expect(jsonErrorAt('{ "a": "unterminated')).toBe(20);
  });

  it('takes deep nesting without overflowing the stack', () => {
    expect(jsonErrorAt('['.repeat(200_000))).toBe(200_000);
    expect(jsonErrorAt(`${'['.repeat(200_000)}${']'.repeat(200_000)}`)).toBe(-1);
  });
});

describe('no value from the file in a message (D24, the review of #106)', () => {
  const SECRET = 'pitwall-test-SECRET-0123456789abcdef';
  const GH = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  const PAT = `github_pat_${'A1b2C3d4E5_'.repeat(8)}`;
  const message = (text: string): string => {
    try {
      parse(text);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('it parsed');
  };

  it('gives invalid JSON a line and column, never V8’s message, which quotes the text around the error', () => {
    const text = `{\n  "token": ${SECRET} }`;
    const got = message(text);
    expect(got).toBe(`${FILE} isn't valid JSON at line 2, column 12. Comments and trailing commas are allowed.`);
    expect(got).not.toContain('pitwall-test');
  });

  it.each([
    ['github', `{ "roots": [ { "path": "/a", "github": "${SECRET}" } ] }`, 'not a string'],
    ['owners', `{ "roots": [ { "path": "/a", "github": { "owners": "${SECRET}" } } ] }`, 'not a string'],
    ['a root', `{ "roots": [ { "path": "/a" }, "${SECRET}" ] }`, 'must be an absolute path, ~, or a path starting with ~/'],
    ['an owner', `{ "roots": [ { "path": "/a", "github": { "owners": ["${SECRET}/x"] } } ] }`, 'must be a GitHub user or organization name'],
  ])('describes a wrong value for %s by its type or shape, never its text', (_, text, expected) => {
    const got = message(text);
    expect(got).toContain(expected);
    expect(got).not.toContain('SECRET');
  });

  it.each([
    ['ghp_', 'ghp_x'],
    ['gho_', 'gho_short'],
    ['ghs_', 'GHS_upper'],
    ['github_pat_', 'github_pat_x'],
  ])('refuses an owner starting like a GitHub token (%s), without quoting it', (_, owner) => {
    const got = message(`{ "roots": [ { "path": "/a", "github": { "owners": ["ok", "${owner}"] } } ] }`);
    expect(got).toBe(`${FILE}: "roots[0].github.owners[1]" looks like a GitHub token, not an owner. Remove it from the file.`);
  });

  it.each([
    ['an owner', `{ "roots": [ { "path": "/a", "github": { "owners": ["${GH}"] } } ] }`, '"roots[0].github.owners[0]"'],
    ['github', `{ "roots": [ { "path": "/a", "github": "${GH}" } ] }`, '"roots[0].github"'],
    ['an unknown key', `{ "auth": "Bearer ${PAT}" }`, '"auth"'],
    ['a key that is one', `{ "roots": [ { "path": "/a", "${GH}": 1 } ] }`, 'a key in "roots[0]"'],
    ['a top-level key that is one', `{ "${GH}": 1 }`, 'a key at the top level'],
  ])('refuses a GitHub token anywhere, in %s, without quoting it', (_, text, where) => {
    const got = message(text);
    expect(got).toBe(
      `${FILE}: ${where} looks like a GitHub token, and pitwall never reads one from a file: gh keeps GitHub's token, and PITWALL_TOKEN comes from the environment only. Remove it from the file.`,
    );
    expect(got).not.toContain(GH.slice(4, 14));
    expect(got).not.toContain(PAT.slice(11, 21));
  });

  it('takes owners and paths that only contain a token prefix', () => {
    expect(parse('{ "roots": [ { "path": "/srv/ghp_notes", "github": { "owners": ["my-ghp_org", "gh_x"] } } ] }').roots?.[0]?.owners).toEqual([
      'my-ghp_org',
      'gh_x',
    ]);
  });
});

describe('parsing in linear time (the review of #106)', () => {
  const identity = (path: string) => path;

  // A megabyte of roots took 30.7 s with a search of the list for each one.
  it('reads a megabyte of roots quickly', { retry: 2 }, () => {
    const paths = Array.from({ length: 90_000 }, (_, i) => `"/r/${i}"`);
    const text = `{ "roots": [${paths.join(',')}] }`;
    expect(text.length).toBeGreaterThan(900_000);
    const started = performance.now();
    const { roots } = parseConfig(text, FILE, { home: HOME, realpath: identity });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(roots).toHaveLength(90_000);
  });

  it('reads a megabyte of owners quickly, deduped', { retry: 2 }, () => {
    const owners = Array.from({ length: 110_000 }, (_, i) => `"o${i % 100_000}"`);
    const text = `{ "roots": [ { "path": "/a", "github": { "owners": [${owners.join(',')}] } } ] }`;
    expect(text.length).toBeGreaterThan(900_000);
    const started = performance.now();
    const { roots } = parseConfig(text, FILE, { home: HOME, realpath: identity });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(roots?.[0]?.owners).toHaveLength(100_000);
  });

  it('builds ownersByRoot for many roots quickly', { retry: 2 }, () => {
    const paths = Array.from({ length: 50_000 }, (_, i) => `/r/${i}`);
    const text = `{ "roots": [${paths.map((path, i) => `{ "path": "${path}", "github": { "owners": ["o${i}"] } }`).join(',')}] }`;
    const config = parseConfig(text, FILE, { home: HOME, realpath: identity });
    const started = performance.now();
    expect(ownersByRoot(config, paths, identity).size).toBe(50_000);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe('real paths with the case on disk (the review of #106)', () => {
  let tmp: string;
  let caseInsensitive = false;

  beforeAll(() => {
    tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'pitwall-test-config-case-')));
    mkdirSync(join(tmp, 'work'));
    caseInsensitive = existsSync(join(tmp, 'WORK'));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // APFS and NTFS by default; ext4 and CI's runners are case-sensitive, where this can't happen.
  it('keys a root written in another case by its case on disk, as the index does', async (context) => {
    if (!caseInsensitive) context.skip();
    const typed = join(tmp, 'Work');
    const config = parseConfig(`{ "roots": [ { "path": "${typed}", "github": { "owners": ["example-co"] } } ] }`, FILE, { home: HOME });
    expect(config.roots?.[0]?.real).toBe(join(tmp, 'work'));
    // The index's own roots (src/index/roots.ts, fs.promises.realpath) agree.
    expect(await indexRoots([typed])).toEqual([join(tmp, 'work')]);
    expect(ownersByRoot(config, [join(tmp, 'work')])).toEqual(new Map([[join(tmp, 'work'), ['example-co']]]));
    expect(ownersByRoot(config, [join(tmp, 'WORK')])).toEqual(new Map([[join(tmp, 'work'), ['example-co']]]));
  });

  it('finds the same directory written in two cases', (context) => {
    if (!caseInsensitive) context.skip();
    expect(() => parseConfig(`{ "roots": ["${join(tmp, 'work')}", "${join(tmp, 'Work')}"] }`, FILE, { home: HOME })).toThrow(
      `"roots[1]" is the same directory as "roots[0]", "${join(tmp, 'work')}". List each root once.`,
    );
  });
});

describe('readCapped', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pitwall-test-config-read-'));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads to the end, and refuses more than the cap however big fstat says the file is', () => {
    const file = join(tmp, 'ten');
    writeFileSync(file, '0123456789');
    const read = (max: number) => {
      const fd = openSync(file, 'r');
      try {
        return readCapped(fd, max);
      } finally {
        closeSync(fd);
      }
    };
    expect(read(10)?.toString()).toBe('0123456789');
    expect(read(100)?.toString()).toBe('0123456789');
    expect(read(9)).toBeUndefined();
    expect(read(0)).toBeUndefined();
  });
});
