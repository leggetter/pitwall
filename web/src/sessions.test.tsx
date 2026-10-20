// The toolbar's filters (docs/design-system.md, Filter chips): the state chips, Needs you and
// Finished, OR with each other; the kind chips, Interactive and Background, OR with each other; the
// two kinds AND, and with the text. No chip on lets everything through.
import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/shared/protocol.js';
import {
  CHIP_KINDS,
  FILTER_CHIPS,
  filterGroups,
  filtering,
  filterNeedle,
  matchesChips,
  matchRanges,
  NO_FILTERS,
  noMatchText,
  sessionCount,
  type FilterChip,
  type Filters,
} from './sessions.js';
import { group, session } from './test/fixtures.js';

const done = { kind: 'background', alive: false, pid: undefined, status: undefined, state: 'done', finished: true } as const;

/** One session of each kind and state the chips tell apart, named after it. */
const SESSIONS = {
  'interactive-waiting': session({ name: 'interactive-waiting', status: 'waiting', waitingFor: 'permission prompt' }),
  'interactive-asked': session({ name: 'interactive-asked', askedYou: { reason: 'question', excerpt: 'Ship it?' } }),
  'interactive-idle': session({ name: 'interactive-idle' }),
  'background-blocked': session({ name: 'background-blocked', kind: 'background', shortId: 'b1', status: undefined, state: 'blocked' }),
  'background-working': session({ name: 'background-working', kind: 'background', shortId: 'b2', status: undefined, state: 'working' }),
  'background-stale': session({ name: 'background-stale', kind: 'background', shortId: 'b3', status: undefined, state: 'blocked', stale: true }),
  'background-finished': session({ name: 'background-finished', ...done, shortId: 'b4' }),
  // Finished, and it asked something: shown under Finished, never under Needs you.
  'background-finished-asked': session({ name: 'background-finished-asked', ...done, shortId: 'b5', askedYou: { reason: 'question', excerpt: 'Open a PR?' } }),
} satisfies Record<string, SessionSummary>;

type Name = keyof typeof SESSIONS;
const ALL = Object.keys(SESSIONS) as Name[];

/** The sessions that pass these chips, by name, in the order above. */
function passing(...chips: FilterChip[]): Name[] {
  return ALL.filter((name) => matchesChips(SESSIONS[name], new Set(chips)));
}

describe('the filter chips', () => {
  it('are Needs you, Interactive, Background and Finished, in that order, of two kinds', () => {
    expect(FILTER_CHIPS).toEqual(['needsYou', 'interactive', 'background', 'finished']);
    expect(CHIP_KINDS).toEqual({ state: ['needsYou', 'finished'], kind: ['interactive', 'background'] });
  });

  it('let everything through when none is on', () => {
    expect(passing()).toEqual(ALL);
  });

  describe('one chip on', () => {
    it('Needs you: waiting, asked you and blocked, never stale or finished', () => {
      expect(passing('needsYou')).toEqual(['interactive-waiting', 'interactive-asked', 'background-blocked']);
    });

    it('Finished: finished sessions, including one that asked something', () => {
      expect(passing('finished')).toEqual(['background-finished', 'background-finished-asked']);
    });

    it('Interactive: interactive sessions', () => {
      expect(passing('interactive')).toEqual(['interactive-waiting', 'interactive-asked', 'interactive-idle']);
    });

    it('Background: background sessions, finished ones too', () => {
      expect(passing('background')).toEqual([
        'background-blocked',
        'background-working',
        'background-stale',
        'background-finished',
        'background-finished-asked',
      ]);
    });
  });

  describe('two chips of the same kind: OR', () => {
    it('Needs you or Finished', () => {
      expect(passing('needsYou', 'finished')).toEqual([
        'interactive-waiting',
        'interactive-asked',
        'background-blocked',
        'background-finished',
        'background-finished-asked',
      ]);
    });

    it('Interactive or Background: everything, as with neither on', () => {
      expect(passing('interactive', 'background')).toEqual(ALL);
    });
  });

  describe('chips of different kinds: AND', () => {
    it('Needs you and Interactive', () => {
      expect(passing('needsYou', 'interactive')).toEqual(['interactive-waiting', 'interactive-asked']);
    });

    it('Needs you and Background', () => {
      expect(passing('needsYou', 'background')).toEqual(['background-blocked']);
    });

    it('Finished and Background', () => {
      expect(passing('finished', 'background')).toEqual(['background-finished', 'background-finished-asked']);
    });

    it('Finished and Interactive: nothing, since only background sessions finish', () => {
      expect(passing('finished', 'interactive')).toEqual([]);
    });
  });

  describe('both kinds, with more than one chip of a kind', () => {
    it('(Needs you or Finished) and Interactive', () => {
      expect(passing('needsYou', 'finished', 'interactive')).toEqual(['interactive-waiting', 'interactive-asked']);
    });

    it('(Needs you or Finished) and Background', () => {
      expect(passing('needsYou', 'finished', 'background')).toEqual(['background-blocked', 'background-finished', 'background-finished-asked']);
    });

    it('Finished and (Interactive or Background)', () => {
      expect(passing('finished', 'interactive', 'background')).toEqual(['background-finished', 'background-finished-asked']);
    });

    it('all four: (Needs you or Finished) and (Interactive or Background)', () => {
      expect(passing('needsYou', 'finished', 'interactive', 'background')).toEqual(passing('needsYou', 'finished'));
    });
  });
});

