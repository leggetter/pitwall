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
//
// - A message whose markdown would take more than MAX_ELEMENTS elements is shown as the text it was
//   written in, with a note saying so, so no message, however hostile, takes long to draw.
//
// It's memoised on its text, so a conversation that re-renders as entries arrive doesn't parse or
// render a message again.

import { memo, useMemo, useRef, type ReactNode } from 'react';
import { elementCount, MAX_ELEMENTS, parseMarkdown, type Align, type Block, type Inline } from '../markdown.js';
import { CopyButton } from './CopyButton.js';
import { ScrollBox } from './ScrollBox.js';
import { Tooltip } from './Tooltip.js';

/** What a message too big to format says, after its text. */
export const AS_WRITTEN = 'Shown as written: too much formatting to show.';

export const Markdown = memo(function Markdown({ text }: { text: string }) {
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
  return <>{blocks.map((block, index) => renderBlock(block, index))}</>;
});

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((block, index) => renderBlock(block, index));
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return (
        <p key={key} className="md-p">
          {renderInlines(block.children)}
        </p>
      );
    case 'heading':
      return (
        <p key={key} className={`md-heading md-h${block.level}`}>
          {renderInlines(block.children)}
        </p>
      );
    case 'code':
      return <CodeBlock key={key} language={block.language} text={block.text} />;
    case 'list': {
      const items = block.items.map((item, index) => <li key={index}>{renderBlocks(item)}</li>);
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
          {renderBlocks(block.children)}
        </blockquote>
      );
    case 'rule':
      return <hr key={key} className="md-rule" />;
    case 'table':
      return <Table key={key} align={block.align} head={block.head} rows={block.rows} />;
  }
}

function renderInlines(inlines: Inline[]): ReactNode[] {
  return inlines.map((inline, index) => renderInline(inline, index));
}

function renderInline(inline: Inline, key: number): ReactNode {
  switch (inline.type) {
    case 'text':
      return inline.text;
    case 'break':
      return <br key={key} />;
    case 'strong':
      return <strong key={key}>{renderInlines(inline.children)}</strong>;
    case 'em':
      return <em key={key}>{renderInlines(inline.children)}</em>;
    case 'del':
      return <del key={key}>{renderInlines(inline.children)}</del>;
    case 'code':
      return (
        <code key={key} className="md-code-span">
          {inline.text}
        </code>
      );
    case 'link':
      return (
        <Link key={key} href={inline.href}>
          {renderInlines(inline.children)}
        </Link>
      );
  }
}

/** A link: a new tab, with no opener or referrer, and the URL it opens in its tooltip. */
function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Tooltip content={href}>
      <a className="md-link" href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    </Tooltip>
  );
}

/** A fenced code block: its language and a Copy button above the code, which scrolls sideways on its own. */
function CodeBlock({ language, text }: { language: string; text: string }) {
  const code = useRef<HTMLElement>(null);
  return (
    <div className="md-code">
      <div className="md-code-bar">
        {language !== '' && <span className="md-code-language">{language}</span>}
        <CopyButton text={text} label="Copy code" target={code} />
      </div>
      <ScrollBox as="pre" axis="x" label={language === '' ? 'Code' : `Code, ${language}`} className="md-code-scroll">
        <code ref={code}>{text}</code>
      </ScrollBox>
    </div>
  );
}

const ALIGN: Record<Exclude<Align, undefined>, string> = { left: 'md-align-left', center: 'md-align-center', right: 'md-align-right' };

/** A GFM table, with header cells as th and the columns' alignment, scrolling sideways on its own. */
function Table({ align, head, rows }: { align: Align[]; head: Inline[][]; rows: Inline[][][] }) {
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
                {renderInlines(cell)}
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
                    {renderInlines(cell)}
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
