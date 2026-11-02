// The supervisor (M5, W114): the real repo list item in each of its states, the real SupervisorView in
// each of the supervisor's states, its draft cards of both kinds, editing, sending and failing, its
// message box sending, queued, refused and stopping, and the page with Needs you saying its drafts
// wait. Each specimen has its own stub API (stubs.ts) and its own drafts in memory, so typing in one
// changes none of the others. Every conversation, draft and error here is made up.

import { useState, type ReactNode } from 'react';
import type { IndexSnapshot, SupervisorApproval, SupervisorState } from '../../../src/shared/protocol.js';
import { AppStrips } from '../components/AppStrip.js';
import { Dashboard } from '../components/Dashboard.js';
import { RepoList } from '../components/RepoList.js';
import { SupervisorOffView, SupervisorView } from '../components/SupervisorView.js';
import { ToastProvider } from '../components/Toast.js';
import { DraftStorageContext } from '../drafts.js';
import { memoryNavigation, type Selection } from '../selection.js';
import { ago, APP_GROUP, JOBS_GROUP, LIST_SNAPSHOT, NOTES_GROUP, snapshot, SUPERVISOR_MESSAGE, SUPERVISOR_SPAWN } from './fixtures.js';
import { element, Scenario, Specimen, type } from './kit.js';
import { memoryDrafts, memoryStorage, type StubOptions } from './stubs.js';
import { Stubbed } from './views.js';

const noop = () => {};
const ALL: Selection = { view: 'all' };

const IDLE: SupervisorState = { status: 'idle', sessionId: 'pitwall-test-supervisor', approvals: [], lastTurnAt: ago(3), costUsd: 0.042 };
const HELD_ERROR =
  'A background session, 1a2b3c4d, is running the supervisor’s conversation, so pitwall can’t resume it. Stop it with `claude stop 1a2b3c4d`, then start the supervisor here.';
const FAILED_ERROR = 'Made up: claude exited with code 1 as it started. pitwall keeps the conversation; Start runs it again.';

/** A specimen's own drafts, so typing in its box changes no other specimen's. */
function OwnDrafts({ children }: { children: ReactNode }) {
  const [drafts] = useState(() => memoryDrafts());
  return <DraftStorageContext.Provider value={drafts}>{children}</DraftStorageContext.Provider>;
}

/** The view, framed as the window it overlays, on its own stub API and drafts. */
function View({ state, options = {}, run }: { state: SupervisorState; options?: StubOptions; run?: (root: HTMLElement) => Promise<unknown> }) {
  const view = (
    <ToastProvider>
      <OwnDrafts>
        <Stubbed options={options}>
          <SupervisorView state={state} onClose={noop} />
        </Stubbed>
      </OwnDrafts>
    </ToastProvider>
  );
  return run ? <Scenario run={run}>{view}</Scenario> : view;
}

/** The repo list with the Supervisor item first, in `state`. */
function Item({ state, open = false }: { state: SupervisorState; open?: boolean }) {
  const [selection, setSelection] = useState<Selection>(ALL);
  return (
    <RepoList
      groups={LIST_SNAPSHOT.groups}
      roots={LIST_SNAPSHOT.roots}
      selection={selection}
      onSelect={setSelection}
      supervisor={{ status: state.status, approvals: state.approvals.length, open, href: '?view=all&supervisor', onOpen: noop }}
    />
  );
}

/** The whole page, as the app has it, with the supervisor in `state`, from `search`. */
function Page({ state, search }: { state: SupervisorState; search: string }) {
  const [own] = useState(() => ({ storage: memoryStorage(), navigation: memoryNavigation(search) }));
  const page: IndexSnapshot = snapshot([APP_GROUP, JOBS_GROUP, NOTES_GROUP], { supervisor: state });
  return (
    <OwnDrafts>
      <Stubbed>
        <Dashboard view={{ state: 'live', snapshot: page }} storage={own.storage} navigation={own.navigation} />
      </Stubbed>
    </OwnDrafts>
  );
}

const card = (root: HTMLElement, index = 0) => element<HTMLElement>(root, `li.approval-card:nth-child(${index + 1})`);
const pressIn = async (root: HTMLElement, label: string, index = 0) => {
  const within = await card(root, index);
  const button = [...within.querySelectorAll<HTMLButtonElement>('button')].find((each) => each.textContent?.trim() === label);
  if (!button) throw new Error(`no ${label} on the card`);
  button.click();
};
const typeInBox = async (root: HTMLElement, text: string) => type(await element<HTMLTextAreaElement>(root, '.supervisor-box textarea'), text);
const send = async (root: HTMLElement) => (await element<HTMLButtonElement>(root, '.supervisor-box button[type="submit"]')).click();

