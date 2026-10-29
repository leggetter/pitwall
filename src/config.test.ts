// The config file (W103, D24). Every test uses its own temp PITWALL_HOME or file: none reads or
// writes the real ~/.pitwall/config.json.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  loadConfig,
  ownersByRoot,
  parseConfig,
  stripJsonComments,
} from './config.js';

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

  it('refuses a /* comment that never ends', () => {
    expect(() => stripJsonComments('{ "a": 1 /* oops')).toThrow(new ConfigError('a /* comment never ends'));
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
      ['not JSON', '{ "roots": [ }', `${FILE} isn't valid JSON (comments and trailing commas are allowed): `],
      ['an unterminated comment', '{ /* ', `${FILE} isn't valid JSON (comments and trailing commas are allowed): a /* comment never ends`],
      ['a list at the top', '["/a"]', `${FILE} must hold a JSON object, such as { "roots": ["~/code"] }`],
      ['null at the top', 'null', `${FILE} must hold a JSON object, such as { "roots": ["~/code"] }`],
      ['roots not a list', '{ "roots": "~/work" }', `${FILE}: "roots" must be a list of roots, each a path or { "path": ... }`],
      ['roots empty', '{ "roots": [] }', `${FILE}: "roots" is empty. List at least one root, or leave "roots" out to watch the current directory.`],
      ['a root that is a number', '{ "roots": [1] }', `${FILE}: "roots[0]" must be a path or { "path": ... }, not the number 1`],
      ['a root that is a list', '{ "roots": [["/a"]] }', `${FILE}: "roots[0]" must be a path or { "path": ... }, not a list`],
      ['a root with no path', '{ "roots": [ { "github": {} } ] }', `${FILE}: "roots[0].path" is missing: each root needs a path`],
      ['a path that is not a string', '{ "roots": [ { "path": true } ] }', `${FILE}: "roots[0].path" must be a path, not boolean true`],
      ['an empty path', '{ "roots": [""] }', `${FILE}: "roots[0]" must be a path, not ""`],
      ['a relative path', '{ "roots": ["/a", "code"] }', `${FILE}: "roots[1]" must be an absolute path or start with ~/, not "code"`],
      ['a ./ path', '{ "roots": [ { "path": "./code" } ] }', `${FILE}: "roots[0].path" must be an absolute path or start with ~/, not "./code"`],
      ['~user', '{ "roots": ["~other/code"] }', `${FILE}: "roots[0]" must be an absolute path or start with ~/, not "~other/code"`],
      ['github not an object', '{ "roots": [ { "path": "/a", "github": "all" } ] }', `${FILE}: "roots[0].github" must be an object, such as { "owners": ["example-co"] }, not "all"`],
      ['owners a bare owner', '{ "roots": [ { "path": "/a", "github": { "owners": "example-co" } } ] }', `${FILE}: "roots[0].github.owners" must be a list of GitHub owners, "all" or "none", not "example-co"`],
      ['owners null', '{ "roots": [ { "path": "/a", "github": { "owners": null } } ] }', `${FILE}: "roots[0].github.owners" must be a list of GitHub owners, "all" or "none", not null`],
      ['owners empty', '{ "roots": [ { "path": "/a", "github": { "owners": [] } } ] }', `${FILE}: "roots[0].github.owners" is empty. Use "none" for this root's own clones only.`],
      ['an owner with a slash', '{ "roots": [ { "path": "/a", "github": { "owners": ["ok", "example/repo"] } } ] }', `${FILE}: "roots[0].github.owners[1]" must be a GitHub user or organization name, such as "example-co", not "example/repo"`],
      ['an owner starting with -', '{ "roots": [ { "path": "/a", "github": { "owners": ["-x"] } } ] }', `${FILE}: "roots[0].github.owners[0]" must be a GitHub user or organization name, such as "example-co", not "-x"`],
      ['an owner that is a number', '{ "roots": [ { "path": "/a", "github": { "owners": [7] } } ] }', `${FILE}: "roots[0].github.owners[0]" must be a GitHub user or organization name, such as "example-co", not the number 7`],
      ['the same root twice', '{ "roots": ["~/work", { "path": "/home/example/work/" }] }', `${FILE}: "roots[1]" is the same directory as "roots[0]" (/home/example/work). List each root once.`],
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

    it('quotes a value with control characters escaped, and cuts a long one short', () => {
      expect(fails('{ "roots": ["rel\\u001b[31m"] }')).toThrow('not "rel\\u001b[31m"');
      const long = 'x'.repeat(500);
      expect(fails(`{ "roots": ["${long}"] }`)).toThrow(/not "x{76}\.\.\."$/);
    });

    it('says where invalid JSON is, as a line and column in the file as written', () => {
      expect(fails('{\n  // a comment\n  "roots": ["/a"] "x"\n}')).toThrow(/line 3 column 19\)$/);
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
    expect(() => loadConfig({ cwd: tmp, env })).toThrow(new ConfigError(`${file} is ${CONFIG_MAX_BYTES + 19} bytes, more than a config file needs (at most ${CONFIG_MAX_BYTES})`));
  });

  it('names the file in a bad value’s message, and returns the warnings', () => {
    const bad = home('{ "roots": ["code"] }');
    expect(() => loadConfig({ cwd: tmp, env: bad.env })).toThrow(`${bad.file}: "roots[0]" must be an absolute path or start with ~/, not "code"`);
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
