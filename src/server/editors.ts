// Open in an editor (W72; Phil, 2026-10-23, option A): a browser can't tell which apps are installed,
// so pitwall's server finds the editors, tells the page which, and opens a listed session's own
// directory in the one chosen.
//
// Both routes come after the /api/* checks in server.ts: Host, Origin and the token or the apiKey,
// and for the POST the apiKey and this server's Origin. Then:
//
//   GET EDITORS_PATH              no query                             answers: EditorList
//     200  the editors found at startup, in KNOWN_EDITORS' order; none is an empty list
//
//   POST openInEditorPath(id)     body: OpenInEditorRequest as JSON    answers: ActionResult
//     200  the editor took it: { ok: true }
//     400  not `Content-Type: application/json`, not JSON, over 1 KiB, anything but { editor } with a
//          known id, or an editor that wasn't found at startup. Then, from resolveSession(): not a safe id
//     404, 503  from resolveSession(): not listed, no snapshot yet
//     409  its directory has gone: `cwdMissing` in the snapshot, or no longer a directory under a root
//          now, through its realpath, as resume checks it
//     429  4 stop, remove, resume and open commands are already running (CommandSlots); or, checked
//          after its directory, just before it runs, DEFAULT_OPEN_RATE's 10 opens in the last
//          minute, since `open -a` returns at once, so the 4 alone don't hold it back (W87).
//          Retry-After is set
//     502  the editor didn't start, or exited non-zero: a short line, never its output. When `open` or the
//          command exits non-zero or has gone, as when the app moved after startup, it says to restart
//          pitwall so it looks again
//     504  it didn't return within 10 seconds. It may still open
//
//   POST openFilePath(id)         body: OpenFileRequest as JSON         answers: OpenFileResult   (W211)
//     200  the editor took it: { ok: true }
//     400  not `Content-Type: application/json`, not JSON, over 4 KiB, anything but { editor, path,
//          line?, column?, outside? } with a known editor id, a `path` of 1 to 1,024 characters with
//          none of UNSAFE_CHARACTERS (a NUL included), a `line` and `column` that are whole numbers from
//          1 to 1,000,000 (a `column` only with a `line`), or an `outside` that isn't a boolean; an
//          editor that wasn't found at startup; a path whose realpath isn't a regular file (a folder,
//          a socket) or ends `.code-workspace`, which loads a workspace's settings and tasks; or
//          a realpath with control characters. Then, from resolveSession(): not a safe id
//     404, 503  from resolveSession(): not listed, no snapshot yet. And "No such file": the path, read
//          against the session's directory, home or as it is, has no realpath
//     409  its directory has gone, as for the folder route; or the file's realpath is under no root
//          and `outside` isn't true: { ok: false, error, outside: true, path: <the realpath> }, which the
//          page asks with, and sends again with `outside: true` only after a yes
//     429  as the folder route's: the same CommandSlots and the same RateWindow, checked after
//          every other check, just before it runs, so a refused or asked-first open doesn't count
//     502, 504  as the folder route's
//
//   The path comes from the page, so from a session's output, which is untrusted. It chooses only which
//   file opens in the editor, and an editor opening a file doesn't run it. Each of these holds:
//   - the editor gets the realpath, absolute, and after `--goto`, so it's never read as an option;
//   - a relative path is read against the session's directory's realpath (checkDirectory), `~/` against
//     the home directory, and anything else must be absolute: the result is realpath'd, and a path
//     that's a symlink out of the roots is judged by where it leads, not where it sits;
//   - the check and the editor's open aren't atomic, as the folder route's aren't (the realpath is
//     checked, then used); what a swap after the check can do is open another file in the editor, never
//     run one. No lstat: the realpath is the thing opened.
//   - a file in the session's directory opens in that folder's window, `<cli> <dir> --goto <file>:<line>:<column>`;
//     any other, `<cli> --goto <file>:<line>:<column>`; the line and column only when given. The CLI is
//     the editor's own command, which opens a file at a line, where `open -a` can't. With none found
//     (on macOS, a bundle without its script), `open -a <bundle> <file>` opens the file with no line.
//
// Detection runs once, as the server starts, and never again:
//
// - On macOS, each editor's app bundle in /Applications, then ~/Applications, and only a real
//   directory: lstat, so a symlink there is never followed. It opens with `/usr/bin/open -a <bundle>`.
//   Its own command, for a file at a line (W211), is the script in the bundle,
//   Contents/Resources/app/bin/<code or cursor>: the first regular, executable file there, or none.
// - On Linux and the other Unixes, its command on PATH as every child gets it (childSearchPath(),
//   W98), in its order: the first regular, executable file, resolved to an absolute path then, and
//   that command is also what opens a file.
//   That's PATH's absolute entries, with a leading `~` expanded to the home directory, so a `code`
//   in `~/.local/bin` is found, or /usr/bin:/bin when none is left. An entry that isn't absolute,
//   such as `.` or an empty one, is skipped, since it would be read against pitwall's own directory.
// - On Windows, none: `code` and `cursor` there are `.cmd` scripts, which need a shell to run.
// - It gives up after 2 seconds, as on a PATH entry on a network mount that hangs, with what it found.
//
// The command is built from those absolute paths and the session's own `cwd` from the snapshot, never
// a path the request names, as separate arguments with no shell, through runFile and the scrubbed
// environment (childEnvironment()), in the temp directory, as stop and remove run. The directory it
// gets is the realpath checkDirectory() checked is under a root, not the snapshot's text, so a symlink
// swapped in after the poll can't send the editor outside the roots. A realpath is absolute, so it can
// never be read as an option.
import { constants } from 'node:fs';
import { access as fsAccess, lstat as fsLstat, realpath as fsRealpath, stat as fsStat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { hasUnsafeCharacters } from '../index/guards.js';
import { isWithin, matchRoot } from '../index/roots.js';
import { childSearchPath, RunError, runFile as defaultRunFile, type RunFile } from '../index/exec.js';
import type { Indexer } from '../index/index.js';
import { EDITORS_PATH, MAX_OPEN_FILE_PATH, MAX_OPEN_FILE_POSITION, openFilePath, openInEditorPath, type ActionResult, type Editor, type EditorId, type EditorList, type OpenFileResult } from '../shared/protocol.js';
import { checkDirectory, CommandSlots, LOOKUP_ERRORS, RateWindow } from './actions.js';
import { childEnvironment } from './command.js';
import { resolveSession } from './sessions.js';

/** The editors pitwall looks for, in the order it lists them. */
export const KNOWN_EDITORS: ReadonlyArray<Editor & { bundle: string; command: string }> = [
  { id: 'vscode', label: 'VS Code', bundle: 'Visual Studio Code.app', command: 'code' },
  { id: 'cursor', label: 'Cursor', bundle: 'Cursor.app', command: 'cursor' },
];

/** What opens an app bundle on macOS. */
export const MAC_OPEN = '/usr/bin/open';

/** How long an editor gets to take the directory: 504 after it. */
export const EDITOR_TIMEOUT_MS = 10_000;
/** How long detection may take at startup. */
export const DETECT_TIMEOUT_MS = 2000;
/** The largest body accepted. `{"editor":"vscode"}` is 19 bytes. */
export const MAX_OPEN_BODY_BYTES = 1024;
/** The largest body the file route accepts: a path of up to 1,024 characters, which JSON may escape or encode as UTF-8. */
export const MAX_OPEN_FILE_BODY_BYTES = 4096;
/** Where an editor's own command is inside its macOS bundle, by the command's name. */
export const BUNDLE_COMMAND_DIR = 'Contents/Resources/app/bin';
/**
 * The most opens in any minute, of any session's directory, in either editor (W87). `open -a` and an
 * editor's command return as soon as the editor has the directory, so the commands' limit of 4 at once
 * (CommandSlots) wouldn't stop one client opening window after window. Ten is more than a person opens
 * in a minute; a client past it waits.
 */
export const DEFAULT_OPEN_RATE = { max: 10, windowMs: 60_000 } as const;

/** An editor found at startup, and what to run to open a directory in it. */
export interface FoundEditor extends Editor {
  /** An absolute path: MAC_OPEN, or the editor's command as found on PATH. */
  file: string;
  /** The arguments before the directory: `-a` and the bundle's path on macOS, none elsewhere. */
  args: readonly string[];
  /** The editor's own command, an absolute path, which opens a file at a line (W211). None when it wasn't found. */
  cli?: string;
}

/** The arguments that open `dir` in `editor`: its own, then the directory, always absolute. */
export function openArgs(editor: FoundEditor, dir: string): string[] {
  return [...editor.args, dir];
}

/** The file system calls detection makes. Tests pass a fake, so they don't depend on this machine. */
export interface DetectionFs {
  /** Doesn't follow a symlink: one is reported as one. */
  lstat(file: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  /** Follows symlinks, as running the file would. */
  stat(file: string): Promise<{ isFile(): boolean }>;
  /** Rejects unless the file has `mode` (constants.X_OK). */
  access(file: string, mode: number): Promise<void>;
}

const nodeFs: DetectionFs = { lstat: fsLstat, stat: fsStat, access: fsAccess };

export interface EditorDetection {
  /** Default process.platform. */
  platform?: NodeJS.Platform;
  /** For ~/Applications on macOS, and what a `~` in PATH stands for elsewhere. Default os.homedir(). */
  home?: string;
  /** PATH, elsewhere. Default process.env.PATH, read once, as detection starts. */
  path?: string | undefined;
  fs?: DetectionFs;
  /** Default DETECT_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** The editors on this machine, in KNOWN_EDITORS' order. Never rejects: anything that fails is not found. */
export async function detectEditors(options: EditorDetection = {}): Promise<FoundEditor[]> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return [];
  const fs = options.fs ?? nodeFs;
  const home = options.home ?? os.homedir();
  const searchPath = 'path' in options ? options.path : process.env.PATH;
  // Where a child would look, `~` as this home directory. With no PATH at all, nowhere.
  const dirs = searchPath === undefined ? [] : childSearchPath(searchPath, home).split(':');
  const found: FoundEditor[] = [];
  const look = async () => {
    for (const editor of KNOWN_EDITORS) {
      const { id, label } = editor;
      if (platform === 'darwin') {
        const bundle = await findBundle(editor.bundle, home, fs);
        if (bundle !== undefined) {
          const cli = await findCommand(editor.command, [path.posix.join(bundle, BUNDLE_COMMAND_DIR)], fs);
          found.push({ id, label, file: MAC_OPEN, args: ['-a', bundle], ...(cli === undefined ? {} : { cli }) });
        }
      } else {
        const command = await findCommand(editor.command, dirs, fs);
        if (command !== undefined) found.push({ id, label, file: command, args: [], cli: command });
      }
    }
  };
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    look().catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, options.timeoutMs ?? DETECT_TIMEOUT_MS);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  // A copy: what a lookup that gave up finds later is never listed.
  return [...found];
}

/** The bundle in /Applications or ~/Applications, when it's a directory there and not a symlink. */
async function findBundle(bundle: string, home: string, fs: DetectionFs): Promise<string | undefined> {
  const dirs = ['/Applications', ...(path.posix.isAbsolute(home) ? [path.posix.join(home, 'Applications')] : [])];
  for (const dir of dirs) {
    const candidate = path.posix.join(dir, bundle);
    try {
      const info = await fs.lstat(candidate);
      if (!info.isSymbolicLink() && info.isDirectory()) return candidate;
    } catch {
      // Not there.
    }
  }
  return undefined;
}

/** The first regular, executable `command` in one of `dirs` that's absolute, as an absolute path. */
async function findCommand(command: string, dirs: readonly string[], fs: DetectionFs): Promise<string | undefined> {
  for (const dir of dirs) {
    if (!path.posix.isAbsolute(dir)) continue;
    const candidate = path.posix.join(dir, command);
    try {
      if (!(await fs.stat(candidate)).isFile()) continue;
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not there, or not executable.
    }
  }
  return undefined;
}

export interface EditorOptions {
  /** The editors, in place of detection. Tests pass these, so nothing depends on this machine. */
  found?: readonly FoundEditor[];
  /** What detection looks at, when `found` isn't given. */
  detection?: EditorDetection;
  /** Default runFile. Tests pass a fake, so no test opens an editor. */
  runFile?: RunFile;
  /** The environment the editor starts from, before childEnvironment() scrubs it. Default process.env, read per call. */
  env?: NodeJS.ProcessEnv;
  /** The server's token. Any variable whose value contains it is left out of the editor's environment. */
  token?: string;
  /** The slots shared with stop, remove and resume (actions.ts). The server passes its own. Default: new ones. */
  slots?: CommandSlots;
  /** Default EDITOR_TIMEOUT_MS. */
  timeoutMs?: number;
  /** The config file's `editor` (W211): served as EditorList's `default`, but only when that editor was found. */
  defaultEditor?: EditorId;
  /** What `~/` stands for in a file's path. Default os.homedir(). */
  home?: string;
  /** Default fs.promises.realpath. Tests pass a fake. */
  realpath?: (file: string) => Promise<string>;
  /** Default fs.promises.stat, of a realpath. Tests pass a fake. */
  stat?: (file: string) => Promise<{ isFile(): boolean }>;
  /** Opens allowed per window, together. Default DEFAULT_OPEN_RATE, 10 a minute. */
  openRate?: { max: number; windowMs: number };
  /** Milliseconds since the epoch, for `openRate`. Default Date.now. */
  now?: () => number;
}

const EDITOR_IDS: ReadonlySet<string> = new Set(KNOWN_EDITORS.map((editor) => editor.id));

/** The editor a body asks for, when it's `{ editor }` with a known id and nothing else. */
export function parseOpenRequest(body: unknown): { ok: true; editor: EditorId } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'The body must be a JSON object.' };
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'editor') return { ok: false, error: 'The body must have "editor" and nothing else.' };
  const { editor } = body as { editor: unknown };
  if (typeof editor !== 'string' || !EDITOR_IDS.has(editor)) return { ok: false, error: "That isn't an editor pitwall knows." };
  return { ok: true, editor: editor as EditorId };
}

