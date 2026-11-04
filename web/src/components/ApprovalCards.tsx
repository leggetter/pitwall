// The supervisor's approvals (M5, W114, W115; docs/design-system.md, 4: Supervisor): a draft card for
// each thing it wants to do that waits on your click, oldest first, above its message box. A message to
// a session, a new session in a directory, or a finished session resumed with a message (W127), with
// the text it would send, as text in <bdi>, never
// markdown, since it's the model's and may quote a transcript; when it runs out; and Send, Edit and
// Don't send.
//
// - What the card shows is what goes (W120, W116's F1): the exact string, never through a filter that
//   removes text, as plainText() would. The server refuses text with a character that wouldn't show
//   as itself (src/shared/hiddenText.ts); anything unusual left, such as a no-break space, is drawn as
//   its code, U+00A0, with a note naming it. Taller than the box shows (half the window, at least 8
//   lines, W136; 4 on a short window), the card says how many lines and characters it has, to scroll through before Send. A
//   text that starts with `/` or has `@` before a path says it may run a slash command or attach a
//   file (W129, the re-review's I2), since it reaches Claude Code as a typed prompt.
// - A resume card (W129, M2, L1) shows, as text, the session's folder, home as ~, and its last
//   activity; how many listed sessions share its name when others do, since names aren't unique; and
//   that it resumes with its own saved settings, its permission mode included, with a warning when
//   that mode is bypassPermissions. Edit opens the text in place, up to SUPERVISOR_PROPOSAL_MAX for a message and
// SPAWN_PROMPT_MAX for a new session's first prompt (editLimit()), with Send edit and Cancel.
//
// - Each decision POSTs a SupervisorDecision to supervisorApprovalPath(). The card stays busy until the
//   snapshot drops it, since that's when pitwall has acted, or STUCK_MS passes. A failure is an inline
//   alert on the card, in pitwall's words, with the server's reason as text.
// - A list with headings: a region named "Drafts for you", a <ul>, and each card an <li> named by its
//   <h4>, which says what it would do. A snapshot that adds or drops a card announces nothing.
// - Focus: a card that goes with focus in it hands focus to the next card's heading, or the one
//   before, or, with none left, to the caller (onEmpty), which puts it in the message box. Edit puts it
//   in the editor, and Cancel or Escape back on Edit.

import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { SPAWN_PROMPT_MAX, type SupervisorApproval, type SupervisorDecision } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { useAutoGrow } from '../autoGrow.js';
import { visibleParts, visibleString, type VisiblePart } from '../../../src/shared/hiddenText.js';
import { characterCount } from '../relay.js';
import {
  APPROVAL_GONE,
  approvalText,
  approvalTitle,
  decideApproval,
  RESUME_BYPASS_WARNING,
  resumeBypassed,
  resumePermissionText,
  resumeWhereLead,
  SUPERVISOR_EDIT_MAX,
  typedPromptNotes,
} from '../supervisor.js';
import { Alert } from './Alert.js';
import { Button } from './Button.js';
import { ScrollBox, useOverflowing } from './ScrollBox.js';
import { Timestamp } from './Timestamp.js';
import { Tooltip } from './Tooltip.js';

/** How long a card stays busy after pitwall took its decision, waiting for the snapshot to drop it. */
export const STUCK_MS = 30_000;

/** A card pitwall took a decision for that the snapshot still has after STUCK_MS. */
export const STUCK_TEXT = "pitwall took your answer, but this card is still waiting. Check the supervisor's conversation before answering again.";

/** The editor's Send edit while it can't send, for its tooltip. */
export const EDIT_EMPTY = 'Type the text to send, or Cancel to keep the draft.';
export const editTooLong = (over: number, limit: number = SUPERVISOR_EDIT_MAX) =>
  `Shorten it by ${over.toLocaleString('en')} ${over === 1 ? 'character' : 'characters'} to send it: the limit is ${limit.toLocaleString('en')}.`;

/** The longest edit of each kind: a message's, a resumed session's included (W127), SUPERVISOR_PROPOSAL_MAX, which stayed at 20,000 when what you send the supervisor grew (W134); a new session's first prompt, SPAWN_PROMPT_MAX (W115). */
export function editLimit(kind: SupervisorApproval['kind']): number {
  return kind === 'spawn' ? SPAWN_PROMPT_MAX : SUPERVISOR_EDIT_MAX;
}

