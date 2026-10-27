// An ended interactive session in its view (W67; docs/design-system.md, 4: Session view: header, tabs
// and footer). Its Claude Code process has exited, as when its terminal closed or the Mac restarted,
// so there's nothing to attach to or message: where the message box would be, a note says so, with
// Resume in background, which resumes it with `claude --resume <id> --bg` through resumePath() (spike
// 006), and Copy command, which copies the command that resumes it in a terminal (resumeCommand()).
// A session whose directory has gone has the note alone: Claude Code resumes a session in its own
// directory. The actions menu has both too (SessionView.tsx).
//
// Resume in background is busy while its request is out, and stays busy once Claude Code has resumed
// it, until the snapshot lists the session as running, or RESUME_LISTED_MS has passed. Resumed, a
// toast says so, and the view shows it as the background session it now is. Refused, an inline alert
// above the buttons says why: Claude Code's message, the command to run when there's one, as New
// session's trust failure has it, or a warning that Claude Code started a copy instead. A result that
// arrives after the view has gone is a toast naming the session, as Stop and Remove's is.

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { couldNot, plainText } from '../format.js';
import { resumeSession, type ResumeOutcome } from '../spawn.js';
import { Alert, Detail } from './Alert.js';
import { Button } from './Button.js';
import { CopyCommand } from './CopyCommand.js';
import { useToast, type ToastInput } from './Toast.js';
import '../actions.css';

/** The footer's note, where an interactive session has its message box. */
export const ENDED_NOTE = 'It ended when its Claude Code process exited. Resume it here in the background, or copy the command that resumes it in a terminal.';
/** The note for one whose directory has gone (`cwdMissing`), which can't be resumed. */
export const ENDED_GONE_NOTE = "It ended when its Claude Code process exited, and its directory no longer exists, so it can't be resumed.";
/** The primary action's label, in the footer and the actions menu, and its busy label. */
export const RESUME_LABEL = 'Resume in background';
export const RESUMING = 'Resuming…';
/** The footer's secondary action. The actions menu calls it Copy resume command, beside Copy session ID. */
export const COPY_COMMAND_LABEL = 'Copy command';
export const COPY_RESUME_COMMAND = 'Copy resume command';
/** The toast once Claude Code has resumed it. */
export const resumedText = (name: string) => `Resumed ${plainText(name)} in the background.`;
/** pitwall's sentence before Claude Code's or the server's reason. */
export const RESUME_REFUSED = "Couldn't resume the session.";
/** The sentence before a command the server says to run, as New session's trust failure has it. */
export const RESUME_HINT_TEXT = "pitwall never trusts a directory for you. Run this in a terminal, accept Claude Code's trust prompt, then resume it again:";
/**
 * The warning's title when Claude Code started a copy instead. Its body: "It's open in another Claude
 * Code process, so the copy, *short id*, is listed as a background session.", then the server's message.
 */
export const COPY_STARTED = 'Claude Code started a copy instead';

/**
 * How long a resumed session's button stays busy while the snapshot still lists it as ended: three of
 * the index's default 5 s polls (DEFAULT_POLL_INTERVAL_MS). After that it's Resume in background again.
 */
export const RESUME_LISTED_MS = 15_000;

/** What a resume can come back with that the view shows: why it didn't resume. */
export type ResumeFailure = Extract<ResumeOutcome, { kind: 'copied' | 'refused' | 'failed' }>;

/** 'running' while the request is out; 'waiting' once it resumed, until the snapshot lists it as running. */
export type ResumePhase = 'idle' | 'running' | 'waiting';

export interface Resume {
  phase: ResumePhase;
  /** Why the last one didn't resume, shown in the footer until the next. */
  failure: ResumeFailure | undefined;
  /** Resumes the session, unless a resume is out or waiting. */
  run: () => void;
}

/**
 * The toast for a result that arrived after the view had gone, naming the session, since nothing on
 * screen says which it was; nothing for one the app already shows (unauthorized).
 */
export function resumeToast(name: string, outcome: ResumeOutcome): ToastInput | undefined {
  const named = `resume ${plainText(name)}`;
  switch (outcome.kind) {
    case 'resumed':
      return { tone: 'success', message: resumedText(name) };
    case 'copied':
      return { tone: 'error', message: `Couldn't ${named}: Claude Code started a copy instead, ${plainText(outcome.copyShortId)}.` };
    case 'refused':
      return { tone: 'error', message: `${couldNot(named, undefined)} ${plainText(outcome.error)}` };
    case 'failed':
      return { tone: 'error', message: couldNot(named, outcome.status) };
    case 'unauthorized':
      return undefined;
  }
}

