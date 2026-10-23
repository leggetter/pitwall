// The header's View preferences menu (docs/design-system.md, 3: Header, and 4: View preferences), W42:
// a ghost md `preferences` icon button named "View preferences", opening a menu with two radio groups.
// Group sessions by: Main repo, Where it started, or Every repo it worked in (W42). Then, after a
// separator, Open running background sessions on: Terminal or Conversation (W54). Each option has one
// line saying what it does. It's MenuButton's: opening focuses the chosen grouping, ↑ and ↓ move
// through all five, Enter, Space or a click chooses one and closes the menu with focus back on the
// button, and Escape or Tab closes it. The choices are the Dashboard's, kept in pitwall.group-by.v1
// (groupBy.ts) and pitwall.background-tab.v1 (backgroundTab.ts).

import {
  BACKGROUND_TAB_DESCRIPTIONS,
  BACKGROUND_TAB_LABELS,
  BACKGROUND_TAB_TITLE,
  BACKGROUND_TABS,
  isBackgroundTab,
  type BackgroundTab,
} from '../backgroundTab.js';
import { GROUP_BY_DESCRIPTIONS, GROUP_BY_LABELS, GROUP_BY_MODES, GROUP_BY_TITLE, isGroupBy, type GroupBy } from '../groupBy.js';
import { MenuButton, type MenuEntry } from './Menu.js';

export const VIEW_PREFERENCES_LABEL = 'View preferences';

export interface ViewPreferencesProps {
  groupBy: GroupBy;
  onGroupBy: (mode: GroupBy) => void;
  /** The tab a running background session's view opens on (W54). */
  backgroundTab: BackgroundTab;
  onBackgroundTab: (tab: BackgroundTab) => void;
}

export function ViewPreferences({ groupBy, onGroupBy, backgroundTab, onBackgroundTab }: ViewPreferencesProps) {
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
    { kind: 'separator', id: 'background-tab-separator' },
    {
      kind: 'radio-group',
      id: 'background-tab',
      title: BACKGROUND_TAB_TITLE,
      value: backgroundTab,
      options: BACKGROUND_TABS.map((tab) => ({ value: tab, label: BACKGROUND_TAB_LABELS[tab], description: BACKGROUND_TAB_DESCRIPTIONS[tab] })),
      onChange: (value) => {
        if (isBackgroundTab(value)) onBackgroundTab(value);
      },
    },
  ];
  return <MenuButton label={VIEW_PREFERENCES_LABEL} icon="preferences" entries={entries} />;
}
