// Recaps outside the strip (M5, W111): reading a recap defensively, the headline and the lines, the
// collapsed setting's storage, Needs you's 'recap' reason on a row's badge and line 2, the quiet
// reason for what an idle session waits on otherwise, the app strip's recap line, and the Dashboard
// passing the snapshot's recaps through. Made-up sessions and recaps only.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RECAP_DAILY_BUDGET, RECAP_FIELD_MAX, type RecapHealth, type RecapSummary, type SessionRecap, type SessionSummary } from '../../src/shared/protocol.js';
import { AppStrips } from './components/AppStrip.js';
import { Dashboard } from './components/Dashboard.js';
import { SessionRow } from './components/SessionRow.js';
import type { ConnectionView } from './connection.js';
import {
  budgetSpent,
  budgetText,
  cutText,
  finishedWaitingOnYou,
  parseRecap,
  quietWaitingOn,
  readRecapCollapsed,
  RECAP_COLLAPSED_KEY,
  recapHeadline,
  recapLines,
  recapsStripText,
  writeRecapCollapsed,
} from './recap.js';
import { countAttention, needsAttention, rowStatusBadge, statusBadge } from './sessions.js';
import { group, minutesAgo, session, snapshot } from './test/fixtures.js';

const RECAP: SessionRecap = {
  why: 'You asked it to fix the made-up export.',
  now: 'It opened draft PR #42.',
  next: 'Say whether to mark #42 ready.',
  waitingOn: 'you',
  title: 'Fix the made-up export',
  at: minutesAgo(4),
  throughAt: minutesAgo(5),
  source: 'pitwall',
};

const summary = (extra: Partial<RecapSummary> = {}): RecapSummary => ({ waitingOn: 'you', title: 'Fix the made-up export', at: minutesAgo(4), source: 'pitwall', ...extra });
const HEALTH: RecapHealth = { calls: 3, budget: RECAP_DAILY_BUDGET, costUsd: 0.003 };

describe('parseRecap', () => {
  it('reads a recap', () => {
    expect(parseRecap(RECAP)).toEqual(RECAP);
    expect(parseRecap({ ...RECAP, stale: true })).toEqual({ ...RECAP, stale: true });
  });

  it('refuses anything that isn’t one', () => {
    for (const bad of [null, [], 'recap', { ...RECAP, waitingOn: 'the moon' }, { ...RECAP, source: 'model' }, { ...RECAP, at: 'yesterday' }, { ...RECAP, why: 3 }, { ...RECAP, stale: false }, { ...RECAP, throughAt: undefined }]) {
      expect(parseRecap(bad)).toBeUndefined();
    }
  });

  it('cuts a field longer than RECAP_FIELD_MAX, never splitting a surrogate pair', () => {
    const long = parseRecap({ ...RECAP, why: 'a'.repeat(RECAP_FIELD_MAX + 50) });
    expect(long?.why.length).toBe(RECAP_FIELD_MAX);
    expect(long?.why.endsWith('…')).toBe(true);
    const emoji = cutText(`${'a'.repeat(8)}😀😀`, 10);
    expect(emoji).toBe(`${'a'.repeat(8)}…`);
  });
});

describe('the headline and the lines', () => {
  it('chooses its label, tone and field by what the recap waits on', () => {
    expect(recapHeadline(RECAP)).toEqual({ label: 'You need to', look: 'subtle-warning', field: 'next', text: RECAP.next });
    expect(recapHeadline({ ...RECAP, waitingOn: 'CI' })).toEqual({ label: 'Waiting on CI', look: 'subtle-neutral', field: 'next', text: RECAP.next });
    expect(recapHeadline({ ...RECAP, waitingOn: 'nothing' })).toEqual({ label: 'Done', look: 'subtle-success', field: 'now', text: RECAP.now });
    expect(recapHeadline({ ...RECAP, source: 'claude-code', waitingOn: 'nothing' })).toMatchObject({ label: 'Now', field: 'now' });
  });

  it('falls back to the other field when its own is empty', () => {
    expect(recapHeadline({ ...RECAP, next: '' })).toMatchObject({ label: 'You need to', field: 'now', text: RECAP.now });
    expect(recapHeadline({ ...RECAP, waitingOn: 'nothing', now: ' ' })).toMatchObject({ label: 'Done', field: 'next', text: RECAP.next });
  });

  it('lists Why, then whichever of Now and Next the headline didn’t show, leaving out empty ones', () => {
    expect(recapLines(RECAP, { field: 'next' }).map((line) => line.label)).toEqual(['Why', 'Now']);
    expect(recapLines(RECAP, { field: 'now' }).map((line) => line.label)).toEqual(['Why', 'Next']);
    expect(recapLines({ ...RECAP, why: '', next: '' }, { field: 'now' })).toEqual([]);
  });
});

