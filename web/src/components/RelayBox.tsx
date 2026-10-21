// The message box (docs/design-system.md, 4: Message box): "Message this session", at the foot of an
// interactive session's view, sending text through pitwall's relay (D8). Top to bottom: the latest
// exchange and its reply, the result of the last send as an inline alert, the text box beside Send,
// then the help line with ⌘ ↵, the limits note behind an info button, and the character count from
// 80 % of the limit.
//
// ⌘/Ctrl + Enter sends and Enter adds a line (Phil, 2026-10-20). Send is aria-disabled while there's
// nothing to send, it's over the limit or a send is out, and its tooltip, which describes it, says
// why, except while it's busy, when its label does. After a send, focus stays in the text box,
// and the draft clears only when the message was delivered, held or refused. Escape never discards a
// draft: the box tells the view when there is one, and the view then ignores Escape.

import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { RelayExchange, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { absoluteTime, plainText } from '../format.js';
import {
  canMessage,
  characterCount,
  exchangeSummary,
  MAX_RELAY_TEXT_LENGTH,
  outgoingText,
  resultLook,
  sendRelay,
  STATUS_TEXT,
  type SendResultStatus,
} from '../relay.js';
import { Alert, Detail } from './Alert.js';
import { Button } from './Button.js';
import { InfoTip } from './InfoTip.js';
import { KeyCaps, modEnter } from './KeyCaps.js';
import { ScrollBox } from './ScrollBox.js';
import { Timestamp } from './Timestamp.js';
import { Tooltip } from './Tooltip.js';
import '../relay.css';

/** What the box shows after a send. `error` is pitwall's own failure, before the relay answered. */
interface Shown {
  status: SendResultStatus;
  text: string;
  detail?: string;
}

export const LIMITS_NOTE =
  "Starts a turn on that session's model. The session sees it as a message from another session, not from you, so it can't approve prompts.";

export const NOT_RUNNING_NOTE = "It isn't running, so it can't be messaged.";

/** Why Send is aria-disabled, for its tooltip. */
export const SEND_EMPTY = 'Type a message to send it.';
export const sendTooLong = (over: number) =>
  `Shorten it by ${over.toLocaleString('en')} ${over === 1 ? 'character' : 'characters'} to send it: the limit is ${MAX_RELAY_TEXT_LENGTH.toLocaleString('en')}.`;
export const SEND_UNAVAILABLE = "Messages can't be sent from here.";

/**
 * Why a draft that was being written can't be sent any more: its session stopped running, or left the
 * list. The text stays, so it isn't lost, until it's cleared; Send says the same in its tooltip.
 */
export const KEPT_NOT_RUNNING = "It isn't running any more, so this can't be sent. Your text stays here until you clear it.";
export const KEPT_NOT_LISTED = "It's no longer listed, so this can't be sent. Your text stays here until you clear it.";
export const SEND_NOT_LISTED = "It's no longer listed, so it can't be messaged.";

export interface RelayBoxProps {
  /** An interactive session. */
  session: SessionSummary;
  /** The conversation already shows the latest exchange's reply, so the box shows only its status line. */
  replyShown?: boolean;
  /** Whether there's a draft, for the view, which ignores Escape while there is one (6.2). */
  onDraftChange?: (hasDraft: boolean) => void;
  /** False once the session has left the snapshot: a draft stays, but can't be sent. */
  listed?: boolean;
}

export function RelayBox({ session, replyShown = false, onDraftChange, listed = true }: RelayBoxProps) {
  const api = useContext(ApiContext);
  const ids = { heading: useId(), text: useId(), keys: useId(), count: useId(), kept: useId() };
  const alive = useRef(true);
  const form = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // Aborted when the box goes, so a request still waiting for an apiKey doesn't outlive it.
  const requests = useRef<AbortController | undefined>(undefined);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [shown, setShown] = useState<Shown>();
  const { sessionId } = session;

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    requests.current = controller;
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, []);

  const messageable = canMessage(session) && listed;
  // A session that stopped running, or left the list, shows its note instead of the text box, unless
  // there's a draft: that stays, editable, so it isn't lost, with a note saying why it can't be sent.
  const formShown = messageable || text !== '';
  const kept = !messageable && text !== '' ? (listed ? KEPT_NOT_RUNNING : KEPT_NOT_LISTED) : undefined;
  const hasDraft = text !== '';
  const onDraftRef = useRef(onDraftChange);
  onDraftRef.current = onDraftChange;
  useEffect(() => {
    onDraftRef.current?.(hasDraft);
  }, [hasDraft]);
  useEffect(() => () => onDraftRef.current?.(false), []);

  // From one line to eight, then it scrolls (4: Inputs): its height follows its content, and the CSS
  // caps it. Measured again when its width changes, since the text wraps differently.
  const grow = () => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  };
  useLayoutEffect(grow, [text, formShown]);
  useEffect(() => {
    const element = field.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let width = element.clientWidth;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      // In the next frame: changing its height inside the callback would notify it again in this one.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(grow);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [formShown]);

  const length = outgoingText(text).length;
  const tooLong = length > MAX_RELAY_TEXT_LENGTH;
  const canSend = messageable && !sending && text.trim() !== '' && !tooLong && api !== undefined;
  const count = characterCount(length);
  // Why Send does nothing, while it doesn't. Busy says so itself, with its label.
  const sendOff = sending
    ? undefined
    : !messageable
      ? listed
        ? NOT_RUNNING_NOTE
        : SEND_NOT_LISTED
      : api === undefined
      ? SEND_UNAVAILABLE
      : tooLong
        ? sendTooLong(length - MAX_RELAY_TEXT_LENGTH)
        : text.trim() === ''
          ? SEND_EMPTY
          : undefined;

  const send = async () => {
    if (!canSend || !api) return;
    setSending(true);
    setShown(undefined);
    const outcome = await sendRelay(api, sessionId, text, requests.current?.signal);
    if (!alive.current) return;
    setSending(false);
    // Focus stays in the text box, or comes back to it from Send, unless it was moved elsewhere meanwhile.
    const active = document.activeElement;
    if (active === null || active === document.body || form.current?.contains(active)) field.current?.focus();
    if (outcome.kind === 'unauthorized') return;
    if (outcome.kind === 'failed') {
      // Uncertain is a warning, as the relay's own is: a resend would start another turn if this one arrived.
      setShown({ status: outcome.uncertain ? 'uncertain' : 'error', text: outcome.error });
      return;
    }
    const { status, detail } = outcome.result;
    setShown(detail === undefined || status === 'delivered' ? { status, text: STATUS_TEXT[status] } : { status, text: STATUS_TEXT[status], detail });
    // Sent, or set aside by the session: either way it's no longer a draft. Kept when it wasn't sent, or may not have been.
    if (status !== 'failed' && status !== 'uncertain') setText('');
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
      // Keep the draft: Escape elsewhere closes the session view.
      event.preventDefault();
    }
  };

  const look = shown ? resultLook(shown.status) : undefined;
  const keys = modEnter();
  const describedBy = [kept && ids.kept, ids.keys, count?.over && ids.count].filter(Boolean).join(' ');

  return (
    <section className="relay-box" aria-labelledby={ids.heading}>
      {/* Named for assistive technology; on screen the text box and Send say what this is, as in a chat. */}
      <h3 className="visually-hidden" id={ids.heading}>
        Message this session
      </h3>
      {session.relay && <RelayExchangeNote exchange={session.relay} showReply={!replyShown} />}
      {shown && look && (
        <Alert tone={look.tone} role={look.role} className="relay-result">
          {shown.text}
          {shown.detail !== undefined && (
            <>
              {' '}
              <Detail>{plainText(shown.detail)}</Detail>
            </>
          )}
        </Alert>
      )}
      {formShown ? (
        <form className="relay-form" ref={form} onSubmit={onSubmit}>
          {kept && (
            <p className="relay-note relay-kept" id={ids.kept}>
              {kept}
            </p>
          )}
          <label className="visually-hidden" htmlFor={ids.text}>
            Message to {plainText(session.name)}
          </label>
          <div className="relay-compose">
            <textarea
              ref={field}
              id={ids.text}
              className="field-input relay-text"
              rows={1}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
              readOnly={sending}
              aria-describedby={describedBy}
              aria-invalid={tooLong || undefined}
              spellCheck
            />
            <Tooltip content={sendOff} relation="description">
              <Button type="submit" variant="primary" icon="send" disabled={!canSend} busy={sending} busyLabel="Sending…">
                Send
              </Button>
            </Tooltip>
          </div>
          <div className="relay-help">
            <p className="relay-help-keys" id={ids.keys}>
              <KeyCaps keys={keys.keys} label={keys.label} /> to send
              {/* A button, so Tab reaches it: its name is the note, which is also its tooltip. */}
              <InfoTip text={LIMITS_NOTE} className="relay-info" />
            </p>
            {count && (
              <p className={count.over ? 'relay-count over' : 'relay-count'} id={ids.count}>
                {count.text}
              </p>
            )}
          </div>
        </form>
      ) : (
        <p className="relay-note">{NOT_RUNNING_NOTE}</p>
      )}
    </section>
  );
}

export interface RelayExchangeNoteProps {
  exchange: RelayExchange;
  /** False when the conversation already shows the reply: then only the status line. */
  showReply?: boolean;
}

/** The latest message pitwall relayed to a session, and its reply, as text only. */
export function RelayExchangeNote({ exchange, showReply = true }: RelayExchangeNoteProps) {
  const summary = exchangeSummary(exchange);
  const reply = showReply && exchange.reply ? exchange.reply : undefined;
  return (
    <div className="relay-exchange">
      <p className="relay-exchange-line">
        Message from pitwall · <Timestamp at={exchange.sentAt} />: <span className={`relay-exchange-status tone-${summary.tone}`}>{summary.status}</span>
      </p>
      {reply && (
        <Tooltip content={`Replied ${absoluteTime(reply.at)}`} relation="none">
          {/* Three lines at most (two on short windows), then it scrolls: a Tab stop while it does (ScrollBox). */}
          <ScrollBox as="p" className="relay-reply" label="Reply">
            <span className="relay-reply-label">Reply:</span> {plainText(reply.text)}
          </ScrollBox>
        </Tooltip>
      )}
    </div>
  );
}
