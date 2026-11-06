// Sessions and PRs named in the supervisor's replies, as controls that open them (W125; Phil,
// 2026-11-02: each bold session name in "What sessions need me now?" should open that session).
// pitwall finds them itself, in the text it renders, so nothing depends on the model writing a
// format, and nothing the model or a session writes can make one: a mention is only ever of a
// session or a PR in pitwall's own snapshot and list, and only ever opens pitwall's own view of it.
// Pure, so the rules are easy to test; Markdown.tsx renders the parts.
//
// - **What matches:** a session's name, its short id (background sessions) or its full id, as a
//   whole: not inside a longer word, name, path or file name, so a letter, digit, mark, `_`, `-` or
//   `/` on either side, or a `.` with a letter or digit beyond it, means it isn't one. Any case,
//   by one simple fold (each character to its lowercase when that's one character, else as it is)
//   applied to the names and the text alike. Longest first, so "pr-894 docs" wins over "pr-894"
//   where both are names, and the leftmost wins where two overlap. Found with a trie of the names
//   walked from each place a name could start, so the cost follows the text and the longest
//   name, not how many names there are: text length times name length, so a name over
//   MENTION_MAX_LENGTH characters is never linked (W129, the re-review's L2).
// - **What doesn't:** a name shorter than MENTION_MIN_LENGTH characters, which plain words would
//   match ("api", "ui"); a generic name, one word of letters only or digits only ("website", "docs",
//   "2024"), unless it's the whole of a bold or italic span, as the supervisor writes a session's
//   name (its prompt, v4), since a word in a sentence is more likely the word than the session; a
//   name with a character that doesn't show as itself (src/shared/hiddenText.ts, W120), so a look-alike
//   with a zero-width or bidi character in it never links, nor does a match that one touches; and a
//   name two sessions share, unless one of them needs you, or else only one is alive, when it's that
//   one. Code, code blocks and links' text are never searched (Markdown.tsx).
// - **PRs:** `owner/name#123`, as a whole, for a PR in pitwall's own list, in any case. A bare `#123`
//   isn't one: which repo it is would be a guess.

import { visibleParts, visibleString } from '../../src/shared/hiddenText.js';
import type { PullRequestSummary, SessionSummary } from '../../src/shared/protocol.js';
import { prKey, prName } from './prs.js';
import { needsAttention } from './sessions.js';

/** The fewest characters a name or id must have to be linked: "api" and "ui" are words first. */
export const MENTION_MIN_LENGTH = 4;

/** The most characters a name may have to be linked (W129, L2): each place in a reply may walk this far. */
export const MENTION_MAX_LENGTH = 200;

/** What a mention opens. */
export type MentionTarget = { kind: 'session'; sessionId: string; name: string } | { kind: 'pr'; key: string; name: string };

/** A text cut into what's plain and what's a mention, `text` as written in either. */
export type MentionPart = { kind: 'text'; text: string } | { kind: 'mention'; text: string; target: MentionTarget };

export interface Mentions {
  /** `text` cut into parts. `whole` when it's the whole of a bold or italic span, where a generic name links too. */
  split(text: string, whole?: boolean): MentionPart[];
}

/** One word of letters only, or of digits only: a word before it's a name. */
const GENERIC = /^(?:\p{L}+|\p{N}+)$/u;

/** A character that, beside a match, makes it part of something longer: a word, a name, a path. */
const JOINS = String.raw`[\p{L}\p{N}\p{M}_\-/\p{Cf}\p{Default_Ignorable_Code_Point}]`;
const BEFORE = String.raw`(?<!${JOINS})(?<![\p{L}\p{N}]\.)`;
const AFTER = String.raw`(?!${JOINS})(?!\.[\p{L}\p{N}])`;

/** A PR as `owner/name#123`: GitHub's owner and repo name characters. */
const PR = new RegExp(String.raw`${BEFORE}([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9})${AFTER}`, 'gu');

const length = (text: string) => Array.from(text).length;

/** A character in lowercase when that is one code point of the same length, else as it is ("İ" stays). */
function foldChar(char: string): string {
  const lower = char.toLowerCase();
  return lower.length === char.length && length(lower) === 1 ? lower : char;
}
/** Both sides of every comparison go through this one fold. */
const key = (text: string) => Array.from(text, foldChar).join('');

/** Whether every character of `text` shows as itself (visibleParts()). */
const shows = (text: string) => visibleParts(text).every((part) => part.kind === 'text');

/** `text` without the spaces and tabs (and newlines) at its ends, and only those: not U+FEFF or NBSP, which don't show. */
const trimPlain = (text: string) => text.replace(/^[ \t\n]+|[ \t\n]+$/g, '');

const JOIN = new RegExp(`^${JOINS}$`, 'u');
const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;

/** A name on a path through the trie: each step a folded character; a hit where a name ends. */
interface Node {
  next: Map<string, Node>;
  target?: MentionTarget;
}

/**
 * The session a name means when several share it: the one that needs you, or else the one alive,
 * or none.
 */
function pick(sessions: readonly SessionSummary[]): SessionSummary | undefined {
  if (sessions.length === 1) return sessions[0];
  const needing = sessions.filter((session) => needsAttention(session));
  if (needing.length === 1) return needing[0];
  if (needing.length > 1) return undefined;
  const alive = sessions.filter((session) => session.alive && !session.ended);
  return alive.length === 1 ? alive[0] : undefined;
}

/**
 * The mentions pitwall can link: every session in `sessions`, by name, short id and id, and every PR
 * in `prs`. With neither, nothing is ever linked.
 */
