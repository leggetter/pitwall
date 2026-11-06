// The supervisor's view (M5, W114; docs/design-system.md, 4: Supervisor): its conversation with you, in
// the third column, in a session view's or a PR view's place and frame, from `?supervisor`
// (supervisor.ts). Phil, 2026-10-29: "the point is to create a customized workflow that isn't just
// typing into a terminal and having a specialized UI".
//
// - The header: "Supervisor", its status, this run's cost, its context (W136) once its first call of the
//   run has said, New conversation, and Start while it's off or has failed. While
//   it's held, the error, in pitwall's words, with the `claude stop` command it names, to copy, and
//   Start, for once you've run it: pitwall never stops or ends the session that has it. While it's
//   failed, the error, with Start.
// - New conversation (W136): asks first, in the page (InlineConfirm, under the header), then the server
//   stops it and forgets the conversation; the next message or Start begins a new one. Off, saying why,
//   while the snapshot shows it would be refused: held, starting, working, or drafts waiting. A
//   refusal the page couldn't see is a danger alert with the server's reason. The conversation below is
//   drawn afresh (SupervisorConversation, keyed by the conversation), here and in any other tab, where
//   the snapshot's session id going away says so.
// - The conversation: the session view's (Conversation.tsx), from supervisorConversationPath(), with
//   Load earlier, Jump to latest, markdown as pitwall's own elements (D15) and the working line (W102)
//   while it works, from the snapshot's status. A session or PR its replies name opens it (W125,
//   mentions.ts), as its row does. A new conversation has an empty state: what the
//   supervisor is for, and questions that fill the message box.
// - What it sent and started in this run, each session with its state, Needs you's notice and
//   "Open <name> →" (SupervisorHandoffs.tsx, W124), from the snapshot alone.
// - Its approvals: draft cards above the message box (ApprovalCards.tsx).
// - The message box, with Stop while it works (SupervisorBox.tsx).
//
// Opening the view, from the repo list, the URL or the back button, starts nothing: the supervisor
// starts when you press Start or send it a message. Nothing in it is a live region but what the
// conversation and the box announce, so a snapshot that changes its status announces nothing.

import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { PullRequestSummary, SessionSummary, SupervisorState } from '../../../src/shared/protocol.js';
import { createMentions, type MentionTarget } from '../mentions.js';
import { needsAttention } from '../sessions.js';
import { ApiContext } from '../api.js';
import type { WorkingLineState } from '../working.js';
import { getSupervisorConversation } from '../conversation.js';
import { plainText } from '../format.js';
import {
  COST_HINT,
  costText,
  heldCommand,
  NEW_CONVERSATION_CONFIRM,
  NEW_CONVERSATION_DONE,
  NEW_CONVERSATION_LABEL,
  newConversationBlocked,
  newSupervisorConversation,
  SUPERVISOR_CONTEXT_INFO,
  STATUS_LABELS,
  STATUS_LOOKS,
  STATUS_NOTES,
  startSupervisor,
  SUPERVISOR_NAME,
  SUPERVISOR_VIEW_ID,
  supervisorWorkingLine,
} from '../supervisor.js';
import { WORKING_POLL_MS } from '../working.js';
import { Alert } from './Alert.js';
import { ApprovalCards } from './ApprovalCards.js';
import { Badge } from './Badge.js';
import { Button } from './Button.js';
import { ConversationPanel, useConversation, type PageLoader } from './Conversation.js';
import { CodeText } from './CodeText.js';
import { ContextMeta } from './ContextGauge.js';
import { InlineConfirm } from './InlineConfirm.js';
import { useToast } from './Toast.js';
import { focusQuietly, Tooltip } from './Tooltip.js';
import { CopyCommand } from './CopyCommand.js';
import { EmptyState } from './EmptyState.js';
import { Icon } from './Icon.js';
import { InfoTip } from './InfoTip.js';
import { MentionsContext, type MentionsValue } from './Markdown.js';
import { Frame, Top, type SessionViewLayout } from './SessionView.js';
import { SupervisorBox } from './SupervisorBox.js';
import { SupervisorHandoffs } from './SupervisorHandoffs.js';
import { Timestamp } from './Timestamp.js';
import '../supervisor.css';

/** The new conversation's empty state: what the supervisor is for, in a line, and a sentence on how. */
export const SUPERVISOR_EMPTY = {
  title: 'Ask the supervisor about your sessions',
  sentence: "It knows every session pitwall lists, from their recaps, and reads a session's conversation when you ask about it. It drafts messages and new sessions, and sends nothing until you say so.",
} as const;

