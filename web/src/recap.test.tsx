// Recaps outside the strip (M5, W111, W121): reading a recap defensively, the to-dos' tags and count, the
// collapsed setting's storage, Needs you's 'recap' reason on a row's badge and line 2, the quiet
// reason for what an idle session waits on otherwise, the app strip's recap line, and the Dashboard
// passing the snapshot's recaps through. Made-up sessions and recaps only.

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RECAP_DAILY_BUDGET, RECAP_FIELD_MAX, RECAP_TODOS_MAX, type RecapHealth, type RecapSummary, type SessionRecap, type SessionSummary } from '../../src/shared/protocol.js';
import { AppStrips } from './components/AppStrip.js';
import { Dashboard } from './components/Dashboard.js';
import { SessionRow } from './components/SessionRow.js';
import type { ConnectionView } from './connection.js';
import {
  asksOnOpen,
  budgetSpent,
  budgetText,
  cutText,
  finishedWaitingOnYou,
  forYouText,
  parseRecap,
  quietWaitingOn,
  waitingPr,
  waitingPrLink,
  readRecapCollapsed,
  recapForYou,
  RECAP_COLLAPSED_KEY,
  recapsStripText,
  TODO_OWNER_TEXT,
  todoOwnerLook,
  todosForYou,
  writeRecapCollapsed,
} from './recap.js';
import { countAttention, needsAttention, rowStatusBadge, statusBadge } from './sessions.js';
import { group, minutesAgo, pr, session, snapshot } from './test/fixtures.js';

const NEXT = 'Say whether to mark #42 ready';
const RECAP: SessionRecap = {
  summary: 'You asked it to fix the made-up export. It opened draft PR #42.',
  todos: [
    { text: 'Finish the checks on #42', owner: 'CI' },
    { text: NEXT, owner: 'you' },
    { text: 'Open a backport PR', owner: 'session' },
    { text: 'Say whether to close #40', owner: 'you' },
  ],
  waitingOn: 'you',
  title: 'Fix the made-up export',
  at: minutesAgo(4),
  throughAt: minutesAgo(5),
  source: 'pitwall',
};

const summary = (extra: Partial<RecapSummary> = {}): RecapSummary => ({ waitingOn: 'you', title: 'Fix the made-up export', forYou: 2, at: minutesAgo(4), source: 'pitwall', ...extra });
const HEALTH: RecapHealth = { calls: 3, budget: RECAP_DAILY_BUDGET, costUsd: 0.003 };

describe('asking as the view opens (W132)', () => {
  const summary: RecapSummary = { waitingOn: 'you', title: 'Fix the made-up export', forYou: 1, at: '2026-11-03T11:00:00.000Z', source: 'pitwall' };
  it('asks with no recap, whether or not the session works', () => {
    expect(asksOnOpen(session({ status: 'idle' }), true, undefined)).toBe(true);
    expect(asksOnOpen(session({ status: 'busy' }), true, false)).toBe(true);
  });
  it('asks for a stale recap only once the turn has ended, by the working line’s rule', () => {
    const stale = { ...summary, stale: true as const };
    expect(asksOnOpen(session({ status: 'idle', recap: stale }), true, undefined)).toBe(true);
    expect(asksOnOpen(session({ status: 'busy', recap: stale }), true, undefined)).toBe(false);
    expect(asksOnOpen(session({ status: 'busy', recap: stale }), true, false)).toBe(false);
    expect(asksOnOpen(session({ kind: 'background', status: undefined, state: 'working', recap: stale }), true, undefined)).toBe(false);
    // The page's mark wins over a status a plugin's monitor keeps at busy.
    expect(asksOnOpen(session({ status: 'busy', recap: stale }), true, true)).toBe(true);
    // Waiting on you, ended, or no longer running: not working.
    expect(asksOnOpen(session({ status: 'waiting', waitingFor: 'permission prompt', recap: stale }), true, undefined)).toBe(true);
    expect(asksOnOpen(session({ ended: true, finished: true, alive: false, pid: undefined, status: undefined, recap: stale }), true, undefined)).toBe(true);
  });
  it('never asks for a current recap', () => {
    expect(asksOnOpen(session({ status: 'idle', recap: summary }), true, true)).toBe(false);
    expect(asksOnOpen(session({ status: 'busy', recap: summary }), true, false)).toBe(false);
  });
});

