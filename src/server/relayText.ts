// The relay's copy of a message (W43). Two pure functions:
//
// - plainSpaces() is the text pitwall relays: spaces that look like a space
//   become a plain space, and a CRLF line break becomes LF. The relay's model
//   (Haiku) tends to write those as plain ones when it copies the text into
//   SendMessage, and the gate, which compares exactly, then blocks the copy.
//   Pitwall frames the request, sets the gate's expectation and checks the
//   call against this text, so all three use the same one.
// - describeCopyDifference() says where the relay's copy first differed from
//   that text, by line and by character code, for the message's result and
//   the server's log. Never with the text itself, not even one character of
//   it: a visible character is only its code, such as U+0107, and whitespace
//   and invisible characters also get a short name.

/**
 * No-break, typographic and mathematical spaces: U+00A0, U+2000 to U+200A,
 * U+202F and U+205F. Not zero-width characters, U+3000 or U+1680, which
 * don't look like a plain space, nor any other character.
 */
const LOOK_ALIKE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f]/g;

/**
 * The text as pitwall relays it: each look-alike space as U+0020, and each
 * CRLF as LF. Nothing else changes: zero-width characters, U+3000, a lone CR,
 * quotes, dashes and every other character stay as they are. A message is
 * checked against the 8,192-character limit as it was received; this can
 * only make it shorter.
 */
export function plainSpaces(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(LOOK_ALIKE_SPACES, ' ');
}

/** Short names for whitespace and invisible characters, with their article. */
const NAMES = new Map<number, string>([
  [0x0009, 'a tab'],
  [0x000a, 'a line break'],
  [0x000b, 'a vertical tab'],
  [0x000c, 'a form feed'],
  [0x000d, 'a carriage return'],
  [0x0020, 'a space'],
  [0x0085, 'a next-line character'],
  [0x00a0, 'a no-break space'],
  [0x00ad, 'a soft hyphen'],
  [0x034f, 'a combining grapheme joiner'],
  [0x061c, 'an Arabic letter mark'],
  [0x1680, 'an Ogham space mark'],
  [0x180e, 'a Mongolian vowel separator'],
  [0x2000, 'an en quad'],
  [0x2001, 'an em quad'],
  [0x2002, 'an en space'],
  [0x2003, 'an em space'],
  [0x2004, 'a three-per-em space'],
  [0x2005, 'a four-per-em space'],
  [0x2006, 'a six-per-em space'],
  [0x2007, 'a figure space'],
  [0x2008, 'a punctuation space'],
  [0x2009, 'a thin space'],
  [0x200a, 'a hair space'],
  [0x200b, 'a zero-width space'],
  [0x200c, 'a zero-width non-joiner'],
  [0x200d, 'a zero-width joiner'],
  [0x200e, 'a left-to-right mark'],
  [0x200f, 'a right-to-left mark'],
  [0x2028, 'a line separator'],
  [0x2029, 'a paragraph separator'],
  [0x202f, 'a narrow no-break space'],
  [0x205f, 'a medium mathematical space'],
  [0x2060, 'a word joiner'],
  [0x3000, 'an ideographic space'],
  [0xfeff, 'a zero-width no-break space'],
]);

