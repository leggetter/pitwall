// The paragraph a worker is given about its lead (W218 piece 2, leads.ts; docs/design-system.md, 4: Leads and
// workers): read once from the server as its dialog opens, and shown read-only. New session's Start a
// worker… shows it above the fields, "Added after your prompt", or, when the server has none, why, and
// that the worker starts without it. Report to…'s second step shows it as the message it offers to send.

import { useContext, useEffect, useState, type Ref } from 'react';
import { ApiContext } from '../api.js';
import { plainText } from '../format.js';
import { BRIEF_LABEL, BRIEF_WITHOUT, getBrief, type BriefOutcome } from '../leads.js';
import { Alert } from './Alert.js';
import { Spinner } from './Spinner.js';

export type BriefState = { kind: 'loading' } | BriefOutcome;

/** The loading line, and why Start session waits for it. */
export const BRIEF_LOADING = 'Getting the paragraph about its lead…';

/** The paragraph at `path` (leadBriefPath() or workerBriefPath()), read once; undefined `path` reads nothing. */
export function useWorkerBrief(path: string | undefined): BriefState {
  const api = useContext(ApiContext);
  const [state, setState] = useState<BriefState>({ kind: 'loading' });
  useEffect(() => {
    if (path === undefined) return undefined;
    if (!api) {
      setState({ kind: 'refused', error: "pitwall can't reach the server from here." });
      return undefined;
    }
    const abort = new AbortController();
    setState({ kind: 'loading' });
    void getBrief(api, path, abort.signal).then((outcome) => {
      if (!abort.signal.aborted) setState(outcome);
    });
    return () => abort.abort();
  }, [api, path]);
  return state;
}

/** The paragraph's text, as text, in the quiet box approvals use. */
export function BriefText({ text, id, ref }: { text: string; id?: string | undefined; ref?: Ref<HTMLParagraphElement> | undefined }) {
  return (
    <p ref={ref} id={id} className="worker-brief-text">
      {plainText(text)}
    </p>
  );
}

/** New session's notice from Start a worker…: the paragraph it adds after the prompt, or why there's none. */
export function WorkerBriefNotice({ state }: { state: BriefState }) {
  if (state.kind === 'loading') {
    return (
      <p className="worker-brief worker-brief-loading field-hint" data-worker-brief="loading">
        <Spinner /> {BRIEF_LOADING}
      </p>
    );
  }
  if (state.kind === 'refused') {
    return (
      <div className="worker-brief" data-worker-brief="refused">
        <Alert tone="warning">
          {plainText(state.error)} {BRIEF_WITHOUT}
        </Alert>
      </div>
    );
  }
  return (
    <div className="worker-brief field" data-worker-brief="ok">
      <p className="field-label">{BRIEF_LABEL}</p>
      <BriefText text={state.text} />
    </div>
  );
}
