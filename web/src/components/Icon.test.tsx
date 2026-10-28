import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ICON_PATHS, type IconName } from '../icons/paths.js';
import { Icon } from './Icon.js';

/** The semantic names in docs/design-system.md, 2.14. */
const NAMES = [
  'close', 'expand', 'select', 'more', 'menu', 'search', 'clear', 'add', 'copy', 'copied', 'terminal',
  'conversation', 'send', 'stop', 'remove', 'restart', 'retry', 'info', 'success', 'warning', 'error',
  'repo', 'directory', 'external', 'latest', 'back', 'keyboard', 'hide', 'show', 'preferences', 'checked', 'star', 'starred', 'subagents', 'attach',
  'image', 'pdf', 'file', 'theme-system',
  'theme-light', 'theme-dark',
];

function svgOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('no <svg> rendered');
  return svg;
}

describe('Icon', () => {
  it('is decorative: hidden from assistive technology and never a tab stop', () => {
    const svg = svgOf(render(<Icon name="close" />).container);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
  });

  it('takes the text colour, so it follows the theme', () => {
    expect(svgOf(render(<Icon name="close" />).container).getAttribute('fill')).toBe('currentColor');
  });

  it("draws the 16 px path in Material Symbols' viewBox, 16 px by default", () => {
    const svg = svgOf(render(<Icon name="copy" className="icon" />).container);
    expect(svg.getAttribute('viewBox')).toBe('0 -960 960 960');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
    expect(svg.getAttribute('class')).toBe('icon');
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    expect(svg.querySelector('path')?.getAttribute('d')).toBe(ICON_PATHS.copy[16]);
  });

  it('draws the 24 px path at 24 px', () => {
    const svg = svgOf(render(<Icon name="send" size={24} />).container);
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.getAttribute('height')).toBe('24');
    expect(svg.querySelector('path')?.getAttribute('d')).toBe(ICON_PATHS.send[24]);
  });

  it("has every name in the design system's table, and no others", () => {
    expect(Object.keys(ICON_PATHS).sort()).toEqual([...NAMES].sort());
  });

  it.each(Object.keys(ICON_PATHS) as IconName[])('%s has a path at 16 and 24 px, from different optical sizes, and nothing else', (name) => {
    const sizes = ICON_PATHS[name];
    expect(Object.keys(sizes).sort()).toEqual(['16', '24']);
    for (const d of Object.values(sizes)) expect(d).toMatch(/^[Mm][MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+[Zz]$/);
    // The 16 px path is the 20 px design, not the 24 px one scaled.
    expect(sizes[16]).not.toBe(sizes[24]);
  });
});
