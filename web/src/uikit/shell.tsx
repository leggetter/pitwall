// The app shell's pieces (W21, W23, W35, W38): the real Header, with a tab per root when there are
// several, RepoList with its Hidden section, RepoDrawer, SessionList with a group's Hide from repo
// list, the filters and the Sort setting, with fixture props. The header is shown in windows of each
// width, since its compact rule is a container query on the app (docs/design-system.md, 2.12). The
// root tabs, the repo lists and the filters keep their own state, so they can be clicked and typed into.

import { useId, useState } from 'react';
import type { IndexSnapshot } from '../../../src/shared/protocol.js';
import { FilterControls } from '../components/Filters.js';
import { Header } from '../components/Header.js';
import { HideButton } from '../components/HideButton.js';
import { RepoDrawer } from '../components/RepoDrawer.js';
import { RepoList } from '../components/RepoList.js';
import { SessionList, type SessionListHeading, type SessionListSummary } from '../components/SessionList.js';
import { SortSelect } from '../components/SortSelect.js';
import type { ConnectionState } from '../connection.js';
import { useHiddenGroups, type HiddenGroup } from '../hidden.js';
import { tabGroups } from '../rootTabs.js';
import { ALL_SESSIONS, groupSelection, NEEDS_YOU, viewIn, type Selection } from '../selection.js';
import { ShortcutsStoreContext } from '../shortcuts.js';
import { NO_FILTERS, SORT_ORDERS, type FilterChip, type Filters, type SortOrder } from '../sessions.js';
import {
  ago,
  ALL_FINISHED_GROUP,
  APP_GROUP,
  GONE_HIDDEN,
  LONG_ROOT,
  LONG_ROOTS,
  NOTES_GROUP,
  OTHER_ROOT,
  REPO_LIST_SNAPSHOT,
  ROOT,
  SERVICE_GROUP,
  THREE_ROOTS,
  TWO_ROOTS_LIST_SNAPSHOT,
  WORKED_ROOT_GROUP,
  WORKED_SNAPSHOT,
} from './fixtures.js';
import { Reopenable, Specimen } from './kit.js';
import { memoryShortcuts, memoryStorage, storedHidden } from './stubs.js';

const noop = () => {};
const UPDATED = ago(0.05);

/** The Sort setting, with state of its own. */
function LiveSort({ start = 'urgency' }: { start?: SortOrder }) {
  const [order, setOrder] = useState(start);
  return <SortSelect value={order} onChange={setOrder} />;
}

/** The filters and the Sort setting after them, as the session list's header has them, with state of their own. */
function LiveFilters({ start = NO_FILTERS, sort }: { start?: Filters; sort?: SortOrder }) {
  const [filters, setFilters] = useState(start);
  return (
    <FilterControls filters={filters} onChange={setFilters}>
      <LiveSort start={sort} />
    </FilterControls>
  );
}

const filters = (text: string, ...chips: FilterChip[]): Filters => ({ text, chips: new Set(chips) });

/** The single-key shortcuts off, for the specimens that show what changes. */
const OFF = memoryShortcuts(false);

const BREAKPOINTS = [
  { title: 'From 900 px', note: 'The repo list is beside the session list, so there is no Repos button.', width: 1100, repos: false },
  { title: 'Below 900 px', note: 'The Repos button opens the repo list as a drawer.', width: 800, repos: true },
  { title: '600 px and narrower', note: 'The right side wraps under the wordmark, and the header grows to fit.', width: 375, repos: true },
];

export interface TabbedHeaderProps {
  roots: readonly string[];
  /** How many need you under each root, by root: a tab that isn't open shows its badge. */
  attention?: Readonly<Record<string, number>>;
  /** The tab open at first; the first root otherwise. */
  start?: string;
  state?: ConnectionState;
  /** Below 900 px: the Repos button. */
  repos?: boolean;
}