const APPROVALS: SupervisorApproval[] = [SUPERVISOR_MESSAGE, SUPERVISOR_SPAWN];
const LONG_DRAFT: SupervisorApproval = {
  id: 'pitwall-test-approval-long',
  kind: 'message',
  to: 'pitwall-test-api',
  at: ago(4),
  expiresAt: ago(-25),
  text: `Please retry the made-up failed batch tonight, in the nightly window, not now.\n\nThen check the made-up export of the 3 GB file, the thumbnails job and the archive job, each with **its own** retry, and say which of them still fail.\n\n<b>Shown as written</b>, never as markup.\n\nOne more line.\nAnd another.\nAnd a last one, past eight, so it scrolls.`,
};

export function SupervisorSpecimens() {
  return (
    <>
      <Specimen title="The Supervisor item, idle" note="First in the repo list, above Needs you, in every root tab. Idle and off show nothing after its name." width={240}>
        <Item state={IDLE} />
      </Specimen>
      <Specimen title="Working, its view open" note="A subtle info badge with its dot, as a working session's; marked current while its view is open, as an open session's row is." width={240}>
        <Item state={{ ...IDLE, status: 'working' }} open />
      </Specimen>
      <Specimen title="Drafts waiting" note="Its drafts that wait on you, a solid count, as Needs you's; Needs you counts them too." width={240}>
        <Item state={{ ...IDLE, approvals: APPROVALS }} />
      </Specimen>
      <Specimen title="Held" note="A background session has its conversation: subtle warning, never solid." width={240}>
        <Item state={{ ...IDLE, status: 'held', error: HELD_ERROR }} />
      </Specimen>
      <Specimen title="Failed, with a draft" note="Subtle danger, then the draft's count." width={240}>
        <Item state={{ ...IDLE, status: 'failed', error: FAILED_ERROR, approvals: [SUPERVISOR_MESSAGE] }} />
      </Specimen>

      <Specimen title="Off: a new conversation" note="It isn't running, and there's no conversation yet: what it's for, and questions that fill the message box. Start, or a message, starts it; opening the view doesn't." frame="view">
        <View state={{ status: 'off', approvals: [] }} options={{ supervisorConversation: 'none' }} />
      </Specimen>
      <Specimen title="A question put in the box" note="One of the questions pressed: it's in the box, with focus there. It sends only with Send." frame="view">
        <View
          state={{ status: 'off', approvals: [] }}
          options={{ supervisorConversation: 'none' }}
          run={async (root) => (await element<HTMLButtonElement>(root, '[data-suggestion]')).click()}
        />
      </Specimen>
      <Specimen title="Starting" note="pitwall is starting it: Starting, with the spinner, and the working line says so, with no time." frame="view">
        <View state={{ status: 'starting', approvals: [] }} options={{ supervisorConversation: 'none' }} />
      </Specimen>
      <Specimen title="Idle, with its conversation" note="Its status, this run's cost, with what it counts behind the info button, and when its last turn ended. Its messages as markdown, as a session's (D15); its tool calls folded." frame="view">
        <View state={IDLE} />
      </Specimen>
      <Specimen title="Working" note="The working line at the end, from the snapshot's status, with its step; and Stop beside Send." frame="view">
        <View state={{ ...IDLE, status: 'working' }} />
      </Specimen>
      <Specimen title="Held" note="The error, in pitwall's words, with the claude stop command it names, to copy, and Start for once you've run it. pitwall never stops your session. Send is off, saying why." frame="view">
        <View state={{ ...IDLE, status: 'held', error: HELD_ERROR }} />
      </Specimen>
      <Specimen title="Failed" note="The error, with Start." frame="view">
        <View state={{ ...IDLE, status: 'failed', error: FAILED_ERROR }} />
      </Specimen>
      <Specimen title="Start, failing" note="Start pressed, and the start failed: pitwall's sentence, then the server's reason." frame="view">
        <View
          state={{ status: 'off', approvals: [] }}
          options={{ supervisorConversation: 'none', supervisorStart: 'failed' }}
          run={async (root) => (await element<HTMLButtonElement>(root, '[data-supervisor-start]')).click()}
        />
      </Specimen>
      <Specimen title="With --no-supervisor" note="A URL's ?supervisor when pitwall runs none." frame="short">
        <ToastProvider>
          <SupervisorOffView onClose={noop} />
        </ToastProvider>
      </Specimen>

      <Specimen title="Draft cards" note="Above the message box, oldest first: a message to a session, and a new session in a directory, named. Each one's text as text, in <bdi>, never markdown; when it's declined if you don't answer; Send, Edit and Don't send." frame="view">
        <View state={{ ...IDLE, approvals: APPROVALS }} />
      </Specimen>
      <Specimen title="A long draft" note="Eight lines, then its text scrolls, a Tab stop while it does; past 40% of the view, the cards scroll under their heading." frame="view">
        <View state={{ ...IDLE, approvals: [LONG_DRAFT, SUPERVISOR_SPAWN] }} />
      </Specimen>
      <Specimen title="Editing" note="Edit: the text in place, with focus in it, its count from 80% of 20,000, and Send edit and Cancel. Escape cancels the edit, not the view." frame="view">
        <View state={{ ...IDLE, approvals: APPROVALS }} run={(root) => pressIn(root, 'Edit')} />
      </Specimen>
      <Specimen title="Sending" note="Send pressed: busy, with the other answers off, until the snapshot drops the card." frame="view">
        <View state={{ ...IDLE, approvals: APPROVALS }} options={{ approval: 'deciding' }} run={(root) => pressIn(root, 'Send')} />
      </Specimen>
      <Specimen title="A decision that failed" note="pitwall's words, on the card; it can be answered again." frame="view">
        <View state={{ ...IDLE, approvals: APPROVALS }} options={{ approval: 'failed' }} run={(root) => pressIn(root, "Don't send")} />
      </Specimen>
      <Specimen title="A card that has gone" note="Answered in another tab, withdrawn, or out of time: it says so, and goes with the next snapshot." frame="view">
        <View state={{ ...IDLE, approvals: APPROVALS }} options={{ approval: 'gone' }} run={(root) => pressIn(root, 'Send', 1)} />
      </Specimen>

      <Specimen title="Sending a message" note="Send pressed: busy, the text box read-only." frame="view">
        <View
          state={IDLE}
          options={{ supervisorSend: 'sending' }}
          run={async (root) => {
            await typeInBox(root, 'What should I work on next?');
            await send(root);
          }}
        />
      </Specimen>
      <Specimen title="Queued" note="Sent while it works: it reads it when its turn ends." frame="view">
        <View
          state={{ ...IDLE, status: 'working' }}
          run={async (root) => {
            await typeInBox(root, 'And the pull requests?');
            await send(root);
          }}
        />
      </Specimen>
      <Specimen title="Not sent" note="pitwall refused it: its sentence, then the server's reason. The draft stays." frame="view">
        <View
          state={IDLE}
          options={{ supervisorSend: 'refused' }}
          run={async (root) => {
            await typeInBox(root, 'Hello?');
            await send(root);
          }}
        />
      </Specimen>
      <Specimen title="Maybe sent" note="No answer: it may have reached the supervisor, so check its conversation before sending again." frame="view">
        <View
          state={IDLE}
          options={{ supervisorSend: 'unreachable' }}
          run={async (root) => {
            await typeInBox(root, 'Hello?');
            await send(root);
          }}
        />
      </Specimen>
      <Specimen title="Stopping" note="Stop pressed: busy until the snapshot says the turn has stopped." frame="view">
        <View state={{ ...IDLE, status: 'working' }} options={{ supervisorStop: 'busy' }} run={async (root) => (await element<HTMLButtonElement>(root, '[data-supervisor-stop]')).click()} />
      </Specimen>

      <Specimen title="The page: its view open" note="In the third column, as ?supervisor, in a session's place." frame="page" width={1280}>
        <Page state={{ ...IDLE, approvals: APPROVALS }} search="?view=all&supervisor" />
      </Specimen>
      <Specimen title="The page: Needs you" note="Its drafts count in Needs you's badge and the page title; Needs you says they wait, with a way to its view." frame="page">
        <Page state={{ ...IDLE, approvals: APPROVALS }} search="?view=needs-you" />
      </Specimen>
      <Specimen title="App strip, held" note="While it's held or has failed, a line of the app strip, with Open." width={1024}>
        <AppStrips relayOff={undefined} recaps={undefined} supervisor={{ ...IDLE, status: 'held', error: HELD_ERROR }} onSupervisor={noop} />
      </Specimen>
    </>
  );
}
