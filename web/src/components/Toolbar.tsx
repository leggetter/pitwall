// The toolbar (docs/design-system.md, 3 and 4): the filter field, the filter chips and "Clear filters"
// on the left, and the summary on the right. The Dashboard shows it once there's a session.

import { useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { FILTER_CHIPS, filtering, NO_FILTERS, needYou, sessionCount, type FilterChip, type Filters } from '../sessions.js';
import { Icon } from './Icon.js';

export const CHIP_LABELS: Readonly<Record<FilterChip, string>> = {
  needsYou: 'Needs you',
  interactive: 'Interactive',
  background: 'Background',
  finished: 'Finished',
};

export interface FilterFieldProps {
  value: string;
  onChange: (value: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * The filter field (Search, in section 4): a search icon, the text, and a clear button once there's
 * text. Escape clears the text, or leaves the field when it's already empty. Escape that clears
 * doesn't go on to close the session view; Escape that leaves the field does.
 */
export function FilterField({ value, onChange, inputRef }: FilterFieldProps) {
  const id = useId();
  const own = useRef<HTMLInputElement>(null);
  const input = inputRef ?? own;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    if (value !== '') {
      // Handled: the session view's Escape listener checks defaultPrevented.
      event.preventDefault();
      onChange('');
    } else {
      event.currentTarget.blur();
    }
  };

  return (
    <div className="filter-field">
      <label className="visually-hidden" htmlFor={id}>
        Filter sessions
      </label>
      <Icon name="search" className="filter-field-icon" />
      <input
        ref={input}
        id={id}
        type="search"
        className="filter-input"
        placeholder="Filter by session, title, repo or directory"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {value !== '' && (
        <button
          type="button"
          className="icon-button ghost sm filter-clear"
          aria-label="Clear filter"
          // Until the design system's tooltips exist (W25), the browser's shows the same name.
          title="Clear filter"
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
        >
          <Icon name="clear" />
        </button>
      )}
    </div>
  );
}

export interface FilterChipsProps {
  chips: ReadonlySet<FilterChip>;
  onChange: (chips: ReadonlySet<FilterChip>) => void;
  /** How many sessions need you, shown on the Needs you chip when there are any. */
  attention: number;
  /** Shown after the chips, in their group, so it wraps with them: Clear filters. */
  children?: ReactNode;
}

/** The filter chips: toggle buttons, each pressed while it's on. */
export function FilterChips({ chips, onChange, attention, children }: FilterChipsProps) {
  const toggle = (chip: FilterChip) => {
    const next = new Set(chips);
    if (next.has(chip)) next.delete(chip);
    else next.add(chip);
    onChange(next);
  };
  return (
    <div className="filter-chips" role="group" aria-label="Filters">
      {FILTER_CHIPS.map((chip) => {
        const on = chips.has(chip);
        return (
          <button key={chip} type="button" className="chip" aria-pressed={on} onClick={() => toggle(chip)}>
            {on && <Icon name="copied" />}
            {CHIP_LABELS[chip]}
            {/* The space keeps the count apart in the button's name; the chip's gap does it on screen. */}
            {chip === 'needsYou' && attention > 0 && (
              <>
                {' '}
                <span className="chip-count">{attention}</span>
              </>
            )}
          </button>
        );
      })}
      {children}
    </div>
  );
}

export interface SummaryProps {
  /** Every session in the snapshot, whatever the filters show. */
  total: number;
  attention: number;
}

/** "12 sessions", then a solid "2 need you" badge, or "Nothing needs you". */
export function Summary({ total, attention }: SummaryProps) {
  return (
    <p className="summary">
      <span className="summary-count">{sessionCount(total)}</span>
      {attention > 0 ? (
        <span className="badge badge-attention">{needYou(attention)}</span>
      ) : (
        <>
          <span aria-hidden="true">·</span>
          <span className="summary-calm">Nothing needs you</span>
        </>
      )}
    </p>
  );
}

export interface ToolbarProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
  /** Every session in the snapshot. */
  total: number;
  /** How many of them need you. */
  attention: number;
}

export function Toolbar({ filters, onChange, total, attention }: ToolbarProps) {
  const field = useRef<HTMLInputElement>(null);
  return (
    <div className="toolbar">
      <form className="toolbar-filters" role="search" onSubmit={(event) => event.preventDefault()}>
        <FilterField value={filters.text} onChange={(text) => onChange({ ...filters, text })} inputRef={field} />
        <FilterChips chips={filters.chips} onChange={(chips) => onChange({ ...filters, chips })} attention={attention}>
          {filtering(filters) && (
            <button
              type="button"
              className="button ghost sm"
              onClick={() => {
                onChange(NO_FILTERS);
                // The button goes away with the filters, so focus goes back to the field rather than the page.
                field.current?.focus();
              }}
            >
              Clear filters
            </button>
          )}
        </FilterChips>
      </form>
      <Summary total={total} attention={attention} />
    </div>
  );
}
