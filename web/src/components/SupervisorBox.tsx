// The supervisor's message box (M5, W114; docs/design-system.md, 4: Supervisor, and 4: Message box): at
// the foot of its view, sending what you type to the supervisor, as you, with POST
// SUPERVISOR_MESSAGE_PATH. The session view's message box (RelayBox.tsx) in look and keys: the text box
// beside Send, the help line with ⌘ ↵, the note behind an info button, and the character count from 80 %
// of the limit, SUPERVISOR_MESSAGE_MAX. While it works, Stop beside Send stops its turn, with POST
// SUPERVISOR_INTERRUPT_PATH.
//
// - ⌘/Ctrl + Enter sends and Enter adds a line, as everywhere (D13). A message sent while it works
//   waits for the turn to end, which the box then says. One sent while it's off starts it.
// - The draft is kept in the tab's sessionStorage as it's typed (W44, drafts.ts), under
//   `pitwall.draft.v1:supervisor`, so it survives a reload, and a send pitwall never heard the end of
//   comes back with a warning to check the conversation before sending it again. Nothing sends by itself.
// - The empty state's suggested questions fill it (`suggestion`), and focus moves to it; they never send.
// - Escape never discards a draft: the box tells the view when there is one, and the view then
//   ignores Escape.
// - Attach file (W135, supervisorAttach.ts) reads a text file in the page and puts its contents in
//   the box at the caret, under its name, for you to add to, edit and send. The server never sees a
//   path. A file that isn't UTF-8 text, or wouldn't fit the limit, is refused in the box's alert.

import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { SUPERVISOR_MODEL, type SupervisorStatus } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { useAutoGrow } from '../autoGrow.js';
import { DraftStorageContext, readDraft, writeDraft, type UnsureSend } from '../drafts.js';
import { plainText } from '../format.js';
import { characterCount, outgoingText } from '../relay.js';
import { ATTACH_FILE_TEXT, attachFile } from '../supervisorAttach.js';
import { CHECK_ITS_CONVERSATION, interruptSupervisor, modelName, sendToSupervisor, SUPERVISOR_DRAFT_ID, SUPERVISOR_TEXT_MAX } from '../supervisor.js';
import { Alert, Detail } from './Alert.js';
import { Button } from './Button.js';
import { InfoTip } from './InfoTip.js';
import { KeyCaps, modEnter } from './KeyCaps.js';
import { Timestamp } from './Timestamp.js';
import { Tooltip } from './Tooltip.js';
import '../relay.css';

/** The note behind the info button: what a message does, and what it keeps (W136), in three sentences. */
export const SUPERVISOR_BOX_NOTE = `Starts a turn on the supervisor's model, ${modelName(SUPERVISOR_MODEL)}, which counts against your plan's usage. It reads your sessions' recaps, and a session's conversation when you ask about it, and sends or starts nothing without your click. It keeps this conversation, long pastes included, until you start a new one.`;

/** Why Send is aria-disabled, for its tooltip. */
export const SUPERVISOR_SEND_EMPTY = 'Type a message to send it.';
export const supervisorTooLong = (over: number) =>
  `Shorten it by ${over.toLocaleString('en')} ${over === 1 ? 'character' : 'characters'} to send it: the limit is ${SUPERVISOR_TEXT_MAX.toLocaleString('en')}.`;
export const SUPERVISOR_SEND_UNAVAILABLE = "Messages can't be sent from here.";
export const SUPERVISOR_SEND_HELD = "It can't take messages while another session has its conversation. Stop or close that session, then press Start.";

/** A message sent while a turn runs: the supervisor reads it when that turn ends. */
export const QUEUED_TEXT = 'Queued: it reads this when its current turn ends.';

/** Stop's tooltip, which describes it. */
export const STOP_HINT = "Stop the supervisor's current turn. What it's written so far stays in the conversation.";

