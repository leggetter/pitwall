// The New session dialog and whole-page states (W19, W21): the real NewSessionDialog, Dashboard and
// Notice, with fixture connection views instead of a live connection. Each page has storage and an
// address bar of its own, in memory, so its selection never reaches the gallery's URL.

import { useState } from 'react';
import type { ConnectionState, ConnectionView } from '../connection.js';
import { Badge, StatusBadge } from '../components/Badge.js';
import { ConnectionBadge } from '../components/ConnectionBadge.js';
import { FINISHED_ASKED_HINT, STALE_HINT } from '../components/SessionRow.js';
import { Dashboard } from '../components/Dashboard.js';
import { NewSessionDialog } from '../components/NewSessionDialog.js';
import { NoTokenNotice, TokenRejectedNotice } from '../components/Notice.js';
import { shortenHome } from '../format.js';
import { PANEL_WIDTH_KEY } from '../panelWidth.js';
import { memoryNavigation } from '../selection.js';
import { statusBadge } from '../sessions.js';
import { SORT_KEY } from '../sort.js';
import {
  APP_DIR,
  APP_GROUP,
  CALM_SNAPSHOT,
  DIALOG_SNAPSHOT,
  EMPTY_SNAPSHOT,
  HIGHLIGHT_SNAPSHOT,
  JOBS_DIR,
  LIST_SNAPSHOT,
  NOTES_GROUP,
  OTHER_ROOT,
  POLL_FAILED_SNAPSHOT,
  RELAY_ALERT_BLOCKED,
  RELAY_ALERT_OFF,
  RELAY_ALERT_SENT,
  RELAY_OFF,
  REPO_LIST_SNAPSHOT,
  ROOT,
  SERVICE_DIR,
  snapshot,
  STATUS_ROWS,
  TWO_ROOTS_SNAPSHOT,
} from './fixtures.js';
import { choose, element, laidOut, press, Reopenable, Scenario, Specimen, text, type, until } from './kit.js';
import { memoryStorage, type StubOptions } from './stubs.js';
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
  /** The query string it starts with, such as ?repo=…: a selection of its own, never the gallery's address. */
  search?: string;
  /** A window this many px wide, for one layout whatever the gallery's width. Otherwise the gallery's. */
  width?: number;
  view: ConnectionView;
  /** What its own storage starts with, such as a Sort setting. */
  stored?: Record<string, string>;
  run?: (root: HTMLElement) => Promise<unknown>;
}

const repo = (key: string, root?: string) => `?repo=${key}${root ? `&root=${root}` : ''}`;

