// An editable combobox with list autocomplete (docs/design-system.md, 4: Combobox; W70), after the
// WAI-ARIA APG's "Editable Combobox With List Autocomplete": a text field whose list of suggestions
// narrows as you type. The caller narrows them; this draws the field and the list, and handles the
// keys. New session's Directory field is built on it.
//
// - The field: role="combobox", aria-autocomplete="list", aria-expanded, aria-controls the listbox,
//   and aria-activedescendant the highlighted option. Focus stays in the field throughout.
// - The list: a role="listbox" of role="option"s, under the field, with status lines after it, such
//   as "Loading directories…" or "50 of 312. Keep typing to narrow them.". The count is announced
//   politely, a moment after the typing stops, not on every key.
// - Keys: ↓ and ↑ move through the options, wrapping, and open the list when it's shut; Alt + ↓ opens
//   it without moving. Enter accepts the highlighted option and never submits the form; ⌘/Ctrl +
//   Enter is left to the form. Escape closes an open list, and goes no further, so the dialog stays;
//   with the list shut it goes on as before. Tab leaves without accepting. ← → Home End move the
//   caret and leave the options. While an input method is composing, every key is its own: ↓ picks
//   its candidates and Enter confirms them, so none of these apply.
// - A click on an option accepts it, and focus stays in the field. A click in the field opens the
//   list; a press outside it closes it, and so does focus moving to another control in its form, as
//   when a submit puts focus on a field with a problem. Focus leaving the page, as when you switch
//   windows, leaves it as it was, as a menu does; so does focus going to another form, which only the
//   #uikit gallery's many dialogs do.
// - selectOnFocus: focus, by Tab, a click or the dialog opening, selects the field's text, so typing
//   replaces it, as for a field that shows a choice already made. The click's own mouseup is kept
//   from putting the caret back.
// - autoSelect, the APG's "List autocomplete with automatic selection" (W142): typing highlights
//   the first option, aria-activedescendant points at it, and Enter accepts it, so typing part of a
//   name then Enter takes the best match. ↓ then moves to the second. It follows the first as the
//   options change under it, as when a listing arrives while you type, and none is highlighted while
//   there are none, so Enter closes the list and keeps the text. Text emptied, or only spaces, has
//   none: the list then offers everything, unnarrowed, and Enter shouldn't pick one you didn't type
//   towards. Only typing turns it on: opening by a click, ↓, Alt + ↓ or focus is as before, so a
//   field that shows its choice with selectOnFocus has none until you type. ← → Home End leave the
//   options as before, and Tab still leaves without accepting. It's read as the field renders, so a
//   caller can turn it off for text that's already a choice, whose list isn't narrowed.
// - The highlight follows its option as the options change: one the arrows moved to keeps it while
//   it's still offered, wherever it moved to, and goes when it isn't.
// - chevron: a select's chevron at the field's end, so it reads as a list to choose from as well as
//   a field to type in. It's decoration: a click on it goes through to the field, which opens the list.

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Icon } from './Icon.js';
import { MiddleEllipsis } from './MiddleEllipsis.js';
import { isComposing } from '../composing.js';
import { plainText } from '../format.js';

export interface ComboboxOption {
  /** What it reads as, as plain text. Paths are cut in the middle when there isn't room. */
  label: string;
  /** A quiet marker after the label, such as "repo". */
  marker?: string | undefined;
}

