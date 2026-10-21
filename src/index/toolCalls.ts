// What one tool call in a transcript names, for the worked-in scanner (workedIn.ts, spike 004): the
// directories it touched, the GitHub repos it named, and which of them it changed. Pure: it reads no
// files and runs nothing, so a path here may not exist. The shell lexer and the GitHub reference
// parsing come from the spike's measurement script (docs/spikes/004-repo-grouping.mjs).
//
// The signals, as the spike recommends:
// - file: the path of a Read, Edit, MultiEdit, Write, NotebookEdit or LSP call, and of Grep and Glob;
// - cwd: the entry's own `cwd`, the shell's working directory at that call;
// - cd: the targets of `cd`, `pushd` and `git -C` in Bash and Monitor commands;
// - gh: GitHub repos named in `gh` commands, `git clone` and `git remote` URLs, WebFetch URLs and
//   the GitHub MCP tools' `owner` and `repo`.
// Other absolute and relative paths in commands are left out: the spike found they add nothing.
//
// Changes: an Edit, MultiEdit, Write or NotebookEdit changes its file's directory; a `git commit` or
// `git push` changes the directory it ran in (its `-C` target, or the shell's directory at that point
// of the command, after any `cd` before it); a `gh pr create` or `gh pr merge` changes the repo it
// names with `--repo`, or else the directory it ran in.

import path from 'node:path';

export interface CallPlaces {
  /** Absolute paths the call touched, each a directory or a file, without duplicates. */
  paths: string[];
  /** The paths it changed: a subset of `paths`. */
  changedPaths: string[];
  /** GitHub repos it named, as lower-case `owner/name`, without duplicates. */
  slugs: string[];
  /** The repos it changed: a subset of `slugs`. */
  changedSlugs: string[];
}

/** File tools and the input keys that hold their path. */
const FILE_KEYS: Readonly<Record<string, readonly string[]>> = {
  Read: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Grep: ['path'],
  Glob: ['path'],
  LSP: ['filePath', 'file_path'],
};
/** File tools whose path is a file, so its directory is what it touched. Grep's and Glob's can be either. */
const FILE_ONLY = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'LSP']);
const CHANGE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'Monitor']);

/** What one `tool_use` block names. `cwd` is the entry's `cwd`; `home` expands `~` and `$HOME`. */
export function placesOf(name: string, input: unknown, cwd: unknown, home: string): CallPlaces {
  const found = new Collector();
  const here = typeof cwd === 'string' && path.isAbsolute(cwd) ? path.resolve(cwd) : undefined;
  if (here !== undefined) found.path(here);
  if (input === null || typeof input !== 'object') return found.done();
  const fields = input as Record<string, unknown>;

  // A search with no path searches the working directory, which `here` already added.
  const keys = FILE_KEYS[name];
  if (keys !== undefined) {
    const change = CHANGE_TOOLS.has(name);
    for (const key of keys) {
      const value = fields[key];
      const resolved = typeof value === 'string' ? resolveWord(value, here, home) : undefined;
      if (resolved !== undefined) found.path(FILE_ONLY.has(name) ? path.dirname(resolved) : resolved, change);
    }
    if (name === 'Glob' && typeof fields.pattern === 'string' && /^[~/$]/.test(fields.pattern)) {
      const resolved = resolveWord(fields.pattern, here, home);
      if (resolved !== undefined) found.path(resolved);
    }
  }

  if (SHELL_TOOLS.has(name) && typeof fields.command === 'string') parseShell(fields.command, here, home, found);
  if (name === 'WebFetch' && typeof fields.url === 'string') for (const slug of slugsIn(fields.url)) found.slug(slug);
  if (/github/i.test(name) && typeof fields.owner === 'string' && typeof fields.repo === 'string') {
    const slug = slugOf(`${fields.owner}/${fields.repo}`);
    if (slug !== undefined) found.slug(slug);
  }
  return found.done();
}

class Collector {
  private readonly paths = new Set<string>();
  private readonly changedPaths = new Set<string>();
  private readonly slugs = new Set<string>();
  private readonly changedSlugs = new Set<string>();

  path(p: string, changed = false): void {
    this.paths.add(p);
    if (changed) this.changedPaths.add(p);
  }

  slug(s: string, changed = false): void {
    this.slugs.add(s);
    if (changed) this.changedSlugs.add(s);
  }

  done(): CallPlaces {
    return { paths: [...this.paths], changedPaths: [...this.changedPaths], slugs: [...this.slugs], changedSlugs: [...this.changedSlugs] };
  }
}

