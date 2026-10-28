// Attachments for New session's first prompt (W79, spike 008): the upload
// route, where uploads are kept, and their clean-up. Spawn (actions.ts) looks
// them up by id, appends an `@<path>` line for each to the first prompt and
// passes `--add-dir=<folder>` for each.
//
// It's a POST, so the /api/* middleware in server.ts has already required the
// apiKey (never the raw token) and this server's Origin, and the server the
// Host. It's the one route whose body isn't JSON: the file's own bytes, with
// the file's own type, checked here, explicitly, against ATTACHMENT_TYPES.
//
//   POST ATTACHMENTS_PATH          body: the file's bytes               answers: AttachmentResult
//     201  kept: { ok: true, attachment }
//     400  X-Pitwall-Filename is missing, isn't URL-encoded UTF-8, or the name is empty, over 200
//          characters, or has a path separator, control or bidi character; the file is empty; or
//          the upload stopped before the whole file arrived
//     413  over ATTACHMENT_MAX_BYTES: at once by Content-Length, or as soon as the streamed bytes
//          pass it, without reading the rest. Nothing is left behind
//     415  Content-Type isn't one of ATTACHMENT_TYPES, a Content-Encoding is set, or the bytes
//          contradict the type: an image's or a PDF's signature, or, for text and JSON, UTF-8
//          with no NUL
//     429  ATTACHMENTS_MAX_PENDING uploads, those still arriving included, that no spawn has used
//          and that haven't expired. Retry-After is when the oldest expires
//     500  the folder or the file couldn't be written
//     503  this server keeps no attachments (no `pitwallHome`, as in tests), or its folder can't be
//          used safely: a symlink, not a directory, another user's or open to others, or a path an
//          `@` mention can't carry
//
// Where they're kept:
//
//   <pitwall home>/attachments/                0700, a real directory, the user's own, never a symlink
//   <pitwall home>/attachments/<uuid>/         0700, made with mkdir, which fails if it exists
//   <pitwall home>/attachments/<uuid>/<name>   0600, opened with O_CREAT|O_EXCL|O_NOFOLLOW. <name> is a
//                                              slug of the uploaded name, never the name itself
//   <pitwall home>/attachments/<uuid>/.used    empty, written when a spawn uses it: its mtime says when
//
// The server keeps a map from id to stored path, so no path ever comes from
// a request. An upload no spawn used goes an hour after it arrived, and a
// used one 7 days after its spawn, since Claude Code keeps an attachment's
// content in the transcript (spike 008, finding 5). The sweep runs at startup
// and every 10 minutes. It goes by the map for this run's uploads, and by
// each folder's own mtimes for anything else, such as an earlier run's or
// another pitwall's: then `.used` marks a used one. It removes only `<uuid>`
// directories directly in the attachments folder, never follows a symlink,
// and does nothing while the folder, or the pitwall home, isn't a real
// directory.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { Hono } from 'hono';
import { hasUnsafeCharacters } from '../index/guards.js';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  ATTACHMENTS_MAX_PENDING,
  ATTACHMENTS_PATH,
  type AttachmentResult,
  type AttachmentType,
} from '../shared/protocol.js';

/** The header with the file's name, URL-encoded. */
export const FILENAME_HEADER = 'x-pitwall-filename';

/** The longest name kept for display, in UTF-16 code units, as the prompt's limit counts. */
export const ATTACHMENT_NAME_MAX = 200;

/** An upload no spawn used is removed this long after it arrived. */
export const UNUSED_TTL_MS = 60 * 60 * 1000;

/** A used upload is removed this long after the spawn that used it. */
export const USED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** The file that marks a folder as used, for a later run's sweep. A stored name never starts with `.`. */
export const USED_MARKER = '.used';

/** The longest stored name before its extension. */
const STORED_STEM_MAX = 100;

/**
 * The longest stored path. Each `@` line in the first prompt is one, so ten of them stay far below
 * the 16,384 characters the user's own prompt can have, and the command line far below ARG_MAX.
 */
export const STORED_PATH_MAX = 1024;

