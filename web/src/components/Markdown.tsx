// Markdown in messages (docs/design-system.md, 4: Markdown in messages): the tree markdown.ts parses,
// as pitwall's own elements. Text is always a React text node, never HTML (6.1, rule 16), and nothing
// is loaded: an image is its alt text, and a link is only ever an absolute http: or https: URL.
//
// - Headings are styled text, not h1 to h6: the page's outline is pitwall's own (6.1, rule 6), and a
//   message's headings would sit in it among the session list's rows, as many and as deep as the
//   session wrote them.
// - A code block scrolls sideways in its own box, with its language and a Copy button above it; a
//   table scrolls sideways in its own box too. Each box is a Tab stop while it scrolls (ScrollBox).
// - A link opens in a new tab with noopener and noreferrer, and its tooltip, on hover and on focus,
//   is the URL it opens, as the browser parsed it, since its text can say anything (links.ts).
// - A link whose text isn't its own address asks first (W55, W48's F6): a click, Enter or a middle
//   click opens an inline confirmation instead, which names the host it goes to and shows its full
//   address, with Cancel and Open link. It shows straight after the paragraph, heading, table or code
//   block the link is in, since a line of text can't hold it. A bare URL and an autolink open on one
//   click, unless a label of their host is punycode, which asks whatever the link's text (asksFirst,
//   markdown.ts; W58). The link itself is unchanged: its name, its tooltip and its href.
// - A bare URL in code is the same link, in the code's mono face and size (W37). The code's text is
//   unchanged: Copy copies it as written, and a link's tooltip is rendered into document.body, so
//   text selected in the code and copied by hand holds none of it.
//
// - A message whose markdown would take more than MAX_ELEMENTS elements is shown as the text it was
//   written in, with a note saying so, so no message, however hostile, takes long to draw.
//
// - In the supervisor's view, a session or a PR it names is a link button that opens it (W125,
//   mentions.ts), from MentionsContext: only in text, never in code, a code block or a link's text.
//   Elsewhere there's no context, and text is only text.
//
// It's memoised on its text, so a conversation that re-renders as entries arrive doesn't parse or
// render a message again.

import { createContext, memo, useCallback, useContext, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { mentionLabel, type Mentions, type MentionTarget } from '../mentions.js';
import { asksFirst, elementCount, httpUrl, MAX_ELEMENTS, parseMarkdown, type Align, type Block, type Inline } from '../markdown.js';
import { CopyButton } from './CopyButton.js';
import { InlineConfirm } from './InlineConfirm.js';
import { ScrollBox } from './ScrollBox.js';
import { focusQuietly, Tooltip } from './Tooltip.js';

/** What a message too big to format says, after its text. */
export const AS_WRITTEN = 'Shown as written: too much formatting to show.';

/** The question a link asks before it opens (W55): the host it goes to, as the browser parsed it, so an internationalised one is in punycode. */
export const linkQuestion = (url: URL) => `Open this link to ${url.host}?`;
/** The question's consequence, before the full address in code style. */
export const LINK_CONSEQUENCE = "Its text doesn't show where it goes: ";
/** The question's confirm button, which repeats its verb and object (5: Labels). */
export const OPEN_LINK = 'Open link';

/**
 * The supervisor's view's mentions (W125): what its replies can name, and what opening one does. None
 * elsewhere, so no other conversation links a name.
 */
export interface MentionsValue {
  mentions: Mentions;
  open: (target: MentionTarget) => void;
}
export const MentionsContext = createContext<MentionsValue | undefined>(undefined);

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const mentions = useContext(MentionsContext);
  const blocks = useMemo(() => {
    const parsed = parseMarkdown(text);
    return elementCount(parsed, MAX_ELEMENTS) > MAX_ELEMENTS ? undefined : parsed;
  }, [text]);
  if (!blocks) {
    return (
      <>
        <p className="md-as-written">{text}</p>
        <p className="md-as-written-note">{AS_WRITTEN}</p>
      </>
    );
  }
  // The message is a host too, for any link outside a paragraph, heading, table or code block, though
  // links are only ever in those, so none should reach it.
  return <Asking>{blocks.map((block, index) => renderBlock(block, index, mentions))}</Asking>;
});

/** What text may link (W125): the view's mentions, or none, as in code and links' text. */
type Linking = MentionsValue | undefined;

function renderBlocks(blocks: Block[], m: Linking): ReactNode[] {
  return blocks.map((block, index) => renderBlock(block, index, m));
}

