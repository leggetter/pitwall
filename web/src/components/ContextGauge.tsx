// A session's context gauge (docs/design-system.md, 4: Context gauge, W133): how many tokens of
// context its newest call carried, from SessionSummary.contextTokens.
//
// - In a row, a subtle badge, "412K", only over 200K: warning, then danger over 400K. Below that, and
//   when it can't be read, nothing, so the list stays calm. Screen readers hear "Context 412K, over 400K".
// - In the session view's line 2, always: "Context 85K" as meta text, or the badge, "Context 412K",
//   over 200K, or "Context unavailable", each with an info button; and, over 200K, a note under line 2
//   on what to do (ContextNote).
//
// Colour is never the only signal: the number says how big, and the level is in the badge's hidden
// text, its tooltip and the note.

import { CONTEXT_HIGH_TOKENS, CONTEXT_WARN_TOKENS } from '../../../src/shared/protocol.js';
import { CONTEXT_INFO, CONTEXT_LOOKS, CONTEXT_UNAVAILABLE_INFO, contextHint, contextLevel, formatTokens, levelText } from '../context.js';
import { Badge } from './Badge.js';
import { InfoTip } from './InfoTip.js';

/** The row's badge: nothing at or below 200K, or when the size isn't known. */
export function ContextBadge({ tokens }: { tokens: number | undefined }) {
  if (tokens === undefined) return null;
  const level = contextLevel(tokens);
  if (level === 'ok') return null;
  return (
    <Badge look={CONTEXT_LOOKS[level]} hint={contextHint(tokens)} className="context-badge">
      <span className="visually-hidden">Context </span>
      {formatTokens(tokens)}
      <span className="visually-hidden">{levelText(level)}</span>
    </Badge>
  );
}

/** The session view's line 2 item: the number, the badge over 200K, or "unavailable", with its info button. */
export function ContextMeta({ tokens }: { tokens: number | undefined }) {
  if (tokens === undefined) {
    return (
      <span className="session-view-context">
        Context unavailable
        <InfoTip text={CONTEXT_UNAVAILABLE_INFO} className="session-view-info" />
      </span>
    );
  }
  const level = contextLevel(tokens);
  return (
    <span className="session-view-context">
      {level === 'ok' ? (
        <span className="session-view-context-value">Context {formatTokens(tokens)}</span>
      ) : (
        <Badge look={CONTEXT_LOOKS[level]} className="context-badge">
          Context {formatTokens(tokens)}
          <span className="visually-hidden">{levelText(level)}</span>
        </Badge>
      )}
      <InfoTip text={CONTEXT_INFO} className="session-view-info" />
    </span>
  );
}

/** Under the session view's line 2, over 200K: what to do about it. Nothing below. Read once, in place. */
export function ContextNote({ tokens }: { tokens: number | undefined }) {
  if (tokens === undefined) return null;
  const level = contextLevel(tokens);
  if (level === 'ok') return null;
  const over = formatTokens(level === 'high' ? CONTEXT_HIGH_TOKENS : CONTEXT_WARN_TOKENS);
  return (
    <p className="session-view-context-note" data-level={level}>
      Its last call carried {formatTokens(tokens)} tokens of context, over {over}, and every call sends all of it again.{' '}
      {level === 'high' ? 'Hand it off to a new session now' : 'Hand it off to a new session'}, with the <code>handoff</code> skill where its
      repo has one, or run <code>/compact</code> in it.
    </p>
  );
}
