// A session's flag toggle, "It doesn't need me" (W153): a ghost sm icon button with aria-pressed, on the
// row of a running session that needs you, named "Flag <session>: it doesn't need me" by its tooltip,
// whatever its state, as the Not needed now toggle is (NotNeededButton.tsx). Outlined while it isn't
// flagged, filled while it is. Pressing it flags the session, which leaves Needs you and is asked what
// it needs, or takes the flag away. It never selects or opens the session.

import { flagLabel } from '../flags.js';
import { Icon } from './Icon.js';
import { Tooltip } from './Tooltip.js';

export interface FlagButtonProps {
  sessionId: string;
  /** The session's name, as its row shows it. */
  name: string;
  /** Whether it's flagged, for what it needs now. */
  flagged: boolean;
  /** Called with the state it should have: true to flag it. */
  onChange: (on: boolean) => void;
  className?: string;
}

export function FlagButton({ sessionId, name, flagged, onChange, className }: FlagButtonProps) {
  return (
    <Tooltip content={flagLabel(name)} relation="label">
      <button
        type="button"
        className={['icon-button', 'ghost', 'sm', 'flag-toggle', className].filter(Boolean).join(' ')}
        aria-pressed={flagged}
        data-flag-session={sessionId}
        onClick={() => onChange(!flagged)}
      >
        <Icon name={flagged ? 'flag-on' : 'flag'} />
      </button>
    </Tooltip>
  );
}