export interface OpenFile {
  editor: EditorId;
  path: string;
  line?: number;
  column?: number;
  outside: boolean;
}

const isPosition = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_OPEN_FILE_POSITION;

/** A file request's fields, each checked: strict, so a body with anything else is refused. */
export function parseOpenFileRequest(body: unknown): { ok: true; request: OpenFile } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'The body must be a JSON object.' };
  const fields = body as Record<string, unknown>;
  const allowed = new Set(['editor', 'path', 'line', 'column', 'outside']);
  for (const key of Object.keys(fields)) if (!allowed.has(key)) return { ok: false, error: `The body can't have "${key.slice(0, 20)}".` };
  const { editor, path: given, line, column, outside } = fields;
  if (typeof editor !== 'string' || !EDITOR_IDS.has(editor)) return { ok: false, error: "That isn't an editor pitwall knows." };
  if (typeof given !== 'string' || given === '' || given.length > MAX_OPEN_FILE_PATH) return { ok: false, error: `"path" must be text of 1 to ${MAX_OPEN_FILE_PATH} characters.` };
  if (hasUnsafeCharacters(given)) return { ok: false, error: 'The path contains control characters or bidi controls.' };
  if (line !== undefined && !isPosition(line)) return { ok: false, error: `"line" must be a whole number from 1 to ${MAX_OPEN_FILE_POSITION}.` };
  if (column !== undefined && !isPosition(column)) return { ok: false, error: `"column" must be a whole number from 1 to ${MAX_OPEN_FILE_POSITION}.` };
  if (column !== undefined && line === undefined) return { ok: false, error: '"column" needs a "line".' };
  if (outside !== undefined && typeof outside !== 'boolean') return { ok: false, error: '"outside" must be true or false.' };
  return {
    ok: true,
    request: { editor: editor as EditorId, path: given, outside: outside === true, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) },
  };
}

