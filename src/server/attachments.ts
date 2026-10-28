// Attachments for New session's first prompt (W79, spike 008): the upload
// route, where uploads are kept, and their clean-up. Spawn (actions.ts) looks
// them up by id, appends an `@<path>` line for each to the first prompt and
// passes `--add-dir=<folder>` for each.
//
// Both routes change state, so the /api/* middleware in server.ts has already
// required the apiKey (never the raw token) and this server's Origin, and the
// server the Host. It's the one route whose body isn't JSON: the file's own bytes, with
// the file's own type, checked here, explicitly, against ATTACHMENT_TYPES.
//
//   POST ATTACHMENTS_PATH          body: the file's bytes               answers: AttachmentResult
//     201  kept: { ok: true, attachment }
//     400  X-Pitwall-Filename is missing, isn't URL-encoded UTF-8, or the name is empty, over 200
//          characters, or has a path separator, control or bidi character; the file is empty; or
//          the upload stopped before the whole file arrived
//     408  no bytes for 30 seconds, or not all of them within 2 minutes. Nothing is left behind
//     413  over ATTACHMENT_MAX_BYTES: at once by Content-Length, or as soon as the streamed bytes
//          pass it, without reading the rest. Nothing is left behind
//     415  Content-Type isn't one of ATTACHMENT_TYPES, a Content-Encoding is set, or the bytes
//          contradict the type: an image's or a PDF's signature, or, for text and JSON, UTF-8
//          with no NUL
//     429  ATTACHMENTS_MAX_PENDING uploads, those still arriving included, that no spawn has used
//          and that haven't expired. Retry-After is the soonest one could free a place: an unused
//          one expiring, or one still arriving reaching its time limit
//     500  the folder or the file couldn't be written
//     503  this server keeps no attachments (no `pitwallHome`, as in tests), or its folder can't be
//          used safely: a symlink, not a directory, another user's or open to others, or a path an
//          `@` mention can't carry
//
//   DELETE attachmentPath(id)      no body                              answers: nothing, or AttachmentResult
//     204  removed: an upload no spawn has used, whose pending place is free at once
//     404  an id this run doesn't hold: never one, gone, or still arriving
//     409  one a spawn has used, or has claimed and not yet finished with. The sweep removes it
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
// content in the transcript (spike 008, finding 5), or sooner once the used
// ones pass USED_MAX_BYTES in all: then the oldest used folders go first
// (W84). The sweep runs at startup and every 10 minutes; the cap is kept by
// each sweep and after each spawn that used files. Both go by the map for this
// run's uploads, and by each folder's own mtimes for anything else, such as an
// earlier run's or another pitwall's: then `.used` marks a used one. The cap
// never takes an upload no spawn has used, one still arriving, one a starting
// spawn has claimed, or the files of the spawn that has just used them.
//
// A removal takes only `<uuid>` directories directly in the attachments
// folder, and everything in one, since a session given `--add-dir=` for it can
// make directories there (W84): each entry by lstat, a file or a symlink
// unlinked itself, never followed, and only a real directory gone into, the
// same at every level. Each pass, a sweep, a cap or a DELETE, lists at most
// REMOVE_MAX_ENTRIES entries and goes at most REMOVE_MAX_DEPTH directories
// down, moving a deeper one up into its upload's folder for another round.
// A folder left partway is logged once, and each sweep carries on with it.
// Sweeps, caps and DELETEs remove one at a time, and nothing is removed while
// the home or the attachments folder isn't a real directory, the user's own
// and closed to others, as uploads require: then no other user can swap a
// folder for a symlink partway through a removal.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, readdir, realpath, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { Hono } from 'hono';
import { hasUnsafeCharacters } from '../index/guards.js';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  ATTACHMENTS_MAX_PENDING,
  ATTACHMENTS_PATH,
  attachmentPath,
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

