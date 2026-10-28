// The session view's Sub-agents tab (W77; docs/design-system.md, 4: Sub-agents): the sub-agents the
// session started, as one flat list, running ones first, then the newest started first; and, opened
// from a row or from a link in the conversation, one sub-agent's transcript, read-only, in the
// conversation's own panel, with Load earlier and Jump to latest, and Back to the list.
//
// - The list comes from subagentsPath() (subagents.ts): once when the view opens, so the tab shows only
//   for a session that has any, again when the tab is opened, and while it's open and any are running,
//   at the pace of the index's polls (SessionView.tsx decides when; useSubagents fetches).
// - Each row: the description, its state badge and when it was last active, in the row's fixed time
//   slot; then its type, its tool calls and when it started; and for one another sub-agent started,
//   "Started by *description*". The rows are buttons named by the description, one Tab stop for the
//   list (roving tabindex), ↓ and ↑, Home and End moving between them, as the repo list's do.
// - Its states: loading, after --pw-delay-spinner, then what's slow; a failure with Try again, danger
//   when nothing is shown and warning when the list is kept; the empty state; and a note at the end
//   when the oldest were left out (SubagentList.truncated).
// - Focus never drops to the page: opening a row puts it on the transcript's heading, Back on that
//   sub-agent's row, and a row or an alert that a refresh takes away hands it to the row that took
//   its place, the list's first, or the list itself (6.1, item 8).

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { SubagentList, SubagentSummary } from '../../../src/shared/protocol.js';
import type { ApiClient } from '../api.js';
import { getSubagentConversation } from '../conversation.js';
import { getSubagents, startedByName, subagentBadge, subagentName, tabCount, toolCallsText } from '../subagents.js';
import { Alert } from './Alert.js';
import { StatusBadge } from './Badge.js';
import { Button } from './Button.js';
import { ConversationPanel, failedText, SubagentName, TryAgain, useConversation, type LoadFailure, type PageLoader, type SubagentRef } from './Conversation.js';
import { EmptyState } from './EmptyState.js';
import { Timestamp } from './Timestamp.js';
import { Tooltip } from './Tooltip.js';
import { useWaiting } from './Waiting.js';

/**
 * - `idle`: nothing has been asked for yet.
 * - `loading`: the first list hasn't arrived.
 * - `ready`: a list has arrived; a refresh that failed since keeps it, with `failure` set.
 * - `failed`: the first list couldn't be loaded.
 * - `unavailable`: there's no API client, as in tests that render a view alone.
 */
type Status = 'idle' | 'loading' | 'ready' | 'failed' | 'unavailable';

export interface SubagentsState {
  status: Status;
  /** The newest list that arrived. */
  list?: SubagentList;
  /** Why the newest fetch failed, until one works: the first (status 'failed'), or a refresh, which keeps the list. */
  failure?: LoadFailure;
  /** Try again is out: its button is busy. */
  retrying: boolean;
  /** How many times Try again has failed: the alert is keyed by it, so a failure that says the same is announced again. */
  attempts: number;
}

export interface SubagentsController {
  state: SubagentsState;
  /** The first fetch, unless one has been made: when the view opens, or its tab does first. */
  ensure: () => void;
  /** Another fetch, once the first has been made: the tab opened, a poll while any run, one that started or ended. */
  refresh: () => void;
  /** Try again, on the failure's alert: busy until the list arrives or it fails again. */
  retry: () => void;
}

/**
 * A session's sub-agents, fetched when asked. Only the newest request counts, and nothing after the
 * view has gone. `signal` aborts the requests when the view closes.
 */
