// Spin-off proposals in Needs you (W163; spinOff.ts; docs/design-system.md, 4: Spin-off proposals):
// a card for each new session a session proposes, over Needs you's rows, newest first. The card names
// the session that asked, and shows the folder, the name and the whole prompt as text in <bdi>, never
// markdown, since it's the session's and untrusted: drawn as the supervisor's drafts are
// (ApprovalCards.tsx), each character that wouldn't show as itself as its code, though the index
// already refuses those.
//
// - Start asks the server to check the proposal (checkSpinOff()), then hands what it checked to the
//   caller, which opens New session filled in. A refusal is an inline alert on the card, the server's
//   reason as text. Open session opens the session that asked; Dismiss takes the card away.
// - A proposal pitwall couldn't read says why, in pitwall's words, with Open session and Dismiss.
// - A list with headings: a region named "Proposed sessions", a <ul>, each card an <li> named by its <h4>.

import { useContext, useId, useState } from 'react';
import { visibleParts, visibleString } from '../../../src/shared/hiddenText.js';
import { ApiContext } from '../api.js';
import { plainText } from '../format.js';
import { checkSpinOff, SPIN_OFF_NOTE, SPIN_OFF_UNREADABLE, SPIN_OFF_UNREADABLE_NEXT, spinOffTitle, type ListedSpinOff } from '../spinOff.js';
import { typedPromptNotes } from '../supervisor.js';
import { Alert } from './Alert.js';
import { ExactText, hiddenNote, lengthNote } from './ApprovalCards.js';
import { Button } from './Button.js';
import { ScrollBox, useOverflowing } from './ScrollBox.js';
import { Timestamp } from './Timestamp.js';
import '../supervisor.css';
import './SpinOffCards.css';

/** What Start hands on once the server has checked it: New session's prefill. */
export interface CheckedSpinOff {
  sessionId: string;
  key: string;
  /** The session that asked, by name, for New session's subtitle. */
  from: string;
  cwd: string;
  name?: string;
  prompt: string;
}

export interface SpinOffCardsProps {
  items: readonly ListedSpinOff[];
  onStart: (checked: CheckedSpinOff) => void;
  onDismiss: (sessionId: string, key: string) => void;
  onOpen?: ((sessionId: string) => void) | undefined;
}

export const SPIN_OFFS_LABEL = 'Proposed sessions';

export function SpinOffCards({ items, onStart, onDismiss, onOpen }: SpinOffCardsProps) {
  const headingId = useId();
  if (items.length === 0) return null;
  return (
    <section className="spin-offs" aria-labelledby={headingId}>
      <h3 className="spin-offs-title" id={headingId}>
        {SPIN_OFFS_LABEL} <span className="spin-offs-count">({items.length})</span>
      </h3>
      <ul className="approval-cards spin-off-cards">
        {items.map((item) => (
          <SpinOffCard key={`${item.session.sessionId}:${item.spinOff.key}`} item={item} onStart={onStart} onDismiss={onDismiss} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

function SpinOffCard({ item, onStart, onDismiss, onOpen }: { item: ListedSpinOff } & Omit<SpinOffCardsProps, 'items'>) {
  const api = useContext(ApiContext);
  const ids = { heading: useId(), text: useId(), notes: useId() };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // A prompt longer than its box says so, as the supervisor's cards do: it's the session's text, and
  // an instruction below the fold is the one to read (W164, F3).
  const [textBox, setTextBox] = useState<HTMLElement | null>(null);
  const overflowing = useOverflowing(textBox);
  const { session, spinOff } = item;
  const from = plainText(session.name);

  const start = async () => {
    if (busy || !api) return;
    setBusy(true);
    setError(undefined);
    const outcome = await checkSpinOff(api, session.sessionId, spinOff.key);
    setBusy(false);
    if (outcome.kind === 'failed') {
      setError(outcome.error);
      return;
    }
    onStart({ sessionId: session.sessionId, key: spinOff.key, from, cwd: outcome.cwd, prompt: outcome.prompt, ...(outcome.name === undefined ? {} : { name: outcome.name }) });
  };

  const parts = spinOff.kind === 'proposal' ? visibleParts(spinOff.prompt) : [];
  const notes = spinOff.kind === 'proposal' ? [overflowing ? lengthNote(spinOff.prompt) : undefined, hiddenNote(parts), ...typedPromptNotes(spinOff.prompt)].filter((note) => note !== undefined) : [];
  return (
    <li className="approval-card spin-off-card" data-session={session.sessionId} data-kind={spinOff.kind} aria-labelledby={ids.heading} aria-busy={busy || undefined}>
      <h4 className="approval-title" id={ids.heading}>
        <bdi>{spinOffTitle(from)}</bdi>
      </h4>
      {session.lastActivityAt !== undefined && (
        <p className="approval-meta">
          Proposed <Timestamp at={session.lastActivityAt} />
        </p>
      )}
      {spinOff.kind === 'proposal' ? (
        <>
          <p className="approval-note">{SPIN_OFF_NOTE}</p>
          {/* The whole path, as it is: the page can't know the real home, so it never shortens it to ~. */}
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
            <p className="approval-label" id={ids.text}>
              First prompt
            </p>
            <ScrollBox ref={setTextBox} as="p" className="approval-text" label="First prompt" aria-describedby={notes.length > 0 ? ids.notes : undefined}>
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
        </>
      ) : (
        <p className="approval-where">
          {SPIN_OFF_UNREADABLE} {spinOff.problem} {SPIN_OFF_UNREADABLE_NEXT}
        </p>
      )}
      {error !== undefined && (
        <Alert tone="danger" role="alert" className="approval-error">
          {error}
        </Alert>
      )}
      <div className="approval-actions">
        {spinOff.kind === 'proposal' && (
          <Button variant="primary" size="sm" icon="add" busy={busy} busyLabel="Checking…" onClick={() => void start()}>
            Start…
          </Button>
        )}
        {onOpen && (
          <Button size="sm" disabled={busy} onClick={() => onOpen(session.sessionId)}>
            Open session
          </Button>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDismiss(session.sessionId, spinOff.key)}>
          Dismiss
        </Button>
      </div>
    </li>
  );
}