/** The header with a tab per root, whose tabs switch, as the app's do (W38). */
export function TabbedHeader({ roots, attention = {}, start, state = 'live', repos = false }: TabbedHeaderProps) {
  const [active, setActive] = useState(start ?? roots[0] ?? '');
  const id = useId();
  return (
    <Header
      state={state}
      roots={roots}
      updatedAt={UPDATED}
      onNewSession={noop}
      onRepos={repos ? noop : undefined}
      onShortcuts={noop}
      tabs={{ tabs: roots.map((root) => ({ root, attention: attention[root] ?? 0 })), active, onSelect: setActive, tabId: (root) => `${id}-tab-${roots.indexOf(root)}` }}
    />
  );
}

/** ~/work needs you twice, with ~/code open. */
const WORK_NEEDS_YOU = { [OTHER_ROOT]: 2 };

/** Three roots that end in the same segment, as folders of clones often do, too long for one line at 320 px. */
const GIT_ROOTS = ['/Users/example/work/git', '/Users/example/personal/git', '/Users/example/scratch/git'];

export function Headers() {
  return (
    <>
      {BREAKPOINTS.map((breakpoint) => (
        <Specimen key={breakpoint.width} title={breakpoint.title} note={breakpoint.note} width={breakpoint.width}>
          <Header state="live" roots={[ROOT]} updatedAt={UPDATED} onNewSession={noop} onRepos={breakpoint.repos ? noop : undefined} onShortcuts={noop} />
        </Specimen>
      ))}
      <Specimen title="Before the first snapshot" note="No roots, no New session and no time yet; the keyboard shortcuts button is there from the start." width={1100}>
        <Header state="connecting" onShortcuts={noop} />
      </Specimen>
      <Specimen title="A long root" note="The start is cut short with an ellipsis and the last segment stays; the full path, home and all, is in a tooltip." width={800}>
        <Header state="live" roots={[LONG_ROOT]} updatedAt={UPDATED} onNewSession={noop} onRepos={noop} onShortcuts={noop} />
      </Specimen>
      <Specimen title="A long root, 600 px and narrower" width={375}>
        <Header state="reconnecting" roots={[LONG_ROOT]} updatedAt={ago(0.9)} onNewSession={noop} onRepos={noop} onShortcuts={noop} />
      </Specimen>
      <Specimen
        title="Two roots"
        note="A tab per root, in the order pitwall was given them, in place of the root's path. The open one has the selected look. Click a tab, or use ← and → and then Enter: moving focus never opens one."
        width={1100}
      >
        <TabbedHeader roots={[ROOT, OTHER_ROOT]} />
      </Specimen>
      <Specimen
        title="Three roots, sessions that need you in a tab that isn't open"
        note="~/work's badge counts its sessions that need you, so nothing that needs you is out of sight. The open tab has none: its repo list's Needs you, just below, says the same. Open ~/work and its badge goes; ~/code's would show if anything there needed you."
        width={1100}
      >
        <TabbedHeader roots={THREE_ROOTS} attention={WORK_NEEDS_YOU} />
      </Specimen>
      <Specimen title="Three roots, below 900 px" note="The Repos button, then the wordmark and the tabs." width={800}>
        <TabbedHeader roots={THREE_ROOTS} attention={WORK_NEEDS_YOU} repos />
      </Specimen>
      <Specimen
        title="Three roots, 600 px and narrower"
        note="The tabs go under the wordmark when they don't fit beside it, and the right side under them, so every tab and its badge stays in sight."
        width={375}
      >
        <TabbedHeader roots={THREE_ROOTS} attention={WORK_NEEDS_YOU} repos />
      </Specimen>
      <Specimen title="Three roots at 320 px" note="As at 200 % zoom on a 640 px window: the tabs wrap among themselves, whole, and nothing scrolls sideways." width={320}>
        <TabbedHeader roots={GIT_ROOTS} attention={{ [GIT_ROOTS[0] ?? '']: 1 }} start={GIT_ROOTS[1]} repos />
      </Specimen>
      <Specimen
        title="Long root paths"
        note="At any width, the right side wraps under the tabs once the line has no room for both. A tab wider than a whole line is cut in the middle, its last segment kept; each tab's full path is in its tooltip."
        width={800}
      >
        <TabbedHeader roots={LONG_ROOTS} attention={{ [LONG_ROOTS[2] ?? '']: 1 }} state="reconnecting" repos />
      </Specimen>
    </>
  );
}

