// Sessions and PRs named in the supervisor's replies, as controls that open them (W125; Phil,
// 2026-11-02: each bold session name in "What sessions need me now?" should open that session).
// pitwall finds them itself, in the text it renders, so nothing depends on the model writing a
// format, and nothing the model or a session writes can make one: a mention is only ever of a
// session or a PR in pitwall's own snapshot and list, and only ever opens pitwall's own view of it.
// Pure, so the rules are easy to test; Markdown.tsx renders the parts.
//
// - **What matches:** a session's name, its short id (background sessions) or its full id, as a
//   whole: not inside a longer word, name, path or file name, so a letter, digit, mark, `_`, `-` or
//   `/` on either side, or a `.` with a letter or digit beyond it, means it isn't one. Any case.
//   Longest first, so "pr-894 docs" wins over "pr-894" where both are names, and the leftmost wins
//   where two overlap.
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

import { visibleParts } from '../../src/shared/hiddenText.js';
import type { PullRequestSummary, SessionSummary } from '../../src/shared/protocol.js';
import type { NotNeeded } from './notNeeded.js';
import { prKey, prName } from './prs.js';
import { needsAttention } from './sessions.js';

/** The fewest characters a name or id must have to be linked: "api" and "ui" are words first. */
export const MENTION_MIN_LENGTH = 4;

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

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const length = (text: string) => Array.from(text).length;
const key = (text: string) => text.toLowerCase();

/** Whether every character of `text` shows as itself (visibleParts()). */
const shows = (text: string) => visibleParts(text).every((part) => part.kind === 'text');

/**
 * The session a name means when several share it: the one that needs you, or else the one alive,
 * or none.
 */
function pick(sessions: readonly SessionSummary[], notNeeded: NotNeeded | undefined): SessionSummary | undefined {
  if (sessions.length === 1) return sessions[0];
  const needing = sessions.filter((session) => needsAttention(session, notNeeded));
  if (needing.length === 1) return needing[0];
  if (needing.length > 1) return undefined;
  const alive = sessions.filter((session) => session.alive && !session.ended);
  return alive.length === 1 ? alive[0] : undefined;
}

/**
 * The mentions pitwall can link: every session in `sessions`, by name, short id and id, and every PR
 * in `prs`. With neither, nothing is ever linked.
 */
export function createMentions(sessions: readonly SessionSummary[], prs: readonly PullRequestSummary[] = [], notNeeded?: NotNeeded): Mentions {
  // Each name or id, by its lowercase form, with every session it could mean.
  const byKey = new Map<string, { text: string; sessions: SessionSummary[] }>();
  for (const session of sessions) {
    const words = new Set([session.name.trim(), session.shortId ?? '', session.sessionId]);
    for (const word of words) {
      if (length(word) < MENTION_MIN_LENGTH || !shows(word)) continue;
      const entry = byKey.get(key(word)) ?? { text: word, sessions: [] };
      if (!entry.sessions.some((each) => each.sessionId === session.sessionId)) entry.sessions.push(session);
      byKey.set(key(word), entry);
    }
  }
  const targets = new Map<string, { target: MentionTarget; generic: boolean }>();
  for (const [lower, entry] of byKey) {
    const session = pick(entry.sessions, notNeeded);
    if (session === undefined) continue;
    targets.set(lower, { target: { kind: 'session', sessionId: session.sessionId, name: session.name }, generic: GENERIC.test(entry.text) });
  }
  const prsByKey = new Map(prs.map((pr) => [`${key(pr.repo)}#${pr.number}`, pr]));

  const specific = [...targets.entries()].filter(([, each]) => !each.generic).map(([lower]) => lower);
  // Longest first, so the longer of two names that start at the same place wins.
  specific.sort((a, b) => b.length - a.length);
  const names = specific.length === 0 ? undefined : new RegExp(`${BEFORE}(?:${specific.map(escape).join('|')})${AFTER}`, 'giu');

  function sessionParts(text: string, whole: boolean): MentionPart[] {
    if (whole) {
      const found = targets.get(key(text.trim()));
      if (found !== undefined && text.trim() !== '') {
        const start = text.indexOf(text.trim());
        return withText([
          { kind: 'text', text: text.slice(0, start) },
          { kind: 'mention', text: text.trim(), target: found.target },
          { kind: 'text', text: text.slice(start + text.trim().length) },
        ]);
      }
    }
    if (names === undefined) return [{ kind: 'text', text }];
    const parts: MentionPart[] = [];
    let at = 0;
    for (const match of text.matchAll(names)) {
      const found = targets.get(key(match[0]));
      if (found === undefined) continue;
      parts.push({ kind: 'text', text: text.slice(at, match.index) }, { kind: 'mention', text: match[0], target: found.target });
      at = match.index + match[0].length;
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

/** A mention's accessible name: what it does and to what, the name as pitwall knows it. */
export function mentionLabel(target: MentionTarget): string {
  const name = visibleParts(target.name)
    .map((part) => (part.kind === 'text' ? part.text : `[${part.label}]`))
    .join('');
  return target.kind === 'session' ? `Open session ${name}` : `Open pull request ${name}`;
}
