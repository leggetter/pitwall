// Filtering the sessions (docs/design-system.md, section 4: Search and Filter chips): the filter
// field, the filter chips and "Clear filters", together in role="search". Where they sit on the
// page is the layout's business (section 3). The PR list uses the field, the chips, with its own,
// and Clear filters too (W95, W101).

import { useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { FILTER_CHIPS, filtering, NO_FILTERS, type FilterChip, type Filters } from '../sessions.js';
import { SHORTCUT_KEYS, useShortcuts } from '../shortcuts.js';
import { Icon } from './Icon.js';
import { KeyCaps } from './KeyCaps.js';
import { Tooltip } from './Tooltip.js';

export const CHIP_LABELS: Readonly<Record<FilterChip, string>> = {
  interactive: 'Interactive',
  background: 'Background',
};

export interface FilterFieldProps {
  value: string;
  onChange: (value: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Its visually hidden label: "Filter sessions", or the PR list's "Filter pull requests" (W95). */
  label?: string;
  /** Its placeholder: the session list's, or the PR list's (W95). */
  placeholder?: string;
}

/**
 * The filter field (Search, in section 4): a search icon, the text, and a clear button once there's
 * text. Escape clears the text, or leaves the field when it's already empty. Escape that clears
 * doesn't go on to close the session view; Escape that leaves the field does.
 *
 * While the single-key shortcuts are on, a `/` key cap says how to get here, while the field is
 * empty and unfocused (CSS hides it on focus), and the field's aria-keyshortcuts says so too.
 */
export function FilterField({ value, onChange, inputRef, label = 'Filter sessions', placeholder = 'Filter by session, title, repo or directory' }: FilterFieldProps) {
  const id = useId();
  const own = useRef<HTMLInputElement>(null);
  const input = inputRef ?? own;
  const shortcuts = useShortcuts();

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
    <div className={shortcuts.on ? 'filter-field with-key' : 'filter-field'}>
      <label className="visually-hidden" htmlFor={id}>
        {label}
      </label>
      <Icon name="search" className="filter-field-icon" />
      <input
        ref={input}
        id={id}
        type="search"
        className="filter-input"
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-keyshortcuts={shortcuts.on ? '/' : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {shortcuts.on && value === '' && (
        // A hint for sighted users: the field's aria-keyshortcuts says it to everyone else.
        <span className="filter-key" aria-hidden="true">
          <KeyCaps keys={SHORTCUT_KEYS.filter.keys} label={SHORTCUT_KEYS.filter.label} />
        </span>
      )}
      {value !== '' && (
        <Tooltip content="Clear text" relation="label">
          <button
            type="button"
            className="icon-button ghost sm filter-clear"
            onClick={() => {
              onChange('');
              input.current?.focus();
            }}
          >
            <Icon name="clear" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

export interface FilterChipsProps<T extends string = FilterChip> {
  chips: ReadonlySet<T>;
  onChange: (chips: ReadonlySet<T>) => void;
  /** The chips, in order: the session list's (FILTER_CHIPS) unless given, as the PR list's are (W101). */
  options?: readonly T[];
  /** Each chip's label: the session list's (CHIP_LABELS) unless given. */
  labels?: Readonly<Record<T, string>>;
  /** Shown after the chips, in their group, so it wraps with them: Clear filters, or its room. */
  children?: ReactNode;
}

/** The filter chips: toggle buttons, each pressed while it's on. */
export function FilterChips<T extends string = FilterChip>({
  chips,
  onChange,
  options = FILTER_CHIPS as unknown as readonly T[],
  labels = CHIP_LABELS as unknown as Readonly<Record<T, string>>,
  children,
}: FilterChipsProps<T>) {
  const toggle = (chip: T) => {
    const next = new Set(chips);
    if (next.has(chip)) next.delete(chip);
    else next.add(chip);
    onChange(next);
  };
  return (
    <div className="filter-chips" role="group" aria-label="Filters">
      {options.map((chip) => {
        const on = chips.has(chip);
        return (
          <button key={chip} type="button" className="chip" aria-pressed={on} data-chip={chip} onClick={() => toggle(chip)}>
            {on && <Icon name="copied" />}
            {labels[chip]}
          </button>
        );
      })}
      {children}
    </div>
  );
}

/**
 * Clear filters, after the chips (W91): a ghost sm icon button named by its tooltip, while any filter
 * is on; otherwise its room, the same size and unseen, not a button and hidden from assistive
 * technology, so nothing after it moves as it comes and goes (W75).
 */
export function ClearFilters({ on, onClear }: { on: boolean; onClear: () => void }) {
  return on ? (
    <Tooltip content="Clear filters" relation="label">
      <button type="button" className="icon-button ghost sm" data-clear-filters="" onClick={onClear}>
        <Icon name="clear-filters" />
      </button>
    </Tooltip>
  ) : (
    <span className="icon-button ghost sm filter-clear-room" aria-hidden="true">
      <Icon name="clear-filters" />
    </span>
  );
}

export interface FilterControlsProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
  /** Other controls, after the chips, such as the session list's Sort setting, so they wrap with them. */
  children?: ReactNode;
  /** The filter field, for the `/` shortcut. */
  fieldRef?: RefObject<HTMLInputElement | null>;
}

/**
 * The field, the chips and Clear filters, in role="search". The field has a line of its own, and the
 * chips, Clear filters and `children` share the next, wrapping when they must. Turning a filter on or
 * off moves none of them (W75): while no filter is on, an unseen copy of Clear filters keeps its room.
 * Clear filters is an icon button at every width, named by its tooltip (W91), so the chips' line has
 * room for Sort in a 1,440 px window, where the text button's room cost the bar a line.
 */
export function FilterControls({ filters, onChange, children, fieldRef }: FilterControlsProps) {
  const own = useRef<HTMLInputElement>(null);
  const field = fieldRef ?? own;
  return (
    <form className="filter-controls" role="search" onSubmit={(event) => event.preventDefault()}>
      <FilterField value={filters.text} onChange={(text) => onChange({ ...filters, text })} inputRef={field} />
      <FilterChips chips={filters.chips} onChange={(chips) => onChange({ ...filters, chips })}>
        <ClearFilters
          on={filtering(filters)}
          onClear={() => {
            onChange(NO_FILTERS);
            // The button goes away with the filters, so focus goes back to the field rather than the page.
            field.current?.focus();
          }}
        />
      </FilterChips>
      {children}
    </form>
  );
}
