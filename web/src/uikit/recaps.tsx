// Recaps (M5, W111, W121): the real RecapStrip in every state, in the session view and alone at its width,
// Plan status (W123), the session rows' recap reasons on line 2, and the app strip's recap lines. Each strip has a stub
// API (stubs.ts) holding its made-up recap, and its own collapsed setting in memory, so pressing one
// changes none of the others. Every recap here is made up, as spike 010's examples are.

import { useState, type ReactNode } from 'react';
import { RECAP_DAILY_BUDGET, type RecapHealth, type RecapSummary, type RecapTodo, type SessionRecap, type SessionSummary } from '../../../src/shared/protocol.js';
import { AppStrips } from '../components/AppStrip.js';
import { RecapStrip } from '../components/RecapStrip.js';
import { SessionView } from '../components/SessionView.js';
import { ToastProvider } from '../components/Toast.js';
import type { StorageSource } from '../groupState.js';
import { RECAP_COLLAPSED_KEY } from '../recap.js';
import { ago, background, endedSession, session } from './fixtures.js';
import { element, hoverFor, Scenario, Specimen } from './kit.js';
import { acrossGroups, inGroup, Rows } from './lists.js';
import { Stubbed } from './views.js';
import type { StubOptions } from './stubs.js';

const noop = () => {};

/** Recaps working, with calls to spare today. */
const HEALTHY: RecapHealth = { calls: 37, budget: RECAP_DAILY_BUDGET, costUsd: 0.04 };
/** The day's budget spent. */
const SPENT: RecapHealth = { calls: RECAP_DAILY_BUDGET, budget: RECAP_DAILY_BUDGET, costUsd: 0.21 };
/** The latest call failed, in pitwall's made-up words. */
const FAILING: RecapHealth = { calls: 41, budget: RECAP_DAILY_BUDGET, costUsd: 0.04, error: "Made up: claude -p didn't answer within 60 seconds." };

const SUMMARY =
  'You asked it to find out why the made-up nightly export fails on files over 2 GB, and to fix it. It found a 32-bit size field in the upload step and opened draft PR #42 with a fix and a test. CI passes.';

/** The to-dos of a made-up recap that waits on you: yours first, then its own. */
const TODOS: RecapTodo[] = [
  { text: 'Say whether to mark #42 ready', owner: 'you' },
  { text: 'Say whether it should open a backport PR for the 1.x branch', owner: 'you' },
  { text: 'Open the backport PR, if you say yes', owner: 'session' },
  { text: 'Review #42 once it is ready', owner: 'someone else' },
];

/** A made-up recap, made 4 minutes ago, through its last turn, waiting on you unless `extra` says otherwise. */
function recap(extra: Partial<SessionRecap> = {}): SessionRecap {
  return {
    summary: SUMMARY,
    todos: TODOS,
    waitingOn: 'you',
    title: 'Fix the made-up export on large files',
    at: ago(4),
    throughAt: ago(5),
    source: 'pitwall',
    ...extra,
  };
}

/** The first to-do for you, or undefined. */
function nextOf(full: SessionRecap): string | undefined {
  return full.todos.find((todo) => todo.owner === 'you')?.text;
}

/** What the snapshot carries of `full` (D14): how many to-dos are yours, and the first of them as `next`. */
function summaryOf(full: SessionRecap): RecapSummary {
  const next = nextOf(full);
  return {
    waitingOn: full.waitingOn,
    title: full.title,
    forYou: full.todos.filter((todo) => todo.owner === 'you').length,
    at: full.at,
    source: full.source,
    ...(next === undefined ? {} : { next }),
    ...(full.stale ? { stale: true as const } : {}),
  };
}

/** A session with `full` as its recap, its title from it, and, waiting on you, Needs you's 'recap' reason. */
function recapped(name: string, full: SessionRecap | undefined, extra: Partial<SessionSummary> = {}): { session: SessionSummary; full: SessionRecap | undefined } {
  const next = full ? nextOf(full) : undefined;
  const needs = full && full.waitingOn === 'you' && !full.stale && full.source === 'pitwall' && next !== undefined;
  return {
    session: session(name, {
      lastActivityAt: ago(5),
      ...(full ? { recap: summaryOf(full), title: full.title, titleSource: 'pitwall' as const } : {}),
      ...(needs ? { needsYou: { reason: 'recap' as const, text: next } } : {}),
      ...extra,
    }),
    full,
  };
}

/** Storage that lasts as long as the specimen, starting collapsed or open. */
function memoryStorage(collapsed: boolean): StorageSource {
  const items = new Map<string, string>([[RECAP_COLLAPSED_KEY, collapsed ? 'true' : 'false']]);
  const storage = { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => void items.set(key, value) };
  return () => storage;
}

