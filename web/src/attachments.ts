// Files for New session's first prompt (W82, spike 008): what the dialog takes, why it refuses a
// file, the upload, and the list it keeps while it's open. The server (W79, ATTACHMENTS_PATH) is the
// authority on every check; these repeat its limits so a file is refused before it's sent.
//
// - A file is checked as it's added: its type (ATTACHMENT_TYPES, from the browser's type or else its
//   extension), its size (ATTACHMENT_MAX_BYTES), its name (what the server's 400 refuses) and the
//   count (ATTACHMENTS_MAX_PER_SESSION, refused ones not counted). A refused file is listed with why,
//   and the others go on.
// - Each accepted file uploads as it's added, at most MAX_AT_ONCE at a time, through the app's
//   ApiClient, which sends the apiKey. Remove aborts an upload, or, once it has uploaded, asks the
//   server to remove it (attachmentPath(), DELETE), freeing its place among the pending ones.
//   Closing the dialog without starting aborts the rest and asks the same for every uploaded file.
//   Both are best effort: the server removes what was never used after an hour anyway.
// - An image gets a small thumbnail, drawn on a canvas and kept as a data: URL, since the CSP's
//   img-src allows `data:` and not `blob:`. Nothing is kept once the dialog closes.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  ATTACHMENTS_MAX_PER_SESSION,
  ATTACHMENTS_PATH,
  attachmentPath,
  type Attachment,
  type AttachmentType,
} from '../../src/shared/protocol.js';
import type { ApiClient } from './api.js';
import { couldNot, plainText } from './format.js';

/** Uploads running at once, at most. */
export const MAX_AT_ONCE = 2;

/** The longest name the server takes, in UTF-16 code units, as JavaScript counts a string's length. */
export const ATTACHMENT_NAME_MAX = 200;

/** The thumbnail's side, in px: twice the 32 px tile, for screens at 2x. */
const THUMBNAIL_PX = 64;

const EXTENSIONS: Readonly<Record<string, AttachmentType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
};

/** Other names browsers and systems give the same types. */
const ALIASES: Readonly<Record<string, AttachmentType>> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'text/x-markdown': 'text/markdown',
};

/** For the file input: the types, and their extensions, for a system that types a file by its name. */
export const ACCEPT = [...ATTACHMENT_TYPES, ...Object.keys(EXTENSIONS).map((extension) => `.${extension}`)].join(',');

/** A path separator, a C0 or C1 control, or a bidi control: what the server's 400 refuses in a name. */
const UNSAFE_NAME = /[/\\\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;

function isAttachmentType(type: string): type is AttachmentType {
  return (ATTACHMENT_TYPES as readonly string[]).includes(type);
}

/**
 * The type to upload a file as: the browser's, when it's one the server takes, or else the one its
 * extension stands for, as a CSV that Windows calls application/vnd.ms-excel. Undefined for anything
 * else, which is refused.
 */
export function attachmentType(file: { name: string; type: string }): AttachmentType | undefined {
  const given = (file.type.split(';')[0] ?? '').trim().toLowerCase();
  if (isAttachmentType(given)) return given;
  const alias = ALIASES[given];
  if (alias) return alias;
  const dot = file.name.lastIndexOf('.');
  return dot > 0 ? EXTENSIONS[file.name.slice(dot + 1).toLowerCase()] : undefined;
}

export type AttachmentKind = 'image' | 'pdf' | 'text';

/** Which icon a file's tile has. */
export function kindOf(type: AttachmentType | undefined): AttachmentKind {
  if (type?.startsWith('image/')) return 'image';
  return type === 'application/pdf' ? 'pdf' : 'text';
}

/**
 * A size as the list shows it, in 1,024s: "512 B", "4.2 KB", "245 KB", "1.5 MB", "10 MB". `up`
 * rounds up, so a file a byte over the limit never reads as the limit.
 */
export function formatSize(bytes: number, { up = false }: { up?: boolean } = {}): string {
  if (bytes < 1024) return `${bytes} B`;
  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, 'KB'] : [bytes / (1024 * 1024), 'MB'];
  // Rounded up, it keeps a decimal place below 100, so 10 MB and a byte reads 10.1 MB, not 11.
  const places = value < 10 || (up && value < 100) ? 1 : 0;
  const scale = 10 ** places;
  const rounded = (up ? Math.ceil(value * scale - 1e-9) : Math.round(value * scale)) / scale;
  return `${rounded.toLocaleString('en', { maximumFractionDigits: places })} ${unit}`;
}

