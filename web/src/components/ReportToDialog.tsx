// Report to… (W218, leads.ts): make a session a worker for a lead you pick from those pitwall lists, in
// the design system's radio group. Allowed on a finished session too. Its first step records the link
// only: nothing is sent to either session. Refused, the server's `error` shows in the dialog, as it is.
//
// Then (W218 piece 2) a second step offers the paragraph the server writes about the lead it reports to
// (workerBriefPath()), so the worker knows where to send its reports. A running interactive session can
// be sent it, as you, through the relay (D8), only on Send; Not now sends nothing. So can a running
// background session (W226): the relay reaches it by name, and the server accepts only this paragraph for
// it. A session that isn't running gets the text and Copy. The page sends the server's text as the
// server gave it, never its own.

import { useContext, useRef, useState } from 'react';
import { workerBriefPath, type SessionSummary } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import { canTellWorker, sendRelay, STATUS_TEXT } from '../relay.js';
import { groupLabel, type Listed } from '../sessions.js';
import { ApiContext } from '../api.js';
import { Alert } from './Alert.js';
import { Button } from './Button.js';
import { CopyButton } from './CopyButton.js';
import { Dialog } from './Dialog.js';
import { RadioGroup } from './RadioGroup.js';
import { Spinner } from './Spinner.js';
import { useToast } from './Toast.js';
import { BriefText, useWorkerBrief } from './WorkerBrief.js';

export const REPORT_TO_TITLE = 'Report to a lead';
export const REPORT_TO_CONFIRM = 'Report to lead';
export const REPORT_TO_HINT = 'pitwall lists it under the lead you pick. Nothing is sent to either session.';

/** The second step's title, and its buttons. */
export const TELL_WORKER_TITLE = 'Tell it where to report';
export const TELL_WORKER_SEND = 'Send';
export const TELL_WORKER_NOT_NOW = 'Not now';
export const TELL_WORKER_COPY = 'Copy message';
/** What the second step says over the paragraph. */
export const tellWorkerHint = (name: string, copyOnly: boolean) =>
  copyOnly
    ? `${name} isn't running, so pitwall can't send this to it. Copy it and paste it in the session once it runs, so it knows where to report.`
    : `Send this to ${name} as you, so it knows where to report? Nothing is sent until you choose Send.`;
/** The toast once it's sent. */
export const toldWorkerText = (name: string, held: boolean) => (held ? `Sent to ${name}, held for approval in its terminal.` : `Sent to ${name}.`);

export interface ReportToDialogProps {
  session: SessionSummary;
  /** The leads to pick from (leads.ts' leadChoices()). */
  leads: readonly Listed[];
  /** Sends it: resolves undefined once done, or the text to show. */
  onReport: (leadId: string) => Promise<string | undefined>;
  onClose: () => void;
}

export function ReportToDialog({ session, leads, onReport, onClose }: ReportToDialogProps) {
  const [value, setValue] = useState(() => (leads.some((lead) => lead.session.sessionId === session.workerOf?.lead) ? (session.workerOf?.lead ?? '') : (leads[0]?.session.sessionId ?? '')));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [linked, setLinked] = useState(false);
  const submit = async () => {
    if (value === '' || busy) return;
    setBusy(true);
    setError(undefined);
    const failed = await onReport(value);
    setBusy(false);
    if (failed === undefined) setLinked(true);
    else setError(failed);
  };
  if (linked) return <TellWorker session={session} onClose={onClose} />;
  return (
    <Dialog
      title={REPORT_TO_TITLE}
      subtitle={<bdi>{plainText(session.name)}</bdi>}
      size="sm"
      onClose={onClose}
      busy={busy}
      onSubmit={() => void submit()}
      className="report-to-dialog"
      actions={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={busy} busyLabel="Saving…" disabled={value === ''}>
            {REPORT_TO_CONFIRM}
          </Button>
        </>
      }
    >
      <RadioGroup
        legend="Lead"
        hint={REPORT_TO_HINT}
        value={value}
        options={leads.map(({ session: lead, group }) => ({ value: lead.sessionId, label: plainText(lead.name), description: plainText(groupLabel(group)) }))}
        onChange={setValue}
      />
      {error !== undefined && (
        <Alert tone="danger" role="alert" className="report-to-failure">
          {plainText(error)}
        </Alert>
      )}
    </Dialog>
  );
}

/** The second step: the paragraph, with Send for a running interactive session, or Copy for the rest. */
function TellWorker({ session, onClose }: { session: SessionSummary; onClose: () => void }) {
  const api = useContext(ApiContext);
  const toast = useToast();
  const brief = useWorkerBrief(workerBriefPath(session.sessionId));
  const textRef = useRef<HTMLParagraphElement>(null);
  const [sending, setSending] = useState(false);
  // After a send that didn't go through, or may have: what to say, and whether Send is still offered.
  const [failure, setFailure] = useState<{ text: string; again: boolean }>();
  const name = plainText(session.name);
  const sendable = canTellWorker(session);

  const send = async () => {
    if (brief.kind !== 'ok' || sending || !api) return;
    setSending(true);
    setFailure(undefined);
    const outcome = await sendRelay(api, session.sessionId, brief.text);
    setSending(false);
    if (outcome.kind === 'unauthorized') return onClose();
    if (outcome.kind === 'failed') return setFailure({ text: outcome.error, again: !outcome.uncertain });
    const { status, detail } = outcome.result;
    if (status === 'delivered' || status === 'held') {
      toast({ tone: 'success', message: toldWorkerText(name, status === 'held') });
      return onClose();
    }
    setFailure({ text: detail === undefined ? STATUS_TEXT[status] : `${STATUS_TEXT[status]} ${plainText(detail)}`, again: status !== 'uncertain' });
  };

  const offerSend = brief.kind === 'ok' && sendable && (failure === undefined || failure.again);
  return (
    <Dialog
      title={TELL_WORKER_TITLE}
      subtitle={<bdi>{name}</bdi>}
      size="sm"
      onClose={onClose}
      busy={sending}
      onSubmit={offerSend ? () => void send() : undefined}
      className="report-to-dialog tell-worker-dialog"
      actions={
        offerSend ? (
          <>
            <Button disabled={sending} onClick={onClose}>
              {TELL_WORKER_NOT_NOW}
            </Button>
            <Button type="submit" variant="primary" busy={sending} busyLabel="Sending…">
              {TELL_WORKER_SEND}
            </Button>
          </>
        ) : (
          <Button variant={brief.kind === 'loading' ? 'outline' : 'primary'} onClick={onClose}>
            {brief.kind === 'loading' ? 'Cancel' : 'Done'}
          </Button>
        )
      }
    >
      {brief.kind === 'loading' && (
        <p className="field-hint worker-brief-loading" data-worker-brief="loading">
          <Spinner /> Getting the paragraph about its lead…
        </p>
      )}
      {brief.kind === 'refused' && (
        <Alert tone="warning" className="tell-worker-refused">
          {plainText(brief.error)}
        </Alert>
      )}
      {brief.kind === 'ok' && (
        <div className="field" data-worker-brief="ok">
          <p className="field-hint">{tellWorkerHint(name, !sendable)}</p>
          <div className="worker-brief-copyable">
            <BriefText ref={textRef} text={brief.text} />
            {!sendable && <CopyButton text={brief.text} label={TELL_WORKER_COPY} target={textRef} className="worker-brief-copy" />}
          </div>
        </div>
      )}
      {failure !== undefined && (
        <Alert tone="danger" role="alert" className="report-to-failure">
          {plainText(failure.text)}
        </Alert>
      )}
    </Dialog>
  );
}
