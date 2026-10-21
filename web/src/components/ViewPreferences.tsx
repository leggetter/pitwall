// The header's View preferences menu (docs/design-system.md, 3: Header, and 4: View preferences), W42:
// a ghost md `preferences` icon button named "View preferences", opening a menu with one radio group,
// Group sessions by: Main repo, Where it started, or Every repo it worked in, each with one line
// saying what it does. It's MenuButton's: opening focuses the chosen mode, ↑ and ↓ move through the
// three, Enter, Space or a click chooses one and closes the menu with focus back on the button, and
// Escape or Tab closes it. The choice is the Dashboard's, kept in pitwall.group-by.v1 (groupBy.ts).

import { GROUP_BY_DESCRIPTIONS, GROUP_BY_LABELS, GROUP_BY_MODES, GROUP_BY_TITLE, isGroupBy, type GroupBy } from '../groupBy.js';
import { MenuButton, type MenuEntry } from './Menu.js';

export const VIEW_PREFERENCES_LABEL = 'View preferences';

export interface ViewPreferencesProps {
  groupBy: GroupBy;
  onGroupBy: (mode: GroupBy) => void;
}

export function ViewPreferences({ groupBy, onGroupBy }: ViewPreferencesProps) {
  const entries: MenuEntry[] = [
    {
      kind: 'radio-group',
      id: 'group-by',
      title: GROUP_BY_TITLE,
      value: groupBy,
      options: GROUP_BY_MODES.map((mode) => ({ value: mode, label: GROUP_BY_LABELS[mode], description: GROUP_BY_DESCRIPTIONS[mode] })),
      onChange: (value) => {
        if (isGroupBy(value)) onGroupBy(value);
      },
    },
  ];
  return <MenuButton label={VIEW_PREFERENCES_LABEL} icon="preferences" entries={entries} />;
}