function renderBlock(block: Block, key: number, m: Linking): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return (
        <Asking key={key}>
          <p className="md-p">{renderInlines(block.children, m)}</p>
        </Asking>
      );
    case 'heading':
      return (
        <Asking key={key}>
          <p className={`md-heading md-h${block.level}`}>{renderInlines(block.children, m)}</p>
        </Asking>
      );
    case 'code':
      // Its bare URLs ask when their host is punycode (W58), so the question shows after the box.
      return (
        <Asking key={key}>
          <CodeBlock language={block.language} text={block.text} linked={block.linked} />
        </Asking>
      );
    case 'list': {
      const items = block.items.map((item, index) => <li key={index}>{renderBlocks(item, m)}</li>);
      return block.ordered ? (
        <ol key={key} className="md-list" start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key} className="md-list">
          {items}
        </ul>
      );
    }
    case 'quote':
      return (
        <blockquote key={key} className="md-quote">
          {renderBlocks(block.children, m)}
        </blockquote>
      );
    case 'rule':
      return <hr key={key} className="md-rule" />;
    case 'table':
      return (
        <Asking key={key}>
          <Table align={block.align} head={block.head} rows={block.rows} m={m} />
        </Asking>
      );
  }
}

/**
 * Inlines as elements. With mentions, a run of text, as the parser may split it, is searched as one,
 * and `whole` says it's all of a bold or italic span's (mentions.ts: a generic name links only there).
 */
function renderInlines(inlines: Inline[], m: Linking = undefined, whole = false): ReactNode[] {
  if (m === undefined) return inlines.map((inline, index) => renderInline(inline, index, undefined));
  const nodes: ReactNode[] = [];
  let run = '';
  const flush = () => {
    if (run === '') return;
    const alone = whole && nodes.length === 0;
    for (const part of m.mentions.split(run, alone && inlines.every((inline) => inline.type === 'text'))) {
      nodes.push(part.kind === 'text' ? part.text : <Mention key={`m${nodes.length}`} text={part.text} target={part.target} open={m.open} />);
    }
    run = '';
  };
  inlines.forEach((inline, index) => {
    if (inline.type === 'text') {
      run += inline.text;
      return;
    }
    flush();
    nodes.push(renderInline(inline, index, m));
  });
  flush();
  return nodes;
}

function renderInline(inline: Inline, key: number, m: Linking): ReactNode {
  switch (inline.type) {
    case 'text':
      return inline.text;
    case 'break':
      return <br key={key} />;
    case 'strong':
      return <strong key={key}>{renderInlines(inline.children, m, true)}</strong>;
    case 'em':
      return <em key={key}>{renderInlines(inline.children, m, true)}</em>;
    case 'del':
      return <del key={key}>{renderInlines(inline.children, m)}</del>;
    case 'code':
      // Never a mention: code is as written.
      return (
        <code key={key} className="md-code-span">
          {inline.linked ? renderInlines(inline.linked) : inline.text}
        </code>
      );
    case 'link':
      // Never a mention in a link's text: links don't nest.
      return (
        <Link key={key} href={inline.href} asks={asksFirst(inline)}>
          {renderInlines(inline.children)}
        </Link>
      );
  }
}

/**
 * A session or PR the supervisor named (W125): a link button, in the text's own face, that opens
 * pitwall's view of it, as its row does. Its name says what it opens, by the name pitwall knows; its
 * text is the reply's. Nothing navigates: no href, no new tab.
 */
function Mention({ text, target, open }: { text: string; target: MentionTarget; open: (target: MentionTarget) => void }) {
  return (
    <button
      type="button"
      className="link-button md-mention"
      aria-label={mentionLabel(target, text)}
      data-mention={target.kind}
      data-mention-session={target.kind === 'session' ? target.sessionId : undefined}
      data-mention-pr={target.kind === 'pr' ? target.key : undefined}
      onClick={() => open(target)}
    >
      {text}
    </button>
  );
}

/** Opens a link's question in the block it's in, with the link to put focus back on. */
type Ask = (url: URL, link: HTMLAnchorElement) => void;
const AskContext = createContext<Ask | undefined>(undefined);

/** Each question's own, so a second link's question in the same block opens afresh, Cancel focused. */
let questions = 0;

