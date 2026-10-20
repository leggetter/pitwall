// An explanation behind an `info` icon (docs/design-system.md, 5: Explanations), such as what `/bg`
// does or what a relayed message can't do. A ghost sm icon button, so Tab reaches it: its name is the
// explanation, which is also its tooltip, shown on hover and focus, and pinned by a click or a tap,
// since touch screens can't hover. Escape, blur or a press elsewhere hides it.

import { Icon } from './Icon.js';
import { Tooltip } from './Tooltip.js';

export interface InfoTipProps {
  /** At most two sentences, as plain text. */
  text: string;
  className?: string | undefined;
}

export function InfoTip({ text, className }: InfoTipProps) {
  return (
    <Tooltip content={text} relation="label" toggle>
      <button type="button" className={className ? `icon-button ghost sm info-tip ${className}` : 'icon-button ghost sm info-tip'}>
        <Icon name="info" />
      </button>
    </Tooltip>
  );
}
