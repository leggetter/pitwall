// The session view and what's in it (W19): the real SessionView, RelayBox, SessionActions and
// terminal, each given a stub API (stubs.ts) and put into its state by a scenario (kit.tsx).
// Every fixture is made once, when the gallery loads, so a re-render never changes a session's id.

import { useState, type ReactNode } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { AttachContext } from '../attach.js';
import { RelayBox } from '../components/RelayBox.js';
import { SessionActions } from '../components/SessionActions.js';
import { SessionView } from '../components/SessionView.js';
import { createReplyLoader, ReplyLoaderContext } from '../lastMessage.js';
import { MAX_RELAY_TEXT_LENGTH } from '../relay.js';
import { background, NOW, session, VIEW_BACKGROUND, VIEW_BACKGROUND_DONE, VIEW_INTERACTIVE } from './fixtures.js';
import { element, press, Scenario, Specimen, text, type, until } from './kit.js';
import { scriptedAttach, stubApi, type AttachScript, type StubOptions } from './stubs.js';

const noop = () => {};

/** A stub API for everything inside, made once from `options` when it mounts. */
export function Stubbed({ options = {}, children }: { options?: StubOptions; children: ReactNode }) {
  const [context] = useState(() => {
    const api = stubApi(options);
    return { api, loader: createReplyLoader({ api }) };
  });
  return (
    <ApiContext.Provider value={context.api}>
      <ReplyLoaderContext.Provider value={context.loader}>{children}</ReplyLoaderContext.Provider>
    </ApiContext.Provider>
  );
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
const OLDER = session('view-older');
const CONVERSATION_STATES = (
  [
    ['Loading the conversation', 'loading'],
    ["Couldn't load it", 'failed'],
    ['No transcript', 'missing'],
    ['Nothing yet', 'empty'],
  ] as const
).map(([title, conversation]) => ({ title, options: { conversation }, session: background(`view-${conversation}`, { state: 'working' }) }));
const NO_API = background('view-no-api', { state: 'working' });

/** Waits for Load earlier, then scrolls the conversation up to it, as a reader would. */
async function toTop(root: HTMLElement): Promise<void> {
  const button = await element(root, '.load-earlier');
  const body = button.closest<HTMLElement>('.session-view-body');
  if (body) body.scrollTop = 0;
}

export function SessionViews() {
  return (
    <>
      <Specimen title="Interactive" note="The conversation, with one of each kind of entry, and the message box below it showing the latest exchange." frame="view">
        <Stubbed>
          <SessionView session={VIEW_INTERACTIVE} listed now={NOW} onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="Background" note="Attach, Stop and Remove in the header, no message box, and older entries behind Load earlier." frame="view">
        <Stubbed options={{ conversation: 'older' }}>
          <SessionView session={VIEW_BACKGROUND} listed now={NOW} onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="Background, finished" note="It isn't running, so Stop is off; attaching would ask to restart it." frame="short">
        <Stubbed>
          <SessionView session={VIEW_BACKGROUND_DONE} listed now={NOW} onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="No longer listed" note="The session left the snapshot, so the view keeps what it showed, without the message box or actions." frame="short">
        <Stubbed>
          <SessionView session={GONE} listed={false} now={NOW} onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="Interactive, with Load earlier" note="Scrolled to the top, where the button is." frame="short">
        <Stubbed options={{ conversation: 'older' }}>
          <Scenario run={toTop}>
            <SessionView session={OLDER} listed now={NOW} onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      {CONVERSATION_STATES.map((state) => (
        <Specimen key={state.title} title={state.title} frame="short">
          <Stubbed options={state.options}>
            <SessionView session={state.session} listed now={NOW} onClose={noop} />
          </Stubbed>
        </Specimen>
      ))}
      <Specimen title="No API" note="Rendered without an API client, as some tests do." frame="short">
        <ApiContext.Provider value={undefined}>
          <SessionView session={NO_API} listed now={NOW} onClose={noop} />
        </ApiContext.Provider>
      </Specimen>
    </>
  );
}

const MESSAGE = 'Please also log each retry at debug level, with the attempt number.';

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
}