export function useSubagents(api: ApiClient | undefined, sessionId: string, signal: () => AbortSignal | undefined): SubagentsController {
  const [state, setState] = useState<SubagentsState>(() => ({ status: api ? 'idle' : 'unavailable', retrying: false, attempts: 0 }));
  const stateRef = useRef(state);
  const commit = useCallback((next: SubagentsState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const made = useRef(false);
  const latest = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!api) return;
    made.current = true;
    const request = ++latest.current;
    const before = stateRef.current;
    if (before.status === 'idle' || before.status === 'failed') commit({ ...before, status: before.status === 'idle' ? 'loading' : before.status });
    const result = await getSubagents(api, sessionId, signal());
    if (!alive.current || request !== latest.current) return;
    const now = stateRef.current;
    if (result.kind === 'ok') {
      commit({ status: 'ready', list: result.list, retrying: false, attempts: now.attempts });
      return;
    }
    if (result.kind === 'unauthorized') {
      // The app has already replaced the dashboard with the token notice.
      commit({ ...now, status: now.list ? 'ready' : 'idle', retrying: false });
      return;
    }
    const failure: LoadFailure = result.kind === 'not-found' ? { status: 404 } : {};
    if (result.kind === 'failed') {
      if (result.status !== undefined) failure.status = result.status;
      if (result.error !== undefined) failure.error = result.error;
    }
    // A Try again that failed: its alert is a new one, announced again even when it says the same.
    const attempts = now.retrying ? now.attempts + 1 : now.attempts;
    commit({ ...now, status: now.list ? 'ready' : 'failed', failure, retrying: false, attempts });
  }, [api, sessionId, signal, commit]);

  const ensure = useCallback(() => {
    if (!made.current) void load();
  }, [load]);
  const refresh = useCallback(() => {
    if (made.current) void load();
  }, [load]);
  const retry = useCallback(() => {
    const current = stateRef.current;
    if (current.retrying) return;
    commit({ ...current, retrying: true });
    void load();
  }, [commit, load]);
  return { state, ensure, refresh, retry };
}

/** The tab's count, once a list has arrived: "6", or "200+" when the oldest were left out. Nothing for none. */
export function subagentsCount(state: SubagentsState): string | undefined {
  return state.list && state.list.subagents.length > 0 ? tabCount(state.list) : undefined;
}

/** What the list says when the server left out the oldest (SubagentList.truncated). */
export function truncatedNote(list: SubagentList): string {
  return `This session has more than ${list.subagents.length.toLocaleString('en-US')} sub-agents, so the oldest are left out.`;
}

/**
 * Who a 'user' entry in a sub-agent's transcript is from (the contract's subagentConversationPath()):
 * what started or messaged it, never the user's own prompt. "From the session", or, for one another
 * sub-agent started, that one, with a link to its transcript; when the list doesn't say, either.
 */
export const FROM_SESSION = 'From the session';
export const FROM_UNKNOWN = 'From the session or a sub-agent';

function userSpeakerOf(listed: SubagentSummary | undefined, all: readonly SubagentSummary[]): ReactNode {
  if (!listed) return FROM_UNKNOWN;
  if (listed.startedBy === undefined) return FROM_SESSION;
  const parent = all.find((each) => each.agentId === listed.startedBy);
  if (!parent) return 'From another sub-agent';
  return (
    <>
      {'From sub-agent: '}
      <SubagentName subagent={{ agentId: parent.agentId, description: parent.description }} />
    </>
  );
}

/** The empty state's words, for a tab shown for a session whose list came back empty. */
export const NO_SUBAGENTS = { title: 'No sub-agents', sentence: 'Sub-agents this session starts show here, with their state and transcripts.' } as const;

interface RowProps {
  subagent: SubagentSummary;
  /** Everything listed, for the description of the sub-agent that started this one. */
  all: readonly SubagentSummary[];
  /** The list's Tab stop. */
  stop: boolean;
  onOpen: (subagent: SubagentSummary) => void;
  onKey: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onFocus: () => void;
}

/** Clicks on these inside a row do their own thing, rather than opening the sub-agent. */
const OWN_CLICK = 'a, button, input, select, textarea, label, summary, [role="button"]';

/** " · " between the parts of a line, which a screen reader hears as a comma. */
function Sep() {
  return (
    <>
      <span className="subagent-sep" aria-hidden="true">
        {' · '}
      </span>
      <span className="visually-hidden">, </span>
    </>
  );
}

