// The New session dialog and whole-page states (W19, W21): the real NewSessionDialog, Dashboard and
// Notice, with fixture connection views instead of a live connection. Each page has storage and an
// address bar of its own, in memory, so its selection never reaches the gallery's URL.

import { useState, type ReactNode } from 'react';
import type { BackgroundTab } from '../backgroundTab.js';
import type { ConnectionState, ConnectionView } from '../connection.js';
import { Badge, StatusBadge } from '../components/Badge.js';
import { ConnectionBadge } from '../components/ConnectionBadge.js';
import { FINISHED_ASKED_HINT, STALE_HINT } from '../components/SessionRow.js';
import { Dashboard } from '../components/Dashboard.js';
import { NewSessionDialog } from '../components/NewSessionDialog.js';
import { PreferencesDialog, RepoListPreferences, SessionViewPreferences, type PreferencesProps } from '../components/Preferences.js';
import { ShortcutsDialog } from '../components/ShortcutsDialog.js';
import { NoTokenNotice, TokenRejectedNotice } from '../components/Notice.js';
import { shortenHome } from '../format.js';
import type { GroupBy } from '../groupBy.js';
import { PANEL_WIDTH_KEY } from '../panelWidth.js';
import { memoryNavigation } from '../selection.js';
import { statusBadge } from '../sessions.js';
import { ShortcutsStoreContext } from '../shortcuts.js';
import { SORT_KEY } from '../sort.js';
import type { TerminalFocus } from '../terminalFocus.js';
import {
  APP_DIR,
  APP_GROUP,
  CALM_SNAPSHOT,
  DIALOG_SNAPSHOT,
  EMPTY_SNAPSHOT,
  GONE_HIDDEN,
  HIGHLIGHT_SNAPSHOT,
  JOBS_DIR,
  JOBS_GROUP,
  LIST_SNAPSHOT,
  NOTES_DIR,
  NOTES_GROUP,
  OTHER_ROOT,
  POLL_FAILED_SNAPSHOT,
  RELAY_ALERT_BLOCKED,
  RELAY_ALERT_CHANGED,
  RELAY_ALERT_CHANGED_BLOCKED,
  RELAY_ALERT_OFF,
  RELAY_ALERT_REPEATED_BLOCKED,
  RELAY_ALERT_REPEATED_SENT,
  RELAY_ALERT_SENT,
  RELAY_OFF,
  REPO_LIST_SNAPSHOT,
  ROOT,
  SERVICE_DIR,
  SERVICE_GROUP,
  snapshot,
  STATUS_ROWS,
  THIRD_ROOT,
  THREE_ROOTS_SNAPSHOT,
  TWO_ROOTS_SNAPSHOT,
  API_DIR,
  WORKED_FROM_ROOT,
  WORKED_SNAPSHOT,
} from './fixtures.js';
import { choose, element, laidOut, press, Reopenable, Scenario, Specimen, text, type, until } from './kit.js';
import { memoryShortcuts, memoryStorage, storedHidden, storedStarred, type StubOptions } from './stubs.js';
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
  {
    title: 'Empty',
    note: 'As it opens, with focus on Directory. Tab stays inside; Cancel, Close or Escape closes it here too, and so does a click on the backdrop while nothing has been typed. ⌘ ↵ starts the session from any field.',
  },
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
    note: 'Problems show after the first submit, then follow the typing; focus goes to the first field with one.',
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
    note: 'Start session is busy; every other control, Close included, is aria-disabled, and Escape and the backdrop do nothing.',
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

const SHORTCUT_CASES = [
  { title: 'Shortcuts on', note: 'As it opens, from ? or the header\'s keyboard button, with focus on the off switch. ⌘ on Apple platforms; Escape or Close closes it here too.', on: true, command: true },
  { title: 'Shortcuts off', note: 'Anywhere says the single-key shortcuts are off; the rest of the map still works.', on: false, command: true },
  { title: 'On other platforms', note: 'Ctrl in place of ⌘.', on: true, command: false },
];

