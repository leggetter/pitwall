// Trust this folder… (W214, spike 020): Claude Code's own trust prompt, answered in the page, on the
// "Workspace not trusted" cards of New session (NewSessionDialog.tsx) and Resume in background
// (EndedSession.tsx). Shown only where the card has a command to copy (the server's `hint`), and only
// inside App, which provides the socket (AttachContext); the command stays for a terminal.
//
// - The button opens a small terminal (xterm.ts, as the Terminal tab's), over the trust socket (trust.ts),
//   a bare `claude` in the folder on the server. pitwall never trusts the folder itself.
// - Keys: only Up, Down, Enter and Esc go to it (TRUST_INPUT), and the server drops anything else too.
//   A paste or a typed character does nothing. Escape is Claude Code's (No, on its trust prompt), so it
//   doesn't close the dialog or the session view: the screen cancels it, and Dialog leaves a cancelled
//   Escape alone. Tab is the page's, so focus can leave the screen.
// - Cancel closes the socket, which ends `claude`.
// - Trusted: onTrusted, once, which sends the start or the resume again; its answer is the proof.
//   Declined, unclear or a failure: a line saying so, and the button again.

import { useContext, useEffect, useId, useRef, useState } from 'react';
import { AttachContext } from '../attach.js';
import { plainText } from '../format.js';
import { startTrust, trustEndMessage, trustSocketUrl, type TrustEnd, type TrustSession } from '../trust.js';
import type { XtermOptions } from '../xterm.js';
import { Detail } from './Alert.js';
import { Button } from './Button.js';
import type { TerminalHandle } from './Terminal.js';
import './Terminal.css';

export const TRUST_BUTTON = 'Trust this folder…';
/** What the terminal is, over it, and the screen's description. */
export const TRUST_PROMPT_LINE = "Claude Code's own trust prompt. Use ↑ ↓ and Enter.";
/** Before the button, after the command to copy. */
export const TRUST_HERE = {
  start: 'Or answer the prompt here, and the session starts once the folder is trusted.',
  resume: 'Or answer the prompt here, and the session resumes once the folder is trusted.',
} as const;
export const TRUSTED = {
  start: 'Claude Code trusted this folder. Starting the session…',
  resume: 'Claude Code trusted this folder. Resuming the session…',
} as const;

/** xterm.js, loaded on first use, as the Terminal tab loads it. */
async function createTerminal(container: HTMLElement, options: XtermOptions): Promise<TerminalHandle> {
  return (await import('../xterm.js')).createXterm(container, options);
}

/** Tab with or without Shift, and no other modifier: the page's, so focus can leave the screen. */
export function isTabKey(event: KeyboardEvent): boolean {
  return event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey;
}

type Phase = { kind: 'idle'; end?: TrustEnd } | { kind: 'open' } | { kind: 'trusted' };

export interface TrustFolderProps {
  /** The folder whose trust prompt it opens: the server checks it as New session does. */
  cwd: string;
  /** Claude Code trusted it: send the start, or the resume, again. Called once for each terminal. */
  onTrusted: () => void;
  /** On Resume's card: its sentences say resume. */
  resume?: boolean;
}

