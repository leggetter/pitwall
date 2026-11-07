// Spin-off proposals (W163): a session ends its turn with a fenced block that proposes a new session,
// which you start from a card in Needs you. Sessions learn the block from the `spin-off` skill
// (skills/spin-off/SKILL.md in pitwall's repo). Read from the newest assistant message's text, behind
// the transcript adapter (transcripts.ts), and pure: no file is read here.
//
// The block, the last thing in the message, with only blank lines after it:
//
//   ```spin-off
//   folder: ~/oss/demo-app
//   name: fix-export-test
//   prompt:
//   Fix the flaky export test in test/export.test.ts. …
//   ```
//
// - The opening fence is three or more backticks or tildes with the info string `spin-off`, any case;
//   the closing fence the same character, at least as many, as CommonMark has it. A prompt with a
//   fence of its own in it uses a longer one: four backticks around three.
// - Before `prompt:`, only blank lines and `folder:` and `name:`, each once. `folder` is required,
//   absolute or starting with `~/`, which is expanded to the home folder. `name` is optional.
// - Everything after `prompt:`, text on its own line included, is the prompt, blank lines at its
//   start and end trimmed, and the fence's own indent taken off each line.
//
// The text is the session's, so untrusted: it's bounded here and nothing is shown that doesn't show as
// itself. A block that breaks a rule isn't dropped, it's 'unreadable', with why in pitwall's own words
// and none of the block's text, so you know a proposal came and why pitwall won't show it. Only a
// block that ends the message counts, so one quoted earlier in a message, as an example, never does.
// The server checks a proposal again, by spawn_session's checks, before New session opens with it
// (src/server/spinOffRoutes.ts).

import { createHash } from 'node:crypto';
import path from 'node:path';
import { describeCodePoint, hiddenCharacter } from '../shared/hiddenText.js';
import { SPAWN_PROMPT_MAX, SPIN_OFF_FOLDER_MAX, SPIN_OFF_NAME_MAX, type SpinOff } from '../shared/protocol.js';

/** The fenced block's info string, which the skill writes. */
export const SPIN_OFF_INFO = 'spin-off';

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const FIELD = /^(folder|name|prompt)\s*:\s?(.*)$/i;

interface Block {
  /** The lines between the fences. */
  body: string[];
  /** How many spaces the opening fence was indented by, taken off each line. */
  indent: number;
  /** Closed by a fence, rather than running to the end of the text. */
  closed: boolean;
}

/**
 * The spin-off proposal `text`, the newest assistant message's whole text, ends with, if any. `home`
 * is the folder `~` stands for. Never throws.
 */
export function detectSpinOff(text: string, home: string): SpinOff | undefined {
  const block = lastBlock(text);
  if (block === undefined) return undefined;
  const key = createHash('sha256').update(block.body.join('\n')).digest('hex').slice(0, 16);
  const unreadable = (problem: string): SpinOff => ({ kind: 'unreadable', key, problem });
  if (!block.closed) return unreadable('The block has no closing fence.');
  const lines = block.body.map((line) => dedent(line, block.indent));

  const fields = new Map<string, string>();
  let promptAt: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '') continue;
    const field = FIELD.exec(line.trim());
    if (field === null) return unreadable('The block has a line before prompt: that isn’t folder: or name:.');
    const name = field[1]!.toLowerCase();
    if (fields.has(name)) return unreadable(`The block gives ${name}: twice.`);
    if (name === 'prompt') {
      promptAt = index;
      fields.set(name, field[2] ?? '');
      break;
    }
    fields.set(name, (field[2] ?? '').trim());
  }
  if (promptAt === undefined) return unreadable('The block has no prompt: line.');
  const folderText = fields.get('folder');
  if (folderText === undefined || folderText === '') return unreadable('The block names no folder.');

  const promptLines = [fields.get('prompt') ?? '', ...lines.slice(promptAt + 1)];
  if (promptLines[0]!.trim() === '') promptLines.shift();
  const prompt = trimBlankLines(promptLines).join('\n').trimEnd();
  if (prompt.trim() === '') return unreadable('The block’s prompt is empty.');

  const folder = expandHome(folderText, home);
  const name = fields.get('name');
  for (const [value, what, max] of [
    [folder, 'folder', SPIN_OFF_FOLDER_MAX],
    [name, 'name', SPIN_OFF_NAME_MAX],
    [prompt, 'prompt', SPAWN_PROMPT_MAX],
  ] as const) {
    if (value === undefined) continue;
    if (value.length > max) return unreadable(`The ${what} is over ${max.toLocaleString('en-US')} characters.`);
    const hidden = hiddenCharacter(value);
    if (hidden !== undefined) return unreadable(`The ${what} has a character that doesn’t show as itself on screen (${describeCodePoint(hidden.codePoint)}).`);
  }
  if (!path.isAbsolute(folder)) return unreadable('The folder isn’t an absolute path, or one that starts with ~/.');
  return { kind: 'proposal', key, folder, ...(name === undefined || name === '' ? {} : { name }), prompt };
}

/**
 * The last fenced block in `text` with the spin-off info string, when nothing but blank lines follows
 * it. Fences as markFences() (text.ts) reads them, so a fence inside a longer one doesn't close it.
 */
function lastBlock(text: string): Block | undefined {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let last: Block | undefined;
  /** Where the newest block of any kind ended: a spin-off block counts only if nothing but blank lines comes after it. */
  let lastEnd = -1;
  let open: { marker: string; block: Block | undefined } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (open !== undefined) {
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close !== undefined && close[0] === open.marker[0] && close.length >= open.marker.length) {
        if (open.block !== undefined) {
          open.block.closed = true;
          last = open.block;
        } else {
          last = undefined;
        }
        lastEnd = index;
        open = undefined;
      } else {
        open.block?.body.push(line);
      }
      continue;
    }
    const opening = FENCE_OPEN.exec(line);
    // Also any other fence, as markFences() has it, so a spin-off block quoted inside one isn't read.
    const other = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening !== null && opening[3]!.toLowerCase() === SPIN_OFF_INFO) {
      open = { marker: opening[2]!, block: { body: [], indent: opening[1]!.length, closed: false } };
      continue;
    }
    if (other !== null && !(other[1]![0] === '`' && other[2]!.includes('`'))) {
      open = { marker: other[1]!, block: undefined };
      continue;
    }
    if (line.trim() !== '' && index > lastEnd) last = undefined;
  }
  // A block still open runs to the end of the text, as in CommonMark: unreadable, since it may be cut.
  if (open !== undefined) return open.block;
  return last;
}

/** `line` without up to `indent` leading spaces. */
function dedent(line: string, indent: number): string {
  let cut = 0;
  while (cut < indent && line[cut] === ' ') cut += 1;
  return line.slice(cut);
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === '') start += 1;
  while (end > start && lines[end - 1]!.trim() === '') end -= 1;
  return lines.slice(start, end);
}

/** `~` or `~/…` as under `home`; anything else as it is. */
function expandHome(folder: string, home: string): string {
  if (folder === '~') return home;
  if (folder.startsWith('~/')) return path.join(home, folder.slice(2));
  return folder;
}
