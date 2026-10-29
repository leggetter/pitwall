// pitwall's config file (W103, D24): the roots, and each root's GitHub owners.
//
// It's <PITWALL_HOME, default ~/.pitwall>/config.json, or the file `--config`
// names. JSON with `//` and `/* */` comments and trailing commas, which
// stripJsonComments() removes in a few lines, so there's no new dependency. A
// flag wins over an environment variable, which wins over the file, which wins
// over the default. Roots given as arguments replace the file's, but each still
// gets its `github` settings when its real path is a configured root's.
//
// Security (D24):
// - It never holds the token. A key named like one, or a GitHub token, anywhere
//   in the file, is an error: PITWALL_TOKEN comes from the environment only,
//   since a token in a file lasts longer and travels further. No message quotes
//   a value from the file, only its key, and a root's real path.
// - It decides which directories pitwall reads and which sessions it lists, so
//   on POSIX it must be the current user's and not writable by group or others.
//   That's checked with fstat on the file once it's open, never stat-then-open,
//   so what's checked is what's read.
// - Nothing in it can weaken PLAN.md's security rules: it has no setting for
//   the host, the token, or the Host and Origin checks.
// - There are no per-repo config files: a file inside a repo could change what
//   pitwall does from code you haven't reviewed.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import os from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { type DirCheckContext, pitwallHome } from './server/launch.js';
import { GITHUB_OWNER_PATTERN, type RootOwners } from './shared/protocol.js';

/** The config file's name in pitwall's folder (PITWALL_HOME, default ~/.pitwall). */
export const CONFIG_FILE_NAME = 'config.json';

/** The biggest config file pitwall reads. A real one is a few hundred bytes. */
export const CONFIG_MAX_BYTES = 1024 * 1024;

/**
 * A problem with the config file. The CLI prints it as it prints a UsageError,
 * with a `pitwall:` prefix, and exits 1. It's a class of its own, not cli.ts's
 * UsageError, only because importing that here would make cli.ts and this
 * module import each other.
 */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Which owners a root claims (RootOwners.owners): a list, 'all' or 'none'. */
export type ConfiguredOwners = RootOwners['owners'];

/** A root from the config file. */
export interface ConfiguredRoot {
  /** Where it is in the file, for messages: `roots[1]`. */
  key: string;
  /** Absolute, with a leading `~` expanded. */
  path: string;
  /**
   * Its real path, as the index resolves roots, with the case on disk (realpathSync.native, as
   * fs.promises.realpath is), or `path` when it can't be resolved.
   */
  real: string;
  /** From `github.owners`: lowercase and deduped. Absent: inferred from the root's clones. */
  owners?: ConfiguredOwners;
}

/** What the config file says, once read and checked. */
export interface LoadedConfig {
  /** The file read, or the default one, when it doesn't exist. */
  file: string;
  /** False when there's no file at the default path: every setting is its default. */
  found: boolean;
  /** Absent when the file has no `roots`, or there's no file. */
  roots?: ConfiguredRoot[];
  /** One line for each unknown key, to print on stderr. */
  warnings: string[];
}

export interface LoadConfigOptions {
  /** From `--config`, as given: resolved against `cwd`, a leading `~` expanded. A missing one is an error. */
  file?: string;
  cwd: string;
  /** For PITWALL_HOME. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** For `~`. Default os.homedir(). */
  home?: string;
  /** The platform and uid the permission check uses. Default this process's. */
  context?: DirCheckContext;
  /** Default realpathSync.native, which, as the index's fs.promises.realpath, gives the case on disk. */
  realpath?: (path: string) => string;
}

/** Where the config file is: `--config`'s, or config.json in pitwall's folder. */
export function configPath(options: Pick<LoadConfigOptions, 'file' | 'cwd' | 'env' | 'home'>): string {
  const home = options.home ?? os.homedir();
  if (options.file !== undefined) return resolve(options.cwd, expandHome(options.file, home));
  return join(pitwallHome(options.env ?? process.env, home), CONFIG_FILE_NAME);
}

/**
 * Reads and checks the config file. A missing default file is fine: every
 * setting is its default. A missing `--config` file, one that isn't safe to
 * read (configFileProblem()), and a bad value are each a ConfigError naming the
 * file. The file is opened, then checked through that open file (fstat), then
 * read, as npm run dev reads its .env. O_NONBLOCK, so a FIFO in its place is
 * refused rather than waited on. A symbolic link is followed, and the file it
 * points to is what's checked.
 */