/** A folder pitwall made: randomUUID()'s form. The sweep touches nothing else. */
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The characters a stored path may have: an `@` mention ends at a space (spike 008), and these read
 * the same in a prompt and on a command line. A pitwall home with anything else can't keep attachments.
 */
const MENTIONABLE_PATH = /^\/[A-Za-z0-9._/-]+$/;

interface TypeRule {
  /** For messages: "a PNG image". */
  label: string;
  /** The extensions a stored name keeps for it; the first is the one it gets otherwise. */
  extensions: readonly string[];
  /** For images and PDF: the first bytes, `undefined` for any byte. Text has none: it must be UTF-8 with no NUL. */
  signatures?: ReadonlyArray<ReadonlyArray<number | undefined>>;
}

const ascii = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

const TYPES: Readonly<Record<AttachmentType, TypeRule>> = {
  'image/png': { label: 'a PNG image', extensions: ['png'], signatures: [[0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a]] },
  'image/jpeg': { label: 'a JPEG image', extensions: ['jpg', 'jpeg'], signatures: [[0xff, 0xd8, 0xff]] },
  'image/gif': { label: 'a GIF image', extensions: ['gif'], signatures: [ascii('GIF87a'), ascii('GIF89a')] },
  'image/webp': {
    label: 'a WebP image',
    extensions: ['webp'],
    signatures: [[...ascii('RIFF'), undefined, undefined, undefined, undefined, ...ascii('WEBP')]],
  },
  'application/pdf': { label: 'a PDF', extensions: ['pdf'], signatures: [ascii('%PDF-')] },
  'text/plain': { label: 'plain text', extensions: ['txt'] },
  'text/markdown': { label: 'Markdown', extensions: ['md', 'markdown'] },
  'text/csv': { label: 'CSV', extensions: ['csv'] },
  'application/json': { label: 'JSON', extensions: ['json'] },
};

/** The most bytes any signature needs. */
const SIGNATURE_BYTES = Math.max(...Object.values(TYPES).flatMap((rule) => (rule.signatures ?? []).map((signature) => signature.length)));

/**
 * Extensions a text attachment's stored name never keeps, because Claude Code would read the file
 * as an image or a PDF by them. It gets its type's own instead.
 */
const NOT_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'ico']);

export const TYPE_ERROR =
  'An attachment can be a PNG, JPEG, GIF or WebP image, a PDF, or a plain text, Markdown, CSV or JSON file.';
export const TOO_LARGE_ERROR = `The file is over ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MiB, the most an attachment can be.`;

/** The type from a Content-Type header, without its parameters, when it's one of ATTACHMENT_TYPES. */
export function attachmentType(header: string | undefined): AttachmentType | undefined {
  const type = header?.split(';')[0]?.trim().toLowerCase();
  return (ATTACHMENT_TYPES as readonly string[]).includes(type ?? '') ? (type as AttachmentType) : undefined;
}

/**
 * The display name from X-Pitwall-Filename: URL-decoded, refused for a control or bidi character
 * (hasUnsafeCharacters()) or a path separator, then NFC-normalized and trimmed, and refused when that
 * leaves it empty or over ATTACHMENT_NAME_MAX. It's only ever shown, never used as a path.
 */
export function attachmentName(header: string | undefined): { ok: true; name: string } | { ok: false; error: string } {
  if (header === undefined || header === '') return { ok: false, error: "Send the file's name, URL-encoded, in X-Pitwall-Filename." };
  // URL-encoded is printable ASCII: anything else arrived as raw bytes, which Node reads as Latin-1.
  if (!/^[\x20-\x7e]+$/.test(header)) return { ok: false, error: "The file's name must be URL-encoded." };
  let name: string;
  try {
    name = decodeURIComponent(header);
  } catch {
    return { ok: false, error: "The file's name isn't URL-encoded UTF-8." };
  }
  // Before trimming, which would drop a line feed or tab at either end rather than refuse it.
  if (hasUnsafeCharacters(name)) return { ok: false, error: "The file's name has a control character or a bidi control." };
  if (/[/\\]/.test(name)) return { ok: false, error: "The file's name can't have a / or a \\." };
  name = name.normalize('NFC').trim();
  if (name === '') return { ok: false, error: "The file's name is empty." };
  if (name.length > ATTACHMENT_NAME_MAX) return { ok: false, error: `The file's name can be at most ${ATTACHMENT_NAME_MAX} characters.` };
  return { ok: true, name };
}