export function createMentions(sessions: readonly SessionSummary[], prs: readonly PullRequestSummary[] = []): Mentions {
  // Each name or id, by its lowercase form, with every session it could mean.
  const byKey = new Map<string, { text: string; sessions: SessionSummary[] }>();
  for (const session of sessions) {
    const words = new Set([trimPlain(session.name), session.shortId ?? '', session.sessionId]);
    for (const word of words) {
      const chars = length(word);
      if (chars < MENTION_MIN_LENGTH || chars > MENTION_MAX_LENGTH || !shows(word)) continue;
      const entry = byKey.get(key(word)) ?? { text: word, sessions: [] };
      if (!entry.sessions.some((each) => each.sessionId === session.sessionId)) entry.sessions.push(session);
      byKey.set(key(word), entry);
    }
  }
  const targets = new Map<string, { target: MentionTarget; generic: boolean }>();
  for (const [lower, entry] of byKey) {
    const session = pick(entry.sessions);
    if (session === undefined) continue;
    targets.set(lower, { target: { kind: 'session', sessionId: session.sessionId, name: session.name }, generic: GENERIC.test(entry.text) });
  }
  const prsByKey = new Map(prs.map((pr) => [`${key(pr.repo)}#${pr.number}`, pr]));

  // A trie of the names that link anywhere in a sentence; the generic ones link only as a whole span.
  const root: Node = { next: new Map() };
  for (const [folded, each] of targets) {
    if (each.generic) continue;
    let node = root;
    for (const char of folded) {
      let next = node.next.get(char);
      if (next === undefined) node.next.set(char, (next = { next: new Map() }));
      node = next;
    }
    node.target = each.target;
  }
  const searchable = root.next.size > 0;

  /** Whether a name may start at code point `at`: nothing that joins before it, and not `x.` before it. */
  const startsHere = (chars: string[], at: number) =>
    !(at > 0 && JOIN.test(chars[at - 1]!)) && !(at > 1 && chars[at - 1] === '.' && LETTER_OR_DIGIT.test(chars[at - 2]!));
  /** Whether a name may end before code point `end`: nothing that joins after it, and not `.x` after it. */
  const endsHere = (chars: string[], end: number) =>
    !(end < chars.length && JOIN.test(chars[end]!)) && !(end + 1 < chars.length && chars[end] === '.' && LETTER_OR_DIGIT.test(chars[end + 1]!));

  function sessionParts(text: string, whole: boolean): MentionPart[] {
    // The check is on the text as written: trimming first would drop U+FEFF and NBSP, which don't show.
    if (whole && shows(text)) {
      const core = trimPlain(text);
      const found = core === '' ? undefined : targets.get(key(core));
      if (found !== undefined) {
        const start = text.indexOf(core);
        return withText([
          { kind: 'text', text: text.slice(0, start) },
          { kind: 'mention', text: core, target: found.target },
          { kind: 'text', text: text.slice(start + core.length) },
        ]);
      }
    }
    if (!searchable) return [{ kind: 'text', text }];
    const chars = Array.from(text);
    const folded = chars.map(foldChar);
    const offsets: number[] = [0];
    for (const char of chars) offsets.push(offsets[offsets.length - 1]! + char.length);
    const parts: MentionPart[] = [];
    let at = 0; // in UTF-16 units, where the plain text after the last mention starts
    for (let i = 0; i < chars.length; ) {
      let node = root.next.get(folded[i]!);
      if (node === undefined || !startsHere(chars, i)) {
        i++;
        continue;
      }
      let end = -1;
      let target: MentionTarget | undefined;
      for (let j = i + 1; ; j++) {
        if (node.target !== undefined && endsHere(chars, j)) {
          end = j;
          target = node.target;
        }
        const next: Node | undefined = j < chars.length ? node.next.get(folded[j]!) : undefined;
        if (next === undefined) break;
        node = next;
      }
      if (target === undefined) {
        i++;
        continue;
      }
      parts.push({ kind: 'text', text: text.slice(at, offsets[i]) }, { kind: 'mention', text: text.slice(offsets[i], offsets[end]), target });
      at = offsets[end]!;
      i = end;
    }
    parts.push({ kind: 'text', text: text.slice(at) });
    return withText(parts);
  }

  return {
    split(text, whole = false) {
      if (text === '' || (targets.size === 0 && prsByKey.size === 0)) return [{ kind: 'text', text }];
      const parts: MentionPart[] = [];
      let at = 0;
      if (prsByKey.size > 0) {
        for (const match of text.matchAll(PR)) {
          const pr = prsByKey.get(`${key(match[1]!)}#${match[2]}`);
          if (pr === undefined) continue;
          parts.push(...sessionParts(text.slice(at, match.index), false), { kind: 'mention', text: match[0], target: { kind: 'pr', key: prKey(pr), name: prName(pr) } });
          at = match.index + match[0].length;
        }
      }
      parts.push(...sessionParts(text.slice(at), whole && at === 0));
      return withText(parts);
    },
  };
}

/** The parts without empty text. */
function withText(parts: MentionPart[]): MentionPart[] {
  const kept = parts.filter((part) => part.kind === 'mention' || part.text !== '');
  return kept.length === 0 ? [{ kind: 'text', text: '' }] : kept;
}

/**
 * A mention's accessible name (WCAG 2.5.3, Label in Name): what it does, then the text as it shows,
 * so the name holds the visible text, then the name as pitwall knows it when that isn't the text
 * (an id, or another case). A hidden character is drawn as its code.
 */
export function mentionLabel(target: MentionTarget, text: string = target.name): string {
  const shown = visibleString(text);
  if (target.kind === 'pr') return `Open pull request ${shown}`;
  const name = visibleString(target.name);
  return key(shown) === key(name) ? `Open session ${shown}` : `Open session ${shown} (${name})`;
}
