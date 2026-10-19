import { useContext, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { RelayExchange, RelayStatus, SessionSummary } from '../../../src/shared/protocol.js';
import { ApiContext } from '../api.js';
import { absoluteTime, plainText, relativeTime } from '../format.js';
import { canMessage, exchangeSummary, MAX_RELAY_TEXT_LENGTH, outgoingText, registerRelayFocus, sendRelay, STATUS_TEXT, statusTone, type RelayTone } from '../relay.js';
import '../relay.css';

/** What the box shows after a send. `error` is pitwall's own failure, before the relay answered. */
interface Shown {
  status: RelayStatus | 'error';
  text: string;
  detail?: string;
}

const LIMITS_NOTE =
  "Starts a turn on that session's model. The session sees it as a message from another session, not from you, so it can't approve prompts.";

export interface RelayBoxProps {
  /** An interactive session. */
  session: SessionSummary;
  now: number;
}

/**
 * "Message this session": sends text through pitwall's relay (D8) and shows
 * what happened, then the latest exchange and any reply, as text only.
 */
export function RelayBox({ session, now }: RelayBoxProps) {
  const api = useContext(ApiContext);
  const headingId = useId();
  const textId = useId();
  const noteId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
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

  // The row's Message button: the box takes the focus.
  useEffect(() => registerRelayFocus(sessionId, () => textRef.current?.focus()), [sessionId]);

  const messageable = canMessage(session);
  const tooLong = outgoingText(text).length > MAX_RELAY_TEXT_LENGTH;
  const canSend = messageable && !sending && text.trim() !== '' && !tooLong && api !== undefined;

  const send = async () => {
    if (!canSend || !api) return;
    setSending(true);
    setShown(undefined);
    const outcome = await sendRelay(api, sessionId, text, requests.current?.signal);
    if (!alive.current) return;
    setSending(false);
    if (outcome.kind === 'unauthorized') return;
    if (outcome.kind === 'failed') {
      setShown({ status: 'error', text: outcome.error });
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
    } else if (event.key === 'Escape' && text !== '') {
      // Keep the draft: Escape elsewhere closes the session view.
      event.preventDefault();
    }
  };

  return (
    <section className="relay-box" aria-labelledby={headingId}>
      <h3 className="relay-title" id={headingId}>
        Message this session
      </h3>
      <p className="relay-note" id={noteId}>
        {LIMITS_NOTE}
      </p>
      {messageable ? (
        <form className="relay-form" onSubmit={onSubmit}>
          <label className="visually-hidden" htmlFor={textId}>
            Message to {plainText(session.name)}
          </label>
          <textarea
            id={textId}
            ref={textRef}
            className="field-input relay-text"
            rows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            disabled={sending}
            aria-describedby={noteId}
            aria-invalid={tooLong || undefined}
            spellCheck
          />
          <div className="relay-actions">
            <span className={tooLong ? 'relay-count over' : 'relay-count'}>
              {tooLong ? `${text.length - MAX_RELAY_TEXT_LENGTH} characters over the ${MAX_RELAY_TEXT_LENGTH} limit` : `${text.length} / ${MAX_RELAY_TEXT_LENGTH}`}
            </span>
            <button type="submit" className="button small primary" disabled={!canSend} aria-busy={sending || undefined}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      ) : (
        <p className="relay-note">It isn&apos;t running, so it can&apos;t be messaged.</p>
      )}
      {shown && (
        <p className={`relay-result tone-${tone(shown.status)}`} role={shown.status === 'delivered' ? 'status' : 'alert'}>
          {shown.text}
          {shown.detail !== undefined && <span className="relay-detail"> {plainText(shown.detail)}</span>}
        </p>
      )}
      {session.relay && <RelayExchangeNote exchange={session.relay} now={now} />}
    </section>
  );
}

function tone(status: Shown['status']): RelayTone {
  return status === 'error' ? 'failed' : statusTone(status);
}

export interface RelayExchangeNoteProps {
  exchange: RelayExchange;
  now: number;
  /** On a row: one line for the reply, which the title shows in full. */
  compact?: boolean;
}

/** The latest message pitwall relayed to a session, and its reply, as text only. */
export function RelayExchangeNote({ exchange, now, compact = false }: RelayExchangeNoteProps) {
  const summary = exchangeSummary(exchange);
  const reply = exchange.reply ? plainText(exchange.reply.text) : undefined;
  return (
    <div className={compact ? 'relay-exchange compact' : 'relay-exchange'}>
      <p className={`relay-exchange-line tone-${summary.tone}`}>
        <span className="relay-exchange-label">Message from pitwall</span>{' '}
        <time dateTime={exchange.sentAt} title={absoluteTime(exchange.sentAt)}>
          {relativeTime(exchange.sentAt, now)}
        </time>
        : {summary.status}
      </p>
      {reply !== undefined && exchange.reply && (
        <p className="relay-reply" title={compact ? `${reply}\n${absoluteTime(exchange.reply.at)}` : absoluteTime(exchange.reply.at)}>
          <span className="who">Reply</span> {reply}
        </p>
      )}
    </div>
  );
}
