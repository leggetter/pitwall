// Page notices (docs/design-system.md, 4: Page notices): what shows in place of the dashboard when
// this tab can't connect. The wordmark, a lead sentence saying what happened, then the detail saying
// what brings the tab back (5: Errors). Everything is text.

import type { ReactNode } from 'react';

export interface NoticeProps {
  /** What happened: one sentence, in the larger size. */
  lead: ReactNode;
  /** What to do, in a sentence or two. */
  detail?: ReactNode;
}

/** A whole-page message in place of the dashboard. */
export function Notice({ lead, detail }: NoticeProps) {
  return (
    <main className="notice">
      <h1 className="brand">pitwall</h1>
      <p className="notice-lead">{lead}</p>
      {detail !== undefined && <p className="notice-detail">{detail}</p>}
    </main>
  );
}

/**
 * The two ways to give this tab the token, for either kind (W51). A per-run token is in the link pitwall
 * printed. A fixed one isn't printed, so it's added to the address by hand. The page can't tell which
 * kind this run has before the tab authenticates, so it says both.
 */
function WaysBack() {
  return (
    <>
      In this tab, open the link pitwall printed when it started, or, if <code>PITWALL_TOKEN</code> is set, add <code>#token=</code> and
      that token to the address.
    </>
  );
}

/** The page was opened without a token, or its tab lost it, as a browser restart can. */
export function NoTokenNotice() {
  return (
    <Notice
      lead="This tab has no token for pitwall."
      detail={
        <>
          <WaysBack /> On a single-user machine, a fixed <code>PITWALL_TOKEN</code> keeps a pinned tab working when pitwall restarts.
        </>
      }
    />
  );
}

/** The server closed the WebSocket with 4401: the token is no good, usually a previous run's. */
export function TokenRejectedNotice() {
  return (
    <Notice
      lead="pitwall rejected this tab's token."
      detail={
        <>
          Unless <code>PITWALL_TOKEN</code> is set, each run of pitwall has its own token, so this usually follows a restart. <WaysBack />
        </>
      }
    />
  );
}