/** A character's code, as U+XXXX. */
export function characterCode(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * A character as a description shows it, never as itself: "a no-break space
 * (U+00A0)" for whitespace and invisible characters, "U+0107" for the rest.
 */
export function characterName(codePoint: number): string {
  const code = characterCode(codePoint);
  const name = NAMES.get(codePoint) ?? groupName(codePoint);
  return name === undefined ? code : `${name} (${code})`;
}

function groupName(codePoint: number): string | undefined {
  if ((codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069)) return 'a bidirectional control';
  if (codePoint >= 0x2061 && codePoint <= 0x2064) return 'an invisible operator';
  if ((codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)) return 'a variation selector';
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return 'a tag character';
  const character = String.fromCodePoint(codePoint);
  if (/\p{Cc}/u.test(character)) return 'a control character';
  if (/\p{Cs}/u.test(character)) return 'a lone surrogate';
  if (/\p{Zs}/u.test(character)) return 'a space character';
  if (/[\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(character)) return 'an invisible character';
  return undefined;
}

/** How far past the first difference the copy must agree with the text again to count as one small change. */
const RESYNC_WINDOW = 16;
/** The longest insertion or deletion, in UTF-16 code units, looked for at the first difference. */
const MAX_SHIFT = 512;

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** Characters in `text`, counting a surrogate pair as one. */
function characters(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function lineBreaks(text: string): number {
  let count = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
  return count;
}

/** "25 more characters from here", and how many of them are line breaks. */
function span(count: number, part: string, more: boolean): string {
  const breaks = lineBreaks(part);
  const including = breaks === 0 ? '' : `, including ${breaks === 1 ? 'a line break' : `${breaks.toLocaleString('en')} line breaks`}`;
  return `${count.toLocaleString('en')} ${more ? 'more ' : ''}characters from here${including}`;
}

/**
 * Where the relay's copy first differed from the text pitwall asked it to
 * send, or undefined when it didn't. Always starts with the line, counted in
 * `text` by LF:
 *
 * - "line 33: a no-break space (U+00A0) became a space (U+0020)"
 * - "line 12: U+0107 became U+0063"
 * - "line 5: the copy adds a carriage return (U+000D)"
 * - "line 7: the copy leaves out a zero-width space (U+200B)"
 * - "line 33: the copy has 25 more characters from here, including a line break"
 * - "line 33: the copy is missing 25 characters from here"
 * - "line 40: the copy ends early, 312 characters short"
 * - "line 9: the copy differs from here, with U+0063 in place of U+0107"
 *
 * Counts are of characters, a surrogate pair being one. A change counts as
 * one character changed, added or left out when the copy agrees with the
 * text again right after it. Never contains the text: characters are named
 * by characterName().
 */
export function describeCopyDifference(text: string, copy: string): string | undefined {
  if (copy === text) return undefined;
  let start = 0;
  const shortest = Math.min(text.length, copy.length);
  while (start < shortest && text.charCodeAt(start) === copy.charCodeAt(start)) start++;
  // Don't split a surrogate pair the two share the first half of.
  if (start > 0 && isHighSurrogate(text.charCodeAt(start - 1))) start--;
  const where = `line ${(lineBreaks(text.slice(0, start)) + 1).toLocaleString('en')}`;
  const extra = (part: string) => {
    const count = characters(part);
    return count === 1 ? `${where}: the copy adds ${characterName(part.codePointAt(0)!)}` : `${where}: the copy has ${span(count, part, true)}`;
  };
  const missing = (part: string) => {
    const count = characters(part);
    return count === 1 ? `${where}: the copy leaves out ${characterName(part.codePointAt(0)!)}` : `${where}: the copy is missing ${span(count, part, false)}`;
  };

  if (start === copy.length) {
    const count = characters(text.slice(start));
    return `${where}: the copy ends early, ${count.toLocaleString('en')} ${count === 1 ? 'character' : 'characters'} short`;
  }
  if (start === text.length) return extra(copy.slice(start));

  // The same end in both, after the first difference.
  let end = 0;
  const room = shortest - start;
  while (end < room && text.charCodeAt(text.length - 1 - end) === copy.charCodeAt(copy.length - 1 - end)) end++;
  if (end > 0 && isLowSurrogate(text.charCodeAt(text.length - end))) end--;
  const removed = text.slice(start, text.length - end);
  const added = copy.slice(start, copy.length - end);
  const was = text.codePointAt(start)!;
  const now = copy.codePointAt(start)!;
  const wasLength = was > 0xffff ? 2 : 1;
  const nowLength = now > 0xffff ? 2 : 1;
  const became = `${where}: ${characterName(was)} became ${characterName(now)}`;

  if (removed === '') return extra(added);
  if (added === '') return missing(removed);
  if (removed.length === wasLength && added.length === nowLength) return became;

  // The rest differs too, later on. Look for the copy agreeing with the text again just after the first difference.
  const agrees = (textAt: number, copyAt: number) => {
    const length = Math.min(RESYNC_WINDOW, text.length - textAt, copy.length - copyAt);
    if (length < RESYNC_WINDOW && text.length - textAt !== copy.length - copyAt) return false;
    return text.slice(textAt, textAt + length) === copy.slice(copyAt, copyAt + length);
  };
  if (agrees(start + wasLength, start + nowLength)) return became;
  for (let shift = 1; shift <= MAX_SHIFT; shift++) {
    if (start + shift < copy.length && !isLowSurrogate(copy.charCodeAt(start + shift)) && agrees(start, start + shift)) {
      return extra(copy.slice(start, start + shift));
    }
    if (start + shift < text.length && !isLowSurrogate(text.charCodeAt(start + shift)) && agrees(start + shift, start)) {
      return missing(text.slice(start, start + shift));
    }
  }
  return `${where}: the copy differs from here, with ${characterName(now)} in place of ${characterName(was)}`;
}