/**
 * The path a link names, absolute: `~` and `~/…` against `home`, a relative one against `dir` (the
 * session's directory, as a realpath), an absolute one as it is. `~user` isn't expanded, so it's relative.
 */
export function resolveFilePath(given: string, dir: string, home: string): string {
  if (given === '~') return home;
  if (given.startsWith('~/')) return path.join(home, given.slice(2));
  return path.resolve(dir, given);
}

/**
 * The arguments that open the file `real` (a realpath) in `editor`: in the session directory's window
 * when `dir` holds it, on its own otherwise. Without the editor's command, `open -a <bundle> <file>`:
 * the file, but no line. Every path is absolute, so none can be read as an option; the line and column
 * follow only when given, and a file name that ends `:<number>` gets `:1`, so the editor doesn't read
 * it as a line.
 */
export function openFileArgs(editor: FoundEditor, dir: string, real: string, line?: number, column?: number): { file: string; args: string[] } {
  if (editor.cli === undefined) return { file: editor.file, args: [...editor.args, real] };
  const at = line ?? (/:\d+$/.test(real) ? 1 : undefined);
  const spec = at === undefined ? real : `${real}:${at}${column === undefined ? '' : `:${column}`}`;
  return { file: editor.cli, args: [...(isWithin(dir, real) ? [dir] : []), '--goto', spec] };
}

