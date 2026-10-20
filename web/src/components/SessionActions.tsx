// Stop and Remove for a background session (W12), each behind a confirmation. The session view's
// actions menu asks for them (W22); the confirmation, the API calls and the result are as W12 built
// them, until W24 restyles inline confirmations. Shows Claude Code's message when it refuses, such as
// `claude rm` keeping a worktree with unpushed commits.

import { useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
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

export interface SessionActions {
  /** The action waiting for its confirmation, if any. */
  confirming: SessionAction | undefined;
  /** The action whose request is out, if any. Nothing else can start meanwhile. */
  running: SessionAction | undefined;
  result: { ok: boolean; text: string } | undefined;
  /** Opens the action's confirmation. */
  ask: (action: SessionAction) => void;
  /** Closes the confirmation without doing anything. */
  cancel: () => void;
  run: (action: SessionAction) => Promise<void>;
}

/**
 * Stop and Remove for `session`, a background session. `onRemoved` runs once Claude Code has removed
 * it, so the view can close.
 */
export function useSessionActions(session: SessionSummary, onRemoved: () => void): SessionActions {
  const api = useContext(ApiContext);
  const alive = useRef(true);
  const [confirming, setConfirming] = useState<SessionAction>();
  const [running, setRunning] = useState<SessionAction>();
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const { sessionId } = session;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const ask = useCallback((action: SessionAction) => {
    setResult(undefined);
    setConfirming(action);
  }, []);

  const cancel = useCallback(() => setConfirming(undefined), []);

  const run = useCallback(
    async (action: SessionAction) => {
      setConfirming(undefined);
      setResult(undefined);
      if (!api) {
        setResult({ ok: false, text: "This can't be done from here." });
        return;
      }
      setRunning(action);
      const outcome = await sessionAction(api, sessionId, action);
      if (!alive.current) return;
      setRunning(undefined);
      if (outcome.kind === 'done') {
        if (action === 'remove') onRemoved();
        else setResult({ ok: true, text: 'Stopped. Its conversation is kept.' });
      } else if (outcome.kind !== 'unauthorized') {
        setResult({ ok: false, text: outcome.error });
      }
    },
    [api, sessionId, onRemoved],
  );

  return { confirming, running, result, ask, cancel, run };
}

export interface SessionConfirmProps {
  actions: SessionActions;
  /** After Cancel or Escape: focus goes back to what opened the confirmation, the actions menu's button. */
  onCancel: () => void;
}

/** The open confirmation, the action in progress, and the last result, under the session view's header. */
export function SessionConfirm({ actions, onCancel }: SessionConfirmProps) {
  const textId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { confirming, running, result } = actions;

  // The safe choice gets focus when a confirmation opens.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  const cancel = () => {
    actions.cancel();
    onCancel();
  };

  const onConfirmKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    // Cancels the confirmation without closing the session view.
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };

  if (!confirming && !running && !result) return null;
  return (
    <div className="session-actions">
      {confirming && (
        <div className="session-confirm" role="group" aria-labelledby={textId} onKeyDown={onConfirmKey}>
          <p id={textId}>{CONFIRM[confirming].text}</p>
          <div className="session-confirm-buttons">
            <button type="button" className="button sm danger" onClick={() => void actions.run(confirming)}>
              {CONFIRM[confirming].confirm}
            </button>
            <button ref={cancelRef} type="button" className="button sm" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {running && (
        <p className="action-result" role="status" aria-busy="true">
          {CONFIRM[running].busy}
        </p>
      )}
      {result && (
        <p className={result.ok ? 'action-result' : 'action-result failed'} role={result.ok ? 'status' : 'alert'}>
          {plainText(result.text)}
        </p>
      )}
    </div>
  );
}