/** The questions the empty state puts in the message box, never sends. */
export const SUGGESTIONS = ['Which sessions need me, and why?', "What's running, in a sentence each?", 'What should I work on next?'] as const;

/** The held alert's title. */
export const HELD_TITLE = 'Another session has its conversation';
/** What a held supervisor's alert says when its error doesn't. */
export const HELD_FALLBACK = "Another session is running the supervisor's conversation, so pitwall can't. Stop or close it, then press Start.";
/** What a failed supervisor's alert says when its error doesn't. */
export const FAILED_FALLBACK = "The supervisor stopped, or couldn't start.";

/** How long Start stays busy after pitwall took it, waiting for the snapshot to say it's starting. */
export const START_WAIT_MS = 30_000;

export interface SupervisorViewProps {
  /** The snapshot's, as asSupervisorState() reads it. */
  state: SupervisorState;
  onClose: () => void;
  layout?: SessionViewLayout;
  /** 600 px and narrower: Back in Close's place. */
  compact?: boolean;
  /** "Back to sessions", or "Back to pull requests" over the PR list. */
  backLabel?: string | undefined;
  /** The heading, which takes focus when the view is opened from the repo list. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  /** Slide in when it opens over the list; not when it takes another view's place. */
  animate?: boolean;
  /** Whether the message box has a draft, for the shortcuts that would close the view (6.2). */
  onDraftChange?: ((hasDraft: boolean) => void) | undefined;
  /** Every session the snapshot lists, for what it sent and started (W124). */
  sessions?: readonly SessionSummary[] | undefined;
  /** Opens a session's view in this one's place, as its row in the list does (W124). */
  onOpenSession?: ((sessionId: string) => void) | undefined;
  /** Your open PRs, as pitwall lists them, which a reply can name as owner/name#123 (W125). */
  prs?: readonly PullRequestSummary[] | undefined;
  /** Opens a PR's view by its key (prKey()), as its row does. */
  onOpenPr?: ((key: string) => void) | undefined;
}