describe('parseRecap', () => {
  it('reads a recap', () => {
    expect(parseRecap(RECAP)).toEqual(RECAP);
    expect(parseRecap({ ...RECAP, stale: true })).toEqual({ ...RECAP, stale: true });
    expect(parseRecap({ ...RECAP, todos: [], waitingOn: 'nothing' })?.todos).toEqual([]);
    // W166's `after` is read and dropped: the page has no use for it.
    expect(parseRecap({ ...RECAP, todos: [{ text: 'a', owner: 'you', after: true }] })?.todos).toEqual([{ text: 'a', owner: 'you' }]);
  });

  it('refuses anything that isn’t one', () => {
    for (const bad of [
      null,
      [],
      'recap',
      { ...RECAP, waitingOn: 'the moon' },
      { ...RECAP, source: 'model' },
      { ...RECAP, at: 'yesterday' },
      { ...RECAP, summary: 3 },
      { ...RECAP, stale: false },
      { ...RECAP, throughAt: undefined },
      { ...RECAP, todos: undefined },
      { ...RECAP, todos: 'Mark #42 ready' },
      { ...RECAP, todos: [{ text: 'a', owner: 'me' }] },
      { ...RECAP, todos: [{ text: 1, owner: 'you' }] },
      { ...RECAP, todos: [{ text: 'a', owner: 'you', extra: true }] },
      { ...RECAP, todos: [{ text: 'a', owner: 'you', after: 'yes' }] },
      { ...RECAP, todos: [{ text: 'a', owner: 'you', after: true, extra: true }] },
      { ...RECAP, todos: [null] },
      { why: 'the old shape', now: 'b', next: 'c', waitingOn: 'you', title: 'd', at: RECAP.at, throughAt: RECAP.throughAt, source: 'pitwall' },
    ]) {
      expect(parseRecap(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('cuts a text longer than RECAP_FIELD_MAX, never splitting a surrogate pair, and keeps at most RECAP_TODOS_MAX to-dos', () => {
    const long = parseRecap({ ...RECAP, summary: 'a'.repeat(RECAP_FIELD_MAX + 50), todos: [{ text: 'b'.repeat(RECAP_FIELD_MAX + 1), owner: 'you' }] });
    expect(long?.summary.length).toBe(RECAP_FIELD_MAX);
    expect(long?.summary.endsWith('…')).toBe(true);
    expect(long?.todos[0]?.text.length).toBe(RECAP_FIELD_MAX);
    const many = parseRecap({ ...RECAP, todos: Array.from({ length: RECAP_TODOS_MAX + 2 }, (_, i) => ({ text: `step ${i}`, owner: 'session' })) });
    expect(many?.todos).toHaveLength(RECAP_TODOS_MAX);
    const emoji = cutText(`${'a'.repeat(8)}😀😀`, 10);
    expect(emoji).toBe(`${'a'.repeat(8)}…`);
  });
});

describe('the to-dos', () => {
  it('tags each owner, yours in the Needs you tone, the rest quiet', () => {
    expect(TODO_OWNER_TEXT).toEqual({ you: 'You', session: 'Session', CI: 'CI', 'someone else': 'Someone else' });
    expect(todoOwnerLook('you')).toBe('subtle-warning');
    for (const owner of ['session', 'CI', 'someone else'] as const) expect(todoOwnerLook(owner)).toBe('subtle-neutral');
  });

  it('counts yours, for the collapsed strip', () => {
    expect(todosForYou(RECAP)).toBe(2);
    expect(todosForYou({ todos: [] })).toBe(0);
    expect(forYouText(1)).toBe('1 for you');
    expect(forYouText(2)).toBe('2 for you');
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
    session({ status: 'idle', recap: summary({ next: NEXT }), needsYou: { reason: 'recap', text: NEXT }, lastUserPrompt: 'Run the made-up export.', ...extra });

  it('needs you, with Waiting on you in Done’s place on a job Claude Code calls done', () => {
    const job = waiting({ kind: 'background', shortId: 'pt111a', status: 'idle', state: 'done' });
    expect(needsAttention(job)).toBe(true);
    expect(countAttention([job])).toBe(1);
    expect(statusBadge(job)).toEqual({ status: 'recap', label: 'Waiting on you', look: 'subtle-warning' });
    expect(rowStatusBadge(waiting())?.label).toBe('Waiting on you');
  });

  it('says on line 2 its first to-do for you, after "Next:", as Asked and Needs have theirs', () => {
    const row = renderRow(waiting());
    expect(row.querySelector('.session-what-text')?.textContent).toBe(`Next: ${NEXT}`);
    expect(row.querySelector('.asked-label')?.textContent).toBe('Next:');
    expect(row.querySelector('[data-status]')?.textContent).toBe('Waiting on you');
    expect(row.dataset.attention).toBe('true');
  });

  it('says what it did last when the recap gives no next: the badge says the rest', () => {
    const row = renderRow(waiting({ needsYou: { reason: 'recap' }, recap: summary({ forYou: 0 }) }));
    expect(row.querySelector('.session-what-text')?.textContent).toBe('You: Run the made-up export.');
  });

  it('shows its text as plain text', () => {
    const row = renderRow(waiting({ needsYou: { reason: 'recap', text: 'Say \u001b[31mwhether\u0007 to ship.' } }));
    expect(row.querySelector('.session-what-text')?.textContent).toBe('Next: Say whether to ship.');
  });

  it('is an outline Waiting on you on a finished or ended row, which never needs you, as a finished Asked you is', () => {
    const finished = session({ kind: 'background', shortId: 'pt111c', status: undefined, state: 'done', alive: false, pid: undefined, finished: true, recap: summary({ next: NEXT }) });
    expect(needsAttention(finished)).toBe(false);
    expect(finishedWaitingOnYou(finished)).toBe(true);
    const row = renderRow(finished);
    const badge = [...row.querySelectorAll('.badge-outline')].find((each) => each.textContent === 'Waiting on you');
    expect(badge).toBeTruthy();
    expect(row.dataset.attention).toBeUndefined();
    const ended = session({ ended: true, finished: true, alive: false, pid: undefined, status: undefined, recap: summary({ next: NEXT }) });
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

  it('isn’t said for a finished job whose recap waits on CI: its badge says it, in Done’s place (W170)', () => {
    const done = idle('CI', { kind: 'background', shortId: 'pt111b', status: undefined, state: 'done', alive: false, pid: undefined, finished: true });
    expect(quietWaitingOn(done, false)).toBeUndefined();
    expect(statusBadge(done)).toEqual({ status: 'waiting-on', label: 'Waiting on CI', look: 'subtle-neutral' });
  });
});

describe('a done job waiting on someone else, CI or another session isn’t Done (W170)', () => {
  // Made up, shaped like the case that prompted it: Claude Code calls the job done, a monitor keeps
  // its process busy, and its recap says it waits on someone else.
  const done = (waitingOn: RecapSummary['waitingOn'] | undefined, extra: Partial<SessionSummary> = {}) =>
    session({
      kind: 'background',
      shortId: 'pt170a',
      state: 'done',
      status: 'busy',
      turnEnded: true,
      lastUserPrompt: 'Wait for the made-up review.',
      ...(waitingOn === undefined ? {} : { recap: summary({ waitingOn, forYou: 0 }) }),
      ...extra,
    });

  it('says what it waits on in Done’s place, subtle and neutral, and never needs you', () => {
    for (const [waitingOn, text] of [
      ['someone else', 'Waiting on someone else'],
      ['CI', 'Waiting on CI'],
      ['another session', 'Waiting on another session'],
    ] as const) {
      const s = done(waitingOn);
      expect(statusBadge(s)).toEqual({ status: 'waiting-on', label: text, look: 'subtle-neutral' });
      expect(needsAttention(s)).toBe(false);
      const row = renderRow(s);
      expect(row.querySelector('.session-badges .badge[data-status]')?.textContent).toBe(text);
      expect(row.dataset.attention).toBeUndefined();
      // Line 2 doesn't say it again.
      expect(row.querySelector('.session-waiting-on')).toBeNull();
      row.closest('ul')?.parentElement?.remove();
    }
  });

  it('stays Done when the recap waits on nothing, is stale or is Claude Code’s, or there is none', () => {
    expect(statusBadge(done('nothing')).label).toBe('Done');
    expect(statusBadge(done(undefined)).label).toBe('Done');
    expect(statusBadge(done('someone else', { recap: summary({ waitingOn: 'someone else', stale: true }) })).label).toBe('Done');
    expect(statusBadge(done('someone else', { recap: summary({ waitingOn: 'CI', source: 'claude-code' }) })).label).toBe('Done');
    // Waiting on you, with no reason from the index, isn't this: the index's 'recap' reason is.
    expect(statusBadge(done('you')).label).toBe('Done');
  });

  it('leaves Failed and Stopped as they are', () => {
    expect(statusBadge(done('CI', { state: 'failed' })).label).toBe('Failed');
    expect(statusBadge(done('CI', { state: 'stopped' })).label).toBe('Stopped');
  });

  it('names the PR its job links on line 2, “#6089”, unless the row’s PR badge shows it', () => {
    const s = done('someone else', { jobPr: { repo: 'example/demo-app', number: 6089 } });
    expect(waitingPr(s, false)).toBe('#6089');
    const row = renderRow(s);
    expect(row.querySelector('.session-waiting-on')?.textContent).toBe('#6089');
    expect(row.querySelector('.session-what-text')?.textContent).toBe('#6089 · You: Wait for the made-up review.');
    row.closest('ul')?.parentElement?.remove();
    // Owned, so the row's PR badge has it already.
    expect(waitingPr(s, false, [pr({ number: 6089 })])).toBeUndefined();
    expect(waitingPr(s, false, [pr({ number: 6090 })])).toBe('#6089');
    // Not while it needs you, nor when its recap waits on nothing.
    expect(waitingPr(s, true)).toBeUndefined();
    expect(waitingPr(done('nothing', { jobPr: { repo: 'example/demo-app', number: 6089 } }), false)).toBeUndefined();
  });

  it('adds the PR after an idle session’s quiet reason, and not while it works', () => {
    const idle = session({ status: 'idle', recap: summary({ waitingOn: 'CI', forYou: 0 }), jobPr: { repo: 'example/demo-app', number: 42 }, lastUserPrompt: 'Push it.' });
    const row = renderRow(idle);
    expect(row.querySelector('.session-waiting-on')?.textContent).toBe('Waiting on CI: #42');
    row.closest('ul')?.parentElement?.remove();
    expect(waitingPr({ ...idle, status: 'busy' }, false)).toBeUndefined();
  });

  it('gives the session view the PR as owner/name#n and its GitHub address', () => {
    expect(waitingPrLink(done('CI', { jobPr: { repo: 'example/demo-app', number: 6089 } }))).toEqual({ text: 'example/demo-app#6089', url: 'https://github.com/example/demo-app/pull/6089' });
    expect(waitingPrLink(done('nothing', { jobPr: { repo: 'example/demo-app', number: 6089 } }))).toBeUndefined();
    expect(waitingPrLink(done('CI'))).toBeUndefined();
    // Not beside Blocked, while its own line says it needs you, nor beside Busy on a job that isn't done.
    expect(waitingPrLink(done('CI', { state: 'blocked', needsYou: { reason: 'claude-code', text: 'A made-up question?' }, jobPr: { repo: 'example/demo-app', number: 6089 } }))).toBeUndefined();
    expect(waitingPrLink(done('CI', { state: 'working', jobPr: { repo: 'example/demo-app', number: 6089 } }))).toBeUndefined();
  });
});

describe('your first to-do, for a row that needs you through a PR (W161)', () => {
  it('is the current recap’s first For you item, with how many there are', () => {
    expect(recapForYou(session({ recap: summary({ waitingOn: 'CI', forYou: 3, next: ` ${NEXT} ` }) }))).toEqual({ next: NEXT, count: 3 });
  });

  it('is none without a recap, a to-do of yours or its text, nor from a stale recap or Claude Code’s', () => {
    expect(recapForYou(session())).toBeUndefined();
    expect(recapForYou(session({ recap: summary({ forYou: 0 }) }))).toBeUndefined();
    expect(recapForYou(session({ recap: summary({ next: '  ' }) }))).toBeUndefined();
    expect(recapForYou(session({ recap: summary({ next: NEXT, stale: true }) }))).toBeUndefined();
    expect(recapForYou(session({ recap: summary({ next: NEXT, source: 'claude-code' }) }))).toBeUndefined();
  });

  it('is line 2 of a row that needs you through its PR, in place of the PR’s state, while you haven’t set it aside', () => {
    const review = pr({ number: 57, relation: 'review-requested', reviewRequest: { via: 'direct' } }, 20);
    const line2 = (s: SessionSummary) => {
      const shown = group({ sessions: [s] });
      const { unmount } = render(
        <ul>
          <SessionRow session={s} group={shown} owned={[review]} />
        </ul>,
      );
      const row = document.querySelector<HTMLElement>('li.session')!;
      const what = [row.classList.contains('attention'), row.querySelector('.session-what-text')?.textContent];
      unmount();
      return what;
    };
    const recap = summary({ waitingOn: 'someone else', forYou: 3, next: NEXT });
    expect(line2(session({ status: 'idle', recap, lastUserPrompt: 'Review #57.' }))).toEqual([true, `For you (3): ${NEXT}`]);
    expect(line2(session({ status: 'idle', lastUserPrompt: 'Review #57.' }))).toEqual([true, 'Needs you for example/demo-app#57: review requested']);
    // Busy: no bar, and what it was asked, whatever the PR or the recap says.
    expect(line2(session({ status: 'busy', recap, lastUserPrompt: 'Review #57.' }))).toEqual([false, 'You: Review #57.']);
    // Snoozed: only its PR keeps it in Needs you, so that's what line 2 says.
    const snoozed = session({ status: 'waiting', waitingFor: 'permission prompt', recap, snoozed: { at: minutesAgo(1) } });
    expect(line2(snoozed)).toEqual([true, "Snoozed until it's woken · Needs you for example/demo-app#57: review requested"]);
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
      "Today's 500 recaps are used up, so pitwall makes no more until midnight. Each session keeps its last recap.",
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
    expect(screen.getByText(/Today's 500 recaps are used up/)).toBeTruthy();
  });
});
