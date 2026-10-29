// The app strip (docs/design-system.md, 3: App strip and page alerts, and 4: Alerts and banners): a
// 32 px band above the header for a state that affects the whole app and outlasts a dismissed alert.
// Two states have one, each a line of its own, stacked in this order when both hold:
// - the relay is off until pitwall restarts, which the snapshot's relayOff says, with Details, which
//   reopens the relay alert;
// - recaps aren't being made (M5, W111): the day's budget is spent, or the latest call failed, which
//   the snapshot's `recaps` says (recapsStripText()). Nothing while they're fine or off.
// It inverts with the theme, --pw-text-inverse on --pw-text, so it never uses a tone colour, and it
// can't be dismissed. Neither line is a live region: a snapshot that changes one announces nothing.

import type { RecapHealth, RelayOff } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import { budgetSpent, recapsStripText } from '../recap.js';
import { Icon } from './Icon.js';
import { Tooltip } from './Tooltip.js';

/** The strip's sentence: what's off, what brings it back, and pitwall's reason, which never holds message text. */
export function relayOffText(off: RelayOff): string {
  return `Messaging is off until you restart pitwall: ${plainText(off.reason)}`;
}

export interface AppStripProps {
  off: RelayOff;
  /** Reopens the relay alert. Left out when there's no alert to show. */
  onDetails?: (() => void) | undefined;
}

export function AppStrip({ off, onDetails }: AppStripProps) {
  return (
    <div className="app-strip">
      <Icon name="warning" />
      {/* One line: a sentence too long for it ends in an ellipsis, with the whole of it in a tooltip. Details has it too. */}
      <Tooltip content={relayOffText(off)} relation="none" onlyIfCut>
        <p className="app-strip-text">{relayOffText(off)}</p>
      </Tooltip>
      {onDetails && (
        <button type="button" className="link-button app-strip-link" onClick={onDetails}>
          Details
        </button>
      )}
    </div>
  );
}

/** The recaps line (W111): nothing while recaps are fine or off. */
export function RecapsStrip({ health }: { health: RecapHealth | undefined }) {
  const text = recapsStripText(health);
  if (text === undefined) return null;
  return (
    <div className="app-strip" data-strip="recaps">
      {/* The budget is a limit reached, not a fault: info. A failed call is a warning. */}
      <Icon name={budgetSpent(health) ? 'info' : 'warning'} />
      <Tooltip content={text} relation="none" onlyIfCut>
        <p className="app-strip-text">{text}</p>
      </Tooltip>
    </div>
  );
}

export interface AppStripsProps {
  relayOff: RelayOff | undefined;
  onRelayDetails?: (() => void) | undefined;
  recaps: RecapHealth | undefined;
}

/** Every line the app strip has now, in the strip's grid area, or nothing when there's none. */
export function AppStrips({ relayOff, onRelayDetails, recaps }: AppStripsProps) {
  const recapsShown = recapsStripText(recaps) !== undefined;
  if (!relayOff && !recapsShown) return null;
  return (
    <div className="app-strips">
      {relayOff && <AppStrip off={relayOff} onDetails={onRelayDetails} />}
      {recapsShown && <RecapsStrip health={recaps} />}
    </div>
  );
}
