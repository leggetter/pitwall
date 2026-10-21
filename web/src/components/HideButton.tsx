// Hide from repo list, or Show in repo list for a group that's hidden (docs/design-system.md, 3:
// Session list, W35): a ghost sm icon button at the end of the session list's heading line, while the
// selection is a group, a git repo or a directory, the root's own included. One click, either way,
// and the toast says where the group went. It stays the same button as its name changes, so focus
// stays on it. Its tooltip is its name (6.1, item 5).

import { Icon } from './Icon.js';
import { Tooltip } from './Tooltip.js';

export const HIDE_LABEL = 'Hide from repo list';
export const SHOW_LABEL = 'Show in repo list';

export interface HideButtonProps {
  /** Whether the selected group is hidden: the button shows it again. */
  hidden: boolean;
  onClick: () => void;
}

export function HideButton({ hidden, onClick }: HideButtonProps) {
  return (
    <Tooltip content={hidden ? SHOW_LABEL : HIDE_LABEL} relation="label">
      <button type="button" className="icon-button ghost sm session-list-hide" onClick={onClick}>
        <Icon name={hidden ? 'show' : 'hide'} />
      </button>
    </Tooltip>
  );
}
