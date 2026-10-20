// Spike 004 (W33): which repos under a root each session's tool calls touch.
//
// Read-only. Lists sessions with pitwall's own adapter (`claude agents --json
// --all`, run with its arguments as an array), reads their transcripts and
// sub-agent transcripts under ~/.claude/projects, and runs `git rev-parse` and
// `git remote -v` in directories under the root and in clones outside it. It
// writes nothing. It prints aggregate numbers; `--detail` and `--calls` also
// print session names, titles, prompts, repos and commands, to stdout only.
// Pass the judged repos as an argument rather than from a file, so they never
// touch the disk.
//
// usage: npx tsx docs/spikes/004-repo-grouping.mjs <root> [--detail] [--truth <json>] [--incremental <seconds>] [--calls <id>[:<label>]]
//   --truth        {"<first 8 characters of a session id>": ["<group label>", ...]}: the repos
//                  each session really works in, judged by hand, to score the candidate rules
//   --incremental  wait this long after the full scan, then scan only what was appended
//   --calls        <first 8 of a session id>[:<group label>]: print the calls that touch that
//                  group, or a few calls for every group the session touches
//
// Takes about 40 s on 14 sessions and 720 MiB of transcripts, most of it in
// `git rev-parse`, once per directory: see "by repo boundary" in the output.

import { open, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const src = (p) => new URL(`../../src/index/${p}`, import.meta.url).href;
const { createAgentsSource } = await import(src('agents.ts'));
const { resolveRoots, inspectCwd, matchRoot, isWithin } = await import(src('roots.ts'));
const { createGroupResolver, groupLabel } = await import(src('grouping.ts'));
const { createTranscriptReader, defaultConfigDir, userPromptOf, aiTitleOf } = await import(src('transcripts.ts'));
const { runFile } = await import(src('exec.ts'));

// --- Arguments ---------------------------------------------------------------

const opts = { detail: false, truth: undefined, incremental: 0, root: undefined, calls: undefined };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--detail') opts.detail = true;
    else if (a === '--truth') opts.truth = JSON.parse(argv[++i]);
    else if (a === '--incremental') opts.incremental = Number(argv[++i]);
    else if (a === '--calls') opts.calls = argv[++i];
    else opts.root = a;
  }
  if (opts.root === undefined) {
    console.error('usage: npx tsx docs/spikes/004-repo-grouping.mjs <root> [--detail] [--truth <json>] [--incremental <seconds>] [--calls <id>[:<label>]]');
    process.exit(2);
  }
}

const HOME = os.homedir();
const CLAUDE_DIR = defaultConfigDir();
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const [root] = await resolveRoots([opts.root]);
const resolver = createGroupResolver({ ttlMs: DAY });

// --- Sessions ----------------------------------------------------------------

const listed = await createAgentsSource().list();
if (!listed.ok) throw new Error(listed.error);
const reader = createTranscriptReader();
const sessions = [];
for (const row of listed.rows) {
  const { path: cwd } = await inspectCwd(row.cwd);
  if (matchRoot(cwd, [root]) === undefined) continue;
  await reader.read(row.sessionId, [row.cwd, cwd]);
  const file = reader.transcriptFile(row.sessionId);
  sessions.push({ row, cwd, file, startedInRoot: cwd === root, calls: [], scans: [], title: undefined, firstPrompt: undefined, lastPrompt: undefined });
}

// --- Scanning ----------------------------------------------------------------

const MARK_TOOL = Buffer.from('"type":"tool_use"');
const MARK_TITLE = Buffer.from('"ai-title"');
const MARK_USER = Buffer.from('"type":"user"');

/** Reads `file` from byte `from` to its end, a line at a time, and hands the lines that matter to `sink`. */
async function scan(file, from, sink) {
  const handle = await open(file, 'r');
  const started = performance.now();
  const chunk = Buffer.alloc(4 << 20);
  let offset = from;
  let carry = Buffer.alloc(0);
  let bytes = 0;
  let lines = 0;
  let parsed = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
      if (bytesRead === 0) break;
      const base = offset - carry.length;
      offset += bytesRead;
      bytes += bytesRead;
      const data = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let pos = 0;
      for (let nl = data.indexOf(10, pos); nl !== -1; nl = data.indexOf(10, pos)) {
        const line = data.subarray(pos, nl);
        const lineAt = base + pos;
        pos = nl + 1;
        lines++;
        const tool = line.indexOf(MARK_TOOL) !== -1;
        const title = !tool && line.indexOf(MARK_TITLE) !== -1;
        const user = !tool && !title && sink.wantsUser() && line.indexOf(MARK_USER) !== -1;
        if (!tool && !title && !user) continue;
        let entry;
        try {
          entry = JSON.parse(line.toString('utf8'));
        } catch {
          continue;
        }
        parsed++;
        if (tool) sink.tool(entry, lineAt);
        else if (title) sink.title(entry);
        else sink.user(entry);
      }
      carry = Buffer.from(data.subarray(pos));
    }
  } finally {
    await handle.close();
  }
  return { file, bytes, lines, parsed, ms: performance.now() - started, end: offset - carry.length };
}

function sinkFor(session, sub) {
  return {
    wantsUser: () => !sub,
    tool(entry, lineAt) {
      if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) return;
      const at = Date.parse(entry.timestamp);
      for (const block of entry.message.content) {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
        session.calls.push({ ...extract(block.name, block.input, entry.cwd), at, sub, sidechain: entry.isSidechain === true, lineAt });
      }
    },
    title(entry) {
      const t = aiTitleOf(entry);
      if (t !== undefined) session.title = t;
    },
    user(entry) {
      const prompt = userPromptOf(entry);
      if (prompt === undefined) return;
      session.firstPrompt ??= prompt;
      session.lastPrompt = prompt;
    },
  };
}

/** The main transcript, then every sub-agent transcript beside it. */
async function transcriptFiles(session) {
  if (session.file === undefined) return [];
  const files = [{ file: session.file, sub: false }];
  const dir = path.join(path.dirname(session.file), path.basename(session.file, '.jsonl'), 'subagents');
  try {
    for (const name of (await readdir(dir)).sort()) if (name.endsWith('.jsonl')) files.push({ file: path.join(dir, name), sub: true });
  } catch {
    // No sub-agents.
  }
  return files;
}

// --- Extracting paths from a tool call ----------------------------------------

const FILE_KEYS = {
  Read: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Grep: ['path'],
  Glob: ['path'],
  LSP: ['filePath', 'file_path'],
};
const CHANGE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'Monitor']);
const CHANGE_SHELL = /\bgit\b(?:\s+-[Cc]\s+\S+)*\s+(?:commit|push)\b|\bgh\s+pr\s+(?:create|merge)\b/;
const SIGNALS = ['file', 'cwd', 'dir', 'abs', 'rel', 'gh'];