/**
 * The most bytes the used uploads kept may have in all (W84): 500 MiB. Past it, the oldest used
 * folders go before their 7 days are up, since their content is in their sessions' transcripts
 * (spike 008, finding 5). It holds five spawns at the most each can carry
 * (ATTACHMENTS_MAX_PER_SESSION × ATTACHMENT_MAX_BYTES, 100 MiB), as many as the spawn rate allows in a
 * minute, so the newest spawn's files are never what has to go; without it, that rate could keep
 * terabytes for 7 days.
 */
export const USED_MAX_BYTES = 500 * 1024 * 1024;

/**
 * The most entries one clean-up pass lists, a sweep, a cap or a DELETE (W84), so a folder a session
 * filled can't stall the sweep. pitwall's own folders have one or two each.
 */
export const REMOVE_MAX_ENTRIES = 10_000;

/** How many directories below an upload's folder a removal goes into; a deeper one is moved up into the folder. */
export const REMOVE_MAX_DEPTH = 16;

/**
 * The longest path, in bytes, a removal goes into: with an entry's name (at most 255 bytes) it stays
 * below the 1,024 macOS allows (PATH_MAX). A directory with a longer one is moved up, as a deeper one is.
 */
const REMOVE_MAX_PATH = 512;

/** What a directory moved up into an upload's folder is called, then a UUID. Never a stored name, which never starts with `.`. */
const MOVED_UP = '.removing-';

/**
 * Characters that show as nothing, which hasUnsafeCharacters() lets through: Unicode's
 * Default_Ignorable_Code_Point, which is the soft hyphen, the Mongolian vowel separator, zero-width
 * space, non-joiner and joiner, the word joiner and the invisible operators, and the zero-width
 * no-break space (BOM) that this rule had before W87, and also the variation selectors (U+FE00 to
 * U+FE0F, and the supplementary ones, U+E0100 to U+E01EF), the tag characters (U+E0000 to U+E007F),
 * the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) and the rest.
 * attachmentName() drops them, so one name can't pass for another, as `a<U+200B>.png` for `a.png`.
 * An emoji's joiner and variation selector go too, so it may show as its parts: a name is only ever
 * shown. Not added to guards.ts's rule, which spawn, resume, open in an editor and the directory list
 * share for real directories. The web UI drops the same before it sends a name (web/src/attachments.ts).
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;

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
 * (hasUnsafeCharacters()) or a path separator, then without INVISIBLE characters, NFC-normalized and
 * trimmed, and refused when that leaves it empty or over ATTACHMENT_NAME_MAX. It's only ever shown, never used as a path.
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
  name = name.replace(INVISIBLE, '').normalize('NFC').trim();
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
  /** An upload that sends no bytes for this long gets 408. Default 30 seconds. */
  uploadIdleMs?: number;
  /** An upload that hasn't sent all its bytes this long after it started gets 408. Default 2 minutes. */
  uploadTotalMs?: number;
  /** The most bytes the used uploads may keep in all before the oldest go. Default USED_MAX_BYTES. */
  usedMaxBytes?: number;
  /** The most entries one clean-up pass lists. Default REMOVE_MAX_ENTRIES. */
  removeMaxEntries?: number;
  /** How many directories down a removal goes before it moves the rest up. Default REMOVE_MAX_DEPTH, at least 1. */
  removeMaxDepth?: number;
  /** Where a folder left partway is reported, once. Default console.error with a `pitwall: attachments:` prefix. */
  log?: (message: string) => void;
}

export const DEFAULT_UPLOAD_IDLE_MS = 30_000;
export const DEFAULT_UPLOAD_TOTAL_MS = 120_000;