/** The sentences the dialog uses (docs/design-system.md, 4: Dialogs, New session's attachments). */
export const ATTACH_TEXT = {
  hint: `Or drop or paste them into the prompt: images, PDFs and text files, up to ${formatSize(ATTACHMENT_MAX_BYTES)} each.`,
  dropTarget: 'Drop files to attach them',
  listLabel: 'Attached files',
  uploading: 'Uploading…',
  waiting: 'Waiting…',
  type: 'Only images, PDFs and text files can be attached.',
  empty: "It's empty.",
  size: (size: number) => `It's ${formatSize(size, { up: true })}, over the ${formatSize(ATTACHMENT_MAX_BYTES)} limit.`,
  count: `A first prompt takes at most ${ATTACHMENTS_MAX_PER_SESSION} files.`,
  long: `Its name is over ${ATTACHMENT_NAME_MAX} characters. Rename the file, then attach it again.`,
  name: 'Its name has a /, \\ or control character in it. Rename the file, then attach it again.',
  noServer: "Files can't be uploaded from here.",
  unavailable: "Files can't be attached on this machine. You can still start the session without them.",
  unclear: "pitwall's answer didn't say which file it kept.",
  attached: (name: string) => `Attached ${name}.`,
} as const;

/** What's wrong with a file, before it's sent: why it's refused, or undefined. `count` is how many are already listed and not refused. */
export function fileProblem(file: { name: string; type: string; size: number }, count: number): string | undefined {
  if (attachmentType(file) === undefined) return ATTACH_TEXT.type;
  if (file.size === 0) return ATTACH_TEXT.empty;
  if (file.size > ATTACHMENT_MAX_BYTES) return ATTACH_TEXT.size(file.size);
  if (file.name.length > ATTACHMENT_NAME_MAX) return ATTACH_TEXT.long;
  if (UNSAFE_NAME.test(file.name)) return ATTACH_TEXT.name;
  if (count >= ATTACHMENTS_MAX_PER_SESSION) return ATTACH_TEXT.count;
  return undefined;
}

/** A pasted file with no name, as some systems give an image, gets one from its type. */
function nameOf(file: File): string {
  if (file.name !== '') return file.name;
  const type = attachmentType(file);
  const extension = type === undefined ? '' : (Object.entries(EXTENSIONS).find(([, each]) => each === type)?.[0] ?? '');
  return `${type?.startsWith('image/') ? 'Pasted image' : 'Pasted file'}${extension === '' ? '' : `.${extension}`}`;
}

export type UploadOutcome =
  | { kind: 'uploaded'; attachment: Attachment }
  /** The server refused the file itself: 400 (its name, or an empty file), 413 (its size) or 415 (its type, or bytes that contradict it). Trying again won't help. */
  | { kind: 'refused'; error?: string; status?: number }
  /** 503: this pitwall keeps no attachments on this machine. The session can still start without them. */
  | { kind: 'unavailable'; error?: string }
  /** Anything else, such as 429 with too many unused uploads, a 500 or no answer: trying again may. */
  | { kind: 'failed'; error?: string; status?: number }
  | { kind: 'unauthorized' }
  | { kind: 'aborted' };

const REFUSALS = new Set([400, 413, 415]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asAttachment(value: unknown): Attachment | undefined {
  const body = asRecord(value);
  if (!body) return undefined;
  const { id, name, type, size } = body;
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || typeof type !== 'string' || !isAttachmentType(type)) return undefined;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return undefined;
  return { id, name, type, size };
}

/**
 * Uploads one file with POST ATTACHMENTS_PATH: its bytes, its type, and its name, URL-encoded, in
 * X-Pitwall-Filename. Never rejects.
 */
