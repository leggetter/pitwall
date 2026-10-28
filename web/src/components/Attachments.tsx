// The files for New session's first prompt (docs/design-system.md, 4: Dialogs, Attachments; W82):
// the list under the prompt, one row per file, and the drop target over the prompt while files are
// dragged over the page. useAttachments (attachments.ts) holds the files and their uploads.
//
// - A row: the file's type icon, or a thumbnail for an image; its name, as text, cut in the middle
//   with its extension kept (fileNameParts); its size, then "Uploading…" or "Waiting…" while it's
//   on its way; why it isn't attached, for a failed or refused file; Try again for a failed one; and
//   Remove, which works during an upload too, aborting it.
// - The list is named "Attached files", and focusable from script alone, so a submit with an upload
//   still out can put focus on it, described by the field's problem.
// - While the dialog's action runs, Try again and Remove are aria-disabled.

import { useId, type Ref } from 'react';
import { ATTACHMENT_MAX_BYTES } from '../../../src/shared/protocol.js';
import { ATTACH_TEXT, formatSize, problemLead, type AttachmentItem } from '../attachments.js';
import { fileNameParts } from '../format.js';
import { Detail } from './Alert.js';
import { Button } from './Button.js';
import { Icon, type IconName } from './Icon.js';
import { MiddleEllipsis } from './MiddleEllipsis.js';
import { Spinner } from './Spinner.js';
import { Tooltip } from './Tooltip.js';
import './Attachments.css';

const ICONS: Record<AttachmentItem['kind'], IconName> = { image: 'image', pdf: 'pdf', text: 'file' };

export interface AttachmentListProps {
  items: readonly AttachmentItem[];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
  /** The dialog's action is running: Try again and Remove do nothing. */
  busy?: boolean;
  /** The field's problem, when it has one, which describes the list. */
  describedBy?: string | undefined;
  ref?: Ref<HTMLUListElement> | undefined;
}

export function AttachmentList({ items, onRemove, onRetry, busy = false, describedBy, ref }: AttachmentListProps) {
  return (
    <ul ref={ref} className="attachment-list" aria-label={ATTACH_TEXT.listLabel} tabIndex={-1} aria-describedby={describedBy}>
      {items.map((item) => (
        <AttachmentRow key={item.key} item={item} onRemove={onRemove} onRetry={onRetry} busy={busy} />
      ))}
    </ul>
  );
}

function AttachmentRow({ item, onRemove, onRetry, busy }: { item: AttachmentItem; onRemove: (key: string) => void; onRetry: (key: string) => void; busy: boolean }) {
  const id = useId();
  const status = item.state === 'uploading' ? ATTACH_TEXT.uploading : item.state === 'waiting' ? ATTACH_TEXT.waiting : undefined;
  const ids = { meta: `${id}-meta`, problem: `${id}-problem` };
  const describedBy = [ids.meta, item.problem && ids.problem].filter(Boolean).join(' ');
  return (
    <li className="attachment" data-state={item.state}>
      <span className="attachment-tile" aria-hidden="true">
        {item.thumbnail !== undefined ? <img className="attachment-thumbnail" src={item.thumbnail} alt="" width={32} height={32} /> : <Icon name={ICONS[item.kind]} />}
      </span>
      <span className="attachment-text">
        <MiddleEllipsis className="attachment-name" text={item.name} parts={fileNameParts} />
        <span className="attachment-meta" id={ids.meta}>
          {/* Rounded up past the limit, as its problem says it, so a byte over never reads as the limit. */}
          {formatSize(item.size, { up: item.size > ATTACHMENT_MAX_BYTES })}
          {status !== undefined && (
            <>
              <span aria-hidden="true"> · </span>
              {item.state === 'uploading' && <Spinner />}
              {status}
            </>
          )}
        </span>
        {item.problem && (
          <span className="attachment-problem" id={ids.problem}>
            {problemLead(item.problem, 'it')}
            {item.problem.reason !== undefined && ` ${item.problem.reason}`}
            {item.problem.detail !== undefined && (
              <>
                {' '}
                <Detail>{item.problem.detail}</Detail>
              </>
            )}
          </span>
        )}
      </span>
      <span className="attachment-actions">
        {item.state === 'failed' && (
          <Button size="sm" icon="retry" disabled={busy} aria-describedby={describedBy} onClick={() => onRetry(item.key)}>
            Try again
          </Button>
        )}
        <Tooltip content={`Remove ${item.name}`} relation="label">
          <button
            type="button"
            className="icon-button ghost sm attachment-remove"
            aria-disabled={busy || undefined}
            aria-describedby={describedBy}
            onClick={() => {
              if (!busy) onRemove(item.key);
            }}
          >
            <Icon name="close" />
          </button>
        </Tooltip>
      </span>
    </li>
  );
}

/** Over the prompt while files are dragged over the page: where to drop them. Pointer only, so it's hidden from assistive technology; Attach files is the way in for everyone. */
export function DropTarget({ over }: { over: boolean }) {
  return (
    <div className={over ? 'prompt-drop-target over' : 'prompt-drop-target'} aria-hidden="true">
      <Icon name="attach" />
      {ATTACH_TEXT.dropTarget}
    </div>
  );
}
