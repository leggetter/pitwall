// A background session's terminal, inside the session view (W10, D3, D9):
// xterm.js over an attach socket running `claude attach`. Unmounting detaches,
// so closing the view or the tab leaves the session running.

import { useCallback, useContext, useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { SessionKind } from '../../../src/shared/protocol.js';
import { AttachContext, attachSocketUrl, endMessage, startAttach, type AttachSession, type AttachStatus } from '../attach.js';
import './Terminal.css';

/** What the view needs from a terminal. createXterm() (xterm.ts) is the real one. */
export interface TerminalHandle {
  readonly cols: number;
  readonly rows: number;
  /** PTY output, as UTF-8 bytes. */
  write(data: Uint8Array): void;
  /** Keystrokes and pastes. */
  onData(listener: (data: string) => void): void;
  /** Resizes the terminal to fill its container. */
  fit(): void;
  focus(): void;
  dispose(): void;
}

/** xterm.js (xterm.ts), loaded on first use so the dashboard doesn't download it up front. */
async function createTerminal(container: HTMLElement): Promise<TerminalHandle> {
  return (await import('../xterm.js')).createXterm(container);
}

export interface AttachToggle {
  /** True for a background session, when the app provides a way to attach. */
  available: boolean;
  /** True while the terminal is shown. */
  open: boolean;
  show: () => void;
  /** Closes the terminal, which detaches, and puts focus back on the Attach button. */
  hide: () => void;
  /** For the Attach button. */
  buttonRef: RefObject<HTMLButtonElement | null>;
}

/** Whether the session view shows its terminal, for SessionView. */
export function useAttachToggle(kind: SessionKind): AttachToggle {
  const env = useContext(AttachContext);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Set when the terminal closes, so focus goes back to Attach rather than being lost.
  const refocus = useRef(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => {
    refocus.current = true;
    setOpen(false);
  }, []);
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    buttonRef.current?.focus();
  }, [open]);
  return { available: kind === 'background' && env !== undefined, open, show, hide, buttonRef };
}

const STATE_LABELS: Record<AttachStatus['kind'], string> = {
  connecting: 'Attaching…',
  'confirm-restart': 'Not running',
  attached: 'Attached',
  ended: 'Detached',
};

export interface SessionTerminalProps {
  sessionId: string;
  /** Leaves the terminal for the conversation. Unmounting detaches. */
  onClose: () => void;
}

export function SessionTerminal({ sessionId, onClose }: SessionTerminalProps) {
  const env = useContext(AttachContext);
  const container = useRef<HTMLDivElement>(null);
  const session = useRef<AttachSession | undefined>(undefined);
  const [status, setStatus] = useState<AttachStatus>({ kind: 'connecting' });
  // Bumped by "Attach again", which starts over with a new terminal and socket.
  const [attempt, setAttempt] = useState(0);
  const confirmId = useId();

  useEffect(() => {
    const element = container.current;
    if (!env || !element) return;
    let disposed = false;
    let terminal: TerminalHandle | undefined;
    let observer: ResizeObserver | undefined;
    setStatus({ kind: 'connecting' });

    Promise.resolve()
      .then(() => createTerminal(element))
      .then(
        (created) => {
          if (disposed) {
            created.dispose();
            return;
          }
          terminal = created;
          const attach = startAttach({
            url: attachSocketUrl(env.host),
            token: env.token,
            sessionId,
            createSocket: env.createSocket,
            size: () => ({ cols: created.cols, rows: created.rows }),
            onStatus: (next) => {
              if (disposed) return;
              setStatus(next);
              if (next.kind === 'attached') {
                // The panel may have changed size while the socket was opening.
                created.fit();
                session.current?.resize(created.cols, created.rows);
                created.focus();
              }
            },
            onOutput: (data) => created.write(data),
          });
          session.current = attach;
          created.onData((data) => attach.input(data));
          if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(() => {
              created.fit();
              attach.resize(created.cols, created.rows);
            });
            observer.observe(element);
          }
        },
        () => {
          if (!disposed) setStatus({ kind: 'ended', end: { kind: 'error', error: "the terminal couldn't be loaded." } });
        },
      );

    return () => {
      disposed = true;
      observer?.disconnect();
      session.current?.detach();
      session.current = undefined;
      terminal?.dispose();
    };
  }, [env, sessionId, attempt]);

  // Escape belongs to the terminal (it interrupts Claude), so it doesn't close the view.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') event.preventDefault();
    };
    element.addEventListener('keydown', onKey);
    return () => element.removeEventListener('keydown', onKey);
  }, []);

  const ended = status.kind === 'ended';
  const notice = ended ? endMessage(status.end) : undefined;
  const failed = ended && status.end.kind !== 'exit' && status.end.kind !== 'detached';

  return (
    <div className="attach">
      <div className="attach-bar">
        <span className={`attach-state state-${status.kind}`} role="status">
          {env ? STATE_LABELS[status.kind] : 'Attach is unavailable here.'}
        </span>
        {ended && (
          <button type="button" className="button small" onClick={() => setAttempt((count) => count + 1)}>
            Attach again
          </button>
        )}
        <button type="button" className="button small" onClick={onClose}>
          {ended ? 'Back to the conversation' : 'Detach'}
        </button>
      </div>
      {status.kind === 'confirm-restart' && (
        <div className="banner warning attach-confirm" role="alertdialog" aria-describedby={confirmId}>
          <p id={confirmId}>This session has finished, or its process has exited. Attaching restarts it.</p>
          <div className="attach-confirm-actions">
            <button type="button" className="button small" onClick={() => session.current?.confirmRestart()}>
              Restart and attach
            </button>
            <button type="button" className="button small" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {notice && (
        <p className={failed ? 'banner error attach-notice' : 'banner muted attach-notice'} role="alert">
          {notice}
        </p>
      )}
      <div className="attach-terminal" ref={container} />
    </div>
  );
}
