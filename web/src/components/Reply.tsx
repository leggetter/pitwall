import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { LastMessage, SessionSummary } from '../../../src/shared/protocol.js';
import { plainText } from '../format.js';
import { ReplyLoaderContext } from '../lastMessage.js';
import { ClampedText } from './ClampedText.js';

type FullReply =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; message: LastMessage }
  | { status: 'failed' };

/**
 * A session's last reply: the snapshot's preview, clamped to two lines, and
 * the whole message once "Show more" has fetched it. Rendered as text, never
 * as markup.
 */
export function Reply({ session }: { session: SessionSummary }) {
  const loader = useContext(ReplyLoaderContext);
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState<FullReply>({ status: 'idle' });
  const { sessionId, lastActivityAt } = session;

  // Fetches on expand, and again if the session moves on while expanded.
  useEffect(() => {
    if (!expanded || !loader) return;
    const cached = loader.cached(sessionId, lastActivityAt);
    if (cached) {
      setFull({ status: 'loaded', message: cached });
      return;
    }
    // A reply already shown stays while a newer one loads, so the row doesn't jump.
    setFull((current) => (current.status === 'loaded' ? current : { status: 'loading' }));
    let wanted = true;
    void loader.load(sessionId, lastActivityAt).then((result) => {
      if (!wanted) return;
      if (result.kind === 'ok') setFull({ status: 'loaded', message: result.message });
      else if (result.kind === 'failed') setFull({ status: 'failed' });
      // On 'unauthorized' the app has already replaced the dashboard with the token notice.
    });
    return () => {
      wanted = false;
    };
  }, [expanded, loader, sessionId, lastActivityAt]);

  let note: ReactNode = null;
  if (full.status === 'loading') {
    note = (
      <p className="reply-note" role="status">
        Loading the full reply…
      </p>
    );
  } else if (full.status === 'failed') {
    note = <p className="reply-note">Couldn't load the full reply, so this is the preview.</p>;
  } else if (full.status === 'loaded' && full.message.truncated) {
    note = <p className="reply-note">This reply is longer than 64 KiB, so this is its first 64 KiB.</p>;
  }

  return (
    <ClampedText
      className="reply"
      text={plainText(session.lastAssistantText ?? '')}
      expandedText={full.status === 'loaded' ? plainText(full.message.text) : undefined}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      note={note}
      busy={full.status === 'loading'}
    />
  );
}
