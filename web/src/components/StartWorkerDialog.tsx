// Start a worker… (W218; piece 2, leads.ts): New session for a lead, "For: <lead>", with the paragraph the
// server adds after the first prompt shown read-only above the fields. The request names the lead by id,
// `lead`, and the server writes its own copy of the paragraph; the page never sends the text. When the
// server has no paragraph for that lead, the dialog says why and starts the worker without it.

import { leadBriefPath } from '../../../src/shared/protocol.js';
import { NewSessionDialog, type NewSessionDialogProps } from './NewSessionDialog.js';
import { useWorkerBrief, WorkerBriefNotice } from './WorkerBrief.js';

export interface StartWorkerDialogProps extends Omit<NewSessionDialogProps, 'notice' | 'lead'> {
  /** The lead's session id: the session whose menu it was opened from. */
  leadId: string;
}

export function StartWorkerDialog({ leadId, ...props }: StartWorkerDialogProps) {
  const brief = useWorkerBrief(leadBriefPath(leadId));
  // While it loads, the lead is sent anyway: the server adds the paragraph only if it can, and refuses with why if not.
  return <NewSessionDialog {...props} notice={<WorkerBriefNotice state={brief} />} lead={brief.kind === 'refused' ? undefined : leadId} />;
}