function SubagentRow({ subagent, all, stop, onOpen, onKey, onFocus }: RowProps) {
  const ids = { status: useId(), meta: useId(), parent: useId() };
  const name = subagentName(subagent.description);
  const badge = subagentBadge(subagent.state);
  const type = subagent.agentType === undefined ? undefined : subagentName(subagent.agentType);
  const parent = subagent.startedBy === undefined ? undefined : startedByName(all, subagent.startedBy);
  const openFromRow = (event: MouseEvent<HTMLLIElement>) => {
    if (event.target instanceof Element && event.target.closest(OWN_CLICK)) return;
    // Selecting text to copy it isn't a click on the row.
    if ((window.getSelection()?.toString() ?? '') !== '') return;
    onOpen(subagent);
  };
  return (
    <li className={subagent.state === 'running' ? 'subagent running' : 'subagent'} data-agent={subagent.agentId} onClick={openFromRow}>
      <div className="subagent-line">
        <Tooltip content={name} relation="none" onlyIfCut>
          <button
            type="button"
            className="subagent-open"
            tabIndex={stop ? 0 : -1}
            // The rest of the row, so it's heard with the name: its state, when it was last active, its type,
            // its tool calls, when it started, and what started it.
            aria-describedby={[ids.status, ids.meta, parent !== undefined && ids.parent].filter(Boolean).join(' ')}
            onClick={() => onOpen(subagent)}
            onKeyDown={onKey}
            onFocus={onFocus}
          >
            {name}
          </button>
        </Tooltip>
        <span className="subagent-status" id={ids.status}>
          {badge && <StatusBadge badge={badge} />}
          {subagent.lastActivityAt !== undefined && (
            <>
              <span className="visually-hidden">, active </span>
              <Timestamp className="activity" at={subagent.lastActivityAt} />
            </>
          )}
        </span>
      </div>
      <p className="subagent-meta" id={ids.meta}>
        {type !== undefined && (
          <>
            <span className="subagent-type">{type}</span>
            <Sep />
          </>
        )}
        <span>{toolCallsText(subagent.toolCalls)}</span>
        {subagent.startedAt !== undefined && (
          <>
            <Sep />
            <Timestamp at={subagent.startedAt} prefix="Started " />
          </>
        )}
      </p>
      {parent !== undefined && (
        <Tooltip content={`Started by ${parent}`} relation="none" onlyIfCut>
          <p className="subagent-parent" id={ids.parent}>
            Started by <span className="subagent-parent-name">{parent}</span>
          </p>
        </Tooltip>
      )}
    </li>
  );
}

/** Where focus was in the list as it rendered: on a row, by its sub-agent and place, or elsewhere in it, such as an alert's button. */
interface HeldFocus {
  agent: string | undefined;
  index: number;
}

interface ListProps {
  controller: SubagentsController;
  onOpen: (subagent: SubagentRef) => void;
  /** The sub-agent whose row takes focus as the list appears: the one whose transcript Back left. */
  returnTo: string | undefined;
}

