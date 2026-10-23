// Text is text (W36, docs/design-system.md, 6.1 rule 16): nothing in the web UI turns a string into
// HTML. Markdown in messages is pitwall's own elements, each piece of its text a text node, so nothing
// needs to, and this fails on any way of doing it: React's dangerouslySetInnerHTML, innerHTML and
// outerHTML, insertAdjacentHTML, document.write, a Range's createContextualFragment, DOMParser, the
// HTML sanitizer's setHTML, Document.parseHTMLUnsafe and an iframe's srcdoc.

import { describe, expect, it } from 'vitest';

const sources = Object.entries(
  import.meta.glob<string>(['./**/*.ts', './**/*.tsx', '!./**/*.test.tsx', '!./test/**'], { query: '?raw', import: 'default', eager: true }),
);

const MAKES_HTML = /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\s*=|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser|\.setHTML(?:Unsafe)?\b|parseHTMLUnsafe|srcdoc/g;

/** Each way of making HTML in `source`, with its line. */
function htmlMakers(source: string): string[] {
  return [...source.matchAll(MAKES_HTML)].map((match) => `${match[0]} on line ${source.slice(0, match.index).split('\n').length}`);
}

describe('making HTML from a string', () => {
  it('is looked for in the conversation and everything else in the web UI', () => {
    expect(sources.map(([path]) => path)).toEqual(
      expect.arrayContaining(['./components/Conversation.tsx', './components/Markdown.tsx', './markdown.ts', './conversation.ts', './format.ts', './App.tsx']),
    );
  });

  it.each(sources)('%s never does it', (_path, source) => {
    expect(htmlMakers(source)).toEqual([]);
  });

  it('finds each way when there is one', () => {
    const made = [
      '<div dangerouslySetInnerHTML={{ __html: text }} />',
      'node.innerHTML = text;',
      'node.outerHTML = text;',
      "node.insertAdjacentHTML('beforeend', text);",
      'document.write(text);',
      'document.createRange().createContextualFragment(text);',
      "new DOMParser().parseFromString(text, 'text/html');",
      'node.setHTML(text);',
      'Document.parseHTMLUnsafe(text);',
      '<iframe srcdoc={text} />',
    ];
    for (const line of made) expect(htmlMakers(line), line).toHaveLength(1);
    // Reading what's there isn't making HTML.
    expect(htmlMakers('const text = node.textContent;')).toEqual([]);
  });
});
