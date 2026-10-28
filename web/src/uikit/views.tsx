// The session view and what's in it (W19, W22, W24, W27, W28): the real SessionView, its conversation,
// its actions menu and their inline confirmations, RelayBox in every send state, an ended session's
// footer with each result of Resume in background (W67), and the terminal,
// each given a stub API (stubs.ts) and put into its state by a scenario (kit.tsx), as a person
// would: opening the menu, choosing an item, opening a tab, opening a fold, scrolling up.
// Every fixture is made once, when the gallery loads, so a re-render never changes a session's id.

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ConversationEntry, Editor, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { AttachContext } from '../attach.js';
import { slowFirstSnapshot } from '../components/Dashboard.js';
import { EndedFooter, useResume } from '../components/EndedSession.js';
import { MenuButton, type MenuEntry } from '../components/Menu.js';
import { RelayBox } from '../components/RelayBox.js';
import { SessionView, STOP_INTERACTIVE_HINT, UnlistedSessionView, WaitingSessionView, type SessionViewProps } from '../components/SessionView.js';
import { ToastProvider, useToast } from '../components/Toast.js';
import { COPIED, COPY_FAILED, useCopy } from '../copy.js';
import { DraftStorageContext, type StoredDraft } from '../drafts.js';
import { EditorsContext } from '../editors.js';
import { withMark, withoutMark, type NotNeeded } from '../notNeeded.js';
import { MAX_RELAY_TEXT_LENGTH } from '../relay.js';
import { resumeCommand, startLabel, workedInLabels } from '../sessions.js';
import {
  ago,
  APP_DIR,
  background,
  endedSession,
  exchange,
  LINKS_IN_CODE,
  LINKS_THAT_ASK,
  MARKDOWN_CONVERSATION,
  MARKDOWN_EDGES,
  MARKDOWN_ELEMENTS,
  QUESTION_CONVERSATION,
  RETRIED_DETAIL,
  ROOT,
  session,
  TO_PITWALL_CONVERSATION,
  TO_PITWALL_EXCHANGE,
  VIEW_BACKGROUND,
  VIEW_BACKGROUND_DONE,
  VIEW_INTERACTIVE,
  WORKED_FROM_ROOT,
  WORKED_MULTI,
  WORKED_SNAPSHOT,
} from './fixtures.js';
import { element, hoverFor, laidOut, press, Scenario, Specimen, specimenOf, text, type, until } from './kit.js';
import { memoryDrafts, scriptedAttach, storedDraft, stubApi, type AttachScript, type StubOptions } from './stubs.js';

const noop = () => {};

/** Where a session started and worked, as the Dashboard works it out from WORKED_SNAPSHOT. */
const placementOf = (session: SessionSummary) => ({ startedIn: startLabel(WORKED_SNAPSHOT.groups, session), workedIn: workedInLabels(session, WORKED_SNAPSHOT.roots) });