/** A store of its own for each, so ticking one specimen's checkbox changes only that one. */
function ShortcutsCase({ on, command }: { on: boolean; command: boolean }) {
  const [store] = useState(() => memoryShortcuts(on));
  return (
    <ShortcutsStoreContext.Provider value={store}>
      <Reopenable>{(close) => <ShortcutsDialog onClose={close} command={command} />}</Reopenable>
    </ShortcutsStoreContext.Provider>
  );
}

export function ShortcutsDialogs() {
  return (
    <>
      {SHORTCUT_CASES.map((shortcuts) => (
        <Specimen key={shortcuts.title} title={shortcuts.title} note={shortcuts.note} frame="dialog-tall">
          <ShortcutsCase on={shortcuts.on} command={shortcuts.command} />
        </Specimen>
      ))}
    </>
  );
}

/** The settings the Dashboard keeps for the Preferences dialog, with state of their own, starting at `start`. */
function usePreferenceState(start: Partial<Pick<PreferencesProps, 'groupBy' | 'backgroundTab' | 'terminalFocus'>> = {}): PreferencesProps {
  const [groupBy, onGroupBy] = useState<GroupBy>(start.groupBy ?? 'main-repo');
  const [backgroundTab, onBackgroundTab] = useState<BackgroundTab>(start.backgroundTab ?? 'terminal');
  const [terminalFocus, onTerminalFocus] = useState<TerminalFocus>(start.terminalFocus ?? 'after-open');
  return { groupBy, onGroupBy, backgroundTab, onBackgroundTab, terminalFocus, onTerminalFocus };
}

interface PreferencesCase {
  title: string;
  note: string;
  start?: Parameters<typeof usePreferenceState>[0];
}

function PreferencesCaseDialog({ start }: Pick<PreferencesCase, 'start'>) {
  const settings = usePreferenceState(start);
  return <Reopenable>{(close) => <PreferencesDialog onClose={close} {...settings} />}</Reopenable>;
}

const PREFERENCES_CASES: PreferencesCase[] = [
  {
    title: 'As it opens',
    note: "From the header's Preferences button, with every setting at its default, and focus on Main repo, the first group's choice. The medium dialog, 624 px, so each option's line fits on one line, but for When you open it's two sentences (W62). Tab goes from one group's choice to the next, the arrows choose within a group, and each choice applies at once. Escape or Close closes it, here too.",
  },
  {
    title: 'Other choices',
    note: 'Every repo it worked in, Conversation and Never. The single-key shortcuts and the theme aren’t here: the keyboard shortcuts dialog and the header’s theme switch have them (W62).',
    start: { groupBy: 'every-repo', backgroundTab: 'conversation', terminalFocus: 'never' },
  },
];

/** A section on its own, as wide as the dialog, with its body's padding. */
function SectionStage({ children }: { children: ReactNode }) {
  return <div className="uikit-preferences-section">{children}</div>;
}

/** Repo list on its own, with a setting of its own. */
function RepoListSection() {
  const settings = usePreferenceState();
  return (
    <SectionStage>
      <RepoListPreferences {...settings} />
    </SectionStage>
  );
}

/** Session view on its own, with settings of its own. */
function SessionViewSection() {
  const settings = usePreferenceState();
  return (
    <SectionStage>
      <SessionViewPreferences {...settings} />
    </SectionStage>
  );
}

export function PreferencesDialogs() {
  return (
    <>
      {PREFERENCES_CASES.map((preferences) => (
        <Specimen key={preferences.title} title={preferences.title} note={preferences.note} frame="dialog">
          <PreferencesCaseDialog start={preferences.start} />
        </Specimen>
      ))}
      <Specimen
        title="A short window"
        note="At 375 × 540: the card is the window less 32 px wide and 96 px tall, its header stays, and its body scrolls. Tab and the arrows bring each choice into view."
        frame="dialog-short"
        width={375}
      >
        <PreferencesCaseDialog />
      </Specimen>
      <Specimen title="Repo list" note="Group sessions by (W42): which group in the repo list each session is listed under, and so the groups' counts and the root tabs' badges.">
        <RepoListSection />
      </Specimen>
      <Specimen
        title="Session view"
        note="Open running background sessions on (W54), for the views that open after the choice, never the one that's open; then The terminal takes the keyboard (W57), whose labels read on from it, for each attach after the choice."
      >
        <SessionViewSection />
      </Specimen>
    </>
  );
}

