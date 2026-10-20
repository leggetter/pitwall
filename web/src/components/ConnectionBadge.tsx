// The header's connection badge (docs/design-system.md, 4: Connection badge): subtle, in the tone of
// the connection's state, with a spinner while it's on its way and a dot once it's live. It's
// role="status", so a change is announced.

import type { ConnectionState } from '../connection.js';
import type { BadgeLook } from '../sessions.js';
import { Badge, type BadgeProps } from './Badge.js';

const STATES: Record<ConnectionState, { label: string; look: BadgeLook; lead?: BadgeProps['lead'] }> = {
  connecting: { label: 'Connecting…', look: 'subtle-neutral', lead: 'spinner' },
  live: { label: 'Live', look: 'subtle-success', lead: 'dot' },
  reconnecting: { label: 'Reconnecting…', look: 'subtle-warning', lead: 'spinner' },
  unauthorized: { label: 'Token rejected', look: 'subtle-danger' },
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  const { label, look, lead } = STATES[state];
  return (
    <span className="connection" data-state={state} role="status">
      <Badge look={look} lead={lead}>
        {label}
      </Badge>
    </span>
  );
}
