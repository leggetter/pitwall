// Resume from a row (W107; docs/design-system.md, 4: Session rows): on the row of a finished session
// that owns an open PR, which stays in the main list until the PR closes (W106), a ghost sm `restart`
// icon button, named "Resume <session> in the background" by its tooltip, at the end of line 2, where a
// session that needs you has its Not needed now toggle, shown on hover and focus as that is. It resumes
// an ended interactive session (D17) or a background session that isn't running, through the resume
// route (W66; W107 for background ones), as the session view's Resume in background does.
//
// - Busy, the spinner in the icon's place, aria-busy and aria-disabled, while the request is out, and
//   once it has resumed until the row goes, as the snapshot lists the session as running, or
//   RESUME_LISTED_MS has passed.
// - Every result is a toast, since the row has no room for an alert: "Resumed name in the
//   background.", or an error toast with the server's reason, and, when it's a folder Claude Code
//   doesn't trust, where to find the command that trusts it: in the session's view.

import { useContext, useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { plainText } from '../format.js';
import { resumeSession, type ResumeOutcome } from '../spawn.js';
import { RESUME_LISTED_MS, resumeToast } from './EndedSession.js';
import { Icon } from './Icon.js';
import { Spinner } from './Spinner.js';
import { useToast, type ToastInput } from './Toast.js';
import { Tooltip } from './Tooltip.js';

/** "Resume pitwall-test-app in the background": the button's name and tooltip. */
export const rowResumeLabel = (name: string) => `Resume ${plainText(name)} in the background`;

/** After a refusal that came with a command to run, as for a folder Claude Code doesn't trust. */
export const RESUME_HINT_IN_VIEW = 'Open it for the command that trusts its folder.';

/** Whether a row offers Resume: a finished session that can come back, an ended interactive one or a background one that isn't running, whose directory is still there. */
export function canResumeFromRow(session: SessionSummary): boolean {
  if (!session.finished || session.cwdMissing === true) return false;
  return session.ended === true || (session.kind === 'background' && !session.alive);
}

/** The toast for a resume from a row: resumeToast()'s, with where to find a trust command. */
export function rowResumeToast(name: string, outcome: ResumeOutcome): ToastInput | undefined {
  const toast = resumeToast(name, outcome);
  if (toast === undefined || outcome.kind !== 'refused' || outcome.hint === undefined) return toast;
  return { ...toast, message: `${toast.message} ${RESUME_HINT_IN_VIEW}` };
}

export function RowResume({ session, className }: { session: SessionSummary; className?: string }) {
  const api = useContext(ApiContext);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const { sessionId, name } = session;
  const label = rowResumeLabel(name);

  const run = () => {
    if (running.current || !api) return;
    running.current = true;
    setBusy(true);
    void resumeSession(api, sessionId).then((outcome) => {
      const said = rowResumeToast(name, outcome);
      if (said) toast(said);
      const done = () => {
        running.current = false;
        if (alive.current) setBusy(false);
      };
      // Resumed, it stays busy until the snapshot lists it as running, which takes the button away.
      if (outcome.kind === 'resumed') setTimeout(done, RESUME_LISTED_MS);
      else done();
    });
  };

  return (
    <Tooltip content={label} relation="label">
      <button
        type="button"
        className={['icon-button', 'ghost', 'sm', 'row-resume', className].filter(Boolean).join(' ')}
        aria-busy={busy || undefined}
        aria-disabled={busy || undefined}
        data-resume-session={sessionId}
        onClick={run}
      >
        {busy ? <Spinner size="button" /> : <Icon name="restart" />}
      </button>
    </Tooltip>
  );
}
