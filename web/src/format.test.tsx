import { describe, expect, it } from 'vitest';
import { middleEllipsisParts, plainText, relativeTime, shortenHome, updatedAgo } from './format.js';
import { attachCommand, needsAttention, needsText, rowStatusBadge, statusBadge, type SessionStatus } from './sessions.js';
import { NOW, session } from './test/fixtures.js';

describe('shortenHome', () => {
  it('shortens macOS and Linux home directories', () => {
    expect(shortenHome('/Users/example/code')).toBe('~/code');
    expect(shortenHome('/home/example/code')).toBe('~/code');
    expect(shortenHome('/Users/example')).toBe('~');
  });

  it('leaves other paths alone', () => {
    expect(shortenHome('/srv/projects')).toBe('/srv/projects');
    expect(shortenHome('/Users')).toBe('/Users');
    expect(shortenHome('/var/Users/example')).toBe('/var/Users/example');
  });
});

describe('middleEllipsisParts', () => {
  it('keeps the last segment, from its slash, for the end that always shows', () => {
    expect(middleEllipsisParts('~/code/pitwall/packages/web')).toEqual({ start: '~/code/pitwall/packages', end: '/web' });
    expect(middleEllipsisParts('~/code, /srv/projects')).toEqual({ start: '~/code, /srv', end: '/projects' });
  });

  it('has no end when there is no slash after the first character, so the text is only cut at its end', () => {
    expect(middleEllipsisParts('pitwall')).toEqual({ start: 'pitwall', end: '' });
    expect(middleEllipsisParts('/srv')).toEqual({ start: '/srv', end: '' });
  });

  it('puts the two parts back together as the text', () => {
    for (const text of ['~/a/b', '~/', '/', '', 'a/b/']) {
      const { start, end } = middleEllipsisParts(text);
      expect(start + end).toBe(text);
    }
  });
});

describe('relativeTime and updatedAgo', () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();

  it('reads naturally across ranges', () => {
    expect(relativeTime(at(2_000), NOW)).toBe('just now');
    expect(relativeTime(at(42_000), NOW)).toBe('42s ago');
    expect(relativeTime(at(5 * 60_000), NOW)).toBe('5m ago');
    expect(relativeTime(at(3 * 3_600_000), NOW)).toBe('3h ago');
    expect(relativeTime(at(3 * 86_400_000), NOW)).toBe('3d ago');
    expect(relativeTime(at(-60_000), NOW)).toBe('just now');
    expect(relativeTime('not a date', NOW)).toBe('unknown');
  });

  it('counts seconds for the update age', () => {
    expect(updatedAgo(at(0), NOW)).toBe('updated 0s ago');
    expect(updatedAgo(at(7_000), NOW)).toBe('updated 7s ago');
    expect(updatedAgo(at(-5_000), NOW)).toBe('updated 0s ago');
    expect(updatedAgo(at(120_000), NOW)).toBe('updated 2m ago');
  });
});

describe('plainText', () => {
  it('keeps ordinary text, tabs and newlines', () => {
    expect(plainText('a\tb\nc <b>d</b>')).toBe('a\tb\nc <b>d</b>');
  });

  it('removes terminal escapes, control characters and bidi overrides', () => {
    expect(plainText('\u001b[1;31mred\u001b[0m')).toBe('red');
    expect(plainText('\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007')).toBe('link');
    expect(plainText('a\u0000b\u0007c\r\n')).toBe('abc\n');
    expect(plainText('‮gnp.exe')).toBe('gnp.exe');
  });
});

describe('plainText and the bidi marks (W87)', () => {
  it('drops the marks the server refuses too, U+061C, U+200E and U+200F, as it drops embeddings, overrides and isolates', () => {
    expect(plainText('a\u061cb\u200ec\u200fd')).toBe('abcd');
    expect(plainText('\u202ax\u202c\u2066y\u2069')).toBe('xy');
  });

  it("keeps an emoji's joiner and variation selector, which are default-ignorable but drawn as part of the emoji", () => {
    const family = '\u{1f469}\u200d\u{1f467}';
    const heart = '\u2764\ufe0f';
    expect(plainText(`${family} ${heart}`)).toBe(`${family} ${heart}`);
  });
});

