// The app strip (docs/design-system.md, 3: App strip and page alerts, and 4: Alerts and banners): a
// 32 px band above the header for a state that affects the whole app and outlasts a dismissed alert.
// Today there's one: the relay is off until pitwall restarts, which the snapshot's relayOff says. It
// inverts with the theme, --pw-text-inverse on --pw-text, so it never uses a tone colour, and it
// can't be dismissed. Details reopens the relay alert.

import type { RelayOff } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import { Icon } from './Icon.js';

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
      {/* One line: a sentence too long for it ends in an ellipsis, and the browser's hover text has it all (until W25's tooltips). */}
      <p className="app-strip-text" title={relayOffText(off)}>
        {relayOffText(off)}
      </p>
      {onDetails && (
        <button type="button" className="link-button app-strip-link" onClick={onDetails}>
          Details
        </button>
      )}
    </div>
  );
}