/** What each kind's text is, as the card labels it. */
const TEXT_LABELS = { message: 'Message', spawn: 'First prompt', resume: 'Message' } as const;

/** What the card says under text taller than its box. */
export function lengthNote(text: string): string {
  const lines = text.split('\n').length;
  const chars = text.length;
  return `${lines.toLocaleString('en')} ${lines === 1 ? 'line' : 'lines'}, ${chars.toLocaleString('en')} ${chars === 1 ? 'character' : 'characters'}: scroll to read it all before you send it.`;
}

/** What the card says under text with characters it draws as their codes. */
export function hiddenNote(parts: readonly VisiblePart[]): string | undefined {
  const named = [...new Set(parts.flatMap((part) => (part.kind === 'hidden' ? [part.description] : [])))];
  if (named.length === 0) return undefined;
  return `Drawn as their codes, since they don't show as themselves: ${named.join('; ')}.`;
}

/** The text as it goes, each character that wouldn't show as itself drawn as its code. */
function ExactText({ parts }: { parts: readonly VisiblePart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.kind === 'text' ? (
          part.text
        ) : (
          <span key={index} className="approval-hidden">
            {part.label}
          </span>
        ),
      )}
    </>
  );
}

/** What a spawn card adds under its heading: how the session starts. */
export const SPAWN_NOTE = 'Starts a background session there with claude --bg, its first prompt as below.';

/** What a resume card adds under its heading (W127): how the finished session comes back, and what it reads. */
export const RESUME_NOTE = 'Resumes this finished session in the background with claude --resume, in its own folder, and sends the message below as its next turn.';

export interface ApprovalCardsProps {
  approvals: readonly SupervisorApproval[];
  /** The last card went with focus in it: the caller puts focus somewhere that stays, the message box. */
  onEmpty: () => void;
}

export function ApprovalCards({ approvals, onEmpty }: ApprovalCardsProps) {
  const headingId = useId();
  const list = useRef<HTMLUListElement>(null);
  // The card focus was last in, by id, while it's still in one.
  const focusedCard = useRef<string | undefined>(undefined);
  const shownIds = useRef(approvals.map((each) => each.id));

  useLayoutEffect(() => {
    const was = shownIds.current;
    const now = approvals.map((each) => each.id);
    shownIds.current = now;
    const left = focusedCard.current;
    if (left === undefined || now.includes(left)) return;
    focusedCard.current = undefined;
    const active = document.activeElement;
    // Focus has gone on somewhere that's still there: it stays.
    if (active !== null && active !== document.body && active.isConnected) return;
    // The card that took its place, or the one before it.
    const at = was.indexOf(left);
    const after = was.slice(at + 1).find((id) => now.includes(id));
    const before = was.slice(0, Math.max(0, at)).reverse().find((id) => now.includes(id));
    const next = after ?? before;
    const heading = next === undefined ? undefined : list.current?.querySelector<HTMLElement>(`[data-approval="${CSS.escape(next)}"] h4`);
    if (heading) heading.focus();
    else onEmpty();
  }, [approvals, onEmpty]);

  if (approvals.length === 0) return null;
  return (
    <section className="supervisor-approvals" aria-labelledby={headingId}>
      <h3 className="supervisor-approvals-title" id={headingId}>
        Drafts for you <span className="supervisor-approvals-count">({approvals.length})</span>
      </h3>
      {/* At most 70% of the view, then it scrolls: a Tab stop while it does, so the message box keeps its room. */}
      <ScrollBox className="supervisor-approvals-scroll" label="Drafts for you">
      <ul
        ref={list}
        className="approval-cards"
        onFocus={(event) => {
          focusedCard.current = event.target.closest<HTMLElement>('[data-approval]')?.dataset.approval;
        }}
        onBlur={(event) => {
          // Moved out of the cards: no card has it. Taken away with its card, it's that card's still.
          const to = event.relatedTarget;
          if (to instanceof Node && !list.current?.contains(to)) focusedCard.current = undefined;
        }}
      >
        {approvals.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} />
        ))}
      </ul>
      </ScrollBox>
    </section>
  );
}

type Phase = { kind: 'idle' } | { kind: 'deciding'; decision: SupervisorDecision['decision'] } | { kind: 'decided'; decision: SupervisorDecision['decision'] };

