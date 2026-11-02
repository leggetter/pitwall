// A copy button (docs/design-system.md, 4: Copy): a ghost sm icon button named for what it copies
// ("Copy path"), with the same tooltip. It writes inside the click, as Safari requires.
//
// - Copied: the icon is `copied` for --pw-copied-timeout (2 s), and a "Copied" toast says so.
// - Refused: the text on screen is selected, so it can be copied by hand, and "Couldn't copy; the text
//   is selected" is the button's tooltip, described by it, until the next copy, and an error toast.

import { useEffect, useRef, useState, type RefObject } from 'react';
import { COPIED, COPY_FAILED, selectText, useCopy } from '../copy.js';
import { COPIED_TIMEOUT_MS, cssTime } from '../timing.js';
import { Icon } from './Icon.js';
import { useToast } from './Toast.js';
import { Tooltip } from './Tooltip.js';

export interface CopyButtonProps {
  /** What it copies. */
  text: string;
  /** Its name and tooltip: "Copy" and what it copies, such as "Copy path". */
  label: string;
  /** The text on screen, selected when the clipboard refuses. */
  target?: RefObject<HTMLElement | null> | undefined;
  className?: string | undefined;
  /** sm, 24 px, beside text, as by a path; md, 28 px, among a view header's other icon buttons, as the PR view's Copy link (W95). */
  size?: 'sm' | 'md';
}

export function CopyButton({ text, label, target, className, size = 'sm' }: CopyButtonProps) {
  const copy = useCopy();
  const toast = useToast();
  const button = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const [result, setResult] = useState<'idle' | 'copied' | 'failed'>('idle');
  // Bumped on each success, so a second copy within the 2 s starts them again.
  const [round, setRound] = useState(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (result !== 'copied') return;
    const timer = setTimeout(() => setResult('idle'), cssTime(button.current, '--pw-copied-timeout', COPIED_TIMEOUT_MS));
    return () => clearTimeout(timer);
  }, [result, round]);

  const onClick = () => {
    void copy(text).then((ok) => {
      if (!alive.current) return;
      if (ok) {
        setResult('copied');
        setRound((value) => value + 1);
        toast({ tone: 'success', message: COPIED });
      } else {
        selectText(target?.current ?? null);
        setResult('failed');
        toast({ tone: 'error', message: COPY_FAILED });
      }
    });
  };

  const failed = result === 'failed';
  return (
    // Named for what it copies; after a refusal, the tooltip says why and the button is described by it.
    <Tooltip content={failed ? COPY_FAILED : label} relation={failed ? 'description' : 'label'}>
      <button
        ref={button}
        type="button"
        className={['icon-button ghost', size, 'copy-button', result === 'copied' && 'copied', className].filter(Boolean).join(' ')}
        aria-label={label}
        data-copy={result}
        onClick={onClick}
      >
        <Icon name={result === 'copied' ? 'copied' : 'copy'} />
      </button>
    </Tooltip>
  );
}
