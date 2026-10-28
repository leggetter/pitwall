// A session's Not needed now toggle (docs/design-system.md, 4: Not needed now), W88: a ghost sm icon
// button with aria-pressed, on the row of a session that needs you, named "Mark <session> not needed
// now" by its tooltip, whatever its state, so its name says which session it marks and the pressed
// state says whether it's marked, as the star toggle does (StarButton.tsx). Outlined while it isn't,
// filled while it is. Pressing it marks the session, which leaves Needs you, or takes the mark away. It
// never selects or opens the session: a row's click opens the session only off its controls.

import { plainText } from '../format.js';
import { Icon } from './Icon.js';
import { Tooltip } from './Tooltip.js';

/** "Mark pitwall-test-app not needed now": the toggle's name and tooltip, in either state. */
export const notNeededLabel = (name: string) => `Mark ${plainText(name)} not needed now`;

export interface NotNeededButtonProps {
  sessionId: string;
  /** The session's name, as its row shows it. */
  name: string;
  /** Whether it's marked not needed now, for what it needs now. */
  marked: boolean;
  /** Called with the state it should have: true to mark it. */
  onChange: (on: boolean) => void;
  className?: string;
}

export function NotNeededButton({ sessionId, name, marked, onChange, className }: NotNeededButtonProps) {
  return (
    <Tooltip content={notNeededLabel(name)} relation="label">
      <button
        type="button"
        className={['icon-button', 'ghost', 'sm', 'not-needed-toggle', className].filter(Boolean).join(' ')}
        aria-pressed={marked}
        data-not-needed-session={sessionId}
        onClick={() => onChange(!marked)}
      >
        <Icon name={marked ? 'not-needed-on' : 'not-needed'} />
      </button>
    </Tooltip>
  );
}
