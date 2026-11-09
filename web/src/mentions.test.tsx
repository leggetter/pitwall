// Sessions and PRs named in the supervisor's replies (W125, mentions.ts): whole names only, longest
// first, any case, never too short, generic only when bold or italic on their own, never with a hidden
// character, and a shared name only when one session is plainly meant. All names are made up.

import { describe, expect, it } from 'vitest';
import { createMentions, mentionLabel, MENTION_MAX_LENGTH, MENTION_MIN_LENGTH, type MentionPart } from './mentions.js';
import { pr, session } from './test/fixtures.js';
import { bestTimes, slowBound } from './test/timing.js';

/** The parts as short strings: text as itself, a mention as [text→name]. */
const show = (parts: MentionPart[]) => parts.map((part) => (part.kind === 'text' ? part.text : `[${part.text}→${part.target.name}]`)).join('');

describe('createMentions: sessions', () => {
  const docs = session({ name: 'blog-agent-coordination' });
  const pr894 = session({ name: 'pr-894' });
  const pr894docs = session({ name: 'pr-894 docs' });
  const spaced = session({ name: 'acceptance test failures pr 477' });
  const mentions = createMentions([docs, pr894, pr894docs, spaced]);

  it('links whole names, with the punctuation around them left as text', () => {
    expect(show(mentions.split('pr-894 (website) needs you to pick A, B or C.'))).toBe('[pr-894→pr-894] (website) needs you to pick A, B or C.');
    expect(show(mentions.split('Then blog-agent-coordination, then pr-894.'))).toBe('Then [blog-agent-coordination→blog-agent-coordination], then [pr-894→pr-894].');
    expect(show(mentions.split('"pr-894": done; (pr-894)! pr-894?'))).toBe('"[pr-894→pr-894]": done; ([pr-894→pr-894])! [pr-894→pr-894]?');
    expect(show(mentions.split('acceptance test failures pr 477 has waited longest'))).toBe('[acceptance test failures pr 477→acceptance test failures pr 477] has waited longest');
  });

  it('matches any case, keeping the text as written and the name as pitwall knows it', () => {
    const parts = mentions.split('PR-894 is next');
    expect(show(parts)).toBe('[PR-894→pr-894] is next');
    expect(parts[0]).toMatchObject({ kind: 'mention', target: { kind: 'session', sessionId: pr894.sessionId } });
  });

  it('takes the longest of two names that start at the same place', () => {
    expect(show(mentions.split('pr-894 docs is idle, pr-894 waits'))).toBe('[pr-894 docs→pr-894 docs] is idle, [pr-894→pr-894] waits');
  });

  it("doesn't link a name inside a longer word, name, path or file name", () => {
    for (const text of ['pr-8945', 'xpr-894', 'old-pr-894', 'pr-894-fix', 'pr-894_b', 'src/pr-894', 'pr-894/notes', 'pr-894.md', 'v2.pr-894']) {
      expect(show(mentions.split(text)), text).toBe(text);
    }
  });

  it("doesn't link a name touched by a zero-width or bidi character", () => {
    for (const text of ['pr-894​', '‍pr-894', 'pr-894⁩ x', '‮pr-894']) expect(show(mentions.split(text)), JSON.stringify(text)).toBe(text);
  });

  it('never links a name with a character that doesn’t show as itself', () => {
    const hidden = session({ name: 'pr-​894' });
    const nbsp = session({ name: 'pr 894' });
    const only = createMentions([hidden, nbsp]);
    expect(show(only.split('pr-​894 and pr 894 and pr-894'))).toBe('pr-​894 and pr 894 and pr-894');
  });

  it("doesn't trim a character that doesn't show: U+FEFF or NBSP beside a name or a bold span", () => {
    const feff = createMentions([session({ name: '\uFEFFpr-894' }), session({ name: 'pr-895\u00a0' }), session({ name: '\uFEFFwebsite' }), session({ name: 'plain-name' })]);
    for (const text of ['\uFEFFpr-894', 'pr-894', 'pr-895\u00a0', 'pr-895']) expect(show(feff.split(text)), JSON.stringify(text)).toBe(text);
    for (const text of ['\uFEFFwebsite', 'website']) expect(show(feff.split(text, true)), JSON.stringify(text)).toBe(text);
    // The same span with a hidden character around a name that does show: not a link either.
    expect(show(feff.split('\uFEFFplain-name', true))).toBe('\uFEFFplain-name');
    const site = createMentions([session({ name: 'website' })]);
    for (const text of ['\uFEFFwebsite', 'website\u00a0', '\u00a0website', 'website\uFEFF']) expect(show(site.split(text, true)), JSON.stringify(text)).toBe(text);
    expect(show(site.split(' website ', true))).toBe(' [website→website] ');
    // Spaces and tabs around it are still the text's, outside the button.
    expect(show(feff.split(' \tplain-name \n', true))).toBe(' \t[plain-name→plain-name] \n');
  });

  it('folds case the same way on both sides, so a name with İ links', () => {
    const turkish = createMentions([session({ name: 'İstanbul-fix' }), session({ name: 'Straße-fix' })]);
    expect(show(turkish.split('İstanbul-fix and Straße-fix and STRAßE-FIX'))).toBe('[İstanbul-fix→İstanbul-fix] and [Straße-fix→Straße-fix] and [STRAßE-FIX→Straße-fix]');
    // "i̇" (i and a combining dot) is not "İ": a different text, so a different name.
    expect(show(turkish.split('i̇stanbul-fix'))).toBe('i̇stanbul-fix');
  });

  // A fixed 100 ms failed on CI's shared runners while other test files kept them busy (W149), so this
  // times a thousand names against 250, in turn. On a 2026 laptop splitting takes about 1 ms either way,
  // and setting up about 4 times as long for 4 times the names. A scan of every name at every place in
  // the reply would split 4 times slower (about 90 ms), and setting up in quadratic time, 16 times.
  it('finds a thousand long names with a shared prefix in a long reply as fast as 250, and sets them up in about 4 times as long', () => {
    const names = (count: number) => Array.from({ length: count }, (_, n) => session({ name: `pitwall-test-session-number-${n}-feature` }));
    const [thousand, quarter] = [names(1000), names(250)];
    const sentence = 'pitwall-test-session-number-7-feature needs you; pitwall-test-session-number-999-feature, pitwall-test-session-number-1000-feature is not a session, and so on for a while. ';
    const reply = sentence.repeat(120); // about 20 KB
    const [many, few] = [createMentions(thousand), createMentions(quarter)];
    expect(many.split(reply).filter((part) => part.kind === 'mention')).toHaveLength(240);
    expect(few.split(reply).filter((part) => part.kind === 'mention')).toHaveLength(120);

    const [manyMs, fewMs] = bestTimes([() => many.split(reply), () => few.split(reply)]);
    expect(manyMs).toBeLessThan(slowBound(fewMs!, { floorMs: 5, ratio: 2.5, ceilingMs: 100 }));
    const [setUpManyMs, setUpFewMs] = bestTimes([() => createMentions(thousand), () => createMentions(quarter)], 3);
    expect(setUpManyMs).toBeLessThan(slowBound(setUpFewMs!, { floorMs: 0, ratio: 10, ceilingMs: 250 }));
  });

  it(`never links a name under ${MENTION_MIN_LENGTH} characters, even in bold`, () => {
    const short = createMentions([session({ name: 'api' }), session({ name: 'ui' }), session({ name: 'a-1' })]);
    expect(show(short.split('the api and the ui, a-1'))).toBe('the api and the ui, a-1');
    expect(show(short.split('api', true))).toBe('api');
    expect(show(createMentions([session({ name: 'a-12' })]).split('a-12 waits'))).toBe('[a-12→a-12] waits');
  });

  it('links a generic name only as the whole of a bold or italic span', () => {
    const generic = createMentions([session({ name: 'website' }), session({ name: '2024' })]);
    expect(show(generic.split('pr-894 (website) is in the website repo, since 2024'))).toBe('pr-894 (website) is in the website repo, since 2024');
    expect(show(generic.split('Website', true))).toBe('[Website→website]');
    expect(show(generic.split(' 2024 ', true))).toBe(' [2024→2024] ');
    expect(show(generic.split('the website', true))).toBe('the website');
  });

  it('links a background session’s short id and a full id', () => {
    const job = session({ name: 'nightly-build', kind: 'background', shortId: 'a1b2c3d4' });
    const both = createMentions([job]);
    expect(show(both.split(`a1b2c3d4 and ${job.sessionId}`))).toBe(`[a1b2c3d4→nightly-build] and [${job.sessionId}→nightly-build]`);
  });

  it('links a shared name to the one that needs you, or else the one alive, or not at all', () => {
    const idle = session({ name: 'shared-name' });
    const waiting = session({ name: 'shared-name', status: 'waiting' });
    const ended = session({ name: 'shared-name', alive: false, finished: true });
    expect(createMentions([idle, waiting]).split('shared-name')[0]).toMatchObject({ kind: 'mention', target: { sessionId: waiting.sessionId } });
    expect(createMentions([idle, ended]).split('shared-name')[0]).toMatchObject({ kind: 'mention', target: { sessionId: idle.sessionId } });
    const other = session({ name: 'shared-name' });
    expect(show(createMentions([idle, other]).split('shared-name'))).toBe('shared-name');
    expect(show(createMentions([waiting, session({ name: 'Shared-Name', status: 'waiting' })]).split('shared-name'))).toBe('shared-name');
  });

  it('counts a session listed twice once', () => {
    const one = session({ name: 'listed-twice' });
    expect(createMentions([one, { ...one }]).split('listed-twice')[0]).toMatchObject({ kind: 'mention' });
  });

  it('takes a name with regex characters as written', () => {
    const odd = createMentions([session({ name: 'fix (a+b)*' })]);
    expect(show(odd.split('see fix (a+b)* now, not fix aab'))).toBe('see [fix (a+b)*→fix (a+b)*] now, not fix aab');
  });

  it('links nothing with no sessions or PRs', () => {
    expect(createMentions([]).split('pr-894')).toEqual([{ kind: 'text', text: 'pr-894' }]);
  });
});

