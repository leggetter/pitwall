// New session's Directory in tests (W147): from a view, + New session opens with no directory
// chosen, so a test that starts a session from one chooses the first, as a person would.

import { fireEvent, within } from '@testing-library/react';

/** Chooses Directory's first option when the dialog opened with none chosen; leaves a chosen one alone. */
export function chooseFirstDirectory(dialog: HTMLElement): void {
  const input = within(dialog).getByRole('combobox', { name: 'Directory' }) as HTMLInputElement;
  if (input.value !== '') return;
  fireEvent.click(input);
  const option = within(within(dialog).getByRole('listbox', { name: 'Directories', hidden: true })).getAllByRole('option', { hidden: true })[0];
  if (option === undefined) throw new Error('Directory offers no directory to choose.');
  fireEvent.mouseDown(option);
  fireEvent.click(option);
}