/** A restored send pitwall never heard the end of (W44), in this box's words. */
function UnsureNote({ send }: { send: UnsureSend }) {
  return send.state === 'out' ? (
    <>
      pitwall started sending this <Timestamp at={send.at} />, but the page reloaded or the view closed before it had an answer, so it may have reached the supervisor.{' '}
      {CHECK_ITS_CONVERSATION}
    </>
  ) : (
    <>
      pitwall tried to send this <Timestamp at={send.at} /> and couldn&apos;t tell whether it reached the supervisor. {CHECK_ITS_CONVERSATION}
    </>
  );
}

/** What the box shows after a send or a Stop. */
type Shown = { tone: 'warning' | 'danger'; text: string } | { tone: 'queued' } | { tone: 'sent' } | { tone: 'attached'; name: string };

export interface SupervisorBoxProps {
  /** Its status, from the snapshot: Stop shows while it works, and nothing can be sent while it's held. */
  status: SupervisorStatus;
  /** A suggested question to put in the box, from the empty state: each new `at` fills it, and focus moves to it. */
  suggestion?: { text: string; at: number } | undefined;
  /** Whether there's a draft, for the view, which ignores Escape while there is one (6.2). */
  onDraftChange?: ((hasDraft: boolean) => void) | undefined;
  /** A message was taken: the view fetches its conversation again. */
  onSent?: (() => void) | undefined;
  /** The text box, for the view to put focus on, as after the last approval's card goes. */
  fieldRef?: RefObject<HTMLTextAreaElement | null> | undefined;
}

