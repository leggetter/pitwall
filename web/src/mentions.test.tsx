// Sessions and PRs named in the supervisor's replies (W125, mentions.ts): whole names only, longest
// first, any case, never too short, generic only when bold or italic on their own, never with a hidden
// character, and a shared name only when one session is plainly meant. All names are made up.

import { describe, expect, it } from 'vitest';
import { createMentions, mentionLabel, MENTION_MIN_LENGTH, type MentionPart } from './mentions.js';
import { pr, session } from './test/fixtures.js';

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
  it('says what it opens, with any hidden character drawn as its code', () => {
    expect(mentionLabel({ kind: 'session', sessionId: 'x', name: 'pr-894' })).toBe('Open session pr-894');
    expect(mentionLabel({ kind: 'pr', key: 'example/demo-app/51', name: 'example/demo-app #51' })).toBe('Open pull request example/demo-app #51');
    expect(mentionLabel({ kind: 'session', sessionId: 'x', name: 'a​b' })).toBe('Open session a[U+200B]b');
  });
});
