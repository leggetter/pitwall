import { describe, expect, it } from 'vitest';
import { cwdWithinGroup, plainText, relativeTime, shortenHome, updatedAgo } from './format.js';
import { attachCommand, needsAttention, statusPill } from './sessions.js';
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

describe('cwdWithinGroup', () => {
  it('is undefined at the group directory, relative below it, and shortened outside it', () => {
    expect(cwdWithinGroup('/Users/example/repo', '/Users/example/repo')).toBeUndefined();
    expect(cwdWithinGroup('/Users/example/repo/', '/Users/example/repo')).toBeUndefined();
    expect(cwdWithinGroup('/Users/example/repo/src/lib', '/Users/example/repo')).toBe('src/lib');
    expect(cwdWithinGroup('/Users/example/repo-worktrees/a', '/Users/example/repo')).toBe('~/repo-worktrees/a');
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

  it('statusPill puts waiting first, then blocked unless stale, then asked you, then the rest', () => {
    const asked = { reason: 'open-questions' as const, excerpt: 'Should I push it?' };
    const label = (overrides: Parameters<typeof session>[0]) => statusPill(session(overrides));
    expect(label({ status: 'waiting', waitingFor: 'input needed', askedYou: asked })).toEqual({
      label: 'waiting: input needed',
      tone: 'attention',
    });
    expect(label({ kind: 'background', state: 'blocked', askedYou: asked })).toEqual({ label: 'blocked', tone: 'attention' });
    expect(label({ status: 'idle', askedYou: asked })).toEqual({ label: 'asked you', tone: 'asked' });
    expect(label({ kind: 'background', state: 'done', alive: false, status: undefined, askedYou: asked })).toEqual({
      label: 'asked you',
      tone: 'asked',
    });
    expect(label({ kind: 'background', state: 'blocked', stale: true, alive: false })).toEqual({
      label: 'blocked',
      tone: 'offline',
    });
    expect(label({ kind: 'background', state: 'blocked', stale: true, askedYou: asked })).toEqual({
      label: 'blocked',
      tone: 'offline',
    });
    expect(label({ status: 'idle' })).toEqual({ label: 'idle', tone: 'idle' });
  });

  it('statusPill includes the blocked reason when there is one', () => {
    expect(statusPill(session({ kind: 'background', state: 'blocked', waitingFor: 'input needed' }))).toEqual({
      label: 'blocked: input needed',
      tone: 'attention',
    });
    expect(statusPill(session({ status: 'waiting' }))).toEqual({ label: 'waiting', tone: 'attention' });
    expect(statusPill(session({ kind: 'background', state: 'working', status: undefined }))).toEqual({
      label: 'working',
      tone: 'busy',
    });
  });

  it('attachCommand is only for background sessions with a plain short id', () => {
    expect(attachCommand(session({ kind: 'background', shortId: 'ab12-cd' }))).toBe('claude attach ab12-cd');
    expect(attachCommand(session({ kind: 'background' }))).toBeUndefined();
    expect(attachCommand(session({ kind: 'interactive', shortId: 'ab12' }))).toBeUndefined();
    expect(attachCommand(session({ kind: 'background', shortId: '$(touch x)' }))).toBeUndefined();
  });
});