function ApprovalCard({ approval }: { approval: SupervisorApproval }) {
  const api = useContext(ApiContext);
  const ids = { heading: useId(), text: useId(), editor: useId(), count: useId(), notes: useId() };
  const [textBox, setTextBox] = useState<HTMLElement | null>(null);
  const overflowing = useOverflowing(textBox);
  const alive = useRef(true);
  const requests = useRef<AbortController | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<string>();
  const editButton = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    requests.current = controller;
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, []);

  // Decided, it waits for the snapshot to drop it; one still here after STUCK_MS can be answered again.
  useEffect(() => {
    if (phase.kind !== 'decided') return;
    const timer = setTimeout(() => {
      setPhase({ kind: 'idle' });
      setError(STUCK_TEXT);
    }, STUCK_MS);
    return () => clearTimeout(timer);
  }, [phase.kind]);

  const decide = async (decision: SupervisorDecision) => {
    if (!api || phase.kind !== 'idle') return;
    setPhase({ kind: 'deciding', decision: decision.decision });
    setError(undefined);
    const outcome = await decideApproval(api, approval.id, decision, requests.current?.signal);
    if (!alive.current) return;
    if (outcome.kind === 'decided') {
      // An edit stays open, read-only, with Send edit busy, until the snapshot drops the card.
      setPhase({ kind: 'decided', decision: decision.decision });
      return;
    }
    setPhase({ kind: 'idle' });
    if (outcome.kind === 'gone') setError(APPROVAL_GONE);
    else if (outcome.kind === 'failed') setError(outcome.error);
  };

  // The editor: in place of the text, with focus in it; Cancel and Escape put it back, with focus on Edit.
  useAutoGrow(editor, editing ?? '', editing !== undefined);
  const openEditor = () => {
    setEditing(approvalText(approval));
    setError(undefined);
  };
  const editorOpen = editing !== undefined;
  const wasOpen = useRef(false);
  // Cancel or Escape: once the editor has gone, Edit is back, and takes focus.
  const backToEdit = useRef(false);
  useLayoutEffect(() => {
    if (editorOpen && !wasOpen.current) {
      const element = editor.current;
      element?.focus();
      element?.setSelectionRange?.(element.value.length, element.value.length);
    } else if (!editorOpen && wasOpen.current && backToEdit.current) {
      backToEdit.current = false;
      editButton.current?.focus();
    }
    wasOpen.current = editorOpen;
  }, [editorOpen]);
  const cancelEdit = () => {
    backToEdit.current = true;
    setEditing(undefined);
  };
  const onEditorKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      // The edit, not the view: Escape elsewhere closes it.
      event.preventDefault();
      if (phase.kind === 'idle') cancelEdit();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      sendEdit();
    }
  };

  const length = editing?.length ?? 0;
  const limit = editLimit(approval.kind);
  const tooLong = length > limit;
  const empty = (editing ?? '').trim() === '';
  const editOff = phase.kind !== 'idle' ? undefined : tooLong ? editTooLong(length - limit, limit) : empty ? EDIT_EMPTY : undefined;
  const sendEdit = () => {
    if (editing === undefined || editOff !== undefined) return;
    void decide({ decision: 'edit', text: editing });
  };
  const count = characterCount(length, limit);

  const busy = phase.kind !== 'idle';
  const busyWith = (decision: SupervisorDecision['decision']) => phase.kind !== 'idle' && phase.decision === decision;
  const title = approvalTitle(approval);
  // The whole path, as it is, with anything that wouldn't show as its code (W129, I3): never a filter that removes text.
  const directory = approval.kind === 'message' ? undefined : visibleString(approval.directory);
  const text = approvalText(approval);
  const parts = visibleParts(text);
  // Only when the text is taller than its box, as measured: the box grows to half the window (W136), so a line count can't say.
  const notes = [overflowing ? lengthNote(text) : undefined, hiddenNote(parts), ...(approval.kind === 'message' ? [] : typedPromptNotes(text))].filter(
    (note) => note !== undefined,
  );
  return (
    <li className="approval-card" data-approval={approval.id} data-kind={approval.kind} aria-labelledby={ids.heading} aria-busy={busy || undefined}>
      {/* Takes focus when the card before it goes (above), with no ring of its own, as the view's heading. */}
      <h4 className="approval-title" id={ids.heading} tabIndex={-1}>
        {directory === undefined ? (
          <bdi>{title}</bdi>
        ) : (
          // The whole path, home and all, in its tooltip: on screen, home is ~.
          <Tooltip content={directory} relation="none">
            <bdi>{title}</bdi>
          </Tooltip>
        )}
      </h4>
      <p className="approval-meta">
        Drafted <Timestamp at={approval.at} />
        <span aria-hidden="true"> · </span>
        <span className="visually-hidden">. </span>
        Not sent unless you answer by <Timestamp at={approval.expiresAt} format="time" />
      </p>
      {approval.kind === 'spawn' && <p className="approval-note">{SPAWN_NOTE}</p>}
      {approval.kind === 'resume' && (
        <>
          {/* Names aren't unique (W129, M2): where it is and when it was last active, as text. */}
          <p className="approval-where">
            {resumeWhereLead(approval.sameName)}
            {/* The whole path, not ~: the page can't know the real home, so /Users/Shared/x and /Users/me/x would both read ~/x (#133's re-check). */}
            <bdi className="approval-folder">{visibleString(approval.directory)}</bdi>
            {approval.lastActivityAt === undefined ? (
              '.'
            ) : (
              <>
                , last active <Timestamp at={approval.lastActivityAt} />.
              </>
            )}
          </p>
          <p className="approval-note">{RESUME_NOTE}</p>
          <p className="approval-note approval-permission">{resumePermissionText(approval.permission)}</p>
          {resumeBypassed(approval.permission) && (
            <Alert tone="warning" className="approval-bypass">
              {RESUME_BYPASS_WARNING}
            </Alert>
          )}
        </>
      )}
      {editing === undefined ? (
        <div className="approval-body">
          <p className="approval-label" id={ids.text}>
            {TEXT_LABELS[approval.kind]}
          </p>
          {/* The model's text, exactly as it goes: up to half the window, then it scrolls, a Tab stop while it does. */}
          <ScrollBox ref={setTextBox} as="p" className="approval-text" label={TEXT_LABELS[approval.kind]} aria-describedby={notes.length > 0 ? ids.notes : undefined}>
            <bdi>
              <ExactText parts={parts} />
            </bdi>
          </ScrollBox>
          {notes.length > 0 && (
            <p className="approval-length" id={ids.notes}>
              {notes.join(' ')}
            </p>
          )}
        </div>
      ) : (
        <div className="approval-body approval-editing">
          <label className="approval-label" htmlFor={ids.editor}>
            {approval.kind === 'spawn' ? 'Edit the first prompt' : 'Edit the message'}
          </label>
          <textarea
            ref={editor}
            id={ids.editor}
            className="field-input relay-text approval-editor"
            rows={3}
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
            onKeyDown={onEditorKey}
            readOnly={busy}
            aria-invalid={tooLong || undefined}
            aria-describedby={count?.over ? ids.count : undefined}
            spellCheck
          />
          {count && (
            <p className={count.over ? 'relay-count over' : 'relay-count'} id={ids.count}>
              {count.text}
            </p>
          )}
        </div>
      )}
      {error !== undefined && (
        <Alert tone={error === APPROVAL_GONE ? 'neutral' : 'danger'} role="alert" className="approval-error">
          {error}
        </Alert>
      )}
      <div className="approval-actions">
        {editing === undefined ? (
          <>
            <Button variant="primary" size="sm" icon="send" disabled={busy && !busyWith('send')} busy={busyWith('send')} busyLabel="Sending…" onClick={() => void decide({ decision: 'send' })}>
              Send
            </Button>
            <Button ref={editButton} size="sm" disabled={busy} onClick={openEditor}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" disabled={busy && !busyWith('decline')} busy={busyWith('decline')} busyLabel="Declining…" onClick={() => void decide({ decision: 'decline' })}>
              Don&apos;t send
            </Button>
          </>
        ) : (
          <>
            <Tooltip content={editOff} relation="description">
              <Button variant="primary" size="sm" icon="send" disabled={editOff !== undefined} busy={busyWith('edit')} busyLabel="Sending…" onClick={sendEdit}>
                Send edit
              </Button>
            </Tooltip>
            <Button variant="ghost" size="sm" disabled={busy} onClick={cancelEdit}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
