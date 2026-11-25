// A spin-off block in a session's Conversation tab (W209; docs/design-system.md, 4: Spin-off proposals):
// the card in place of the code block. Folder, name, the whole prompt and Start, which asks the server to
// find the block in the session's transcript and check it (checkSpinOff(…, 'conversation')), then hands
// what it checked to New session, as Needs you's Start does. The block is the session's text, so it's
// shown as text in <bdi>, never markdown, each character that wouldn't show as itself as its code.
//
// - Start only, for a hand-off too (W168): Clear and continue types into the job, so it stays on Needs
//   you's card, while the proposal is current.
// - A proposal W212 settled (`settled` on the snapshot, for the session's current one) says "Started as
//   <name>", linked to that session when pitwall knows it, in place of Start; a dismissed one says it was
//   dismissed from Needs you, and can still be started from here. An older block has no settled state.

import { useContext, useId, useState } from 'react';
import { visibleParts, visibleString } from '../../../src/shared/hiddenText.js';
import type { SpinOff, SpinOffSettled } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { plainText } from '../format.js';
import { SPIN_OFF_BLOCK_CLASS } from '../spinOffBlock.js';
import { checkSpinOff, handoffTitle, isHandoffProposal, SPIN_OFF_HANDOFF_START_NOTE, SPIN_OFF_NOTE, spinOffTitle } from '../spinOff.js';
import { typedPromptNotes } from '../supervisor.js';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import { Alert } from './Alert.js';
import { ExactText, hiddenNote, lengthNote } from './ApprovalCards.js';
import { Button } from './Button.js';
import { ScrollBox, useOverflowing } from './ScrollBox.js';
import type { CheckedSpinOff } from './SpinOffCards.js';
import '../supervisor.css';
import './SpinOffCards.css';

export interface SpinOffBlockCardProps {
  session: Pick<SessionSummary, 'sessionId' | 'name'>;
  spinOff: Extract<SpinOff, { kind: 'proposal' }>;
  settled?: SpinOffSettled | undefined;
  onStart: (checked: CheckedSpinOff) => void;
  onOpenSession?: ((sessionId: string) => void) | undefined;
}

export function SpinOffBlockCard({ session, spinOff, settled, onStart, onOpenSession }: SpinOffBlockCardProps) {
  const api = useContext(ApiContext);
  const ids = { heading: useId(), notes: useId() };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [box, setBox] = useState<HTMLElement | null>(null);
  const overflowing = useOverflowing(box);
  const from = plainText(session.name);
  const handoff = isHandoffProposal(session, spinOff);
  const parts = visibleParts(spinOff.prompt);
  const notes = [overflowing ? lengthNote(spinOff.prompt) : undefined, hiddenNote(parts), ...typedPromptNotes(spinOff.prompt)].filter((note) => note !== undefined);

  const start = async () => {
    if (busy || !api) return;
    setBusy(true);
    setError(undefined);
    const outcome = await checkSpinOff(api, session.sessionId, spinOff.key, 'conversation');
    setBusy(false);
    if (outcome.kind === 'failed') {
      setError(outcome.error);
      return;
    }
    onStart({ sessionId: session.sessionId, key: spinOff.key, from, cwd: outcome.cwd, prompt: outcome.prompt, ...(handoff ? { handoff: true } : {}), ...(outcome.name === undefined ? {} : { name: outcome.name }) });
  };

  const startedName = settled?.how === 'started' ? (settled.name === undefined ? 'a new session' : plainText(settled.name)) : undefined;
  return (
    <div className={`approval-card spin-off-card ${SPIN_OFF_BLOCK_CLASS}`} role="group" aria-labelledby={ids.heading} aria-busy={busy || undefined} data-key={spinOff.key}>
      <h4 className="approval-title" id={ids.heading}>
        <bdi>{handoff ? handoffTitle(from) : spinOffTitle(from)}</bdi>
      </h4>
      <p className="approval-note">{handoff ? SPIN_OFF_HANDOFF_START_NOTE : SPIN_OFF_NOTE}</p>
      <p className="approval-where">
        In <bdi className="approval-folder">{visibleString(spinOff.folder)}</bdi>
        {spinOff.name !== undefined && (
          <>
            , named <bdi className="approval-folder">{visibleString(spinOff.name)}</bdi>
          </>
        )}
        .
      </p>
      <div className="approval-body">
        <p className="approval-label">First prompt</p>
        <ScrollBox ref={setBox} as="p" className="approval-text" label="First prompt" aria-describedby={notes.length > 0 ? ids.notes : undefined}>
          <bdi>
            <ExactText parts={parts} />
          </bdi>
        </ScrollBox>
        {notes.length > 0 && (
          <p className="approval-length" id={ids.notes}>
            {notes.join(' ')}
          </p>
        )}
      </div>
      {error !== undefined && (
        <Alert tone="danger" role="alert" className="approval-error">
          {error}
        </Alert>
      )}
      {settled?.how === 'dismissed' && <p className="approval-note spin-off-block-settled">Dismissed from Needs you. You can still start it here.</p>}
      <div className="approval-actions">
        {startedName !== undefined ? (
          <p className="approval-note spin-off-block-settled" role="status">
            Started as{' '}
            {settled?.sessionId !== undefined && onOpenSession ? (
              <button type="button" className="link-button" data-open-started={settled.sessionId} onClick={() => onOpenSession(settled.sessionId!)}>
                <bdi>{startedName}</bdi>
              </button>
            ) : (
              <bdi>{startedName}</bdi>
            )}
          </p>
        ) : (
          <Button variant="primary" size="sm" icon="add" busy={busy} busyLabel="Checking…" onClick={() => void start()}>
            {handoff ? 'Start new session…' : 'Start…'}
          </Button>
        )}
      </div>
    </div>
  );
}