/**
 * The name a file is stored under: letters, digits, `.`, `-` and `_`, never starting with `.` or `-`,
 * then its extension. Accents are dropped and other characters become `-`; a name with none left is
 * `attachment`. The uploaded extension is kept when it fits the type. An image or a PDF gets its
 * type's own otherwise, since Claude Code goes by the extension; text keeps any extension but an
 * image's or a PDF's, and gets its type's own when it has none.
 */
export function storedName(name: string, type: AttachmentType): string {
  const rule = TYPES[type];
  let stem = name;
  let extension = rule.extensions[0] as string;
  const match = /^(.+)\.([^.]+)$/.exec(name);
  if (match) {
    const candidate = (match[2] as string).toLowerCase();
    const fits = /^[a-z0-9]{1,16}$/.test(candidate) && (rule.signatures ? rule.extensions.includes(candidate) : !NOT_TEXT_EXTENSIONS.has(candidate));
    if (fits) {
      stem = match[1] as string;
      extension = candidate;
    }
  }
  return `${slug(stem)}.${extension}`;
}

function slug(stem: string): string {
  const trimEnds = (text: string) => text.replace(/^[.-]+/, '').replace(/[.-]+$/, '');
  const cleaned = trimEnds(
    stem
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/\.{2,}/g, '.'),
  );
  const short = trimEnds(cleaned.slice(0, STORED_STEM_MAX));
  return short === '' ? 'attachment' : short;
}

/**
 * Checks a file's bytes against its declared type as they arrive: an image's or a PDF's signature
 * from its first bytes, and text as UTF-8 with no NUL, all of it. push() and end() return why it
 * isn't that type, or undefined while it is.
 */
export class TypeCheck {
  readonly #rule: TypeRule;
  #head: Buffer = Buffer.alloc(0);
  #signed = false;
  readonly #decoder: TextDecoder | undefined;

  constructor(type: AttachmentType) {
    this.#rule = TYPES[type];
    this.#decoder = this.#rule.signatures ? undefined : new TextDecoder('utf-8', { fatal: true });
  }