/** Resume in background for `session`, an ended interactive session. `onResumed` runs once Claude Code has resumed it. */
export function useResume(session: SessionSummary, onResumed: () => void): Resume {
  const api = useContext(ApiContext);
  const toast = useToast();
  const alive = useRef(true);
  const [phase, setPhase] = useState<ResumePhase>('idle');
  const phaseRef = useRef<ResumePhase>('idle');
  const [failure, setFailure] = useState<ResumeFailure>();
  const { sessionId, name, ended } = session;
  const moveTo = useCallback((next: ResumePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Resumed: busy until the snapshot lists it as running, or RESUME_LISTED_MS has passed.
  useEffect(() => {
    if (phase !== 'waiting') return;
    if (!ended) {
      moveTo('idle');
      return;
    }
    const timer = setTimeout(() => moveTo('idle'), RESUME_LISTED_MS);
    return () => clearTimeout(timer);
  }, [phase, ended, moveTo]);

  const run = useCallback(() => {
    if (phaseRef.current !== 'idle') return;
    setFailure(undefined);
    if (!api) {
      setFailure({ kind: 'failed', error: "This can't be done from here." });
      return;
    }
    moveTo('running');
    void resumeSession(api, sessionId).then((outcome) => {
      if (!alive.current) {
        // The view went while the request was out: the result is a toast from the app's stack, which is still there.
        const gone = resumeToast(name, outcome);
        if (gone) toast(gone);
        return;
      }
      if (outcome.kind === 'resumed') {
        toast({ tone: 'success', message: resumedText(name) });
        moveTo('waiting');
        onResumed();
        return;
      }
      moveTo('idle');
      // On 'unauthorized' the app has already replaced the dashboard with the token notice.
      if (outcome.kind !== 'unauthorized') setFailure(outcome);
    });
  }, [api, sessionId, name, toast, onResumed, moveTo]);

  return { phase, failure, run };
}

export interface EndedFooterProps {
  session: SessionSummary;
  resume: Resume;
  /** Copies the command that resumes it in a terminal, or undefined when there's none (resumeCommand()). */
  onCopy: (() => void) | undefined;
}

/**
 * The note, then why the last resume didn't happen, then Copy command and Resume in background, at
 * the right, secondary then primary, as a dialog's footer has them. A missing directory leaves the note.
 */
export function EndedFooter({ session, resume, onCopy }: EndedFooterProps) {
  const gone = session.cwdMissing === true;
  const busy = resume.phase !== 'idle';
  return (
    <div className="ended-foot">
      <p className="session-view-note">{gone ? ENDED_GONE_NOTE : ENDED_NOTE}</p>
      {!gone && resume.failure && <ResumeAlert failure={resume.failure} />}
      {!gone && (
        <div className="ended-actions">
          {onCopy && (
            <Button icon="copy" onClick={onCopy}>
              {COPY_COMMAND_LABEL}
            </Button>
          )}
          <Button variant="primary" icon="restart" disabled={busy} busy={busy} busyLabel={RESUMING} onClick={resume.run}>
            {RESUME_LABEL}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A refusal or failure in danger, with the command to run when there's one; a copy Claude Code started, in warning. */
function ResumeAlert({ failure }: { failure: ResumeFailure }) {
  if (failure.kind === 'copied') {
    return (
      <Alert tone="warning" role="alert" title={COPY_STARTED} className="resume-failure">
        It&apos;s open in another Claude Code process, so the copy, <Detail>{plainText(failure.copyShortId)}</Detail>, is listed as a background session.{' '}
        <Detail>{plainText(failure.error)}</Detail>
      </Alert>
    );
  }
  return (
    <Alert tone="danger" role="alert" className="resume-failure">
      {failure.kind === 'refused' ? (
        <>
          {RESUME_REFUSED} <Detail>{plainText(failure.error)}</Detail>
        </>
      ) : (
        plainText(failure.error)
      )}
      {failure.kind === 'refused' && failure.hint !== undefined && (
        <>
          <p className="spawn-trust">{RESUME_HINT_TEXT}</p>
          {/* Its own name: the footer's Copy command is the resume command's. */}
          <CopyCommand command={failure.hint} label="Copy trust command" />
        </>
      )}
    </Alert>
  );
}
