// The app shell's pieces (W21, W23): the real Header, RepoList, RepoDrawer, SessionList, the filters
// and the Sort setting, with fixture props. The header is shown in windows of each width, since its compact rule is a container
// query on the app (docs/design-system.md, 2.12). The repo lists and filters keep their own state,
// so they can be clicked and typed into.

import { useState } from 'react';
import type { IndexSnapshot } from '../../../src/shared/protocol.js';
import { FilterControls } from '../components/Filters.js';
import { Header } from '../components/Header.js';
import { RepoDrawer } from '../components/RepoDrawer.js';
import { RepoList } from '../components/RepoList.js';
import { SessionList, type SessionListHeading, type SessionListSummary } from '../components/SessionList.js';
import { SortSelect } from '../components/SortSelect.js';
import { ALL_SESSIONS, groupSelection, NEEDS_YOU, type Selection } from '../selection.js';
import { NO_FILTERS, SORT_ORDERS, type FilterChip, type Filters, type SortOrder } from '../sessions.js';
import { ago, APP_GROUP, LONG_ROOTS, REPO_LIST_SNAPSHOT, ROOT, SERVICE_GROUP, TWO_ROOTS_LIST_SNAPSHOT } from './fixtures.js';
import { Reopenable, Specimen } from './kit.js';

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

const BREAKPOINTS = [
  { title: 'From 900 px', note: 'The repo list is beside the session list, so there is no Repos button.', width: 1100, repos: false },
  { title: 'Below 900 px', note: 'The Repos button opens the repo list as a drawer.', width: 800, repos: true },
  { title: '600 px and narrower', note: 'The right side wraps under the wordmark, and the header grows to fit.', width: 375, repos: true },
];

export function Headers() {
  return (
    <>
      {BREAKPOINTS.map((breakpoint) => (
        <Specimen key={breakpoint.width} title={breakpoint.title} note={breakpoint.note} width={breakpoint.width}>
          <Header state="live" roots={[ROOT]} updatedAt={UPDATED} onNewSession={noop} onRepos={breakpoint.repos ? noop : undefined} />
        </Specimen>
      ))}
      <Specimen title="Before the first snapshot" note="No roots, no New session and no time yet." width={1100}>
        <Header state="connecting" />
      </Specimen>
      <Specimen title="A long roots list" note="The start is cut short with an ellipsis and the last segment stays; the full list, home and all, is in a tooltip." width={800}>
        <Header state="live" roots={LONG_ROOTS} updatedAt={UPDATED} onNewSession={noop} onRepos={noop} />
      </Specimen>
      <Specimen title="A long roots list, 600 px and narrower" width={375}>
        <Header state="reconnecting" roots={LONG_ROOTS} updatedAt={ago(0.9)} onNewSession={noop} onRepos={noop} />
      </Specimen>
    </>
  );
}

/** A repo list with a selection of its own: clicking an item selects it. */
function LiveRepoList({ snapshot, start = ALL_SESSIONS }: { snapshot: IndexSnapshot | undefined; start?: Selection }) {
  const [selection, setSelection] = useState(start);
  return <RepoList groups={snapshot?.groups} roots={snapshot?.roots ?? [ROOT]} selection={selection} onSelect={setSelection} />;
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
      <Specimen title="Several roots" note="Each root's groups under its path." width={240}>
        <LiveRepoList snapshot={TWO_ROOTS_LIST_SNAPSHOT} start={groupSelection(SERVICE_GROUP, TWO_ROOTS_LIST_SNAPSHOT.roots)} />
      </Specimen>
      <Specimen title="Before the first snapshot" note="The two views, with no counts." width={240}>
        <LiveRepoList snapshot={undefined} />
      </Specimen>
    </>
  );
}

/** The drawer, with a selection of its own. */
function Drawer({ onClose }: { onClose: () => void }) {
  const [selection, setSelection] = useState<Selection>(ALL_SESSIONS);
  return (
    <RepoDrawer onClose={onClose}>
      <RepoList groups={REPO_LIST_SNAPSHOT.groups} roots={REPO_LIST_SNAPSHOT.roots} selection={selection} onSelect={setSelection} />
    </RepoDrawer>
  );
}

export function RepoDrawers() {
  return (
    <Specimen title="Open" note="Below 900 px. Escape or a click on the backdrop closes it here too." frame="view">
      <Reopenable>{(close) => <Drawer onClose={close} />}</Reopenable>
    </Specimen>
  );
}

interface HeadCase {
  title: string;
  heading: SessionListHeading;
  summary: SessionListSummary;
  start?: Filters;
  sort?: SortOrder;
}

const HEADS: HeadCase[] = [
  { title: 'All sessions', heading: { label: 'All sessions' }, summary: { total: 10, shown: 10, attention: 2 } },
  { title: 'Needs you', heading: { label: 'Needs you' }, summary: { total: 2, shown: 2, attention: 2 } },
  { title: 'A group', heading: { label: 'pitwall-test-app', kind: 'git' }, summary: { total: 4, shown: 4, attention: 2 } },
  { title: 'A directory, with nothing that needs you', heading: { label: 'pitwall-test-notes', kind: 'directory' }, summary: { total: 1, shown: 1, attention: 0 } },
  { title: 'A group under one of several roots', heading: { label: 'pitwall-test-service', kind: 'git', root: '/Users/example/work' }, summary: { total: 1, shown: 1, attention: 0 } },
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
        <Specimen key={head.title} title={head.title}>
          <SessionList
            heading={head.heading}
            summary={head.summary}
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
      <Specimen title="In a narrow window" note="The summary and the filters wrap." width={320}>
        <SessionList
          heading={{ label: 'pitwall-test-app/packages/a-package-directory-with-a-long-name', kind: 'git' }}
          summary={{ total: 4, shown: 4, attention: 2 }}
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
      <Specimen title="Empty" note="Type to filter; the chips toggle.">
        <LiveFilters />
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