// --- The shell -------------------------------------------------------------------------------------

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['sudo', 'time', 'command', 'env', 'nohup', 'exec', 'xargs', 'nice', 'timeout']);
/** git's options before its subcommand that take a separate value. */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** The directories a command touches and changes, and the GitHub repos it names. */
function parseShell(command: string, cwd: string | undefined, home: string, found: Collector): void {
  // The shell's directory as the command goes: undefined after a `cd` to somewhere it can't tell.
  let here = cwd;
  for (const all of lexShell(stripHeredocs(command))) {
    let start = 0;
    while (start < all.length && (ASSIGNMENT.test(all[start] ?? '') || WRAPPERS.has(all[start] ?? ''))) start++;
    const words = all.slice(start);
    const cmd = words[0];
    if (cmd === undefined) continue;

    if (cmd === 'cd' || cmd === 'pushd') {
      const target = words.slice(1).find((word) => !word.startsWith('-') || word === '-');
      // `cd -` goes back to wherever the shell was before, which isn't known here.
      here = target === undefined ? home : target === '-' ? undefined : resolveWord(target, here, home);
      if (here !== undefined) found.path(here);
      continue;
    }

    if (cmd === 'git') {
      let at = here;
      let subcommand: string | undefined;
      let j = 1;
      for (; j < words.length; j++) {
        const word = words[j] ?? '';
        if (word === '-C') {
          const target = words[j + 1];
          at = target === undefined ? undefined : resolveWord(target, at, home);
          if (at !== undefined) found.path(at);
          j++;
        } else if (GIT_VALUE_OPTIONS.has(word)) {
          j++;
        } else if (!word.startsWith('-')) {
          subcommand = word;
          break;
        }
      }
      if ((subcommand === 'commit' || subcommand === 'push') && at !== undefined) found.path(at, true);
      if (subcommand === 'clone' || subcommand === 'remote') for (const word of words.slice(j + 1)) for (const slug of slugsIn(word)) found.slug(slug);
      continue;
    }

    if (cmd === 'gh') {
      const named = ghSlugs(words);
      const changes = words[1] === 'pr' && (words[2] === 'create' || words[2] === 'merge');
      for (const slug of named.all) found.slug(slug, changes && named.repo.includes(slug));
      // Without --repo, gh works on the repo it runs in.
      if (changes && named.repo.length === 0 && here !== undefined) found.path(here, true);
    }
  }
}

/** Drops here-document bodies, which are file contents or messages, not commands. */
export function stripHeredocs(text: string): string {
  const out: string[] = [];
  const pending: string[] = [];
  for (const line of text.split('\n')) {
    if (pending.length > 0) {
      if (line.trim() === pending[0]) pending.shift();
      continue;
    }
    out.push(line);
    for (const match of line.matchAll(/(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)) pending.push(match[2] ?? '');
  }
  return out.join('\n');
}

/** A rough shell lexer: quotes, escapes, comments, and the operators that start a new command. */
export function lexShell(text: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word: string | null = null;
  const push = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const end = () => {
    push();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      word = (word ?? '') + (close === -1 ? text.slice(i + 1) : text.slice(i + 1, close));
      i = close === -1 ? text.length : close;
    } else if (ch === '"') {
      let s = '';
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) s += text[j] === '\\' && j + 1 < text.length ? text[++j] : text[j];
      word = (word ?? '') + s;
      i = j;
    } else if (ch === '\\') {
      if (text[i + 1] !== '\n') word = (word ?? '') + (text[i + 1] ?? '');
      i++;
    } else if (ch === '#' && word === null) {
      const newline = text.indexOf('\n', i);
      i = newline === -1 ? text.length : newline - 1;
    } else if (ch === ' ' || ch === '\t') {
      push();
    } else if ('\n;&|()`'.includes(ch)) {
      end();
    } else if (ch === '$' && text[i + 1] === '(') {
      end();
      i++;
    } else if (ch === '<' || ch === '>') {
      push();
      while (text[i + 1] === '>' || text[i + 1] === '&') i++;
    } else {
      word = (word ?? '') + ch;
    }
  }
  end();
  return segments;
}

/**
 * A word as an absolute path, with `~` and `$HOME` expanded, and a glob, a `:line` suffix and
 * trailing punctuation cut. Undefined for a word with any other variable or a command
 * substitution, and for a relative word when the directory it's relative to isn't known.
 */
export function resolveWord(word: string, here: string | undefined, home: string): string | undefined {
  let w = word.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  if (/[$`]/.test(w)) return undefined;
  const glob = w.search(/[*?[{]/);
  if (glob !== -1) w = w.slice(0, glob);
  w = w.replace(/:\d+(?::\d+)?$/, '').replace(/[.,;:)]+$/, '');
  if (w === '') return undefined;
  if (path.isAbsolute(w)) return path.resolve(w);
  return here === undefined ? undefined : path.resolve(here, w);
}

// --- GitHub ----------------------------------------------------------------------------------------

/** The repos a `gh` command names: all of them, and those named with `--repo` or `-R`. */
function ghSlugs(words: readonly string[]): { all: string[]; repo: string[] } {
  const all: string[] = [];
  const repo: string[] = [];
  for (let j = 1; j < words.length; j++) {
    const word = words[j] ?? '';
    const option = word === '--repo' || word === '-R' ? words[++j] : word.startsWith('--repo=') ? word.slice('--repo='.length) : undefined;
    if (option !== undefined) {
      const slug = slugOf(option);
      if (slug !== undefined) {
        all.push(slug);
        repo.push(slug);
      }
      continue;
    }
    const api = /^\/?repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/.exec(word);
    if (api) all.push(slug(api[1] ?? '', api[2] ?? ''));
    else all.push(...slugsIn(word));
  }
  return { all, repo };
}

/** `owner/name`, or a github.com URL to it, as a slug. */
export function slugOf(text: string): string | undefined {
  const match = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(text);
  return match ? slug(match[1] ?? '', match[2] ?? '') : undefined;
}

/** github.com paths that aren't an owner. */
const NOT_OWNERS = new Set(['orgs', 'settings', 'apps', 'users', 'search', 'notifications', 'marketplace', 'sponsors', 'features', 'topics', 'login']);
const GITHUB_URL =
  /(?:api\.github\.com\/repos\/|raw\.githubusercontent\.com\/|(?<![\w.-])github\.com[/:])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[/?#\s"')]|$)/g;

/** Every GitHub repo a URL, a remote or any text names, such as `git@github.com:owner/name.git`. */
export function slugsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(GITHUB_URL)) {
    const owner = match[1] ?? '';
    if (!NOT_OWNERS.has(owner.toLowerCase())) found.push(slug(owner, match[2] ?? ''));
  }
  return found;
}

function slug(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}