/** One strip alone, at a session view's width, on a stub API holding its recap. */
function Strip({
  of,
  health = HEALTHY,
  options = {},
  collapsed = false,
  listed = true,
}: {
  of: { session: SessionSummary; full: SessionRecap | undefined };
  health?: RecapHealth;
  options?: StubOptions;
  collapsed?: boolean;
  listed?: boolean;
}) {
  const [storage] = useState(() => memoryStorage(collapsed));
  const recaps = of.full ? { [of.session.sessionId]: of.full } : {};
  return (
    <ToastProvider>
      <Stubbed options={{ recaps, ...options }}>
        <div className="session-view uikit-recap-stage">
          <RecapStrip session={of.session} health={health} listed={listed} storage={storage} />
        </div>
      </Stubbed>
    </ToastProvider>
  );
}

const IN_VIEW = recapped('recap-view', recap());
const YOU = recapped('recap-you', recap());
const CI = recapped(
  'recap-ci',
  recap({
    waitingOn: 'CI',
    todos: [
      { text: 'Finish the made-up e2e run on #42', owner: 'CI' },
      { text: 'Mark #42 ready once it passes', owner: 'session' },
      { text: 'Say whether to open a backport PR for the 1.x branch', owner: 'you' },
    ],
  }),
);
const SESSION = recapped(
  'recap-session',
  recap({
    waitingOn: 'another session',
    todos: [
      { text: 'Finish the made-up migration pitwall-test-api asked for', owner: 'someone else' },
      { text: 'Rerun the export against the migrated schema', owner: 'session' },
    ],
  }),
);
const SOMEONE = recapped(
  'recap-someone',
  recap({
    waitingOn: 'someone else',
    todos: [
      { text: "Fix the review's comments on #42", owner: 'someone else' },
      { text: 'Check the fixes and push', owner: 'session' },
    ],
  }),
);
const DONE = recapped(
  'recap-done',
  recap({ waitingOn: 'nothing', todos: [], summary: 'You asked it to fix the made-up nightly export on files over 2 GB. It did: #42 merged, and the nightly run passed with a 3 GB file.' }),
);
const STALE = recapped('recap-stale', recap({ stale: true }), { lastActivityAt: ago(1) });
const CLAUDE = recapped('recap-claude-code', recap({ source: 'claude-code', todos: [], title: '', waitingOn: 'nothing', summary: 'The export fix is in draft PR #42 with green CI. Next, you decide whether to mark it ready.' }));
const COLLAPSED = recapped('recap-collapsed', recap());
const REFRESHING = recapped('recap-refreshing', recap());
const SPENT_RECAP = recapped('recap-budget', recap({ stale: true }), { lastActivityAt: ago(1) });
const LOADING_SUMMARY = recapped('recap-loading', recap());
const FIRST = recapped('recap-first', undefined);
const NONE_SPENT = recapped('recap-none', undefined);
const NONE_FAILED = recapped('recap-none-failed', undefined);
const FETCH_FAILED = recapped('recap-fetch-failed', recap());
const LONG = recapped(
  'recap-long',
  recap({
    summary: `${SUMMARY} You then asked it to check the made-up thumbnails and archive jobs for the same field; it's on step 2 of its 3-step plan, the archive job.`,
    todos: [
      { text: 'Say whether to mark #42 ready', owner: 'you' },
      { text: 'Say whether the made-up archive job, which has the same field, gets its own PR or joins #42', owner: 'you' },
      { text: 'Fix the archive job', owner: 'session' },
      { text: 'Check the thumbnails job for the same field', owner: 'session' },
      { text: 'Finish the checks on #42 and the archive fix', owner: 'CI' },
      { text: 'Review #42 and the archive fix', owner: 'someone else' },
    ],
  }),
);

// The rows: Needs you's 'recap' reason on line 2, and what an idle session's recap says it waits on otherwise.
const ROW_YOU = recapped('row-recap-you', recap()).session;
const ROW_DONE_JOB = background('row-recap-done-job', {
  state: 'done',
  status: 'idle',
  lastActivityAt: ago(6),
  lastUserPrompt: 'Run the made-up export with a 3 GB file.',
  recap: summaryOf(recap()),
  title: 'Fix the made-up export on large files',
  titleSource: 'pitwall',
  needsYou: { reason: 'recap', text: TODOS[0]!.text },
});
const ROW_CI = recapped('row-recap-ci', recap({ waitingOn: 'CI' }), { lastUserPrompt: 'Push it and wait for CI.' }).session;
const ROW_SESSION = recapped('row-recap-session', recap({ waitingOn: 'another session' }), { lastUserPrompt: 'Ask pitwall-test-api for the migration.' }).session;
const ROW_SOMEONE = recapped('row-recap-someone', recap({ waitingOn: 'someone else' }), { lastUserPrompt: 'Wait for the author to fix the review comments.' }).session;
const ROW_STALE_CI = recapped('row-recap-stale-ci', recap({ waitingOn: 'CI', stale: true }), { lastUserPrompt: 'Push it and wait for CI.' }).session;
// Ended, with a current recap that waits on you (D26): an outline Waiting on you, never needing you.
const ROW_ENDED = endedSession('row-recap-ended', { title: 'Fix the made-up export on large files', titleSource: 'pitwall', recap: summaryOf(recap()), lastUserPrompt: 'Run the made-up export with a 3 GB file.' });
const VIEW_ENDED = endedSession('recap-ended-view', { title: 'Fix the made-up export on large files', titleSource: 'pitwall', recap: summaryOf(recap()) });