interface LiveRepoListProps {
  snapshot: IndexSnapshot | undefined;
  start?: Selection;
  /** Groups hidden from it, in storage of its own, and whether the Hidden section starts open (W35). */
  hiding?: { groups: readonly HiddenGroup[]; open: boolean };
  /** With several roots, the open root tab, whose groups and hidden groups alone it lists (W38). */
  tab?: string;
}

/** A repo list with a selection and hidden groups of its own: clicking an item selects it, and Unhide and the Hidden toggle work. */
function LiveRepoList({ snapshot, start, hiding, tab }: LiveRepoListProps) {
  const [selection, setSelection] = useState(start ?? (tab === undefined ? ALL_SESSIONS : viewIn('all', tab)));
  const roots = snapshot?.roots ?? [ROOT];
  const [storage] = useState(() => memoryStorage(hiding ? storedHidden(hiding.groups, hiding.open) : {}));
  const hidden = useHiddenGroups(roots, storage);
  return (
    <RepoList
      groups={snapshot ? tabGroups(snapshot.groups, tab) : undefined}
      roots={roots}
      selection={selection}
      onSelect={setSelection}
      hidden={{
        groups: tab === undefined ? hidden.groups : hidden.groups.filter((group) => group.root === tab),
        open: hidden.open,
        onToggle: () => hidden.setOpen(!hidden.open),
        onUnhide: hidden.unhide,
      }}
      tab={tab}
    />
  );
}

export function RepoLists() {
  return (
    <>
      <Specimen
        title="One root, All sessions selected"
        note="A need-you badge, session counts, the root's own directory first and labelled with its path, a group whose sessions have all finished, muted, and a long label cut in the middle."
        width={240}
      >
        <LiveRepoList snapshot={REPO_LIST_SNAPSHOT} />
      </Specimen>
      <Specimen title="A group selected" width={240}>
        <LiveRepoList snapshot={REPO_LIST_SNAPSHOT} start={groupSelection(APP_GROUP, [ROOT])} />
      </Specimen>
      <Specimen title="Needs you selected" width={240}>
        <LiveRepoList snapshot={REPO_LIST_SNAPSHOT} start={NEEDS_YOU} />
      </Specimen>
      <Specimen
        title="A root's tab, of several"
        note="With two or more roots, the list is the open root tab's: ~/work's groups, with its own Needs you and All sessions and their counts. ~/code's are in its own tab."
        width={240}
      >
        <LiveRepoList snapshot={TWO_ROOTS_LIST_SNAPSHOT} start={groupSelection(SERVICE_GROUP, TWO_ROOTS_LIST_SNAPSHOT.roots)} tab={OTHER_ROOT} />
      </Specimen>
      <Specimen title="Before the first snapshot" note="The two views, with no counts." width={240}>
        <LiveRepoList snapshot={undefined} />
      </Specimen>
      <Specimen
        title="Each session in one group"
        note="Each session is under the group it started in alone: one started in pitwall-test-app is there, though it worked in pitwall-test-api and pitwall-test-docs too. pitwall-test-docs, where sessions only worked, has no item. Each group counts the sessions started in it, so the groups' counts add up to All sessions', and their badges to Needs you's."
        width={240}
      >
        <LiveRepoList snapshot={WORKED_SNAPSHOT} />
      </Specimen>
      <Specimen
        title="The root's group, and a directory below it"
        note="~/code holds every session started in the root itself, one that worked in pitwall-test-api and pitwall-test-docs among them. pitwall-test-scratch, a directory below the root that isn't a repo, holds the session started in it, which also worked in pitwall-test-docs."
        width={240}
      >
        <LiveRepoList snapshot={WORKED_SNAPSHOT} start={groupSelection(WORKED_ROOT_GROUP, [ROOT])} />
      </Specimen>
      <Specimen
        title="Hidden groups, the section closed"
        note="Two groups hidden from the list with the session list header's Hide from repo list. They're listed at its foot behind Hidden (2), collapsed by default, its own Tab stop outside the list's one."
        width={240}
      >
        <LiveRepoList snapshot={REPO_LIST_SNAPSHOT} hiding={{ groups: [NOTES_GROUP, ALL_FINISHED_GROUP], open: false }} />
      </Specimen>
      <Specimen
        title="Hidden groups, the section open"
        note="Each hidden group muted, with its count, as a link that selects it, here pitwall-test-notes, and an Unhide button. Unhide puts the group back in its place, with focus on its item. The open state is remembered."
        width={240}
      >
        <LiveRepoList snapshot={REPO_LIST_SNAPSHOT} start={groupSelection(NOTES_GROUP, [ROOT])} hiding={{ groups: [NOTES_GROUP, ALL_FINISHED_GROUP], open: true }} />
      </Specimen>
      <Specimen
        title="A hidden group that needs you"
        note="The disclosure carries the need-you badge, counting each session once, so nothing that needs you is out of sight. Opened, the group's own badge shows, as in the list."
        width={240}
      >
        <LiveRepoList snapshot={REPO_LIST_SNAPSHOT} hiding={{ groups: [APP_GROUP], open: false }} />
      </Specimen>
      <Specimen
        title="A hidden group with no sessions"
        note="pitwall-test-old-clone is in no snapshot, so it shows No sessions, and stays until it's unhidden. Next to it, a hidden group that needs you, open."
        width={240}
      >
        <LiveRepoList snapshot={REPO_LIST_SNAPSHOT} hiding={{ groups: [GONE_HIDDEN, APP_GROUP], open: true }} />
      </Specimen>
      <Specimen
        title="Hidden groups in a root's tab"
        note="pitwall-test-notes, under ~/code, and pitwall-test-service, under ~/work, are both hidden; ~/code's tab lists its own alone, and counts its own. Each root's are kept under its own key."
        width={240}
      >
        <LiveRepoList snapshot={TWO_ROOTS_LIST_SNAPSHOT} hiding={{ groups: [NOTES_GROUP, SERVICE_GROUP], open: true }} tab={ROOT} />
      </Specimen>
    </>
  );
}