export function SupervisorView({ state, onClose, layout = 'overlay', compact = false, backLabel, headingRef, animate = true, onDraftChange, sessions = [], onOpenSession, prs, onOpenPr }: SupervisorViewProps) {
  const api = useContext(ApiContext);
  const mentions = useReplyMentions(sessions, onOpenSession, prs, onOpenPr);
  const ids = { title: useId(), conversation: useId(), panel: useId(), suggest: useId() };
  const ownHeading = useRef<HTMLHeadingElement>(null);
  const heading = headingRef ?? ownHeading;
  const field = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const requests = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    requests.current = controller;
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, []);

  const { status } = state;
  // Its pages, with the transcript's own mark of a turn's end left out: its status is pitwall's, from
  // the process it runs, so a message queued behind a turn that has ended still polls (W102).
  const loader = useMemo<PageLoader | undefined>(
    () =>
      api
        ? async (before) => {
            const result = await getSupervisorConversation(api, before, requests.current?.signal);
            if (result.kind !== 'ok' || result.page.turnEnded === undefined) return result;
            const { turnEnded: _ignored, ...page } = result.page;
            return { kind: 'ok', page };
          }
        : undefined,
    [api],
  );
  // Fetched again when a turn ends, its status changes, or you send it a message.
  const [sent, setSent] = useState(0);
  const active = status === 'working' || status === 'starting';
  // Which conversation is shown (W136): a new one after New conversation here, or when the snapshot's
  // session id goes away or changes, as another tab's New conversation does (a tab that missed the
  // snapshot without one, after a sleep, sees it change straight to the new id), so the one left is
  // never shown again.
  const [generation, setGeneration] = useState(0);
  const shownSession = useRef(state.sessionId);
  useEffect(() => {
    if (shownSession.current !== undefined && state.sessionId !== shownSession.current) setGeneration((count) => count + 1);
    shownSession.current = state.sessionId;
  }, [state.sessionId]);

  // New conversation (W136): asked in the page first, never a browser dialog.
  const toast = useToast();
  const [confirmingNew, setConfirmingNew] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [newError, setNewError] = useState<string>();
  const newButton = useRef<HTMLButtonElement>(null);
  const blocked = newConversationBlocked(state);
  // A refusal is about the status it was pressed in: any change of status takes it away.
  useEffect(() => {
    setNewError(undefined);
  }, [status]);
  const openNew = () => {
    if (blocked !== undefined || clearing) return;
    setNewError(undefined);
    setConfirmingNew(true);
  };
  const cancelNew = () => {
    if (clearing) return;
    setConfirmingNew(false);
    focusQuietly(newButton.current);
  };
  const confirmNew = async () => {
    if (!api || clearing) return;
    setClearing(true);
    const outcome = await newSupervisorConversation(api, requests.current?.signal);
    if (!alive.current) return;
    setClearing(false);
    setConfirmingNew(false);
    if (outcome.kind === 'done') {
      setGeneration((count) => count + 1);
      toast({ tone: 'success', message: NEW_CONVERSATION_DONE, key: 'supervisor-new-conversation' });
      // What you do next is write the new conversation's first message.
      field.current?.focus();
    } else if (outcome.kind === 'failed') {
      setNewError(outcome.error);
      focusQuietly(newButton.current);
    } else {
      focusQuietly(newButton.current);
    }
  };

  // Start, while it's off or has failed: busy until the snapshot says it's starting, or the answer fails.
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>();
  // Held too: once you've stopped or closed the session that has it, Start tries again; still held, its 409 says why.
  const startable = status === 'off' || status === 'failed' || status === 'held';
  // A Start's refusal is about the status it was pressed in: any change of status takes it away.
  useEffect(() => {
    setStartError(undefined);
  }, [status]);
  useEffect(() => {
    if (!starting) return;
    if (!startable) {
      setStarting(false);
      return;
    }
    const timer = setTimeout(() => setStarting(false), START_WAIT_MS);
    return () => clearTimeout(timer);
  }, [starting, startable]);
  const start = async () => {
    if (!api || starting) return;
    setStarting(true);
    setStartError(undefined);
    const outcome = await startSupervisor(api, requests.current?.signal);
    if (!alive.current) return;
    if (outcome.kind === 'failed') {
      setStarting(false);
      setStartError(outcome.error);
    } else if (outcome.kind === 'unauthorized') {
      setStarting(false);
    }
  };
  // Start goes once it starts: focus it had goes to the message box, never to the page.
  const startFocus = useRef(false);
  const startShown = startable || starting;
  useLayoutEffect(() => {
    if (startShown || !startFocus.current) return;
    startFocus.current = false;
    const now = document.activeElement;
    if (now === null || now === document.body) field.current?.focus();
  }, [startShown]);
  const startButton = (variant: 'primary' | 'outline') => (
    <Button
      variant={variant}
      size="sm"
      busy={starting}
      busyLabel="Starting…"
      onClick={() => void start()}
      onFocus={() => {
        startFocus.current = true;
      }}
      onBlur={(event) => {
        if (event.relatedTarget !== null) startFocus.current = false;
      }}
      data-supervisor-start=""
    >
      Start
    </Button>
  );

  // The empty state's questions: each fills the message box, and focus goes there.
  const [suggestion, setSuggestion] = useState<{ text: string; at: number }>();
  const suggest = (text: string) => setSuggestion((current) => ({ text, at: (current?.at ?? 0) + 1 }));

  // Escape closes the view, unless the box has a draft (6.2).
  const draft = useRef(false);
  const onDraft = useCallback(
    (has: boolean) => {
      draft.current = has;
      onDraftChange?.(has);
    },
    [onDraftChange],
  );
  const onEscape = () => {
    // The confirmation first, as the session view's (4: Inline confirmation): Escape cancels it, never the view.
    if (confirmingNew) return cancelNew();
    if (!draft.current) onClose();
  };
  const toBox = useCallback(() => field.current?.focus(), []);

  const look = STATUS_LOOKS[status];
  const cost = costText(state.costUsd);
  const command = status === 'held' ? heldCommand(state.error) : undefined;
  const empty = active ? null : (
    <div className="supervisor-empty">
      <EmptyState
        icon="supervisor"
        title={SUPERVISOR_EMPTY.title}
        sentence={SUPERVISOR_EMPTY.sentence}
        actions={
          <div className="supervisor-suggestions">
            <p className="supervisor-suggestions-label" id={ids.suggest}>
              Put a question in the message box:
            </p>
            <ul aria-labelledby={ids.suggest}>
              {SUGGESTIONS.map((question) => (
                <li key={question}>
                  <Button size="sm" onClick={() => suggest(question)} data-suggestion="">
                    {question}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        }
      />
    </div>
  );

  return (
    <Frame layout={layout} id={SUPERVISOR_VIEW_ID} className="supervisor-view" animate={animate} titleId={ids.title} onEscape={onEscape}>
      <header className="session-view-head supervisor-head">
        <Top compact={compact} onClose={onClose} backLabel={backLabel}>
          {/* Focused when the view opens from the repo list, with no ring of its own (6.1, item 8). */}
          <h2 className="session-view-title supervisor-title" id={ids.title} ref={heading} tabIndex={-1}>
            <Icon name="supervisor" className="supervisor-title-icon" />
            <span className="session-view-name">{SUPERVISOR_NAME}</span>
          </h2>
        </Top>
        <div className="session-view-meta">
          <span data-supervisor-status={status}>
            <Badge look={look.look} lead={look.lead}>
              {STATUS_LABELS[status]}
            </Badge>
          </span>
          {cost !== undefined && (
            <span className="supervisor-cost">
              {cost}
              <InfoTip text={COST_HINT} className="session-view-info" />
            </span>
          )}
          {state.contextTokens !== undefined && (
            <span data-supervisor-context={state.contextTokens}>
              <ContextMeta tokens={state.contextTokens} info={SUPERVISOR_CONTEXT_INFO} />
            </span>
          )}
          {state.lastTurnAt !== undefined && <Timestamp className="session-view-activity" at={state.lastTurnAt} prefix="Last turn " />}
          <span className="supervisor-head-actions">
            <Tooltip content={blocked} relation="description">
              <Button
                ref={newButton}
                size="sm"
                variant="ghost"
                icon="add"
                disabled={blocked !== undefined || clearing}
                aria-expanded={confirmingNew}
                onClick={openNew}
                data-supervisor-new=""
              >
                {NEW_CONVERSATION_LABEL}
              </Button>
            </Tooltip>
            {status === 'off' && startButton('primary')}
          </span>
        </div>
        {status === 'off' && <p className="supervisor-note">{STATUS_NOTES.off}</p>}
        {status === 'held' && (
          // There when the view opened, or since: no role, as the app strip says so too.
          <Alert tone="warning" title={HELD_TITLE} className="supervisor-alert" actions={startButton('outline')}>
            <span className="supervisor-error">
              <CodeText text={state.error ?? HELD_FALLBACK} />
            </span>
            {command !== undefined && (
              <span className="supervisor-command">
                <CopyCommand command={command} label="Copy the stop command" />
              </span>
            )}
          </Alert>
        )}
        {status === 'failed' && (
          <Alert tone="danger" className="supervisor-alert" actions={startButton('outline')}>
            <CodeText text={state.error ?? FAILED_FALLBACK} />
          </Alert>
        )}
        {/* Not when it says what the held or failed alert above says already. */}
        {startError !== undefined && startable && !(state.error !== undefined && startError.endsWith(plainText(state.error).trim())) && (
          <Alert tone="danger" role="alert" className="supervisor-alert">
            {startError}
          </Alert>
        )}
      </header>

      {(confirmingNew || newError !== undefined) && (
        <div className="session-actions supervisor-new" data-supervisor-new-confirm="">
          {confirmingNew ? (
            <InlineConfirm
              question={NEW_CONVERSATION_CONFIRM.question}
              consequence={NEW_CONVERSATION_CONFIRM.consequence}
              confirmLabel={NEW_CONVERSATION_CONFIRM.confirm}
              busyLabel={NEW_CONVERSATION_CONFIRM.busy}
              icon="add"
              variant="danger"
              busy={clearing}
              onConfirm={() => void confirmNew()}
              onCancel={cancelNew}
            />
          ) : (
            <Alert tone="danger" role="alert">
              {newError}
            </Alert>
          )}
        </div>
      )}

      <h3 className="visually-hidden" id={ids.conversation}>
        Conversation
      </h3>
      <MentionsContext.Provider value={mentions}>
        <SupervisorConversation
          key={generation}
          status={status}
          refresh={`${state.lastTurnAt ?? ''}|${status}|${sent}`}
          loader={loader}
          id={ids.panel}
          labelledBy={ids.conversation}
          empty={empty}
        />
      </MentionsContext.Provider>

      <SupervisorHandoffs handoffs={state.handoffs} sessions={sessions} onOpenSession={onOpenSession} />

      <ApprovalCards approvals={state.approvals} onEmpty={toBox} />

      <footer className="session-view-foot supervisor-foot">
        <SupervisorBox status={status} suggestion={suggestion} onDraftChange={onDraft} onSent={() => setSent((count) => count + 1)} fieldRef={field} />
      </footer>
    </Frame>
  );
}

/**
 * Its conversation (W114), in a component of its own so that a new conversation (W136) draws it from
 * nothing: keyed by which conversation it is, so nothing of the one left stays, its entries, its
 * place or its "no longer available" notice.
 */
function SupervisorConversation({
  status,
  refresh,
  loader,
  id,
  labelledBy,
  empty,
}: {
  status: SupervisorState['status'];
  /** Changes when it's to be fetched again: a turn's end, its status, or a message you sent. */
  refresh: string;
  loader: PageLoader | undefined;
  id: string;
  labelledBy: string;
  empty: ReactNode;
}) {
  const active = status === 'working' || status === 'starting';
  const conversation = useConversation(refresh, loader, { pollMs: active ? WORKING_POLL_MS : undefined, pollMissing: true });
  const newest = conversation.state.ahead ?? conversation.state;
  const working = useMemo<WorkingLineState>(() => supervisorWorkingLine(status, newest.entries, newest.before !== undefined), [status, newest.entries, newest.before]);
  return (
    <ConversationPanel
      conversation={conversation}
      id={id}
      labelledBy={labelledBy}
      hidden={false}
      role="region"
      working={working}
      workingReady={conversation.state.status !== 'loading' && conversation.state.status !== 'unavailable'}
      empty={empty}
    />
  );
}

/**
 * What the replies can name (W125, mentions.ts): the sessions and PRs pitwall lists, rebuilt only when
 * what a mention depends on changes, so a snapshot that changes nothing else draws no reply again.
 * None without a way to open them.
 */
function useReplyMentions(
  sessions: readonly SessionSummary[],
  onOpenSession: ((sessionId: string) => void) | undefined,
  prs: readonly PullRequestSummary[] | undefined,
  onOpenPr: ((key: string) => void) | undefined,
): MentionsValue | undefined {
  const opens = useRef({ onOpenSession, onOpenPr });
  opens.current = { onOpenSession, onOpenPr };
  const linkSessions = onOpenSession !== undefined;
  const linkPrs = onOpenPr !== undefined;
  const signature = JSON.stringify([
    linkSessions ? sessions.map((session) => [session.sessionId, session.name, session.shortId ?? '', session.alive, session.ended === true, needsAttention(session)]) : [],
    linkPrs ? (prs ?? []).map((pr) => [pr.repo, pr.number, pr.repoLabel]) : [],
  ]);
  const inputs = useRef({ sessions, prs });
  inputs.current = { sessions, prs };
  return useMemo(() => {
    if (!linkSessions && !linkPrs) return undefined;
    const { sessions: all, prs: list } = inputs.current;
    return {
      mentions: createMentions(linkSessions ? all : [], linkPrs ? (list ?? []) : []),
      open: (target: MentionTarget) => {
        if (target.kind === 'session') opens.current.onOpenSession?.(target.sessionId);
        else opens.current.onOpenPr?.(target.key);
      },
    };
    // The signature is what the mentions depend on.
  }, [signature, linkSessions, linkPrs]);
}

export interface SupervisorOffViewProps {
  onClose: () => void;
  layout?: SessionViewLayout;
  compact?: boolean;
  backLabel?: string | undefined;
  headingRef?: RefObject<HTMLHeadingElement | null>;
  animate?: boolean;
}

/** The empty state's words for a pitwall with no supervisor, as a URL's `?supervisor` can open. */
export const NO_SUPERVISOR = {
  title: 'The supervisor is off',
  sentence: 'pitwall was started with --no-supervisor, so it runs none. Start pitwall without it to talk to one here.',
} as const;

/**
 * `?supervisor` with no supervisor in the snapshot, as with `--no-supervisor` (W114): the view says
 * so, as an empty state whose title is its heading, with Close. It starts and sends nothing.
 */
export function SupervisorOffView({ onClose, layout = 'overlay', compact = false, backLabel, headingRef, animate = true }: SupervisorOffViewProps) {
  const titleId = useId();
  return (
    <Frame layout={layout} id={SUPERVISOR_VIEW_ID} className="supervisor-view" animate={animate} titleId={titleId} onEscape={onClose}>
      <header className="session-view-head">
        <Top compact={compact} onClose={onClose} backLabel={backLabel}>
          <span className="session-view-spacer" />
        </Top>
      </header>
      <div className="session-view-body session-view-state">
        <EmptyState
          icon="supervisor"
          heading={{ id: titleId, ref: headingRef }}
          title={NO_SUPERVISOR.title}
          sentence={
            <>
              pitwall was started with <code>--no-supervisor</code>, so it runs none. Start pitwall without it to talk to one here.
            </>
          }
        />
      </div>
    </Frame>
  );
}
