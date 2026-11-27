// Report to… (W218, leads.ts): make a session a worker for a lead you pick from those pitwall lists, in
// the design system's radio group. Allowed on a finished session too. It records the link only: nothing
// is sent to either session. Refused, the server's `error` shows in the dialog, as it is.

import { useState } from 'react';
import type { SessionSummary } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import { groupLabel, type Listed } from '../sessions.js';
import { Alert } from './Alert.js';
import { Button } from './Button.js';
import { Dialog } from './Dialog.js';
import { RadioGroup } from './RadioGroup.js';

export const REPORT_TO_TITLE = 'Report to a lead';
export const REPORT_TO_CONFIRM = 'Report to lead';
export const REPORT_TO_HINT = 'pitwall lists it under the lead you pick. Nothing is sent to either session.';

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
  const submit = async () => {
    if (value === '' || busy) return;
    setBusy(true);
    setError(undefined);
    const failed = await onReport(value);
    setBusy(false);
    if (failed === undefined) onClose();
    else setError(failed);
  };
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