export async function uploadAttachment(api: ApiClient, file: Blob, name: string, type: AttachmentType, signal: AbortSignal): Promise<UploadOutcome> {
  const result = await api.upload(ATTACHMENTS_PATH, { body: file, contentType: type, headers: { 'X-Pitwall-Filename': encodeURIComponent(name) } }, { signal });
  if (signal.aborted) return { kind: 'aborted' };
  if (result.kind === 'unauthorized') return { kind: 'unauthorized' };
  const body = asRecord(result.body);
  if (result.kind === 'ok') {
    const attachment = body?.ok === true ? asAttachment(body.attachment) : undefined;
    return attachment ? { kind: 'uploaded', attachment } : { kind: 'failed', error: ATTACH_TEXT.unclear };
  }
  const error = body?.ok === false && typeof body.error === 'string' && body.error !== '' ? body.error : undefined;
  if (result.status === 503) return error === undefined ? { kind: 'unavailable' } : { kind: 'unavailable', error };
  const kind = result.status !== undefined && REFUSALS.has(result.status) ? 'refused' : 'failed';
  if (error !== undefined) return { kind, error };
  return result.status === undefined ? { kind } : { kind, status: result.status };
}

export type AttachmentState = 'waiting' | 'uploading' | 'uploaded' | 'failed' | 'refused';

/** Why a file isn't attached: pitwall's own reason, or the server's, or an HTTP status. */
export interface AttachmentProblem {
  /** "attach" for a refusal, "upload" for a failure that trying again may fix. */
  verb: 'attach' | 'upload';
  /** pitwall's own sentence after "Couldn't attach it.", such as ATTACH_TEXT.type. */
  reason?: string;
  /** The server's message, shown in code style. */
  detail?: string;
  status?: number;
}

export interface AttachmentItem {
  /** The list's own key for it, never sent. */
  key: string;
  /** The name to show: the server's cleaned one once uploaded, as plain text. */
  name: string;
  size: number;
  kind: AttachmentKind;
  state: AttachmentState;
  /** A data: URL, for an image once drawn. */
  thumbnail?: string;
  /** For failed and refused. */
  problem?: AttachmentProblem;
  /** The server's id, once uploaded. */
  id?: string;
}

/** The problem's lead, "Couldn't attach it." or "Couldn't upload report.pdf (HTTP 500).", naming `subject`. */
export function problemLead(problem: AttachmentProblem, subject: string): string {
  return couldNot(`${problem.verb} ${subject}`, problem.detail === undefined && problem.reason === undefined ? problem.status : undefined);
}

/** The problem as one line of text, for the list's announcement. */
export function problemSentence(problem: AttachmentProblem, subject: string): string {
  return [problemLead(problem, subject), problem.reason, problem.detail].filter((part) => part !== undefined).join(' ');
}

/**
 * The files a paste carries, to attach, or undefined to let it paste as text. A paste with files and
 * text other than their names, as a copy from a spreadsheet or a document has, is text: it pastes
 * as text and attaches nothing. A copied file comes with its name, or its path, as its text.
 */
export function pastedFiles(data: DataTransfer | null): File[] | undefined {
  if (!data) return undefined;
  // Chrome puts a pasted image in files; a browser that has it in items alone still gets it attached.
  const fromItems = () => [...(data.items ?? [])].filter((item) => item.kind === 'file').flatMap((item) => item.getAsFile() ?? []);
  const files = data.files && data.files.length > 0 ? [...data.files] : fromItems();
  if (files.length === 0) return undefined;
  const text = data.getData('text/plain').trim();
  if (text === '') return files;
  const names = files.map((file) => file.name).filter((name) => name !== '');
  const onlyNames = text.split(/\r?\n/).every((line) => line.trim() === '' || names.some((name) => line.trim().endsWith(name)));
  return onlyNames ? files : undefined;
}

/** Whether a drag carries files, as one from the Finder or a desktop does. */
export function draggingFiles(data: DataTransfer | null | undefined): boolean {
  return [...(data?.types ?? [])].includes('Files');
}

/** A small square thumbnail of an image, from its middle, as a data: URL, or undefined where the browser can't draw one. */
async function thumbnailOf(file: Blob): Promise<string | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined;
  try {
    const bitmap = await createImageBitmap(file, { resizeWidth: THUMBNAIL_PX * 2, resizeQuality: 'medium' });
    try {
      const canvas = document.createElement('canvas');
      canvas.width = THUMBNAIL_PX;
      canvas.height = THUMBNAIL_PX;
      const context = canvas.getContext('2d');
      if (!context) return undefined;
      const side = Math.min(bitmap.width, bitmap.height);
      context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, THUMBNAIL_PX, THUMBNAIL_PX);
      return canvas.toDataURL('image/png');
    } finally {
      bitmap.close();
    }
  } catch {
    // Not an image the browser can decode: the tile keeps its icon.
    return undefined;
  }
}

