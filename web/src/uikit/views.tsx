// The session view and what's in it (W19, W22, W24): the real SessionView, its actions menu and their
// inline confirmations, RelayBox in every send state, and the terminal, each given a stub API (stubs.ts) and put into its state
// by a scenario (kit.tsx), as a person would: opening the menu, choosing an item, opening a tab.
// Every fixture is made once, when the gallery loads, so a re-render never changes a session's id.

import { useState, type ReactNode } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { AttachContext } from '../attach.js';
import { MenuButton, type MenuEntry } from '../components/Menu.js';
import { RelayBox } from '../components/RelayBox.js';
import { SessionView, UnlistedSessionView } from '../components/SessionView.js';
import { MAX_RELAY_TEXT_LENGTH } from '../relay.js';
import { APP_DIR, background, exchange, NOW, ROOT, session, VIEW_BACKGROUND, VIEW_BACKGROUND_DONE, VIEW_INTERACTIVE } from './fixtures.js';
import { element, press, Scenario, Specimen, text, type, until } from './kit.js';
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
const OLDER = session('view-older');
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
    ['Loading the conversation', 'loading'],
    ["Couldn't load it", 'failed'],
    ['No transcript', 'missing'],
    ['Nothing yet', 'empty'],
  ] as const
).map(([title, conversation]) => ({ title, options: { conversation }, session: background(`view-${conversation}`, { state: 'working' }) }));
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
          <SessionView session={VIEW_INTERACTIVE} listed now={NOW} onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="Background" note="The actions menu in the header, no message box, and older entries behind Load earlier." frame="view">
        <Stubbed options={{ conversation: 'older' }}>
          <SessionView session={VIEW_BACKGROUND} listed now={NOW} onClose={noop} />
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
              <SessionView session={ATTACHED} listed now={NOW} onClose={noop} />
            </Scenario>
          </Stubbed>
        </Attachable>
      </Specimen>
      <Specimen title="Background, not running" note="It has finished, so Stop is off in the menu, and opening Terminal asks before restarting it." frame="short">
        <Stubbed>
          <SessionView session={VIEW_BACKGROUND_DONE} listed now={NOW} onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="No longer listed" note="The session left the snapshot, so the view keeps what it showed, without the message box, the actions or the terminal." frame="short">
        <Stubbed>
          <SessionView session={GONE} listed={false} now={NOW} onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="Directory gone" note="Its working directory no longer exists, as after a worktree was removed." frame="short">
        <Stubbed>
          <SessionView session={MISSING_DIR} listed now={NOW} onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="A long name and title" note="The title gives way first, then the name, and the directory in the middle." frame="short">
        <Stubbed>
          <SessionView session={LONG_TITLE} listed now={NOW} onClose={noop} />
        </Stubbed>
      </Specimen>
      <Specimen title="Not listed under these roots" note="A ?session= in the URL that pitwall doesn't list, with Close." frame="short">
        <UnlistedSessionView sessionId="00000000-0000-4000-8000-00000000dead" roots={[ROOT]} onClose={noop} />
      </Specimen>
      <Specimen title="600 px and narrower" note="Full width, with Back to sessions in place of Close." frame="short" width={375}>
        <Stubbed>
          <SessionView session={COMPACT} listed now={NOW} onClose={noop} compact />
        </Stubbed>
      </Specimen>
      <Specimen title="Actions menu, background" note="Copy session ID, Copy attach command, then Stop session and Remove session, in danger text." frame="short">
        <Stubbed>
          <Scenario run={openMenu}>
            <SessionView session={MENU_BACKGROUND} listed now={NOW} onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="Actions menu, not running" note="Stop session is off: there's nothing to stop." frame="short">
        <Stubbed>
          <Scenario run={openMenu}>
            <SessionView session={MENU_DONE} listed now={NOW} onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen title="Actions menu, interactive" note="Only Copy session ID: it has no attach command, and can't be stopped or removed from here." frame="short">
        <Stubbed>
          <Scenario run={openMenu}>
            <SessionView session={MENU_INTERACTIVE} listed now={NOW} onClose={noop} />
          </Scenario>
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
    title: "Couldn't reach pitwall",
    note: "pitwall's own failure, before the relay answered. The draft stays.",
    session: session('box-unreachable'),
    options: { relay: 'unreachable' },
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

export function MessageBoxes() {
  return (
    <div className="uikit-panel-width">
      {BOX_CASES.map((box) => (
        <Specimen key={box.title} title={box.title} note={box.note}>
          <Stubbed options={box.options}>
            <MaybeScenario run={box.run}>
              <footer className="session-view-foot">
                <RelayBox session={box.session} now={NOW} replyShown={box.replyShown ?? false} />
              </footer>
            </MaybeScenario>
          </Stubbed>
        </Specimen>
      ))}
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
  { title: 'Stop: stopped', note: 'The result, announced. A toast once toasts exist (W25).', session: working('actions-stopped'), options: { stop: 'done' }, run: confirm('Stop', (root) => text(root, 'Stopped.')) },
  { title: 'Remove: asking', session: working('actions-confirm-remove'), run: confirm('Remove') },
  {
    title: 'Remove: removing',
    session: working('actions-removing'),
    options: { remove: 'busy' },
    run: confirm('Remove', (root) => text(root, 'Removing…')),
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
        <Specimen key={action.title} title={action.title} note={action.note} frame="short">
          <Attachable script={action.script ?? 'attached'}>
            <Stubbed options={action.options}>
              <MaybeScenario run={action.run}>
                <SessionView session={action.session} listed now={NOW} onClose={noop} />
              </MaybeScenario>
            </Stubbed>
          </Attachable>
        </Specimen>
      ))}
    </>
  );
}

/** Opens the Terminal tab, then waits for the terminal's status to be `state`. */
const attach = (state: string) => async (root: HTMLElement) => {
  await openTerminal(root);
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
      <Specimen title="Closed" note="A ghost md icon button with aria-haspopup=menu.">
        <MenuStage>
          <MenuButton label="Session actions" icon="more" entries={SAMPLE_MENU} />
        </MenuStage>
      </Specimen>
      <Specimen
        title="Open"
        note="An item, a disabled item (its reason in the hover text), a separator, then a danger item. Below its button, aligned to its end; ↑ ↓ Home End move, Enter or Space activates, Escape or Tab closes."
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