/** Why the editor didn't open, in one short line: never its output. */
function failure(editor: FoundEditor, error: unknown, timeoutMs: number, file: string = editor.file): { status: 502 | 504; error: string } {
  if (error instanceof RunError && error.reason === 'timeout') {
    return { status: 504, error: `${editor.label} didn't answer within ${Math.round(timeoutMs / 1000)} seconds. It may still open.` };
  }
  const reason = error instanceof RunError ? error.reason : 'spawn';
  // `open -a` exits 1 for a bundle that has gone, and a command that has gone isn't found: most likely
  // the app moved, or was removed, after pitwall looked at startup.
  if (reason === 'exit' || reason === 'not-found') {
    return { status: 502, error: `${editor.label} didn't open. If it has moved, restart pitwall so it looks again.` };
  }
  const why = reason === 'signal' ? `${file} was stopped by a signal` : `${file} couldn't be started`;
  return { status: 502, error: `${editor.label} didn't open: ${why}.` };
}

const OPEN_ROUTE = decodeURIComponent(openInEditorPath(':sessionId'));
const OPEN_FILE_ROUTE = decodeURIComponent(openFilePath(':sessionId'));

/**
 * Adds GET EDITORS_PATH and POST openInEditorPath(). Detection starts now, as the server starts. Call
 * it after the /api/* checks and before the /api/* catch-all, as ServerInternals.routes does.
 */