const BOX_CASES: Case[] = [
  { title: 'Empty', session: session('box-empty') },
  { title: 'With the latest exchange', note: 'The last message from pitwall, and the reply that came back.', session: VIEW_INTERACTIVE },
  { title: 'Delivered', session: session('box-delivered'), options: { relay: { status: 'delivered' } }, run: send(result) },
  {
    title: 'Held for approval',
    session: session('box-held'),
    options: { relay: { status: 'held', detail: 'pitwall-test-box-held holds messages from other sessions until they are approved.' } },
    run: send(result),
  },
  {
    title: 'Refused',
    session: session('box-refused'),
    options: { relay: { status: 'refused', detail: 'pitwall-test-box-refused accepts messages only from sessions it started.' } },
    run: send(result),
  },
  {
    title: 'Not sent',
    session: session('box-failed'),
    options: { relay: { status: 'failed', detail: 'No live session is named pitwall-test-box-failed.' } },
    run: send(result),
  },
  {
    title: "Couldn't reach pitwall",
    note: "pitwall's own failure, before the relay answered. The draft stays.",
    session: session('box-unreachable'),
    options: { relay: 'unreachable' },
    run: send(result),
  },
  {
    title: 'May have arrived',
    session: session('box-uncertain'),
    options: { relay: { status: 'uncertain', detail: 'The relay stopped before SendMessage returned.' } },
    run: send(result),
  },
  { title: 'Sending', session: session('box-sending'), options: { relay: 'sending' }, run: send((root) => text(root, 'Sending…')) },
  {
    title: 'Over the limit',
    note: `More than ${MAX_RELAY_TEXT_LENGTH.toLocaleString('en')} characters, so Send is off.`,
    session: session('box-over'),
    run: async (root) => {
      type(await element<HTMLTextAreaElement>(root, 'textarea'), 'Retry each batch three times. '.repeat(280));
      await text(root, 'over the');
    },
  },
  { title: 'Not running', session: session('box-not-running', { alive: false, pid: undefined, status: undefined }) },
];

export function MessageBoxes() {
  return (
    <div className="uikit-panel-width">
      {BOX_CASES.map((box) => (
        <Specimen key={box.title} title={box.title} note={box.note}>
          <Stubbed options={box.options}>
            <MaybeScenario run={box.run}>
              <footer className="session-view-foot uikit-surface">
                <RelayBox session={box.session} now={NOW} />
              </footer>
            </MaybeScenario>
          </Stubbed>
        </Specimen>
      ))}
    </div>
  );
}

/** Opens a confirmation and, with `then`, confirms it and waits for what follows. */
const confirm = (action: 'Stop' | 'Remove', then?: (root: HTMLElement) => Promise<unknown>) => async (root: HTMLElement) => {
  await press(root, action);
  await element(root, '.session-confirm');
  if (!then) return;
  await press(root, `${action} session`);
  await then(root);
};

const working = (name: string) => background(name, { state: 'working' });

const ACTION_CASES: Case[] = [
  { title: 'Ready', session: working('actions-ready') },
  { title: 'Not running', session: VIEW_BACKGROUND_DONE },
  { title: 'Confirm stop', session: working('actions-confirm-stop'), run: confirm('Stop') },
  { title: 'Confirm remove', session: working('actions-confirm-remove'), run: confirm('Remove') },
  { title: 'Stopping', session: working('actions-stopping'), options: { stop: 'busy' }, run: confirm('Stop', (root) => text(root, 'Stopping…')) },
  { title: 'Removing', session: working('actions-removing'), options: { remove: 'busy' }, run: confirm('Remove', (root) => text(root, 'Removing…')) },
  { title: 'Stopped', session: working('actions-stopped'), options: { stop: 'done' }, run: confirm('Stop', (root) => element(root, '.action-result')) },
  {
    title: 'Refused',
    session: working('actions-refused'),
    options: { remove: 'refused' },
    run: confirm('Remove', (root) => element(root, '.action-result.failed')),
  },
];

export function Confirmations() {
  return (
    <div className="uikit-grid">
      {ACTION_CASES.map((action) => (
        <Specimen key={action.title} title={action.title}>
          <Stubbed options={action.options}>
            <MaybeScenario run={action.run}>
              <div className="session-view-head uikit-surface">
                <SessionActions session={action.session} onRemoved={noop} />
              </div>
            </MaybeScenario>
          </Stubbed>
        </Specimen>
      ))}
    </div>
  );
}

/** Presses Attach, then waits for the terminal's status to be `state`. */
const attach = (state: string) => async (root: HTMLElement) => {
  await press(root, 'Attach');
  await until(`the terminal to be ${state}`, () => root.querySelector(`.attach-state.state-${state}`));
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
  { title: 'Attaching', note: 'The scripted server never answers, so it stays here.', script: 'connecting', state: 'connecting', session: working('terminal-connecting') },
  { title: 'Attached', note: 'xterm.js, with made-up output.', script: 'attached', state: 'attached', session: working('terminal-attached') },
  {
    title: 'Restart and attach',
    note: "The session isn't running, so attaching asks first.",
    script: 'restart',
    state: 'confirm-restart',
    session: working('terminal-restart'),
  },
  { title: 'Ended', note: 'claude attach exited.', script: 'exit', state: 'ended', session: working('terminal-exit') },
  { title: "Couldn't attach", script: 'error', state: 'ended', session: working('terminal-error') },
  { title: 'Too many attached', script: 'too-many', state: 'ended', session: working('terminal-too-many') },
];

export function Terminals() {
  return (
    <>
      {TERMINAL_CASES.map((terminal) => (
        <Specimen key={terminal.title} title={terminal.title} note={terminal.note} frame="short">
          <Attachable script={terminal.script}>
            <Stubbed>
              <Scenario run={attach(terminal.state)}>
                <SessionView session={terminal.session} listed now={NOW} onClose={noop} />
              </Scenario>
            </Stubbed>
          </Attachable>
        </Specimen>
      ))}
    </>
  );
}