/** The list, with its loading, failed, empty and truncated states. */
function SubagentListBody({ controller, onOpen, returnTo }: ListProps) {
  const { state, retry } = controller;
  const body = useRef<HTMLDivElement>(null);
  const subagents = useMemo(() => state.list?.subagents ?? [], [state.list]);
  const [stop, setStop] = useState<string | undefined>(returnTo);
  const tabStop = subagents.some((each) => each.agentId === stop) ? stop : subagents[0]?.agentId;
  const waiting = useWaiting(body, state.status === 'loading');

  // Where focus is in the list as it renders, so a refresh that moves or takes away what has it can put
  // it back: a row React moves loses focus in some browsers, and an alert that goes takes its button.
  const active = typeof document === 'undefined' ? null : document.activeElement;
  const holding: HeldFocus | undefined =
    body.current && active instanceof HTMLElement && active !== body.current && body.current.contains(active)
      ? (() => {
          const agent = active.closest<HTMLElement>('[data-agent]')?.dataset.agent;
          return { agent, index: agent === undefined ? 0 : subagents.findIndex((each) => each.agentId === agent) };
        })()
      : undefined;

  const rowButton = (agentId: string | undefined) =>
    agentId === undefined ? null : (body.current?.querySelector<HTMLButtonElement>(`[data-agent="${agentId}"] .subagent-open`) ?? null);
  const firstRow = () => body.current?.querySelector<HTMLButtonElement>('.subagent-open') ?? null;

  useLayoutEffect(() => {
    if (!holding) return;
    // Still somewhere: nothing to put back.
    const now = document.activeElement;
    if (now && now !== document.body) return;
    // The row it was on, or the one that took its place, the one before, an alert's Try again, the first row, or the list itself.
    const rows = body.current?.querySelectorAll<HTMLButtonElement>('.subagent-open');
    const target =
      rowButton(holding.agent) ??
      (rows && rows.length > 0 ? rows[Math.min(Math.max(holding.index, 0), rows.length - 1)] : undefined) ??
      body.current?.querySelector<HTMLButtonElement>('.subagents-alert button') ??
      firstRow() ??
      body.current;
    target?.focus();
  });

  // Back from a transcript: that sub-agent's row, or the first, or the list itself.
  useLayoutEffect(() => {
    if (returnTo === undefined) return;
    (rowButton(returnTo) ?? firstRow() ?? body.current)?.focus();
    // Only as the list appears, which it does as Back is pressed.
  }, []);

  const onKey = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const last = subagents.length - 1;
    const to = { ArrowDown: Math.min(index + 1, last), ArrowUp: Math.max(index - 1, 0), Home: 0, End: last }[event.key];
    if (to === undefined) return;
    // Not the list's scroll: focus moves, and the browser scrolls the row it lands on into view.
    event.preventDefault();
    const target = subagents[to];
    if (!target) return;
    setStop(target.agentId);
    rowButton(target.agentId)?.focus();
  };

  const open = (subagent: SubagentSummary) => onOpen({ agentId: subagent.agentId, description: subagent.description });
  const shown = subagents.length > 0;

  return (
    <div
      ref={body}
      className="session-view-body subagents-body"
      // With rows, they're the Tab stop; without, the list is, so its status or empty state can be reached and read.
      tabIndex={shown ? -1 : 0}
    >
      {state.status === 'failed' && (
        <Alert
          key={`failed-${state.attempts}`}
          tone="danger"
          role="alert"
          className="subagents-alert"
          actions={<TryAgain busy={state.retrying} onClick={retry} />}
        >
          {failedText('load the sub-agents', state.failure)}
        </Alert>
      )}
      {state.status === 'ready' && state.failure !== undefined && (
        <Alert
          key={`refresh-${state.attempts}`}
          tone="warning"
          role="alert"
          className="subagents-alert"
          actions={<TryAgain busy={state.retrying} onClick={retry} />}
        >
          {failedText('refresh the sub-agents', state.failure, ', so they may be out of date.')}
        </Alert>
      )}
      {state.status === 'ready' && !shown && (
        <div className="subagents-empty">
          <EmptyState icon="subagents" title={NO_SUBAGENTS.title} sentence={NO_SUBAGENTS.sentence} />
        </div>
      )}
      {shown && (
        <ul className="subagent-list" aria-label="Sub-agents">
          {subagents.map((subagent, index) => (
            <SubagentRow
              key={subagent.agentId}
              subagent={subagent}
              all={subagents}
              stop={subagent.agentId === tabStop}
              onOpen={open}
              onKey={onKey(index)}
              onFocus={() => setStop(subagent.agentId)}
            />
          ))}
        </ul>
      )}
      {state.list?.truncated === true && shown && (
        <Alert tone="neutral" className="subagents-truncated">
          {truncatedNote(state.list)}
        </Alert>
      )}
      <div className="conversation-status" role="status">
        {state.status === 'loading' && waiting.shown && <p className="status-line">Loading the sub-agents…</p>}
        {state.status === 'loading' && waiting.long && <p className="status-line">Still waiting for the sub-agents&apos; transcripts…</p>}
        {state.status === 'unavailable' && <p className="status-line">The sub-agents can&apos;t be loaded here.</p>}
      </div>
    </div>
  );
}

interface TranscriptProps {
  api: ApiClient | undefined;
  sessionId: string;
  subagent: SubagentRef;
  /** It as listed, when it is: its state, type, counts and times. */
  listed: SubagentSummary | undefined;
  all: readonly SubagentSummary[];
  hidden: boolean;
  /** Bumped each time it's opened, from a row or a link, even when it's open already: its heading takes focus. */
  opened: number;
  signal: () => AbortSignal | undefined;
  onBack: () => void;
}

