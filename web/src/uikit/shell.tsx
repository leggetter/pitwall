// The app shell's pieces (W21): the real Header, Toolbar and Summary, with fixture props. The header
// is shown in windows of each breakpoint's width, since the shell's width rules are container
// queries on the app (docs/design-system.md, 2.12); the toolbars keep their own filters, so they
// can be typed into and clicked.

import { useState } from 'react';
import { Header } from '../components/Header.js';
import { Summary, Toolbar } from '../components/Toolbar.js';
import { NO_FILTERS, type FilterChip, type Filters } from '../sessions.js';
import { ago, LONG_ROOTS, NOW, ROOT } from './fixtures.js';
import { Specimen } from './kit.js';

const noop = () => {};
const UPDATED = ago(0.05);

/** A toolbar with filters of its own, starting from `start`. */
function LiveToolbar({ start = NO_FILTERS, total = 12, attention = 2 }: { start?: Filters; total?: number; attention?: number }) {
  const [filters, setFilters] = useState(start);
  return <Toolbar filters={filters} onChange={setFilters} total={total} attention={attention} />;
}

const chips = (...on: FilterChip[]): ReadonlySet<FilterChip> => new Set(on);

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

export function Toolbars() {
  return (
    <>
      <Specimen title="Empty" note="Type to filter; the chips toggle.">
        <LiveToolbar />
      </Specimen>
      <Specimen title="With text" note="The clear button shows, and so does Clear filters. Escape clears the text.">
        <LiveToolbar start={{ text: 'export', chips: chips() }} />
      </Specimen>
      <Specimen title="With chips on" note="Needs you and Background: sessions that need you and are background sessions.">
        <LiveToolbar start={{ text: '', chips: chips('needsYou', 'background') }} />
      </Specimen>
      <Specimen title="600 px and narrower" note="The toolbar wraps." width={375}>
        <LiveToolbar start={{ text: 'export', chips: chips('finished') }} />
      </Specimen>
    </>
  );
}

export function Summaries() {
  return (
    <>
      <Specimen title="Something needs you">
        <Summary total={12} attention={2} />
      </Specimen>
      <Specimen title="Nothing needs you">
        <Summary total={1} attention={0} />
      </Specimen>
    </>
  );
}