/**
 * A block a link that asks can ask from: a paragraph, a heading, a table, a code block, or the message
 * for anything else. Its question, when one is open, shows straight after the block, at the message's
 * width.
 */
function Asking({ children }: { children: ReactNode }) {
  const [question, setQuestion] = useState<{ id: number; url: URL; link: HTMLAnchorElement }>();
  const ask = useCallback<Ask>((url, link) => setQuestion({ id: (questions += 1), url, link }), []);
  // Back on the link before the question goes, so focus never falls to the page.
  const close = (link: HTMLAnchorElement) => {
    focusQuietly(link);
    setQuestion(undefined);
  };
  return (
    <AskContext.Provider value={ask}>
      {children}
      {question && (
        <LinkQuestion
          key={question.id}
          url={question.url}
          onOpen={() => {
            // As the link itself would: a new tab, with no opener or referrer.
            window.open(question.url.href, '_blank', 'noopener,noreferrer');
            close(question.link);
          }}
          onCancel={() => close(question.link)}
        />
      )}
    </AskContext.Provider>
  );
}

/**
 * The question: the host the link goes to and its full address, as the browser parsed them, so an
 * internationalised host is in punycode, as its tooltip shows it. An alertdialog, as the restart's is,
 * since it interrupts opening the link; Cancel takes focus, so a screen reader reads the question and
 * the address as it opens.
 */
function LinkQuestion({ url, onOpen, onCancel }: { url: URL; onOpen: () => void; onCancel: () => void }) {
  return (
    <InlineConfirm
      question={linkQuestion(url)}
      consequence={
        <>
          {LINK_CONSEQUENCE}
          <code className="link-confirm-address">{url.href}</code>
        </>
      }
      confirmLabel={OPEN_LINK}
      busyLabel="Opening…"
      icon="external"
      variant="primary"
      tone="warning"
      role="alertdialog"
      onConfirm={onOpen}
      onCancel={onCancel}
    />
  );
}

/**
 * A link: a new tab, with no opener or referrer, and the URL it opens in its tooltip. One that `asks`
 * opens its question instead, on a click, Enter or a middle click; a modifier doesn't skip it.
 */
function Link({ href, asks, children }: { href: string; asks: boolean; children: ReactNode }) {
  const ask = useContext(AskContext);
  const question = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const url = httpUrl(href);
    if (url) ask?.(url, event.currentTarget);
  };
  return (
    <Tooltip content={href}>
      <a
        className="md-link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={asks ? question : undefined}
        onAuxClick={
          asks
            ? (event) => {
                if (event.button === 1) question(event);
              }
            : undefined
        }
      >
        {children}
      </a>
    </Tooltip>
  );
}

/**
 * A fenced code block: its language and a Copy button above the code, which scrolls sideways on its
 * own. Its bare URLs are links (`linked`), but Copy always copies `text`, the code as written.
 */
function CodeBlock({ language, text, linked }: { language: string; text: string; linked: Inline[] | undefined }) {
  const code = useRef<HTMLElement>(null);
  return (
    <div className="md-code">
      <div className="md-code-bar">
        {language !== '' && <span className="md-code-language">{language}</span>}
        <CopyButton text={text} label="Copy code" target={code} />
      </div>
      <ScrollBox as="pre" axis="x" label={language === '' ? 'Code' : `Code, ${language}`} className="md-code-scroll">
        <code ref={code}>{linked ? renderInlines(linked) : text}</code>
      </ScrollBox>
    </div>
  );
}

const ALIGN: Record<Exclude<Align, undefined>, string> = { left: 'md-align-left', center: 'md-align-center', right: 'md-align-right' };

/** A GFM table, with header cells as th and the columns' alignment, scrolling sideways on its own. */
function Table({ align, head, rows, m }: { align: Align[]; head: Inline[][]; rows: Inline[][][]; m: Linking }) {
  const cellClass = (column: number) => {
    const side = align[column];
    return side === undefined ? undefined : ALIGN[side];
  };
  return (
    <ScrollBox axis="x" label="Table" className="md-table-scroll">
      <table className="md-table">
        <thead>
          <tr>
            {head.map((cell, column) => (
              <th key={column} scope="col" className={cellClass(column)}>
                {renderInlines(cell, m)}
              </th>
            ))}
          </tr>
        </thead>
        {rows.length > 0 && (
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {row.map((cell, column) => (
                  <td key={column} className={cellClass(column)}>
                    {renderInlines(cell, m)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </ScrollBox>
  );
}
