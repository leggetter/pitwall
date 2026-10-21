// The header's root tabs (docs/design-system.md, 3: Header, and 4: Tabs), W38: with two or more
// roots, a tab for each, in the order pitwall was given them, in place of the roots' path. Each is
// labelled with its path, home as ~, cut in the middle when there's no room, with the full path in a
// tooltip. A tab that isn't open carries its root's need-you badge whenever any of its sessions need
// you, so nothing that needs you is out of sight; the open tab has none, since its
// repo list's Needs you says the same just below.
//
// A tablist, one Tab stop: ← and → move focus between the tabs, wrapping, and Home and End jump to the
// ends; Enter, Space or a click opens one, never focus alone (tabs.ts). Focus stays on the tab it
// opened. The tabs control one tab panel, the columns, which the open tab names.

import { useRef, type KeyboardEvent } from 'react';
import { plainText, shortenHome } from '../format.js';
import { moveTabFocus } from '../tabs.js';
import { MiddleEllipsis } from './MiddleEllipsis.js';
import { Tooltip } from './Tooltip.js';

export interface RootTab {
  /** The root's path, as the snapshot has it. */
  root: string;
  /** How many of its sessions need you. */
  attention: number;
}

export interface RootTabsProps {
  tabs: readonly RootTab[];
  /** The open tab's root. */
  active: string;
  onSelect: (root: string) => void;
  /** The tab panel every tab controls: the columns. None in the #uikit gallery, which has no columns under its headers. */
  panelId?: string | undefined;
  /** Each tab's id, so the panel can be named by the open one. */
  tabId: (root: string) => string;
}

export function RootTabs({ tabs, active, onSelect, panelId, tabId }: RootTabsProps) {
  const list = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) =>
    moveTabFocus(event, [...(list.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])]);
  return (
    <div ref={list} className="root-tabs" role="tablist" aria-label="Roots" onKeyDown={onKeyDown}>
      {tabs.map(({ root, attention }) => {
        const open = root === active;
        const label = plainText(shortenHome(root));
        return (
          // The full path, home and all; on screen, home is ~ and the middle may be cut.
          <Tooltip key={root} content={plainText(root)} relation="description">
            <button
              type="button"
              role="tab"
              id={tabId(root)}
              className="root-tab"
              aria-selected={open}
              aria-controls={panelId}
              tabIndex={open ? 0 : -1}
              onClick={() => onSelect(root)}
            >
              <MiddleEllipsis text={label} className="root-tab-label" />
              {!open && attention > 0 && (
                <span className="badge badge-attention">
                  <span className="visually-hidden">, </span>
                  {attention}
                  <span className="visually-hidden"> {attention === 1 ? 'needs' : 'need'} you</span>
                </span>
              )}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