export function registerEditors(app: Hono, indexer: Pick<Indexer, 'latest'>, options: EditorOptions = {}): void {
  const found: Promise<readonly FoundEditor[]> = options.found ? Promise.resolve(options.found) : detectEditors(options.detection);
  const run = options.runFile ?? defaultRunFile;
  const slots = options.slots ?? new CommandSlots();
  const timeoutMs = options.timeoutMs ?? EDITOR_TIMEOUT_MS;
  const openRate = options.openRate ?? DEFAULT_OPEN_RATE;
  const opens = new RateWindow(openRate, options.now ?? Date.now);

  app.get(EDITORS_PATH, async (c) => {
    c.header('Cache-Control', 'no-store');
    const editors = (await found).map(({ id, label }) => ({ id, label }));
    // The config file's choice, only when that editor was found: otherwise it's ignored.
    const list: EditorList = { editors, ...(editors.some((each) => each.id === options.defaultEditor) ? { default: options.defaultEditor as EditorId } : {}) };
    return c.json(list);
  });

  const answer = (c: Context, result: ActionResult, status: 200 | 400 | 404 | 409 | 429 | 502 | 503 | 504) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };
  const reply = (c: Context, result: OpenFileResult, status: 200 | 409) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };
  const refuse = (c: Context, error: string, status: 400 | 404 | 409 | 503) => answer(c, { ok: false, error }, status);

  app.post(
    OPEN_ROUTE,
    bodyLimit({ maxSize: MAX_OPEN_BODY_BYTES, onError: (c) => refuse(c, 'The request is too large.', 400) }),
    async (c) => {
      if (!/^application\/json\s*(;|$)/i.test(c.req.header('content-type') ?? '')) return refuse(c, 'Send the request as application/json.', 400);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return refuse(c, "The body isn't valid JSON.", 400);
      }
      const request = parseOpenRequest(body);
      if (!request.ok) return refuse(c, request.error, 400);
      const editor = (await found).find((each) => each.id === request.editor);
      if (!editor) {
        const label = KNOWN_EDITORS.find((each) => each.id === request.editor)?.label ?? request.editor;
        return refuse(c, `${label} wasn't found on this machine when pitwall started.`, 400);
      }

      const lookup = resolveSession(indexer, c.req.param('sessionId'));
      if (!lookup.ok) return refuse(c, LOOKUP_ERRORS[lookup.status], lookup.status);
      // From the resolved summary, never the request. Any session: an ended one's directory may still be there.
      const { cwd } = lookup.session;
      if (lookup.session.cwdMissing === true) return refuse(c, `Its directory, ${cwd}, no longer exists.`, 409);

      const release = slots.acquire();
      if (!release) {
        c.header('Retry-After', '1');
        return answer(c, { ok: false, error: slots.busyError }, 429);
      }
      try {
        // Afresh, as resume checks it: it may have gone, or been swapped for a symlink, since the poll.
        // checkDirectory() refuses a path that isn't absolute. The editor gets the realpath it checked
        // is under a root, which starts with `/`, so it can't be read as an option.
        const dir = await checkDirectory(cwd, indexer.latest()?.roots ?? []);
        if (!dir.ok) return refuse(c, dir.error, 409);
        // Counted only now, after every check, as resume counts a start (W81): a refused open doesn't count.
        const taken = opens.take();
        if (!taken.ok) {
          c.header('Retry-After', String(taken.retryAfterSeconds));
          const every = Math.round(openRate.windowMs / 1000);
          return answer(c, { ok: false, error: `pitwall opens at most ${openRate.max} ${openRate.max === 1 ? 'directory' : 'directories'} in an editor every ${every} seconds. Try again in ${taken.retryAfterSeconds}s.` }, 429);
        }
        try {
          await run(editor.file, openArgs(editor, dir.path), { cwd: os.tmpdir(), env: childEnvironment(options.env ?? process.env, options.token), timeoutMs });
        } catch (error) {
          const failed = failure(editor, error, timeoutMs);
          return answer(c, { ok: false, error: failed.error }, failed.status);
        }
        return answer(c, { ok: true }, 200);
      } finally {
        release();
      }
    },
  );

  const home = () => options.home ?? os.homedir();
  const realpath = options.realpath ?? fsRealpath;
  const stat = options.stat ?? fsStat;

  app.post(
    OPEN_FILE_ROUTE,
    bodyLimit({ maxSize: MAX_OPEN_FILE_BODY_BYTES, onError: (c) => refuse(c, 'The request is too large.', 400) }),
    async (c) => {
      if (!/^application\/json\s*(;|$)/i.test(c.req.header('content-type') ?? '')) return refuse(c, 'Send the request as application/json.', 400);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return refuse(c, "The body isn't valid JSON.", 400);
      }
      const parsed = parseOpenFileRequest(body);
      if (!parsed.ok) return refuse(c, parsed.error, 400);
      const request = parsed.request;
      const editor = (await found).find((each) => each.id === request.editor);
      if (!editor) {
        const label = KNOWN_EDITORS.find((each) => each.id === request.editor)?.label ?? request.editor;
        return refuse(c, `${label} wasn't found on this machine when pitwall started.`, 400);
      }

      const lookup = resolveSession(indexer, c.req.param('sessionId'));
      if (!lookup.ok) return refuse(c, LOOKUP_ERRORS[lookup.status], lookup.status);
      const { cwd } = lookup.session;
      if (lookup.session.cwdMissing === true) return refuse(c, `Its directory, ${cwd}, no longer exists.`, 409);

      const release = slots.acquire();
      if (!release) {
        c.header('Retry-After', '1');
        return answer(c, { ok: false, error: slots.busyError }, 429);
      }
      try {
        const roots = indexer.latest()?.roots ?? [];
        const dir = await checkDirectory(cwd, roots);
        if (!dir.ok) return refuse(c, dir.error, 409);
        const target = resolveFilePath(request.path, dir.path, home());
        let real: string;
        try {
          real = await realpath(target);
        } catch {
          return refuse(c, 'No such file.', 404);
        }
        // The realpath is what's opened, so what it is is what's checked: absolute, plain, a regular file.
        if (!path.isAbsolute(real) || hasUnsafeCharacters(real)) return refuse(c, "That file's path can't be opened.", 400);
        let isFile = false;
        try {
          isFile = (await stat(real)).isFile();
        } catch {
          return refuse(c, 'No such file.', 404);
        }
        if (!isFile) return refuse(c, "That isn't a file.", 400);
        if (real.toLowerCase().endsWith('.code-workspace')) return refuse(c, "pitwall doesn't open a workspace file: it loads settings and tasks.", 400);
        if (matchRoot(real, roots) === undefined && !request.outside) {
          return reply(c, { ok: false, error: `This file is outside your workspaces: ${real}`, outside: true, path: real }, 409);
        }
        const taken = opens.take();
        if (!taken.ok) {
          c.header('Retry-After', String(taken.retryAfterSeconds));
          const every = Math.round(openRate.windowMs / 1000);
          return answer(c, { ok: false, error: `pitwall opens at most ${openRate.max} ${openRate.max === 1 ? 'directory' : 'directories'} in an editor every ${every} seconds. Try again in ${taken.retryAfterSeconds}s.` }, 429);
        }
        const command = openFileArgs(editor, dir.path, real, request.line, request.column);
        try {
          await run(command.file, command.args, { cwd: os.tmpdir(), env: childEnvironment(options.env ?? process.env, options.token), timeoutMs });
        } catch (error) {
          const failed = failure(editor, error, timeoutMs, command.file);
          return answer(c, { ok: false, error: failed.error }, failed.status);
        }
        return answer(c, { ok: true }, 200);
      } finally {
        release();
      }
    },
  );
}