export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const file = configPath(options);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && options.file === undefined) return { file, found: false, warnings: [] };
    if (code === 'ENOENT') throw new ConfigError(`the config file ${file} does not exist (--config)`);
    throw new ConfigError(`couldn't open the config file ${file} (${(error as Error).message})`);
  }
  let text: string;
  try {
    const stats = fstatSync(fd);
    const problem = configFileProblem(file, stats, options.context);
    if (problem !== undefined) throw new ConfigError(problem);
    // The size first, then while reading, which stops at the cap: a file can grow after fstat,
    // and some, such as Linux's /proc files, say they're empty.
    const bytes = stats.size > CONFIG_MAX_BYTES ? undefined : readCapped(fd, CONFIG_MAX_BYTES);
    if (bytes === undefined) throw new ConfigError(`the config file ${file} is over ${CONFIG_MAX_BYTES} bytes, far more than a config file needs`);
    text = bytes.toString('utf8');
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`couldn't read the config file ${file} (${(error as Error).message})`);
  } finally {
    closeSync(fd);
  }
  return { file, found: true, ...parseConfig(text, file, options) };
}

/** What's in `fd` from where it is, or undefined when it holds more than `max` bytes. Reads at most `max + 1`. */
export function readCapped(fd: number, max: number): Buffer | undefined {
  const buffer = Buffer.alloc(max + 1);
  let total = 0;
  while (total < buffer.length) {
    const read = readSync(fd, buffer, total, buffer.length - total, null);
    if (read === 0) return buffer.subarray(0, total);
    total += read;
  }
  return undefined;
}

/**
 * Why the config file mustn't be read, or undefined when it may. It decides
 * which directories pitwall reads and which sessions it lists, so it must be a
 * file of yours that neither group nor others can change; others may read it,
 * since it holds no secret. `stats` is from the open file (fstat), so what's
 * checked is what's read. Windows has no POSIX owner or mode bits, so there
 * only the file check applies.
 */
export function configFileProblem(file: string, stats: Pick<Stats, 'mode' | 'uid' | 'isFile'>, context: DirCheckContext = {}): string | undefined {
  const platform = context.platform ?? process.platform;
  const uid = 'uid' in context ? context.uid : process.getuid?.();
  if (!stats.isFile()) return `the config file ${file} is not a file. Move it aside, then run pitwall again.`;
  if (platform === 'win32') return undefined;
  if (uid !== undefined && stats.uid !== uid) {
    return `the config file ${file} belongs to another user (uid ${stats.uid}). pitwall reads a config file only when it's yours, since it decides which directories pitwall reads.`;
  }
  const mode = stats.mode & 0o777;
  if ((mode & 0o022) !== 0) {
    return `the config file ${file} can be changed by other users (mode ${mode.toString(8).padStart(3, '0')}), and it decides which directories pitwall reads. Run chmod go-w ${file}, then run pitwall again.`;
  }
  return undefined;
}

/**
 * Checks the config file's text: JSON with comments and trailing commas, an
 * object at the top. Throws ConfigError, naming the key and `file`, for a bad
 * value or a token anywhere; returns a warning for each unknown key, so an
 * older pitwall can read a newer file.
 */
