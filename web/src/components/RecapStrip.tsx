// The recap strip (M5, W111; docs/design-system.md, 4: Recap strip): in the session view between its
// header and its tabs, on every tab, so it's there whatever the view shows (Phil agreed, 2026-10-29:
// "a collapsible strip in the session view between the header and the tabs, not in the terminal or
// the conversation"). Phil, 2026-10-29: "Can you give me a status update? Where are we?"
//
// - **Line 1:** the disclosure button, "Recap", or "Claude Code's recap" when only Claude Code's
//   `away_summary` is there, with aria-expanded; how old it is; and Refresh, an icon button, busy
//   while a new one is coming and off, saying why, while the day's budget is spent.
// - **The headline,** always shown, collapsed too: one line chosen by what it waits on (recap.ts,
//   recapHeadline()): "You need to" and what's next, in the Needs you tone; "Waiting on CI" and the
//   like, quiet; "Done" and where it is, quiet success. "May be out of date" first while it's older
//   than the session's latest turn.
// - **Then, while it's open:** Why, and whichever of Now and Next the headline didn't show.
// - **While the first is on its way,** the strip's line 1 at once, so the tabs don't move twice, and
//   skeleton bars after --pw-delay-spinner; "No recap yet." once none is coming, with why when pitwall
//   can say; and "Couldn't load the recap." with Try again when fetching it failed.
//
// No strip with recaps off, for an ended session, or for one pitwall doesn't recap. Nothing in it is a
// live region, so a snapshot that changes it announces nothing; Refresh's results are toasts. Every
// text from the recap is plain text, in <bdi>, since it names files, PRs and people.