/** The raw places one tool call names, by signal. Paths are absolute; `rel` ones are checked for existence later. */
function extract(name, input, cwd) {
  const c = { file: [], cwd: [], dir: [], abs: [], rel: [], gh: [], ghChange: [] };
  const call = { tool: name, change: CHANGE_TOOLS.has(name), shellChange: false, c };
  if (opts.calls !== undefined) call.what = describe(name, input);
  const here = typeof cwd === 'string' && path.isAbsolute(cwd) ? cwd : undefined;
  if (here !== undefined) c.cwd.push(here);
  if (input === null || typeof input !== 'object') return call;
  const keys = FILE_KEYS[name];
  if (keys !== undefined) {
    let named = false;
    for (const k of keys) {
      const p = typeof input[k] === 'string' ? resolveWord(input[k], here ?? root) : undefined;
      if (p !== undefined) {
        c.file.push(p);
        named = true;
      }
    }
    if (name === 'Glob' && typeof input.pattern === 'string' && /^[~/]/.test(input.pattern)) {
      const p = resolveWord(input.pattern, here ?? root);
      if (p !== undefined) {
        c.file.push(p);
        named = true;
      }
    }
    if (!named && (name === 'Grep' || name === 'Glob') && here !== undefined) c.file.push(here);
  }
  if (SHELL_TOOLS.has(name) && typeof input.command === 'string') {
    parseShell(input.command, here ?? root, c);
    call.shellChange = CHANGE_SHELL.test(input.command);

  }
  if (name === 'WebFetch' && typeof input.url === 'string') slugsInUrl(input.url, c.gh);
  if (/github/i.test(name) && typeof input.owner === 'string' && typeof input.repo === 'string') {
    c.gh.push(slug(input.owner, input.repo));
  }
  return call;
}

