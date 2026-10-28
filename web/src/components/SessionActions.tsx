// Stop and Remove for a background session (W12), each behind an inline confirmation (docs/design-
// system.md, 4: Inline confirmation). The session view's actions menu asks for them (W22). The API
// calls are W12's. While one runs, its confirmation stays, with the confirm button busy. Done, it's a
// toast (W25): "Stopped. Its conversation is kept.", or "Removed name" as the view closes. Refused, the
// result shows in the confirmation's place, with Claude Code's message, such as `claude rm` keeping a
// worktree with unpushed commits.
//
// The result still arrives when the view has gone while the request was out, as Close, Back or the
// browser's back button take it away: as a toast from the app's stack, which outlives the view,
// naming the session, and an error toast with Claude Code's message, as text, for a refusal. j, k,
// ↑ and ↓ do nothing while one runs (onRunningChange), so they never move the view away from it.
//
// End session (W90, spike 005, D22), for a running interactive session, behind its own confirmation,
// which names the session and its running sub-agents and says what ending costs. The server ends only
// an idle one: one that's working, by its transcript afresh, comes back as `working`, and the
// confirmation becomes the stronger warning, naming what's running, whose End session anyway sends
// `whileWorking`. Done, it's a toast, "Ended name. Its terminal is back at the shell.", and the next
// snapshot lists it as ended (W67), with Resume in background.

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { EndSessionWorking, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { couldNot, plainText } from '../format.js';
import { endSession, sessionAction, type ActionOutcome, type EndOutcome, type SessionAction } from '../spawn.js';
import { Alert, Detail } from './Alert.js';
import type { IconName } from './Icon.js';
import { InlineConfirm } from './InlineConfirm.js';
import { useToast, type ToastInput } from './Toast.js';
import '../actions.css';

/** The view's actions behind a confirmation: Stop and Remove for a background session, End for an interactive one (W90). */
export type ViewAction = SessionAction | 'end';

export const CONFIRM: Record<
  ViewAction,
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
  // Its consequence names the session and what runs under it: endConsequence().
  end: {
    question: 'End this session?',
    consequence: '',
    confirm: 'End session',
    busy: 'Ending…',
    icon: 'stop',
    refused: "Couldn't end the session.",
  },
};

/** End's consequence (W90): the session by name, its running sub-agents from the snapshot, and what ending costs. */
export function endConsequence(name: string, subagentsRunning: number | undefined): string {
  const running =
    subagentsRunning !== undefined && subagentsRunning > 0
      ? `, and ${subagentsRunning === 1 ? 'its running sub-agent is' : `its ${subagentsRunning} running sub-agents are`} stopped`
      : '';
  return `${plainText(name)}'s Claude Code process ends, and its terminal goes back to the shell. Any reply in progress is lost${running}. Its conversation is kept, so you can resume it afterwards.`;
}

/** The stronger warning's question, once the server says the session is working (spike 005's guard). */
export const END_WORKING_QUESTION = "It's still working. End this session anyway?";
export const END_WORKING_CONFIRM = 'End session anyway';

/** The stronger warning's consequence: what's running, by the server's check just now, and what ending it now loses. */
export function workingConsequence(working: EndSessionWorking): string {
  const parts: string[] = [];
  if (working.turn === 'running') parts.push('Its turn is still running: a reply being written is lost, and its commands are stopped.');
  if (working.turn === 'unknown') parts.push("pitwall can't tell from its transcript whether its turn has ended, so a reply being written may be lost, and its commands stopped.");
  if (working.subagents !== undefined) parts.push(`${working.subagents === 1 ? '1 sub-agent is' : `${working.subagents} sub-agents are`} running, and ${working.subagents === 1 ? 'it' : 'they'} end with it.`);
  return `${parts.join(' ')} You can still resume it afterwards.`;
}

/** The toast once a session has ended (W90). */
export const endedText = (name: string) => `Ended ${plainText(name)}. Its terminal is back at the shell.`;
/** The toast when its process hadn't exited by the server's answer. */
export const endingText = (name: string) => `Sent ${plainText(name)} the signal to end. It hadn't exited after 5 seconds, so it may still be finishing.`;

export const STOPPED = 'Stopped. Its conversation is kept.';
/** The toast once a session is removed: its name, as written. */
export const removedText = (name: string) => `Removed ${plainText(name)}`;
/** The toast once a session is stopped after its view has gone: which one, since the view no longer says. */
export const stoppedText = (name: string) => `Stopped ${plainText(name)}. Its conversation is kept.`;