import { useContext, useId, useRef } from 'react';
import type { RecapHealth, RecapSummary, SessionRecap, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { plainText } from '../format.js';
import {
  recapHeadline,
  recapLines,
  REFRESH_RECAP_BUSY,
  REFRESH_RECAP_LABEL,
  useRecap,
  useRecapCollapsed,
  type RecapController,
  type RecapHeadline,
} from '../recap.js';
import type { StorageSource } from '../groupState.js';
import { Badge } from './Badge.js';
import { Icon } from './Icon.js';
import { Spinner } from './Spinner.js';
import { Timestamp } from './Timestamp.js';
import { useToast } from './Toast.js';
import { Tooltip } from './Tooltip.js';
import { useWaiting } from './Waiting.js';

/** The headline's first badge while the recap is older than the session's latest turn, and its hint. */
export const STALE_LABEL = 'May be out of date';
export const STALE_RECAP_HINT = "It's older than the session's latest turn.";

/** The strip's title, by where the recap came from. */
export const RECAP_TITLES: Readonly<Record<SessionRecap['source'], string>> = {
  pitwall: 'Recap',
  'claude-code': "Claude Code's recap",
};

export interface RecapStripProps {
  session: SessionSummary;
  /** The snapshot's RecapHealth: absent with recaps off, and then there's no strip. */
  health: RecapHealth | undefined;
  /** False once the session has left the snapshot: it shows what it had, and asks for nothing. */
  listed: boolean;
  /** In a root tab that isn't open (W38). */
  hidden?: boolean;
  /** Where the collapsed choice is kept; the browser's localStorage by default. */
  storage?: StorageSource;
}

export function RecapStrip({ session, health, listed, hidden = false, storage }: RecapStripProps) {
  const api = useContext(ApiContext);
  const toast = useToast();
  const ref = useRef<HTMLElement>(null);
  const recap = useRecap({ api, session, health, listed, hidden, toast, delayFrom: () => ref.current });
  const [collapsed, setCollapsed] = useRecapCollapsed(storage);
  const headingId = useId();
  const bodyId = useId();
  const { state } = recap;
  const waiting = useWaiting(ref, state.kind === 'loading');
  if (state.kind === 'off') return null;

  const shown = state.kind === 'shown' ? state.recap : undefined;
  const summary = state.kind === 'loading' ? state.summary : undefined;
  const source = shown?.source ?? summary?.source ?? 'pitwall';
  const at = shown?.at ?? summary?.at;
  const headline = shown ? recapHeadline(shown) : summary ? summaryHeadline(summary) : undefined;
  const lines = shown && headline ? recapLines(shown, headline) : [];
  // Something under the headline to open: its lines, or, while it loads, the lines it will have. Claude Code's says only where it is.
  const openable = lines.length > 0 || (summary !== undefined && summary.source === 'pitwall');
  const open = openable && !collapsed;
  const title = RECAP_TITLES[source];

  return (
    <section ref={ref} className="session-recap" aria-labelledby={headingId} data-recap={state.kind} data-collapsed={openable ? collapsed : undefined}>
      <div className="recap-head">
        <h3 className="recap-heading" id={headingId}>
          {openable ? (
            <button type="button" className="recap-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setCollapsed(!collapsed)}>
              <Icon name="expand" className="chevron" />
              {title}
            </button>
          ) : (
            <span className="recap-title">{title}</span>
          )}
        </h3>
        {at !== undefined && <Timestamp className="recap-age" at={at} />}
        <RefreshButton recap={recap} />
      </div>

      {headline ? (
        <Headline headline={headline} stale={recap.stale} />
      ) : state.kind === 'loading' ? (
        <>
          <span className="visually-hidden">Loading the recap</span>
          {waiting.shown && (
            <span className="recap-skeleton" aria-hidden="true">
              <span className="skeleton-bar recap-skeleton-headline" />
            </span>
          )}
        </>
      ) : state.kind === 'none' ? (
        <p className="recap-note">
          No recap yet.{state.why !== undefined && <> {state.why}</>}
        </p>
      ) : state.kind === 'failed' ? (
        <p className="recap-note">
          Couldn&apos;t load the recap{state.status === undefined ? '' : ` (HTTP ${state.status})`}.{' '}
          <button type="button" className="link-button" onClick={recap.retry}>
            Try again
          </button>
        </p>
      ) : null}

      {openable && (
        <div className="recap-body" id={bodyId} hidden={!open}>
          {shown ? (
            <dl className="recap-lines">
              {lines.map((line) => (
                <div className="recap-line" key={line.label}>
                  <dt>{line.label}</dt>
                  <dd>
                    <bdi>{plainText(line.text)}</bdi>
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            waiting.shown && (
              <span className="recap-skeleton" aria-hidden="true">
                <span className="skeleton-bar recap-skeleton-line" />
                <span className="skeleton-bar recap-skeleton-line short" />
              </span>
            )
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The headline from the snapshot's summary alone, while the whole recap is on its way: the summary
 * carries `next` only when the recap waits on you (D14), so that's the only one it can show.
 */
function summaryHeadline(summary: RecapSummary): RecapHeadline | undefined {
  if (summary.source !== 'pitwall' || summary.waitingOn !== 'you' || summary.next === undefined || summary.next.trim() === '') return undefined;
  return recapHeadline({ source: 'pitwall', waitingOn: 'you', now: '', next: summary.next });
}

/**
 * The headline: "May be out of date" while it's stale, the label as a badge in its tone, then the
 * text, one line with an ellipsis while the strip is collapsed, its whole in a tooltip when it's cut.
 * Screen readers hear "May be out of date. You need to: …".
 */
function Headline({ headline, stale }: { headline: RecapHeadline; stale: boolean }) {
  const text = plainText(headline.text);
  return (
    <Tooltip content={text} relation="none" onlyIfCut>
      <p className="recap-headline" data-headline={headline.field}>
        {stale && (
          <>
            <Badge look="outline" hint={STALE_RECAP_HINT} className="recap-stale">
              {STALE_LABEL}
            </Badge>
            <span className="visually-hidden">. </span>
          </>
        )}
        <Badge look={headline.look} className="recap-label">
          {headline.label}
        </Badge>
        <span className="visually-hidden">: </span>
        <span className="recap-headline-text">
          <bdi>{text}</bdi>
        </span>
      </p>
    </Tooltip>
  );
}

/** Refresh: a ghost sm icon button, its spinner while a new recap is coming, off while the day's budget is spent, saying why. */
function RefreshButton({ recap }: { recap: RecapController }) {
  const { refreshing, refreshOff } = recap;
  const off = !refreshing && refreshOff !== undefined;
  const tip = refreshing ? REFRESH_RECAP_BUSY : (refreshOff ?? REFRESH_RECAP_LABEL);
  return (
    // Its name, always; while it's busy or off, the tooltip says why, and describes it.
    <Tooltip content={tip} relation={refreshing || off ? 'description' : 'label'}>
      <button
        type="button"
        className="icon-button ghost sm recap-refresh"
        aria-label={REFRESH_RECAP_LABEL}
        aria-disabled={refreshing || off || undefined}
        aria-busy={refreshing || undefined}
        data-recap-refresh=""
        onClick={() => {
          if (!refreshing && !off) recap.refresh();
        }}
      >
        {refreshing ? <Spinner size="button" /> : <Icon name="retry" />}
      </button>
    </Tooltip>
  );
}
