import { useContext, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { plainText } from '../format.js';
import { sessionAction, type SessionAction } from '../spawn.js';
import '../actions.css';

const CONFIRM: Record<SessionAction, { text: string; confirm: string; busy: string }> = {
  stop: {
    text: 'Stops the session; its conversation is kept. Attaching to it later asks before restarting it.',
    confirm: 'Stop session',
    busy: 'Stopping…',
  },
  remove: {
    text: 'Removes it from the list. Claude Code keeps a worktree that has unpushed commits.',
    confirm: 'Remove session',
    busy: 'Removing…',
  },
};

export interface SessionActionsProps {
  /** A background session. The session view doesn't render this for any other kind. */
  session: SessionSummary;
  /** Called once Claude Code has removed the session, so the view can close. */
  onRemoved: () => void;
}

/**
 * Stop and Remove for a background session, each behind a confirmation.
 * Shows Claude Code's message when it refuses, such as `claude rm` keeping a
 * worktree with unpushed commits.
 */
export function SessionActions({ session, onRemoved }: SessionActionsProps) {
  const api = useContext(ApiContext);
  const textId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const [confirming, setConfirming] = useState<SessionAction>();
  const [running, setRunning] = useState<SessionAction>();
  const [result, setResult] = useState<{ ok: boolean; text: string }>();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The safe choice gets focus when a confirmation opens.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  const run = async (action: SessionAction) => {
    setConfirming(undefined);
    setResult(undefined);
    if (!api) {
      setResult({ ok: false, text: "This can't be done from here." });
      return;
    }
    setRunning(action);
    const outcome = await sessionAction(api, session.sessionId, action);
    if (!alive.current) return;
    setRunning(undefined);
    if (outcome.kind === 'done') {
      if (action === 'remove') onRemoved();
      else setResult({ ok: true, text: 'Stopped. Its conversation is kept.' });
    } else if (outcome.kind !== 'unauthorized') {
      setResult({ ok: false, text: outcome.error });
    }
  };

  const onConfirmKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    // Cancels the confirmation without closing the session view.
    event.preventDefault();
    event.stopPropagation();
    setConfirming(undefined);
  };

  const busy = running !== undefined;
  const ask = (action: SessionAction) => {
    setResult(undefined);
    setConfirming(action);
  };

  return (
    <div className="session-actions">
      <div className="session-actions-buttons">
        <button
          type="button"
          className="button small"
          onClick={() => ask('stop')}
          disabled={busy || !session.alive}
          aria-expanded={confirming === 'stop'}
          title={session.alive ? undefined : "It isn't running, so there's nothing to stop."}
        >
          {running === 'stop' ? CONFIRM.stop.busy : 'Stop'}
        </button>
        <button type="button" className="button small" onClick={() => ask('remove')} disabled={busy} aria-expanded={confirming === 'remove'}>
          {running === 'remove' ? CONFIRM.remove.busy : 'Remove'}
        </button>
      </div>
      {confirming && (
        <div className="session-confirm" role="group" aria-labelledby={textId} onKeyDown={onConfirmKey}>
          <p id={textId}>{CONFIRM[confirming].text}</p>
          <div className="session-confirm-buttons">
            <button type="button" className="button small danger" onClick={() => void run(confirming)}>
              {CONFIRM[confirming].confirm}
            </button>
            <button ref={cancelRef} type="button" className="button small" onClick={() => setConfirming(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {result && (
        <p className={result.ok ? 'action-result' : 'action-result failed'} role={result.ok ? 'status' : 'alert'}>
          {plainText(result.text)}
        </p>
      )}
    </div>
  );
}
