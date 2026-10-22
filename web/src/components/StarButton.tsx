// A session's star toggle (docs/design-system.md, 4: Starred sessions), W53: a ghost icon button with
// aria-pressed, named "Star <session>" by its tooltip, whatever its state, so its name says which
// session it stars and the pressed state says whether it's starred. Outlined while it isn't, filled
// while it is. sm at the end of a row's line 1, md in the session view's header, before the actions
// menu. It stars and unstars, and never selects or opens the session: a row's click opens the session
// only off its controls.

import { plainText } from '../format.js';
import { useShortcuts } from '../shortcuts.js';
import { Icon } from './Icon.js';
import { Tooltip } from './Tooltip.js';

/** "Star pitwall-test-app": the toggle's name and tooltip, in either state. */
export const starLabel = (name: string) => `Star ${plainText(name)}`;

export interface StarButtonProps {
  sessionId: string;
  /** The session's name, as its row shows it. */
  name: string;
  starred: boolean;
  /** Called with the state it should have: true to star. */
  onStar: (sessionId: string, on: boolean) => void;
  size: 'sm' | 'md';
  className?: string;
  /** The single-key shortcut that presses it, as its key cap and in aria-keyshortcuts while the shortcuts are on: the session view's `s`. */
  shortcut?: { keys: readonly string[]; label: string } | undefined;
}

export function StarButton({ sessionId, name, starred, onStar, size, className, shortcut }: StarButtonProps) {
  const shortcuts = useShortcuts();
  const keyShortcut = shortcut && shortcuts.on ? shortcut.keys.join('+') : undefined;
  return (
    <Tooltip content={starLabel(name)} keys={shortcut} relation="label">
      <button
        type="button"
        className={['icon-button', 'ghost', size, 'star-toggle', className].filter(Boolean).join(' ')}
        aria-pressed={starred}
        aria-keyshortcuts={keyShortcut}
        data-star-session={sessionId}
        onClick={() => onStar(sessionId, !starred)}
      >
        <Icon name={starred ? 'starred' : 'star'} />
      </button>
    </Tooltip>
  );
}
