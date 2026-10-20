// The app shell's pieces (W21): the real Header and filters, with fixture props. The header is shown
// in windows of each breakpoint's width, since the shell's width rules are container queries on the
// app (docs/design-system.md, 2.12); each set of filters keeps its own, so it can be typed into and
// clicked.

import { useState } from 'react';
import { Header } from '../components/Header.js';
import { FilterControls } from '../components/Filters.js';
import { NO_FILTERS, type FilterChip, type Filters } from '../sessions.js';
import { ago, LONG_ROOTS, NOW, ROOT } from './fixtures.js';
import { Specimen } from './kit.js';

const noop = () => {};
const UPDATED = ago(0.05);

/** The filters, with state of their own, starting from `start`. */
function LiveFilters({ start = NO_FILTERS }: { start?: Filters }) {
  const [filters, setFilters] = useState(start);
  return <FilterControls filters={filters} onChange={setFilters} />;
}

const filters = (text: string, ...chips: FilterChip[]): Filters => ({ text, chips: new Set(chips), attentionOnly: false });

const BREAKPOINTS = [
  { title: 'From 1,100 px', note: '24 px gutters.', width: 1100 },
  { title: 'Between 600 and 1,100 px', note: '16 px gutters, on one line.', width: 800 },
  { title: '600 px and narrower', note: 'The right side wraps under the wordmark, and the header grows to fit.', width: 375 },
];

export function Headers() {
  return (
    <>
      {BREAKPOINTS.map((breakpoint) => (
        <Specimen key={breakpoint.width} title={breakpoint.title} note={breakpoint.note} width={breakpoint.width}>
          <Header state="live" roots={[ROOT]} updatedAt={UPDATED} now={NOW} onNewSession={noop} />
        </Specimen>
      ))}
      <Specimen title="Before the first snapshot" note="No roots, no New session and no time yet." width={800}>
        <Header state="connecting" now={NOW} />
      </Specimen>
      <Specimen title="A long roots list" note="The start is cut short with an ellipsis and the last segment stays; the full list is in the hover text." width={800}>
        <Header state="live" roots={LONG_ROOTS} updatedAt={UPDATED} now={NOW} onNewSession={noop} />
      </Specimen>
      <Specimen title="A long roots list, 600 px and narrower" width={375}>
        <Header state="reconnecting" roots={LONG_ROOTS} updatedAt={ago(0.9)} now={NOW} onNewSession={noop} />
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
      <Specimen title="In a narrow window" note="The chips and Clear filters wrap under the field." width={320}>
        <LiveFilters start={filters('export', 'interactive')} />
      </Specimen>
    </>
  );
}
