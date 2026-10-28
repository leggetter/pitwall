// The session view's Sub-agents tab (W77): the real SessionView, given a stub API (stubs.ts) whose
// sub-agents are in each state, and put into its state by a scenario (kit.tsx), as a person would:
// opening the tab, a row, or Try again. The list in each state, nested ones, many, cut short, empty,
// loading and failed; a sub-agent's transcript; the conversation naming them; and at 375 px. The
// session row's running count is with the other rows (lists.tsx).
//
// Most specimens are a background session with an empty conversation, so they stay light: its
// conversation is behind the tab, and it has no message box.

import type { ConversationEntry } from '../../../src/shared/protocol.js';
import { SessionView } from '../components/SessionView.js';
import { background, REVIEW, SUBAGENT_CONVERSATION, VIEW_SUBAGENTS } from './fixtures.js';
import { element, press, Scenario, Specimen, until } from './kit.js';
import type { StubOptions } from './stubs.js';
import { Stubbed } from './views.js';

const noop = () => {};

/** A running background session with two sub-agents running, so the tab shows whatever its list does. */
const JOB = background('view-subagents-job', { state: 'working', title: 'Export retries', subagentsRunning: 2 });
const NONE: ConversationEntry[] = [];

/** Opens the Sub-agents tab once it shows, and waits for its panel. */
async function openTab(root: HTMLElement): Promise<HTMLElement> {
  const tab = await until('the Sub-agents tab', () => [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find((candidate) => candidate.textContent?.startsWith('Sub-agents')));
  tab.click();
  return element(root, '.session-view-subagents:not([hidden])');
}

/** Opens the tab and waits for its rows. */
async function openList(root: HTMLElement): Promise<HTMLElement> {
  const panel = await openTab(root);
  await element(panel, '.subagent-open');
  return panel;
}

/** Opens the tab, then the row for `description`, and waits for its transcript's entries. */
const openRow = (description: string) => async (root: HTMLElement) => {
  const panel = await openList(root);
  const button = await until(`the ${description} row`, () => [...panel.querySelectorAll<HTMLElement>('.subagent-open')].find((candidate) => candidate.textContent === description));
  button.click();
  await element(panel, '.subagent-transcript ol.conversation');
};

interface StateCase {
  title: string;
  note: string;
  options: StubOptions;
  frame?: 'view' | 'short';
  waited?: 'shown' | 'long';
  width?: number;
  /** 600 px and narrower: Back to sessions in the view's header, as the Dashboard has it there. */
  compact?: boolean;
  run: (root: HTMLElement) => Promise<unknown>;
}

const STATES: StateCase[] = [
  {
    title: 'Many: 72 sub-agents',
    note: 'The most one of Phil’s sessions started in a week: one flat list, running ones first, then the newest started first, every eighth started by another. The list scrolls; its rows are one Tab stop.',
    options: { subagents: 'many', entries: NONE },
    run: openList,
  },
  {
    title: 'Cut short',
    note: 'The server sends at most 200 (SUBAGENTS_MAX), the newest; here twelve stand in for them. A neutral note at the end says the oldest are left out, and the tab’s count ends in +.',
    options: { subagents: 'truncated', entries: NONE },
    frame: 'short',
    run: async (root) => {
      const panel = await openList(root);
      const body = await element(panel, '.subagents-body');
      await element(panel, '.subagents-truncated');
      body.scrollTop = body.scrollHeight;
    },
  },
  {
    title: 'None',
    note: 'A tab shown for a session the snapshot counted running ones for, whose list came back empty. The tab shows only once there is at least one, so this is rare.',
    options: { subagents: 'empty', entries: NONE },
    frame: 'short',
    run: async (root) => element(await openTab(root), '.empty-state'),
  },
  {
    title: 'Loading',
    note: 'A status line after half a second, as the conversation’s is. The tab has no count until the list arrives.',
    options: { subagents: 'loading', entries: NONE },
    frame: 'short',
    waited: 'shown',
    run: openTab,
  },
  {
    title: 'Loading, after 10 seconds',
    note: 'The long-wait line joins it.',
    options: { subagents: 'loading', entries: NONE },
    frame: 'short',
    waited: 'long',
    // Only the tab: the tests' page has no stylesheet, so its delays are the doc's, and the line would take 10 s there.
    run: openTab,
  },
  {
    title: 'Couldn’t load them',
    note: 'A danger alert, since nothing is shown, with Try again. The HTTP status follows pitwall’s sentence.',
    options: { subagents: 'failed', entries: NONE },
    frame: 'short',
    run: async (root) => element(await openTab(root), '.subagents-alert'),
  },
  {
    title: 'Couldn’t load them, trying again',
    note: 'Try again is busy while its request is out, and the alert stays until the list arrives.',
    options: { subagents: 'failed-retrying', entries: NONE },
    frame: 'short',
    run: async (root) => {
      const panel = await openTab(root);
      await press(panel, 'Try again');
      await element(panel, '.subagents-alert [aria-busy="true"]');
    },
  },
  {
    title: 'Couldn’t refresh them',
    note: 'The list the view asked for as it opened is kept, with a warning that it may be out of date, after opening the tab asked again and failed.',
    options: { subagents: 'refresh-failed', entries: NONE },
    frame: 'short',
    run: async (root) => {
      // The list the view asked for as it opened, first: then opening the tab asks again.
      await until('the first list', () => [...root.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent === 'Sub-agents (6)'));
      return element(await openTab(root), '.subagents-alert.warning');
    },
  },
  {
    title: '600 px and narrower',
    note: 'Full width, as the view is: the three tabs fit on one line, and each row’s description gives way before its badge and time.',
    options: { subagents: 'ok', entries: NONE },
    frame: 'short',
    width: 375,
    compact: true,
    run: openList,
  },
];

export function SubagentViews() {
  return (
    <>
      <Specimen
        title="The list: each state, and nested ones"
        note="Running ones first, then the newest started first. Each row: its description, the button that opens its transcript; its state badge (Running with its dot, Done, Failed, Stopped, or none when unknown) and when it was last active, in the row’s fixed time slot; its type, tool calls and when it started; and, for one another started, Started by its description. ↓, ↑, Home and End move between rows."
        frame="view"
      >
        <Stubbed options={{ subagents: 'ok', entries: SUBAGENT_CONVERSATION }}>
          <Scenario run={openList}>
            <SessionView session={VIEW_SUBAGENTS} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="A sub-agent’s transcript"
        note="Opened from its row: Back to sub-agents, its state and last activity, its description as the heading, which takes focus, then its type, tool calls, start and what started it; then its conversation, read-only, with Load earlier and Jump to latest, and no message box. Its own call to another sub-agent links to that one."
        frame="view"
      >
        <Stubbed options={{ subagents: 'ok', entries: SUBAGENT_CONVERSATION }}>
          <Scenario run={openRow(REVIEW.description)}>
            <SessionView session={VIEW_SUBAGENTS} listed onClose={noop} />
          </Scenario>
        </Stubbed>
      </Specimen>
      <Specimen
        title="The conversation names them"
        note="The call that started one reads Agent: and its description, its report From sub-agent: and its description, and a message to one SendMessage to and its description, folded with the calls around it. Each description is a link that opens its transcript in the Sub-agents tab."
        frame="view"
      >
        <Stubbed options={{ subagents: 'ok', entries: SUBAGENT_CONVERSATION }}>
          <SessionView session={VIEW_SUBAGENTS} listed onClose={noop} />
        </Stubbed>
      </Specimen>
      {STATES.map((state) => (
        <Specimen
          key={state.title}
          title={state.title}
          note={state.note}
          frame={state.frame ?? 'view'}
          {...(state.waited ? { waited: state.waited } : {})}
          {...(state.width ? { width: state.width } : {})}
        >
          <Stubbed options={state.options}>
            <Scenario run={state.run}>
              <SessionView session={JOB} listed onClose={noop} compact={state.compact ?? false} />
            </Scenario>
          </Stubbed>
        </Specimen>
      ))}
    </>
  );
}