export function SupervisorBox({ status, suggestion, onDraftChange, onSent, fieldRef }: SupervisorBoxProps) {
  const api = useContext(ApiContext);
  const drafts = useContext(DraftStorageContext);
  const ids = { heading: useId(), text: useId(), keys: useId(), count: useId(), unsure: useId() };
  const alive = useRef(true);
  const form = useRef<HTMLFormElement>(null);
  const ownField = useRef<HTMLTextAreaElement>(null);
  const field = fieldRef ?? ownField;
  const requests = useRef<AbortController | undefined>(undefined);
  const [restored] = useState(() => readDraft(SUPERVISOR_DRAFT_ID, drafts));
  const [text, setText] = useState(restored?.text ?? '');
  const [unsure, setUnsure] = useState(restored?.send);
  const [sending, setSending] = useState(false);
  const [shown, setShown] = useState<Shown>();
  // Stop: out, then waiting for the snapshot to say the turn has stopped, for at most STOP_WAIT_MS.
  const [stopping, setStopping] = useState(false);
  // Attach file: its hidden input, the read under way, and the caret's last place in the box, which
  // stays undefined until the box has focus, so a file goes at the end of a restored draft.
  const fileInput = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const caret = useRef<number | undefined>(undefined);
  const placeCaret = useRef<number | undefined>(undefined);

  const keep = (next: string, send?: UnsureSend) => writeDraft(SUPERVISOR_DRAFT_ID, next === '' ? undefined : { text: next, send }, drafts);
  const edit = (next: string) => {
    setText(next);
    setUnsure(undefined);
    keep(next);
  };

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    requests.current = controller;
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, []);

  // A suggested question: in the box, as if typed, with the caret at its end. Never sent.
  const filled = useRef(suggestion?.at);
  useEffect(() => {
    if (suggestion === undefined || suggestion.at === filled.current) return;
    filled.current = suggestion.at;
    edit(suggestion.text);
    const element = field.current;
    if (!element) return;
    element.focus();
    try {
      element.setSelectionRange(suggestion.text.length, suggestion.text.length);
    } catch {
      // A field that can't place the caret keeps it where the browser put it.
    }
  }, [suggestion?.at]);

  const hasDraft = text !== '';
  const onDraftRef = useRef(onDraftChange);
  onDraftRef.current = onDraftChange;
  useEffect(() => {
    onDraftRef.current?.(hasDraft);
  }, [hasDraft]);
  useEffect(() => () => onDraftRef.current?.(false), []);

  useAutoGrow(field, text);

  // After a file goes in: focus in the box, with the caret after the file, once the box has its text.
  useLayoutEffect(() => {
    const at = placeCaret.current;
    const element = field.current;
    if (at === undefined || !element) return;
    placeCaret.current = undefined;
    element.focus();
    try {
      element.setSelectionRange(at, at);
    } catch {
      // A field that can't place the caret keeps it where the browser put it.
    }
    // The browser doesn't scroll a box to a caret placed this way: at the end, as it usually is, show the end.
    if (at >= element.value.length) element.scrollTop = element.scrollHeight;
    caret.current = at;
  }, [text]);

  // Stop stays busy until the snapshot says the turn has stopped, or STOP_WAIT_MS passes.
  const working = status === 'working';
  useEffect(() => {
    if (!stopping) return;
    if (!working) {
      setStopping(false);
      return;
    }
    const timer = setTimeout(() => setStopping(false), STOP_WAIT_MS);
    return () => clearTimeout(timer);
  }, [stopping, working]);

  // Stop goes when the turn ends: focus it had goes to the text box, never to the page.
  const stopShown = working || stopping;
  const stopFocus = useRef(false);
  useLayoutEffect(() => {
    if (stopShown || !stopFocus.current) return;
    stopFocus.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) field.current?.focus();
  }, [stopShown]);

  const held = status === 'held';
  const length = outgoingText(text).length;
  const tooLong = length > SUPERVISOR_TEXT_MAX;
  const canSend = !held && !sending && text.trim() !== '' && !tooLong && api !== undefined;
  const count = characterCount(length, SUPERVISOR_TEXT_MAX);
  const sendOff = sending
    ? undefined
    : held
      ? SUPERVISOR_SEND_HELD
      : api === undefined
        ? SUPERVISOR_SEND_UNAVAILABLE
        : tooLong
          ? supervisorTooLong(length - SUPERVISOR_TEXT_MAX)
          : text.trim() === ''
            ? SUPERVISOR_SEND_EMPTY
            : undefined;

  const send = async () => {
    if (!canSend || !api) return;
    // Kept as out before it goes, so a reload before the answer leaves a warning with the draft (W44).
    const at = new Date().toISOString();
    const queued = working;
    keep(text, { at, state: 'out' });
    setUnsure(undefined);
    setSending(true);
    setShown(undefined);
    const outcome = await sendToSupervisor(api, text, requests.current?.signal);
    if (!alive.current) return;
    setSending(false);
    const active = document.activeElement;
    if (active === null || active === document.body || form.current?.contains(active)) field.current?.focus();
    if (outcome.kind === 'unauthorized') {
      keep(text);
      return;
    }
    if (outcome.kind === 'failed') {
      setShown({ tone: outcome.uncertain ? 'warning' : 'danger', text: outcome.error });
      keep(text, outcome.uncertain ? { at, state: 'uncertain' } : undefined);
      return;
    }
    setShown(queued ? { tone: 'queued' } : { tone: 'sent' });
    setText('');
    keep('');
    caret.current = undefined;
    onSent?.();
  };

  const stop = async () => {
    if (!api || stopping) return;
    setStopping(true);
    setShown(undefined);
    const outcome = await interruptSupervisor(api, requests.current?.signal);
    if (!alive.current) return;
    if (outcome.kind === 'failed') {
      setStopping(false);
      setShown({ tone: 'danger', text: outcome.error });
    } else if (outcome.kind === 'unauthorized') {
      setStopping(false);
    }
  };

  const chooseFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Emptied, so choosing the same file again is a change too.
    event.target.value = '';
    if (!file || reading || sending) return;
    setReading(true);
    setShown(undefined);
    const outcome = await attachFile(file, text, caret.current);
    if (!alive.current) return;
    setReading(false);
    if (!outcome.ok) {
      setShown({ tone: 'danger', text: outcome.error });
      return;
    }
    placeCaret.current = outcome.caret;
    edit(outcome.text);
    setShown({ tone: 'attached', name: file.name });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape' && hasDraft) {
      // Keep the draft: Escape elsewhere closes the view.
      event.preventDefault();
    }
  };

  const keys = modEnter();
  const describedBy = [unsure && ids.unsure, ids.keys, count?.over && ids.count].filter(Boolean).join(' ');

  return (
    <section className="relay-box supervisor-box" aria-labelledby={ids.heading}>
      <h3 className="visually-hidden" id={ids.heading}>
        Message the supervisor
      </h3>
      {unsure && (
        <Alert tone="warning" className="relay-result relay-unsure">
          <span id={ids.unsure}>
            <UnsureNote send={unsure} />
          </span>
        </Alert>
      )}
      {shown?.tone === 'queued' && (
        <Alert tone="neutral" role="status" className="relay-result">
          {QUEUED_TEXT}
        </Alert>
      )}
      {/* Sent, or a file attached, with nothing more to say on screen: the message shows in the conversation, the file in the box. Said once, to a screen reader. */}
      <p className="visually-hidden" role="status">
        {shown?.tone === 'sent' ? 'Sent to the supervisor.' : shown?.tone === 'attached' ? ATTACH_FILE_TEXT.attached(shown.name) : ''}
      </p>
      {(shown?.tone === 'warning' || shown?.tone === 'danger') && (
        <Alert tone={shown.tone} role="alert" className="relay-result">
          <SentenceThenDetail text={shown.text} />
        </Alert>
      )}
      <form className="relay-form" ref={form} onSubmit={onSubmit}>
        <label className="visually-hidden" htmlFor={ids.text}>
          Message to the supervisor
        </label>
        <div className="relay-compose">
          <textarea
            ref={field}
            id={ids.text}
            className="field-input relay-text"
            rows={1}
            value={text}
            onChange={(event) => edit(event.target.value)}
            onKeyDown={onKeyDown}
            onSelect={(event) => {
              caret.current = event.currentTarget.selectionEnd;
            }}
            readOnly={sending || reading}
            aria-describedby={describedBy}
            aria-invalid={tooLong || undefined}
            spellCheck
          />
          {stopShown && (
            <Tooltip content={STOP_HINT} relation="description">
              <Button
                icon="stop"
                busy={stopping}
                busyLabel="Stopping…"
                onClick={() => void stop()}
                onFocus={() => {
                  stopFocus.current = true;
                }}
                onBlur={(event) => {
                  // Moved elsewhere; with nowhere to go, as when it's taken away, it's still the Stop's.
                  if (event.relatedTarget !== null) stopFocus.current = false;
                }}
                data-supervisor-stop=""
              >
                Stop
              </Button>
            </Tooltip>
          )}
          <Tooltip content={sendOff} relation="description">
            <Button type="submit" variant="primary" icon="send" disabled={!canSend} busy={sending} busyLabel="Sending…">
              Send
            </Button>
          </Tooltip>
        </div>
        <div className="relay-help">
          <Tooltip content={ATTACH_FILE_TEXT.hint} relation="description">
            <Button
              size="sm"
              variant="ghost"
              icon="attach"
              className="supervisor-attach"
              disabled={sending}
              busy={reading}
              busyLabel="Reading…"
              onClick={() => fileInput.current?.click()}
            >
              {ATTACH_FILE_TEXT.button}
            </Button>
          </Tooltip>
          {/* No accept: a picker filtering by type would hide source files with no type of their own, such as a Go file. */}
          <input ref={fileInput} type="file" hidden tabIndex={-1} onChange={(event) => void chooseFile(event)} data-supervisor-attach-input="" />
          <p className="relay-help-keys" id={ids.keys}>
            <KeyCaps keys={keys.keys} label={keys.label} /> to send
            <InfoTip text={SUPERVISOR_BOX_NOTE} className="relay-info" />
          </p>
          {count && (
            <p className={count.over ? 'relay-count over' : 'relay-count'} id={ids.count}>
              {count.text}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}

/** How long Stop stays busy after pitwall took it, waiting for the snapshot to say the turn has stopped. */
export const STOP_WAIT_MS = 15_000;

/**
 * pitwall's sentence, then the server's reason in code style when there's one after "Not sent: " or
 * "… (HTTP n). ": a failure's text is pitwall's own up to its first full stop, the rest the server's.
 */
function SentenceThenDetail({ text }: { text: string }) {
  const notSent = 'Not sent: ';
  if (text.startsWith(notSent) && !text.startsWith('Not sent: pitwall refused')) {
    return (
      <>
        Not sent: <Detail>{plainText(text.slice(notSent.length))}</Detail>
      </>
    );
  }
  return <>{plainText(text)}</>;
}
