import { useEffect, useId, useRef, useState } from 'react';

type CopyResult = 'idle' | 'copied' | 'failed';

/** Selects the command's text so it can be copied by hand when the clipboard API refuses. */
function selectContents(element: HTMLElement | null) {
  if (!element) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** A shell command shown as code, with a button that copies it. */
export function CopyCommand({ command }: { command: string }) {
  const codeRef = useRef<HTMLElement>(null);
  const codeId = useId();
  const [result, setResult] = useState<CopyResult>('idle');

  useEffect(() => {
    if (result === 'idle') return;
    const timer = setTimeout(() => setResult('idle'), 2_000);
    return () => clearTimeout(timer);
  }, [result]);

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(command);
      setResult('copied');
    } catch {
      selectContents(codeRef.current);
      setResult('failed');
    }
  };

  return (
    <div className="copy-command">
      <code ref={codeRef} id={codeId}>
        {command}
      </code>
      <button type="button" className="button sm" aria-describedby={codeId} onClick={() => void copy()}>
        Copy
      </button>
      <span className="copy-status" role="status">
        {result === 'copied' ? 'Copied' : result === 'failed' ? "Couldn't copy; the command is selected" : ''}
      </span>
    </div>
  );
}
