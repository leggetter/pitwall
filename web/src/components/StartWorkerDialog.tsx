// Start a worker… (W218; piece 2, leads.ts): New session for a lead, "For: <lead>", with the paragraph the
// server adds after the first prompt shown read-only above the fields. The request names the lead by id,
// `lead`, with `leadName`, the lead's name the paragraph showed, and the server writes its own copy of the
// paragraph; the page never sends the text. Start session waits while the paragraph loads, and the server
// starts nothing when the lead's name has changed since (the review's F3). When the server has no
// paragraph for that lead, the dialog says why and starts the worker without it.

import { leadBriefPath } from '../../../src/shared/protocol.js';
import { NewSessionDialog, type NewSessionDialogProps } from './NewSessionDialog.js';
import { BRIEF_LOADING, useWorkerBrief, WorkerBriefNotice } from './WorkerBrief.js';

export interface StartWorkerDialogProps extends Omit<NewSessionDialogProps, 'notice' | 'lead'> {
  /** The lead's session id: the session whose menu it was opened from. */
  leadId: string;
}

export function StartWorkerDialog({ leadId, ...props }: StartWorkerDialogProps) {
  const brief = useWorkerBrief(leadBriefPath(leadId));
  // Start waits for the paragraph; then the lead goes with the name it showed, or, after a refusal, not at all.
  return (
    <NewSessionDialog
      {...props}
      notice={<WorkerBriefNotice state={brief} />}
      waiting={brief.kind === 'loading' ? BRIEF_LOADING : undefined}
      lead={brief.kind === 'ok' ? { id: leadId, name: brief.leadName } : undefined}
    />
  );
}