const PAGES: PageCase[] = [
  { short: true, title: 'Connecting', note: 'Loading: before the first snapshot.', view: { state: 'connecting' } },
  { short: true, title: 'Reconnecting, before the first list', view: { state: 'reconnecting' } },
  {
    title: 'All sessions',
    note: 'The first time. Click a row to open its session view, in the third column from 1,200 px or over the list below that.',
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  { title: 'A group', search: repo(APP_DIR), view: { state: 'live', snapshot: LIST_SNAPSHOT } },
  { title: 'Needs you', search: '?view=needs-you', view: { state: 'live', snapshot: LIST_SNAPSHOT } },
  { title: 'Two roots', note: 'A group under the second root.', search: repo(SERVICE_DIR, OTHER_ROOT), view: { state: 'live', snapshot: TWO_ROOTS_SNAPSHOT } },
  { title: 'Connection lost', view: { state: 'reconnecting', snapshot: LIST_SNAPSHOT } },
  { title: 'Poll failed', view: { state: 'live', snapshot: POLL_FAILED_SNAPSHOT } },
  { title: "Relay sent a message nobody asked for", view: { state: 'live', snapshot: snapshot([NOTES_GROUP], { relayAlert: RELAY_ALERT_SENT }) } },
  { title: 'Relay blocked one', view: { state: 'live', snapshot: snapshot([NOTES_GROUP], { relayAlert: RELAY_ALERT_BLOCKED }) } },
  {
    title: 'The relay off until restart',
    note: 'The snapshot’s relayOff: the app strip above the header, and the relay alert says messaging is off.',
    view: { state: 'live', snapshot: snapshot([NOTES_GROUP], { relayAlert: RELAY_ALERT_OFF, relayOff: RELAY_OFF }) },
  },
  {
    title: 'The relay off, its alert dismissed',
    note: 'The strip stays. Details brings the alert back and takes focus to it.',
    view: { state: 'live', snapshot: snapshot([NOTES_GROUP], { relayAlert: RELAY_ALERT_OFF, relayOff: RELAY_OFF }) },
    run: async (root) => {
      await press(root, 'Dismiss');
      await until('the alert to go', () => !root.querySelector('.relay-alert'));
    },
  },
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
    title: 'The filter matches nothing in a group',
    note: 'Search all sessions keeps the text and selects All sessions.',
    short: true,
    search: repo(APP_DIR),
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
    run: async (root) => {
      type(await element<HTMLInputElement>(root, 'input[type="search"]'), 'pitwall-test-notes');
      await text(root, 'Search all sessions');
    },
  },
  {
    title: 'Nothing needs you',
    short: true,
    search: '?view=needs-you',
    view: { state: 'live', snapshot: CALM_SNAPSHOT },
  },
  {
    title: 'A group that has left the snapshot',
    note: 'It stays selected, and the repo list has no item for it.',
    short: true,
    search: repo(`${ROOT}/pitwall-test-gone`),
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  {
    title: 'Filtered, with the matches highlighted',
    note: 'In names, titles and paths. A group whose label matches shows all its sessions.',
    view: { state: 'live', snapshot: HIGHLIGHT_SNAPSHOT },
    run: async (root) => {
      type(await element<HTMLInputElement>(root, 'input[type="search"]'), 'export');
      await element(root, 'mark.match');
    },
  },
  {
    title: 'A chip on',
    note: 'Background: background sessions only. Finished ones stay in the Finished section.',
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
    run: async (root) => {
      await press(root, 'Background');
      await until('the chip to be on', () => root.querySelector('.chip[aria-pressed="true"]'));
    },
  },
  {
    title: 'Sorted by Recent',
    note: 'Most recently active first. A new order waits while the pointer is over the list or focus is inside it.',
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
    stored: { [SORT_KEY]: 'recent' },
  },
  {
    title: 'Sorted by Name',
    note: 'Alphanumerically, so it never moves as sessions change. The Finished section follows it too.',
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
    stored: { [SORT_KEY]: 'name' },
  },
  {
    title: 'Token rejected',
    note: "The badge alone: the app shows the token notice, below, instead of the list.",
    view: { state: 'unauthorized', snapshot: CALM_SNAPSHOT },
  },
];

/** One page: the Dashboard with storage and an address bar of its own, so it never touches the gallery's. */
function Page({ page }: { page: PageCase }) {
  const [own] = useState(() => ({ storage: memoryStorage(page.stored), navigation: memoryNavigation(page.search ?? '') }));
  const dashboard = <Dashboard view={page.view} storage={own.storage} navigation={own.navigation} />;
  return <Stubbed>{page.run ? <Scenario run={page.run}>{dashboard}</Scenario> : dashboard}</Stubbed>;
}

export function Pages() {
  return (
    <>
      {PAGES.map((page) => (
        <Specimen key={page.title} title={page.title} note={page.note} frame={page.short ? 'page-short' : 'page'}>
          <Page page={page} />
        </Specimen>
      ))}
    </>
  );
}

/** A session in LIST_SNAPSHOT, opened from the URL as a reload or a link would. */
const OPEN = `?view=all&session=${APP_GROUP.sessions[0]?.sessionId ?? ''}`;

const LAYOUTS: PageCase[] = [
  {
    title: 'Three columns, from 1,200 px',
    note: 'With nothing open, the third column says so, and stays.',
    width: 1280,
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  {
    title: 'Three columns, a session open',
    width: 1280,
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
    run: async (root) => {
      (await element<HTMLButtonElement>(root, '[data-open-session]')).click();
      await element(root, laidOut(root) ? '.session-view.in-column' : '.session-view');
    },
  },
  {
    title: 'Three columns, opened from the URL',
    note: 'A ?session= opens the view on load, without attaching, sending or changing anything.',
    width: 1280,
    search: OPEN,
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  {
    title: 'The divider at its minimum',
    note: 'Dragged, or Home on the divider: 560 px, about 80 terminal columns.',
    width: 1280,
    search: OPEN,
    stored: { [PANEL_WIDTH_KEY]: '560' },
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  {
    title: 'The divider at its maximum',
    note: 'Dragged, or End on the divider: what the repo list and the session list’s 360 px leave, here 680 px.',
    width: 1280,
    search: OPEN,
    stored: { [PANEL_WIDTH_KEY]: '4000' },
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  {
    title: 'A session the URL names that isn’t listed',
    width: 1280,
    search: '?view=all&session=00000000-0000-4000-8000-00000000dead',
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  { title: 'Two columns, from 900 px', note: 'An open session overlays the session list.', width: 1000, view: { state: 'live', snapshot: LIST_SNAPSHOT } },
  {
    title: 'The relay off, a session open over the list',
    note: 'The session view starts below the app strip, so the strip shows in every layout.',
    width: 1000,
    search: OPEN,
    view: { state: 'live', snapshot: { ...LIST_SNAPSHOT, relayAlert: RELAY_ALERT_OFF, relayOff: RELAY_OFF } },
  },
  {
    title: 'Two columns, a session open',
    note: 'Over the session list, which stays usable: non-modal, with no backdrop.',
    width: 1000,
    search: OPEN,
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  { title: 'One column, below 900 px', note: 'The repo list is a drawer, opened with Repos.', width: 375, view: { state: 'live', snapshot: LIST_SNAPSHOT } },
  {
    title: 'One column, a session open',
    note: 'At 600 px and narrower the view is full width, with Back to sessions in place of Close.',
    width: 375,
    search: OPEN,
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  {
    title: 'The drawer open',
    width: 375,
    search: repo(APP_DIR),
    view: { state: 'live', snapshot: REPO_LIST_SNAPSHOT },
    run: async (root) => {
      if (!laidOut(root)) return;
      (await element<HTMLButtonElement>(root, 'button[aria-label="Repos"]')).click();
      await element(root, '.repo-drawer');
    },
  },
];

export function Layouts() {
  return (
    <>
      {LAYOUTS.map((page) => (
        <Specimen key={page.title} title={page.title} note={page.note} frame="page" width={page.width}>
          <Page page={page} />
        </Specimen>
      ))}
    </>
  );
}

const STATES: ConnectionState[] = ['connecting', 'live', 'reconnecting', 'unauthorized'];

export function Notices() {
  return (
    <>
      <Specimen title="Status badges" note="Each session status, as statusBadge() gives it. Solid is for needing you only. The list leaves Idle out; the session view shows it.">
        <p className="uikit-row">
          {STATUS_ROWS.map((row) => (
            <StatusBadge key={row.sessionId} badge={statusBadge(row)} />
          ))}
        </p>
      </Specimen>
      <Specimen title="Other badges" note="Stale and a finished session's Asked you carry their explanations in the hover text.">
        <p className="uikit-row">
          <Badge look="subtle-neutral" title={STALE_HINT}>
            Stale
          </Badge>
          <Badge look="outline" title={FINISHED_ASKED_HINT}>
            Asked you
          </Badge>
          <Badge look="subtle-neutral">4</Badge>
          <span className="badge badge-attention">2 need you</span>
        </p>
      </Specimen>
      <Specimen title="Connection badges" note="The header's badge, in each connection state: a spinner while connecting, a dot once live.">
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