/** A stub API for everything inside, made once from `options` when it mounts. */
export function Stubbed({ options = {}, children }: { options?: StubOptions; children: ReactNode }) {
  const [api] = useState(() => stubApi(options));
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

/** Attach sockets that follow `script`, for everything inside, made once when it mounts. */
function Attachable({ script, children }: { script: AttachScript; children: ReactNode }) {
  const [env] = useState(() => scriptedAttach(script));
  return <AttachContext.Provider value={env}>{children}</AttachContext.Provider>;
}

/**
 * --pw-delay-attach at an hour for everything inside, so a view stepped onto waits on screen, saying
 * Attaching…, with nothing attached (W54). `display: contents`, so the view still sits in its frame.
 */
function AttachWaits({ children }: { children: ReactNode }) {
  return <div style={{ display: 'contents', '--pw-delay-attach': '3600s' } as CSSProperties}>{children}</div>;
}

/** Runs `run` when there is one; otherwise just shows the children. */
function MaybeScenario({ run, children }: { run: ((root: HTMLElement) => Promise<unknown>) | undefined; children: ReactNode }) {
  return run ? <Scenario run={run}>{children}</Scenario> : children;
}

const GONE = session('view-gone', { title: 'Export retries' });
// W47: a session whose directory has gone, in each state that says what to do, and the two that don't.
const GONE_DIR = `${APP_DIR}/.claude/worktrees/pitwall-test-export-fix`;
const MISSING_INTERACTIVE = session('view-missing-dir', {
  title: 'Export retries',
  cwd: GONE_DIR,
  cwdMissing: true,
  lastActivityAt: ago(10 * 24 * 60),
  askedYou: { reason: 'question', excerpt: 'Should the made-up export keep archived projects?' },
  needsYou: { reason: 'asked' },
});
const MISSING_BACKGROUND = background('view-missing-dir-job', { state: 'working', cwd: GONE_DIR, cwdMissing: true });
const MISSING_FINISHED = background('view-missing-dir-done', { state: 'done', alive: false, pid: undefined, finished: true, cwd: GONE_DIR, cwdMissing: true });
const MISSING_QUIET = session('view-missing-dir-quiet', { alive: false, pid: undefined, status: undefined, cwd: GONE_DIR, cwdMissing: true });
const MISSING_GONE = background('view-missing-dir-gone', { state: 'working', cwd: GONE_DIR, cwdMissing: true });
// W47: a running session waiting on you, and where to answer.
const WAITING_INTERACTIVE = session('view-waiting', { title: 'Export retries', status: 'waiting', waitingFor: 'input needed', needsYou: { reason: 'prompt' } });
const WAITING_BACKGROUND = background('view-waiting-job', { state: 'working', status: 'waiting', waitingFor: 'permission prompt', needsYou: { reason: 'prompt' } });
const WAITING_BLOCKED = background('view-waiting-blocked', {
  state: 'blocked',
  status: 'idle',
  needsYou: { reason: 'claude-code', text: 'Should the made-up export keep archived projects?' },
});
// W69: needs you from its context, or not.
const RESTARTED_VIEW = background('view-restarted', { state: 'blocked', status: 'idle', needsYou: { reason: 'restarted' } });
const BLOCKED_IDLE_VIEW = background('view-blocked-idle', { state: 'blocked', status: 'idle' });
const LONG_TITLE = session('view-with-a-long-name-for-the-header', {
  title: 'Retry each failed export batch three times with backoff, keeping the 30 second timeout',
  cwd: `${APP_DIR}/packages/exports/src/jobs/retry`,
});
const ATTACHED = background('view-attached', { state: 'working' });
// W54: a running background session's view opens on its Terminal tab; stepped onto, it waits first.
const OPENS_ON_TERMINAL = background('view-opens-on-terminal', { state: 'working' });
const STEPPED_ONTO = background('view-stepped-onto', { state: 'working' });
const MENU_BACKGROUND = background('view-menu', { state: 'working' });
const MENU_DONE = background('view-menu-done', { state: 'done', alive: false, pid: undefined, finished: true });
const MENU_INTERACTIVE = session('view-menu-interactive');
// W72: the editors pitwall's server found, as the app has them from EDITORS_PATH.
const VSCODE: Editor = { id: 'vscode', label: 'VS Code' };
const CURSOR: Editor = { id: 'cursor', label: 'Cursor' };
const EDITOR_MENUS = [
  {
    title: 'Actions menu, two editors found',
    note: "Open in VS Code and Open in Cursor, after the copies, one for each editor pitwall's server found at startup (W72). Each opens the session's own directory, through the server: the page never sends a path. Not while the directory has gone, or once it's no longer listed.",
    editors: [VSCODE, CURSOR],
    session: background('view-menu-two-editors', { state: 'working' }),
  },
  {
    title: 'Actions menu, one editor found',
    note: 'Only Cursor is installed, so only Open in Cursor.',
    editors: [CURSOR],
    session: background('view-menu-one-editor', { state: 'working' }),
  },
  {
    title: 'Actions menu, no editor found',
    note: 'Neither is installed, so neither is offered, and there is no separator for them: the menu is as it was before W72.',
    editors: [],
    session: background('view-menu-no-editor', { state: 'working' }),
  },
];
const OPENED = background('view-opened-in-editor', { state: 'working' });
const NOT_OPENED = background('view-not-opened-in-editor', { state: 'working' });
const COMPACT = session('view-compact', { title: 'Export retries' });
const STARRED_VIEW = session('view-starred', { title: 'Export retries' });
const STARRED_COMPACT = session('view-starred-compact', { title: 'Export retries' });

/** A background job Claude Code calls blocked, waiting on someone else, marked not needed now (W88). */
const NOT_NEEDED_VIEW = background('view-not-needed', {
  state: 'blocked',
  status: 'idle',
  needsYou: { reason: 'claude-code', text: "Waiting for the made-up author's fix before re-running the check" },
});

/** A session view whose actions menu marks it not needed now or puts it back, with marks of its own, marked to start with (W88). */
function Markable(props: SessionViewProps) {
  const [entries, setEntries] = useState<NotNeeded>(() => withMark(new Map(), props.session));
  return <SessionView {...props} notNeeded={{ entries, onChange: (changed, on) => setEntries((current) => (on ? withMark(current, changed) : withoutMark(current, changed.sessionId))) }} />;
}

/** A session view with its star toggle, starred or not to start with, and a state of its own, so it can be pressed (W53). */
function Starrable({ starred: start, ...props }: SessionViewProps & { starred: boolean }) {
  const [starred, setStarred] = useState(start);
  return <SessionView {...props} star={{ starred, onStar: (_id, on) => setStarred(on) }} />;
}
const CONVERSATION_STATES = (
  [
    ['Loading the conversation', 'loading', 'shown', 'A status line after half a second, so a fast answer never flashes it.'],
    ['Loading the conversation, after 10 seconds', 'loading', 'long', 'The long-wait line joins it: what the view is waiting for.'],
    ["Couldn't load it", 'failed', undefined, 'A danger alert, since nothing is shown, with Try again. The HTTP status follows pitwall’s sentence.'],
    ['No transcript', 'missing', undefined, undefined],
    ['Nothing yet', 'empty', undefined, undefined],
  ] as const
).map(([title, conversation, waited, note]) => ({
  title,
  note,
  waited,
  options: { conversation },
  session: background(waited === 'long' ? 'view-loading-long' : `view-${conversation}`, { state: 'working' }),
}));
const RETRYING = background('view-failed-retrying', { state: 'working' });
const STALE_VIEW = background('view-stale', { state: 'blocked', stale: true, waitingFor: 'a question from last month' });
const FINISHED_ASKED_VIEW = background('view-finished-asked', {
  state: 'done',
  alive: false,
  pid: undefined,
  finished: true,
  askedYou: { reason: 'open-questions', excerpt: 'Should the made-up export keep archived projects?' },
});
const NO_API = background('view-no-api', { state: 'working' });

/** Opens the session view's actions menu. */
async function openMenu(root: HTMLElement): Promise<HTMLElement> {
  (await element<HTMLButtonElement>(root, 'button[aria-label="Session actions"]')).click();
  return element(root, '[role="menu"]');
}

/** Opens the actions menu and hovers `label`, a disabled item, for its tooltip. */
const openMenuAt = (label: string) => async (root: HTMLElement) => {
  await openMenu(root);
  const item = await until(`the ${label} item`, () => [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent?.trim() === label));
  item.dataset.uikitHover = 'stop';
  await hoverFor(root, '[data-uikit-hover="stop"]', STOP_INTERACTIVE_HINT);
};

/** Opens the actions menu and chooses `label`. */
async function chooseFromMenu(root: HTMLElement, label: string): Promise<void> {
  await openMenu(root);
  const item = await until(`the ${label} item`, () => [...root.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent?.trim() === label));
  item.click();
}

/** Opens the Terminal tab, which attaches. */
async function openTerminal(root: HTMLElement): Promise<void> {
  const tab = await until('the Terminal tab', () => [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find((candidate) => candidate.textContent?.startsWith('Terminal')));
  tab.click();
}

/** Waits for Load earlier, then scrolls the conversation up to it, as a reader would. */
async function toTop(root: HTMLElement): Promise<void> {
  const button = await element(root, '.load-earlier');
  const body = button.closest<HTMLElement>('.session-view-body');
  if (body) body.scrollTop = 0;
}

export function SessionViews() {
  return (
    <>
      <Specimen
        title="Interactive"
        note="The conversation, with one of each kind of entry, and the message box below it showing the latest exchange. The info icon and the Terminal tab say how /bg lets pitwall attach."
        frame="view"
      >
        <Stubbed>
          <SessionView session={VIEW_INTERACTIVE} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Stale"
        note="The row's Stale badge, after the status, with an info button whose name and tooltip are its explanation, so the keyboard and screen readers reach it; in the row it's a hover-only tooltip."
        frame="short"
      >
        <Stubbed>
          <SessionView session={STALE_VIEW} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Worked in other repos"
        note="Line 3: the group it started in, the same whatever Group sessions by lists it under, and the repos it worked in, newest first, each by its label, pitwall-test-docs too, which has no group. The names are text: selecting one does nothing. The info button has the rule, and how to find every session that worked in a repo. It shows once a scan finds a repo beyond the start; rows stay two lines."
        frame="short"
      >
        <Stubbed>
          <SessionView session={WORKED_MULTI} placement={placementOf(WORKED_MULTI)} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="Worked in repos, started in the root" note="It started in the root itself, so it's listed in the root's own group, ~/code, and its line 3 names the repos it worked in." frame="short">
        <Stubbed>
          <SessionView session={WORKED_FROM_ROOT} placement={placementOf(WORKED_FROM_ROOT)} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="Finished, and it asked you" note="The row's outlined Asked you, with its explanation behind an info button too." frame="short">
        <Stubbed>
          <SessionView session={FINISHED_ASKED_VIEW} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Not needed now (W88)"
        note="Marked not needed now: the status badge keeps its text, outlined, with Not needed now after it, as its row has. The actions menu has Put back in Needs you, which takes the mark away, and then Mark not needed now. Under line 2, the note on where to answer stays: it's still waiting."
        frame="short"
      >
        <Stubbed>
          <Markable session={NOT_NEEDED_VIEW} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Background, on Conversation"
        note="As it opens with Preferences on Conversation, or once you choose the tab (W54): the actions menu in the header, older entries behind Load earlier, and where an interactive session has its message box, a note: it takes messages in its Terminal tab, which attaches (W47). No button opens the tab from there, since opening it attaches."
        frame="view"
      >
        <Stubbed options={{ conversation: 'older' }}>
          <SessionView session={VIEW_BACKGROUND} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="Background, attached" note="The Terminal tab open, attached to a scripted server, with the success dot on the tab. The footer's note goes while the tab is open." frame="view">
        <Attachable script="attached">
          <Stubbed>
            <Scenario
              run={async (root) => {
                await openTerminal(root);
                await until('the terminal to attach', () => root.querySelector('.session-tab-dot'));
              }}
            >
              <SessionView session={ATTACHED} listed onClose={noop} />
            </Scenario>
          </Stubbed>
        </Attachable>
      </Specimen>
      <Specimen
        title="Background, opened on its Terminal tab (W54)"
        note="A running background session opens on its Terminal tab, as Preferences has it by default, and attaches at once: nothing pressed here. Its conversation is behind the Conversation tab, with the footer's note. Nothing here asked for the terminal, so it takes no focus, and its bar says how to type to it (W57); a click or Enter on the session's row, or on the Terminal tab, would have given it focus as it attached."
        frame="view"
      >
        <Attachable script="attached">
          <Stubbed>
            <Scenario run={async (root) => until('the terminal to attach', () => root.querySelector('.session-tab-dot'))}>
              <SessionView session={OPENS_ON_TERMINAL} listed onClose={noop} backgroundTab="terminal" />
            </Scenario>
          </Stubbed>
        </Attachable>
      </Specimen>
      <Specimen
        title="Stepped onto with j, waiting to attach (W54)"
        note="Opened by j, k, ↑ or ↓: on its Terminal tab, saying Attaching…, but nothing attaches until the view has stayed open for --pw-delay-attach, 500 ms (an hour here). Moving on before then attaches nothing, and once it attaches the terminal takes no focus, so the next j is still a step."
        frame="short"
      >
        <AttachWaits>
          <Attachable script="attached">
            <Stubbed>
              <SessionView session={STEPPED_ONTO} listed onClose={noop} backgroundTab="terminal" stepped />
            </Stubbed>
          </Attachable>
        </AttachWaits>
      </Specimen>
      <Specimen
        title="Background, not running"
        note="It has finished, so it opens on Conversation even with Preferences on Terminal (W54): attaching restarts it, and opening Terminal asks first, as its footer says. Stop is off in the menu."
        frame="short"
      >
        <Stubbed>
          <SessionView session={VIEW_BACKGROUND_DONE} listed onClose={noop} backgroundTab="terminal" />
        </Stubbed>
      </Specimen>
      <Specimen title="No longer listed" note="The session left the snapshot, so the view keeps what it showed, without the message box, the actions or the terminal." frame="short">
        <Stubbed>
          <SessionView session={GONE} listed={false} onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Waiting, interactive"
        note="The badge says it's waiting and on what, as Claude Code gives it; the line under line 2 says where to answer: in its terminal, since pitwall can't, and a message sent below waits until then (W47)."
        frame="short"
      >
        <Stubbed>
          <SessionView session={WAITING_INTERACTIVE} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Waiting, background"
        note="Answer it in its Terminal tab, which attaches to it. No button opens the tab from the note, since opening it attaches."
        frame="short"
      >
        <Stubbed>
          <SessionView session={WAITING_BACKGROUND} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Blocked, background"
        note="A blocked job whose own line says what it needs, or whose job file pitwall couldn't read, is waiting on you too: the same line. A stale one has none (W69)."
        frame="short"
      >
        <Stubbed>
          <SessionView session={WAITING_BLOCKED} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Waiting for your prompt"
        note="Resumed, or restarted after you confirmed it, in this run of pitwall: solid until you send it a prompt. Nothing to answer, so no line under line 2 (W69)."
        frame="short"
      >
        <Stubbed>
          <SessionView session={RESTARTED_VIEW} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Blocked, but nothing needs you"
        note="Claude Code says blocked, but its context asks nothing, as a resumed session's &quot;send a prompt to start&quot; after pitwall restarted: Idle, as its process is, and no line (W69)."
        frame="short"
      >
        <Stubbed>
          <SessionView session={BLOCKED_IDLE_VIEW} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Directory gone, interactive"
        note="Its worktree was removed, but it's still running in its terminal, waiting on a question from ten days ago. Line 2 keeps Directory no longer exists, and the line under it says why it's listed and that /exit in its terminal ends it (W47)."
        frame="short"
      >
        <Stubbed>
          <SessionView session={MISSING_INTERACTIVE} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="Directory gone, background and running" note="Still running, so it's listed: Stop session, in the actions menu, ends it. Its footer says how to message it." frame="short">
        <Stubbed>
          <SessionView session={MISSING_BACKGROUND} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Directory gone, background and not running"
        note="It has finished, or its process exited: Remove session, in the actions menu, takes it off the list. Its footer says the Terminal tab asks before restarting it."
        frame="short"
      >
        <Stubbed>
          <SessionView session={MISSING_FINISHED} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Directory gone, interactive and not running"
        note="Plain: nothing in pitwall or in a terminal acts on an interactive session that isn't running, so there's no line under line 2."
        frame="short"
      >
        <Stubbed>
          <SessionView session={MISSING_QUIET} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="Directory gone, no longer listed" note="Plain: the menu has no Stop or Remove now, and the alert says why. No footer either." frame="short">
        <Stubbed>
          <SessionView session={MISSING_GONE} listed={false} onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="A long name and title" note="The title gives way first, then the name, and the directory in the middle." frame="short">
        <Stubbed>
          <SessionView session={LONG_TITLE} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Starred"
        note="The star toggle in line 1, before the actions menu: md, filled while the session is starred, named Star and the session's name in either state, with s in its tooltip while the single-key shortcuts are on (W53). Press it to unstar; it never closes the view."
        frame="short"
      >
        <Stubbed>
          <Starrable session={STARRED_VIEW} listed onClose={noop} starred />
        </Stubbed>
      </Specimen>
      <Specimen title="Not starred, 600 px and narrower" note="The outlined star, after the heading, with Back to sessions at the start." frame="short" width={375}>
        <Stubbed>
          <Starrable session={STARRED_COMPACT} listed onClose={noop} compact starred={false} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Not listed under these roots"
        note="A ?session= in the URL that pitwall doesn't list: an empty state whose title is the view's heading, with Close in the header."
        frame="short"
      >
        <UnlistedSessionView sessionId="00000000-0000-4000-8000-00000000dead" roots={[ROOT]} onClose={noop} />
      </Specimen>
      <Specimen
        title="Waiting for the first snapshot"
        note="A ?session= in the URL before pitwall has listed anything: Close, and skeletons for the header after half a second, aria-hidden, with a hidden status."
        frame="short"
      >
        <WaitingSessionView waiting={{ shown: true, long: false }} slow={slowFirstSnapshot('connecting')} onClose={noop} />
      </Specimen>
      <Specimen title="Waiting for the first snapshot, after 10 seconds" note="The long-wait line, the same as the session list's." frame="short">
        <WaitingSessionView waiting={{ shown: true, long: true }} slow={slowFirstSnapshot('connecting')} onClose={noop} />
      </Specimen>
      <Specimen title="600 px and narrower" note="Full width, with Back to sessions in place of Close." frame="short" width={375}>
        <Stubbed>
          <SessionView session={COMPACT} listed onClose={noop} compact />
        </Stubbed>
      </Specimen>
      <Specimen title="Actions menu, background" note="Copy session ID, Copy attach command, then Stop session and Remove session, in danger text." frame="short">
        <Stubbed>
          <Scenario run={openMenu}>
            <SessionView session={MENU_BACKGROUND} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="Actions menu, not running" note="Stop session is off: there's nothing to stop." frame="short">
        <Stubbed>
          <Scenario run={openMenu}>
            <SessionView session={MENU_DONE} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="Actions menu, interactive"
        note="Copy session ID, then Stop session, off: it has no attach command, and can't be stopped or removed from here (W40). Its tooltip says how /bg changes that."
        frame="short"
      >
        <Stubbed>
          <Scenario run={openMenuAt('Stop session')}>
            <SessionView session={MENU_INTERACTIVE} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      {EDITOR_MENUS.map((menu) => (
        <Specimen key={menu.title} title={menu.title} note={menu.note} frame="short">
          <EditorsContext.Provider value={menu.editors}>
            <Stubbed>
              <Scenario run={openMenu}>
                <SessionView session={menu.session} listed onClose={noop} />
              </Scenario>
            </Stubbed>
          </EditorsContext.Provider>
        </Specimen>
      ))}
      <Specimen title="Opened in an editor" note="A success toast, naming the session and the editor. The menu closes, and focus goes back to its button." frame="short" lasting>
        <ToastProvider>
          <EditorsContext.Provider value={[VSCODE, CURSOR]}>
            <Stubbed options={{ open: 'opened' }}>
              <Scenario
                run={async (root) => {
                  await chooseFromMenu(root, 'Open in Cursor');
                  await text(specimenOf(root), `Opened ${OPENED.name}'s directory in Cursor.`);
                }}
              >
                <SessionView session={OPENED} listed onClose={noop} />
              </Scenario>
            </Stubbed>
          </EditorsContext.Provider>
        </ToastProvider>
      </Specimen>
      <Specimen title="Didn't open in an editor" note="An error toast, which stays until it's dismissed: pitwall's sentence, then the server's reason." frame="short" lasting>
        <ToastProvider>
          <EditorsContext.Provider value={[VSCODE, CURSOR]}>
            <Stubbed options={{ open: 'refused' }}>
              <Scenario
                run={async (root) => {
                  await chooseFromMenu(root, 'Open in Cursor');
                  await text(specimenOf(root), "Cursor didn't open");
                }}
              >
                <SessionView session={NOT_OPENED} listed onClose={noop} />
              </Scenario>
            </Stubbed>
          </EditorsContext.Provider>
        </ToastProvider>
      </Specimen>
      {CONVERSATION_STATES.map((state) => (
        <Specimen key={state.title} title={state.title} note={state.note} frame="short" {...(state.waited ? { waited: state.waited } : {})}>
          <Stubbed options={state.options}>
            <SessionView session={state.session} listed onClose={noop} />
          </Stubbed>
        </Specimen>
      ))}
      <Specimen title="Couldn't load it, trying again" note="Try again is busy while its request is out, and the alert stays until the page arrives." frame="short">
        <Stubbed options={{ conversation: 'failed-retrying' }}>
          <Scenario
            run={async (root) => {
              await press(root, 'Try again');
              await element(root, '.conversation-alert [aria-busy="true"]');
            }}
          >
            <SessionView session={RETRYING} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="No API" note="Rendered without an API client, as some tests do." frame="short">
        <ApiContext.Provider value={undefined}>
          <SessionView session={NO_API} listed onClose={noop} />
        </ApiContext.Provider>
      </Specimen>
    </>
  );
}

// W67: an ended interactive session's view, and its footer in each state of Resume in background.
// A few whole views, then the footer alone for each state of a resume: a whole view for each would
// make the gallery slow enough, under the test suite's load, that other specimens' scenarios time out.
interface EndedCase {
  title: string;
  note?: string;
  session: SessionSummary;
  options?: StubOptions;
  run?: (root: HTMLElement) => Promise<unknown>;
  /** A window this wide, compact at 600 px and narrower. */
  width?: number;
}

/** Presses Resume in background, then waits for `then`. */
const resumeThen = (then: (root: HTMLElement) => Promise<unknown>) => async (root: HTMLElement) => {
  await press(root, 'Resume in background');
  await then(root);
};
const ENDED_TITLE = { title: 'Update the getting started guide', titleSource: 'claude-code' } as const;
const failureShown = (root: HTMLElement) => element(root, '.resume-failure');
/** A short conversation for the whole views here, which are about the header, the tabs and the footer. */
const ENDED_CONVERSATION: ConversationEntry[] = [
  { kind: 'user', at: ago(2 * 24 * 60 + 2), text: 'Update the made-up getting started guide for the new export flags.' },
  { kind: 'assistant', at: ago(2 * 24 * 60), markdown: true, text: 'Done: the guide covers `--retries` and `--backoff`, with an example of each.' },
];

const ENDED_VIEWS: EndedCase[] = [
  {
    title: 'Ended',
    note: "Its Claude Code process exited, as when its terminal closed: Ended where a session's status goes, the Conversation tab alone, and, where an interactive session has its message box, the note, then Copy command and Resume in background, secondary then primary. Interactive, with no /bg note: there's no terminal to type it in.",
    session: endedSession('view-ended', ENDED_TITLE),
  },
  {
    title: 'Ended, directory gone',
    note: "Its worktree was removed, so it can't be resumed: line 2 says the directory no longer exists, and the footer's note says why, with nothing to press. The actions menu has Copy session ID alone.",
    session: endedSession('view-ended-gone', { ...ENDED_TITLE, cwd: GONE_DIR, cwdMissing: true }),
  },
  {
    title: "Ended, a ' in its directory's path",
    note: "No Copy command, in the footer or the actions menu (W87): zsh and bash read a ' or \\ inside single quotes one way and fish another, so no quoting pastes as one word in all of them. The note says why, and Resume in background stands alone.",
    session: endedSession('view-ended-quoted', { ...ENDED_TITLE, cwd: `${APP_DIR}/.claude/worktrees/pitwall-test-it's-fixed` }),
  },
  {
    title: 'Actions menu, ended',
    note: 'Copy session ID, Copy resume command, then Resume in background. No Stop or Remove: there is no process.',
    session: endedSession('view-ended-menu', ENDED_TITLE),
    run: openMenu,
  },
  {
    title: 'Ended, 600 px and narrower',
    note: 'The note wraps; the buttons stay at the right, and wrap onto a line each when there isn’t room for both.',
    session: endedSession('view-ended-compact', ENDED_TITLE),
    width: 375,
  },
];

const ENDED_FOOTERS: EndedCase[] = [
  {
    title: 'Footer: resuming',
    note: 'Resume in background is busy while its request is out, and stays busy once it has resumed until pitwall lists it as running.',
    session: endedSession('foot-resuming', ENDED_TITLE),
    options: { resume: 'resuming' },
    run: resumeThen((root) => text(root, 'Resuming…')),
  },
  {
    title: 'Footer: resumed',
    note: "A toast says so. In the app, within a poll the snapshot lists it as a running background session, and the view opens its Terminal tab, taking no focus. Here nothing lists it, so after 15 s it's Resume in background again.",
    session: endedSession('foot-resumed', ENDED_TITLE),
    options: { resume: 'resumed' },
    run: resumeThen((root) => text(specimenOf(root), 'Resumed pitwall-test-foot-resumed in the background.')),
  },
  {
    title: "Footer: couldn't resume, running again",
    note: "It's running again, so pitwall didn't resume it, which would start a copy: pitwall's sentence, then the server's reason in code style, in a danger alert above the buttons, which keep their place.",
    session: endedSession('foot-refused', ENDED_TITLE),
    options: { resume: 'refused' },
    run: resumeThen(failureShown),
  },
  {
    title: "Footer: couldn't resume, not trusted",
    note: "Claude Code's Workspace not trusted line, then the command the server sent to run: in a command chip, with its own copy button, as New session's trust failure has it.",
    session: endedSession('foot-hint', ENDED_TITLE),
    options: { resume: 'hint' },
    run: resumeThen(failureShown),
  },
  {
    title: 'Footer: a copy started instead',
    note: "It was open in another Claude Code process after all, so Claude Code started a copy: a warning, whose body is the server's sentence alone, which names the copy and says what to do, and an error toast that says the same, which outlives the footer and is what announces it.",
    session: endedSession('foot-copied', ENDED_TITLE),
    options: { resume: 'copied' },
    run: resumeThen(failureShown),
  },
  {
    title: 'Footer: too many at once',
    note: 'A 429: pitwall is already running four stop, remove, resume or open commands.',
    session: endedSession('foot-busy', ENDED_TITLE),
    options: { resume: 'busy' },
    run: resumeThen(failureShown),
  },
  {
    title: "Footer: couldn't resume, it took too long",
    note: "A 504: claude --resume didn't finish in time. Its reason, as for any status.",
    session: endedSession('foot-timeout', ENDED_TITLE),
    options: { resume: 'timeout' },
    run: resumeThen(failureShown),
  },
  {
    title: "Footer: pitwall didn't answer",
    note: "No answer at all: pitwall's sentence alone.",
    session: endedSession('foot-failed', ENDED_TITLE),
    options: { resume: 'failed' },
    run: resumeThen(failureShown),
  },
  {
    title: "Footer: couldn't resume, not trusted, 375 px",
    session: endedSession('foot-hint-compact', ENDED_TITLE),
    options: { resume: 'hint' },
    run: resumeThen(failureShown),
    width: 375,
  },
];

/** An ended session's footer alone, as its view has it: Resume in background against the stub API, and Copy command against the stub clipboard. */
function EndedFoot({ session }: { session: SessionSummary }) {
  const resume = useResume(session);
  const copy = useCopy();
  const toast = useToast();
  const command = resumeCommand(session);
  const onCopy = command === undefined ? undefined : () => void copy(command).then((ok) => toast(ok ? { tone: 'success', message: COPIED } : { tone: 'error', message: COPY_FAILED }));
  return (
    <footer className="session-view-foot">
      <EndedFooter session={session} resume={resume} onCopy={onCopy} />
    </footer>
  );
}

export function EndedViews() {
  // With a toasts' stack of its own, as the app has, whose toasts stay here.
  const specimen = (each: EndedCase, footer: boolean) => (
    <Specimen key={each.title} title={each.title} note={each.note} frame={footer ? undefined : 'view'} lasting {...(each.width === undefined ? {} : { width: each.width })}>
      <ToastProvider>
        <Stubbed options={{ entries: ENDED_CONVERSATION, ...each.options }}>
          <MaybeScenario run={each.run}>
            {footer ? <EndedFoot session={each.session} /> : <SessionView session={each.session} listed onClose={noop} compact={each.width !== undefined && each.width <= 600} />}
          </MaybeScenario>
        </Stubbed>
      </ToastProvider>
    </Specimen>
  );
  return (
    <>
      {ENDED_VIEWS.map((each) => specimen(each, false))}
      {ENDED_FOOTERS.map((each) => specimen(each, true))}
    </>
  );
}

const CONVERSATION_ALL = background('conversation-all', { state: 'working' });
const CONVERSATION_OPEN = background('conversation-open', { state: 'working' });
const CONVERSATION_NARROW = background('conversation-narrow', { state: 'working' });
const EARLIER = background('conversation-earlier', { state: 'working' });
const EARLIER_BUSY = background('conversation-earlier-busy', { state: 'working' });
const EARLIER_FAILED = background('conversation-earlier-failed', { state: 'working' });
const EARLIER_RETRYING = background('conversation-earlier-retrying', { state: 'working' });
const STALE = background('conversation-stale', { state: 'working' });
const REFRESH_FAILED = background('conversation-refresh-failed', { state: 'working' });
const REFRESH_RETRYING = background('conversation-refresh-retrying', { state: 'working' });
const GONE_TRANSCRIPT = background('conversation-gone', { state: 'working' });
const JUMP = session('conversation-jump', { title: 'Export retries' });
const MARKDOWN = background('conversation-markdown', { state: 'working' });
const MARKDOWN_AS_TEXT = background('conversation-markdown-as-text', { state: 'working' });
const MARKDOWN_NARROW = background('conversation-markdown-narrow', { state: 'working' });
const MARKDOWN_COPY = background('conversation-markdown-copy', { state: 'working' });
const MARKDOWN_STUB: StubOptions = { entries: MARKDOWN_CONVERSATION };
const CODE_LINKS = background('conversation-code-links', { state: 'working' });
const CODE_LINKS_NARROW = background('conversation-code-links-narrow', { state: 'working' });
const CODE_LINKS_STUB: StubOptions = { entries: LINKS_IN_CODE };
// Interactive, so they open on Conversation whatever a background session's first tab is.
const LINKS_ASK = session('conversation-links-ask', { title: 'Export retries' });
const LINKS_ASKING = session('conversation-links-asking', { title: 'Export retries' });
const LINKS_ASKING_NARROW = session('conversation-links-asking-narrow', { title: 'Export retries' });
const LINKS_ASK_STUB: StubOptions = { entries: LINKS_THAT_ASK };
const TO_PITWALL = session('conversation-to-pitwall', { title: 'Export retries', relay: TO_PITWALL_EXCHANGE });
const TO_PITWALL_NARROW = session('conversation-to-pitwall-narrow', { title: 'Export retries', relay: TO_PITWALL_EXCHANGE });
const TO_PITWALL_STUB: StubOptions = { entries: TO_PITWALL_CONVERSATION };
const QUESTIONS = session('conversation-questions', { title: 'Export retries' });
const QUESTIONS_NARROW = session('conversation-questions-narrow', { title: 'Export retries' });
const QUESTIONS_STUB: StubOptions = { entries: QUESTION_CONVERSATION };

/** The event that moves a Refreshing session's activity, as the index does when the session does something. */
const REFRESH = 'uikit-refresh';

/** Renders its session, and moves the session's last activity on a REFRESH event from inside, so the view fetches the newest page again. */
function Refreshing({ session: initial, children }: { session: SessionSummary; children: (session: SessionSummary) => ReactNode }) {
  const [current, setCurrent] = useState(initial);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = ref.current;
    if (!target) return;
    const refresh = () =>
      setCurrent((shown) => ({ ...shown, lastActivityAt: new Date(Date.parse(shown.lastActivityAt ?? initial.startedAt) + 1_000).toISOString() }));
    target.addEventListener(REFRESH, refresh);
    return () => target.removeEventListener(REFRESH, refresh);
  }, [initial.startedAt]);
  return (
    <div ref={ref} className="uikit-refreshing">
      {children(current)}
    </div>
  );
}

