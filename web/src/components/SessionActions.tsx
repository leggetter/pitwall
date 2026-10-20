// Stop and Remove for a background session (W12), each behind an inline confirmation (docs/design-
// system.md, 4: Inline confirmation). The session view's actions menu asks for them (W22). The API
// calls are W12's. While one runs, its confirmation stays, with the confirm button busy. Done, it's a
// toast (W25): "Stopped. Its conversation is kept.", or "Removed name" as the view closes. Refused, the
// result shows in the confirmation's place, with Claude Code's message, such as `claude rm` keeping a
// worktree with unpushed commits.

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { plainText } from '../format.js';
import { sessionAction, type SessionAction } from '../spawn.js';
import { Alert, Detail } from './Alert.js';
import type { IconName } from './Icon.js';
import { InlineConfirm } from './InlineConfirm.js';
import { useToast } from './Toast.js';
import '../actions.css';

export const CONFIRM: Record<
  SessionAction,
  { question: string; consequence: string; confirm: string; busy: string; icon: IconName; refused: string }
> = {
  stop: {
    question: 'Stop this session?',
    consequence: 'Its conversation is kept. Attaching to it later asks before restarting it.',
    confirm: 'Stop session',
    busy: 'Stopping…',
    icon: 'stop',
    refused: "Couldn't stop the session.",
  },
  remove: {
    question: 'Remove this session?',
    consequence: 'It leaves the list. Claude Code keeps a worktree that has unpushed commits.',
    confirm: 'Remove session',
    busy: 'Removing…',
    icon: 'remove',
    refused: "Couldn't remove the session.",
  },
};

export const STOPPED = 'Stopped. Its conversation is kept.';
/** The toast once a session is removed: its name, as written. */
export const removedText = (name: string) => `Removed ${plainText(name)}`;

/** What went wrong. `detail` is Claude Code's own message, when it refused. Success is a toast instead. */
export type ActionResult = { text: string; detail?: string };

/** How a run ended: removed (the view closes), or anything else (the view stays). */
export type RunEnd = 'removed' | 'stopped' | 'failed';

export interface SessionActions {
  /** The action whose confirmation is open, if any. It stays open while the action runs. */
  confirming: SessionAction | undefined;
  /** The action whose request is out, if any. Nothing else can start meanwhile. */
  running: SessionAction | undefined;
  /** Why the last one didn't happen, shown in the confirmation's place. */
  result: ActionResult | undefined;
  /** Opens the action's confirmation. */
  ask: (action: SessionAction) => void;
  /** Closes the confirmation without doing anything. Does nothing while the action runs. */
  cancel: () => void;
  run: (action: SessionAction) => Promise<RunEnd>;
}

/**
 * Stop and Remove for `session`, a background session. `onRemoved` runs once Claude Code has removed
 * it, so the view can close. Each success is a toast.
 */
export function useSessionActions(session: SessionSummary, onRemoved: () => void): SessionActions {
  const api = useContext(ApiContext);
  const toast = useToast();
  const alive = useRef(true);
  const [confirming, setConfirming] = useState<SessionAction>();
  const [running, setRunning] = useState<SessionAction>();
  const runningRef = useRef<SessionAction | undefined>(undefined);
  const [result, setResult] = useState<ActionResult>();
  const { sessionId, name } = session;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const ask = useCallback((action: SessionAction) => {
    if (runningRef.current) return;
    setResult(undefined);
    setConfirming(action);
  }, []);

  const cancel = useCallback(() => {
    if (!runningRef.current) setConfirming(undefined);
  }, []);

  const run = useCallback(
    async (action: SessionAction): Promise<RunEnd> => {
      if (runningRef.current) return 'failed';
      setResult(undefined);
      if (!api) {
        setConfirming(undefined);
        setResult({ text: "This can't be done from here." });
        return 'failed';
      }
      runningRef.current = action;
      setRunning(action);
      const outcome = await sessionAction(api, sessionId, action);
      runningRef.current = undefined;
      if (!alive.current) return 'failed';
      setRunning(undefined);
      setConfirming(undefined);
      if (outcome.kind === 'done') {
        if (action === 'remove') {
          toast({ tone: 'success', message: removedText(name) });
          onRemoved();
          return 'removed';
        }
        toast({ tone: 'success', message: STOPPED });
        return 'stopped';
      }
      if (outcome.kind === 'refused') setResult({ text: CONFIRM[action].refused, detail: outcome.error });
      else if (outcome.kind === 'failed') setResult({ text: outcome.error });
      // On 'unauthorized' the app has already replaced the dashboard with the token notice.
      return 'failed';
    },
    [api, sessionId, name, onRemoved, toast],
  );

  return { confirming, running, result, ask, cancel, run };
}

export interface SessionConfirmProps {
  actions: SessionActions;
  /** Focus back on what opened the confirmation, the actions menu's button: after Cancel, Escape, or a result. */
  onReturnFocus: () => void;
}

/** The open confirmation, busy while its action runs, then a refusal, under the session view's header. */
export function SessionConfirm({ actions, onReturnFocus }: SessionConfirmProps) {
  const box = useRef<HTMLDivElement>(null);
  const { confirming, running, result } = actions;

  const confirm = (action: SessionAction) => {
    void actions.run(action).then((end) => {
      // Removed: the view closes, and the app puts focus back on the list. Otherwise focus goes back to
      // the menu button, unless it was moved elsewhere while the request was out.
      if (end === 'removed') return;
      const active = document.activeElement;
      if (active === null || active === document.body || box.current?.contains(active)) onReturnFocus();
    });
  };

  if (!confirming && !result) return null;
  return (
    <div className="session-actions" ref={box}>
      {confirming ? (
        <InlineConfirm
          // A new confirmation, such as Remove chosen while Stop's was open, takes focus afresh.
          key={confirming}
          question={CONFIRM[confirming].question}
          consequence={CONFIRM[confirming].consequence}
          confirmLabel={CONFIRM[confirming].confirm}
          busyLabel={CONFIRM[confirming].busy}
          icon={CONFIRM[confirming].icon}
          variant="danger"
          busy={running === confirming}
          onConfirm={() => confirm(confirming)}
          onCancel={() => {
            actions.cancel();
            onReturnFocus();
          }}
        />
      ) : (
        result && (
          <Alert tone="danger" role="alert">
            {plainText(result.text)}
            {result.detail !== undefined && (
              <>
                {' '}
                <Detail>{plainText(result.detail)}</Detail>
              </>
            )}
          </Alert>
        )
      )}
    </div>
  );
}
