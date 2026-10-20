// The New session dialog and whole-page states (W19): the real NewSessionDialog, Dashboard and
// Notice, with fixture connection views instead of a live connection.

import type { ConnectionState, ConnectionView } from '../connection.js';
import { ConnectionBadge } from '../components/ConnectionBadge.js';
import { Dashboard } from '../components/Dashboard.js';
import { NewSessionDialog } from '../components/NewSessionDialog.js';
import { NoTokenNotice, TokenRejectedNotice } from '../components/Notice.js';
import { shortenHome } from '../format.js';
import { GROUP_STATE_KEY } from '../groupState.js';
import {
  CALM_SNAPSHOT,
  DIALOG_SNAPSHOT,
  EMPTY_SNAPSHOT,
  HIGHLIGHT_SNAPSHOT,
  JOBS_DIR,
  LIST_SNAPSHOT,
  NOTES_GROUP,
  POLL_FAILED_SNAPSHOT,
  RELAY_ALERT_BLOCKED,
  RELAY_ALERT_SENT,
  ROOT,
  snapshot,
  TWO_ROOTS_SNAPSHOT,
} from './fixtures.js';
import { choose, element, press, Reopenable, Scenario, Specimen, text, type, until } from './kit.js';
import { memoryStorage, openGroups, type StubOptions } from './stubs.js';
import { Stubbed } from './views.js';

const PROMPT = 'Add a retry with backoff to the export job. Keep the existing 30 second timeout.';

/** The field whose label starts with `label`. */
function field<T extends HTMLElement>(root: HTMLElement, label: string): Promise<T> {
  return until(`the ${label} field`, () => {
    const found = [...root.querySelectorAll('label')].find((candidate) => candidate.textContent?.startsWith(label));
    return found ? (root.querySelector<T>(`[id="${CSS.escape(found.htmlFor)}"]`) ?? undefined) : undefined;
  });
}

async function fill(root: HTMLElement, values: { directory?: string; path?: string; name?: string; model?: string; alias?: string; prompt?: string }) {
  if (values.directory) choose(await field<HTMLSelectElement>(root, 'Directory'), values.directory);
  if (values.path !== undefined) type(await element<HTMLInputElement>(root, 'input[aria-label="Directory path"]'), values.path);
  if (values.name !== undefined) type(await field<HTMLInputElement>(root, 'Name'), values.name);
  if (values.model) choose(await field<HTMLSelectElement>(root, 'Model'), values.model);
  if (values.alias !== undefined) type(await element<HTMLInputElement>(root, 'input[aria-label="Model alias"]'), values.alias);
  if (values.prompt !== undefined) type(await field<HTMLTextAreaElement>(root, 'First prompt'), values.prompt);
}

const OTHER_DIRECTORY = 'Another directory under a root…';

interface DialogCase {
  title: string;
  note?: string;
  options?: StubOptions;
  run?: (root: HTMLElement) => Promise<unknown>;
}

const DIALOG_CASES: DialogCase[] = [
  { title: 'Empty', note: 'As it opens. Cancel or Escape closes it here too.' },
  {
    title: 'Filled',
    run: (root) => fill(root, { directory: shortenHome(JOBS_DIR), name: 'pitwall-test-new', model: 'opus', prompt: PROMPT }),
  },
  {
    title: 'A typed directory and model',
    note: 'The two choices that reveal a field.',
    run: (root) => fill(root, { directory: OTHER_DIRECTORY, path: `${ROOT}/pitwall-test-new-dir`, model: 'Other…', alias: 'sonnet', prompt: PROMPT }),
  },
  {
    title: 'Submitted empty',
    run: async (root) => {
      await press(root, 'Start session');
      await element(root, '.field-problem');
    },
  },
  {
    title: 'Every field wrong',
    run: async (root) => {
      await fill(root, { directory: OTHER_DIRECTORY, path: 'pitwall-test-relative', name: '-pitwall test ', model: 'Other…', alias: 'not a model!' });
      await press(root, 'Start session');
      await until('four problems', () => root.querySelectorAll('.field-problem').length === 4);
    },
  },
  {
    title: 'Trust failure',
    note: "Claude Code hasn't trusted the directory, so the server sends the command that does.",
    options: { spawn: 'trust' },
    run: async (root) => {
      await fill(root, { prompt: PROMPT });
      await press(root, 'Start session');
      await element(root, '.spawn-failure');
    },
  },
  {
    title: "Couldn't start",
    options: { spawn: 'failed' },
    run: async (root) => {
      await fill(root, { prompt: PROMPT });
      await press(root, 'Start session');
      await element(root, '.spawn-failure');
    },
  },
  {
    title: 'Starting',
    options: { spawn: 'starting' },
    run: async (root) => {
      await fill(root, { prompt: PROMPT });
      await press(root, 'Start session');
      await text(root, 'Starting…');
    },
  },
];

export function Dialogs() {
  return (
    <>
      {DIALOG_CASES.map((dialog) => (
        <Specimen key={dialog.title} title={dialog.title} note={dialog.note} frame="dialog">
          <Stubbed options={dialog.options}>
            <Reopenable>
              {(close) => {
                const shown = <NewSessionDialog snapshot={DIALOG_SNAPSHOT} onClose={close} onStarted={close} />;
                return dialog.run ? <Scenario run={dialog.run}>{shown}</Scenario> : shown;
              }}
            </Reopenable>
          </Stubbed>
        </Specimen>
      ))}
    </>
  );
}

