// Text that doesn't read as what it contains (M5, W120, W116's F1): one set of rules for the
// server, which refuses such text in what the supervisor proposes, and the web UI, whose approval
// card shows the exact string that goes, with anything that wouldn't show made visible. Pure, with
// no Node or DOM, so both import it.
//
//   hiddenCharacter()   the first character a proposal can't contain: a C0 or C1 control but tab
//                       and newline (ESC among them, so no terminal escape), a format character
//                       (Unicode's Cf: the bidi controls, zero-width space, joiner and non-joiner,
//                       the word joiner, the byte-order mark, soft hyphen and the tag characters,
//                       U+E0000 to U+E007F), a line or paragraph separator, a lone surrogate, or any
//                       other default-ignorable code point, which a browser draws as nothing (the
//                       Hangul fillers, the variation selectors that carry no emoji style, U+E0100
//                       to U+E01EF among them). One exception: U+FE0E or U+FE0F straight after a
//                       character that shows, which only picks a text or emoji style for it, as in ⚠️
//   visibleParts()      a text cut into what shows as it is and what doesn't: each character
//                       hiddenCharacter() would refuse, and also private-use and unassigned code
//                       points and spaces other than U+0020, which may draw as nothing or as a
//                       space, is its own part, for the card to draw as its code (U+200B)
//   stripInvisible()    text without the tag and zero-width characters and the other
//                       default-ignorables, for untrusted text pitwall passes on to a model
//                       (src/server/mcpTools.ts, src/index/text.ts): they can carry instructions
//                       that nobody reading the text sees

/** Characters a proposal can't contain, but the variation selectors' exception (above). */
const REFUSED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Default_Ignorable_Code_Point}]/u;
/** Characters the card also shows by their code: private use, unassigned, and spaces but U+0020. */
const UNUSUAL = /[\p{Co}\p{Cn}\p{Zs}]/u;
/** Emoji and text presentation selectors, allowed straight after a character that shows. */
const PRESENTATION = new Set([0xfe0e, 0xfe0f]);

/** Names for the characters most likely to be met, for a refusal's message and the card's tooltip. */
const NAMES: Readonly<Record<number, string>> = {
  0x00: 'NUL',
  0x0d: 'CARRIAGE RETURN',
  0x1b: 'ESCAPE, which starts a terminal escape',
  0x7f: 'DELETE',
  0x9b: 'CONTROL SEQUENCE INTRODUCER',
  0x9d: 'OPERATING SYSTEM COMMAND',
  0xa0: 'NO-BREAK SPACE',
  0xad: 'SOFT HYPHEN',
  0x061c: 'ARABIC LETTER MARK',
  0x200b: 'ZERO WIDTH SPACE',
  0x200c: 'ZERO WIDTH NON-JOINER',
  0x200d: 'ZERO WIDTH JOINER',
  0x200e: 'LEFT-TO-RIGHT MARK',
  0x200f: 'RIGHT-TO-LEFT MARK',
  0x2028: 'LINE SEPARATOR',
  0x2029: 'PARAGRAPH SEPARATOR',
  0x202a: 'LEFT-TO-RIGHT EMBEDDING',
  0x202b: 'RIGHT-TO-LEFT EMBEDDING',
  0x202c: 'POP DIRECTIONAL FORMATTING',
  0x202d: 'LEFT-TO-RIGHT OVERRIDE',
  0x202e: 'RIGHT-TO-LEFT OVERRIDE',
  0x2060: 'WORD JOINER',
  0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE',
  0xfeff: 'ZERO WIDTH NO-BREAK SPACE',
};

/** "U+200B": a code point as Unicode writes it, at least four hex digits. */
export function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** "U+200B ZERO WIDTH SPACE", or "U+E0041 TAG LATIN CAPITAL LETTER A", or the code alone. */
export function describeCodePoint(codePoint: number): string {
  const label = codePointLabel(codePoint);
  const named = NAMES[codePoint];
  if (named !== undefined) return `${label} ${named}`;
  if (codePoint >= 0xe0020 && codePoint <= 0xe007e) return `${label} TAG ${String.fromCodePoint(codePoint - 0xe0000)}, a tag character`;
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return `${label}, a tag character`;
  if ((codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)) return `${label}, a variation selector`;
  return label;
}