describe('the collapsed setting', () => {
  it('is a boolean, "true" or "false", and open otherwise or when storage throws', () => {
    expect(readRecapCollapsed()).toBe(false);
    writeRecapCollapsed(true);
    expect(window.localStorage.getItem(RECAP_COLLAPSED_KEY)).toBe('true');
    expect(readRecapCollapsed()).toBe(true);
    writeRecapCollapsed(false);
    expect(window.localStorage.getItem(RECAP_COLLAPSED_KEY)).toBe('false');
    const throwing = () => {
      throw new Error('blocked');
    };
    expect(readRecapCollapsed(throwing)).toBe(false);
    expect(() => writeRecapCollapsed(true, throwing)).not.toThrow();
  });
});

/** A row in a group's list. */
function renderRow(s: SessionSummary) {
  const shown = group({ sessions: [s] });
  render(
    <ul>
      <SessionRow session={s} group={shown} />
    </ul>,
  );
  return document.querySelector<HTMLElement>('li.session')!;
}

describe("Needs you's 'recap' reason", () => {
  const waiting = (extra: Partial<SessionSummary> = {}) =>
    session({ status: 'idle', recap: summary({ next: RECAP.next }), needsYou: { reason: 'recap', text: RECAP.next }, lastUserPrompt: 'Run the made-up export.', ...extra });

  it('needs you, with Waiting on you in Done’s place on a job Claude Code calls done', () => {
    const job = waiting({ kind: 'background', shortId: 'pt111a', status: 'idle', state: 'done' });
    expect(needsAttention(job)).toBe(true);
    expect(countAttention([job])).toBe(1);
    expect(statusBadge(job)).toEqual({ status: 'recap', label: 'Waiting on you', look: 'subtle-warning' });
    expect(rowStatusBadge(waiting())?.label).toBe('Waiting on you');
  });

  it('says on line 2 what the recap says you need to do, after "Next:", as Asked and Needs have theirs', () => {
    const row = renderRow(waiting());
    expect(row.querySelector('.session-what-text')?.textContent).toBe(`Next: ${RECAP.next}`);
    expect(row.querySelector('.asked-label')?.textContent).toBe('Next:');
    expect(row.querySelector('[data-status]')?.textContent).toBe('Waiting on you');
    expect(row.dataset.attention).toBe('true');
  });

  it('says what it did last when the recap gives no next: the badge says the rest', () => {
    const row = renderRow(waiting({ needsYou: { reason: 'recap' }, recap: summary() }));
    expect(row.querySelector('.session-what-text')?.textContent).toBe('You: Run the made-up export.');
  });

  it('shows its text as plain text', () => {
    const row = renderRow(waiting({ needsYou: { reason: 'recap', text: 'Say \u001b[31mwhether\u0007 to ship.' } }));
    expect(row.querySelector('.session-what-text')?.textContent).toBe('Next: Say whether to ship.');
  });

  it('is an outline Waiting on you on a finished or ended row, which never needs you, as a finished Asked you is', () => {
    const finished = session({ kind: 'background', shortId: 'pt111c', status: undefined, state: 'done', alive: false, pid: undefined, finished: true, recap: summary({ next: RECAP.next }) });
    expect(needsAttention(finished)).toBe(false);
    expect(finishedWaitingOnYou(finished)).toBe(true);
    const row = renderRow(finished);
    const badge = [...row.querySelectorAll('.badge-outline')].find((each) => each.textContent === 'Waiting on you');
    expect(badge).toBeTruthy();
    expect(row.dataset.attention).toBeUndefined();
    const ended = session({ ended: true, finished: true, alive: false, pid: undefined, status: undefined, recap: summary({ next: RECAP.next }) });
    expect(finishedWaitingOnYou(ended)).toBe(true);
    // Not from a stale recap, nor beside a finished Asked you.
    expect(finishedWaitingOnYou({ ...ended, recap: summary({ stale: true }) })).toBe(false);
    expect(finishedWaitingOnYou({ ...ended, askedYou: { reason: 'question', excerpt: 'Ship it?' } })).toBe(false);
  });
});