interface PageCase {
  title: string;
  note?: string;
  /** The query string it starts with, such as ?repo=…: a selection of its own, never the gallery's address. */
  search?: string;
  /** A window this many px wide, for one layout whatever the gallery's width. Otherwise the gallery's. */
  width?: number;
  view: ConnectionView;
  /** What its own storage starts with, such as a Sort setting. */
  stored?: Record<string, string>;
  /** Its toasts stay (kit.tsx). */
  lasting?: boolean;
  /** Its waiting state shows at once, without or with the long-wait line (kit.tsx). */
  waited?: 'shown' | 'long';
  run?: (root: HTMLElement) => Promise<unknown>;
}

const repo = (key: string, root?: string) => `?repo=${key}${root ? `&root=${root}` : ''}`;

/** Three starred sessions in LIST_SNAPSHOT: one that needs you, a calm one, and a finished one (W53). */
const STARRED_IDS = [APP_GROUP.sessions[0], NOTES_GROUP.sessions[0], JOBS_GROUP.sessions.at(-1)].flatMap((listed) => (listed ? [listed.sessionId] : []));

const PAGES: PageCase[] = [
  {
    title: 'Connecting',
    note: 'Before the first snapshot, after half a second: four skeleton items in the repo list and three skeleton rows, aria-hidden, with a hidden "Loading sessions" status. They pulse, except under reduced motion.',
    view: { state: 'connecting' },
    waited: 'shown',
  },
  {
    title: 'Connecting, after 10 seconds',
    note: 'The long-wait line joins the status: the first snapshot waits for the index’s first poll.',
    view: { state: 'connecting' },
    waited: 'long',
  },
  {
    title: 'Reconnecting, before the first list, after 10 seconds',
    note: 'The connection dropped before the first snapshot, so what’s slow is reaching pitwall.',
    view: { state: 'reconnecting' },
    waited: 'long',
  },
  {
    title: 'All sessions',
    note: 'The first time. Click a row to open its session view, in the third column from 1,200 px or over the list below that.',
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  { title: 'A group', search: repo(APP_DIR), view: { state: 'live', snapshot: LIST_SNAPSHOT } },
  { title: 'Needs you', search: '?view=needs-you', view: { state: 'live', snapshot: LIST_SNAPSHOT } },
  {
    title: 'Starred',
    note: 'The starred sessions under the root, each with its group on line 2, sorted by the Sort setting, a finished one in its own Finished section (W53). Press a star to unstar: the row leaves at once. Stars on the other rows show on hover and focus.',
    search: '?view=starred',
    stored: storedStarred(STARRED_IDS),
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  {
    title: 'Starred, with nothing starred',
    note: 'The empty state says how to star; Show all sessions selects All sessions, with focus on the heading. Starred stays in the repo list, so the list never jumps as the first star comes.',
    search: '?view=starred',
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  {
    title: 'Starred in a root’s tab',
    note: 'Two roots, a session starred under each: ~/work’s tab lists and counts its own alone. The stars are every root’s, in one key.',
    search: `?view=starred&root=${OTHER_ROOT}`,
    stored: storedStarred([APP_GROUP.sessions[0]?.sessionId ?? '', SERVICE_GROUP.sessions[0]?.sessionId ?? '']),
    view: { state: 'live', snapshot: TWO_ROOTS_SNAPSHOT },
  },
  {
    title: 'Two roots',
    note: 'A tab per root in the header. ~/work is open, with a group under it selected: the repo list, its counts and the session list are ~/work’s alone. ~/code’s tab carries its need-you badge.',
    search: repo(SERVICE_DIR, OTHER_ROOT),
    view: { state: 'live', snapshot: TWO_ROOTS_SNAPSHOT },
  },
  {
    title: 'Three roots, one with no sessions',
    note: '~/personal is open and has no sessions, so it keeps its tab, with the usual empty state, naming its root. Switch tabs to see each keep its own selection and open session.',
    search: `?view=all&root=${THIRD_ROOT}`,
    view: { state: 'live', snapshot: THREE_ROOTS_SNAPSHOT },
  },
  {
    title: 'Each session in one group',
    note: 'pitwall-test-api selected: only the session started in it. Two others worked in it, and are listed where they started, pitwall-test-app and ~/code. pitwall-test-docs, where sessions only worked, has no group.',
    search: repo(API_DIR),
    view: { state: 'live', snapshot: WORKED_SNAPSHOT },
  },
  {
    title: "The root's group",
    note: 'Every session started in the root, one that worked in pitwall-test-api and pitwall-test-docs too. The directory below it, pitwall-test-scratch, keeps its own group.',
    search: repo(ROOT),
    view: { state: 'live', snapshot: WORKED_SNAPSHOT },
  },
  {
    title: 'Filtered by a repo sessions worked in',
    note: 'All sessions, filtered by pitwall-test-docs, which has no group: the three sessions that worked there, each under where it started. Nothing on their rows matches, so nothing is highlighted.',
    view: { state: 'live', snapshot: WORKED_SNAPSHOT },
    run: async (root) => {
      type(await element<HTMLInputElement>(root, 'input[type="search"]'), 'pitwall-test-docs');
      await text(root, '3 of 6 sessions');
    },
  },
  {
    title: 'Hiding a group',
    note: 'Hide from repo list, pressed on pitwall-test-app: it leaves the repo list and stays selected, the Hidden section opens on it, and a toast says where it went. Its sessions, the views and their counts are as they were. The toast stays here.',
    search: repo(APP_DIR),
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
    lasting: true,
    run: async (root) => {
      (await element<HTMLButtonElement>(root, 'button[aria-label="Hide from repo list"]')).click();
      await text(root, 'Hid pitwall-test-app.');
    },
  },
  {
    title: 'A hidden group selected',
    note: 'From its link in the Hidden section, or a URL: its sessions show as usual, and the header offers Show in repo list. pitwall-test-old-clone is in no snapshot, so it shows No sessions.',
    search: repo(NOTES_DIR),
    stored: storedHidden([NOTES_GROUP, GONE_HIDDEN], true),
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  { title: 'Connection lost', view: { state: 'reconnecting', snapshot: LIST_SNAPSHOT } },
  { title: 'Poll failed', view: { state: 'live', snapshot: POLL_FAILED_SNAPSHOT } },
  { title: "Relay sent a message nobody asked for", view: { state: 'live', snapshot: snapshot([NOTES_GROUP], { relayAlert: RELAY_ALERT_SENT }) } },
  { title: 'Relay blocked one', view: { state: 'live', snapshot: snapshot([NOTES_GROUP], { relayAlert: RELAY_ALERT_BLOCKED }) } },
  {
    title: 'Relay may have sent a changed copy',
    note: 'W43: a copy of your message that didn’t match it, which the gate may not have stopped. It points at the session you messaged, never at another session.',
    view: { state: 'live', snapshot: snapshot([NOTES_GROUP], { relayAlert: RELAY_ALERT_CHANGED }) },
  },
  {
    title: 'Relay blocked a changed copy',
    note: 'W52: a blocked copy that differed in more than its text, such as one to another session, which pitwall doesn’t try again. A copy whose text alone differed raises none: pitwall tries that once more, and the message’s own result says so.',
    view: { state: 'live', snapshot: snapshot([NOTES_GROUP], { relayAlert: RELAY_ALERT_CHANGED_BLOCKED }) },
  },
  {
    title: 'Relay may have repeated a send',
    note: 'W52: the relay tried your message again in the same turn, after the gate stopped its copy, and pitwall never saw whether the gate stopped that too. It points at your sessions, and never says another session caused it.',
    view: { state: 'live', snapshot: snapshot([NOTES_GROUP], { relayAlert: RELAY_ALERT_REPEATED_SENT }) },
  },
  {
    title: 'Relay blocked a repeated send',
    note: 'W52: the same, with the repeat blocked too. A warning, since nothing more was sent.',
    view: { state: 'live', snapshot: snapshot([NOTES_GROUP], { relayAlert: RELAY_ALERT_REPEATED_BLOCKED }) },
  },
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
    note: 'After Start session in the dialog: a toast, at the bottom right, and the view opens when the session shows up in the list. The toast stays here.',
    view: { state: 'live', snapshot: CALM_SNAPSHOT },
    lasting: true,
    run: async (root) => {
      await press(root, 'New session');
      type(await element<HTMLTextAreaElement>(root, '.dialog textarea'), PROMPT);
      await press(root, 'Start session');
      await text(root, 'Started pitwall-test-started');
    },
  },
  {
    title: 'No sessions',
    note: 'No sessions under the roots: New session, the region’s one primary action, opens the dialog.',
    view: { state: 'live', snapshot: EMPTY_SNAPSHOT },
  },
  {
    title: 'The filter matches nothing',
    note: 'Clear filters clears the text and the chips, and puts focus in the field.',
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
    run: async (root) => {
      type(await element<HTMLInputElement>(root, 'input[type="search"]'), 'pitwall-test-nowhere');
      await text(root, 'No sessions match');
    },
  },
  {
    title: 'The filter matches nothing in a group',
    note: 'Search all sessions keeps the text and selects All sessions.',
    search: repo(APP_DIR),
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
    run: async (root) => {
      type(await element<HTMLInputElement>(root, 'input[type="search"]'), 'pitwall-test-notes');
      await text(root, 'Search all sessions');
    },
  },
  {
    title: 'Nothing needs you',
    note: 'Show all sessions selects All sessions, with focus on the session list’s heading.',
    search: '?view=needs-you',
    view: { state: 'live', snapshot: CALM_SNAPSHOT },
  },
  {
    title: 'A group that has left the snapshot',
    note: 'It stays selected, and the repo list has no item for it.',
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
        <Specimen
          key={page.title}
          title={page.title}
          note={page.note}
          frame="page"
          lasting={page.lasting ?? false}
          {...(page.waited ? { waited: page.waited } : {})}
        >
          <Page page={page} />
        </Specimen>
      ))}
    </>
  );
}

