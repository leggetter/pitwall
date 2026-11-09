// A session's snooze control (W154), on the row of a session that needs you, under its flag toggle.
// Named "Snooze <session>" by its tooltip, whatever its state, as the flag toggle is (FlagButton.tsx).
// While it isn't snoozed, it's a menu button (Menu.tsx) whose menu has the choices: for 1 hour, for 3
// hours, until tomorrow or Monday at 9:00, or Later, until it's woken. While it is, it's a toggle
// button with aria-pressed, filled, and pressing it takes the snooze off. It never selects or opens
// the session.

import { SNOOZE_CHOICES, snoozeLabel } from '../snooze.js';
import { Icon } from './Icon.js';
import { MenuButton } from './Menu.js';
import { Tooltip } from './Tooltip.js';

export interface SnoozeButtonProps {
  sessionId: string;
  /** The session's name, as its row shows it. */
  name: string;
  snoozed: boolean;
  /** A choice from the menu: snooze it until then, or Later without one. */
  onSnooze: (until: Date | undefined) => void;
  /** The pressed toggle: take the snooze off. */
  onWake: () => void;
  className?: string;
}

export function SnoozeButton({ sessionId, name, snoozed, onSnooze, onWake, className }: SnoozeButtonProps) {
  const label = snoozeLabel(name);
  if (snoozed) {
    return (
      <Tooltip content={label} relation="label">
        <button
          type="button"
          className={['icon-button', 'ghost', 'sm', 'snooze-toggle', className].filter(Boolean).join(' ')}
          aria-pressed={true}
          data-snooze-session={sessionId}
          onClick={onWake}
        >
          <Icon name="snooze-on" />
        </button>
      </Tooltip>
    );
  }
  return (
    <MenuButton
      label={label}
      icon="snooze"
      size="sm"
      className={['snooze-menu', className].filter(Boolean).join(' ')}
      buttonData={{ 'data-snooze-session': sessionId }}
      entries={SNOOZE_CHOICES.map((choice) => ({ id: choice.id, label: choice.label, onSelect: () => onSnooze(choice.until(new Date())) }))}
    />
  );
}
