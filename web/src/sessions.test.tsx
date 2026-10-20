// The filters (docs/design-system.md, Filter chips): the Interactive and Background chips combine as
// OR, and no chip on lets everything through. The text and "Needs attention only" AND with them.
import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/shared/protocol.js';
import {
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

/** One session of each kind, and of the states the other filters tell apart, named after it. */
const SESSIONS = {
  'interactive-waiting': session({ name: 'interactive-waiting', status: 'waiting', waitingFor: 'permission prompt' }),
  'interactive-idle': session({ name: 'interactive-idle' }),
  'background-blocked': session({ name: 'background-blocked', kind: 'background', shortId: 'b1', status: undefined, state: 'blocked' }),
  'background-working': session({ name: 'background-working', kind: 'background', shortId: 'b2', status: undefined, state: 'working' }),
  'background-finished': session({ name: 'background-finished', ...done, shortId: 'b4' }),
} satisfies Record<string, SessionSummary>;

type Name = keyof typeof SESSIONS;
const ALL = Object.keys(SESSIONS) as Name[];

/** The sessions that pass these chips, by name, in the order above. */
function passing(...chips: FilterChip[]): Name[] {
  return ALL.filter((name) => matchesChips(SESSIONS[name], new Set(chips)));
}

const filters = (text: string, chips: FilterChip[] = [], attentionOnly = false): Filters => ({ text, chips: new Set(chips), attentionOnly });

describe('the filter chips', () => {
  it('are Interactive and Background, in that order', () => {
    expect(FILTER_CHIPS).toEqual(['interactive', 'background']);
  });

  it('let everything through when none is on', () => {
    expect(passing()).toEqual(ALL);
  });

  it('Interactive: interactive sessions only', () => {
    expect(passing('interactive')).toEqual(['interactive-waiting', 'interactive-idle']);
  });

  it('Background: background sessions only, finished ones too', () => {
    expect(passing('background')).toEqual(['background-blocked', 'background-working', 'background-finished']);
  });

  it('Interactive or Background, with both on: everything, as with neither', () => {
    expect(passing('interactive', 'background')).toEqual(ALL);
  });
});

describe('filterGroups', () => {
  const app = group({ sessions: [SESSIONS['interactive-waiting'], SESSIONS['interactive-idle'], SESSIONS['background-finished']] });
  const jobs = group({
    key: '/Users/example/code/jobs',
    label: 'jobs',
    sessions: [SESSIONS['background-working'], SESSIONS['background-blocked']],
  });
  const names = (result: ReturnType<typeof filterGroups>) => result.map(({ group: shown, sessions }) => [shown.label, sessions.map((s) => s.name)]);

  it('keeps every group and session with no filters', () => {
    expect(names(filterGroups([app, jobs], NO_FILTERS))).toEqual([
      ['demo-app', ['interactive-waiting', 'interactive-idle', 'background-finished']],
      ['jobs', ['background-working', 'background-blocked']],
    ]);
  });

  it('ANDs a chip with the text, and drops groups left empty', () => {
    expect(names(filterGroups([app, jobs], filters('finished', ['background'])))).toEqual([['demo-app', ['background-finished']]]);
    expect(names(filterGroups([app, jobs], filters('idle', ['background'])))).toEqual([]);
    expect(names(filterGroups([app, jobs], filters('', ['interactive'])))).toEqual([['demo-app', ['interactive-waiting', 'interactive-idle']]]);
  });

  it('ANDs the chips with "Needs attention only"', () => {
    expect(names(filterGroups([app, jobs], filters('', [], true)))).toEqual([
      ['demo-app', ['interactive-waiting']],
      ['jobs', ['background-blocked']],
    ]);
    expect(names(filterGroups([app, jobs], filters('', ['background'], true)))).toEqual([['jobs', ['background-blocked']]]);
    expect(names(filterGroups([app, jobs], filters('', ['interactive', 'background'], true)))).toHaveLength(2);
  });

  it('applies the chips inside a group whose label matches the text, which otherwise shows all its sessions', () => {
    expect(names(filterGroups([app, jobs], filters('JOBS')))).toEqual([['jobs', ['background-working', 'background-blocked']]]);
    expect(names(filterGroups([app, jobs], filters('jobs', ['interactive'])))).toEqual([]);
  });
});

describe('filtering', () => {
  it('is on with any text in the field, a chip or "Needs attention only", which is when Clear filters shows', () => {
    expect(filtering(NO_FILTERS)).toBe(false);
    expect(filtering(filters('', ['background']))).toBe(true);
    expect(filtering(filters('x'))).toBe(true);
    expect(filtering(filters(' '))).toBe(true);
    expect(filtering(filters('', [], true))).toBe(true);
  });
});

describe('noMatchText', () => {
  it('says which text matched nothing, and with which filters', () => {
    expect(noMatchText(filters('zzz'), 0)).toEqual({ title: 'No sessions match', sentence: 'Nothing matches "zzz".' });
    expect(noMatchText(filters(' zzz ', ['background']), 0)).toEqual({ title: 'No sessions match', sentence: 'Nothing matches "zzz" with these filters.' });
    expect(noMatchText(filters('zzz', [], true), 2).sentence).toBe('Nothing matches "zzz" with these filters.');
    expect(noMatchText(filters('', ['interactive']), 0)).toEqual({ title: 'No sessions match', sentence: 'Nothing matches these filters.' });
  });

  it('is calm when "Needs attention only" is the only filter and nothing needs you', () => {
    expect(noMatchText(filters('', [], true), 0)).toEqual({
      title: 'Nothing needs you right now',
      sentence: 'Sessions that are waiting for you, or asked you something, show here.',
    });
    expect(noMatchText(filters('', ['interactive'], true), 0).title).toBe('No sessions match');
    expect(noMatchText(filters('docs', [], true), 0).title).toBe('No sessions match');
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