export function parseConfig(
  text: string,
  file: string,
  options: Pick<LoadConfigOptions, 'home' | 'realpath'> = {},
): { roots?: ConfiguredRoot[]; warnings: string[] } {
  const invalid = (at: number) =>
    new ConfigError(`${file} isn't valid JSON${at === -1 ? '' : ` at ${lineAndColumn(text, at)}`}. Comments and trailing commas are allowed.`);
  let stripped: string;
  try {
    stripped = stripJsonComments(text);
  } catch (error) {
    if (error instanceof UnendingComment) throw new ConfigError(`${file}: the /* comment at ${lineAndColumn(text, error.at)} never ends`);
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(stripped);
  } catch {
    // Not V8's own message, which quotes the text around the error, and so perhaps a secret (D24).
    throw invalid(jsonErrorAt(stripped));
  }
  if (!isPlainObject(value)) throw new ConfigError(`${file} must hold a JSON object, such as { "roots": ["~/code"] }`);
  const token = tokenIn(value);
  if (token?.kind === 'named') {
    throw new ConfigError(
      `${file}: the key ${quote(token.key)} is named like a token, and pitwall never reads one from a file: PITWALL_TOKEN comes from the environment only. Remove it from the file.`,
    );
  }
  if (token !== undefined) {
    const where = token.kind === 'value' ? quote(token.key) : token.key === '' ? 'a key at the top level' : `a key in ${quote(token.key)}`;
    throw new ConfigError(
      `${file}: ${where} looks like a GitHub token, and pitwall never reads one from a file: gh keeps GitHub's token, and PITWALL_TOKEN comes from the environment only. Remove it from the file.`,
    );
  }
  const warnings: string[] = [];
  const unknown = (key: string) => warnings.push(`${file}: unknown key ${quote(key)}, ignored. A newer pitwall may use it.`);
  const fail = (key: string, message: string): never => {
    throw new ConfigError(`${file}: ${quote(key)} ${message}`);
  };

  for (const key of Object.keys(value)) if (key !== 'roots') unknown(key);
  if (!Object.hasOwn(value, 'roots')) return { warnings };
  const list = value.roots;
  if (!Array.isArray(list)) return fail('roots', 'must be a list of roots, each a path or { "path": ... }');
  if (list.length === 0) return fail('roots', 'is empty. List at least one root, or leave "roots" out to watch the current directory.');

  const home = options.home ?? os.homedir();
  const realpath = options.realpath ?? realpathSync.native;
  const roots: ConfiguredRoot[] = [];
  // Each real path's key, so a root listed twice is found without searching the list each time.
  const keyOf = new Map<string, string>();
  list.forEach((entry: unknown, i) => {
    const key = `roots[${i}]`;
    let given: unknown;
    let owners: ConfiguredOwners | undefined;
    let pathKey = key;
    if (typeof entry === 'string') {
      given = entry;
    } else if (isPlainObject(entry)) {
      pathKey = `${key}.path`;
      for (const name of Object.keys(entry)) if (name !== 'path' && name !== 'github') unknown(`${key}.${name}`);
      if (!Object.hasOwn(entry, 'path')) fail(pathKey, 'is missing: each root needs a path');
      given = entry.path;
      if (Object.hasOwn(entry, 'github')) owners = parseGithub(entry.github, `${key}.github`, unknown, fail);
    } else {
      fail(key, `must be a path or { "path": ... }, not ${typeOf(entry)}`);
    }
    const path = rootPath(given, pathKey, home, fail);
    const real = realpathOr(path, realpath);
    const same = keyOf.get(real);
    // The real path in full, JSON-quoted: it's a path, not a value from the file as written.
    if (same !== undefined) fail(key, `is the same directory as ${quote(same)}, ${JSON.stringify(real)}. List each root once.`);
    keyOf.set(real, key);
    roots.push({ key, path, real, ...(owners === undefined ? {} : { owners }) });
  });
  checkOwnersOnce(roots, fail);
  return { roots, warnings };
}

/** `github`: an object whose `owners` is a list of GitHub owners, 'all' or 'none'. Absent when it has no `owners`. */
function parseGithub(
  value: unknown,
  key: string,
  unknown: (key: string) => void,
  fail: (key: string, message: string) => never,
): ConfiguredOwners | undefined {
  if (!isPlainObject(value)) return fail(key, `must be an object, such as { "owners": ["example-co"] }, not ${typeOf(value)}`);
  for (const name of Object.keys(value)) if (name !== 'owners') unknown(`${key}.${name}`);
  if (!Object.hasOwn(value, 'owners')) return undefined;
  const owners = value.owners;
  const ownersKey = `${key}.owners`;
  if (owners === 'all' || owners === 'none') return owners;
  if (!Array.isArray(owners)) return fail(ownersKey, `must be a list of GitHub owners, "all" or "none", not ${typeOf(owners)}`);
  if (owners.length === 0) return fail(ownersKey, 'is empty. Use "none" for this root\'s own clones only.');
  const seen = new Set<string>();
  owners.forEach((owner: unknown, i) => {
    const ownerKey = `${ownersKey}[${i}]`;
    if (typeof owner !== 'string') return fail(ownerKey, `must be a GitHub user or organization name, such as "example-co", not ${typeOf(owner)}`);
    // Never quoted: a token pasted here would otherwise be printed, and would pass OWNER.
    if (GITHUB_TOKEN_PREFIX.test(owner)) return fail(ownerKey, 'looks like a GitHub token, not an owner. Remove it from the file.');
    if (!OWNER.test(owner)) {
      return fail(ownerKey, 'must be a GitHub user or organization name: letters, digits, - and _, starting with a letter or digit, at most 100 characters');
    }
    seen.add(owner.toLowerCase());
  });
  return [...seen];
}

