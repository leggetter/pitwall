// An inline alert (docs/design-system.md, 4: Alerts and banners): a tinted box with the tone's icon,
// an optional title, the body, and actions at the right, which wrap under the text below 600 px. The
// icon takes the tint's -tint-fg and the text is --pw-text, the pairs 2.5 checks on every tint.
//
// Roles: role="alert" for a warning or danger alert that appears after an action or arrives live,
// role="status" for the rest, and neither for one that was there when the page loaded. The caller
// says which, since only it knows how the alert arrived.

import type { ReactNode, Ref } from 'react';
import { Button } from './Button.js';
import { Icon, type IconName } from './Icon.js';

export type AlertTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const ICONS: Record<AlertTone, IconName> = { neutral: 'info', info: 'info', success: 'success', warning: 'warning', danger: 'error' };

export interface AlertProps {
  tone: AlertTone;
  title?: ReactNode;
  role?: 'alert' | 'status' | undefined;
  /** Outline sm buttons, at the right. */
  actions?: ReactNode;
  /** A ghost sm "Dismiss" after the actions. */
  onDismiss?: (() => void) | undefined;
  className?: string | undefined;
  /** For focus to land on the alert itself, as the app strip's Details does. Makes it focusable from script only. */
  ref?: Ref<HTMLDivElement> | undefined;
  children: ReactNode;
}

export function Alert({ tone, title, role, actions, onDismiss, className, ref, children }: AlertProps) {
  return (
    <div ref={ref} className={['inline-alert', tone, className].filter(Boolean).join(' ')} role={role} tabIndex={ref ? -1 : undefined}>
      <Icon name={ICONS[tone]} />
      <div className="inline-alert-text">
        {title !== undefined && <p className="inline-alert-title">{title}</p>}
        <div className="inline-alert-body">{children}</div>
      </div>
      {(actions !== undefined || onDismiss) && (
        <div className="inline-alert-actions">
          {actions}
          {onDismiss && (
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Detail that comes from Claude Code or the server, in code style (4: Alerts and banners). Plain text only. */
export function Detail({ children }: { children: string }) {
  return <span className="alert-detail">{children}</span>;
}