/** A session in LIST_SNAPSHOT, opened from the URL as a reload or a link would. */
const OPEN = `?view=all&session=${APP_GROUP.sessions[0]?.sessionId ?? ''}`;
/** LIST_SNAPSHOT's running background session, pitwall-test-nightly, opened the same way (W54). */
const OPEN_JOB = `?view=all&session=${JOBS_GROUP.sessions[0]?.sessionId ?? ''}`;

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
    note: 'A ?session= opens the view on load, without sending or changing anything. This one is interactive, so it opens on Conversation and attaches nothing.',
    width: 1280,
    search: OPEN,
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  {
    title: 'Three columns, a running background session opened from the URL (W54)',
    note: 'It opens on its Terminal tab, which attaches, as a click on its row would have it, with Preferences on Terminal, the default. It sends and changes nothing else.',
    width: 1280,
    search: OPEN_JOB,
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  {
    title: 'Three columns, the actions menu',
    note: 'In three columns the menu can resize the view without a drag (WCAG 2.5.7): Make view wider and Make view narrower move it 80 px, and Reset view width goes back to 760 px, or what the window allows. Here the view is 600 px in a 1,280 px window, so all three can act; at a limit, an item is off, and says why in its tooltip.',
    width: 1280,
    search: OPEN,
    stored: { [PANEL_WIDTH_KEY]: '600' },
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
    run: async (root) => {
      if (!laidOut(root)) return;
      (await element<HTMLButtonElement>(root, '.session-view button[aria-label="Session actions"]')).click();
      await element(root, '[role="menu"]');
    },
  },
  {
    title: 'Three columns, a session that worked in several repos',
    note: 'Opened from ~/code, where it started: the view’s line 3 names the repos it worked in, pitwall-test-docs too, which has no group, with the rule behind the info button.',
    width: 1280,
    search: `${repo(ROOT)}&session=${WORKED_FROM_ROOT.sessionId}`,
    view: { state: 'live', snapshot: WORKED_SNAPSHOT },
  },
  {
    title: 'Three columns, a starred session open',
    note: 'The view’s star toggle, filled, before the actions menu, and the row’s too: both say the same, and either unstars it. s does as well, with a toast, while the single-key shortcuts are on.',
    width: 1280,
    search: `?view=starred&session=${APP_GROUP.sessions[0]?.sessionId ?? ''}`,
    stored: storedStarred(STARRED_IDS),
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
    title: 'Opened from the URL, before the first snapshot',
    note: 'A ?session= waits in the view, with Close: skeletons for its header after half a second, then the long-wait line after 10 seconds, here at once. It takes no focus.',
    width: 1280,
    search: OPEN,
    view: { state: 'connecting' },
    waited: 'long',
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
    note: 'The session view starts below the header, which is below the app strip, so both show in every layout.',
    width: 1000,
    search: OPEN,
    view: { state: 'live', snapshot: { ...LIST_SNAPSHOT, relayAlert: RELAY_ALERT_OFF, relayOff: RELAY_OFF } },
  },
  {
    title: 'Two columns, a session open',
    note: 'Over the session list, below the header, which stays usable. The list is inert while the view is open; the repo list is clear of it from 1,000 px, and stays usable. Non-modal, with no backdrop.',
    width: 1000,
    search: OPEN,
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  {
    title: 'Two columns at 900 px, a session open',
    note: 'The view reaches into the repo list, which is inert too while it’s open.',
    width: 900,
    search: OPEN,
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  {
    title: 'Two columns at 1,100 px, a session open',
    note: 'A strip of the session list shows beside the view, inert: its chips and Sort are under it.',
    width: 1100,
    search: OPEN,
    view: { state: 'live', snapshot: LIST_SNAPSHOT },
  },
  {
    title: 'Two columns, opened from the URL before the first snapshot',
    note: 'The waiting view over the list, which shows its skeleton rows.',
    width: 1000,
    search: OPEN,
    view: { state: 'connecting' },
    waited: 'shown',
  },
  { title: 'One column, below 900 px', note: 'The repo list is a drawer, opened with Repos.', width: 375, view: { state: 'live', snapshot: LIST_SNAPSHOT } },
  {
    title: 'One column, a session open',
    note: 'At 600 px and narrower the view is full width, with Back to sessions in place of Close, below the header.',
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
        <Specimen key={page.title} title={page.title} note={page.note} frame="page" width={page.width} {...(page.waited ? { waited: page.waited } : {})}>
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
      <Specimen
        title="Status badges"
        note="Each session status, as statusBadge() gives it. Solid is for needing you only: Waiting, Blocked and Waiting for your prompt, by the session's needsYou (W69). A blocked job that needs nothing shows Idle. The list leaves Idle out; the session view shows it."
      >
        <p className="uikit-row">
          {STATUS_ROWS.map((row) => (
            <StatusBadge key={row.sessionId} badge={statusBadge(row)} />
          ))}
        </p>
      </Specimen>
      <Specimen title="Other badges" note="Stale and a finished session's Asked you carry their explanations in tooltips, on hover. See Tooltips.">
        <p className="uikit-row">
          <Badge look="subtle-neutral" hint={STALE_HINT}>
            Stale
          </Badge>
          <Badge look="outline" hint={FINISHED_ASKED_HINT}>
            Asked you
          </Badge>
          <Badge look="subtle-neutral">4</Badge>
          <span className="badge badge-attention">2 need you</span>
        </p>
      </Specimen>
      <Specimen title="Connection badges" note="The header's badge, in each connection state: the Spinner component while connecting or reconnecting, a dot once live.">
        <p className="uikit-row">
          {STATES.map((state) => (
            <ConnectionBadge key={state} state={state} />
          ))}
        </p>
      </Specimen>
      <Specimen title="No token" note="This tab has no token: opened without one, or after a browser restart lost it. It gives both ways back, the link pitwall printed or, with a fixed PITWALL_TOKEN, #token= added to the address (W51), and says a fixed PITWALL_TOKEN keeps a pinned tab working (W40)." frame="page">
        <NoTokenNotice />
      </Specimen>
      <Specimen title="Token rejected" note="The server refused this tab's token, usually the last run's. The same two ways back." frame="page">
        <TokenRejectedNotice />
      </Specimen>
    </>
  );
}