/** When an upload still arriving started, and when its latest bytes came, by the store's clock. */
interface Arriving {
  startedAt: number;
  lastByteAt: number;
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
  status: 201 | 400 | 408 | 413 | 415 | 429 | 500 | 503;
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
  readonly #idleMs: number;
  readonly #totalMs: number;
  readonly #usedMaxBytes: number;
  readonly #maxEntries: number;
  readonly #maxDepth: number;
  readonly #log: (message: string) => void;
  readonly #kept = new Map<string, Kept>();
  /** Uploads still arriving, by id: they count as pending, and the sweep leaves their folders alone. */
  readonly #arriving = new Map<string, Arriving>();
  /**
   * Folders to remove that aren't gone yet, by id, never one the map holds: each sweep carries on with
   * them, whatever their age. True once a removal has left one partway and logged it.
   */
  readonly #unfinished = new Map<string, boolean>();
  #timer: NodeJS.Timeout | undefined;
  #sweeping: Promise<void> | undefined;
  /** The clean-up queued last: sweeps, caps and DELETEs' removals run one at a time, in order. */
  #lane: Promise<void> = Promise.resolve();

  constructor(options: AttachmentStoreOptions = {}) {
    this.#home = options.home === undefined ? undefined : path.resolve(options.home);
    this.#root = this.#home === undefined ? undefined : path.join(this.#home, 'attachments');
    this.#now = options.now ?? Date.now;
    this.#sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.#uid = 'uid' in options ? options.uid : process.getuid?.();
    this.#idleMs = options.uploadIdleMs ?? DEFAULT_UPLOAD_IDLE_MS;
    this.#totalMs = options.uploadTotalMs ?? DEFAULT_UPLOAD_TOTAL_MS;
    this.#usedMaxBytes = options.usedMaxBytes ?? USED_MAX_BYTES;
    this.#maxEntries = options.removeMaxEntries ?? REMOVE_MAX_ENTRIES;
    this.#maxDepth = Math.max(1, options.removeMaxDepth ?? REMOVE_MAX_DEPTH);
    this.#log = options.log ?? ((message: string) => console.error(`pitwall: attachments: ${message}`));
  }

