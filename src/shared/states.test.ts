// docs/states.md names every state the protocol has (W178): the badge statuses, the background states, the
// process statuses, the Needs you reasons and the PR needs. Each is backticked in the page.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BackgroundState, NeedsYou, ProcessStatus } from './protocol.js';
import { NEEDS_YOU_RULES, PR_NEED_RULES, SESSION_STATUSES } from './sessionState.js';

const doc = readFileSync(new URL('../../docs/states.md', import.meta.url), 'utf8');

// Records, so a new value in the protocol's types is a compile error here until it is listed.
const BACKGROUND: Record<BackgroundState, true> = { working: true, blocked: true, done: true, failed: true, stopped: true };
const PROCESS: Record<ProcessStatus, true> = { busy: true, waiting: true, idle: true };
const REASONS: Record<NeedsYou['reason'], true> = { prompt: true, 'claude-code': true, asked: true, 'handed-off': true, recap: true, restarted: true, blocked: true };

describe('docs/states.md', () => {
  const cases: [string, string[]][] = [
    ['badge statuses', SESSION_STATUSES],
    ['background states', Object.keys(BACKGROUND)],
    ['process statuses', Object.keys(PROCESS)],
    ['Needs you reasons', Object.keys(REASONS)],
    ['PR needs', Object.keys(PR_NEED_RULES)],
  ];
  for (const [what, ids] of cases) {
    it(`covers every one of the ${what}`, () => {
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.filter((id) => !doc.includes(`\`${id}\``))).toEqual([]);
    });
  }
  it('has a rule for every Needs you reason', () => {
    expect(Object.keys(NEEDS_YOU_RULES).sort()).toEqual(Object.keys(REASONS).sort());
  });
});
