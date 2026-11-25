// A spin-off block in the Conversation tab (W209): the session's view says what a block's card does,
// through this context, and the Markdown renderer asks it for the card. Without it, as in the
// supervisor's conversation and a sub-agent's transcript, a block stays a code block.
import { createContext, type ReactNode } from 'react';
import type { SpinOff } from '../../src/shared/protocol.js';

/** A block the server read in an assistant message (ConversationEntry.spinOffs). */
export type FoundBlock = { spinOff: SpinOff; lines: number };

export interface SpinOffBlockHost {
  /** The card for a readable block. */
  card: (spinOff: Extract<SpinOff, { kind: 'proposal' }>) => ReactNode;
}

export const SpinOffBlockContext = createContext<SpinOffBlockHost | undefined>(undefined);

/** The class every card in the Conversation tab has, which `spinoff=latest` scrolls to the newest of. */
export const SPIN_OFF_BLOCK_CLASS = 'spin-off-block';