describe('createMentions: PRs', () => {
  const listed = pr({ number: 51, repoLabel: 'Example/Demo-App' });
  const mentions = createMentions([session({ name: 'demo-app-fix' })], [listed]);

  it('links owner/name#n for a PR in the list, in any case', () => {
    const parts = mentions.split('See example/demo-app#51, and Example/Demo-App#51.');
    expect(show(parts)).toBe('See [example/demo-app#51→Example/Demo-App #51], and [Example/Demo-App#51→Example/Demo-App #51].');
    expect(parts[1]).toMatchObject({ target: { kind: 'pr', key: 'example/demo-app/51' } });
  });

  it("doesn't link a PR pitwall doesn't list, a bare #n or one inside a longer path", () => {
    expect(show(mentions.split('example/demo-app#52, #51, x/example/demo-app#51, example/demo-app#510'))).toBe('example/demo-app#52, #51, x/example/demo-app#51, example/demo-app#510');
  });

  it('links sessions around a PR', () => {
    expect(show(mentions.split('demo-app-fix owns example/demo-app#51; demo-app-fix waits'))).toBe('[demo-app-fix→demo-app-fix] owns [example/demo-app#51→Example/Demo-App #51]; [demo-app-fix→demo-app-fix] waits');
  });
});

describe('mentionLabel', () => {
  it('says what it opens, and holds the visible text as it shows (WCAG 2.5.3), with any hidden character drawn as its code', () => {
    const session = { kind: 'session', sessionId: 'x', name: 'pr-894' } as const;
    expect(mentionLabel(session)).toBe('Open session pr-894');
    expect(mentionLabel(session, 'pr-894')).toBe('Open session pr-894');
    expect(mentionLabel(session, 'PR-894')).toBe('Open session PR-894');
    expect(mentionLabel(session, 'a1b2c3d4')).toBe('Open session a1b2c3d4 (pr-894)');
    expect(mentionLabel({ kind: 'pr', key: 'example/demo-app/51', name: 'Example/Demo-App #51' }, 'example/demo-app#51')).toBe('Open pull request example/demo-app#51');
    expect(mentionLabel({ kind: 'session', sessionId: 'x', name: 'a​b' })).toBe('Open session a[U+200B]b');
  });
});