/** The drawer, with a selection, and any hidden groups, of its own. */
function Drawer({ onClose, hiding }: { onClose: () => void; hiding?: LiveRepoListProps['hiding'] }) {
  return (
    <RepoDrawer onClose={onClose}>
      <LiveRepoList snapshot={REPO_LIST_SNAPSHOT} {...(hiding ? { hiding } : {})} />
    </RepoDrawer>
  );
}

export function RepoDrawers() {
  return (
    <>
      <Specimen title="Open" note="Below 900 px. Escape or a click on the backdrop closes it here too." frame="view">
        <Reopenable>{(close) => <Drawer onClose={close} />}</Reopenable>
      </Specimen>
      <Specimen
        title="Open, with hidden groups"
        note="The Hidden section, open, at its foot. Tab stays inside, through the section's controls; choosing a hidden group closes the drawer, as any item does."
        frame="view"
      >
        <Reopenable>{(close) => <Drawer onClose={close} hiding={{ groups: [NOTES_GROUP, GONE_HIDDEN], open: true }} />}</Reopenable>
      </Specimen>
    </>
  );
}

interface HeadCase {
  title: string;
  note?: string;
  heading: SessionListHeading;
  summary: SessionListSummary;
  start?: Filters;
  sort?: SortOrder;
  /** A group's Hide from repo list, or Show in repo list when it's hidden (W35). */
  hidden?: boolean;
}

/** Hide from repo list, which turns into Show in repo list when pressed, and back. */
function LiveHideButton({ start }: { start: boolean }) {
  const [hidden, setHidden] = useState(start);
  return <HideButton hidden={hidden} onClick={() => setHidden(!hidden)} />;
}

