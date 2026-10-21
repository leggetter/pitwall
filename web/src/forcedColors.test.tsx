// Forced colours (W31, docs/design-system.md, 6.1 rule 17): the browser drops every box-shadow and
// forces every colour that isn't a system colour, so what a shadow or a fill said is drawn again in
// @media (forced-colors: active), in system colours. Headless Chrome checks how it looks; this checks
// the rules are there and use only system colours.
import { describe, expect, it } from 'vitest';
import stylesCss from './styles.css?raw';
import { block, withoutComments } from './test/css.js';

const forced = block(withoutComments(stylesCss), /@media\s*\(forced-colors:\s*active\)\s*\{/);

describe('the forced-colours rules', () => {
  it.each([
    ['the open row', '.session.open'],
    ['a pressed chip', ".chip[aria-pressed='true']"],
    ['a chip', '.chip {'],
    ['the selected repo', '.repo-item.selected'],
    ["the theme switch's selected option", ".theme-switch-option[aria-pressed='true']"],
    ["the open tab's underline", ".session-tab[aria-selected='true']::after"],
    ["the divider's line", '.session-divider::before'],
    ['the session view over the list', '.session-view.overlay'],
    ['the dialog', '.dialog'],
    ['a menu', '.menu'],
    ['a toast', '.toast'],
    ['a tooltip', '.tooltip'],
    ['the drawer', '.repo-drawer'],
    ['fields', '.field-input'],
    ['the filter field', '.filter-input'],
    ['buttons with an edge', '.button:not(.ghost)'],
    ['inline alerts', '.inline-alert'],
  ])('draw %s again', (_what, selector) => {
    expect(forced).toContain(selector);
  });

  it('use only system colours, since the browser forces every other one', () => {
    const colours = [...forced.matchAll(/(?:border(?:-left)?|outline|background):\s*([^;]+);/g)].map((match) => match[1] ?? '');
    expect(colours.length).toBeGreaterThan(10);
    const systemColour = /\b(?:Highlight|CanvasText|ButtonText)\b/;
    expect(colours.filter((value) => !systemColour.test(value))).toEqual([]);
    expect(forced).not.toMatch(/var\(--pw-(?!space|control)/);
  });
});
