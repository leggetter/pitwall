// A collapsed column's rail (W224, docs/ui-map.md: Column rail): a narrow strip where the repo list or the
// session list was, with one button that opens that column again on its own, and the column's name set
// sideways so it's clear what's folded away.

import { Icon } from './Icon.js';
import { Tooltip } from './Tooltip.js';

export interface PaneRailProps {
  column: 'repos' | 'list';
  onOpen: () => void;
}

const TEXT = {
  repos: { label: 'Show the repo list', name: 'Repos' },
  list: { label: 'Show the session list', name: 'Sessions' },
} as const;

export function PaneRail({ column, onOpen }: PaneRailProps) {
  const { label, name } = TEXT[column];
  return (
    <div className="pane-rail" data-rail={column}>
      <Tooltip content={label} relation="label">
        <button type="button" className="icon-button ghost md" aria-expanded={false} data-open-rail={column} onClick={onOpen}>
          <Icon name="expand" />
        </button>
      </Tooltip>
      <span className="pane-rail-name" aria-hidden="true">
        {name}
      </span>
    </div>
  );
}