/** Asks the server to remove an upload no spawn has used. Best effort: whatever it answers, it removes it after an hour anyway. */
function release(api: ApiClient | undefined, id: string): void {
  void api?.delete(attachmentPath(id)).catch(() => undefined);
}

export interface AttachmentsController {
  items: readonly AttachmentItem[];
  /** Adds files from the picker, a drop or a paste: each is checked, then uploaded or listed as refused. */
  add(files: readonly File[]): void;
  /** Takes a file off the list, aborting its upload if it's running, or asking the server to remove it once uploaded. */
  remove(key: string): void;
  /** The session started with the uploaded files: closing now leaves them, since a spawn has used them. */
  started(): void;
  /** Uploads a failed file again. */
  retry(key: string): void;
  /** The uploaded files' ids, in the list's order, for SpawnRequest.attachments. */
  ids: readonly string[];
  /** How many are waiting or uploading. */
  pending: number;
  /** How many failed. */
  failed: number;
  /** The latest result, for a polite status region: what was attached, refused or failed. */
  announcement: string;
}

/**
 * Holds the files for one opening of the New session dialog. Unmounting aborts every upload, and,
 * unless the session started with them, asks the server to remove each uploaded file.
 */
export function useAttachments(api: ApiClient | undefined): AttachmentsController {
  const [items, setItems] = useState<readonly AttachmentItem[]>([]);
  const [announcement, setAnnouncement] = useState('');
  // The list as it is now, for the async work, which mustn't read a render's stale copy.
  const list = useRef<readonly AttachmentItem[]>([]);
  // Each accepted file's bytes and type, and its upload's controller while it runs.
  const held = useRef(new Map<string, { file: File; name: string; type: AttachmentType; controller?: AbortController | undefined }>());
  const alive = useRef(true);
  const counter = useRef(0);
  const apiRef = useRef(api);
  apiRef.current = api;
  // Set once the session started with the files, so closing doesn't remove what it used.
  const used = useRef(false);

  useEffect(() => {
    alive.current = true;
    const files = held.current;
    return () => {
      alive.current = false;
      for (const each of files.values()) each.controller?.abort();
      files.clear();
      if (!used.current) for (const item of list.current) if (item.state === 'uploaded' && item.id !== undefined) release(apiRef.current, item.id);
      list.current = [];
    };
  }, []);

  const commit = (next: readonly AttachmentItem[]) => {
    list.current = next;
    if (alive.current) setItems(next);
  };
  const change = (key: string, patch: Patch) => {
    commit(list.current.map((item) => (item.key === key ? withPatch(item, patch) : item)));
  };
  const announce = (text: string) => {
    if (alive.current) setAnnouncement(text);
  };

  const pump = () => {
    let running = list.current.filter((item) => item.state === 'uploading').length;
    for (const item of list.current) {
      if (running >= MAX_AT_ONCE) return;
      if (item.state !== 'waiting') continue;
      running += 1;
      start(item.key);
    }
  };

  const start = (key: string) => {
    const file = held.current.get(key);
    const item = list.current.find((each) => each.key === key);
    if (!file || !item) return;
    const client = apiRef.current;
    if (!client) {
      change(key, { state: 'failed', problem: { verb: 'upload', reason: ATTACH_TEXT.noServer } });
      announce(problemSentence({ verb: 'upload', reason: ATTACH_TEXT.noServer }, item.name));
      return;
    }
    const controller = new AbortController();
    file.controller = controller;
    change(key, { state: 'uploading', problem: undefined });
    void uploadAttachment(client, file.file, file.name, file.type, controller.signal).then((outcome) => {
      // Removed, or the dialog closed: nothing more to say about it.
      if (controller.signal.aborted || held.current.get(key) !== file) return;
      file.controller = undefined;
      const name = list.current.find((each) => each.key === key)?.name ?? item.name;
      switch (outcome.kind) {
        case 'uploaded': {
          const shown = plainText(outcome.attachment.name) || name;
          change(key, { state: 'uploaded', id: outcome.attachment.id, name: shown, problem: undefined });
          announce(ATTACH_TEXT.attached(shown));
          break;
        }
        case 'refused':
        case 'unavailable':
        case 'failed':
        case 'unauthorized': {
          const refused = outcome.kind === 'refused' || outcome.kind === 'unavailable';
          const problem: AttachmentProblem = { verb: refused ? 'attach' : 'upload' };
          // No attachments on this machine: say the session can still start, then the server's why.
          if (outcome.kind === 'unavailable') problem.reason = ATTACH_TEXT.unavailable;
          if (outcome.kind !== 'unauthorized') {
            if (outcome.error === ATTACH_TEXT.unclear) problem.reason = outcome.error;
            else if (outcome.error !== undefined) problem.detail = plainText(outcome.error);
            if (outcome.kind !== 'unavailable' && outcome.status !== undefined) problem.status = outcome.status;
          }
          // A refused file no longer counts towards the limit, and isn't uploaded again.
          if (refused) held.current.delete(key);
          change(key, { state: refused ? 'refused' : 'failed', problem });
          announce(problemSentence(problem, name));
          break;
        }
        case 'aborted':
          return;
      }
      pump();
    });
  };

  // Each call reads the list's ref, so the callbacks needn't change from render to render.
  const add = useCallback((files: readonly File[]) => {
    if (files.length === 0) return;
    let count = list.current.filter((item) => item.state !== 'refused').length;
    const added: AttachmentItem[] = [];
    const refusals: string[] = [];
    for (const file of files) {
      const key = `attachment-${(counter.current += 1)}`;
      const name = plainText(nameOf(file));
      const type = attachmentType(file);
      const reason = fileProblem({ name: nameOf(file), type: file.type, size: file.size }, count);
      const item: AttachmentItem = { key, name, size: file.size, kind: kindOf(type), state: reason === undefined ? 'waiting' : 'refused' };
      if (reason !== undefined || type === undefined) {
        const problem: AttachmentProblem = { verb: 'attach', reason: reason ?? ATTACH_TEXT.type };
        item.problem = problem;
        refusals.push(problemSentence(problem, name));
      } else {
        count += 1;
        held.current.set(key, { file, name: nameOf(file), type });
        if (item.kind === 'image') {
          void thumbnailOf(file).then((thumbnail) => {
            if (thumbnail !== undefined && held.current.has(key)) change(key, { thumbnail });
          });
        }
      }
      added.push(item);
    }
    commit([...list.current, ...added]);
    if (refusals.length > 0) announce(refusals.join(' '));
    pump();
    // pump, commit and change only read refs.
  }, []);

  const remove = useCallback((key: string) => {
    held.current.get(key)?.controller?.abort();
    held.current.delete(key);
    const item = list.current.find((each) => each.key === key);
    // Uploaded, and so held by the server as one of its pending: it can go now, not in an hour.
    if (item?.state === 'uploaded' && item.id !== undefined) release(apiRef.current, item.id);
    commit(list.current.filter((each) => each.key !== key));
    pump();
  }, []);

  const started = useCallback(() => {
    used.current = true;
  }, []);

  const retry = useCallback((key: string) => {
    const item = list.current.find((each) => each.key === key);
    if (item?.state !== 'failed' || !held.current.has(key)) return;
    change(key, { state: 'waiting', problem: undefined });
    pump();
  }, []);

  const ids = items.flatMap((item) => (item.state === 'uploaded' && item.id !== undefined ? [item.id] : []));
  const pending = items.filter((item) => item.state === 'waiting' || item.state === 'uploading').length;
  const failed = items.filter((item) => item.state === 'failed').length;
  return { items, add, remove, retry, started, ids, pending, failed, announcement };
}

/** Fields to change, an undefined one taking the field away. */
type Patch = { [Field in keyof AttachmentItem]?: AttachmentItem[Field] | undefined };

/** The item with `patch` applied, an undefined in it taking the field away, so no stale problem or id is left behind. */
function withPatch(item: AttachmentItem, patch: Patch): AttachmentItem {
  const next: Record<string, unknown> = { ...item };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete next[field];
    else next[field] = value;
  }
  return next as unknown as AttachmentItem;
}

/**
 * Why Start session is off while files upload or have failed, or undefined: the dialog's problem for
 * the files, and Start session's tooltip, in the same words.
 */
export function attachmentsProblem(pending: number, failed: number): string | undefined {
  if (failed > 0) return failed === 1 ? "A file didn't upload. Try it again, or remove it." : `${failed} files didn't upload. Try them again, or remove them.`;
  if (pending > 0) return pending === 1 ? 'Wait for the file to upload, or remove it.' : `Wait for the ${pending} files to upload, or remove them.`;
  return undefined;
}
