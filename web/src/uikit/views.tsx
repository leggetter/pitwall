// The session view and what's in it (W19, W22, W24, W27, W28): the real SessionView, its conversation,
// its actions menu and their inline confirmations, RelayBox in every send state, and the terminal,
// each given a stub API (stubs.ts) and put into its state by a scenario (kit.tsx), as a person
// would: opening the menu, choosing an item, opening a tab, opening a fold, scrolling up.
// Every fixture is made once, when the gallery loads, so a re-render never changes a session's id.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { AttachContext } from '../attach.js';
import { slowFirstSnapshot } from '../components/Dashboard.js';
import { MenuButton, type MenuEntry } from '../components/Menu.js';
import { RelayBox } from '../components/RelayBox.js';
import { SessionView, UnlistedSessionView, WaitingSessionView } from '../components/SessionView.js';
import { ToastProvider } from '../components/Toast.js';
import { MAX_RELAY_TEXT_LENGTH } from '../relay.js';
import { APP_DIR, background, exchange, ROOT, session, VIEW_BACKGROUND, VIEW_BACKGROUND_DONE, VIEW_INTERACTIVE } from './fixtures.js';
import { element, laidOut, press, Scenario, Specimen, specimenOf, text, type, until } from './kit.js';
import { scriptedAttach, stubApi, type AttachScript, type StubOptions } from './stubs.js';

const noop = () => {};

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

/** Runs `run` when there is one; otherwise just shows the children. */
function MaybeScenario({ run, children }: { run: ((root: HTMLElement) => Promise<unknown>) | undefined; children: ReactNode }) {
  return run ? <Scenario run={run}>{children}</Scenario> : children;
}

const GONE = session('view-gone', { title: 'Export retries' });
const MISSING_DIR = background('view-missing-dir', {
  state: 'done',
  cwd: `${APP_DIR}/.claude/worktrees/pitwall-test-export-fix`,
  cwdMissing: true,
});
const LONG_TITLE = session('view-with-a-long-name-for-the-header', {
  title: 'Retry each failed export batch three times with backoff, keeping the 30 second timeout',
  cwd: `${APP_DIR}/packages/exports/src/jobs/retry`,
});
const ATTACHED = background('view-attached', { state: 'working' });
const MENU_BACKGROUND = background('view-menu', { state: 'working' });
const MENU_DONE = background('view-menu-done', { state: 'done', alive: false, pid: undefined, finished: true });
const MENU_INTERACTIVE = session('view-menu-interactive');
const COMPACT = session('view-compact', { title: 'Export retries' });
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
const NO_API = background('view-no-api', { state: 'working' });

/** Opens the session view's actions menu. */
async function openMenu(root: HTMLElement): Promise<HTMLElement> {
  (await element<HTMLButtonElement>(root, 'button[aria-label="Session actions"]')).click();
  return element(root, '[role="menu"]');
}

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
      <Specimen title="Background" note="The actions menu in the header, no message box, and older entries behind Load earlier." frame="view">
        <Stubbed options={{ conversation: 'older' }}>
          <SessionView session={VIEW_BACKGROUND} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="Background, attached" note="The Terminal tab open, attached to a scripted server, with the success dot on the tab." frame="view">
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
      <Specimen title="Background, not running" note="It has finished, so Stop is off in the menu, and opening Terminal asks before restarting it." frame="short">
        <Stubbed>
          <SessionView session={VIEW_BACKGROUND_DONE} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="No longer listed" note="The session left the snapshot, so the view keeps what it showed, without the message box, the actions or the terminal." frame="short">
        <Stubbed>
          <SessionView session={GONE} listed={false} onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="Directory gone" note="Its working directory no longer exists, as after a worktree was removed." frame="short">
        <Stubbed>
          <SessionView session={MISSING_DIR} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="A long name and title" note="The title gives way first, then the name, and the directory in the middle." frame="short">
        <Stubbed>
          <SessionView session={LONG_TITLE} listed onClose={noop} />
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
      <Specimen title="Actions menu, interactive" note="Only Copy session ID: it has no attach command, and can't be stopped or removed from here." frame="short">
        <Stubbed>
          <Scenario run={openMenu}>
            <SessionView session={MENU_INTERACTIVE} listed onClose={noop} />
          </Scenario>
        </Stubbed>
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
  { title: 'With the latest exchange', note: 'The last message from pitwall, and the reply that came back.', session: VIEW_INTERACTIVE },
  {
    title: 'The reply already in the conversation',
    note: 'Shown once: the footer keeps only the status line.',
    session: session('box-reply-shown', { relay: exchange('delivered', 'Yes: the export job retries now, and the tests pass.') }),
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
            <MaybeScenario run={box.run}>
              <footer className="session-view-foot">
                <RelayBox session={box.session} replyShown={box.replyShown ?? false} />
              </footer>
            </MaybeScenario>
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
    note: 'A subtle success badge with a dot, and xterm.js in JetBrains Mono, its colours from the --pw-term-* tokens, with made-up output. F6 leaves it, for the Terminal tab.',
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
function MenuStage({ children }: { children: ReactNode }) {
  return <div className="uikit-menu-stage">{children}</div>;
}

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
        <Scenario run={async (root) => (await element<HTMLButtonElement>(root, 'button[aria-haspopup="menu"]')).click()}>
          <MenuStage>
            <MenuButton label="Session actions" icon="more" entries={SAMPLE_MENU} />
          </MenuStage>
        </Scenario>
      </Specimen>
    </>
  );
}