describe('session helpers', () => {
  it("needsAttention is exactly the sessions with the index's needsYou (W69), never stale, finished or ended", () => {
    for (const reason of ['prompt', 'claude-code', 'asked', 'restarted', 'blocked'] as const) {
      expect(needsAttention(session({ needsYou: { reason } })), reason).toBe(true);
    }
    // Blocked alone isn't a reason: a resumed job's "send a prompt to start" asks nothing.
    expect(needsAttention(session({ kind: 'background', state: 'blocked', needsYou: undefined }))).toBe(false);
    expect(needsAttention(session({ status: 'waiting', askedYou: { reason: 'question', excerpt: 'Ship it?' }, needsYou: undefined }))).toBe(false);
    // Never stale, finished or ended, whatever the snapshot says.
    expect(needsAttention(session({ kind: 'background', state: 'blocked', stale: true, needsYou: { reason: 'blocked' } }))).toBe(false);
    expect(needsAttention(session({ finished: true, needsYou: { reason: 'asked' } }))).toBe(false);
    expect(needsAttention(session({ ended: true, finished: true, needsYou: { reason: 'restarted' } }))).toBe(false);
  });

  it('needsAttention covers waiting, blocked and asked you, never stale', () => {
    expect(needsAttention(session({ status: 'waiting' }))).toBe(true);
    expect(needsAttention(session({ kind: 'background', state: 'blocked' }))).toBe(true);
    expect(needsAttention(session({ status: 'idle', askedYou: { reason: 'question', excerpt: 'Ship it?' } }))).toBe(true);
    expect(needsAttention(session({ kind: 'background', state: 'blocked', stale: true, alive: false }))).toBe(false);
    expect(
      needsAttention(session({ stale: true, askedYou: { reason: 'question', excerpt: 'Ship it?' } })),
    ).toBe(false);
    expect(needsAttention(session({ status: 'busy' }))).toBe(false);
    expect(needsAttention(session({ kind: 'background', state: 'failed' }))).toBe(false);
  });

  it('needsAttention never counts a finished session, even one that asked something', () => {
    const asked = { reason: 'question' as const, excerpt: 'Open a PR?' };
    for (const state of ['done', 'stopped', 'failed'] as const) {
      expect(
        needsAttention(session({ kind: 'background', state, alive: false, pid: undefined, status: undefined, finished: true, askedYou: asked })),
        state,
      ).toBe(false);
    }
    // Done with its process still alive is idle, not finished, so its question counts.
    expect(needsAttention(session({ kind: 'background', state: 'done', status: 'idle', askedYou: asked }))).toBe(true);
  });

  it('statusBadge puts waiting first, then blocked unless stale, then asked you, then the rest', () => {
    const asked = { reason: 'open-questions' as const, excerpt: 'Should I push it?' };
    const badge = (overrides: Parameters<typeof session>[0]) => statusBadge(session(overrides));
    expect(badge({ status: 'waiting', waitingFor: 'input needed', askedYou: asked })).toEqual({
      status: 'waiting',
      label: 'Waiting: input needed',
      look: 'solid-warning',
    });
    // As the index puts them: asked you before blocked where pitwall couldn't read the job's file.
    expect(badge({ kind: 'background', state: 'blocked', askedYou: asked })).toEqual({ status: 'asked', label: 'Asked you', look: 'subtle-warning' });
    expect(badge({ kind: 'background', state: 'blocked' })).toEqual({ status: 'blocked', label: 'Blocked', look: 'solid-warning' });
    expect(badge({ status: 'idle', askedYou: asked })).toEqual({ status: 'asked', label: 'Asked you', look: 'subtle-warning' });
    // Finished: the state, not the question, which the row shows apart, as an outline badge.
    expect(badge({ kind: 'background', state: 'done', alive: false, status: undefined, finished: true, askedYou: asked })).toEqual({
      status: 'done',
      label: 'Done',
      look: 'subtle-success',
    });
    expect(badge({ kind: 'background', state: 'failed', alive: false, pid: undefined, status: undefined, finished: true, askedYou: asked })).toEqual({
      status: 'failed',
      label: 'Failed',
      look: 'subtle-danger',
    });
    // Done with a live process is idle, so its question still leads.
    expect(badge({ kind: 'background', state: 'done', status: 'idle', askedYou: asked })).toEqual({ status: 'asked', label: 'Asked you', look: 'subtle-warning' });
    expect(badge({ kind: 'background', state: 'blocked', stale: true, alive: false })).toEqual({ status: 'blocked-stale', label: 'Blocked', look: 'outline' });
    expect(badge({ kind: 'background', state: 'blocked', stale: true, askedYou: asked })).toEqual({ status: 'blocked-stale', label: 'Blocked', look: 'outline' });
    expect(badge({ status: 'idle' })).toEqual({ status: 'idle', label: 'Idle', look: 'subtle-neutral' });
  });

  it("statusBadge follows needsYou's reason: solid for each but asked you (W69)", () => {
    const asked = { reason: 'question' as const, excerpt: 'Ship it?' };
    const job = { kind: 'background' as const, shortId: 'bg1', state: 'blocked' as const, status: 'idle' as const };
    const badge = (overrides: Parameters<typeof session>[0]) => statusBadge(session(overrides));
    expect(badge({ status: 'waiting', waitingFor: 'permission prompt', needsYou: { reason: 'prompt' } })).toEqual({
      status: 'waiting',
      label: 'Waiting: permission prompt',
      look: 'solid-warning',
    });
    expect(badge({ ...job, needsYou: { reason: 'claude-code', text: 'Tea or coffee?' } })).toEqual({ status: 'blocked', label: 'Blocked', look: 'solid-warning' });
    expect(badge({ ...job, needsYou: { reason: 'blocked' } })).toEqual({ status: 'blocked', label: 'Blocked', look: 'solid-warning' });
    expect(badge({ ...job, state: 'working', status: 'busy', needsYou: { reason: 'restarted' } })).toEqual({
      status: 'restarted',
      label: 'Waiting for your prompt',
      look: 'solid-warning',
    });
    expect(badge({ status: 'busy', askedYou: asked, needsYou: { reason: 'asked' } })).toEqual({ status: 'asked', label: 'Asked you', look: 'subtle-warning' });
  });

  it('statusBadge shows a blocked job that needs nothing of you as its process is: idle, busy or not running (W69)', () => {
    const job = { kind: 'background' as const, shortId: 'bg1', state: 'blocked' as const, needsYou: undefined };
    expect(statusBadge(session({ ...job, status: 'idle' }))).toEqual({ status: 'idle', label: 'Idle', look: 'subtle-neutral' });
    expect(statusBadge(session({ ...job, status: undefined }))).toEqual({ status: 'idle', label: 'Idle', look: 'subtle-neutral' });
    expect(rowStatusBadge(session({ ...job, status: 'idle' }))).toBeUndefined();
    expect(statusBadge(session({ ...job, status: 'busy' }))).toMatchObject({ status: 'busy', label: 'Busy' });
    expect(statusBadge(session({ ...job, alive: false, pid: undefined, status: undefined }))).toEqual({ status: 'not-running', label: 'Not running', look: 'outline' });
    // A stale one keeps its outline badge.
    expect(statusBadge(session({ ...job, stale: true, alive: false }))).toEqual({ status: 'blocked-stale', label: 'Blocked', look: 'outline' });
  });

  it('needsText is the job line, only while it is why the session needs you', () => {
    const job = { kind: 'background' as const, shortId: 'bg1', state: 'blocked' as const };
    expect(needsText(session({ ...job, needsYou: { reason: 'claude-code', text: 'Do you prefer tea or coffee?' } }))).toBe('Do you prefer tea or coffee?');
    expect(needsText(session({ ...job, needsYou: { reason: 'claude-code', text: '   ' } }))).toBeUndefined();
    expect(needsText(session({ ...job, needsYou: { reason: 'blocked' } }))).toBeUndefined();
    expect(needsText(session({ ...job, stale: true, needsYou: { reason: 'claude-code', text: 'Old?' } }))).toBeUndefined();
  });

  it("statusBadge gives each state the Badges table's label and look, in sentence case, with a dot for busy and working", () => {
    const cases: [Parameters<typeof session>[0], SessionStatus, string, string, boolean][] = [
      [{ kind: 'background', state: 'blocked', waitingFor: 'input needed' }, 'blocked', 'Blocked: input needed', 'solid-warning', false],
      [{ status: 'waiting' }, 'waiting', 'Waiting', 'solid-warning', false],
      [{ kind: 'background', state: 'stopped', alive: false, status: undefined }, 'stopped', 'Stopped', 'subtle-neutral', false],
      [{ alive: false, status: undefined }, 'not-running', 'Not running', 'outline', false],
      [{ status: 'busy' }, 'busy', 'Busy', 'subtle-info', true],
      [{ kind: 'background', state: 'working', status: undefined }, 'working', 'Working', 'subtle-info', true],
      [{ status: undefined }, 'unknown', 'Unknown', 'subtle-neutral', false],
    ];
    for (const [overrides, status, label, look, dot] of cases) {
      const badge = statusBadge(session(overrides));
      expect({ status: badge.status, label: badge.label, look: badge.look, dot: badge.dot === true }).toEqual({ status, label, look, dot });
    }
  });

  it('rowStatusBadge leaves out Idle, which only the session view shows, and nothing else', () => {
    expect(rowStatusBadge(session({ status: 'idle' }))).toBeUndefined();
    expect(rowStatusBadge(session({ status: undefined }))?.label).toBe('Unknown');
    expect(rowStatusBadge(session({ status: 'busy' }))?.label).toBe('Busy');
    expect(rowStatusBadge(session({ status: 'idle', askedYou: { reason: 'question', excerpt: 'Ship it?' } }))?.label).toBe('Asked you');
  });

  it('attachCommand is only for background sessions with a plain short id', () => {
    expect(attachCommand(session({ kind: 'background', shortId: 'ab12-cd' }))).toBe('claude attach ab12-cd');
    expect(attachCommand(session({ kind: 'background' }))).toBeUndefined();
    expect(attachCommand(session({ kind: 'interactive', shortId: 'ab12' }))).toBeUndefined();
    expect(attachCommand(session({ kind: 'background', shortId: '$(touch x)' }))).toBeUndefined();
  });
});
