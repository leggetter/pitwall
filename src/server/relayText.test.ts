// The relay's copy of a message (W43): the text pitwall relays, and where the
// relay's copy first differed from it. Made-up text only.
import { describe, expect, it } from 'vitest';
import { characterName, describeCopyDifference, plainSpaces } from './relayText.js';

/** Every code point plainSpaces() makes a plain space. */
const LOOK_ALIKES = [0x00a0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f];

describe('plainSpaces', () => {
  it.each(LOOK_ALIKES.map((code) => [`U+${code.toString(16).toUpperCase().padStart(4, '0')}`, code]))('makes %s a plain space', (_name, code) => {
    expect(plainSpaces(`one${String.fromCodePoint(code)}two`)).toBe('one two');
  });

  it('makes every CRLF an LF', () => {
    expect(plainSpaces('one\r\ntwo\r\n\r\nthree\r\n')).toBe('one\ntwo\n\nthree\n');
  });

  it.each([
    ['a zero-width space', '​'],
    ['a zero-width non-joiner', '‌'],
    ['a zero-width joiner', '‍'],
    ['a word joiner', '⁠'],
    ['a zero-width no-break space', '﻿'],
    ['an ideographic space', '　'],
    ['an Ogham space mark', ' '],
    ['a lone CR', '\r'],
    ['a tab', '\t'],
    ['a line separator', ' '],
    ['a next-line character', '\u0085'],
    ['a soft hyphen', '­'],
    ['straight and curly quotes', `'"‘’“”`],
    ['dashes and hyphens', '-‐‑‒–—−'],
    ['accented letters', 'ćŠéü'],
    ['an emoji', '\u{1f600}'],
  ])('leaves %s as it is', (_what, characters) => {
    const text = `one${characters}two${characters}`;
    expect(plainSpaces(text)).toBe(text);
  });

  it('changes a CR only as part of a CRLF, so a lone one before a CRLF stays', () => {
    expect(plainSpaces('one\r\r\ntwo\n\rthree')).toBe('one\r\ntwo\n\rthree');
  });

  it('never makes a text longer, and leaves plain text alone', () => {
    const text = `${LOOK_ALIKES.map((code) => String.fromCodePoint(code)).join('a')}\r\n`.repeat(50);
    expect(plainSpaces(text).length).toBeLessThan(text.length);
    const plain = 'Plain text, with "quotes" – a dash, and\nlines.';
    expect(plainSpaces(plain)).toBe(plain);
  });
});

describe('characterName', () => {
  it('names whitespace and invisible characters, with their code', () => {
    expect(characterName(0x00a0)).toBe('a no-break space (U+00A0)');
    expect(characterName(0x0020)).toBe('a space (U+0020)');
    expect(characterName(0x000a)).toBe('a line break (U+000A)');
    expect(characterName(0x000d)).toBe('a carriage return (U+000D)');
    expect(characterName(0x200b)).toBe('a zero-width space (U+200B)');
    expect(characterName(0x202f)).toBe('a narrow no-break space (U+202F)');
    expect(characterName(0x3000)).toBe('an ideographic space (U+3000)');
    expect(characterName(0x202e)).toBe('a bidirectional control (U+202E)');
    expect(characterName(0xfe0f)).toBe('a variation selector (U+FE0F)');
    expect(characterName(0x0007)).toBe('a control character (U+0007)');
    expect(characterName(0xd800)).toBe('a lone surrogate (U+D800)');
    expect(characterName(0x180b)).toBe('an invisible character (U+180B)');
  });

  it('shows any other character by its code alone', () => {
    expect(characterName(0x0107)).toBe('U+0107');
    expect(characterName(0x0041)).toBe('U+0041');
    expect(characterName(0x2013)).toBe('U+2013');
    expect(characterName(0x1f600)).toBe('U+1F600');
  });
});

/** 89 made-up lines, as long as a long pasted message, with line `n` (from 1) as `line(n)`. */
function lines(line: (n: number) => string = (n) => `Line ${n} of a made-up message about the export job, with some words.`): string[] {
  return Array.from({ length: 89 }, (_, i) => line(i + 1));
}

