// The gallery's own building blocks (W19): a specimen with its caption, and scenarios that put a
// real component into a state by using it, as a person would: typing, choosing, pressing. That
// keeps the components unchanged, with no props that exist only for the gallery.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/** Collects the scenarios still running, so the gallery knows when every specimen has settled. */
export const SettleContext = createContext<((work: Promise<unknown>) => void) | undefined>(undefined);

export type ThemeChoice = 'light' | 'dark' | 'none';

/** The gallery's theme: what the toolbar chose, and what that resolves to now. */
export const ThemeContext = createContext<{ choice: ThemeChoice; resolved: 'light' | 'dark' }>({ choice: 'none', resolved: 'light' });

export interface SpecimenProps {
  title: string;
  note?: ReactNode;
  /**
   * A frame holds what the app positions against the window (the session view, dialogs, whole
   * pages): it becomes their containing block, so they sit inside it. Its height is the window's.
   */
  frame?: 'view' | 'short' | 'dialog' | 'page';
  children: ReactNode;
}

export function Specimen({ title, note, frame, children }: SpecimenProps) {
  return (
    <div className="uikit-specimen">
      <h3>{title}</h3>
      {note !== undefined && <p className="uikit-note">{note}</p>}
      <div className={frame ? `uikit-stage uikit-frame uikit-frame-${frame}` : 'uikit-stage'}>{children}</div>
    </div>
  );
}

/** Polls until `find` returns something, every frame or so. performance.now(), since a screenshot run may freeze Date.now(). */
export async function until<T>(what: string, find: () => T | null | undefined | false, timeoutMs = 3000): Promise<T> {
  const end = performance.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found) return found;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

/** The element `selector` matches inside `root`, waiting for it to appear. */
export function element<T extends Element = HTMLElement>(root: ParentNode, selector: string): Promise<T> {
  return until(selector, () => root.querySelector<T>(selector));
}

/** Types into a field as a person would, so React sees the change. */
export function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Chooses the option whose text is `label`. */
export function choose(select: HTMLSelectElement, label: string): void {
  const option = [...select.options].find((candidate) => candidate.text === label);
  if (!option) throw new Error(`no option "${label}"`);
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, option.value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Presses the button labelled `label` inside `root`, waiting for it to appear. */
export async function press(root: ParentNode, label: string): Promise<void> {
  const button = await until(`the ${label} button`, () =>
    [...root.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label && !candidate.disabled),
  );
  button.click();
}

/** Text that appears inside `root`. */
export function text(root: HTMLElement, wanted: string): Promise<true> {
  return until(`"${wanted}"`, () => root.textContent?.includes(wanted) || undefined);
}

export interface ScenarioProps {
  /** Puts the specimen inside `root` into its state. Runs once, after the first render. */
  run: (root: HTMLElement) => Promise<unknown>;
  children: ReactNode;
}

/** Runs `run` against its children once they're on screen, and says so if it couldn't finish. */
export function Scenario({ run, children }: ScenarioProps) {
  const ref = useRef<HTMLDivElement>(null);
  const settle = useContext(SettleContext);
  const started = useRef(false);
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    const root = ref.current;
    if (!root || started.current) return;
    started.current = true;
    const work = run(root).catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
    settle?.(work);
  }, [run, settle]);

  return (
    <div ref={ref} className="uikit-scenario">
      {problem !== undefined && (
        <p className="uikit-problem" role="status">
          This specimen didn&apos;t reach its state: {problem}
        </p>
      )}
      {children}
    </div>
  );
}

/** A dialog that Cancel and Escape close, as in the app, with a way to open it again in the same state. */
export function Reopenable({ children }: { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(true);
  const [round, setRound] = useState(0);
  if (!open) {
    return (
      <p className="uikit-reopen">
        <button
          type="button"
          onClick={() => {
            setRound((value) => value + 1);
            setOpen(true);
          }}
        >
          Open it again
        </button>
      </p>
    );
  }
  return <div key={round}>{children(() => setOpen(false))}</div>;
}