/** The conversation's body, once its entries are there. */
const conversationBody = (root: HTMLElement) =>
  until('the conversation', () => root.querySelector('.conversation') && root.querySelector<HTMLElement>('.session-view-body'));

/** Opens every fold, then scrolls back to the top, where the first ones are. */
async function openFolds(root: HTMLElement): Promise<void> {
  const body = await conversationBody(root);
  for (const toggle of body.querySelectorAll<HTMLButtonElement>('.fold-toggle')) toggle.click();
  await until('the folds to open', () => body.querySelector('.fold-toggle[aria-expanded="true"]'));
  body.scrollTop = 0;
}

/** The session does something, so the view fetches its newest page again, and `selector` appears. */
async function refreshUntil(root: HTMLElement, selector: string): Promise<void> {
  await conversationBody(root);
  root.querySelector('.uikit-refreshing')?.dispatchEvent(new Event(REFRESH));
  await element(root, selector);
}

/** Load earlier, until `selector` appears; then scrolled to the top, where it is. */
async function earlierUntil(root: HTMLElement, selector: string): Promise<void> {
  await press(root, 'Load earlier');
  const found = await element(root, selector);
  const body = found.closest<HTMLElement>('.session-view-body');
  if (body) body.scrollTop = 0;
}

/** Scrolls the conversation's `body` so `target` is at the top, as a reader would. */
function scrollToTop(body: HTMLElement, target: Element): void {
  // In a window scaled to fit its stage, the box on screen is smaller than the one that scrolls.
  const scale = body.offsetHeight > 0 ? body.getBoundingClientRect().height / body.offsetHeight : 1;
  body.scrollTop += (target.getBoundingClientRect().top - body.getBoundingClientRect().top) / scale - 12;
}