/** Whether the code point is one hiddenCharacter() refuses, given the one before it. */
function refused(codePoint: number, char: string, previous: number | undefined): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a) return false;
  if (!REFUSED.test(char)) return false;
  // ⚠️ and its kind: a presentation selector after a character that shows.
  if (PRESENTATION.has(codePoint) && previous !== undefined && previous > 0x20 && !REFUSED.test(String.fromCodePoint(previous)) && !UNUSUAL.test(String.fromCodePoint(previous))) return false;
  return true;
}

/** The first character `text` can't contain as a proposal, with its index in UTF-16 code units, or undefined. */
export function hiddenCharacter(text: string): { codePoint: number; index: number } | undefined {
  let index = 0;
  let previous: number | undefined;
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (refused(codePoint, char, previous)) return { codePoint, index };
    previous = codePoint;
    index += char.length;
  }
  return undefined;
}

/**
 * Why `text` can't be proposed, in pitwall's words, or undefined when it can. `what` names it: "message",
 * "first prompt", "name", "recipient", "directory".
 */
export function hiddenTextProblem(text: string, what: string): string | undefined {
  const found = hiddenCharacter(text);
  if (found === undefined) return undefined;
  const position = Array.from(text.slice(0, found.index)).length + 1;
  return `The ${what} has a character that doesn't show as itself on screen (${describeCodePoint(found.codePoint)}, character ${position.toLocaleString('en-US')}), so pitwall won't send it: what goes must be what the user reads. Write it without control, format, zero-width or tag characters.`;
}

/** A piece of text as the card draws it: as it is, or a character drawn as its code. */
export type VisiblePart = { kind: 'text'; text: string } | { kind: 'hidden'; codePoint: number; label: string; description: string };

/**
 * `text` cut into parts: runs that show as they are, and each character that wouldn't show as itself
 * (hiddenCharacter()'s, private use, unassigned, or a space other than U+0020). Joined back, with each
 * hidden part as its character, the parts are `text`, every character of it.
 */
export function visibleParts(text: string): VisiblePart[] {
  const parts: VisiblePart[] = [];
  let run = '';
  let previous: number | undefined;
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    const hidden = codePoint !== 0x20 && (refused(codePoint, char, previous) || (codePoint !== 0x09 && codePoint !== 0x0a && UNUSUAL.test(char)));
    previous = codePoint;
    if (!hidden) {
      run += char;
      continue;
    }
    if (run !== '') parts.push({ kind: 'text', text: run });
    run = '';
    parts.push({ kind: 'hidden', codePoint, label: codePointLabel(codePoint), description: describeCodePoint(codePoint) });
  }
  if (run !== '') parts.push({ kind: 'text', text: run });
  return parts;
}

/** The tag characters, the variation selector supplement, zero-width and other default-ignorables. */
const INVISIBLE = /[­͏ᅟᅠ឴឵᠋-᠏​-‍⁠-⁤⁪-⁯ㅤ﻿ﾠ\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/gu;

/**
 * `text` without the characters INVISIBLE names, for untrusted text pitwall passes on. The bidi
 * controls and the C0 and C1 controls are the callers' to remove, as they already do; the emoji
 * presentation selectors U+FE0E and U+FE0F stay.
 */
export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

/**
 * `text` as one string, with each part visibleParts() calls hidden written as its code in brackets,
 * "[U+200B]", for a heading or a tooltip, where the card can't style it. The card's own text draws
 * them as styled codes instead.
 */
export function visibleString(text: string): string {
  return visibleParts(text)
    .map((part) => (part.kind === 'text' ? part.text : `[${part.label}]`))
    .join('');
}