/** A listed owner may belong to one root only, and only one root may take 'all'. */
function checkOwnersOnce(roots: readonly ConfiguredRoot[], fail: (key: string, message: string) => never): void {
  const listedBy = new Map<string, string>();
  let all: string | undefined;
  for (const root of roots) {
    const key = `${root.key}.github.owners`;
    if (root.owners === 'all') {
      if (all !== undefined) fail(key, `is "all", and so is ${quote(all)}. Only one root can take the owners no other root lists.`);
      all = key;
    }
    if (!Array.isArray(root.owners)) continue;
    for (const owner of root.owners) {
      const other = listedBy.get(owner);
      if (other !== undefined) fail(key, `lists ${quote(owner)}, and so does ${quote(other)}. An owner can belong to one root only.`);
      listedBy.set(owner, key);
    }
  }
}

/** A root's path: absolute, `~`, or starting with `~/`, made absolute with `~` expanded. */
function rootPath(value: unknown, key: string, home: string, fail: (key: string, message: string) => never): string {
  if (typeof value !== 'string') return fail(key, `must be a path, not ${typeOf(value)}`);
  if (value === '') return fail(key, 'must be a path, not an empty string');
  const expanded = expandHome(value, home);
  if (!isAbsolute(expanded)) return fail(key, 'must be an absolute path, ~, or a path starting with ~/');
  return resolve(expanded);
}