interface PageCase {
  title: string;
  note?: string;
  /** A page with no list, shown in a shorter window. */
  short?: boolean;
  view: ConnectionView;
  run?: (root: HTMLElement) => Promise<unknown>;
}

const PAGES: PageCase[] = [
  { short: true, title: 'Connecting', note: 'Loading: before the first snapshot.', view: { state: 'connecting' } },
  { short: true, title: 'Reconnecting, before the first list', view: { state: 'reconnecting' } },
  { title: 'Live', note: 'Groups open, the filter, and the summary. Click a row to open its session view.', view: { state: 'live', snapshot: LIST_SNAPSHOT } },
  { title: 'Two roots', view: { state: 'live', snapshot: TWO_ROOTS_SNAPSHOT } },
  { title: 'Connection lost', view: { state: 'reconnecting', snapshot: LIST_SNAPSHOT } },
  { title: 'Poll failed', view: { state: 'live', snapshot: POLL_FAILED_SNAPSHOT } },
  { title: "Relay sent a message nobody asked for", view: { state: 'live', snapshot: snapshot([NOTES_GROUP], { relayAlert: RELAY_ALERT_SENT }) } },
  { title: 'Relay blocked one', view: { state: 'live', snapshot: snapshot([NOTES_GROUP], { relayAlert: RELAY_ALERT_BLOCKED }) } },
  {
    title: 'Server error',
    view: { state: 'live', snapshot: snapshot([NOTES_GROUP]), serverError: "The index couldn't read one transcript: a made-up error for pitwall-test." },
  },
  {
    title: 'Session started',
    note: 'After Start session in the dialog, until the new session shows up in the list.',
    view: { state: 'live', snapshot: CALM_SNAPSHOT },
    run: async (root) => {
      await press(root, 'New session');
      type(await element<HTMLTextAreaElement>(root, '.modal textarea'), PROMPT);
      await press(root, 'Start session');
      await text(root, 'Started pitwall-test-started');
    },
  },
  { short: true, title: 'No sessions', view: { state: 'live', snapshot: EMPTY_SNAPSHOT } },
  {
    title: 'The filter matches nothing',
    short: true,
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
    run: async (root) => {
      type(await element<HTMLInputElement>(root, 'input[type="search"]'), 'pitwall-test-matches-nothing');
      await text(root, 'No sessions match');
    },
  },
  {
    title: 'Nothing needs you',
    note: '"Needs attention only" on, with nothing that does.',
    short: true,
    view: { state: 'live', snapshot: CALM_SNAPSHOT },
    run: async (root) => {
      (await element<HTMLInputElement>(root, 'input[type="checkbox"]')).click();
      await text(root, 'Nothing needs you right now');
    },
  },
  {
    title: 'Filtered, with the matches highlighted',
    note: 'In names, titles, group labels and paths. A group whose label matches shows all its sessions.',
    view: { state: 'live', snapshot: HIGHLIGHT_SNAPSHOT },
    run: async (root) => {
      type(await element<HTMLInputElement>(root, 'input[type="search"]'), 'export');
      await element(root, 'mark.match');
    },
  },
  {
    title: 'A chip on',
    note: 'Background: background sessions only. Finished ones stay in their Finished list.',
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
    run: async (root) => {
      await press(root, 'Background');
      await until('background rows only', () => root.querySelector('.session') !== null && ![...root.querySelectorAll('.session .kind')].some((kind) => kind.textContent === 'interactive'));
    },
  },
  {
    title: 'Token rejected',
    note: "The badge alone: the app shows the token notice, below, instead of the list.",
    view: { state: 'unauthorized', snapshot: CALM_SNAPSHOT },
  },
];

/** Each page with its groups open, in storage of its own. */
const PAGE_CASES = PAGES.map((page) => ({ ...page, storage: memoryStorage({ [GROUP_STATE_KEY]: openGroups(page.view.snapshot?.groups ?? []) }) }));

export function Pages() {
  return (
    <>
      {PAGE_CASES.map((page) => {
        const dashboard = <Dashboard view={page.view} storage={page.storage} />;
        return (
          <Specimen key={page.title} title={page.title} note={page.note} frame={page.short ? 'page-short' : 'page'}>
            <Stubbed>{page.run ? <Scenario run={page.run}>{dashboard}</Scenario> : dashboard}</Stubbed>
          </Specimen>
        );
      })}
    </>
  );
}

const STATES: ConnectionState[] = ['connecting', 'live', 'reconnecting', 'unauthorized'];

export function Notices() {
  return (
    <>
      <Specimen title="Connection badges" note="The header's badge, in each connection state.">
        <p className="uikit-row">
          {STATES.map((state) => (
            <ConnectionBadge key={state} state={state} />
          ))}
        </p>
      </Specimen>
      <Specimen title="No token" frame="page">
        <NoTokenNotice />
      </Specimen>
      <Specimen title="Token rejected" frame="page">
        <TokenRejectedNotice />
      </Specimen>
    </>
  );
}