/** Scrolls the conversation so the first `selector` is at the top, as a reader would; at the top for none. */
const scrolledTo = (selector?: string) => async (root: HTMLElement) => {
  const body = await conversationBody(root);
  if (selector === undefined) {
    body.scrollTop = 0;
    return;
  }
  scrollToTop(body, await element(body, selector));
};

/** Copies the first code block with its Copy button, as a reader would, then waits for the copied icon and the toast. */
async function copyCode(root: HTMLElement): Promise<void> {
  await scrolledTo('.md-code')(root);
  (await element<HTMLButtonElement>(root, 'button[aria-label="Copy code"]')).click();
  await until('the copied icon', () => root.querySelector('.md-code .copy-button.copied'));
  await text(specimenOf(root), 'Copied');
}

/**
 * Clicks the link saying `text`, as a reader would, so its question opens after the paragraph it's in
 * (W55), then scrolls the conversation to that paragraph, with the question under it.
 */
const asks = (text: string) => async (root: HTMLElement) => {
  const body = await conversationBody(root);
  const link = await until(`the link "${text}"`, () => [...body.querySelectorAll<HTMLAnchorElement>('a.md-link')].find((a) => a.textContent === text));
  link.click();
  const question = await element(body, '.inline-confirm');
  scrollToTop(body, question.previousElementSibling ?? question);
};

