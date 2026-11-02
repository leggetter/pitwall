// New session from here (W118; docs/design-system.md, 4: Session view: header, tabs and footer, the
// actions menu, and 4: Dialogs, the New session dialog): a session's actions menu opens New session
// in that session's directory, which you can change, with a blank prompt. Draft from this session, in
// the dialog, adds the text you selected in the session's conversation, quoted, after one line naming
// the session by its id. All pure, but conversationSelection(), which reads the page's selection.
//
// - Nothing pitwall or a model chose goes in the prompt: no recap, no title, no summary, and not the
//   session's name, which can be Claude Code's generated title or whatever a process passed with
//   --name, the supervisor's included (PR #120's review). A prompt pitwall fills in is sent as typed by
//   you (D25's rule), so the draft is only what you selected, and the session's id in pitwall's fixed
//   words. The readable name is in the dialog's subtitle, which isn't sent. It all goes into the
//   prompt field, where you see and can change it before Start session.
// - The selection is read when the actions menu's button is pressed, and as the menu opens when no
//   press came first, as from a screen reader's click (SessionView), and only when both its ends are in
//   that view's entries (`ol.conversation`): never pitwall's own text around them, such as an alert,
//   Load earlier, the status line or Jump to latest. Text selected anywhere else, or none, leaves Draft
//   from this session off, saying to select text there first.

import { plainText } from './format.js';
import { MAX_PROMPT_LENGTH } from './spawn.js';

/** The actions menu's item, and the dialog's button. */
export const NEW_FROM_HERE_LABEL = 'New session from here';
export const DRAFT_LABEL = 'Draft from this session';

/** Why New session from here is off. */
export const NEW_FROM_HERE_HINTS = {
  missing: "Its directory no longer exists, so there's nowhere to start a session.",
  unlisted: "It's no longer listed, so pitwall can't tell whether its directory is still there.",
} as const;

/** What the dialog's Draft from this session says beside it: what it does, or why it's off. */
export const DRAFT_HINTS = {
  ready: "Adds the text you selected in its conversation to the prompt, quoted, after a line with the session's ID.",
  none: 'To quote it, select text in its conversation, then choose New session from here again.',
  added: "The text you selected is in the prompt. Delete it from there to add it again.",
  tooLong: `The text you selected doesn't fit in the prompt with what's there: at most ${MAX_PROMPT_LENGTH.toLocaleString('en')} characters. Select less of it.`,
} as const;

/** What New session from here opens with: the session's directory, id and name, and what was selected in its conversation. */
export interface FromSession {
  /** Absolute: chosen in Directory, and added to its choices when no group has it, as a worktree's. */
  cwd: string;
  /** The session's id, for the draft's line. */
  sessionId: string;
  /** The session's name, for the subtitle alone: never sent. */
  name: string;
  /** The text selected in its conversation as its actions menu opened, or '' for none. */
  selection: string;
}

/**
 * The text selected in the entries of `panel`, the session view's conversation, its `ol.conversation`,
 * or '' when there's none, or it starts or ends outside them. Read from the page's Selection, as the
 * browser copies it.
 */
export function conversationSelection(panel: Element | null | undefined, selection: Selection | null | undefined = typeof window === 'undefined' ? null : window.getSelection()): string {
  const entries = panel?.querySelector('ol.conversation');
  if (!entries || !selection || selection.rangeCount === 0 || selection.isCollapsed) return '';
  const inside = (node: Node | null) => node !== null && entries.contains(node);
  if (!inside(selection.anchorNode) || !inside(selection.focusNode)) return '';
  return selection.toString();
}

/**
 * One line naming the session by its id, in pitwall's fixed words: "From my session <id>:". The id
 * keeps only letters, digits, `_` and `-`, which a session's id, a UUID, has.
 */
export function sourceLine(sessionId: string): string {
  return `From my session ${sessionId.replace(/[^A-Za-z0-9_-]/g, '')}:`;
}

/**
 * The selection as a quote: as text (plainText), each line after "> ", or ">" alone for a blank one,
 * with blank lines at either end and spaces at each line's end left out. '' when nothing's left.
 */
export function quoteSelection(text: string): string {
  const lines = plainText(text.replace(/\r\n?/g, '\n').replace(/ /g, ' '))
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => (line === '' ? '>' : `> ${line}`)).join('\n');
}

/** The draft: the line naming the session, a blank line, then the quote. Undefined when the selection is only space. */
export function draftText(from: Pick<FromSession, 'sessionId' | 'selection'>): string | undefined {
  const quote = quoteSelection(from.selection);
  return quote === '' ? undefined : `${sourceLine(from.sessionId)}\n\n${quote}`;
}

/** The prompt with the draft added: at its start, then a blank line, then what was there, or a blank line for you to type after. */
export function withDraft(prompt: string, draft: string): string {
  return prompt.trim() === '' ? `${draft}\n\n` : `${draft}\n\n${prompt}`;
}

/** Whether Draft from this session can add `draft` to `prompt`, and why not when it can't. */
export function draftState(prompt: string, draft: string | undefined): 'ready' | keyof Omit<typeof DRAFT_HINTS, 'ready'> {
  if (draft === undefined) return 'none';
  if (prompt.includes(draft)) return 'added';
  if (withDraft(prompt, draft).length > MAX_PROMPT_LENGTH) return 'tooLong';
  return 'ready';
}
