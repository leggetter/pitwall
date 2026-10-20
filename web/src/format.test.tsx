import { describe, expect, it } from 'vitest';
import { middleEllipsisParts, plainText, relativeTime, shortenHome, updatedAgo } from './format.js';
import { attachCommand, needsAttention, rowStatusBadge, splitFinished, statusBadge, type SessionStatus } from './sessions.js';
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

describe('session helpers', () => {
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

  it('splitFinished goes by the finished field and keeps the order within each part', () => {
    const finished = { kind: 'background' as const, alive: false, pid: undefined, status: undefined, state: 'done' as const, finished: true };
    const a = session({ name: 'a' });
    const b = session({ name: 'b', ...finished });
    const c = session({ name: 'c' });
    const d = session({ name: 'd', ...finished, state: 'failed' });
    const { current, finished: done } = splitFinished([a, b, c, d]);
    expect(current.map((s) => s.name)).toEqual(['a', 'c']);
    expect(done.map((s) => s.name)).toEqual(['b', 'd']);
  });

  it('statusBadge puts waiting first, then blocked unless stale, then asked you, then the rest', () => {
    const asked = { reason: 'open-questions' as const, excerpt: 'Should I push it?' };
    const badge = (overrides: Parameters<typeof session>[0]) => statusBadge(session(overrides));
    expect(badge({ status: 'waiting', waitingFor: 'input needed', askedYou: asked })).toEqual({
      status: 'waiting',
      label: 'Waiting: input needed',
      look: 'solid-warning',
    });
    expect(badge({ kind: 'background', state: 'blocked', askedYou: asked })).toEqual({ status: 'blocked', label: 'Blocked', look: 'solid-warning' });
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