/**
 * The toast for a result that arrived after the session's view had gone, or nothing for one the app
 * already shows (unauthorized). It names the session, since nothing on screen says which it was. A
 * refusal is an error toast with Claude Code's message after pitwall's sentence, as text.
 */
export function resultToast(action: SessionAction, name: string, outcome: ActionOutcome): ToastInput | undefined {
  const named = `${action} ${plainText(name)}`;
  switch (outcome.kind) {
    case 'done':
      return { tone: 'success', message: action === 'remove' ? removedText(name) : stoppedText(name) };
    case 'refused':
      return { tone: 'error', message: `${couldNot(named, undefined)} ${plainText(outcome.error)}` };
    case 'failed':
      return { tone: 'error', message: couldNot(named, outcome.status) };
    case 'unauthorized':
      return undefined;
  }
}

/**
 * End's result when its view has gone (W90), as resultToast() is Stop's and Remove's: it names the
 * session. Not ended because it's working: an error toast, since nothing happened, saying where to
 * end it anyway.
 */
export function endResultToast(name: string, outcome: EndOutcome): ToastInput | undefined {
  switch (outcome.kind) {
    case 'ended':
      return outcome.exited ? { tone: 'success', message: endedText(name) } : { tone: 'info', message: endingText(name) };
    case 'working':
      return { tone: 'error', message: `Didn't end ${plainText(name)}: it's still working. Open it to end it anyway.` };
    case 'refused':
      return { tone: 'error', message: `${couldNot(`end ${plainText(name)}`, undefined)} ${plainText(outcome.error)}` };
    case 'failed':
      return { tone: 'error', message: couldNot(`end ${plainText(name)}`, outcome.status) };
    case 'unauthorized':
      return undefined;
  }
}

/** What went wrong. `detail` is Claude Code's own message, when it refused. Success is a toast instead. */
export type ActionResult = { text: string; detail?: string };

/**
 * How a run ended: removed (the view closes), working (End's stronger warning takes the
 * confirmation's place, and its Cancel takes focus), or anything else (the view stays).
 */
export type RunEnd = 'removed' | 'stopped' | 'ended' | 'working' | 'failed';

export interface SessionActions {
  /** The action whose confirmation is open, if any. It stays open while the action runs. */
  confirming: ViewAction | undefined;
  /** The action whose request is out, if any. Nothing else can start meanwhile. */
  running: ViewAction | undefined;
  /** What's running, once the server said End's session is working: the confirmation is then the stronger warning. */
  working: EndSessionWorking | undefined;
  /** Why the last one didn't happen, shown in the confirmation's place. */
  result: ActionResult | undefined;
  /** Opens the action's confirmation. */
  ask: (action: ViewAction) => void;
  /** Closes the confirmation without doing anything. Does nothing while the action runs. */
  cancel: () => void;
  run: (action: ViewAction) => Promise<RunEnd>;
}

/**
 * Stop and Remove for `session`, a background session, and End for an interactive one (W90).
 * `onRemoved` runs once Claude Code has removed it, so the view can close. Each success is a toast.
 */