/** One sub-agent's transcript, read-only: Back, its description as the heading, its state and the rest, then its conversation. */
function SubagentTranscript({ api, sessionId, subagent, listed, all, hidden, opened, signal, onBack }: TranscriptProps) {
  const ids = { title: useId(), panel: useId() };
  const heading = useRef<HTMLHeadingElement>(null);
  const { agentId } = subagent;
  const loader = useMemo<PageLoader | undefined>(
    () => (api ? (before) => getSubagentConversation(api, sessionId, agentId, before, signal()) : undefined),
    [api, sessionId, agentId, signal],
  );
  // The newest page again whenever its activity moves, as the list, refreshed while any run, says.
  const conversation = useConversation(listed?.lastActivityAt, loader);
  const name = subagentName(listed?.description ?? subagent.description);
  const badge = listed ? subagentBadge(listed.state) : undefined;
  const parent = listed?.startedBy === undefined ? undefined : startedByName(all, listed.startedBy);

  // Opened from a row or a link: its heading takes focus, as the view's does when it opens from a row.
  useLayoutEffect(() => {
    heading.current?.focus();
  }, [opened]);

  return (
    <div className="subagent-transcript">
      <div className="subagent-bar">
        <div className="subagent-bar-top">
          <Button variant="ghost" size="sm" icon="back" className="subagent-back" onClick={onBack}>
            Back to sub-agents
          </Button>
          <span className="subagent-bar-status">
            {badge && <StatusBadge badge={badge} />}
            {listed?.lastActivityAt !== undefined && <Timestamp className="activity" at={listed.lastActivityAt} prefix="Active " />}
          </span>
        </div>
        <h3 className="subagent-title" id={ids.title} ref={heading} tabIndex={-1}>
          {name}
        </h3>
        {listed && (
          <p className="subagent-meta">
            {listed.agentType !== undefined && (
              <>
                <span className="subagent-type">{subagentName(listed.agentType)}</span>
                <Sep />
              </>
            )}
            <span>{toolCallsText(listed.toolCalls)}</span>
            {listed.startedAt !== undefined && (
              <>
                <Sep />
                <Timestamp at={listed.startedAt} prefix="Started " />
              </>
            )}
            {parent !== undefined && (
              <>
                <Sep />
                <span>
                  Started by <span className="subagent-parent-name">{parent}</span>
                </span>
              </>
            )}
          </p>
        )}
      </div>
      <ConversationPanel
        conversation={conversation}
        id={ids.panel}
        labelledBy={ids.title}
        role="region"
        hidden={hidden}
        emptyLine="Nothing to show yet."
        missingLine="No transcript for this sub-agent."
        userSpeaker={userSpeakerOf(listed, all)}
      />
    </div>
  );
}

export interface SubagentsPanelProps {
  api: ApiClient | undefined;
  sessionId: string;
  controller: SubagentsController;
  /** The tab panel's id, which the Sub-agents tab controls, and the tab's, which names it. */
  id: string;
  labelledBy: string;
  hidden: boolean;
  /** The sub-agent whose transcript is open, or none for the list. */
  open: SubagentRef | undefined;
  /** Bumped each time a transcript is opened, from a row or a link, so its heading takes focus. */
  opened: number;
  onOpen: (subagent: SubagentRef) => void;
  onBack: () => void;
  /** The sub-agent whose row takes focus as the list comes back. */
  returnTo: string | undefined;
  signal: () => AbortSignal | undefined;
}

/** The Sub-agents tab's panel: the list, or one sub-agent's transcript. */
export function SubagentsPanel({ api, sessionId, controller, id, labelledBy, hidden, open, opened, onOpen, onBack, returnTo, signal }: SubagentsPanelProps) {
  const all = controller.state.list?.subagents ?? [];
  return (
    <div className="session-view-subagents" role="tabpanel" id={id} aria-labelledby={labelledBy} hidden={hidden}>
      {open ? (
        <SubagentTranscript
          key={open.agentId}
          api={api}
          sessionId={sessionId}
          subagent={open}
          listed={all.find((each) => each.agentId === open.agentId)}
          all={all}
          hidden={hidden}
          opened={opened}
          signal={signal}
          onBack={onBack}
        />
      ) : (
        <SubagentListBody controller={controller} onOpen={onOpen} returnTo={returnTo} />
      )}
    </div>
  );
}