  push(chunk: Uint8Array): string | undefined {
    if (this.#decoder) {
      if (chunk.includes(0)) return `It has a NUL character, so it isn't ${this.#rule.label}.`;
      try {
        this.#decoder.decode(chunk, { stream: true });
      } catch {
        return `It isn't UTF-8, so it isn't ${this.#rule.label}.`;
      }
      return undefined;
    }
    if (this.#signed) return undefined;
    this.#head = Buffer.concat([this.#head, chunk]).subarray(0, SIGNATURE_BYTES);
    if (this.#head.length < SIGNATURE_BYTES) return undefined;
    return this.#sign();
  }

  end(): string | undefined {
    if (this.#decoder) {
      try {
        this.#decoder.decode();
      } catch {
        return `It ends partway through a UTF-8 character, so it isn't ${this.#rule.label}.`;
      }
      return undefined;
    }
    return this.#signed ? undefined : this.#sign();
  }

  #sign(): string | undefined {
    this.#signed = true;
    const head = this.#head;
    const matches = (signature: ReadonlyArray<number | undefined>) =>
      head.length >= signature.length && signature.every((byte, index) => byte === undefined || head[index] === byte);
    return this.#rule.signatures?.some(matches) ? undefined : `It was sent as ${this.#rule.label}, but its first bytes aren't one's.`;
  }
}

export interface AttachmentStoreOptions {
  /**
   * pitwall's own folder, `$PITWALL_HOME` or `~/.pitwall` (pitwallHome()), whose `attachments`
   * folder keeps uploads. Undefined: none are kept, uploads get 503, spawn knows no ids, and
   * nothing on disk is read or written.
   */
  home?: string;
  /** Milliseconds since the epoch. Default Date.now. Disk mtimes are compared with it. */
  now?: () => number;
  /** How often the sweep runs after the one at start(). Default 10 minutes. */
  sweepIntervalMs?: number;
  /** The current user's uid, for the owner check. Default process.getuid(); undefined skips it. */
  uid?: number;
}

/** A kept attachment, as spawn passes it on: its stored file and folder, both absolute realpaths. */
export interface AttachmentFile {
  id: string;
  /** The display name, for messages. */
  name: string;
  file: string;
  dir: string;
}

export type AttachmentLookup = { ok: true; files: AttachmentFile[] } | { ok: false; error: string };

/** What an upload came to, for the route. */
export interface UploadOutcome {
  status: 201 | 400 | 413 | 415 | 429 | 500 | 503;
  result: AttachmentResult;
  retryAfterSeconds?: number;
}

interface Kept extends AttachmentFile {
  size: number;
  uploadedAt: number;
  /** When a spawn used it. */
  usedAt?: number;
  /** A spawn that will use it is starting. */
  claimed: boolean;
}

const refused = (status: UploadOutcome['status'], error: string): UploadOutcome => ({ status, result: { ok: false, error } });

export const UNKNOWN_ATTACHMENT_ERROR =
  "One of the attachments isn't one pitwall knows: it may have expired, or pitwall restarted since. Attach it again.";

/** The uploads this server keeps: written by upload(), looked up and marked by spawn, removed by sweep(). */
export class AttachmentStore {
  readonly #home: string | undefined;
  readonly #root: string | undefined;
  readonly #now: () => number;
  readonly #sweepIntervalMs: number;
  readonly #uid: number | undefined;
  readonly #kept = new Map<string, Kept>();
  /** Ids of uploads still arriving: they count as pending, and the sweep leaves their folders alone. */
  readonly #arriving = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #sweeping: Promise<void> | undefined;

  constructor(options: AttachmentStoreOptions = {}) {
    this.#home = options.home === undefined ? undefined : path.resolve(options.home);
    this.#root = this.#home === undefined ? undefined : path.join(this.#home, 'attachments');
    this.#now = options.now ?? Date.now;
    this.#sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.#uid = 'uid' in options ? options.uid : process.getuid?.();
  }