export function useSessionActions(session: SessionSummary, onRemoved: () => void): SessionActions {
  const api = useContext(ApiContext);
  const toast = useToast();
  const alive = useRef(true);
  const [confirming, setConfirming] = useState<ViewAction>();
  const [running, setRunning] = useState<ViewAction>();
  const runningRef = useRef<ViewAction | undefined>(undefined);
  const [working, setWorking] = useState<EndSessionWorking>();
  const [result, setResult] = useState<ActionResult>();
  const { sessionId, name } = session;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const ask = useCallback((action: ViewAction) => {
    if (runningRef.current) return;
    setResult(undefined);
    setWorking(undefined);
    setConfirming(action);
  }, []);

  const cancel = useCallback(() => {
    if (runningRef.current) return;
    setConfirming(undefined);
    setWorking(undefined);
  }, []);

  const runEnd = useCallback(
    async (whileWorking: boolean): Promise<RunEnd> => {
      if (!api) return 'failed';
      const outcome = await endSession(api, sessionId, whileWorking);
      runningRef.current = undefined;
      if (!alive.current) {
        const gone = endResultToast(name, outcome);
        if (gone) toast(gone);
        return outcome.kind === 'ended' ? 'ended' : 'failed';
      }
      setRunning(undefined);
      if (outcome.kind === 'working') {
        // The confirmation stays, as the stronger warning, naming what's running.
        setWorking(outcome.working);
        return 'working';
      }
      setConfirming(undefined);
      setWorking(undefined);
      if (outcome.kind === 'ended') {
        toast(outcome.exited ? { tone: 'success', message: endedText(name) } : { tone: 'info', message: endingText(name) });
        return 'ended';
      }
      if (outcome.kind === 'refused') setResult({ text: CONFIRM.end.refused, detail: outcome.error });
      else if (outcome.kind === 'failed') setResult({ text: outcome.error });
      return 'failed';
    },
    [api, sessionId, name, toast],
  );

  const run = useCallback(
    async (action: ViewAction): Promise<RunEnd> => {
      if (runningRef.current) return 'failed';
      setResult(undefined);
      if (!api) {
        setConfirming(undefined);
        setWorking(undefined);
        setResult({ text: "This can't be done from here." });
        return 'failed';
      }
      runningRef.current = action;
      setRunning(action);
      if (action === 'end') return runEnd(working !== undefined);
      const outcome = await sessionAction(api, sessionId, action);
      runningRef.current = undefined;
      if (!alive.current) {
        // The view went while the request was out: the result is a toast from the app's stack, which is still there.
        const gone = resultToast(action, name, outcome);
        if (gone) toast(gone);
        return outcome.kind === 'done' ? (action === 'remove' ? 'removed' : 'stopped') : 'failed';
      }
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
    [api, sessionId, name, onRemoved, toast, runEnd, working],
  );

  return { confirming, running, working, result, ask, cancel, run };
}

export interface SessionConfirmProps {
  actions: SessionActions;
  /** The session, for End's consequence: its name and its running sub-agents (W90). */
  session: Pick<SessionSummary, 'name' | 'subagentsRunning'>;
  /**
   * True once End's session has ended some other way, as in its own terminal: End's confirmation,
   * open and not yet confirmed, goes, since there's nothing left to end (W90).
   */
  ended?: boolean;
  /** Focus back on what opened the confirmation, the actions menu's button: after Cancel, Escape, or a result. */
  onReturnFocus: () => void;
}

/** The open confirmation, busy while its action runs, then a refusal, under the session view's header. */
export function SessionConfirm({ actions, session, ended = false, onReturnFocus }: SessionConfirmProps) {
  const box = useRef<HTMLDivElement>(null);
  const { confirming, running, working, result, cancel } = actions;

  // Ended meanwhile, with End's question still open: it goes, and focus it had goes back to the menu button.
  const stale = ended && confirming === 'end' && running === undefined;
  useEffect(() => {
    if (!stale) return;
    const active = document.activeElement;
    const inside = active !== null && box.current?.contains(active) === true;
    cancel();
    if (inside) onReturnFocus();
  }, [stale, cancel, onReturnFocus]);

  const confirm = (action: ViewAction) => {
    void actions.run(action).then((end) => {
      // Removed: the view closes, and the app puts focus back on the list. Working: End's stronger
      // warning has taken the confirmation's place, and its Cancel has focus. Otherwise focus goes back
      // to the menu button, unless it was moved elsewhere while the request was out.
      if (end === 'removed' || end === 'working') return;
      const active = document.activeElement;
      if (active === null || active === document.body || box.current?.contains(active)) onReturnFocus();
    });
  };

  if (!confirming && !result) return null;
  const warning = confirming === 'end' && working !== undefined;
  return (
    <div className="session-actions" ref={box}>
      {confirming ? (
        <InlineConfirm
          // A new confirmation, such as Remove chosen while Stop's was open, or End's stronger warning, takes focus afresh.
          key={warning ? 'end-working' : confirming}
          question={warning ? END_WORKING_QUESTION : CONFIRM[confirming].question}
          consequence={
            warning ? workingConsequence(working) : confirming === 'end' ? endConsequence(session.name, session.subagentsRunning) : CONFIRM[confirming].consequence
          }
          confirmLabel={warning ? END_WORKING_CONFIRM : CONFIRM[confirming].confirm}
          busyLabel={CONFIRM[confirming].busy}
          icon={CONFIRM[confirming].icon}
          variant="danger"
          // The stronger warning interrupts End, so its question and consequence are read as Cancel takes focus.
          role={warning ? 'alertdialog' : 'group'}
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