/** `~` alone or a leading `~/` as the home directory. `~user` is left as it is. */
export function expandHome(path: string, home: string = os.homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

function realpathOr(path: string, realpath: (path: string) => string): string {
  try {
    return realpath(path);
  } catch {
    return path;
  }
}

/**
 * Which owners each of `roots` claims from the config file, keyed by its real
 * path, as the index's roots are (IndexSnapshot.roots), for the PR side's
 * `ownersByRoot` (W105). A root is in it only when a configured root with
 * `github.owners` is the same directory, by real path: a root given as an
 * argument keeps its configured settings, and every other root is absent,
 * meaning its owners are inferred from its clones. `roots` are the effective
 * roots, absolute, as the CLI resolved them.
 */
export function ownersByRoot(
  config: Pick<LoadedConfig, 'roots'>,
  roots: readonly string[],
  realpath: (path: string) => string = realpathSync.native,
): Map<string, ConfiguredOwners> {
  const configured = new Map<string, ConfiguredOwners>();
  for (const entry of config.roots ?? []) if (entry.owners !== undefined) configured.set(entry.real, entry.owners);
  const map = new Map<string, ConfiguredOwners>();
  for (const root of roots) {
    const real = realpathOr(resolve(root), realpath);
    const owners = configured.get(real);
    if (owners !== undefined && !map.has(real)) map.set(real, owners);
  }
  return map;
}

/** A `/*` comment that never ends, `at` its offset. */
export class UnendingComment extends Error {
  override name = 'UnendingComment';
  constructor(readonly at: number) {
    super('a /* comment never ends');
  }
}

/**
 * The text with its `//` and `/* *\/` comments, and trailing commas before a
 * `]` or `}`, each replaced by spaces, outside strings only, so JSON.parse
 * reads the rest. Line breaks are kept and nothing moves, so an offset in the
 * result, such as jsonErrorAt()'s, is the same in the file as written. A comma
 * straight after `[`, `{` or another comma is left for JSON.parse to refuse.
 * Throws UnendingComment for a `/*` that never ends.
 */
export function stripJsonComments(text: string): string {
  const out = text.split('');
  // A byte order mark, which JSON.parse refuses.
  if (out[0] === '\uFEFF') out[0] = ' ';
  const blank = (from: number, to: number) => {
    for (let j = from; j < to; j++) if (out[j] !== '\n' && out[j] !== '\r') out[j] = ' ';
  };
  let comma = -1;
  let last = '';
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1;
      last = c;
      comma = -1;
    } else if (c === '/' && text[i + 1] === '/') {
      let j = i + 2;
      while (j < text.length && text[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new UnendingComment(i);
      blank(i, end + 2);
      i = end + 2;
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF') {
      i++;
    } else {
      if ((c === ']' || c === '}') && comma !== -1) out[comma] = ' ';
      comma = c === ',' && last !== '[' && last !== '{' && last !== ',' ? i : -1;
      last = c;
      i++;
    }
  }
  return out.join('');
}

/**
 * The first token found anywhere in `value`, and where:
 *
 * - 'named': a key named like one, `token` or ending in it, ignoring case, `-`, `_` and `.`
 *   (`PITWALL_TOKEN`, `githubToken`, `api-token`); `key` is that key's path.
 * - 'value': a string that holds a GitHub token (GITHUB_TOKEN); `key` is its path.
 * - 'key': a key that is one; `key` is the path of the object it's in, since the key itself
 *   mustn't be printed.
 *
 * Walked without recursion, so a deeply nested file can't overflow the stack.
 */
function tokenIn(value: unknown): { kind: 'named' | 'value' | 'key'; key: string } | undefined {
  const stack: { value: unknown; key: string }[] = [{ value, key: '' }];
  while (stack.length > 0) {
    const { value: node, key } = stack.pop()!;
    if (typeof node === 'string' && GITHUB_TOKEN.test(node)) return { kind: 'value', key };
    if (Array.isArray(node)) {
      node.forEach((item: unknown, i) => stack.push({ value: item, key: `${key}[${i}]` }));
    } else if (isPlainObject(node)) {
      for (const [name, item] of Object.entries(node)) {
        if (GITHUB_TOKEN.test(name)) return { kind: 'key', key };
        const path = key === '' ? name : `${key}.${name}`;
        if (/token$/.test(name.toLowerCase().replace(/[-_.]/g, ''))) return { kind: 'named', key: path };
        stack.push({ value: item, key: path });
      }
    }
  }
  return undefined;
}

/**
 * Where JSON.parse first fails in `text`, as an offset, or -1 when it doesn't.
 * Only for the message, which gives a line and column instead of V8's own,
 * since that quotes the text around the error (D24). Iterative, so deep
 * nesting can't overflow the stack. An error at the end is `text.length`.
 */
export function jsonErrorAt(text: string): number {
  const open: string[] = [];
  let i = 0;
  const space = () => {
    while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r') i++;
  };
  // From the opening quote; true past the closing one.
  const string = (): boolean => {
    for (i++; i < text.length; i++) {
      const c = text[i]!;
      if (c === '"') {
        i++;
        return true;
      }
      if (c < ' ') return false;
      if (c === '\\') {
        const escape = text[i + 1];
        if (escape === 'u' && /^[0-9A-Fa-f]{4}$/.test(text.slice(i + 2, i + 6))) i += 5;
        else if (escape !== undefined && '"\\/bfnrt'.includes(escape)) i++;
        else {
          // At the character after the backslash, as V8 has it.
          i++;
          return false;
        }
      }
    }
    return false;
  };
  let state: 'value' | 'key' | 'after' = 'value';
  for (;;) {
    space();
    if (state === 'value') {
      const c = text[i];
      if (c === '{' || c === '[') {
        i++;
        space();
        if (text[i] === (c === '{' ? '}' : ']')) {
          i++;
          state = 'after';
        } else {
          open.push(c);
          state = c === '{' ? 'key' : 'value';
        }
      } else if (c === '"') {
        if (!string()) return i;
        state = 'after';
      } else if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) {
        NUMBER.lastIndex = i;
        // A lone minus sign's error is after it, as V8 has it.
        if (!NUMBER.test(text)) return c === '-' ? i + 1 : i;
        i = NUMBER.lastIndex;
        state = 'after';
      } else {
        const word = ['true', 'false', 'null'].find((literal) => text.startsWith(literal, i));
        if (word === undefined) return i;
        i += word.length;
        state = 'after';
      }
    } else if (state === 'key') {
      if (text[i] !== '"' || !string()) return i;
      space();
      if (text[i] !== ':') return i;
      i++;
      state = 'value';
    } else {
      const top = open.at(-1);
      if (top === undefined) return i < text.length ? i : -1;
      if (text[i] === ',') {
        i++;
        state = top === '{' ? 'key' : 'value';
      } else if (text[i] === (top === '{' ? '}' : ']')) {
        i++;
        open.pop();
      } else {
        return i;
      }
    }
  }
}

/** `offset` in `text` as "line 3, column 19", both from 1. */
function lineAndColumn(text: string, offset: number): string {
  let line = 1;
  let start = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++;
    start = i + 1;
  }
  return `line ${line}, column ${offset - start + 1}`;
}

/** A JSON number, from where lastIndex says. */
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/**
 * GitHub's token formats (classic, OAuth, user-to-server, server-to-server, refresh and
 * fine-grained), anywhere in a string, from a prefix and at least 20 more characters.
 */
const GITHUB_TOKEN = /(?:^|[^A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/;

/** An owner starting like a GitHub token. No GitHub user or org name has a `_`, and an Enterprise Managed User's ends in its shortcode. */
const GITHUB_TOKEN_PREFIX = /^(?:gh[pousr]_|github_pat_)/i;

const OWNER = new RegExp(`^${GITHUB_OWNER_PATTERN}$`);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A key from the file, for a message: JSON-quoted, so control characters are escaped, and cut
 * short. Never a value from the file (D24).
 */
function quote(value: string): string {
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}..."` : text;
}

/** A value's type, for a message, never its text (D24). */
function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return 'a string';
  if (typeof value === 'number') return 'a number';
  return 'true or false';
}