  /** Sweeps now, then every sweepIntervalMs, until close(). */
  start(): void {
    if (this.#root === undefined || this.#timer !== undefined) return;
    void this.sweep();
    this.#timer = setInterval(() => void this.sweep(), this.#sweepIntervalMs);
    this.#timer.unref();
  }

  /** Stops the timer, and waits for a sweep that's running. */
  async close(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#sweeping;
  }

  /** Uploads that count toward ATTACHMENTS_MAX_PENDING: arriving, or kept, unused and unexpired. */
  pending(): number {
    const now = this.#now();
    let count = this.#arriving.size;
    for (const kept of this.#kept.values()) if (kept.usedAt === undefined && !expired(kept, now)) count += 1;
    return count;
  }

  /**
   * Streams `body` into a new folder of its own, at most ATTACHMENT_MAX_BYTES, checking its bytes
   * against `type` as they arrive. `name` is the display name from attachmentName(). Anything that
   * fails removes the folder.
   */
  async upload(body: ReadableStream<Uint8Array> | null, name: string, type: AttachmentType): Promise<UploadOutcome> {
    const root = this.#root;
    if (root === undefined) return refused(503, "This pitwall doesn't keep attachments.");
    // Counted and taken before anything waits, so two uploads can't both take the last place.
    if (this.pending() >= ATTACHMENTS_MAX_PENDING) {
      return {
        ...refused(
          429,
          `pitwall holds at most ${ATTACHMENTS_MAX_PENDING} attachments that no session has used yet. Start a session with some, or wait: an unused one goes after an hour.`,
        ),
        retryAfterSeconds: this.#retryAfterSeconds(),
      };
    }
    const id = randomUUID();
    this.#arriving.add(id);
    try {
      const ready = await this.#ready();
      if (!ready.ok) return refused(503, ready.error);
      const stored = storedName(name, type);
      const realDir = path.join(ready.real, id);
      const realFile = path.join(realDir, stored);
      if (realFile.length > STORED_PATH_MAX || !MENTIONABLE_PATH.test(realFile)) {
        return refused(
          503,
          `pitwall can't keep attachments in ${ready.real}: a session is given each file as an @ mention, which needs a path of letters, digits, ".", "-", "_" and "/" only, at most ${STORED_PATH_MAX} characters. Set PITWALL_HOME to a folder with such a path.`,
        );
      }
      const dir = path.join(root, id);
      try {
        // Not recursive, so it fails if the folder exists.
        await mkdir(dir, { mode: 0o700 });
      } catch (error) {
        return refused(500, `pitwall couldn't make a folder for the attachment: ${(error as Error).message}`);
      }
      const written = await writeBody(body, path.join(dir, stored), type);
      if (!written.ok) {
        await removeFolder(root, id);
        return refused(written.status, written.error);
      }
      this.#kept.set(id, { id, name, file: realFile, dir: realDir, size: written.size, uploadedAt: this.#now(), claimed: false });
      return { status: 201, result: { ok: true, attachment: { id, name, type, size: written.size } } };
    } finally {
      this.#arriving.delete(id);
    }
  }

  /**
   * The files for `ids`, when every one is known, unused, unexpired, not being used by a spawn
   * that's starting, and still a regular file on disk. Spawn checks with it, then claim()s.
   */
  async lookup(ids: readonly string[]): Promise<AttachmentLookup> {
    const found = this.#check(ids);
    if (!found.ok) return found;
    for (const file of found.files) {
      try {
        if (!(await lstat(file.file)).isFile()) throw new Error('not a file');
      } catch {
        return { ok: false, error: `"${file.name}" is no longer where pitwall kept it. Attach it again.` };
      }
    }
    return found;
  }

  /**
   * Takes `ids` for a spawn that's about to run, after checking them again: synchronous, so two
   * spawns can't both take one. Then markUsed() when it started, or release() when it didn't.
   */
  claim(ids: readonly string[]): AttachmentLookup {
    const found = this.#check(ids);
    if (!found.ok) return found;
    for (const id of ids) (this.#kept.get(id) as Kept).claimed = true;
    return found;
  }

  /** Gives back what claim() took, when the spawn didn't start. */
  release(ids: readonly string[]): void {
    for (const id of ids) {
      const kept = this.#kept.get(id);
      if (kept) kept.claimed = false;
    }
  }

  /**
   * Marks `ids` used by a spawn that started: they can't be used again, and go USED_TTL_MS from now.
   * Each folder gets a `.used` file, so a later run's sweep keeps it as long. A marker that can't be
   * written only shortens that, to an hour from the upload.
   */
  async markUsed(ids: readonly string[]): Promise<void> {
    const now = this.#now();
    for (const id of ids) {
      const kept = this.#kept.get(id);
      if (!kept) continue;
      kept.usedAt = now;
      kept.claimed = false;
      try {
        // In the folder's realpath from the upload, never through a symlink made since.
        const marker = await open(path.join(kept.dir, USED_MARKER), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
        await marker.close();
      } catch {
        // Fail soft, as above.
      }
    }
  }

  /** Removes what has expired. Runs one at a time: a call during a sweep waits for it. */
  sweep(): Promise<void> {
    this.#sweeping ??= this.#sweepOnce().finally(() => {
      this.#sweeping = undefined;
    });
    return this.#sweeping;
  }

  async #sweepOnce(): Promise<void> {
    const root = this.#root;
    const home = this.#home;
    if (root === undefined || home === undefined) return;
    const now = this.#now();
    const gone: string[] = [];
    for (const kept of this.#kept.values()) {
      if (!kept.claimed && expired(kept, now)) gone.push(kept.id);
    }
    // Forgotten whatever the disk says, so spawn can't use them.
    for (const id of gone) this.#kept.delete(id);
    // Nothing is removed through a symlink, or from anything but a real directory.
    if ((await realDirectory(home)) !== true || (await realDirectory(root)) !== true) return;
    for (const id of gone) await removeFolder(root, id);

    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // readdir's types are lstat's: a symlink is never a directory here.
      if (!UPLOAD_ID.test(entry.name) || !entry.isDirectory()) continue;
      if (this.#kept.has(entry.name) || this.#arriving.has(entry.name)) continue;
      const age = await folderAge(path.join(root, entry.name));
      if (age === undefined) continue;
      if (now - age.at >= (age.used ? USED_TTL_MS : UNUSED_TTL_MS)) await removeFolder(root, entry.name);
    }
  }

  #check(ids: readonly string[]): AttachmentLookup {
    const now = this.#now();
    const files: AttachmentFile[] = [];
    for (const id of ids) {
      const kept = this.#kept.get(id);
      if (!kept) return { ok: false, error: UNKNOWN_ATTACHMENT_ERROR };
      if (kept.usedAt !== undefined) return { ok: false, error: `"${kept.name}" was already used by another session. Attach it again.` };
      if (expired(kept, now)) return { ok: false, error: `"${kept.name}" went unused for an hour, so pitwall let it go. Attach it again.` };
      if (kept.claimed) return { ok: false, error: `"${kept.name}" is being used by a session that's starting.` };
      files.push({ id: kept.id, name: kept.name, file: kept.file, dir: kept.dir });
    }
    return { ok: true, files };
  }