describe('describeCopyDifference', () => {
  it('says nothing for an exact copy', () => {
    expect(describeCopyDifference('same\ntext', 'same\ntext')).toBeUndefined();
    expect(describeCopyDifference('', '')).toBeUndefined();
  });

  it('describes one character that became another, on its line', () => {
    const text = lines();
    text[32] = text[32]!.replace('export job', 'export job');
    const copy = [...text];
    copy[32] = copy[32]!.replace(' ', ' ');
    expect(describeCopyDifference(text.join('\n'), copy.join('\n'))).toBe('line 33: a no-break space (U+00A0) became a space (U+0020)');
    expect(describeCopyDifference('one\ntwo\nkrać', 'one\ntwo\nkrac')).toBe('line 3: U+0107 became U+0063');
    expect(describeCopyDifference('a\tb', 'a b')).toBe('line 1: a tab (U+0009) became a space (U+0020)');
  });

  it('describes the first difference only, when the copy changes more after it', () => {
    const text = lines();
    text[32] = text[32]!.replace('export job', 'export job');
    const copy = [...text];
    copy[32] = copy[32]!.replace(' ', ' ');
    // 25 more characters and a line further on, as the first of the two attempts in the report did.
    copy.splice(34, 0, 'twenty-five more letters.');
    expect(describeCopyDifference(text.join('\n'), copy.join('\n'))).toBe('line 33: a no-break space (U+00A0) became a space (U+0020)');
  });

  it('describes one character added or left out', () => {
    expect(describeCopyDifference('one\ntwo\nthree', 'one\ntwo\r\nthree')).toBe('line 2: the copy adds a carriage return (U+000D)');
    expect(describeCopyDifference('one​two', 'onetwo')).toBe('line 1: the copy leaves out a zero-width space (U+200B)');
    expect(describeCopyDifference('one two', 'one, two')).toBe('line 1: the copy adds U+002C');
  });

  it('counts characters added or left out from where the copy first differed, and their line breaks', () => {
    const text = lines().join('\n');
    const at = text.indexOf('Line 33');
    const added = `${text.slice(0, at)}Twenty-four more letters\n${text.slice(at)}`;
    expect(describeCopyDifference(text, added)).toBe('line 33: the copy has 25 more characters from here, including a line break');
    const removed = text.slice(0, at) + text.slice(at + 25);
    expect(describeCopyDifference(text, removed)).toBe('line 33: the copy is missing 25 characters from here');
    const twoLines = text.slice(0, at) + text.slice(text.indexOf('Line 35'));
    expect(describeCopyDifference(text, twoLines)).toMatch(/^line 33: the copy is missing \d+ characters from here, including 2 line breaks$/);
  });

  it('finds an addition or a removal when the copy also differs further on', () => {
    const text = lines();
    const copy = [...text];
    copy[9] = copy[9]!.replace('made-up', 'very made-up');
    copy[60] = copy[60]!.replace('words', 'other words');
    expect(describeCopyDifference(text.join('\n'), copy.join('\n'))).toBe('line 10: the copy has 5 more characters from here');
    copy[9] = text[9]!.replace('made-up ', '');
    expect(describeCopyDifference(text.join('\n'), copy.join('\n'))).toBe('line 10: the copy is missing 8 characters from here');
  });

  it('says where a copy ends early, and how much it left out', () => {
    const text = lines().join('\n');
    const at = text.indexOf('Line 40');
    expect(describeCopyDifference(text, text.slice(0, at))).toBe(`line 40: the copy ends early, ${(text.length - at).toLocaleString('en')} characters short`);
    expect(describeCopyDifference('one\ntwo.', 'one\ntwo')).toBe('line 2: the copy ends early, 1 character short');
    expect(describeCopyDifference('one', '')).toBe('line 1: the copy ends early, 3 characters short');
  });

  it('says how much a copy adds at the end', () => {
    expect(describeCopyDifference('one\ntwo', 'one\ntwo, and twenty more letters')).toBe('line 2: the copy has 25 more characters from here');
    expect(describeCopyDifference('one\ntwo', 'one\ntwo\n')).toBe('line 2: the copy adds a line break (U+000A)');
  });

  it('says where a copy that was rewritten starts to differ', () => {
    expect(describeCopyDifference('Please run the tests and report back.', 'Please execute every check you can find, then stop.')).toBe(
      'line 1: the copy differs from here, with U+0065 in place of U+0072',
    );
  });

  it('counts a surrogate pair as one character, and never splits one', () => {
    expect(describeCopyDifference('smile \u{1f600}.', 'smile \u{1f603}.')).toBe('line 1: U+1F600 became U+1F603');
    expect(describeCopyDifference('smile.', 'smile \u{1f600}\u{1f600}.')).toBe('line 1: the copy has 3 more characters from here');
    expect(describeCopyDifference('a\u{1f600}b', 'ab')).toBe('line 1: the copy leaves out U+1F600');
  });

  it('counts lines by LF only', () => {
    expect(describeCopyDifference('one\rtwo three x', 'one\rtwo three y')).toBe('line 1: U+0078 became U+0079');
    expect(describeCopyDifference('one\n\n\nfour x', 'one\n\n\nfour y')).toBe('line 4: U+0078 became U+0079');
  });

  it('never includes the text, not even one character of it', () => {
    // Letters and marks a description never uses, so any of them in one would be the text.
    const alphabet = ['ж', 'ψ', 'é', 'ł', '✓', '–', 'ß', '中', '\u{1f600}'];
    const word = (n: number) => Array.from({ length: 3 + (n % 5) }, (_, i) => alphabet[(n * 7 + i) % alphabet.length]).join('');
    const text = Array.from({ length: 12 }, (_, line) => Array.from({ length: 6 }, (_, w) => word(line * 6 + w)).join(' ')).join('\n');
    const copies = [
      text.replace('ψ', 'ж'),
      text.replace(' ', ' '),
      text.replace('é', ''),
      text.replace('\n', '\nł✓–'),
      text.slice(0, 100),
      `${text}ßß中`,
      text.slice(0, 40) + [...text.slice(40)].reverse().join(''),
      '',
    ];
    for (const copy of copies) {
      const description = describeCopyDifference(text, copy)!;
      expect(description, 'a difference was found').toBeDefined();
      expect(/^[\x20-\x7e]+$/.test(description), `only pitwall's own ASCII words: ${description}`).toBe(true);
    }
    // And words of ASCII text don't appear either.
    const words = 'zebra quokka narwhal axolotl';
    for (const copy of [words.replace('quokka', 'quakka'), words.slice(0, 9), `${words} pangolin`, 'okapi']) {
      expect(describeCopyDifference(words, copy)).not.toMatch(/zeb|quo|qua|nar|axo|pan|oka/);
    }
  });
});