  /** Sweeps now, then every sweepIntervalMs, until close(). */
  start(): void {
    if (this.#root === undefined || this.#timer !== undefined) return;
    void this.sweep();
    this.#timer = setInterval(() => void this.sweep(), this.#sweepIntervalMs);
    this.#timer.unref();
  }

  /** Stops the timer, and waits for the clean-up that's running or queued. */
  async close(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#lane;
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
    const started = this.#now();
    const arriving: Arriving = { startedAt: started, lastByteAt: started };
    this.#arriving.set(id, arriving);
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
      const written = await writeBody(body, path.join(dir, stored), type, {
        idleMs: this.#idleMs,
        totalMs: this.#totalMs,
        onBytes: () => {
          arriving.lastByteAt = this.#now();
        },
      });
      if (!written.ok) {
        // Its own folder, which nothing else touches while it's arriving, and #ready() has just checked.
        await this.#remove(root, id, this.#budget());
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

  /**
   * Removes an upload no spawn has used, as when it's removed from the dialog, and frees its place
   * among the pending at once. 'used' for one a spawn has used, or has claimed and not yet
   * finished with: it stays, for the sweep. 'unknown' for an id this run doesn't hold, one still
   * arriving included. The map is changed before anything waits, so a claim() after this sees
   * the id as unknown, and one before it makes this 'used'. The folder is removed only while the
   * home and the attachments folder are private and the user's own, as uploads require; otherwise
   * the id is forgotten and the folder left for a sweep once they are.
   */
  async discard(id: string): Promise<'removed' | 'unknown' | 'used'> {
    const kept = this.#kept.get(id);
    if (!kept) return 'unknown';
    if (kept.usedAt !== undefined || kept.claimed) return 'used';
    this.#kept.delete(id);
    const root = this.#root;
    const home = this.#home;
    if (root === undefined || home === undefined) return 'removed';
    this.#unfinished.set(id, false);
    await this.#serial(async () => {
      if (await this.#private(home, root)) await this.#remove(root, id, this.#budget());
    });
    return 'removed';
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
   * written only shortens that, to an hour from the upload. Then, when the used uploads have more than
   * usedMaxBytes in all, the oldest used folders go, never these (#cap()).
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
    const root = this.#root;
    const home = this.#home;
    if (root === undefined || home === undefined) return;
    const spawned = new Set(ids);
    await this.#serial(async () => {
      if (await this.#private(home, root)) await this.#cap(root, spawned, this.#budget());
    });
  }

  /** Removes what has expired, then keeps the cap. Runs one at a time: a call during a sweep waits for it. */
  sweep(): Promise<void> {
    this.#sweeping ??= this.#serial(() => this.#sweepOnce()).finally(() => {
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
    // Forgotten whatever the disk says, so spawn can't use them, and removed once that's safe.
    const earlier = [...this.#unfinished.keys()];
    for (const id of gone) {
      this.#kept.delete(id);
      this.#unfinished.set(id, false);
    }
    // Nothing is removed unless both are private and the user's own, as uploads require.
    if (!(await this.#private(home, root))) return;
    const budget = this.#budget();
    for (const id of gone) {
      if (budget.left <= 0) return;
      await this.#remove(root, id, budget);
    }

    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget.left <= 0) return;
      // readdir's types are lstat's: a symlink is never a directory here.
      if (!UPLOAD_ID.test(entry.name) || !entry.isDirectory()) continue;
      if (this.#kept.has(entry.name) || this.#arriving.has(entry.name) || this.#unfinished.has(entry.name)) continue;
      const age = await folderAge(path.join(root, entry.name), budget);
      if (age === undefined) continue;
      if (now - age.at >= (age.used ? USED_TTL_MS : UNUSED_TTL_MS)) await this.#remove(root, entry.name, budget);
    }
    if (budget.left > 0) await this.#cap(root, new Set(), budget);
    // Last, so a folder that can't be removed, or a huge one, never holds up the rest.
    for (const id of earlier) {
      if (budget.left <= 0) return;
      if (this.#unfinished.has(id)) await this.#remove(root, id, budget);
    }
  }

  /**
   * Keeps the used uploads to usedMaxBytes in all (W84): while they have more, removes the oldest used
   * folder, this run's by when its spawn used it and any other by its `.used` mtime. A used upload's
   * bytes are its file's, as uploaded, for this run's, and those of the regular files directly in its
   * folder for any other. Never one of `spawned`, the files of the spawn that has just used them, and
   * never an upload no spawn has used, still arriving or claimed by a starting spawn: none is used.
   * Stops at a folder left partway, for the next sweep.
   */
  async #cap(root: string, spawned: ReadonlySet<string>, budget: Budget): Promise<void> {
    const used: Array<{ id: string; at: number; bytes: number }> = [];
    for (const kept of this.#kept.values()) {
      if (kept.usedAt !== undefined) used.push({ id: kept.id, at: kept.usedAt, bytes: kept.size });
    }
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!UPLOAD_ID.test(entry.name) || !entry.isDirectory()) continue;
      // Being removed already, or this run's, which the map says more about than the disk.
      if (this.#kept.has(entry.name) || this.#arriving.has(entry.name) || this.#unfinished.has(entry.name)) continue;
      const folder = await usedFolder(path.join(root, entry.name), budget);
      if (folder !== undefined) used.push({ id: entry.name, ...folder });
    }
    let total = used.reduce((sum, folder) => sum + folder.bytes, 0);
    if (total <= this.#usedMaxBytes) return;
    used.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const folder of used) {
      if (total <= this.#usedMaxBytes) return;
      if (spawned.has(folder.id)) continue;
      this.#kept.delete(folder.id);
      this.#unfinished.set(folder.id, false);
      if (!(await this.#remove(root, folder.id, budget))) return;
      total -= folder.bytes;
    }
  }

  /**
   * Removes `<root>/<id>` within `budget`: true when it's gone. Otherwise it stays among the
   * unfinished, which each sweep carries on with, and is logged the first time.
   */
  async #remove(root: string, id: string, budget: Budget): Promise<boolean> {
    const removal = await removeFolder(root, id, this.#maxDepth, budget);
    if (removal.done) {
      this.#unfinished.delete(id);
      return true;
    }
    if (this.#unfinished.get(id) !== true) {
      this.#log(`couldn't remove all of ${path.join(root, id)} yet: ${removal.reason}. Each sweep carries on with it.`);
    }
    this.#unfinished.set(id, true);
    return false;
  }

  /** What one clean-up pass may list. */
  #budget(): Budget {
    return { left: this.#maxEntries, max: this.#maxEntries };
  }

  /**
   * Runs `task` after every clean-up queued before it, so two never remove at once. A task that throws
   * is logged, never left unhandled.
   */
  #serial(task: () => Promise<void>): Promise<void> {
    const run = this.#lane.then(task).catch((error: unknown) => this.#log(`the clean-up failed: ${(error as Error).message}`));
    this.#lane = run;
    return run;
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

  /**
   * Seconds until the soonest a pending place could free, at least 1: an unused upload expiring, or
   * one still arriving reaching its idle or total limit, whichever comes first for it.
   */
  #retryAfterSeconds(): number {
    const now = this.#now();
    let soonest = Infinity;
    for (const kept of this.#kept.values()) {
      if (kept.usedAt === undefined && !expired(kept, now)) soonest = Math.min(soonest, kept.uploadedAt + UNUSED_TTL_MS);
    }
    for (const arriving of this.#arriving.values()) {
      soonest = Math.min(soonest, arriving.lastByteAt + this.#idleMs, arriving.startedAt + this.#totalMs);
    }
    return soonest === Infinity ? 1 : Math.max(1, Math.ceil((soonest - now) / 1000));
  }

  /** True when the home and the attachments folder are both real directories, the user's own and closed to others. */
  async #private(home: string, root: string): Promise<boolean> {
    return (await realDirectory(home, this.#uid)) === true && (await realDirectory(root, this.#uid)) === true;
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

/** What one clean-up pass may still list, of `max`. */
interface Budget {
  left: number;
  max: number;
}

type Removal = { done: true } | { done: false; reason: string };

/** How emptying a directory ended: it's gone; a deeper directory was moved up, for another round; or something is left. */
type Walk = { state: 'removed' } | { state: 'moved' } | { state: 'left'; reason: string };

const REMOVED: Walk = { state: 'removed' };
const MOVED: Walk = { state: 'moved' };

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

function couldNot(verb: string, error: unknown): Walk {
  return { state: 'left', reason: `an entry couldn't be ${verb} (${errorCode(error) ?? (error as Error).message})` };
}

/** The worse of two walks: something left, then something moved up, then gone. */
function worse(a: Walk, b: Walk): Walk {
  if (a.state === 'left') return a;
  if (b.state === 'left') return b;
  return a.state === 'moved' ? a : b;
}

/**
 * Removes `<root>/<id>` and everything in it, when `id` is an upload's and it's a real directory, since
 * a session given `--add-dir=` for the folder can make directories there (W84). The same rule at every
 * level: each entry by lstat, a file, a symlink or anything else unlinked itself, never followed, and
 * only a real directory gone into. Within `budget`, and at most `maxDepth` directories down: a deeper
 * directory, or one whose path is past REMOVE_MAX_PATH, is moved up into the upload's folder and
 * emptied from there in another round, so the walk never goes deeper and no path gets too long to use.
 * `done: false` when something is left: the budget ran out, or an entry couldn't be removed.
 *
 * Callers check first that the home and `root` are private and the user's own (#private()), so no
 * other user can swap anything in. Node has no unlinkat(), so a process running as this user could
 * still swap a directory for a symlink between its lstat and its removal; but making a symlink takes
 * a shell command, which could remove those files itself.
 */
async function removeFolder(root: string, id: string, maxDepth: number, budget: Budget): Promise<Removal> {
  if (!UPLOAD_ID.test(id)) return { done: true };
  const top = path.join(root, id);
  try {
    // Never a symlink: one with an upload's name is left alone.
    if (!(await lstat(top)).isDirectory()) return { done: true };
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { done: true } : { done: false, reason: `it couldn't be read (${errorCode(error)})` };
  }
  // Each round lists at least the directories the last one moved up, so the budget ends it.
  for (;;) {
    const walk = await emptyTree(top, top, 0, maxDepth, budget);
    if (walk.state === 'removed') return { done: true };
    if (walk.state === 'left') return { done: false, reason: walk.reason };
    if (budget.left <= 0) return { done: false, reason: `a pass lists at most ${budget.max} entries` };
  }
}

/**
 * Empties `dir`, a real directory `depth` levels below the upload's folder `top`, then removes it.
 * Files and symlinks first, so a folder left partway has lost its upload; then each directory; then,
 * in `top`, the `.used` marker, so a later run still knows when it was used.
 */
async function emptyTree(top: string, dir: string, depth: number, maxDepth: number, budget: Budget): Promise<Walk> {
  const listed = await listSome(dir, budget);
  if (!listed.ok) return listed.code === 'ENOENT' ? REMOVED : { state: 'left', reason: `a directory couldn't be read (${listed.code})` };
  let walk: Walk = listed.more ? { state: 'left', reason: `a pass lists at most ${budget.max} entries` } : REMOVED;
  const directories: string[] = [];
  let marker: string | undefined;
  for (const name of listed.names) {
    const entry = path.join(dir, name);
    let stats;
    try {
      stats = await lstat(entry);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') walk = worse(walk, couldNot('read', error));
      continue;
    }
    if (stats.isDirectory()) directories.push(entry);
    else if (depth === 0 && name === USED_MARKER) marker = entry;
    else walk = worse(walk, await unlinkEntry(entry));
  }
  for (const sub of directories) {
    // One directly in `top` is never moved: it's there already.
    const tooDeep = depth > 0 && (depth + 1 > maxDepth || Buffer.byteLength(sub) > REMOVE_MAX_PATH);
    walk = worse(walk, tooDeep ? await moveUp(top, sub) : await emptyTree(top, sub, depth + 1, maxDepth, budget));
  }
  if (walk.state === 'left') return walk;
  // What was moved up is in `top` now, for the next round. Below `top`, this directory is empty.
  if (depth === 0 && walk.state === 'moved') return walk;
  if (marker !== undefined) {
    const unmarked = await unlinkEntry(marker);
    if (unmarked.state !== 'removed') return unmarked;
  }
  try {
    await rmdir(dir);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return couldNot('removed', error);
  }
  return walk;
}

/** Unlinks `entry` itself, a symlink included, never what it points to. */
async function unlinkEntry(entry: string): Promise<Walk> {
  try {
    await unlink(entry);
    return REMOVED;
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? REMOVED : couldNot('removed', error);
  }
}

/** Moves the directory `sub` up into `top`, under a new name, to be emptied from there. rename() moves a symlink itself. */
async function moveUp(top: string, sub: string): Promise<Walk> {
  try {
    await rename(sub, path.join(top, `${MOVED_UP}${randomUUID()}`));
    return MOVED;
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? REMOVED : couldNot('moved', error);
  }
}

/**
 * The names in `dir`, at most what `budget` has left, which they take from it, and whether there
 * are more. All are read before anything is removed, since a directory read while it changes may
 * skip entries. opendir() streams them, so a huge directory is never read whole.
 */
async function listSome(dir: string, budget: Budget): Promise<{ ok: true; names: string[]; more: boolean } | { ok: false; code: string | undefined }> {
  let handle;
  try {
    handle = await opendir(dir);
  } catch (error) {
    return { ok: false, code: errorCode(error) };
  }
  const names: string[] = [];
  try {
    for (;;) {
      const entry = await handle.read();
      if (entry === null) return { ok: true, names, more: false };
      if (budget.left <= 0) return { ok: true, names, more: true };
      budget.left -= 1;
      names.push(entry.name);
    }
  } catch {
    return { ok: true, names, more: true };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * When an upload's folder was last touched, by lstat: `.used`'s mtime for a used one, otherwise
 * the newest of the folder's and its entries', as far as `budget` lists them. Undefined when it
 * can't be read.
 */
async function folderAge(dir: string, budget: Budget): Promise<{ used: boolean; at: number } | undefined> {
  try {
    try {
      return { used: true, at: (await lstat(path.join(dir, USED_MARKER))).mtimeMs };
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    let at = (await lstat(dir)).mtimeMs;
    const listed = await listSome(dir, budget);
    if (!listed.ok) return undefined;
    for (const name of listed.names) at = Math.max(at, (await lstat(path.join(dir, name))).mtimeMs);
    return { used: false, at };
  } catch {
    return undefined;
  }
}

/**
 * For a used upload's folder, one with `.used`: when it was used, by the marker's mtime, and the bytes
 * of the regular files directly in it, as far as `budget` lists them. Undefined for an unused one, or
 * one that can't be read.
 */
async function usedFolder(dir: string, budget: Budget): Promise<{ at: number; bytes: number } | undefined> {
  try {
    const at = (await lstat(path.join(dir, USED_MARKER))).mtimeMs;
    const listed = await listSome(dir, budget);
    if (!listed.ok) return undefined;
    let bytes = 0;
    for (const name of listed.names) {
      const stats = await lstat(path.join(dir, name));
      if (stats.isFile()) bytes += stats.size;
    }
    return { at, bytes };
  } catch {
    return undefined;
  }
}

type Written = { ok: true; size: number } | { ok: false; status: 400 | 408 | 413 | 415 | 500; error: string };

interface WriteLimits {
  idleMs: number;
  totalMs: number;
  /** Called as each chunk arrives. */
  onBytes: () => void;
}

/**
 * The next chunk, or 'stalled' when none comes within `ms`, or undefined when the body failed, as
 * when the client went away. A read still waiting is settled by the reader's cancel() in writeBody().
 */
async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const stalled = new Promise<'stalled'>((resolve) => {
    timer = setTimeout(() => resolve('stalled'), Math.max(0, ms));
  });
  try {
    return await Promise.race([reader.read().catch(() => undefined), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streams `body` into a new file at `file`, at most ATTACHMENT_MAX_BYTES, checking it against `type`,
 * and gives up with 408 when no bytes come for `idleMs`, or not all of them within `totalMs`, so a
 * stalled upload can't hold a pending place, or its folder, for as long as its socket stays open.
 */
async function writeBody(body: ReadableStream<Uint8Array> | null, file: string, type: AttachmentType, limits: WriteLimits): Promise<Written> {
  const fail = (status: 400 | 408 | 413 | 415 | 500, error: string): Written => ({ ok: false, status, error });
  const deadline = Date.now() + limits.totalMs;
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
      const left = deadline - Date.now();
      const next = await readWithin(reader, Math.min(limits.idleMs, left));
      if (next === 'stalled') {
        return fail(
          408,
          left <= limits.idleMs
            ? `The upload took more than ${limits.totalMs / 1000} seconds, so pitwall stopped it. Try again.`
            : `The upload sent nothing for ${limits.idleMs / 1000} seconds, so pitwall stopped it. Try again.`,
        );
      }
      if (next === undefined) return fail(400, 'The upload stopped before the whole file arrived.');
      if (next.done) break;
      limits.onBytes();
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

/** attachmentPath() as a Hono pattern. It encodes its argument, so the pattern is decoded back. */
const ATTACHMENT_ROUTE = decodeURIComponent(attachmentPath(':id'));

/** Adds ATTACHMENTS_PATH, and DELETE attachmentPath(). Call it after the /api/* checks and before the /api/* catch-all, as server.ts does. */
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

  app.delete(ATTACHMENT_ROUTE, async (c) => {
    c.header('Cache-Control', 'no-store');
    // Looked up in the map only: the id never becomes a path unless it's one the map holds.
    const outcome = await store.discard(c.req.param('id') ?? '');
    if (outcome === 'removed') return c.body(null, 204);
    const result = (error: string): AttachmentResult => ({ ok: false, error });
    if (outcome === 'unknown') return c.json(result("That attachment isn't one pitwall holds."), 404);
    return c.json(result('A session has used that attachment, so pitwall keeps it for a while and removes it on its own.'), 409);
  });
}