function describe(name, input) {
  if (input === null || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.path ?? (input.owner ? `${input.owner}/${input.repo}` : '');
  return String(v).replace(/\s+/g, ' ').slice(0, 220);
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['sudo', 'time', 'command', 'env', 'nohup', 'exec', 'xargs', 'nice', 'timeout']);
/** Commands whose bare arguments are usually paths, so `ls src` counts. Other relative arguments need a `/`. */
const PATH_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'find', 'rg', 'grep', 'tree', 'du', 'diff', 'less', 'code', 'open', 'stat', 'file']);
/** Flags whose value is prose, such as a commit message, not a path. */
const PROSE_FLAGS = new Set(['-m', '--message', '--body', '-b', '--title', '-t', '--notes', '--description']);
/** An absolute or home-relative path inside a word, after a separator. */
const ABSOLUTE = /(?:^|[\s'"`=:(,])((?:~|\$HOME|\$\{HOME\})?\/[A-Za-z0-9._@+%-][^\s'"`;|&<>(){}*?[\],]*)/g;

function parseShell(command, cwd, c) {
  let here = cwd;
  for (const all of lexShell(stripHeredocs(command))) {
    let i = 0;
    while (i < all.length && (ASSIGNMENT.test(all[i]) || WRAPPERS.has(all[i]))) i++;
    const words = all.slice(i);
    if (words.length === 0) continue;
    const cmd = words[0];
    if (cmd === 'cd' || cmd === 'pushd') {
      const target = words.slice(1).find((w) => !w.startsWith('-'));
      // After `cd $DIR` the directory is unknown, so relative words are skipped until the next absolute `cd`.
      here = target === undefined ? HOME : resolveWord(target, here);
      if (here !== undefined) c.dir.push(here);
      continue;
    }
    if (cmd === 'git') {
      for (let j = 1; j + 1 < words.length; j++) {
        if (words[j] !== '-C') continue;
        const p = resolveWord(words[j + 1], here);
        if (p !== undefined) c.dir.push(p);
      }
      if (words[1] === 'clone' || words[1] === 'remote') for (const w of words) slugsInUrl(w, c.gh);
    }
    if (cmd === 'gh') {
      const before = c.gh.length;
      parseGh(words, c.gh);
      // A PR opened or merged changes the repo this command names.
      if (words[1] === 'pr' && (words[2] === 'create' || words[2] === 'merge')) c.ghChange.push(...c.gh.slice(before));
    }
    const prose = new Set();
    for (let j = 0; j < words.length; j++) if (PROSE_FLAGS.has(words[j])) prose.add(j + 1);
    for (let j = 0; j < words.length; j++) {
      if (prose.has(j)) continue;
      let w = words[j];
      for (const m of w.matchAll(ABSOLUTE)) {
        const p = resolveWord(m[1], here);
        if (p !== undefined) c.abs.push(p);
      }
      if (w.startsWith('-')) {
        const eq = w.indexOf('=');
        if (eq === -1) continue;
        w = w.slice(eq + 1);
      }
      if (w === '' || w.includes('://') || /^[~/$]/.test(w) || /\s/.test(w)) continue;
      const pathy = j === 0 ? w.includes('/') : w.includes('/') || PATH_COMMANDS.has(cmd);
      if (!pathy) continue;
      const p = resolveWord(w, here);
      if (p !== undefined) c.rel.push(p);
    }
  }
}

/** Drops here-document bodies, which are file contents or messages, not commands. */
function stripHeredocs(text) {
  const out = [];
  const pending = [];
  for (const line of text.split('\n')) {
    if (pending.length > 0) {
      if (line.trim() === pending[0]) pending.shift();
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(/(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)) pending.push(m[2]);
  }
  return out.join('\n');
}

/** A rough shell lexer: quotes, escapes, comments, and the operators that start a new command. */
function lexShell(text) {
  const segments = [];
  let words = [];
  let word = null;
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
    const ch = text[i];
    if (ch === "'") {
      const j = text.indexOf("'", i + 1);
      word = (word ?? '') + (j === -1 ? text.slice(i + 1) : text.slice(i + 1, j));
      i = j === -1 ? text.length : j;
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
      const j = text.indexOf('\n', i);
      i = j === -1 ? text.length : j - 1;
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

function parseGh(words, out) {
  for (let j = 1; j < words.length; j++) {
    const w = words[j];
    if ((w === '--repo' || w === '-R') && words[j + 1] !== undefined) slugOf(words[j + 1], out);
    else if (w.startsWith('--repo=')) slugOf(w.slice('--repo='.length), out);
    else {
      const m = /^\/?repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/.exec(w);
      if (m) out.push(slug(m[1], m[2]));
      else slugsInUrl(w, out);
    }
  }
}

function slugOf(s, out) {
  const m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(s);
  if (m) out.push(slug(m[1], m[2]));
}

const NOT_OWNERS = new Set(['orgs', 'settings', 'apps', 'users', 'search', 'notifications', 'marketplace', 'sponsors', 'features', 'topics', 'login']);
const GITHUB_URL =
  /(?:api\.github\.com\/repos\/|raw\.githubusercontent\.com\/|(?<![\w.-])github\.com[/:])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?=[/?#\s"')]|$)/g;

function slugsInUrl(s, out) {
  for (const m of s.matchAll(GITHUB_URL)) if (!NOT_OWNERS.has(m[1].toLowerCase())) out.push(slug(m[1], m[2]));
}

const slug = (owner, name) => `${owner}/${name}`.toLowerCase();

/** A word as an absolute path, with `~` and `$HOME` expanded and line numbers and globs cut. Undefined for anything with an unexpanded variable. */
function resolveWord(word, here) {
  let w = word.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, HOME);
  if (/[$`]/.test(w)) return undefined;
  if (here === undefined && !path.isAbsolute(w)) return undefined;
  const glob = w.search(/[*?[{]/);
  if (glob !== -1) w = w.slice(0, glob);
  w = w.replace(/:\d+(?::\d+)?$/, '').replace(/[.,;:)]+$/, '');
  if (w === '') return undefined;
  return path.resolve(here, w);
}

// --- Mapping paths to groups ---------------------------------------------------

const kinds = new Map();
/** 'dir', 'file' or null, cached per path: most paths repeat many times. */
async function kindOf(p) {
  let k = kinds.get(p);
  if (k === undefined) {
    k = stat(p).then(
      (s) => (s.isDirectory() ? 'dir' : 'file'),
      () => null,
    );
    kinds.set(p, k);
  }
  return k;
}

async function nearestDir(p) {
  for (let at = p; ; at = path.dirname(at)) {
    const k = await kindOf(at);
    if (k === 'dir') return at;
    if (k === 'file') return path.dirname(at);
    if (path.dirname(at) === at) return undefined;
  }
}

const TEMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var'];

function outsideBucket(p) {
  if (isWithin(CLAUDE_DIR, p)) return 'claude';
  if (TEMP_ROOTS.some((t) => isWithin(t, p))) return 'temp';
  if (isWithin(HOME, p)) return 'home';
  return 'system';
}

const cost = { gitResolves: 0, resolveMs: 0, originMs: 0 };
const dirGroups = new Map();
function groupOfDir(dir) {
  let g = dirGroups.get(dir);
  if (g === undefined) {
    g = (async () => {
      let real;
      try {
        real = await realpath(dir);
      } catch {
        real = dir;
      }
      cost.gitResolves++;
      const group = await resolver.resolve(real);
      if (group.kind === 'git') return `repo:${group.key}`;
      if (real === root) return 'root';
      if (isWithin(root, real)) return `dir:${path.join(root, path.relative(root, real).split(path.sep)[0])}`;
      return `out:${outsideBucket(real)}`;
    })();
    dirGroups.set(dir, g);
  }
  return g;
}

const counters = { viaClone: 0, viaOutside: 0, notAPath: 0, relDropped: 0, ghUnmatched: 0, ghAmbiguous: 0 };

const pathGroups = new Map();
/** `lookupPath`, once per path. */
function groupOfPath(p) {
  let g = pathGroups.get(p);
  if (g === undefined) {
    g = lookupPath(p);
    pathGroups.set(p, g);
  }
  return g;
}

/**
 * A path's group: `id` is 'root', 'repo:<key>' (pitwall's git grouping, so worktrees
 * and submodules map as the index maps them), 'dir:<child of root>' for a plain
 * directory, 'missing:<child of root>' when the repo has gone, or 'out:<bucket>'.
 * `id` is undefined for a word that only looks like a path. `via` marks a path
 * outside the root that maps to a repo under it.
 */
async function lookupPath(p) {
  if (!isWithin(root, p)) {
    const bucket = outsideBucket(p);
    if (bucket === 'system') {
      const first = path.join(path.parse(p).root, p.split(path.sep)[1] ?? '');
      if ((await kindOf(first)) === null) return { notAPath: true };
    }
    if (bucket === 'home' || bucket === 'temp') {
      // A worktree outside the root whose main repo is under it still counts,
      // such as one a session made in its scratchpad.
      const dir = await nearestDir(p);
      if (dir !== undefined && dir !== HOME && !isWithin(dir, root) && !TEMP_ROOTS.includes(dir)) {
        const id = await groupOfDir(dir);
        if (id.startsWith('repo:') && isWithin(root, id.slice('repo:'.length))) return { id, via: 'worktree' };
        // A clone outside the root: matched to a repo under it by remote, once the remotes are known.
        if (id.startsWith('repo:')) return { id: `out:${bucket}`, cloneKey: id.slice('repo:'.length) };
      }
    }
    return { id: `out:${bucket}` };
  }
  if (p === root) return { id: 'root' };
  const child = path.join(root, path.relative(root, p).split(path.sep)[0]);
  if ((await kindOf(child)) === null) return { id: `missing:${child}` };
  const dir = await nearestDir(p);
  return { id: dir === undefined ? `missing:${child}` : await groupOfDir(dir) };
}

let origins;
async function buildOrigins(extraKeys) {
  const started = performance.now();
  const keys = new Set(extraKeys);
  for (const name of await readdir(root)) {
    const { id } = await groupOfPath(path.join(root, name));
    if (id?.startsWith('repo:')) keys.add(id.slice('repo:'.length));
  }
  const map = new Map();
  for (const key of keys) {
    let out;
    try {
      out = await runFile('git', ['-C', key, 'remote', '-v'], { timeoutMs: 5000 });
    } catch {
      continue;
    }
    const slugs = [];
    slugsInUrl(out, slugs);
    for (const s of new Set(slugs)) {
      if (!map.has(s)) map.set(s, new Set());
      map.get(s).add(key);
    }
  }
  cost.originMs = performance.now() - started;
  return map;
}

const clones = new Map();
/** The repo under the root that a clone outside it shares a remote with, if exactly one does. */
function cloneGroup(key) {
  let g = clones.get(key);
  if (g === undefined) {
    g = (async () => {
      let out;
      try {
        out = await runFile('git', ['-C', key, 'remote', '-v'], { timeoutMs: 5000 });
      } catch {
        return undefined;
      }
      const slugs = [];
      slugsInUrl(out, slugs);
      for (const s of new Set(slugs)) {
        const keys = [...(origins.get(s) ?? [])].filter((k) => isWithin(root, k));
        if (keys.length > 0) return `repo:${keys.find((k) => path.basename(k).toLowerCase() === s.split('/')[1]) ?? keys.sort()[0]}`;
      }
      return undefined;
    })();
    clones.set(key, g);
  }
  return g;
}

function groupOfSlug(s) {
  const keys = origins.get(s) && new Set([...origins.get(s)].filter((k) => isWithin(root, k)));
  if (keys === undefined || keys.size === 0) {
    counters.ghUnmatched++;
    return undefined;
  }
  if (keys.size === 1) return `repo:${[...keys][0]}`;
  counters.ghAmbiguous++;
  const name = s.split('/')[1];
  const byName = [...keys].find((k) => path.basename(k).toLowerCase() === name);
  return `repo:${byName ?? [...keys].sort()[0]}`;
}

async function resolveCall(call) {
  const g = {};
  for (const sig of ['file', 'cwd', 'dir', 'abs', 'rel']) {
    g[sig] = new Set();
    for (const p of call.c[sig]) {
      if (sig === 'rel' && (await kindOf(p)) === null) {
        counters.relDropped++;
        continue;
      }
      const { id, via, notAPath, cloneKey } = await groupOfPath(p);
      if (notAPath) counters.notAPath++;
      if (via) counters.viaOutside++;
      const clone = cloneKey === undefined ? undefined : await cloneGroup(cloneKey);
      if (clone !== undefined) counters.viaClone++;
      if (clone !== undefined) g[sig].add(clone);
      else if (id !== undefined) g[sig].add(id);
    }
  }
  g.gh = new Set();
  for (const s of call.c.gh) {
    const id = groupOfSlug(s);
    if (id !== undefined) g.gh.add(id);
  }
  call.ghChanged = new Set(call.c.ghChange.map(groupOfSlug).filter((id) => id !== undefined));
  call.g = g;
  delete call.c;
}

const isRepoLike = (id) => id.startsWith('repo:') || id.startsWith('dir:') || id.startsWith('missing:');
/** What a rule may show: a repo or plain directory that still exists. */
const isShowable = (id) => id.startsWith('repo:') || id.startsWith('dir:');

function labelOf(id) {
  if (id === 'root') return groupLabel(root, root, HOME);
  if (id.startsWith('repo:')) return groupLabel(id.slice('repo:'.length), root, HOME);
  if (id.startsWith('dir:')) return `${path.relative(root, id.slice('dir:'.length))} (dir)`;
  if (id.startsWith('missing:')) return `${path.relative(root, id.slice('missing:'.length))} (missing)`;
  return id;
}

// --- Stats and rules -------------------------------------------------------------

const SIGNAL_SETS = {
  file: ['file'],
  'file+cwd': ['file', 'cwd'],
  'file+cwd+gh': ['file', 'cwd', 'gh'],
  'file+cwd+cd+gh': ['file', 'cwd', 'dir', 'gh'],
  'file+cwd+bash': ['file', 'cwd', 'dir', 'abs', 'rel'],
  all: SIGNALS,
};

/** Per repo-like group: calls that touch it, calls that change it, and the newest touch. */
function groupStats(calls, signals) {
  const stats = new Map();
  // Calls under the root: those that touch the root itself or a repo under it, by these signals.
  const under = calls.filter((c) => signals.some((sig) => [...c.g[sig]].some((id) => id === 'root' || isRepoLike(id)))).length;
  for (const call of calls) {
    const ids = new Set();
    for (const sig of signals) for (const id of call.g[sig]) if (isRepoLike(id)) ids.add(id);
    const changed = new Set();
    if (call.change) for (const id of call.g.file) changed.add(id);
    // A commit or push changes the repo it was run in: the last `cd` or `git -C` target, otherwise the shell's cwd.
    if (call.shellChange) for (const id of call.g.dir.size > 0 ? call.g.dir : call.g.cwd) changed.add(id);
    // `gh pr create --repo owner/name` from a clone outside the root changes the repo it names.
    for (const id of call.ghChanged) changed.add(id);
    for (const id of ids) {
      let s = stats.get(id);
      if (s === undefined) stats.set(id, (s = { calls: 0, changes: 0, lastAt: 0, of: calls.length, under }));
      s.calls++;
      if (changed.has(id)) s.changes++;
      if (Number.isFinite(call.at) && call.at > s.lastAt) s.lastAt = call.at;
    }
  }
  return stats;
}

const lastAt = (calls) => calls.reduce((m, c) => (Number.isFinite(c.at) && c.at > m ? c.at : m), 0);
const sinceLast = (calls, ms) => {
  const from = lastAt(calls) - ms;
  return calls.filter((c) => c.at >= from);
};
const WINDOWS = {
  all: (calls) => calls,
  'last 200 calls': (calls) => calls.slice(-200),
  'last 500 calls': (calls) => calls.slice(-500),
  'last 7 days': (calls) => calls.filter((c) => c.at >= NOW - 7 * DAY),
  'last 3 days of its activity': (calls) => sinceLast(calls, 3 * DAY),
  'last 7 days of its activity': (calls) => sinceLast(calls, 7 * DAY),
};

const THRESHOLDS = {
  'any touch': (s) => s.calls >= 1,
  'calls >= 2': (s) => s.calls >= 2,
  'calls >= 3': (s) => s.calls >= 3,
  'calls >= 5': (s) => s.calls >= 5,
  'calls >= 10': (s) => s.calls >= 10,
  'a change': (s) => s.changes >= 1,
  'a change, or calls >= 3': (s) => s.changes >= 1 || s.calls >= 3,
  'a change, or calls >= 5': (s) => s.changes >= 1 || s.calls >= 5,
  'a change, or calls >= 10': (s) => s.changes >= 1 || s.calls >= 10,
  'share >= 5%': (s) => s.calls >= 0.05 * s.of,
  'a change, or share >= 2%': (s) => s.changes >= 1 || s.calls >= 0.02 * s.of,
  'a change, or share >= 5%': (s) => s.changes >= 1 || s.calls >= 0.05 * s.of,
  'a change, or share >= 10%': (s) => s.changes >= 1 || s.calls >= 0.1 * s.of,
  'a change, or calls >= 2 and share >= 2%': (s) => s.changes >= 1 || (s.calls >= 2 && s.calls >= 0.02 * s.of),
  'a change, or share under the root >= 2%': (s) => s.changes >= 1 || s.calls >= 0.02 * s.under,
  'a change, or share under the root >= 5%': (s) => s.changes >= 1 || s.calls >= 0.05 * s.under,
  'a change, or share under the root >= 10%': (s) => s.changes >= 1 || s.calls >= 0.1 * s.under,
};

/** The repos a rule adds beyond the start group, most calls first, at most `cap`. */
function applyRule(session, { signals, window, threshold, cap, includeSub }) {
  const calls = WINDOWS[window](includeSub ? session.calls : session.calls.filter((c) => !c.sub));
  const stats = groupStats(calls, SIGNAL_SETS[signals]);
  return [...stats]
    .filter(([id, s]) => id !== session.start && isShowable(id) && THRESHOLDS[threshold](s))
    .sort((a, b) => b[1].calls - a[1].calls || b[1].lastAt - a[1].lastAt)
    .slice(0, cap)
    .map(([id]) => labelOf(id));
}

function score(rule) {
  let shown = 0;
  let fp = 0;
  let miss = 0;
  let exact = 0;
  const perSession = [];
  for (const session of sessions) {
    const truth = opts.truth?.[session.row.sessionId.slice(0, 8)];
    if (truth === undefined) continue;
    const want = new Set(truth.filter((label) => label !== labelOf(session.start)));
    const got = new Set(applyRule(session, rule));
    const f = [...got].filter((l) => !want.has(l));
    const m = [...want].filter((l) => !got.has(l));
    shown += got.size;
    fp += f.length;
    miss += m.length;
    if (f.length === 0 && m.length === 0) exact++;
    perSession.push({ session, fp: f, miss: m });
  }
  return { shown, fp, miss, exact, perSession };
}

// --- Run ---------------------------------------------------------------------------

const scanStarted = performance.now();
for (const session of sessions) {
  for (const { file, sub } of await transcriptFiles(session)) {
    const result = await scan(file, 0, sinkFor(session, sub));
    session.scans.push({ ...result, sub, size: (await stat(file)).size });
  }
  session.calls.sort((a, b) => (a.at || 0) - (b.at || 0));
}
const scanMs = performance.now() - scanStarted;

const resolveStarted = performance.now();
for (const session of sessions) {
  session.start = (await groupOfPath(session.cwd)).id;
  // Every repo the calls name, so the origin map below covers repos outside the root's first level.
  for (const call of session.calls) for (const sig of ['file', 'cwd', 'dir', 'abs']) for (const p of call.c[sig]) await groupOfPath(p);
}
const discovered = [...dirGroups.values()];
const keys = (await Promise.all(discovered)).filter((id) => id.startsWith('repo:')).map((id) => id.slice('repo:'.length));
origins = await buildOrigins(keys);
for (const session of sessions) for (const call of session.calls) await resolveCall(call);
cost.resolveMs = performance.now() - resolveStarted;

const out = [];
const log = (...parts) => out.push(parts.join(' '));
const pct = (n, d) => (d === 0 ? '-' : `${Math.round((100 * n) / d)}%`);
const kib = (b) => `${(b / 1024).toFixed(0)} KiB`;
const mib = (b) => `${(b / 1024 / 1024).toFixed(1)} MiB`;
const quantiles = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return s.length === 0 ? 'none' : `min ${q(0)} median ${q(0.5)} p90 ${q(0.9)} max ${s[s.length - 1]}`;
};

const readable = sessions.filter((s) => s.file !== undefined);
const fromRoot = readable.filter((s) => s.startedInRoot);
log(`root ${groupLabel(root, root, HOME)} · listed under it: ${sessions.length} · with a readable transcript: ${readable.length} (${fromRoot.length} started in the root itself, ${readable.length - fromRoot.length} inside a repo)`);
const allCalls = readable.flatMap((s) => s.calls);
log(`tool calls: ${allCalls.length} (${allCalls.filter((c) => !c.sub).length} main, ${allCalls.filter((c) => c.sub).length} in sub-agents)`);
const byTool = new Map();
for (const c of allCalls) {
  const k = c.tool.startsWith('mcp__') ? 'mcp__*' : c.tool;
  byTool.set(k, (byTool.get(k) ?? 0) + 1);
}
log('by tool:', [...byTool].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${v}`).join(', '));

// Q1: what each signal finds.
log('\n## Signals (calls that name at least one place, and session-repo pairs found, main and sub-agents)');
const pairsBy = (sigs, filter = () => true) => {
  const pairs = new Set();
  for (const s of readable) for (const c of s.calls) if (filter(c)) for (const sig of sigs) for (const id of c.g[sig]) if (isRepoLike(id)) pairs.add(`${s.row.sessionId}\0${id}`);
  return pairs;
};
for (const sig of SIGNALS) {
  const naming = allCalls.filter((c) => c.g[sig].size > 0).length;
  const inRepo = allCalls.filter((c) => [...c.g[sig]].some(isRepoLike)).length;
  log(`- ${sig}: ${naming} calls name a place, ${inRepo} of them a repo under the root; ${pairsBy([sig]).size} session-repo pairs`);
}
const filePairs = pairsBy(['file']);
const union = pairsBy(SIGNALS);
log(`- file tools alone: ${filePairs.size} pairs; every signal: ${union.size}`);
for (const sig of SIGNALS.filter((s) => s !== 'file')) {
  const extra = [...pairsBy([sig])].filter((p) => !filePairs.has(p)).length;
  const only = [...pairsBy([sig])].filter((p) => !pairsBy(SIGNALS.filter((x) => x !== sig)).has(p)).length;
  log(`  - ${sig} adds ${extra} pairs beyond file tools; ${only} found by ${sig} alone`);
}
for (const [name, sigs] of Object.entries(SIGNAL_SETS)) log(`  - ${name}: ${pairsBy(sigs).size} pairs`);
log(`- gh slugs not matched to a local repo: ${counters.ghUnmatched}; matched to more than one: ${counters.ghAmbiguous}`);
{
  const kinds = { 'dir:': 0, 'missing:': 0 };
  for (const prefix of Object.keys(kinds)) kinds[prefix] = [...union].filter((p) => p.split('\0')[1].startsWith(prefix)).length;
  const missingCalls = allCalls.filter((c) => SIGNALS.some((sig) => [...c.g[sig]].some((id) => id.startsWith('missing:')))).length;
  log(`- pairs with a plain directory under the root: ${kinds['dir:']}; with a repo that no longer exists: ${kinds['missing:']} (${missingCalls} calls)`);
}
log(`- relative shell words dropped because nothing exists there: ${counters.relDropped}; absolute words that aren't paths: ${counters.notAPath}`);
log(`- path references outside the root that map to a repo under it: ${counters.viaOutside} through a worktree, ${counters.viaClone} through a clone with the same remote`);

// Outside the root.
const outside = new Map();
let namingPlaces = 0;
let outsideOnly = 0;
for (const c of allCalls) {
  const ids = new Set(SIGNALS.filter((s) => s !== 'cwd').flatMap((s) => [...c.g[s]]));
  if (ids.size === 0) continue;
  namingPlaces++;
  const outs = [...ids].filter((id) => id.startsWith('out:'));
  for (const id of new Set(outs)) outside.set(id, (outside.get(id) ?? 0) + 1);
  if (outs.length === ids.size) outsideOnly++;
}
log(`\n## Outside the root (calls naming a path, cwd aside: ${namingPlaces})`);
log(`- naming only places outside the root: ${outsideOnly} (${pct(outsideOnly, namingPlaces)})`);
for (const [id, n] of [...outside].sort((a, b) => b[1] - a[1])) log(`- ${id.slice(4)}: ${n} calls`);

// Q2: distribution.
log('\n## Distribution: repos touched per session (start group included when it is a repo)');
const dist = (sigs, threshold, includeSub = true) => {
  const rows = { root: [0, 0, 0, 0], repo: [0, 0, 0, 0] };
  for (const s of readable) {
    const calls = includeSub ? s.calls : s.calls.filter((c) => !c.sub);
    const stats = groupStats(calls, sigs);
    const ids = new Set([...stats].filter(([id, st]) => isShowable(id) && THRESHOLDS[threshold](st)).map(([id]) => id));
    if (isRepoLike(s.start)) ids.add(s.start);
    rows[s.startedInRoot ? 'root' : 'repo'][Math.min(3, ids.size)]++;
  }
  return rows;
};
for (const [name, sigs] of Object.entries(SIGNAL_SETS)) {
  for (const threshold of ['any touch', 'a change, or calls >= 10']) {
    const d = dist(sigs, threshold);
    log(`- ${name}, ${threshold}: started in root [0,1,2,3+] = ${d.root.join(',')}; started in a repo = ${d.repo.join(',')}`);
  }
}

// Q5: sidechains.
log('\n## Sub-agents');
const withSubs = readable.filter((s) => s.scans.some((x) => x.sub));
log(`- sessions with sub-agent transcripts: ${withSubs.length} of ${readable.length}; sub-agent files: ${readable.reduce((n, s) => n + s.scans.filter((x) => x.sub).length, 0)}`);
log(`- sidechain entries inside main transcripts: ${readable.reduce((n, s) => n + s.calls.filter((c) => !c.sub && c.sidechain).length, 0)}`);
for (const [name, sigs] of Object.entries(SIGNAL_SETS)) {
  const mainOnly = pairsBy(sigs, (c) => !c.sub).size;
  log(`- ${name}: ${mainOnly} pairs from main transcripts, ${pairsBy(sigs).size} with sub-agents`);
}
for (const threshold of ['any touch', 'a change, or calls >= 10']) {
  let changed = 0;
  for (const s of readable) {
    const a = applyRule(s, { signals: 'all', window: 'all', threshold, cap: 99, includeSub: false }).sort().join();
    const b = applyRule(s, { signals: 'all', window: 'all', threshold, cap: 99, includeSub: true }).sort().join();
    if (a !== b) changed++;
  }
  log(`- sessions whose repos (all signals, ${threshold}) change when sub-agents are included: ${changed}`);
}

// Q6: cost.
log('\n## Cost');
const mainScans = readable.map((s) => s.scans.find((x) => !x.sub));
const subScans = readable.flatMap((s) => s.scans.filter((x) => x.sub));
log(`- main transcript sizes (MiB): ${quantiles(mainScans.map((x) => +(x.size / 1048576).toFixed(1)))}; total ${mib(mainScans.reduce((n, x) => n + x.size, 0))}`);
log(`- sub-agent transcripts: ${subScans.length} files, total ${mib(subScans.reduce((n, x) => n + x.size, 0))}`);
log(`- full scan, read and parse (ms per main transcript): ${quantiles(mainScans.map((x) => Math.round(x.ms)))}`);
log(`- full scan, every file: ${Math.round(scanMs)} ms for ${mib([...mainScans, ...subScans].reduce((n, x) => n + x.bytes, 0))}; lines parsed ${pct([...mainScans, ...subScans].reduce((n, x) => n + x.parsed, 0), [...mainScans, ...subScans].reduce((n, x) => n + x.lines, 0))}`);
log(`- mapping: ${cost.gitResolves} directories resolved with git, ${Math.round(cost.resolveMs)} ms in all, of which origin remotes ${Math.round(cost.originMs)} ms`);
const tail = (s, pick) => {
  const main = s.scans.find((x) => !x.sub);
  const calls = s.calls.filter((c) => !c.sub);
  const first = pick(calls);
  return first === undefined ? 0 : main.size - first.lineAt;
};
log(`- bytes from the end to cover the last 200 main calls (KiB): ${quantiles(readable.map((s) => Math.round(tail(s, (c) => c[Math.max(0, c.length - 200)]) / 1024)))}`);
log(`- bytes from the end to cover the last 3 days (KiB): ${quantiles(readable.map((s) => Math.round(tail(s, (c) => c.find((x) => x.at >= NOW - 3 * DAY)) / 1024)))}`);
log(`- main calls in the last 256 KiB: ${quantiles(readable.map((s) => { const m = s.scans.find((x) => !x.sub); return s.calls.filter((c) => !c.sub && c.lineAt >= m.size - 256 * 1024).length; }))}`);
log(`- main calls in the last 2 MiB: ${quantiles(readable.map((s) => { const m = s.scans.find((x) => !x.sub); return s.calls.filter((c) => !c.sub && c.lineAt >= m.size - 2 * 1048576).length; }))}`);

// Mapping by repo boundary: walk up to the nearest directory holding `.git` and
// run git only there, instead of once per directory. Checked against the
// per-directory answers above.
{
  const started = performance.now();
  const boundaryResolver = createGroupResolver({ ttlMs: DAY });
  const dotGit = new Map();
  const hasDotGit = (d) => {
    let v = dotGit.get(d);
    if (v === undefined) {
      v = stat(path.join(d, '.git')).then(() => true, () => false);
      dotGit.set(d, v);
    }
    return v;
  };
  const boundaries = new Set();
  let agree = 0;
  let differ = 0;
  for (const [dir, answer] of dirGroups) {
    let top;
    for (let at = dir; ; at = path.dirname(at)) {
      if (await hasDotGit(at)) {
        top = at;
        break;
      }
      if (at === root || path.dirname(at) === at) break;
    }
    let id;
    if (top === undefined) id = dir === root ? 'root' : isWithin(root, dir) ? `dir:${path.join(root, path.relative(root, dir).split(path.sep)[0])}` : `out:${outsideBucket(dir)}`;
    else {
      boundaries.add(top);
      const g = await boundaryResolver.resolve(top);
      id = g.kind === 'git' ? `repo:${g.key}` : 'root';
    }
    if (id === (await answer)) agree++;
    else differ++;
  }
  log(`- by repo boundary instead: ${boundaries.size} boundaries resolved with git, ${dotGit.size} \`.git\` stats, ${Math.round(performance.now() - started)} ms; same group for ${agree} of ${agree + differ} directories`);
}

// Q4: rules.
if (opts.truth !== undefined) {
  log('\n## Rules, scored against the hand-judged repos (repos beyond the start group)');
  const truthPairs = sessions.reduce((n, s) => {
    const t = opts.truth[s.row.sessionId.slice(0, 8)];
    return t === undefined ? n : n + t.filter((l) => l !== labelOf(s.start)).length;
  }, 0);
  log(`- judged sessions: ${sessions.filter((s) => opts.truth[s.row.sessionId.slice(0, 8)] !== undefined).length}; repos to find beyond the start group: ${truthPairs}`);
  const results = [];
  for (const signals of Object.keys(SIGNAL_SETS)) {
    for (const window of Object.keys(WINDOWS)) {
      for (const threshold of Object.keys(THRESHOLDS)) {
        for (const cap of [99, 3]) {
          const rule = { signals, window, threshold, cap, includeSub: true };
          results.push({ rule, ...score(rule) });
        }
      }
    }
  }
  results.sort((a, b) => a.fp + a.miss - (b.fp + b.miss) || a.fp - b.fp);
  const row = (r) => `${r.rule.signals} | ${r.rule.window} | ${r.rule.threshold} | ${r.rule.cap === 99 ? '-' : r.rule.cap} | ${r.shown} | ${r.fp} | ${r.miss} | ${r.exact}`;
  log(`rules compared: ${results.length}; the best 40 by false positives plus misses`);
  log('signals | window | threshold | cap | shown | false positives | misses | sessions exactly right');
  for (const r of results.slice(0, 40)) log(row(r));
  log('\nthe best rule for each signal set, window and threshold:');
  for (const key of ['signals', 'window', 'threshold']) {
    const seen = new Set();
    for (const r of results) if (!seen.has(r.rule[key])) { seen.add(r.rule[key]); log(`- ${key} = ${r.rule[key]}: ${row(r)}`); }
  }
  log('\nthe recommended signals over the whole transcript, no cap, by threshold:');
  for (const r of results) if (r.rule.signals === 'file+cwd+cd+gh' && r.rule.window === 'all' && r.rule.cap === 99) log(`- ${row(r)}`);
  log('\neach signal set over the whole transcript, no cap, at "a change, or share >= 5%" and ">= 2%":');
  for (const r of results) if (r.rule.window === 'all' && r.rule.cap === 99 && (r.rule.threshold === 'a change, or share >= 5%' || r.rule.threshold === 'a change, or share >= 2%')) log(`- ${row(r)}`);
  log('\nany touch, by signal set (whole transcript, no cap):');
  for (const r of results) if (r.rule.threshold === 'any touch' && r.rule.window === 'all' && r.rule.cap === 99) log(`- ${row(r)}`);
  log('\nthe best 5 rules again, without sub-agent transcripts:');
  for (const r of results.slice(0, 5)) log(`- ${row({ rule: { ...r.rule, includeSub: false }, ...score({ ...r.rule, includeSub: false }) })}`);
  if (opts.detail) {
    for (const r of results.slice(0, 3)) {
      log(`\nper session for ${JSON.stringify(r.rule)}`);
      for (const p of r.perSession) if (p.fp.length || p.miss.length) log(`  ${p.session.row.sessionId.slice(0, 8)} ${p.session.row.name}: fp [${p.fp.join(', ')}] miss [${p.miss.join(', ')}]`);
    }
  }
}

// The rule the write-up recommends, in full.
const RECOMMENDED = { signals: 'file+cwd+cd+gh', window: 'all', threshold: 'a change, or share >= 5%', cap: 99, includeSub: true };
{
  log(`\n## The recommended rule: ${JSON.stringify(RECOMMENDED)}`);
  const counts = { root: [0, 0, 0, 0, 0], repo: [0, 0, 0, 0, 0] };
  for (const s of readable) {
    const shown = new Set(applyRule(s, RECOMMENDED));
    if (isRepoLike(s.start)) shown.add(labelOf(s.start));
    counts[s.startedInRoot ? 'root' : 'repo'][Math.min(4, shown.size)]++;
  }
  log(`- repos per session, start group included when it is a repo, [0,1,2,3,4+]: started in root ${counts.root.join(',')}; started in a repo ${counts.repo.join(',')}`);
  for (const variant of [{}, { includeSub: false }, { cap: 3 }, { window: 'last 500 calls' }, { signals: 'all' }, { signals: 'file+cwd+gh' }, { threshold: 'a change, or share under the root >= 5%' }, { threshold: 'a change, or share >= 2%' }, { threshold: 'a change, or share >= 10%' }, { threshold: 'a change' }]) {
    const rule = { ...RECOMMENDED, ...variant };
    const r = score(rule);
    if (opts.truth !== undefined) log(`- ${JSON.stringify(variant)}: shown ${r.shown}, false positives ${r.fp}, misses ${r.miss}, sessions exactly right ${r.exact}`);
  }
  // Numbers only, so the table can go in the write-up.
  if (opts.truth !== undefined) {
    log('session | started in | main calls | sub-agent calls | repos touched | shown by the rule | judged | false positives | misses');
    readable.forEach((s, i) => {
      const t = (opts.truth[s.row.sessionId.slice(0, 8)] ?? []).filter((l) => l !== labelOf(s.start));
      const touched = [...groupStats(s.calls, SIGNALS).keys()].filter((id) => id !== s.start && isShowable(id)).length;
      const got = applyRule(s, RECOMMENDED);
      const main = s.calls.filter((c) => !c.sub).length;
      log(`${i + 1} | ${s.startedInRoot ? 'the root' : 'a repo'} | ${main} | ${s.calls.length - main} | ${touched} | ${got.length} | ${t.length} | ${got.filter((l) => !t.includes(l)).length} | ${t.filter((l) => !got.includes(l)).length}`);
    });
  }
  if (opts.detail) {
    for (const s of readable) {
      const t = opts.truth?.[s.row.sessionId.slice(0, 8)];
      const got = applyRule(s, RECOMMENDED);
      const noSub = applyRule(s, { ...RECOMMENDED, includeSub: false });
      log(`  ${s.row.sessionId.slice(0, 8)} start ${labelOf(s.start)} -> [${got.join(', ')}]${noSub.join() !== got.join() ? ` (without sub-agents [${noSub.join(', ')}])` : ''}${t ? ` · judged [${t.join(', ')}]` : ''}`);
    }
  }
}

// Every session-repo pair with what a rule could use, to see how the judged pairs separate.
if (opts.truth !== undefined && opts.detail) {
  log('\n## Pairs: judged? | calls all signals | changes | share of the session | calls file+cwd+cd+gh | calls in last 500 | days since last touch | session | repo');
  for (const s of sessions) {
    const truth = opts.truth[s.row.sessionId.slice(0, 8)];
    if (truth === undefined) continue;
    const all = groupStats(s.calls, SIGNALS);
    const cheap = groupStats(s.calls, SIGNAL_SETS['file+cwd+cd+gh']);
    const recent = groupStats(WINDOWS['last 500 calls'](s.calls), SIGNALS);
    for (const [id, st] of [...all].sort((a, b) => b[1].calls - a[1].calls)) {
      if (id === s.start || !isShowable(id)) continue;
      const days = ((NOW - st.lastAt) / DAY).toFixed(1);
      log(`${truth.includes(labelOf(id)) ? 'YES' : ' - '} | ${st.calls} | ${st.changes} | ${pct(st.calls, st.of)} | ${cheap.get(id)?.calls ?? 0} | ${recent.get(id)?.calls ?? 0} | ${days} | ${s.row.sessionId.slice(0, 8)} | ${labelOf(id)}`);
    }
  }
}

// Per-session detail, to stdout only.
if (opts.detail) {
  log('\n## Sessions');
  for (const s of sessions) {
    log(`\n== ${s.row.sessionId.slice(0, 8)} ${s.row.name} · ${s.row.kind} ${s.row.status ?? s.row.state ?? ''} · start ${labelOf(s.start ?? 'none')} · transcript ${s.file === undefined ? 'missing' : 'ok'}`);
    if (s.file === undefined) continue;
    log(`   title: ${s.title ?? '-'}`);
    log(`   first prompt: ${(s.firstPrompt ?? '-').replace(/\s+/g, ' ').slice(0, 260)}`);
    log(`   last prompt: ${(s.lastPrompt ?? '-').replace(/\s+/g, ' ').slice(0, 160)}`);
    const main = s.calls.filter((c) => !c.sub);
    log(`   calls: ${main.length} main, ${s.calls.length - main.length} sub · ${new Date(s.calls[0]?.at).toISOString().slice(0, 10)} to ${new Date(s.calls.at(-1)?.at).toISOString().slice(0, 16)}`);
    const per = new Map();
    for (const sig of SIGNALS) {
      for (const [id, st] of groupStats(s.calls, [sig])) {
        if (!per.has(id)) per.set(id, {});
        per.get(id)[sig] = st;
      }
    }
    const allStats = groupStats(s.calls, SIGNALS);
    const subStats = groupStats(s.calls.filter((c) => c.sub), SIGNALS);
    const recent = groupStats(WINDOWS['last 200 calls'](s.calls), SIGNALS);
    log('   repo | all calls (changes) | file cwd dir abs rel gh | in sub-agents | last 200 | last touch');
    for (const [id, st] of [...allStats].sort((a, b) => b[1].calls - a[1].calls)) {
      const p = per.get(id) ?? {};
      log(`   ${labelOf(id)} | ${st.calls} (${st.changes}) | ${SIGNALS.map((sig) => p[sig]?.calls ?? 0).join(' ')} | ${subStats.get(id)?.calls ?? 0} | ${recent.get(id)?.calls ?? 0} | ${new Date(st.lastAt).toISOString().slice(0, 16)}`);
    }
  }
}

if (opts.calls !== undefined) {
  const [id8, label] = opts.calls.split(':');
  const s = sessions.find((x) => x.row.sessionId.startsWith(id8));
  const line = (c, sigs) =>
    `${new Date(c.at).toISOString().slice(0, 16)} ${c.sub ? 'sub ' : 'main'} ${c.tool}${c.change || c.shellChange ? ' CHANGE' : ''} [${sigs.join(',')}] ${c.what}`;
  const labels = label === undefined ? [...groupStats(s?.calls ?? [], SIGNALS).keys()].map(labelOf) : [label];
  for (const l of labels) {
    const hits = [];
    for (const c of s?.calls ?? []) {
      const sigs = SIGNALS.filter((sig) => [...c.g[sig]].some((id) => labelOf(id) === l));
      if (sigs.length > 0) hits.push(line(c, sigs));
    }
    log(`\n## Calls in ${id8} touching ${l}: ${hits.length}`);
    const shown = label === undefined ? [...hits.filter((h) => h.includes(' CHANGE ')).slice(0, 2), ...hits.filter((h) => !h.includes(' CHANGE ')).slice(0, 2)] : hits;
    for (const h of shown) log(label === undefined ? h.slice(0, 200) : h);
  }
}

console.log(out.join('\n'));

// Q6: an incremental scan from the offsets the full scan ended at.
if (opts.incremental > 0) {
  await sleep(opts.incremental * 1000);
  let bytes = 0;
  let ms = 0;
  let files = 0;
  let grown = 0;
  let newCalls = 0;
  for (const s of readable) {
    const before = s.calls.length;
    for (const x of s.scans) {
      files++;
      const t0 = performance.now();
      const size = (await stat(x.file)).size;
      if (size > x.end) {
        grown++;
        const r = await scan(x.file, x.end, sinkFor(s, x.sub));
        bytes += r.bytes;
      }
      ms += performance.now() - t0;
    }
    const known = new Set(s.scans.map((x) => x.file));
    const added = (await transcriptFiles(s)).filter((f) => !known.has(f.file));
    for (const f of added) {
      const t0 = performance.now();
      const r = await scan(f.file, 0, sinkFor(s, true));
      bytes += r.bytes;
      ms += performance.now() - t0;
    }
    newCalls += s.calls.length - before;
  }
  console.log(`\n## Incremental scan after ${opts.incremental} s: ${files} files stat'd, ${grown} had grown, ${kib(bytes)} read, ${newCalls} new calls, ${ms.toFixed(1)} ms in all`);
}