const HEADS: HeadCase[] = [
  { title: 'All sessions', heading: { label: 'All sessions' }, summary: { total: 10, shown: 10, attention: 2 } },
  { title: 'Needs you', heading: { label: 'Needs you' }, summary: { total: 2, shown: 2, attention: 2 } },
  {
    title: 'A group',
    note: 'Hide from repo list, after the summary: a ghost sm icon button, named by its tooltip. Press it to see Show in repo list.',
    heading: { label: 'pitwall-test-app', kind: 'git' },
    summary: { total: 4, shown: 4, attention: 2 },
    hidden: false,
  },
  {
    title: 'A hidden group',
    note: 'Show in repo list, in the same place: the same button, so focus stays on it.',
    heading: { label: 'pitwall-test-notes', kind: 'directory' },
    summary: { total: 1, shown: 1, attention: 0 },
    hidden: true,
  },
  { title: 'A directory, with nothing that needs you', heading: { label: 'pitwall-test-notes', kind: 'directory' }, summary: { total: 1, shown: 1, attention: 0 }, hidden: false },
  {
    title: 'Filtered',
    heading: { label: 'All sessions' },
    summary: { total: 10, shown: 3, attention: 2 },
    start: filters('export', 'background'),
  },
  { title: 'Sorted by name', heading: { label: 'All sessions' }, summary: { total: 10, shown: 10, attention: 2 }, sort: 'name' },
];

export function SessionListHeads() {
  return (
    <>
      {HEADS.map((head) => (
        <Specimen key={head.title} title={head.title} note={head.note}>
          <SessionList
            heading={head.heading}
            summary={head.summary}
            headingAction={head.hidden === undefined ? undefined : <LiveHideButton start={head.hidden} />}
            filters={<LiveFilters start={head.start} sort={head.sort} />}
            current={[]}
            finished={[]}
            finishedCollapsed
            onToggleFinished={noop}
          />
        </Specimen>
      ))}
      <Specimen title="At 360 px" note="The session list's width at 1,200 px: the chips and Sort share the line under the field." width={360}>
        <SessionList
          heading={{ label: 'All sessions' }}
          summary={{ total: 10, shown: 10, attention: 2 }}
          filters={<LiveFilters />}
          current={[]}
          finished={[]}
          finishedCollapsed
          onToggleFinished={noop}
        />
      </Specimen>
      <Specimen title="In a narrow window" note="The summary and the filters wrap; Hide from repo list goes with the summary." width={320}>
        <SessionList
          heading={{ label: 'pitwall-test-app/packages/a-package-directory-with-a-long-name', kind: 'git' }}
          summary={{ total: 4, shown: 4, attention: 2 }}
          headingAction={<LiveHideButton start={false} />}
          filters={<LiveFilters start={filters('export', 'interactive')} />}
          current={[]}
          finished={[]}
          finishedCollapsed
          onToggleFinished={noop}
        />
      </Specimen>
    </>
  );
}

export function FilterSpecimens() {
  return (
    <>
      <Specimen title="Empty" note="Type to filter; the chips toggle. The / key cap says how to get here; it goes while the field has focus or text.">
        <LiveFilters />
      </Specimen>
      <Specimen title="Empty, with the single-key shortcuts off" note="No / key cap, since / does nothing.">
        <ShortcutsStoreContext.Provider value={OFF}>
          <LiveFilters />
        </ShortcutsStoreContext.Provider>
      </Specimen>
      <Specimen title="With text" note="The clear button shows, and so does Clear filters. Escape clears the text.">
        <LiveFilters start={filters('export')} />
      </Specimen>
      <Specimen title="A chip on" note="Background: background sessions only.">
        <LiveFilters start={filters('', 'background')} />
      </Specimen>
      <Specimen title="Both chips on" note="Interactive or Background: every session, as with neither on.">
        <LiveFilters start={filters('', 'interactive', 'background')} />
      </Specimen>
      <Specimen title="In a narrow window" note="The chips and Clear filters wrap under the field, and Sort after them." width={320}>
        <LiveFilters start={filters('export', 'interactive')} />
      </Specimen>
      <Specimen title="The Sort setting" note="Urgency, the default, then Recent and Name. Each one keeps its own choice here; in the app it's one setting, kept in pitwall.sort.v1.">
        <div className="uikit-row">
          {SORT_ORDERS.map((order) => (
            <LiveSort key={order} start={order} />
          ))}
        </div>
      </Specimen>
    </>
  );
}
