// Files named in a session's output (W211): finding them in text and in a link's target, and asking
// pitwall's server to open one in an editor (POST openFilePath(), src/server/editors.ts).
//
// What a session prints is untrusted, so nothing here reads the file system or decides what is safe to
// open: the page only says which text looks like a file, and the server checks the path on the click
// (a missing file answers 404, one outside every root asks first). A reference is a path as it was
// written, absolute, `~/…` or relative to the session's directory, and an optional line and column.
//
// Three sources use it:
// - an OSC 8 link in the terminal, or a markdown link in a message, whose target is `file:///abs/x.ts`
//   or a relative `src/x.ts#L12` (parseFileTarget);
// - text in the terminal's lines, found by the link provider (terminalFileLinks);
// - text and code in a message (findFileRefs).
import type { IBufferRange, ILink, ILinkProvider } from '@xterm/xterm';
import { openFilePath, type EditorId, type OpenFileRequest } from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';

/** A file as a link names it. */
export interface FileRef {
  path: string;
  line?: number;
  column?: number;
}

/** The longest path a reference may have: the server's limit. */
export const MAX_PATH = 1024;
const MAX_POSITION = 1_000_000;

const position = (text: string | undefined): number | undefined => {
  if (text === undefined) return undefined;
  const value = Number(text);
  return Number.isInteger(value) && value >= 1 && value <= MAX_POSITION ? value : undefined;
};

/** Control and bidi characters, which a path can't hold: the server's rule (src/index/guards.ts). */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

/**
 * The file a link's target names, or undefined for anything else: another scheme, a host that isn't
 * this machine, a path with a control character, or one too long.
 *
 * - `file:///abs/a%20b.md` is `/abs/a b.md` (the host may be empty or `localhost`);
 * - a target with no scheme is a relative path, or an absolute or `~/` one;
 * - `#L12`, `#L12C3` and `#L12-L20` give the line, and the column, as Claude Code and editors write them.
 */
export function parseFileTarget(target: string): FileRef | undefined {
  if (target.length > MAX_PATH * 3) return undefined;
  let rest = target;
  let decode = false;
  if (/^file:/i.test(rest)) {
    rest = rest.replace(/^file:/i, '');
    if (!rest.startsWith('//')) return undefined;
    const slash = rest.indexOf('/', 2);
    const host = slash === -1 ? rest.slice(2) : rest.slice(2, slash);
    if (slash === -1 || (host !== '' && host.toLowerCase() !== 'localhost')) return undefined;
    rest = rest.slice(slash);
    decode = true;
  } else if (/^[a-z][a-z0-9+.-]*:(?!\d+(?::\d+)?$)/i.test(rest) || rest.startsWith('//') || rest.startsWith('\\')) {
    // Another scheme (http:, javascript:, vscode:), or a network path: not this route's.
    return undefined;
  }
  let line: number | undefined;
  let column: number | undefined;
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    const fragment = /^#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/.exec(rest.slice(hash));
    if (!fragment) return undefined;
    line = position(fragment[1]);
    column = position(fragment[2]);
    rest = rest.slice(0, hash);
  } else {
    // Not a `file:` target, whose `:` could be part of a name: `src/a.ts:12:3` is the text form.
    const at = !decode ? /^(.*?\.[A-Za-z0-9]+|.*[^/]):(\d+)(?::(\d+))?$/.exec(rest) : undefined;
    if (at) {
      rest = at[1] as string;
      line = position(at[2]);
      column = position(at[3]);
    }
  }
  // The query is cut from the raw target, before decoding once: `a%3Fb.md` is a file named `a?b.md`, not `a`.
  const query = rest.indexOf('?');
  if (decode && query !== -1) rest = rest.slice(0, query);
  if (decode || /%[0-9a-f]{2}/i.test(rest)) {
    try {
      rest = decodeURIComponent(rest);
    } catch {
      return undefined;
    }
  }
  if (rest === '' || rest.length > MAX_PATH || UNSAFE.test(rest)) return undefined;
  // A `file:` link names a file by being one. A relative target is a file only when it's named like one: `[the docs](docs)` isn't.
  if (!decode && !nameLooksLikeFile(rest)) return undefined;
  return { path: rest, ...(line === undefined ? {} : { line }), ...(line === undefined || column === undefined ? {} : { column }) };
}