/** Scrolls up to read, then the session does more: "Jump to latest" appears with the count. */
async function scrollUpThenMore(root: HTMLElement): Promise<void> {
  const body = await conversationBody(root);
  // happy-dom has no layout, so nothing there is ever scrolled up.
  if (!laidOut(root)) return;
  body.scrollTop = 0;
  await until('the scroll', () => body.scrollTop === 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  root.querySelector('.uikit-refreshing')?.dispatchEvent(new Event(REFRESH));
  await element(root, '.jump-latest-button');
}

export function Conversations() {
  return (
    <>
      <Specimen
        title="Every kind of entry"
        note="Your messages, Claude's, one from another session and a notice, each with its speaker line and time; three tool calls folded, with an error; two folded without; one on its own; a reply cut short; a line with no break in it; and markup, shown as text. It opens scrolled to the newest entry."
        frame="tall"
      >
        <Stubbed>
          <SessionView session={CONVERSATION_ALL} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen
        title="Markdown in messages"
        note="Your prompt as typed, its indents and blank lines kept and its markdown not read; then Claude's message with every element of the subset: headings, bold, italic, both, strikethrough, inline code, line breaks, escapes, a nested list with its task markers as text, a code block with its language and Copy, a table with its alignments, quotes, a rule, and a link, an autolink and a bare URL. Scrolled to the top."
        frame="tall"
      >
        <Stubbed options={{ entries: MARKDOWN_ELEMENTS }}>
          <Scenario run={scrolledTo()}>
            <SessionView session={MARKDOWN} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="Markdown cut short, and shown as text"
        note="A message the server cut short inside a code block, which runs to the end; one whose raw HTML, links to anything but http and https, image and unsupported syntax show as the text they are; and another session's message, in markdown too."
        frame="view"
      >
        <Stubbed options={{ entries: MARKDOWN_EDGES }}>
          <Scenario run={scrolledTo()}>
            <SessionView session={MARKDOWN_AS_TEXT} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="Markdown, 600 px and narrower"
        note="The code block's long line and the wide table each scroll sideways in their own box, a Tab stop while they do; the page doesn't. Scrolled to the code block."
        frame="view"
        width={375}
      >
        <Stubbed options={MARKDOWN_STUB}>
          <Scenario run={scrolledTo('.md-code')}>
            <SessionView session={MARKDOWN_NARROW} listed onClose={noop} compact />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="Links in code"
        note="Bare http and https URLs in a code block and in inline code are links, as in text, kept in the code's mono face and underlined: at a line's end, in brackets, and before a full stop, which stays out. A javascript: URL and markdown's own link syntax stay text, as code does. Another session's code, on --pw-surface, links the same way. Scrolled to the top."
        frame="tall"
      >
        <Stubbed options={CODE_LINKS_STUB}>
          <Scenario run={scrolledTo()}>
            <SessionView session={CODE_LINKS} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="Links in code, 600 px and narrower"
        note="The code block with links still scrolls sideways in its own box, and the page doesn't. Scrolled to the code block."
        frame="view"
        width={375}
      >
        <Stubbed options={CODE_LINKS_STUB}>
          <Scenario run={scrolledTo('.md-code')}>
            <SessionView session={CODE_LINKS_NARROW} listed onClose={noop} compact />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="Links that ask"
        note="A link whose text isn't its own address asks before it opens: one whose text is words, one whose text is another address, and one to an internationalised host. A bare URL, an autolink and a link whose text is its own address open on one click, as before. A URL with a username before its host is text, in text and in code. Nothing shows the difference until a click. Scrolled to the top."
        frame="view"
      >
        <Stubbed options={LINKS_ASK_STUB}>
          <Scenario run={scrolledTo()}>
            <SessionView session={LINKS_ASK} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="Links that ask: asking"
        note="The link whose text is another address, clicked: an inline confirmation after its paragraph names the host it really goes to, then its full address in code style, with Cancel, which has focus, and Open link. Cancel or Escape opens nothing and puts focus back on the link; Open link opens it in a new tab with no opener or referrer."
        frame="view"
      >
        <Stubbed options={LINKS_ASK_STUB}>
          <Scenario run={asks('https://github.com/example/export-app/pull/51')}>
            <SessionView session={LINKS_ASKING} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="Links that ask, 600 px and narrower"
        note="The link to an internationalised host, clicked: its host is named in punycode, as its tooltip shows it. The address wraps anywhere, and the buttons wrap under the text."
        frame="view"
        width={375}
      >
        <Stubbed options={LINKS_ASK_STUB}>
          <Scenario run={asks('the dashboard')}>
            <SessionView session={LINKS_ASKING_NARROW} listed onClose={noop} compact />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="Messages to pitwall"
        note="The session's SendMessage replies to pitwall's relay, each in full, as markdown, in its call's place, after the message from pitwall that asked: a short one between folded tool calls, never folded with them; a long one; and one with a code block and links. Speaker line To pitwall-relay, the name each call addressed, on --pw-surface-sunken with the info inset at its end edge. The first is the reply pitwall's relay received, so the footer keeps only its status line, which says the reply is in the conversation. Scrolled to the message from pitwall."
        frame="tall"
      >
        <Stubbed options={TO_PITWALL_STUB}>
          <Scenario run={scrolledTo('.entry-cross-session')}>
            <SessionView session={TO_PITWALL} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="Messages to pitwall, 600 px and narrower"
        note="The long message wraps, and the code block scrolls sideways in its own box; the page doesn't. Scrolled to the first message to pitwall."
        frame="view"
        width={375}
      >
        <Stubbed options={TO_PITWALL_STUB}>
          <Scenario run={scrolledTo('.entry-to-pitwall')}>
            <SessionView session={TO_PITWALL_NARROW} listed onClose={noop} compact />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="Questions asked in a dialog"
        note="Claude Code's question dialog, once answered, in its call's place, never folded with the calls around it: Claude asked, then each question with its header and its options, the chosen ones in the selected look with a check and Your answer. A dialog of two, a single choice and a multi-select; an answer typed in place of an option, shown as typed; an answer with notes; and a dismissed dialog, Not answered. Plain text throughout. Scrolled to the first question."
        frame="tall"
      >
        <Stubbed options={QUESTIONS_STUB}>
          <Scenario run={scrolledTo('.entry-question')}>
            <SessionView session={QUESTIONS} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="Questions asked in a dialog, 600 px and narrower"
        note="Long questions, options and answers wrap; nothing scrolls sideways. Scrolled to the first question."
        frame="view"
        width={375}
      >
        <Stubbed options={QUESTIONS_STUB}>
          <Scenario run={scrolledTo('.entry-question')}>
            <SessionView session={QUESTIONS_NARROW} listed onClose={noop} compact />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="Copying a code block" note="Copy, pressed: the copied icon for --pw-copied-timeout, and a Copied toast, as every copy button gives. These stay, for the gallery." frame="view" lasting>
        <ToastProvider>
          <Stubbed options={MARKDOWN_STUB}>
            <Scenario run={copyCode}>
              <SessionView session={MARKDOWN_COPY} listed onClose={noop} />
            </Scenario>
          </Stubbed>
        </ToastProvider>
      </Specimen>
      <Specimen title="Folds open" note="Each call on its line, cut with an ellipsis and whole in a tooltip, with its own error badge. Scrolled to the top." frame="tall">
        <Stubbed>
          <Scenario run={openFolds}>
            <SessionView session={CONVERSATION_OPEN} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="Folds open, 600 px and narrower" note="The long lines give way; nothing scrolls sideways." frame="view" width={375}>
        <Stubbed>
          <Scenario run={openFolds}>
            <SessionView session={CONVERSATION_NARROW} listed onClose={noop} compact />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="Load earlier" note="Outline sm, centred at the top. Scrolled to the top, where the button is." frame="short">
        <Stubbed options={{ conversation: 'older' }}>
          <Scenario run={toTop}>
            <SessionView session={EARLIER} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="Loading earlier" note="Busy, with its spinner after half a second, while the older page is on its way." frame="short">
        <Stubbed options={{ conversation: 'older-loading' }}>
          <Scenario
            run={async (root) => {
              await press(root, 'Load earlier');
              await element(root, '.load-earlier[aria-busy="true"]');
              await toTop(root);
            }}
          >
            <SessionView session={EARLIER_BUSY} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="Jump to latest"
        note="Scrolled up when three entries arrived: the place is kept, and the bar sticks to the bottom of the body, 8 px from the footer, until the reader gets there."
        frame="view"
      >
        <Stubbed options={{ conversation: 'growing' }}>
          <Scenario run={scrollUpThenMore}>
            <Refreshing session={JUMP}>{(shown) => <SessionView session={shown} listed onClose={noop} />}</Refreshing>
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="Couldn't load earlier messages" note="A warning alert in Load earlier's place, with Try again: what's shown is kept." frame="short">
        <Stubbed options={{ conversation: 'older-failed' }}>
          <Scenario run={(root) => earlierUntil(root, '.conversation-alert.warning')}>
            <SessionView session={EARLIER_FAILED} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="Couldn't load earlier messages, trying again" note="Try again busy, the alert kept until the page arrives." frame="short">
        <Stubbed options={{ conversation: 'older-failed-retrying' }}>
          <Scenario
            run={async (root) => {
              await earlierUntil(root, '.conversation-alert.warning');
              await press(root, 'Try again');
              await element(root, '.conversation-alert [aria-busy="true"]');
            }}
          >
            <SessionView session={EARLIER_RETRYING} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="The transcript changed"
        note="Load earlier found the transcript replaced, so the view starts again from its newest page, at the top, under a neutral notice."
        frame="short"
      >
        <Stubbed options={{ conversation: 'stale' }}>
          <Scenario run={(root) => earlierUntil(root, '.conversation-alert.neutral')}>
            <SessionView session={STALE} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="A refresh failed"
        note="The session did something and the newest page didn't load: the entries stay, and a warning at the end says they may be out of date."
        frame="short"
      >
        <Stubbed options={{ conversation: 'refresh-failed' }}>
          <Scenario run={(root) => refreshUntil(root, '.conversation-alert.end.warning')}>
            <Refreshing session={REFRESH_FAILED}>{(shown) => <SessionView session={shown} listed onClose={noop} />}</Refreshing>
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="A refresh failed, trying again" note="Try again busy; the entries and the alert stay until the page arrives." frame="short">
        <Stubbed options={{ conversation: 'refresh-failed-retrying' }}>
          <Scenario
            run={async (root) => {
              await refreshUntil(root, '.conversation-alert.end.warning');
              await press(root, 'Try again');
              await element(root, '.conversation-alert [aria-busy="true"]');
            }}
          >
            <Refreshing session={REFRESH_RETRYING}>{(shown) => <SessionView session={shown} listed onClose={noop} />}</Refreshing>
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="The transcript has gone" note="A refresh found no transcript: what was shown is kept, with a neutral notice at the end." frame="short">
        <Stubbed options={{ conversation: 'gone' }}>
          <Scenario run={(root) => refreshUntil(root, '.conversation-alert.end.neutral')}>
            <Refreshing session={GONE_TRANSCRIPT}>{(shown) => <SessionView session={shown} listed onClose={noop} />}</Refreshing>
          </Scenario>
        </Stubbed>
      </Specimen>
    </>
  );
}

const MESSAGE = 'Please also log each retry at debug level, with the attempt number.';
const DRAFT = 'Please also log each retry at debug level.\nInclude the attempt number,\nand the batch id.';
const LONG_DRAFT = Array.from({ length: 12 }, (_, line) => `Line ${line + 1} of a long draft, to show the box stops growing at eight lines.`).join('\n');

/** Types into the message box. */
const typeIn = (value: string) => async (root: HTMLElement) => {
  type(await element<HTMLTextAreaElement>(root, 'textarea'), value);
};

/** Types a message and presses Send, then waits for what the box shows after. */
const send = (after: (root: HTMLElement) => Promise<unknown>) => async (root: HTMLElement) => {
  type(await element<HTMLTextAreaElement>(root, 'textarea'), MESSAGE);
  await press(root, 'Send');
  await after(root);
};
const result = (root: HTMLElement) => element(root, '.relay-result');

interface Case {
  title: string;
  note?: string;
  session: SessionSummary;
  options?: StubOptions;
  run?: (root: HTMLElement) => Promise<unknown>;
  /** The conversation already shows the reply. */
  replyShown?: boolean;
  /** The draft the tab kept for it, as a reload finds it (W44), in the specimen's own memory. */
  kept?: StoredDraft;
}

/** The drafts a specimen's box finds, in memory of its own: as the tab would keep them, never the tab's. */
function KeptDrafts({ sessionId, draft, children }: { sessionId: string; draft: StoredDraft | undefined; children: ReactNode }) {
  const [drafts] = useState(() => memoryDrafts(draft ? storedDraft(sessionId, draft) : {}));
  return <DraftStorageContext.Provider value={drafts}>{children}</DraftStorageContext.Provider>;
}

const BOX_CASES: Case[] = [
  { title: 'Empty', note: 'One line, Send off until there is something to send.', session: session('box-empty') },
  { title: 'Typing', note: 'It grows a line at a time; Enter adds a line, ⌘ ↵ sends.', session: session('box-typing'), run: typeIn(DRAFT) },
  { title: 'A long draft', note: 'Eight lines at most, then it scrolls.', session: session('box-long'), run: typeIn(LONG_DRAFT) },
  {
    title: 'Near the limit',
    note: 'The count shows from 80 % of the limit.',
    session: session('box-near'),
    run: async (root) => {
      await typeIn('Retry each batch three times. '.repeat(240))(root);
      await text(root, '/ 8,192');
    },
  },
  {
    title: 'Over the limit',
    note: `More than ${MAX_RELAY_TEXT_LENGTH.toLocaleString('en')} characters, so Send is off.`,
    session: session('box-over'),
    run: async (root) => {
      await typeIn('Retry each batch three times. '.repeat(280))(root);
      await text(root, 'over the');
    },
  },
  {
    title: 'Sending',
    note: 'Send is busy, with its spinner after half a second, and the text is read-only.',
    session: session('box-sending'),
    options: { relay: 'sending' },
    run: send((root) => text(root, 'Sending…')),
  },
  { title: 'Delivered', note: 'A success alert, role="status".', session: session('box-delivered'), options: { relay: { status: 'delivered' } }, run: send(result) },
  {
    title: 'Delivered on one more try',
    note: 'W52: pitwall’s gate stopped the relay’s first copy, whose text alone differed, here only in its spacing, and the second went through. The server’s detail says so, in code style, as other results’ do.',
    session: session('box-delivered-retried'),
    options: { relay: { status: 'delivered', detail: RETRIED_DETAIL } },
    run: send(result),
  },
  {
    title: 'Held for approval',
    note: 'A warning, role="alert". The server’s detail is in code style.',
    session: session('box-held'),
    options: { relay: { status: 'held', detail: 'pitwall-test-box-held holds messages from other sessions until they are approved.' } },
    run: send(result),
  },
  {
    title: 'May have arrived',
    note: 'A warning. The draft stays.',
    session: session('box-uncertain'),
    options: { relay: { status: 'uncertain', detail: 'The relay stopped before SendMessage returned.' } },
    run: send(result),
  },
  {
    title: 'Refused',
    note: 'Danger. The draft clears: it reached the session, which refused it.',
    session: session('box-refused'),
    options: { relay: { status: 'refused', detail: 'pitwall-test-box-refused accepts messages only from sessions it started.' } },
    run: send(result),
  },
  {
    title: 'Not sent',
    note: 'Danger. The draft stays.',
    session: session('box-failed'),
    options: { relay: { status: 'failed', detail: 'No live session is named pitwall-test-box-failed.' } },
    run: send(result),
  },
  {
    title: "pitwall didn't answer",
    note: "pitwall's own failure, before the relay answered: the message may have gone, so a warning that says to check, as May have arrived does. A server error says the same. The draft stays.",
    session: session('box-unreachable'),
    options: { relay: 'unreachable' },
    run: send(result),
  },
  {
    title: 'pitwall refused the request',
    note: 'Danger: pitwall refused it before the relay ran, so nothing was sent. The draft stays.',
    session: session('box-refused-request'),
    options: { relay: 'refused-request' },
    run: send(result),
  },
  {
    title: 'Kept through a reload',
    note: "The tab's sessionStorage kept the draft, so the box starts with it, editable, with Send as it was. Each conversation has its own.",
    session: session('box-kept'),
    kept: { text: DRAFT },
  },
  {
    title: 'Being sent when the page reloaded',
    note: 'A warning, with no role, since it was there when the box appeared, and linked to the text box. It goes once the draft is edited or sent; Send is as it was.',
    session: session('box-kept-out'),
    kept: { text: MESSAGE, send: { at: ago(2), state: 'out' } },
  },
  {
    title: 'May have arrived, then a reload',
    note: 'An uncertain answer, then a reload: the same warning, in its own words.',
    session: session('box-kept-uncertain'),
    kept: { text: MESSAGE, send: { at: ago(6), state: 'uncertain' } },
  },
  {
    title: 'Kept, and its session has stopped',
    note: 'A kept draft whose session stopped running meanwhile: the draft, with the note saying why it can’t be sent.',
    session: session('box-kept-stopped-since', { alive: false, pid: undefined, status: undefined }),
    kept: { text: DRAFT },
  },
  { title: 'With the latest exchange', note: 'The last message from pitwall, and the reply that came back.', session: VIEW_INTERACTIVE },
  {
    title: 'The reply already in the conversation',
    note: 'Shown once, in full, in the conversation, as the message the session sent pitwall’s relay (W46): the footer keeps only the status line, which says so.',
    session: session('box-reply-shown', { relay: exchange('delivered', 'Yes: the export job retries now, and the tests pass.') }),
    replyShown: true,
  },
  {
    title: 'The reply in the conversation, held',
    note: 'The status keeps its tone; the words after it are the line’s own.',
    session: session('box-reply-shown-held', { relay: exchange('held', 'Approved, and done.') }),
    replyShown: true,
  },
  { title: 'The latest exchange, held', note: 'Its status in --pw-warning-fg.', session: session('box-exchange-held', { relay: exchange('held') }) },
  { title: 'The latest exchange, not sent', note: 'Its status in --pw-danger-fg, with no band.', session: session('box-exchange-failed', { relay: exchange('failed') }) },
  {
    title: "Can't be messaged",
    note: 'It isn’t running: the note alone, without the limits note.',
    session: session('box-not-running', { alive: false, pid: undefined, status: undefined }),
  },
];

const KEPT_RUNNING = session('box-kept-stopped');
const KEPT_LISTED = session('box-kept-unlisted');

/**
 * A message box whose session stops running, or leaves the list, as soon as a draft is typed into it,
 * as a poll would say while the draft is being written: the draft stays, with why it can't be sent.
 */
function GoesWhileDrafting({ session: shown, goes }: { session: SessionSummary; goes: 'stops' | 'unlisted' }) {
  const [gone, setGone] = useState(false);
  const current = gone && goes === 'stops' ? { ...shown, alive: false, pid: undefined, status: undefined } : shown;
  return (
    <RelayBox
      session={current}
      listed={!(gone && goes === 'unlisted')}
      onDraftChange={(has) => {
        if (has) setGone(true);
      }}
    />
  );
}

export function MessageBoxes() {
  return (
    <div className="uikit-panel-width">
      {BOX_CASES.map((box) => (
        <Specimen key={box.title} title={box.title} note={box.note}>
          <Stubbed options={box.options}>
            <KeptDrafts sessionId={box.session.sessionId} draft={box.kept}>
              <MaybeScenario run={box.run}>
                <footer className="session-view-foot">
                  <RelayBox session={box.session} replyShown={box.replyShown ?? false} />
                </footer>
              </MaybeScenario>
            </KeptDrafts>
          </Stubbed>
        </Specimen>
      ))}
      <Specimen title="A draft, when the session stops" note="The draft stays, and can be edited or copied; Send is off, and the note says why. Cleared, the box gives way to the not-running note.">
        <Stubbed>
          <Scenario run={async (root) => {
            await typeIn(DRAFT)(root);
            await element(root, '.relay-kept');
          }}>
            <footer className="session-view-foot">
              <GoesWhileDrafting session={KEPT_RUNNING} goes="stops" />
            </footer>
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="A draft, when the session leaves the list" note="The footer stays while the draft does, under the header's no-longer-listed alert. Cleared, the footer goes.">
        <Stubbed>
          <Scenario run={async (root) => {
            await typeIn(DRAFT)(root);
            await element(root, '.relay-kept');
          }}>
            <footer className="session-view-foot">
              <GoesWhileDrafting session={KEPT_LISTED} goes="unlisted" />
            </footer>
          </Scenario>
        </Stubbed>
      </Specimen>
    </div>
  );
}

/** Chooses Stop or Remove in the actions menu, and with `then`, confirms it and waits for what follows. */
const confirm = (action: 'Stop' | 'Remove', then?: (root: HTMLElement) => Promise<unknown>) => async (root: HTMLElement) => {
  await chooseFromMenu(root, `${action} session`);
  await element(root, '.inline-confirm');
  if (!then) return;
  await press(root, `${action} session`);
  await then(root);
};

const working = (name: string) => background(name, { state: 'working' });

interface ConfirmCase extends Case {
  /** For the restart: the attach server's script. */
  script?: AttachScript;
}

const ACTION_CASES: ConfirmCase[] = [
  { title: 'Stop: asking', note: 'Cancel has focus as it opens.', session: working('actions-confirm-stop'), run: confirm('Stop') },
  {
    title: 'Stop: stopping',
    note: 'Busy: the spinner after half a second, the width kept, Cancel off, Escape ignored.',
    session: working('actions-stopping'),
    options: { stop: 'busy' },
    run: confirm('Stop', (root) => text(root, 'Stopping…')),
  },
  {
    title: 'Stop: stopped',
    note: 'A toast, announced by the stack’s live region, and focus back on the menu button.',
    session: working('actions-stopped'),
    options: { stop: 'done' },
    run: confirm('Stop', (root) => text(specimenOf(root), 'Stopped.')),
  },
  { title: 'Remove: asking', session: working('actions-confirm-remove'), run: confirm('Remove') },
  {
    title: 'Remove: removing',
    session: working('actions-removing'),
    options: { remove: 'busy' },
    run: confirm('Remove', (root) => text(root, 'Removing…')),
  },
  {
    title: 'Remove: removed',
    note: 'A toast with its name; in the app, the view closes.',
    session: working('actions-removed'),
    options: { remove: 'done' },
    run: confirm('Remove', (root) => text(specimenOf(root), 'Removed pitwall-test-actions-removed')),
  },
  {
    title: 'Remove: refused',
    note: "pitwall's sentence, then Claude Code's message in code style.",
    session: working('actions-refused'),
    options: { remove: 'refused' },
    run: confirm('Remove', (root) => element(root, '.inline-alert.danger')),
  },
  {
    title: 'Restart and attach: asking',
    note: 'Opening Terminal on a session that isn’t running. Under the terminal’s bar, with the warning bar; role="alertdialog".',
    session: working('actions-restart'),
    script: 'restart',
    run: async (root) => {
      await openTerminal(root);
      await element(root, '.inline-confirm');
    },
  },
  {
    title: 'Restart and attach: restarting',
    note: 'Busy until the attach has started or failed.',
    session: working('actions-restarting'),
    script: 'restart-pending',
    run: async (root) => {
      await openTerminal(root);
      await element(root, '.inline-confirm');
      await press(root, 'Restart and attach');
      await text(root, 'Restarting…');
    },
  },
];

export function Confirmations() {
  return (
    <>
      {ACTION_CASES.map((action) => (
        // With a toasts' stack of its own, as the app has, whose toasts stay here.
        <Specimen key={action.title} title={action.title} note={action.note} frame="short" lasting>
          <ToastProvider>
            <Attachable script={action.script ?? 'attached'}>
              <Stubbed options={action.options}>
                <MaybeScenario run={action.run}>
                  <SessionView session={action.session} listed onClose={noop} />
                </MaybeScenario>
              </Stubbed>
            </Attachable>
          </ToastProvider>
        </Specimen>
      ))}
    </>
  );
}

/** Opens the Terminal tab, then waits for the terminal's status to be `state`, and for a notice when it has ended. */
const attach = (state: string) => async (root: HTMLElement) => {
  await openTerminal(root);
  await until(`the terminal to be ${state}`, () => root.querySelector(`.attach-status[data-status="${state}"]`));
  if (state === 'ended') await element(root, '.attach-notice');
};

interface TerminalCase {
  title: string;
  note?: string;
  script: AttachScript;
  /** The status the terminal settles on. */
  state: string;
  session: SessionSummary;
}

const TERMINAL_CASES: TerminalCase[] = [
  {
    title: 'Attaching',
    note: 'A subtle neutral badge with a spinner, and an empty screen. The scripted server never answers, so it stays here.',
    script: 'connecting',
    state: 'connecting',
    session: working('terminal-connecting'),
  },
  {
    title: 'Attached',
    note: "A subtle success badge with a dot, and xterm.js in JetBrains Mono, its colours from the --pw-term-* tokens, with made-up output. F6 leaves it, for the Terminal tab. Shift+↵ sends a line feed, a new line in Claude Code's prompt; the shortcuts dialog lists it, since the hint has no room for it at 375 px.",
    script: 'attached',
    state: 'attached',
    session: working('terminal-attached'),
  },
  {
    title: 'Not running',
    note: "An outline badge: the session isn't running, so attaching asks first.",
    script: 'restart',
    state: 'confirm-restart',
    session: working('terminal-restart'),
  },
  {
    title: 'Detached',
    note: 'claude attach exited cleanly, as it does when you detach inside it: a neutral notice above the screen, Attach again, and Back to the conversation.',
    script: 'exit',
    state: 'ended',
    session: working('terminal-exit'),
  },
  { title: "Couldn't attach", note: 'The server refused, so a danger notice.', script: 'error', state: 'ended', session: working('terminal-error') },
  { title: 'Too many attached', note: 'Four sessions are attached already, so a danger notice.', script: 'too-many', state: 'ended', session: working('terminal-too-many') },
];

export function Terminals() {
  return (
    <>
      {TERMINAL_CASES.map((terminal) => (
        <Specimen key={terminal.title} title={terminal.title} note={terminal.note} frame="short">
          <Attachable script={terminal.script}>
            <Stubbed>
              <Scenario run={attach(terminal.state)}>
                <SessionView session={terminal.session} listed onClose={noop} />
              </Scenario>
            </Stubbed>
          </Attachable>
        </Specimen>
      ))}
    </>
  );
}

const SAMPLE_MENU: MenuEntry[] = [
  { id: 'copy', label: 'Copy session ID', icon: 'copy', onSelect: noop },
  { id: 'off', label: 'Stop session', icon: 'stop', disabled: true, hint: "It isn't running, so there's nothing to stop.", onSelect: noop },
  { kind: 'separator', id: 'separator' },
  { id: 'danger', label: 'Remove session', icon: 'remove', danger: true, onSelect: noop },
];

/** A menu button's frame: the space below it that the open menu needs. */
function MenuStage({ children, radio = false }: { children: ReactNode; radio?: boolean }) {
  return <div className={radio ? 'uikit-menu-stage uikit-menu-stage-radio' : 'uikit-menu-stage'}>{children}</div>;
}

/**
 * A made-up radio group in a menu, with a choice of its own, so choosing one checks it. View
 * preferences used the menu's radio groups (W42, W54) until it became the Preferences dialog (W59);
 * nothing in the app has one now.
 */
function LiveRadioMenu() {
  const [choice, setChoice] = useState('first');
  const entries: MenuEntry[] = [
    { id: 'copy', label: 'Copy session ID', icon: 'copy', onSelect: noop },
    { kind: 'separator', id: 'separator' },
    {
      kind: 'radio-group',
      id: 'made-up',
      title: 'A made-up choice',
      value: choice,
      options: [
        { value: 'first', label: 'The first', description: 'A line saying what choosing it does, which wraps under its label.' },
        { value: 'second', label: 'The second', description: 'Another line.' },
      ],
      onChange: setChoice,
    },
  ];
  return <MenuButton label="Made-up choices" icon="more" entries={entries} />;
}

const clickMenuButton = async (root: HTMLElement) => (await element<HTMLButtonElement>(root, 'button[aria-haspopup="menu"]')).click();

export function Menus() {
  return (
    <>
      <Specimen title="Closed" note="A ghost md icon button with aria-haspopup=menu, named by its tooltip.">
        <MenuStage>
          <MenuButton label="Session actions" icon="more" entries={SAMPLE_MENU} />
        </MenuStage>
      </Specimen>
      <Specimen
        title="Open"
        note="An item, a disabled item (its reason in a tooltip, on hover and when ↑ ↓ reach it), a separator, then a danger item. Below its button, aligned to its end; ↑ ↓ Home End move, Enter or Space activates, Escape or Tab closes."
      >
        <Scenario run={clickMenuButton}>
          <MenuStage>
            <MenuButton label="Session actions" icon="more" entries={SAMPLE_MENU} />
          </MenuStage>
        </Scenario>
      </Specimen>
      <Specimen
        title="A radio group, open (W42)"
        note="An item, a separator, then a radio group: its title, then its options, each with a line saying what it does, the chosen one with the check mark, taking focus as the menu opens. ↑ ↓ Home End move through items and options alike, Enter, Space or a click chooses and closes, Escape or Tab closes."
      >
        <Scenario run={clickMenuButton}>
          <MenuStage radio>
            <LiveRadioMenu />
          </MenuStage>
        </Scenario>
      </Specimen>
    </>
  );
}