// W129, the re-review's L2: matching costs the reply's length times the longest name's, so a name
// over MENTION_MAX_LENGTH is never linked, and a long name with a long reply still splits quickly.
describe('createMentions: long names', () => {
  it('leaves a name over MENTION_MAX_LENGTH characters out, and links one at it', () => {
    // Not generic, so they'd link anywhere in a sentence.
    const atMost = 'a'.repeat(MENTION_MAX_LENGTH - 2) + '-z';
    const over = 'b'.repeat(MENTION_MAX_LENGTH - 1) + '-z';
    const mentions = createMentions([session({ name: atMost }), session({ name: over })]);
    expect(show(mentions.split(`${atMost} and ${over}`))).toBe(`[${atMost}→${atMost}] and ${over}`);
    expect(show(mentions.split(over, true))).toBe(over);
  });

  it('splits a 40,000-character reply quickly with a 10,000-character name, and one just under the cap, that it nearly matches everywhere', () => {
    const huge = 'a'.repeat(10_000) + '-x';
    const capped = 'a'.repeat(MENTION_MAX_LENGTH - 2) + '-x';
    const mentions = createMentions([session({ name: huge }), session({ name: capped }), session({ name: 'pr-894' })]);
    const reply = 'a'.repeat(40_000);
    const started = performance.now();
    const parts = mentions.split(reply);
    const spaced = mentions.split(Array.from({ length: 4_000 }, () => 'aaaaaaaaa').join(' '));
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(parts).toEqual([{ kind: 'text', text: reply }]);
    expect(spaced).toHaveLength(1);
  });
});