/** Extensions a bare name, with no directory, needs to be taken for a file: `NOW.md`, not `example.com`. */
const BARE_EXTENSIONS = new Set(
  'md mdx ts tsx js jsx mjs cjs json jsonc yml yaml toml css scss html py go rs java kt rb php sh txt lock sql c h cpp hpp cs swift vue svelte env xml ini cfg conf log csv svg tf proto graphql mts cts'.split(' '),
);
/** Names with no extension that are files. */
const KNOWN_NAMES = new Set(['Makefile', 'Dockerfile', 'LICENSE', 'README', 'CHANGELOG', 'Gemfile', 'Procfile']);

const PATH_TOKEN =
  /^((?:~\/|\.{1,2}\/|\/)?[\w@%+~.-]+(?:\/[\w@%+~.-]+)*)(?::(\d+)(?::(\d+))?(?:-\d+)?)?$/;
/** What may stand straight before a path, and straight after one, as punctuation in a sentence. */
/** A margin for the punctuation round a path, in a token's length. */
const MAX_AFFIX = 16;
const LEADING = /^[([{<'"`*]+/;
const TRAILING = new Set(Array.from('.,;:!?)]}>\'"`*'));

/** `raw` with the sentence's punctuation off its end, by a loop: a regex for it is quadratic on a long run of dots. */
function trimTrailing(raw: string, from: number): number {
  let end = raw.length;
  while (end > from && TRAILING.has(raw[end - 1] as string)) end--;
  return end;
}

/**
 * Whether a path's last name is a file's: it has an extension that starts with a letter (and, with no
 * directory, one from a short list of common ones, so `NOW.md` is a file and `example.com` isn't), or
 * it's a well-known name such as `Makefile`.
 */
export function nameLooksLikeFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (KNOWN_NAMES.has(name)) return true;
  if (name === '.' || name === '..') return false;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  if (!/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(extension)) return false;
  return path.includes('/') || BARE_EXTENSIONS.has(extension.toLowerCase());
}

/** A path-like token's reference, or undefined when it isn't one. */
function pathOf(token: string): FileRef | undefined {
  if (token.length > MAX_PATH + 24 || token.includes('://')) return undefined;
  const match = PATH_TOKEN.exec(token);
  if (!match) return undefined;
  const path = match[1] as string;
  if (path.length > MAX_PATH) return undefined;
  if (!nameLooksLikeFile(path)) return undefined;
  const line = position(match[2]);
  const column = line === undefined ? undefined : position(match[3]);
  return { path, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
}

/** A file reference found in a line of text: where it starts and ends in the text (end exclusive), and what it names. */
export interface FoundRef extends FileRef {
  start: number;
  end: number;
}

/**
 * The file references in `text`: absolute, `~/` and relative paths with a file extension, each with an
 * optional `:line` or `:line:column`, in the order they appear. A token that holds `://` is a URL, not
 * a path. A path stops at a space, so one with spaces is found only as a link's target. The sentence's
 * own punctuation around a path, `(`, `.`, `,` and the like, isn't part of it.
 */
export function findFileRefs(text: string): FoundRef[] {
  const found: FoundRef[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const raw = match[0];
    // A token past the longest path can't be one: skipped before any trimming, so a long run costs nothing.
    if (raw.length > MAX_PATH + 24 + MAX_AFFIX) continue;
    const lead = LEADING.exec(raw)?.[0].length ?? 0;
    // `file.ts:12.` is the sentence's full stop after a position: the trailing punctuation goes first.
    const token = raw.slice(lead, trimTrailing(raw, lead));
    const ref = token === '' ? undefined : pathOf(token);
    if (!ref) continue;
    const start = (match.index as number) + lead;
    found.push({ ...ref, start, end: start + token.length });
  }
  return found;
}

/** Where a request goes, from a reference and the editor. */
export function openFileRequest(ref: FileRef, editor: EditorId, outside = false): OpenFileRequest {
  return { editor, path: ref.path, ...(ref.line === undefined ? {} : { line: ref.line }), ...(ref.column === undefined ? {} : { column: ref.column }), ...(outside ? { outside: true } : {}) };
}

export type OpenFileOutcome =
  | { kind: 'opened' }
  /** The file is outside every root: ask, with its realpath, then send again with `outside`. */
  | { kind: 'outside'; path: string }
  /** The server refused, or the editor didn't open, with why, in the server's words. */
  | { kind: 'refused'; error: string; status?: number }
  | { kind: 'unauthorized' }
  | { kind: 'failed'; status?: number; retryAfter?: number };

/** POSTs openFilePath(). Never rejects. */
export async function openFile(api: ApiClient, sessionId: string, request: OpenFileRequest): Promise<OpenFileOutcome> {
  const result = await api.post(openFilePath(sessionId), request);
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  const body = typeof result.body === 'object' && result.body !== null ? (result.body as Record<string, unknown>) : undefined;
  if (result.kind === 'ok' && body?.ok === true) return { kind: 'opened' };
  if (result.kind === 'failed' && body?.ok === false) {
    if (result.status === 409 && body.outside === true && typeof body.path === 'string' && body.path !== '') return { kind: 'outside', path: body.path };
    if (typeof body.error === 'string' && body.error !== '') return { kind: 'refused', error: body.error, ...(result.status === undefined ? {} : { status: result.status }) };
  }
  const failed: OpenFileOutcome = result.status === undefined ? { kind: 'failed' } : { kind: 'failed', status: result.status };
  return result.kind === 'failed' && result.retryAfter !== undefined ? { ...failed, retryAfter: result.retryAfter } : failed;
}

/** What opening a file link does, from the session view: the terminal's and the conversation's links call it. */
export interface FileLinks {
  /**
   * `shown` is passed only by a link whose visible text isn't the file it opens (isOwnFileTarget; a markdown
   * link's text, an OSC 8 link's cells): it asks first, as an http link does (W55). Every other link passes none.
   */
  open(ref: FileRef, shown?: string): void;
}

/** What a link's text may say to be its own file: the target as written, the path, the path with its position, or the file's name with either. */
export function isOwnFileTarget(shown: string, target: string, ref: FileRef): boolean {
  const text = shown.trim();
  if (text === '') return false;
  const name = ref.path.slice(ref.path.lastIndexOf('/') + 1);
  const positions = ref.line === undefined ? [''] : ['', `:${ref.line}`, ...(ref.column === undefined ? [] : [`:${ref.line}:${ref.column}`])];
  const own = new Set<string>([target, ref.path]);
  // The file's name alone only for a target without `..`, so a link can't name this repo's file and open another's.
  const byName = !target.split(/[\\/]/).includes('..');
  for (const position of positions) {
    own.add(ref.path + position);
    if (byName) own.add(name + position);
  }
  return own.has(text);
}

/**
 * The terminal's link provider: path-like text on a line is a link, as a bare path or one in backticks,
 * which Claude Code colours but doesn't make a hyperlink (spike, 2026-11-24). `getLine(y)` is the
 * text of buffer line `y` (1-based), or undefined. A path that wraps onto the next row isn't found
 * whole, and a wide character before a path shifts its columns: the link is then a cell or two off.
 */
export function terminalFileLinks(getLine: (y: number) => string | undefined, open: (ref: FileRef) => void): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const text = getLine(y);
      if (text === undefined) return callback(undefined);
      const links: ILink[] = findFileRefs(text).map((found) => {
        const range: IBufferRange = { start: { x: found.start + 1, y }, end: { x: found.end, y } };
        const { start: _start, end: _end, ...ref } = found;
        return { range, text: text.slice(found.start, found.end), activate: () => open(ref) };
      });
      callback(links.length === 0 ? undefined : links);
    },
  };
}

const LAST_EDITOR_KEY = 'pitwall.editor';

/** The editor last used, from this browser's storage, or undefined: a private window or blocked storage reads as none. */
export function lastEditor(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): EditorId | undefined {
  try {
    const value = storage?.getItem(LAST_EDITOR_KEY);
    return value === 'vscode' || value === 'cursor' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the editor used last. Storage that throws is ignored. */
export function rememberEditor(editor: EditorId, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try {
    storage?.setItem(LAST_EDITOR_KEY, editor);
  } catch {
    // Not kept: the next link asks again.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The editor a file link opens in: the last used, if it's still found; else the config file's, if
 * found; else the only one found; else undefined, and the page asks.
 */
export function chooseEditor(editors: readonly { id: EditorId }[], last: EditorId | undefined, configured: EditorId | undefined): EditorId | undefined {
  const has = (id: EditorId | undefined) => id !== undefined && editors.some((editor) => editor.id === id);
  if (has(last)) return last;
  if (has(configured)) return configured;
  return editors.length === 1 ? editors[0]?.id : undefined;
}