export function TrustFolder({ cwd, onTrusted, resume = false }: TrustFolderProps) {
  const env = useContext(AttachContext);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // Bumped by each open, so a second try makes a new terminal and socket.
  const [attempt, setAttempt] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const session = useRef<TrustSession | undefined>(undefined);
  const lineId = useId();
  const onTrustedRef = useRef(onTrusted);
  onTrustedRef.current = onTrusted;
  // Focus goes back to the button once the terminal has gone, when it was in the terminal or on Cancel.
  const refocus = useRef(false);
  const open = phase.kind === 'open';
  const verb = resume ? 'resume' : 'start';

  useEffect(() => {
    if (!open || !env) return;
    const element = container.current;
    if (!element) return;
    let disposed = false;
    let terminal: TerminalHandle | undefined;
    let observer: ResizeObserver | undefined;
    // Ends the terminal once, for an answer or a failure: the first wins.
    let settled = false;
    const finish = (end: TrustEnd) => {
      if (disposed || settled) return;
      settled = true;
      refocus.current = element.contains(document.activeElement);
      if (end.kind === 'outcome' && end.outcome === 'trusted') {
        setPhase({ kind: 'trusted' });
        onTrustedRef.current();
        return;
      }
      setPhase({ kind: 'idle', end });
    };
    // Escape is Claude Code's here, which xterm.js sends: nothing behind closes for it (Dialog, Frame).
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') event.preventDefault();
    };
    element.addEventListener('keydown', onKey);

    Promise.resolve()
      .then(() => createTerminal(element, { describedBy: lineId, leaveKey: isTabKey, onResize: (cols, rows) => session.current?.resize(cols, rows) }))
      .then(
        (created) => {
          if (disposed) {
            created.dispose();
            return;
          }
          terminal = created;
          // Every key and paste arrives here; the session sends only the four keys.
          created.onData((data) => session.current?.input(data));
          session.current = startTrust({
            url: trustSocketUrl(env.host),
            token: env.token,
            cwd,
            createSocket: env.createSocket,
            size: () => ({ cols: created.cols, rows: created.rows }),
            onStatus: (status) => {
              if (disposed) return;
              if (status.kind === 'running') {
                created.fit();
                session.current?.resize(created.cols, created.rows);
              } else if (status.kind === 'ended') {
                finish(status.end);
              }
            },
            onOutput: (data) => created.write(data),
          });
          if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(() => {
              created.fit();
              session.current?.resize(created.cols, created.rows);
            });
            observer.observe(element);
          }
          // Asked for with the button: the prompt is what you answer next.
          created.focus();
        },
        () => finish({ kind: 'error', error: "the terminal couldn't be loaded." }),
      );

    return () => {
      disposed = true;
      element.removeEventListener('keydown', onKey);
      observer?.disconnect();
      session.current?.cancel();
      session.current = undefined;
      terminal?.dispose();
    };
  }, [open, attempt, env, cwd, lineId]);

  useEffect(() => {
    if (phase.kind !== 'idle' || !refocus.current) return;
    refocus.current = false;
    button.current?.focus();
  }, [phase]);

  if (!env) return null;

  if (phase.kind === 'trusted') {
    return (
      <div className="trust-folder">
        <p className="spawn-trust" role="status">
          {TRUSTED[verb]}
        </p>
      </div>
    );
  }

  if (phase.kind === 'open') {
    return (
      <div className="trust-folder" data-state="open">
        <p className="spawn-trust" id={lineId}>
          {TRUST_PROMPT_LINE}
        </p>
        <div className="attach-terminal trust-folder-screen">
          <div className="attach-terminal-fit" ref={container} />
        </div>
        <div className="trust-folder-actions">
          <Button
            size="sm"
            onClick={() => {
              session.current?.cancel();
              refocus.current = true;
              // A terminal still loading has no session to cancel yet: closing it here ends it.
              setPhase({ kind: 'idle', end: { kind: 'cancelled' } });
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const notice = phase.end ? trustEndMessage(phase.end, resume) : undefined;
  return (
    <div className="trust-folder">
      {notice && (
        <p className="spawn-trust trust-folder-notice" role="status">
          {plainText(notice.text)}
          {notice.detail !== undefined && (
            <>
              {' '}
              <Detail>{plainText(notice.detail)}</Detail>
            </>
          )}
        </p>
      )}
      <p className="spawn-trust">{TRUST_HERE[verb]}</p>
      <div className="trust-folder-actions">
        <Button
          ref={button}
          size="sm"
          onClick={() => {
            setAttempt((count) => count + 1);
            setPhase({ kind: 'open' });
          }}
        >
          {TRUST_BUTTON}
        </Button>
      </div>
    </div>
  );
}
