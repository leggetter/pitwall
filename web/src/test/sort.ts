// The Sort menu button (SortMenu.tsx, W106's review), driven as a reader would: open it, choose an
// order in its radio group. Shared by the tests of the lists that sort.

import { fireEvent, screen } from '@testing-library/react';

/** The filter bar's Sort button. */
export const sortButton = (): HTMLElement => screen.getByRole('button', { name: 'Sort' });

/** Opens the Sort menu and chooses an order by its label: "Urgency", "Recent" or "Name". */
export function chooseSort(label: string): void {
  fireEvent.click(sortButton());
  fireEvent.click(screen.getByRole('menuitemradio', { name: label }));
}

/** The orders in the Sort menu, and the chosen one, from a look at it, opened and closed again. */
export function sortMenu(): { options: string[]; chosen: string | undefined } {
  fireEvent.click(sortButton());
  const items = screen.getAllByRole('menuitemradio');
  const result = { options: items.map((item) => item.textContent ?? ''), chosen: items.find((item) => item.getAttribute('aria-checked') === 'true')?.textContent ?? undefined };
  fireEvent.click(sortButton());
  return result;
}
