// A command chip (docs/design-system.md, 4: Copy): a shell command in code style, on one line with a
// middle ellipsis and the whole command in a tooltip, then its copy button. A click selects the whole
// command (user-select: all), and so does a copy the clipboard refuses. Both parts of the ellipsis
// stay in the DOM, so screen readers, find in page and copying by hand get the whole command.

import { useRef } from 'react';
import { CopyButton } from './CopyButton.js';
import { MiddleEllipsis } from './MiddleEllipsis.js';
import { Tooltip } from './Tooltip.js';

export interface CopyCommandProps {
  /** Plain text. */
  command: string;
  /** The copy button's name: "Copy command" unless it says which. */
  label?: string;
}

export function CopyCommand({ command, label = 'Copy command' }: CopyCommandProps) {
  const chip = useRef<HTMLElement>(null);
  return (
    <span className="copy-command">
      <Tooltip content={command} relation="none" onlyIfCut>
        <code ref={chip} className="command-chip">
          <MiddleEllipsis text={command} />
        </code>
      </Tooltip>
      <CopyButton text={command} label={label} target={chip} />
    </span>
  );
}
