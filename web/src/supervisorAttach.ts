// Attach a file in the supervisor's message box (W135; docs/design-system.md, 4: Supervisor, Its
// message box): the page reads the file you choose and puts its text in the box, for you to add to,
// edit and send. The server is never given a path and opens nothing; the supervisor still can't
// read files (D4). Only what fits the box's limit, SUPERVISOR_TEXT_MAX, with what's already there.
//
// - Text only: the bytes must be UTF-8 (TextDecoder with `fatal`, since File.text() would swap bad
//   bytes for U+FFFD without a word) and have no NUL, which the message route refuses anyway.
// - Its size is checked before it's read, so a file that can't fit is never read whole: n bytes of
//   UTF-8 are at least about n / 3 characters (fewestCharacters()).
// - In the box it's the line "File: <name>", then its text in a fenced code block whose fence is
//   longer than any run of backticks in it, so the file's own fences can't close it early.
// - It goes in at the caret, or at the end when the box hasn't had focus, with a blank line between
//   it and the text on either side, and the caret goes after it.

import { outgoingText } from './relay.js';
import { SUPERVISOR_TEXT_MAX } from './supervisor.js';
import { formatSize } from './attachments.js';

const format = (n: number) => n.toLocaleString('en');

/** The sentences, in pitwall's words (docs/design-system.md, 4: Supervisor, Its message box). */
export const ATTACH_FILE_TEXT = {
  button: 'Attach file',
  /** The Attach button's tooltip, which describes it. */
  hint: `Put a text file's contents in the box, to send with your message. The page reads it; pitwall's server never opens it.`,
  attached: (name: string) => `Attached ${name} to your message.`,
  couldNot: (name: string) => `Couldn't attach ${name}.`,
  empty: "It's empty.",
  blank: 'It has nothing but blank space.',
  notText: "It isn't UTF-8 text: only text files can be attached.",
  nul: "It has NUL bytes, so it isn't text: only text files can be attached.",
  unreadable: "The browser couldn't read it.",
  /** The box's text changed while the file was read, by a suggested question or a send. */
  changed: 'The message changed while the file was read: attach it again.',
  /** Before it's read: its size alone is more than the room left. */
  tooBig: (size: number, room: number) =>
    room >= SUPERVISOR_TEXT_MAX
      ? `At ${formatSize(size, { up: true })}, it's longer than a message can be: the limit is ${format(SUPERVISOR_TEXT_MAX)} characters.`
      : `At ${formatSize(size, { up: true })}, it's longer than the ${format(Math.max(0, room))} characters left in this message: the limit is ${format(SUPERVISOR_TEXT_MAX)}.`,
  /** Once read: the message with it would be over the limit. */
  tooLong: (over: number) =>
    `With it, the message would be ${format(over)} ${over === 1 ? 'character' : 'characters'} over the ${format(SUPERVISOR_TEXT_MAX)} limit.`,
} as const;

/**
 * The fewest UTF-16 code units, as a string's length counts them, that `bytes` bytes of UTF-8 can
 * come to: three bytes make at least one, and a leading byte-order mark, three bytes, makes none.
 * Line endings, \r\n made \n, only take bytes away too.
 */
export function fewestCharacters(bytes: number): number {
  return Math.max(0, Math.ceil((bytes - 3) / 3));
}

/**
 * A name for the line above the file: control characters, a line break among them, and the
 * characters that reorder text (bidirectional embeddings, overrides and isolates), as spaces.
 */
export function fileLabel(name: string): string {
  return name.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, ' ').trim() || 'file';
}

/** "File: notes.md", then its text, without one trailing line break, in a fence longer than any run of backticks in it. */
export function fileBlock(name: string, text: string): string {
  // A loop, not Math.max(...runs): a file of 100K or more runs would pass too many arguments.
  let longest = 0;
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return `File: ${fileLabel(name)}\n${fence}\n${body}\n${fence}`;
}

/**
 * `block` put in `current` at `at` (the end when undefined or past it), with a blank line between it
 * and the text on either side, and the caret's place after it: at the start of the text after it, or
 * on a new line below it when there's none, ready to type.
 */
export function insertBlock(current: string, block: string, at?: number): { text: string; caret: number } {
  const place = at === undefined || at > current.length || at < 0 ? current.length : at;
  const before = current.slice(0, place);
  const after = current.slice(place);
  const lead = before.trim() === '' ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  // Blank space before it, with nothing else, goes: the block starts the message.
  const head = before.trim() === '' ? '' : before + lead;
  const text = head + block + trail + after;
  return { text, caret: head.length + block.length + trail.length };
}

/** What attaching came to: the box's new text and caret, or why not, in pitwall's words. */
export type AttachOutcome = { ok: true; text: string; caret: number } | { ok: false; error: string };

/**
 * Reads `file` in the page and puts it in `current` at `at`, or says why not. The size is checked
 * before reading, and the result against SUPERVISOR_TEXT_MAX as the box counts it (outgoingText()).
 */
export async function attachFile(file: Blob & { readonly name: string }, current: string, at?: number): Promise<AttachOutcome> {
  const refuse = (reason: string): AttachOutcome => ({ ok: false, error: `${ATTACH_FILE_TEXT.couldNot(fileLabel(file.name))} ${reason}` });
  if (file.size === 0) return refuse(ATTACH_FILE_TEXT.empty);
  const room = SUPERVISOR_TEXT_MAX - outgoingText(current).length;
  if (fewestCharacters(file.size) > room) return refuse(ATTACH_FILE_TEXT.tooBig(file.size, room));
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return refuse(ATTACH_FILE_TEXT.unreadable);
  }
  if (bytes.includes(0)) return refuse(ATTACH_FILE_TEXT.nul);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refuse(ATTACH_FILE_TEXT.notText);
  }
  // As a text box keeps line breaks, so the count is the one it will show.
  const text = decoded.replace(/\r\n?/g, '\n');
  if (text.trim() === '') return refuse(ATTACH_FILE_TEXT.blank);
  const next = insertBlock(current, fileBlock(file.name, text), at);
  const length = outgoingText(next.text).length;
  if (length > SUPERVISOR_TEXT_MAX) return refuse(ATTACH_FILE_TEXT.tooLong(length - SUPERVISOR_TEXT_MAX));
  return { ok: true, ...next };
}
