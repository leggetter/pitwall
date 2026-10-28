// The filters (docs/design-system.md, section 4: Search and Filter chips): the filter field, the
// chips and Clear filters, rendered on their own with filters the test holds.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ICON_PATHS } from '../icons/paths.js';
import { NO_FILTERS, type FilterChip, type Filters } from '../sessions.js';
import { FilterControls, FilterField } from './Filters.js';

/** The filters in state, as in the Dashboard, reporting every change. */
function renderFilters(start: Filters = NO_FILTERS) {
  const changes: Filters[] = [];
  function Host() {
    const [filters, setFilters] = useState(start);
    return (
      <FilterControls
        filters={filters}
        onChange={(next) => {
          changes.push(next);
          setFilters(next);
        }}
      />
    );
  }
  render(<Host />);
  return { changes, last: () => changes.at(-1) };
}

const start = (text: string, chips: FilterChip[] = []): Filters => ({ text, chips: new Set(chips) });
const field = () => screen.getByRole('searchbox', { name: 'Filter sessions' });
const group = () => within(screen.getByRole('group', { name: 'Filters' }));
const chip = (name: string) => group().getByRole('button', { name });
const pressed = () => group().queryAllByRole('button', { pressed: true }).map((button) => button.textContent);

describe('the filter field', () => {
  it('is a search field in role="search", named "Filter sessions", with the placeholder', () => {
    renderFilters();

    expect(within(screen.getByRole('search')).getByRole('searchbox')).toBe(field());
    expect(field().getAttribute('placeholder')).toBe('Filter by session, title, repo or directory');
  });

  it('filters as you type', () => {
    const { last } = renderFilters();

    fireEvent.change(field(), { target: { value: 'export' } });
    expect(last()?.text).toBe('export');
  });

  it('shows Clear text once there is text, which clears it and keeps focus in the field', () => {
    renderFilters();
    expect(screen.queryByRole('button', { name: 'Clear text' })).toBeNull();

    fireEvent.change(field(), { target: { value: 'export' } });
    const clear = screen.getByRole('button', { name: 'Clear text' });
    expect(clear.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(clear);

    expect((field() as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(field());
    expect(screen.queryByRole('button', { name: 'Clear text' })).toBeNull();
  });

  describe('Escape', () => {
    /** Presses Escape in the field, and says what a listener on the document, as the session view's is, saw. */
    function escape(): { reachedDocument: boolean; defaultPrevented: boolean } {
      let seen: KeyboardEvent | undefined;
      const listener = (event: KeyboardEvent) => {
        seen = event;
      };
      document.addEventListener('keydown', listener);
      fireEvent.keyDown(field(), { key: 'Escape' });
      document.removeEventListener('keydown', listener);
      return { reachedDocument: seen !== undefined, defaultPrevented: seen?.defaultPrevented ?? false };
    }

    it('clears the text, and only the text, keeps focus in the field, and stops there: the session view stays open', () => {
      const { last } = renderFilters(start('export', ['background']));
      field().focus();

      const result = escape();

      expect((field() as HTMLInputElement).value).toBe('');
      expect(last()).toEqual(start('', ['background']));
      expect(document.activeElement).toBe(field());
      // The session view closes on Escape unless something has handled it.
      expect(result.defaultPrevented).toBe(true);
    });

    it('clears text that is only spaces too', () => {
      renderFilters(start('  '));
      field().focus();

      expect(escape().defaultPrevented).toBe(true);
      expect((field() as HTMLInputElement).value).toBe('');
    });

    it('leaves the field when it is empty, and lets Escape go on to close the session view', () => {
      const { changes } = renderFilters();
      field().focus();

      const result = escape();

      expect(document.activeElement).not.toBe(field());
      expect(changes).toEqual([]);
      expect(result).toEqual({ reachedDocument: true, defaultPrevented: false });
    });

    it('ignores other keys', () => {
      const onChange = vi.fn();
      render(<FilterField value="export" onChange={onChange} />);
      field().focus();

      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(onChange).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(field());
    });
  });
});

describe('the filter chips', () => {
  it('are toggle buttons in a group named "Filters", none pressed to start with', () => {
    renderFilters();

    expect(group().getAllByRole('button').map((button) => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([
      ['Interactive', 'false'],
      ['Background', 'false'],
    ]);
  });

  it('set aria-pressed as they turn on and off, and pass on which chips are on', () => {
    const { last } = renderFilters();

    fireEvent.click(chip('Interactive'));
    expect(chip('Interactive').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Background').getAttribute('aria-pressed')).toBe('false');
    expect(last()?.chips).toEqual(new Set(['interactive']));

    fireEvent.click(chip('Background'));
    expect(pressed()).toEqual(['Interactive', 'Background']);
    expect(last()?.chips).toEqual(new Set(['interactive', 'background']));

    fireEvent.click(chip('Interactive'));
    expect(chip('Interactive').getAttribute('aria-pressed')).toBe('false');
    expect(pressed()).toEqual(['Background']);
    expect(last()?.chips).toEqual(new Set(['background']));
  });

  it('keep the text as they toggle', () => {
    const { last } = renderFilters(start('export'));

    fireEvent.click(chip('Background'));
    expect(last()).toEqual(start('export', ['background']));
  });

  it('show a check icon only while on, hidden from assistive technology', () => {
    renderFilters(start('', ['background']));

    expect(chip('Background').querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(chip('Interactive').querySelector('svg')).toBeNull();
  });
});

describe('Clear filters', () => {
  const clear = () => screen.queryByRole('button', { name: 'Clear filters' });

  it('shows after the chips, in their group, while a chip is on or the field has text', () => {
    renderFilters();
    expect(clear()).toBeNull();

    fireEvent.click(chip('Interactive'));
    expect(group().getAllByRole('button').at(-1)).toBe(clear());

    fireEvent.click(chip('Interactive'));
    expect(clear()).toBeNull();
    fireEvent.change(field(), { target: { value: 'x' } });
    expect(clear()).not.toBeNull();
  });

  it('is a ghost sm icon button, named by its tooltip, with no text and its icon hidden (W91)', () => {
    renderFilters(start('', ['interactive']));
    const button = clear()!;

    expect(button.getAttribute('aria-label')).toBe('Clear filters');
    expect(button.textContent).toBe('');
    expect([...button.classList].sort()).toEqual(['ghost', 'icon-button', 'sm']);
    expect(button.querySelectorAll('svg')).toHaveLength(1);
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    // filter_alt_off, not cancel: that's the field's own Clear text, beside it while there's text.
    expect(button.querySelector('path')?.getAttribute('d')).toBe(ICON_PATHS['clear-filters'][16]);
    expect(ICON_PATHS['clear-filters'][16]).not.toBe(ICON_PATHS.clear[16]);
  });

  it('opens its tooltip on keyboard focus: the same text as its name, hidden from assistive technology', () => {
    renderFilters(start('', ['background']));

    act(() => clear()!.focus());
    const tip = [...document.querySelectorAll<HTMLElement>('[role="tooltip"]')].find((each) => !each.hidden);
    expect(tip?.textContent).toBe('Clear filters');
    expect(tip?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps its room while no filter is on: an unseen copy, aria-hidden, that is no button and takes no focus', () => {
    renderFilters();
    const chips = () => screen.getByRole('group', { name: 'Filters' });
    const room = () => chips().querySelector('.filter-clear-room');

    expect(room()?.tagName).toBe('SPAN');
    expect(room()?.getAttribute('aria-hidden')).toBe('true');
    expect(room()?.hasAttribute('tabindex')).toBe(false);
    expect(room()?.hasAttribute('aria-label')).toBe(false);
    expect(chips().lastElementChild).toBe(room());
    // A copy of the button: the same classes, so the same 24 px square, and the same icon.
    expect([...room()!.classList].sort()).toEqual(['filter-clear-room', 'ghost', 'icon-button', 'sm']);
    const roomIcon = room()!.querySelector('path')?.getAttribute('d');

    fireEvent.click(chip('Background'));
    expect(room()).toBeNull();
    expect(chips().lastElementChild).toBe(clear());
    expect(clear()!.querySelector('path')?.getAttribute('d')).toBe(roomIcon);
  });

  it('clears the text and every chip, and puts focus in the field', () => {
    const { last } = renderFilters(start('export', ['interactive', 'background']));

    fireEvent.click(clear()!);

    expect(last()).toEqual(NO_FILTERS);
    expect(pressed()).toEqual([]);
    expect((field() as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(field());
    expect(clear()).toBeNull();
  });
});