/** A specimen of one strip. */
function StripSpecimen({ title, note, children }: { title: string; note: ReactNode; children: ReactNode }) {
  return (
    <Specimen title={title} note={note} lasting>
      {children}
    </Specimen>
  );
}

export function RecapSpecimens() {
  return (
    <>
      <Specimen
        title="In the session view"
        note="Between the header and the tabs, on every tab: line 1 is the disclosure button, how old the recap is and Refresh; then the summary, why it was started and where it is now; then the to-dos in order, each with who it waits on as a tag, yours in the Needs you tone. The title in the header is the recap's, pitwall's, with where it came from in its tooltip."
        frame="view"
      >
        <Stubbed options={{ recaps: { [IN_VIEW.session.sessionId]: IN_VIEW.full! } }}>
          <SessionView session={IN_VIEW.session} listed onClose={noop} recaps={HEALTHY} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="An ended session"
        note="Recapped when you ask (D26): its view asks once as it opens, as any other's does. Its recap waits on you, so its header has an outline Waiting on you, with an info button, as a finished Asked you has; it never needs you."
        frame="short"
      >
        <Stubbed options={{ recaps: { [VIEW_ENDED.sessionId]: recap() } }}>
          <SessionView session={VIEW_ENDED} listed onClose={noop} recaps={HEALTHY} />
        </Stubbed>
      </Specimen>
      <StripSpecimen title="Waiting on you" note="The summary, then the to-dos in order: yours with a You tag in the Needs you tone, subtle warning, as Asked you, and their text in full colour; the rest quiet, subtle neutral tags and muted text. The session needs you, for Needs you's reason 'recap', with your first to-do on its row's line 2.">
        <Strip of={YOU} />
      </StripSpecimen>
      <StripSpecimen title="Waiting on CI" note="The to-dos in their order, CI's first: yours comes later, still in the Needs you tone. It never counts as needing you.">
        <Strip of={CI} />
      </StripSpecimen>
      <StripSpecimen title="Waiting on another session" note="Another session's to-do is Someone else's.">
        <Strip of={SESSION} />
      </StripSpecimen>
      <StripSpecimen title="Waiting on someone else" note="A reviewer or an author, M6's blocked on someone else.">
        <Strip of={SOMEONE} />
      </StripSpecimen>
      <StripSpecimen title="Nothing left" note="No to-dos: the summary, then Nothing left to do.">
        <Strip of={DONE} />
      </StripSpecimen>
      <StripSpecimen
        title="May be out of date"
        note="Older than the session's latest turn, on line 1 beside its age, so the summary keeps its width. The view asked for a new one once as it opened, which this stub refuses quietly; Refresh asks again. Its hint: It's older than the session's latest turn."
      >
        <Strip of={STALE} options={{ recapRefresh: 'failed' }} />
      </StripSpecimen>
      <StripSpecimen title="Claude Code's recap" note="Before pitwall's first recap, or while the day's budget is spent: Claude Code's own away_summary, as the summary alone, with no to-dos. Nothing to open, so no disclosure button.">
        <Strip of={CLAUDE} />
      </StripSpecimen>
      <StripSpecimen title="Collapsed" note="The summary's first line, its whole in a tooltip when it's cut, and how many to-dos are yours, 2 for you, in the Needs you tone. The choice is kept per viewer, as a boolean, in pitwall.recap-collapsed.v1.">
        <Strip of={COLLAPSED} collapsed />
      </StripSpecimen>
      <StripSpecimen title="Collapsed, nothing for you" note="No to-do is yours, so no count: the summary's first line alone.">
        <Strip of={SOMEONE} collapsed />
      </StripSpecimen>
      <StripSpecimen title="Collapsed, the summary cut" note="A long summary ends in an ellipsis while it's collapsed.">
        <Strip of={LONG} collapsed />
      </StripSpecimen>
      <StripSpecimen title="Open, a long recap" note="Six to-dos, the most a recap keeps, for each owner. Open, everything wraps; past 35% of the view's height it scrolls inside itself.">
        <Strip of={LONG} />
      </StripSpecimen>
      <StripSpecimen title="Plan status" note="W123: pressed, where the session is in its bigger plan, under the summary and the to-dos: the plan's one line, its items in order, each Done, Now, Next or Dropped, and how the plan changed; its age, Make a new one and Close.">
        <Scenario run={async (root) => (await element(root, '[data-plan-status]')).click()}>
          <Strip of={LONG} />
        </Scenario>
      </StripSpecimen>
      <StripSpecimen title="Plan status, no plan" note="The transcript shows no plan the session works through.">
        <Scenario run={async (root) => (await element(root, '[data-plan-status]')).click()}>
          <Strip of={LONG} options={{ planStatus: 'none' }} />
        </Scenario>
      </StripSpecimen>
      <StripSpecimen title="Plan status, being made" note="Its button busy, and the panel saying so, while the call runs.">
        <Scenario run={async (root) => (await element(root, '[data-plan-status]')).click()}>
          <Strip of={LONG} options={{ planStatus: 'making' }} />
        </Scenario>
      </StripSpecimen>
      <StripSpecimen title="Refreshing" note="Refresh pressed: its spinner until the snapshot's recap changes, or a minute passes, or a call fails.">
        <Scenario run={async (root) => (await element(root, '[data-recap-refresh]')).click()}>
          <Strip of={REFRESHING} options={{ recapRefresh: 'sending' }} />
        </Scenario>
      </StripSpecimen>
      <StripSpecimen title="Budget spent" note="Today's 200 recaps are used up: Refresh is off, and its tooltip says why. It shows the last recap, stale here, and the view asks for none.">
        <Scenario run={(root) => hoverFor(root, '[data-recap-refresh]')}>
          <Strip of={SPENT_RECAP} health={SPENT} />
        </Scenario>
      </StripSpecimen>
      <Specimen title="Loading, from the snapshot's summary" note="The whole recap is on its way: its age from the snapshot's summary, and skeleton bars for the summary and the to-dos after --pw-delay-spinner." waited="shown">
        <Strip of={LOADING_SUMMARY} options={{ recapFetch: 'loading' }} />
      </Specimen>
      <Specimen title="Loading, the first on its way" note="No recap yet: the view asks for one once, and the strip's line 1 is there at once, with skeleton bars after --pw-delay-spinner." waited="shown">
        <Strip of={FIRST} options={{ recapRefresh: 'sending' }} />
      </Specimen>
      <StripSpecimen title="No recap yet, the budget spent" note="None, and none on its way today.">
        <Strip of={NONE_SPENT} health={SPENT} />
      </StripSpecimen>
      <StripSpecimen title="No recap yet, the latest failed" note="None arrived after the view asked, and pitwall's latest recap failed, in its words.">
        <Strip of={NONE_FAILED} health={FAILING} options={{ recapRefresh: 'failed' }} />
      </StripSpecimen>
      <StripSpecimen title="Couldn't load the recap" note="Fetching it failed: Try again fetches it again.">
        <Strip of={FETCH_FAILED} options={{ recapFetch: 'failed' }} />
      </StripSpecimen>
      <Specimen
        title="Session rows"
        note="Needs you's 'recap' reason: Waiting on you, subtle warning, in Done's place on a job Claude Code calls done, and on line 2 Next: and the recap's first to-do for you. Then what an idle session's current recap says it waits on otherwise, quiet, first on line 2; a stale recap's says nothing. Last, an ended session whose recap waits on you: an outline Waiting on you, which never needs you, as a finished Asked you is."
      >
        <Rows rows={inGroup('pitwall-test-app', [ROW_YOU, ROW_DONE_JOB, ROW_CI, ROW_SESSION, ROW_SOMEONE, ROW_STALE_CI, ROW_ENDED])} />
      </Specimen>
      <Specimen title="Session rows, in Needs you and All sessions" note="After the group's label.">
        <Rows rows={acrossGroups([ROW_YOU, ROW_CI, ROW_SOMEONE])} showGroup />
      </Specimen>
      <Specimen title="App strip, the budget spent" note="Nothing more is made today: the info icon.">
        <AppStrips relayOff={undefined} recaps={SPENT} />
      </Specimen>
      <Specimen title="App strip, the latest recap failed" note="pitwall's words, never the model's: the warning icon.">
        <AppStrips relayOff={undefined} recaps={FAILING} />
      </Specimen>
      <Specimen title="App strip, with the relay off too" note="A line each, the relay's first.">
        <AppStrips relayOff={{ since: ago(20), reason: "its gate didn't check a SendMessage call." }} onRelayDetails={noop} recaps={FAILING} />
      </Specimen>
      <Specimen title="App strip at 375 px" note="One line each, 32 px: the sentence ends in an ellipsis, with the whole of it in a tooltip." width={375}>
        <AppStrips relayOff={undefined} recaps={SPENT} />
      </Specimen>
    </>
  );
}
