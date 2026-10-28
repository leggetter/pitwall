// A background session's terminal, the session view's Terminal tab (W10, D3, D9; W22; W29):
// xterm.js over an attach socket running `claude attach`. Mounting attaches and unmounting
// detaches, so switching to the Conversation tab, closing the view or closing the browser tab
// leaves the session running.
//
// docs/design-system.md, 4: Terminal. The bar has the status badge, a hint, and ghost sm "Attach
// again" and "Detach" buttons. The hint is "F6 to leave the terminal", or, while it's attached and
// the screen doesn't have focus, how to type to it (W57). Below it, the screen: xterm.js on
// --pw-term-bg, its font and colours from the tokens (xterm.ts). A notice for an attach that ended
// is an inline alert above the screen, neutral when it ended as asked and danger when it failed.
//
// Keys: every key goes to the terminal, Escape included (it interrupts Claude), so Escape never
// closes the view from here. Two are taken before xterm.js sees them. F6 moves focus to the Terminal
// tab, so the terminal isn't a keyboard trap (WCAG 2.1.2), and never reaches the session. Shift+Enter
// sends a line feed (Ctrl+J), a new line in Claude Code's prompt (W41), where xterm.js would send
// Enter's carriage return, which submits.
//
// A session that isn't running asks first, as an inline confirmation under the bar (W24): Cancel
// takes focus, and goes back to the conversation; "Restart and attach" stays busy until the attach
// has started or failed.
//
// Once attached, the terminal takes focus if the view says it may: only right after you asked for it
// in this page, and while focus is still in the view (focusGesture.ts, W57). Attach again and a
// confirmed restart are asked for here, so it tells the view of each (onAsk). A terminal the view
// opened on by stepping (j, k, ↑, ↓) waits --pw-delay-attach before it attaches, so a session only
// passed through is never attached, and doesn't take focus when it does, so the next step is still a
// step (W54). It shows "Attaching…" while it waits.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ATTACH_COMMAND, attachSocketUrl, endMessage, startAttach, type AttachEnd, type AttachEnv, type AttachSession, type AttachStatus, type EndNotice } from '../attach.js';
import { isComposing } from '../composing.js';
import { plainText } from '../format.js';
import type { BadgeLook } from '../sessions.js';
import { ATTACH_DELAY_MS, cssTime } from '../timing.js';
import type { XtermOptions } from '../xterm.js';
import { Alert, Detail } from './Alert.js';
import { Badge, type BadgeProps } from './Badge.js';
import { Button } from './Button.js';
import { InlineConfirm } from './InlineConfirm.js';
import { KeyCaps } from './KeyCaps.js';
import './Terminal.css';

/** The restart confirmation: open, or busy once confirmed, until the attach has started or failed. */
export type RestartPhase = 'asking' | 'restarting';

export const RESTART = {
  question: 'Restart and attach?',
  consequence: 'This session has finished, or its process has exited. Attaching restarts it.',
  confirm: 'Restart and attach',
  busy: 'Restarting…',
} as const;

/** The key that leaves the terminal, for the Terminal tab (6.1 rule 14, 6.2). */
export const LEAVE_KEY = 'F6';

/**
 * The bar's hint while it's attached and the screen doesn't have focus (W57): what's typed goes
 * elsewhere until you click the screen or Tab to it, as after a reload, a step, or F6.
 */
export const TYPE_HINT = 'Click the terminal, or Tab to it, to type to the session';

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
async function createTerminal(container: HTMLElement, options: XtermOptions): Promise<TerminalHandle> {
  return (await import('../xterm.js')).createXterm(container, options);
}

/** A notice's text, with `claude attach` in code style wherever it's named, then the server's reason as its detail. */
function NoticeText({ notice }: { notice: EndNotice }): ReactNode {
  const parts = plainText(notice.text).split(ATTACH_COMMAND);
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && <code>{ATTACH_COMMAND}</code>}
          {part}
        </span>
      ))}
      {notice.detail !== undefined && (
        <>
          {' '}
          <Detail>{plainText(notice.detail)}</Detail>
        </>
      )}
    </>
  );
}

