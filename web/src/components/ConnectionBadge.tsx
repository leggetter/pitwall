// The header's connection badge. Its restyle to the design system's badge is W23; until then it's a
// dot and a label, as it was in the masthead.

import type { ConnectionState } from '../connection.js';

const STATE_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  unauthorized: 'Token rejected',
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  return (
    <span className={`connection state-${state}`} role="status">
      <span className="dot" aria-hidden="true" />
      {STATE_LABELS[state]}
    </span>
  );
}
