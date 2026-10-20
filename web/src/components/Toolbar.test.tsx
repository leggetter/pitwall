// The toolbar (docs/design-system.md, 3 and 4): the filter field, the filter chips, Clear filters and
// the summary, rendered on their own with filters the test holds.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { NO_FILTERS, type FilterChip, type Filters } from '../sessions.js';
import { FilterField, Summary, Toolbar } from './Toolbar.js';

/** A toolbar whose filters live in state, as in the Dashboard, reporting every change. */
function renderToolbar(start: Filters = NO_FILTERS, attention = 2) {
  const changes: Filters[] = [];
  function Host() {
    const [filters, setFilters] = useState(start);
    return (
      <Toolbar
        filters={filters}
        onChange={(next) => {
          changes.push(next);
          setFilters(next);
        }}
        total={12}
        attention={attention}
      />
    );
  }
  render(<Host />);
  return { changes, last: () => changes.at(-1) };
}

const field = () => screen.getByRole('searchbox', { name: 'Filter sessions' });
const chip = (name: string | RegExp) => within(screen.getByRole('group', { name: 'Filters' })).getByRole('button', { name });
const pressed = () =>
  within(screen.getByRole('group', { name: 'Filters' }))
    .queryAllByRole('button', { pressed: true })
    .map((button) => button.textContent);

describe('the filter field', () => {
  it('is a search field in role="search", named "Filter sessions", with the placeholder', () => {
    renderToolbar();

    expect(within(screen.getByRole('search')).getByRole('searchbox')).toBe(field());
    expect(field().getAttribute('placeholder')).toBe('Filter by session, title, repo or directory');
  });

  it('filters as you type', () => {
    const { last } = renderToolbar();

    fireEvent.change(field(), { target: { value: 'export' } });
    expect(last()?.text).toBe('export');
  });

  it('shows a clear button once there is text, which clears it and keeps focus in the field', () => {
    renderToolbar();
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();

    fireEvent.change(field(), { target: { value: 'export' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));

    expect((field() as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(field());
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull();
  });

  describe('Escape', () => {
    /** Presses Escape in the field, and says whether it reached a listener on the document, as the session view's is. */
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

    it('clears the text, keeps focus in the field, and stops there: the session view stays open', () => {
      const { last } = renderToolbar({ text: 'export', chips: new Set(['finished']) });
      field().focus();

      const result = escape();

      expect((field() as HTMLInputElement).value).toBe('');
      expect(last()).toEqual({ text: '', chips: new Set(['finished']) });
      expect(document.activeElement).toBe(field());
      // The session view closes on Escape unless it's been handled.
      expect(result.defaultPrevented).toBe(true);
    });

    it('clears text that is only spaces too', () => {
      renderToolbar({ text: '  ', chips: new Set() });
      field().focus();

      expect(escape().defaultPrevented).toBe(true);
      expect((field() as HTMLInputElement).value).toBe('');
    });

    it('leaves the field when it is empty, and lets Escape go on to close the session view', () => {
      const { changes } = renderToolbar();
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
    renderToolbar();

    const buttons = within(screen.getByRole('group', { name: 'Filters' })).getAllByRole('button');
    expect(buttons.map((button) => [button.textContent, button.getAttribute('aria-pressed')])).toEqual([
      ['Needs you 2', 'false'],
      ['Interactive', 'false'],
      ['Background', 'false'],
      ['Finished', 'false'],
    ]);
  });

  it('set aria-pressed as they turn on and off, and pass on which chips are on', () => {
    const { last } = renderToolbar();

    fireEvent.click(chip(/^Needs you/));
    fireEvent.click(chip('Background'));
    expect(pressed()).toEqual(['Needs you 2', 'Background']);
    expect(chip(/^Needs you/).getAttribute('aria-pressed')).toBe('true');
    expect(chip('Interactive').getAttribute('aria-pressed')).toBe('false');
    expect(last()?.chips).toEqual(new Set<FilterChip>(['needsYou', 'background']));

    fireEvent.click(chip(/^Needs you/));
    expect(chip(/^Needs you/).getAttribute('aria-pressed')).toBe('false');
    expect(pressed()).toEqual(['Background']);
    expect(last()?.chips).toEqual(new Set<FilterChip>(['background']));
  });

  it('show a check icon only while on, hidden from assistive technology', () => {
    renderToolbar({ text: '', chips: new Set(['finished']) });

    expect(chip('Finished').querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(chip('Interactive').querySelector('svg')).toBeNull();
  });

  it('count the sessions that need you on the Needs you chip, and only when there are some', () => {
    renderToolbar(NO_FILTERS, 0);

    expect(chip('Needs you').textContent).toBe('Needs you');
  });
});

describe('Clear filters', () => {
  const clear = () => screen.queryByRole('button', { name: 'Clear filters' });

  it('shows after the chips while a chip is on or the field has text', () => {
    renderToolbar();
    expect(clear()).toBeNull();

    fireEvent.click(chip('Interactive'));
    const group = within(screen.getByRole('group', { name: 'Filters' })).getAllByRole('button');
    expect(group.at(-1)).toBe(clear());

    fireEvent.click(chip('Interactive'));
    expect(clear()).toBeNull();
    fireEvent.change(field(), { target: { value: 'x' } });
    expect(clear()).not.toBeNull();
  });

  it('clears the text and every chip, and puts focus in the field', () => {
    const { last } = renderToolbar({ text: 'export', chips: new Set(['needsYou', 'interactive']) });

    fireEvent.click(clear()!);

    expect(last()).toEqual(NO_FILTERS);
    expect(pressed()).toEqual([]);
    expect((field() as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(field());
    expect(clear()).toBeNull();
  });
});

describe('the summary', () => {
  it('counts the sessions, then a solid "need you" badge when any need you', () => {
    const { container } = render(<Summary total={12} attention={2} />);

    expect(container.textContent).toBe('12 sessions2 need you');
    const badge = screen.getByText('2 need you');
    expect(badge.className).toBe('badge badge-attention');
    expect(screen.queryByText('Nothing needs you')).toBeNull();
  });

  it('says "Nothing needs you" in plain text when nothing does', () => {
    const { container } = render(<Summary total={1} attention={0} />);

    expect(container.textContent).toBe('1 session·Nothing needs you');
    expect(screen.getByText('Nothing needs you').className).toBe('summary-calm');
    expect(container.querySelector('.badge')).toBeNull();
    // The dot only separates the two on screen.
    expect(screen.getByText('·').getAttribute('aria-hidden')).toBe('true');
  });

  it('handles one session needing you', () => {
    render(<Summary total={3} attention={1} />);

    expect(screen.getByText('1 needs you')).toBeTruthy();
  });
});
