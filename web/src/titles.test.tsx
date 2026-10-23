// No browser hover text where a tooltip should be (W25, docs/design-system.md, 4: Tooltips): the web
// UI's components have no `title` attribute on an HTML element, read as text. A component prop called
// title, such as an Alert's or an empty state's, is fine: those start with a capital.
//
// There are no exceptions: the last ones, the conversation's entries, have had speaker lines with
// their times and tool calls with their own tooltips since W27. The #uikit gallery test checks the
// same thing at run time, over every component in every state.

import { describe, expect, it } from 'vitest';

const sources = Object.entries(
  import.meta.glob<string>(['./**/*.tsx', '!./**/*.test.tsx', '!./uikit/**', '!./test/**'], { query: '?raw', import: 'default', eager: true }),
);

/** The tag each `title=` attribute sits on, found by walking back to the `<` that opens its element. */
function titledTags(source: string): { tag: string; line: number }[] {
  const found: { tag: string; line: number }[] = [];
  for (const match of source.matchAll(/\stitle=[{"']/g)) {
    const at = match.index ?? 0;
    const open = source.lastIndexOf('<', at);
    const tag = /^<([A-Za-z][\w.]*)/.exec(source.slice(open))?.[1] ?? '';
    found.push({ tag, line: source.slice(0, at).split('\n').length });
  }
  return found;
}

describe('title attributes in the components', () => {
  it('are looked for in every component', () => {
    expect(sources.map(([path]) => path)).toEqual(
      expect.arrayContaining(['./components/SessionRow.tsx', './components/Header.tsx', './components/Conversation.tsx', './App.tsx']),
    );
  });

  it.each(sources)('%s has none on an HTML element, where a tooltip should be', (path, source) => {
    const onElements = titledTags(source).filter(({ tag }) => /^[a-z]/.test(tag));
    expect(onElements.map(({ tag, line }) => `${path}:${line} <${tag}>`)).toEqual([]);
  });

  it('finds one when there is one', () => {
    expect(titledTags('<span className="x" title={hint}>\n</span>').map(({ tag }) => tag)).toEqual(['span']);
    expect(titledTags('<Alert tone="danger" title="Couldn\'t list sessions">').map(({ tag }) => tag)).toEqual(['Alert']);
    expect(titledTags('<button\n  type="button"\n  title="Close"\n>').map(({ tag }) => tag)).toEqual(['button']);
  });
});