  /** Seconds until the oldest unused upload expires, at least 1. */
  #retryAfterSeconds(): number {
    const now = this.#now();
    let oldest: number | undefined;
    for (const kept of this.#kept.values()) {
      if (kept.usedAt === undefined && !expired(kept, now)) oldest = Math.min(oldest ?? kept.uploadedAt, kept.uploadedAt);
    }
    return oldest === undefined ? 1 : Math.max(1, Math.ceil((oldest + UNUSED_TTL_MS - now) / 1000));
  }

  /**
   * Makes the pitwall home and its attachments folder at 0700 when they're missing, each without
   * `recursive`, then checks both are real directories, the user's own, closed to others. It never
   * changes an existing one, as the launch folder's check doesn't (launch.ts). `real` is the
   * attachments folder's realpath, for the paths spawn passes on.
   */
  async #ready(): Promise<{ ok: true; real: string } | { ok: false; error: string }> {
    for (const dir of [this.#home as string, this.#root as string]) {
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, error: `pitwall couldn't make ${dir}: ${(error as Error).message}` };
      }
      const state = await realDirectory(dir, this.#uid);
      if (state !== true) return { ok: false, error: state };
    }
    try {
      return { ok: true, real: await realpath(this.#root as string) };
    } catch (error) {
      return { ok: false, error: `pitwall couldn't resolve ${this.#root}: ${(error as Error).message}` };
    }
  }
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function expired(kept: Kept, now: number): boolean {
  return kept.usedAt === undefined ? now - kept.uploadedAt >= UNUSED_TTL_MS : now - kept.usedAt >= USED_TTL_MS;
}

/**
 * True when `dir` is a real directory, not a symlink, and, with a `uid`, that user's own and closed to
 * group and others; otherwise why not. Never follows a symlink.
 */
async function realDirectory(dir: string, uid?: number): Promise<true | string> {
  let stats;
  try {
    stats = await lstat(dir);
  } catch (error) {
    return `pitwall couldn't check ${dir}: ${(error as Error).message}`;
  }
  if (stats.isSymbolicLink()) return `${dir} is a symbolic link. pitwall keeps attachments only in a real directory that you own.`;
  if (!stats.isDirectory()) return `${dir} isn't a directory.`;
  if (uid === undefined || process.platform === 'win32') return true;
  if (stats.uid !== uid) return `${dir} belongs to another user (uid ${stats.uid}). pitwall keeps attachments only in a directory that you own.`;
  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return `${dir} can be read or entered by other users (mode ${mode.toString(8).padStart(3, '0')}). Run chmod 700 ${dir}, then try again.`;
  }
  return true;
}

/** Removes `<root>/<id>` when `id` is an upload's and it's a real directory. rm() unlinks a symlink inside without following it. */
async function removeFolder(root: string, id: string): Promise<void> {
  if (!UPLOAD_ID.test(id)) return;
  const dir = path.join(root, id);
  try {
    if (!(await lstat(dir)).isDirectory()) return;
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Gone already, or the next sweep tries again.
  }
}

/**
 * When an upload's folder was last touched, by lstat: `.used`'s mtime for a used one, otherwise
 * the newest of the folder's and its entries'. Undefined when it can't be read.
 */
async function folderAge(dir: string): Promise<{ used: boolean; at: number } | undefined> {
  try {
    try {
      return { used: true, at: (await lstat(path.join(dir, USED_MARKER))).mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    let at = (await lstat(dir)).mtimeMs;
    for (const name of await readdir(dir)) at = Math.max(at, (await lstat(path.join(dir, name))).mtimeMs);
    return { used: false, at };
  } catch {
    return undefined;
  }
}

type Written = { ok: true; size: number } | { ok: false; status: 400 | 413 | 415 | 500; error: string };

/** Streams `body` into a new file at `file`, at most ATTACHMENT_MAX_BYTES, checking it against `type`. */
async function writeBody(body: ReadableStream<Uint8Array> | null, file: string, type: AttachmentType): Promise<Written> {
  const fail = (status: 400 | 413 | 415 | 500, error: string): Written => ({ ok: false, status, error });
  let handle: FileHandle;
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  } catch (error) {
    return fail(500, `pitwall couldn't create the attachment's file: ${(error as Error).message}`);
  }
  const check = new TypeCheck(type);
  const reader = body?.getReader();
  let size = 0;
  try {
    for (;;) {
      if (!reader) break;
      const next = await reader.read().catch(() => undefined);
      if (next === undefined) return fail(400, 'The upload stopped before the whole file arrived.');
      if (next.done) break;
      const chunk = next.value;
      size += chunk.byteLength;
      // Before writing it: the rest is never read, and the folder goes.
      if (size > ATTACHMENT_MAX_BYTES) return fail(413, TOO_LARGE_ERROR);
      const wrong = check.push(chunk);
      if (wrong !== undefined) return fail(415, wrong);
      try {
        let offset = 0;
        while (offset < chunk.byteLength) offset += (await handle.write(chunk, offset, chunk.byteLength - offset)).bytesWritten;
      } catch (error) {
        return fail(500, `pitwall couldn't write the attachment: ${(error as Error).message}`);
      }
    }
    if (size === 0) return fail(400, 'The file is empty.');
    const wrong = check.end();
    if (wrong !== undefined) return fail(415, wrong);
    return { ok: true, size };
  } finally {
    // Stops reading a body that's refused partway; the server drains or closes the connection.
    reader?.cancel().catch(() => {});
    await handle.close().catch(() => {});
  }
}

/** Adds ATTACHMENTS_PATH. Call it after the /api/* checks and before the /api/* catch-all, as server.ts does. */
export function registerAttachments(app: Hono, store: AttachmentStore): void {
  app.post(ATTACHMENTS_PATH, async (c) => {
    c.header('Cache-Control', 'no-store');
    const answer = (outcome: UploadOutcome) => {
      if (outcome.retryAfterSeconds !== undefined) c.header('Retry-After', String(outcome.retryAfterSeconds));
      return c.json(outcome.result, outcome.status);
    };
    // The file's own type, never JSON: this route alone takes a body that isn't.
    const type = attachmentType(c.req.header('content-type'));
    if (type === undefined) return answer(refused(415, TYPE_ERROR));
    const encoding = c.req.header('content-encoding');
    if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
      return answer(refused(415, 'Send the file as it is, without a Content-Encoding.'));
    }
    const name = attachmentName(c.req.header(FILENAME_HEADER));
    if (!name.ok) return answer(refused(400, name.error));
    // Node's parser has checked it's a number, and stops the body there.
    const length = c.req.header('content-length');
    if (length !== undefined && Number(length) > ATTACHMENT_MAX_BYTES) return answer(refused(413, TOO_LARGE_ERROR));
    return answer(await store.upload(c.req.raw.body, name.name, type));
  });
}