/** The bar's status badge for each attach status (4: Terminal). */
export const STATUS_BADGES: Record<AttachStatus['kind'], { label: string; look: BadgeLook; lead?: BadgeProps['lead'] }> = {
  connecting: { label: 'Attaching…', look: 'subtle-neutral', lead: 'spinner' },
  attached: { label: 'Attached', look: 'subtle-success', lead: 'dot' },
  ended: { label: 'Detached', look: 'subtle-neutral' },
  'confirm-restart': { label: 'Not running', look: 'outline' },
};

/**
 * A notice's tone: neutral when `claude attach` ended as it should (it exited cleanly, as it does
 * when you detach inside it), danger when it failed: a non-zero exit, the server refusing or
 * failing, too many attached, the proof refused, or the connection lost.
 */
export function noticeTone(end: AttachEnd): 'neutral' | 'danger' {
  return end.kind === 'detached' || (end.kind === 'exit' && (end.code === null || end.code === 0)) ? 'neutral' : 'danger';
}

/** Ignores F6 with a modifier, which goes to the terminal like any other key. */
function isLeaveKey(event: KeyboardEvent): boolean {
  return event.key === LEAVE_KEY && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

/**
 * What Shift+Enter sends: a line feed, which is Ctrl+J. Claude Code's terminal docs give Ctrl+J as
 * the way to add a line break without submitting, in every terminal with no setup
 * (code.claude.com/docs/en/terminal-config, "Enter multiline prompts"). xterm.js sends a carriage
 * return for Enter with or without Shift, and that submits.
 */
export const NEW_LINE = '\n';

/**
 * Shift+Enter with no other modifier, and not while an input method composes. With Ctrl, Alt or ⌘
 * too, or while composing, it goes to xterm.js like any other key.
 */
function isNewLineKey(event: KeyboardEvent): boolean {
  return event.key === 'Enter' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !isComposing(event);
}

export interface SessionTerminalProps {
  sessionId: string;
  /** The token and socket factory for the attach. The view shows the Terminal tab only when it has one. */
  env: AttachEnv;
  /** Leaves the terminal for the conversation. Unmounting detaches. */
  onClose: () => void;
  /** F6 in the terminal: focus goes to the Terminal tab, and the terminal stays attached. */
  onLeave?: () => void;
  /** Each status as it changes, for the Terminal tab's dot and Escape's layering in the session view. */
  onStatus?: (status: AttachStatus) => void;
  /** The restart confirmation's phase as it changes, for Escape's layering in the session view. */
  onRestartChange?: (phase: RestartPhase | undefined) => void;
  /**
   * Opened by stepping onto the session (W54): the first attach starts only once --pw-delay-attach has
   * passed with the terminal still open, and doesn't take focus. Read as the terminal opens. Attach
   * again starts at once.
   */
  wait?: boolean;
  /** Whether the terminal may take focus now that it has attached. Always, unless this says no. */
  canFocus?: () => boolean;
  /**
   * Attach again, or a confirmed Restart and attach, with the element pressed when there's one: asked
   * for in this page, so the view lets the attach that follows take focus (W57).
   */
  onAsk?: (target: Element | undefined) => void;
  /** The id for the hint that says how to type to it, which the view's Terminal tab is described by (W57). */
  typeHintId?: string;
}

export function SessionTerminal({ sessionId, env, onClose, onLeave, onStatus, onRestartChange, wait = false, canFocus, onAsk, typeHintId }: SessionTerminalProps) {
  // The box xterm.js opens in, inside the screen's padding: what the fit addon measures, and what a
  // resize is watched on (W74).
  const container = useRef<HTMLDivElement>(null);
  // The F6 hint, which describes xterm.js's textarea, so a screen reader in the terminal hears how to leave.
  const hintId = useId();
  const ownTypeHintId = useId();
  // Whether focus is in the screen, xterm.js's textarea, for which hint the bar shows.
  const [focused, setFocused] = useState(false);
  const onAskRef = useRef(onAsk);
  onAskRef.current = onAsk;
  const session = useRef<AttachSession | undefined>(undefined);
  const [status, setStatus] = useState<AttachStatus>({ kind: 'connecting' });
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;
  const canFocusRef = useRef(canFocus);
  canFocusRef.current = canFocus;
  // Read once, for the first attach: a later change, as the view's own state settles, starts nothing over.
  const waits = useRef(wait);
  // This attach waited, and so takes no focus, until a confirmed restart asks for it.
  const quiet = useRef(false);
  useEffect(() => {
    onStatusRef.current?.(status);
  }, [status]);
  // Bumped by "Attach again", which starts over with a new terminal and socket.
  const [attempt, setAttempt] = useState(0);
  // Confirmed, and waiting for the attach to start or fail.
  const [restarting, setRestarting] = useState(false);
  const attachAgain = useRef<HTMLButtonElement>(null);
  const phase: RestartPhase | undefined =
    status.kind === 'confirm-restart' ? 'asking' : restarting && status.kind === 'connecting' ? 'restarting' : undefined;
  const onRestartRef = useRef(onRestartChange);
  onRestartRef.current = onRestartChange;
  useEffect(() => {
    onRestartRef.current?.(phase);
  }, [phase]);
  useEffect(() => () => onRestartRef.current?.(undefined), []);
  // The restart has started or failed. Attached, the terminal takes focus; ended, Attach again does,
  // since the busy button that had it has gone.
  useEffect(() => {
    if (!restarting || status.kind === 'connecting') return;
    setRestarting(false);
    if (status.kind === 'ended') attachAgain.current?.focus();
  }, [restarting, status]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let disposed = false;
    let terminal: TerminalHandle | undefined;
    let observer: ResizeObserver | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Whether the wait, if any, is over; and whether this run has started its attach.
    let waited = true;
    let started = false;
    setStatus({ kind: 'connecting' });
    // A new screen, which has no focus yet: the last one's went with it, with or without a blur.
    setFocused(false);
    // Only the first attempt waits: Attach again is asked for.
    quiet.current = attempt === 0 && waits.current;

    /** Attaches once the terminal is there and the wait is over, whichever comes last. */
    const begin = () => {
      const created = terminal;
      if (disposed || started || !waited || !created) return;
      started = true;
      session.current = startAttach({
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
            if (!quiet.current && (canFocusRef.current?.() ?? true)) created.focus();
          }
        },
        onOutput: (data) => created.write(data),
      });
    };

    // Stepped onto: attach once the session has stayed open for the delay, counted from when the
    // terminal opened, while it loads. Moving on unmounts the view, which clears the timer, so nothing
    // attaches for a session only passed through.
    if (quiet.current) {
      waited = false;
      timer = setTimeout(() => {
        timer = undefined;
        waited = true;
        begin();
      }, cssTime(element, '--pw-delay-attach', ATTACH_DELAY_MS));
    }

    Promise.resolve()
      .then(() =>
        createTerminal(element, {
          describedBy: hintId,
          // A font that arrived late changed the cells' size: the session gets the new one.
          onResize: (cols, rows) => session.current?.resize(cols, rows),
        }),
      )
      .then(
        (created) => {
          if (disposed) {
            created.dispose();
            return;
          }
          terminal = created;
          // Keys before the attach has started go nowhere, as every key does then.
          created.onData((data) => session.current?.input(data));
          if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(() => {
              created.fit();
              session.current?.resize(created.cols, created.rows);
            });
            observer.observe(element);
          }
          begin();
        },
        () => {
          if (!disposed) setStatus({ kind: 'ended', end: { kind: 'error', error: "the terminal couldn't be loaded." } });
        },
      );

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      observer?.disconnect();
      session.current?.detach();
      session.current = undefined;
      terminal?.dispose();
    };
  }, [env, sessionId, attempt, hintId]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    // F6 and Shift+Enter, before xterm.js sees them: capturing on the screen runs ahead of xterm.js's
    // own listener on its textarea. Cancelling the keydown also stops the keypress and the textarea's
    // input that would follow it.
    const onScreenKey = (event: KeyboardEvent) => {
      if (isLeaveKey(event)) {
        // F6 never reaches the session.
        event.preventDefault();
        event.stopPropagation();
        onLeaveRef.current?.();
      } else if (isNewLineKey(event)) {
        // A line feed alone, never xterm.js's carriage return too. Held down, it repeats as Enter
        // does: one line feed for each keydown, the repeats included. Before the attach has started,
        // or after it has ended, it goes nowhere, as every key does then.
        event.preventDefault();
        event.stopPropagation();
        session.current?.input(NEW_LINE);
      }
    };
    // Escape belongs to the terminal (it interrupts Claude), so it doesn't close the view.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') event.preventDefault();
    };
    element.addEventListener('keydown', onScreenKey, true);
    element.addEventListener('keydown', onKey);
    return () => {
      element.removeEventListener('keydown', onScreenKey, true);
      element.removeEventListener('keydown', onKey);
    };
  }, []);

  const ended = status.kind === 'ended';
  const notice = ended ? endMessage(status.end) : undefined;
  const tone = ended ? noticeTone(status.end) : 'neutral';
  const badge = STATUS_BADGES[status.kind];
  // How to type to it while it's attached and the screen doesn't have focus; F6 otherwise, as before,
  // since the screen takes every key, attached or not.
  const typeHint = status.kind === 'attached' && !focused;

  return (
    <div className="attach">
      <div className="attach-bar">
        {/* A status region, so each change is announced, as the connection badge's is. */}
        <span className="attach-status" data-status={status.kind} role="status">
          <Badge look={badge.look} lead={badge.lead}>
            {badge.label}
          </Badge>
        </span>
        {/*
          One place for both hints: the one that doesn't apply is hidden but keeps its room, so focus
          moving in or out of the screen never changes the bar's size, which would resize the session.
          Plain text, never a live region: it's read in place, and as the Terminal tab's description.
        */}
        <span className="attach-hints">
          <span className="attach-hint" id={hintId} data-shown={!typeHint}>
            <KeyCaps keys={[LEAVE_KEY]} label={LEAVE_KEY} /> to leave the terminal
          </span>
          <span className="attach-hint attach-type-hint" id={typeHintId ?? ownTypeHintId} data-shown={typeHint}>
            {TYPE_HINT}
          </span>
        </span>
        <span className="attach-actions">
          {ended && (
            <Button
              ref={attachAgain}
              variant="ghost"
              size="sm"
              icon="retry"
              onClick={() => {
                onAskRef.current?.(attachAgain.current ?? undefined);
                setAttempt((count) => count + 1);
              }}
            >
              Attach again
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            {ended ? 'Back to the conversation' : 'Detach'}
          </Button>
        </span>
      </div>
      {phase && (
        <InlineConfirm
          question={RESTART.question}
          consequence={RESTART.consequence}
          confirmLabel={RESTART.confirm}
          busyLabel={RESTART.busy}
          icon="restart"
          variant="primary"
          tone="warning"
          role="alertdialog"
          busy={phase === 'restarting'}
          onConfirm={() => {
            setRestarting(true);
            // Asked for: the terminal takes focus once it's attached, as Restart and attach had it.
            quiet.current = false;
            onAskRef.current?.(undefined);
            session.current?.confirmRestart();
          }}
          onCancel={onClose}
        />
      )}
      {notice && (
        // It arrives live: an alert when it failed, a status when it ended as asked (4: Alerts and banners).
        <Alert tone={tone} role={tone === 'danger' ? 'alert' : 'status'} className="attach-notice">
          <NoticeText notice={notice} />
        </Alert>
      )}
      {/*
        The screen: its padding, edge and fill on the outer box, and xterm.js in a box of its own that
        fills the outer one's content box, with no padding (W74). The fit addon sizes the terminal to
        its parent's computed height and width, less only the terminal element's own padding: given
        the outer box, whose padding the page's border-box sizing counts in, it took up to 12 px more
        than there's room for, so the last row ran into the padding and was cut off, and the last
        column ran under the scrollbar's track.
      */}
      <div
        className="attach-terminal"
        onFocus={() => setFocused(true)}
        onBlur={(event) => setFocused(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))}
      >
        <div className="attach-terminal-fit" ref={container} />
      </div>
    </div>
  );
}