describe('what an idle session waits on, when it isn’t you', () => {
  const idle = (waitingOn: RecapSummary['waitingOn'], extra: Partial<SessionSummary> = {}) => session({ status: 'idle', recap: summary({ waitingOn }), lastUserPrompt: 'Push it and wait.', ...extra });

  it('is a quiet reason first on line 2, which never needs you', () => {
    for (const [waitingOn, text] of [
      ['CI', 'Waiting on CI'],
      ['another session', 'Waiting on another session'],
      ['someone else', 'Waiting on someone else'],
    ] as const) {
      const s = idle(waitingOn);
      expect(needsAttention(s)).toBe(false);
      expect(quietWaitingOn(s, false)).toBe(text);
      const row = renderRow(s);
      expect(row.querySelector('.session-waiting-on')?.textContent).toBe(text);
      expect(row.querySelector('.session-what-text')?.textContent).toBe(`${text} · You: Push it and wait.`);
      expect(row.dataset.attention).toBeUndefined();
      row.closest('ul')?.parentElement?.remove();
    }
  });

  it('isn’t said while it works, needs you, has ended, or from a stale recap or Claude Code’s', () => {
    expect(quietWaitingOn(idle('CI', { status: 'busy' }), false)).toBeUndefined();
    expect(quietWaitingOn(idle('CI', { kind: 'background', status: undefined, state: 'working' }), false)).toBeUndefined();
    expect(quietWaitingOn(idle('CI'), true)).toBeUndefined();
    expect(quietWaitingOn(idle('CI', { ended: true, finished: true, alive: false }), false)).toBeUndefined();
    expect(quietWaitingOn(idle('CI', { recap: summary({ waitingOn: 'CI', stale: true }) }), false)).toBeUndefined();
    expect(quietWaitingOn(idle('CI', { recap: summary({ waitingOn: 'CI', source: 'claude-code' }) }), false)).toBeUndefined();
    expect(quietWaitingOn(idle('nothing'), false)).toBeUndefined();
    expect(quietWaitingOn(idle('you'), false)).toBeUndefined();
  });

  it('is said for a finished job whose recap waits on CI', () => {
    const done = idle('CI', { kind: 'background', shortId: 'pt111b', status: undefined, state: 'done', alive: false, pid: undefined, finished: true });
    expect(quietWaitingOn(done, false)).toBe('Waiting on CI');
  });
});

describe('the app strip’s recap line', () => {
  it('says nothing while recaps are fine or off', () => {
    expect(recapsStripText(undefined)).toBeUndefined();
    expect(recapsStripText(HEALTH)).toBeUndefined();
    render(<AppStrips relayOff={undefined} recaps={HEALTH} />);
    expect(document.querySelector('.app-strip')).toBeNull();
  });

  it('says the day’s budget is spent, and what it means, first', () => {
    const spent = { ...HEALTH, calls: RECAP_DAILY_BUDGET, error: 'Made up: it failed.' };
    expect(budgetSpent(spent)).toBe(true);
    expect(recapsStripText(spent)).toBe(`${budgetText(RECAP_DAILY_BUDGET)} Each session keeps its last recap.`);
    render(<AppStrips relayOff={undefined} recaps={spent} />);
    expect(document.querySelector('[data-strip="recaps"]')?.textContent).toBe(
      "Today's 200 recaps are used up, so pitwall makes no more until midnight. Each session keeps its last recap.",
    );
  });

  it('says the latest call failed, in pitwall’s words, as text', () => {
    expect(recapsStripText({ ...HEALTH, error: "Made up: claude -p didn't answer\u001b[2J" })).toBe(
      "The latest recap failed: Made up: claude -p didn't answer. Each session keeps its last recap until one works.",
    );
  });

  it('stacks under the relay’s line when both hold', () => {
    render(<AppStrips relayOff={{ since: minutesAgo(2), reason: 'made up.' }} recaps={{ ...HEALTH, error: 'Made up.' }} />);
    expect([...document.querySelectorAll('.app-strips > .app-strip')].map((line) => (line as HTMLElement).dataset.strip ?? 'relay')).toEqual(['relay', 'recaps']);
  });
});

describe('the Dashboard', () => {
  it('shows the app strip’s recap line from the snapshot', () => {
    const view: ConnectionView = { state: 'live', snapshot: snapshot([group({ sessions: [session({ name: 'pitwall-test-one' })] })], { recaps: { ...HEALTH, calls: RECAP_DAILY_BUDGET } }) };
    render(<Dashboard view={view} />);
    expect(screen.getByText(/Today's 200 recaps are used up/)).toBeTruthy();
  });
});