describe('filterGroups', () => {
  const app = group({ sessions: [SESSIONS['interactive-waiting'], SESSIONS['interactive-idle'], SESSIONS['background-finished']] });
  const jobs = group({
    key: '/Users/example/code/jobs',
    label: 'jobs',
    sessions: [SESSIONS['background-working'], SESSIONS['background-finished-asked']],
  });
  const filters = (text: string, ...chips: FilterChip[]): Filters => ({ text, chips: new Set(chips) });
  const names = (result: ReturnType<typeof filterGroups>) => result.map(({ group: shown, sessions }) => [shown.label, sessions.map((s) => s.name)]);

  it('keeps every group and session with no filters', () => {
    expect(names(filterGroups([app, jobs], NO_FILTERS))).toEqual([
      ['demo-app', ['interactive-waiting', 'interactive-idle', 'background-finished']],
      ['jobs', ['background-working', 'background-finished-asked']],
    ]);
  });

  it('ANDs the chips with the text, and drops groups left empty', () => {
    expect(names(filterGroups([app, jobs], filters('finished', 'finished')))).toEqual([
      ['demo-app', ['background-finished']],
      ['jobs', ['background-finished-asked']],
    ]);
    expect(names(filterGroups([app, jobs], filters('asked', 'finished')))).toEqual([['jobs', ['background-finished-asked']]]);
    expect(names(filterGroups([app, jobs], filters('idle', 'finished')))).toEqual([]);
  });

  it("applies the chips inside a group whose label matches the text, which otherwise shows all its sessions", () => {
    expect(names(filterGroups([app, jobs], filters('JOBS')))).toEqual([['jobs', ['background-working', 'background-finished-asked']]]);
    expect(names(filterGroups([app, jobs], filters('jobs', 'finished')))).toEqual([['jobs', ['background-finished-asked']]]);
  });
});

describe('filtering', () => {
  it('is on with any chip, or any text in the field, which is when Clear filters shows', () => {
    expect(filtering(NO_FILTERS)).toBe(false);
    expect(filtering({ text: '', chips: new Set(['background']) })).toBe(true);
    expect(filtering({ text: 'x', chips: new Set() })).toBe(true);
    expect(filtering({ text: ' ', chips: new Set() })).toBe(true);
  });
});

describe('noMatchText', () => {
  const text = (value: string, ...chips: FilterChip[]) => noMatchText({ text: value, chips: new Set(chips) }, 0);

  it('says which text matched nothing, and with which filters', () => {
    expect(text('zzz')).toEqual({ title: 'No sessions match', sentence: 'Nothing matches "zzz".' });
    expect(text(' zzz ', 'background')).toEqual({ title: 'No sessions match', sentence: 'Nothing matches "zzz" with these filters.' });
    expect(text('', 'finished', 'interactive')).toEqual({ title: 'No sessions match', sentence: 'Nothing matches these filters.' });
  });

  it('is calm when Needs you is the only filter and nothing needs you', () => {
    expect(text('', 'needsYou')).toEqual({
      title: 'Nothing needs you right now',
      sentence: 'Sessions that are waiting for you, or asked you something, show here.',
    });
    expect(text('', 'needsYou', 'interactive').title).toBe('No sessions match');
    expect(text('docs', 'needsYou').title).toBe('No sessions match');
    expect(noMatchText({ text: '', chips: new Set(['needsYou']) }, 2).title).toBe('No sessions match');
  });
});

describe('matchRanges, for the highlight', () => {
  it('finds every match, case-insensitively, without overlaps', () => {
    expect(matchRanges('Export the exports', filterNeedle(' EXPORT '))).toEqual([
      [0, 6],
      [11, 17],
    ]);
    expect(matchRanges('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('finds nothing for no text, or text that is not there', () => {
    expect(matchRanges('pitwall', '')).toEqual([]);
    expect(matchRanges('pitwall', 'zzz')).toEqual([]);
  });

  it('gives up rather than misplace a match when lower-casing changes the length', () => {
    expect(matchRanges('İstanbul export', 'export')).toEqual([]);
  });
});

describe('sessionCount', () => {
  it('handles one and many', () => {
    expect(sessionCount(1)).toBe('1 session');
    expect(sessionCount(12)).toBe('12 sessions');
    expect(sessionCount(0)).toBe('0 sessions');
  });
});