export interface ComboboxProps<T extends ComboboxOption> {
  id: string;
  /** The field's accessible name. */
  label: string;
  /** The listbox's accessible name. */
  listLabel: string;
  value: string;
  /** The text changed by typing. */
  onInput: (value: string) => void;
  /** The options to show now, already narrowed, best first. */
  options: readonly T[];
  /** An option was chosen, with Enter or a click. The caller sets the value. */
  onAccept: (option: T) => void;
  /** Lines after the options, in meta type: loading, how many there are, none match. */
  status?: ReactNode;
  /** What a screen reader hears, politely, a moment after it settles, while the list is open. */
  announcement?: string | undefined;
  /** Open the list the first time the field takes focus, as when a choice reveals it and moves focus into it. */
  openOnMount?: boolean;
  /** Select the text as the field takes focus, so typing replaces it: for a field that shows a choice already made. */
  selectOnFocus?: boolean;
  /** Typing highlights the first option, so Enter accepts it: the APG's automatic selection (W142). */
  autoSelect?: boolean;
  /** A select's chevron at the field's end, for a combobox that stands in for a select. */
  chevron?: boolean;
  placeholder?: string | undefined;
  className?: string | undefined;
  /** While the dialog's action runs: aria-disabled and read-only, with the list shut. */
  busy?: boolean;
  invalid?: boolean;
  describedBy?: string | undefined;
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * The highlighted option: none; the first, whichever it is (autoSelect, after typing); or the one the
 * arrows moved to, by its index then and its label, so it's found again as the options change.
 */
type Highlight = { to: 'none' } | { to: 'first' } | { to: 'option'; index: number; label: string };

const NONE: Highlight = { to: 'none' };

/** The highlight's index in these options, or -1 for none. */
function indexOf(highlight: Highlight, options: readonly ComboboxOption[], autoSelect: boolean): number {
  switch (highlight.to) {
    case 'none':
      return -1;
    case 'first':
      return autoSelect && options.length > 0 ? 0 : -1;
    case 'option':
      return options[highlight.index]?.label === highlight.label ? highlight.index : options.findIndex((option) => option.label === highlight.label);
  }
}

/** How long the count waits for the typing to stop before it's announced. */
export const ANNOUNCE_DELAY_MS = 500;

export function Combobox<T extends ComboboxOption>({
  id,
  label,
  listLabel,
  value,
  onInput,
  options,
  onAccept,
  status,
  announcement,
  openOnMount = false,
  selectOnFocus = false,
  autoSelect = false,
  chevron = false,
  placeholder,
  className,
  busy = false,
  invalid = false,
  describedBy,
  inputRef,
}: ComboboxProps<T>) {
  const listId = `${id}-listbox`;
  const optionId = (index: number) => `${id}-option-${index}`;
  // Whether the list is open, and the highlighted option: focus is in the field either way. Kept in
  // a ref too, so keys pressed before the next render see the latest.
  const [state, setState] = useState<{ open: boolean; highlight: Highlight }>({ open: false, highlight: NONE });
  const latest = useRef(state);
  const update = (next: { open: boolean; highlight: Highlight }) => {
    latest.current = next;
    setState(next);
  };
  const { open } = state;
  // The option at an index, to highlight.
  const at = (index: number): Highlight => {
    const option = options[index];
    return option === undefined ? NONE : { to: 'option', index, label: option.label };
  };
  // openOnMount, until the field first takes focus.
  const openOnFocus = useRef(openOnMount);
  // Set by a press on the field while it hasn't focus, so that click's mouseup doesn't put the caret
  // back over the text focus selected.
  const pressedToFocus = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const [announced, setAnnounced] = useState('');
  const list = useRef<HTMLUListElement>(null);

  // Options that went away take the highlight with them.
  const highlighted = indexOf(state.highlight, options, autoSelect);
  const shown = open && !busy && (options.length > 0 || status !== undefined);

  useEffect(() => {
    if (!shown || announcement === undefined) {
      setAnnounced('');
      return;
    }
    const timer = setTimeout(() => setAnnounced(announcement), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [shown, announcement]);

  // A press outside closes it, wherever it puts focus.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && box.current?.contains(event.target)) return;
      latest.current = { open: false, highlight: NONE };
      setState(latest.current);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  // The highlighted option stays in sight as the arrows move through a list that scrolls.
  useEffect(() => {
    if (highlighted < 0) return;
    const element = list.current?.children[highlighted];
    if (element instanceof HTMLElement) element.scrollIntoView?.({ block: 'nearest' });
  }, [highlighted]);

  const close = () => update({ open: false, highlight: NONE });

  const accept = (index: number) => {
    const option = options[index];
    if (!option) return;
    close();
    onAccept(option);
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (busy) return;
    const text = event.target.value;
    onInput(text);
    // autoSelect is checked as the field renders, not here: this render's may be about to change
    // with the text, as when the text stops being a choice already made.
    update({ open: true, highlight: text.trim() !== '' ? { to: 'first' } : NONE });
    // The options narrow from the top, so the list goes back there: a first match highlighted while
    // the list stayed scrolled down would be out of sight, and Enter would take it unseen (W142).
    if (list.current) list.current.scrollTop = 0;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // The input method's keys, as Terminal.tsx has them, Safari's 229 after compositionend included.
    if (busy || isComposing(event.nativeEvent)) return;
    const count = options.length;
    const now = latest.current;
    const current = indexOf(now.highlight, options, autoSelect);
    const visible = now.open && (count > 0 || status !== undefined);
    switch (event.key) {
      case 'ArrowDown':
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        if (event.altKey) update({ open: true, highlight: now.open ? now.highlight : NONE });
        else if (!now.open) update({ open: true, highlight: at(0) });
        else if (count > 0) update({ open: true, highlight: at(current < 0 || current >= count - 1 ? 0 : current + 1) });
        return;
      case 'ArrowUp':
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        if (event.altKey) close();
        else if (!now.open) update({ open: true, highlight: at(count - 1) });
        else if (count > 0) update({ open: true, highlight: at(current <= 0 ? count - 1 : current - 1) });
        return;
      case 'Enter':
        // ⌘/Ctrl + Enter is the form's: it starts the session.
        if (event.metaKey || event.ctrlKey) return;
        // Never the form's implicit submission: Enter here is for the list.
        event.preventDefault();
        if (visible && current >= 0) accept(current);
        else close();
        return;
      case 'Escape':
        if (!visible) return;
        // Handled here, so the dialog stays open.
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      case 'Tab':
        close();
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Home':
      case 'End':
        if (current >= 0) update({ open: now.open, highlight: NONE });
        return;
    }
  };

  return (
    <div ref={box} className={['combobox', chevron && 'combobox-chevroned', className].filter(Boolean).join(' ')}>
      <span className="combobox-field">
        <input
          id={id}
          ref={inputRef}
          type="text"
          className="field-input mono combobox-input"
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={listId}
          aria-activedescendant={shown && highlighted >= 0 ? optionId(highlighted) : undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onClick={() => {
            if (!busy && !latest.current.open) update({ open: true, highlight: NONE });
          }}
          onMouseDown={(event) => {
            pressedToFocus.current = selectOnFocus && document.activeElement !== event.currentTarget;
          }}
          onMouseUp={(event) => {
            if (!pressedToFocus.current) return;
            pressedToFocus.current = false;
            event.preventDefault();
          }}
          onFocus={(event) => {
            if (selectOnFocus) event.currentTarget.select();
            if (!openOnFocus.current) return;
            openOnFocus.current = false;
            update({ open: true, highlight: NONE });
          }}
          onBlur={(event) => {
            const to = event.relatedTarget;
            if (!(to instanceof Element) || box.current?.contains(to)) return;
            const scope = box.current?.closest('form') ?? document.body;
            if (scope.contains(to)) close();
          }}
          readOnly={busy}
          aria-disabled={busy || undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        />
        {chevron && <Icon name="select" className="select-icon" />}
      </span>
      <div
        className="combobox-popup"
        hidden={!shown}
        // A press in the list keeps focus in the field, so a click accepts without a blur closing it first.
        onMouseDown={(event) => event.preventDefault()}
      >
        <ul ref={list} id={listId} role="listbox" aria-label={listLabel} className="combobox-list" hidden={options.length === 0}>
          {options.map((option, index) => (
            <li
              key={`${index}:${option.label}`}
              id={optionId(index)}
              role="option"
              aria-selected={index === highlighted}
              className="combobox-option"
              onClick={() => accept(index)}
            >
              <MiddleEllipsis text={plainText(option.label)} className="combobox-option-label" />
              {option.marker !== undefined && (
                <span className="combobox-option-marker">
                  <span className="visually-hidden">, </span>
                  {option.marker}
                </span>
              )}
            </li>
          ))}
        </ul>
        {status !== undefined && <div className="combobox-status">{status}</div>}
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        {announced}
      </span>
    </div>
  );
}
