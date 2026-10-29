// The session list's Sort setting (docs/design-system.md, 3: Session list, and 4: Menus): a ghost sm
// menu button, "Sort", with the `sort` icon, whose menu is a radio group of Urgency, Recent and Name,
// the chosen one checked. It was a native select with a visible "Sort" label until W106's review: the
// third filter chip, Has PR, left the chips and that 131 px select no line to share in a 440 px list,
// as W91's text Clear filters once had, and as an icon it takes 24 px. Its name is its tooltip, as
// every icon button's is, and the menu's keys are the Menu pattern's.

import { SORT_LABELS, SORT_ORDERS, type SortOrder } from '../sessions.js';
import { MenuButton, type MenuEntry } from './Menu.js';

/** Its name and tooltip, and its menu's name. */
export const SORT_LABEL = 'Sort';

/** The radio group's title, above the orders. */
export const SORT_TITLE = 'Sort by';

export interface SortMenuProps {
  value: SortOrder;
  onChange: (order: SortOrder) => void;
}

export function SortMenu({ value, onChange }: SortMenuProps) {
  const entries: MenuEntry[] = [
    {
      kind: 'radio-group',
      id: 'sort',
      title: SORT_TITLE,
      options: SORT_ORDERS.map((order) => ({ value: order, label: SORT_LABELS[order] })),
      value,
      onChange: (chosen) => {
        const order = SORT_ORDERS.find((each) => each === chosen);
        if (order) onChange(order);
      },
    },
  ];
  return (
    <div className="sort">
      <MenuButton label={SORT_LABEL} icon="sort" size="sm" entries={entries} />
    </div>
  );
}
