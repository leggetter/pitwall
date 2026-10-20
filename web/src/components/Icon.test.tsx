import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ICON_PATHS, type IconName } from '../icons/paths.js';
import { Icon } from './Icon.js';

/** The semantic names in docs/design-system.md, 2.14. */
const NAMES = [
  'close', 'expand', 'select', 'more', 'search', 'clear', 'add', 'copy', 'copied', 'terminal',
  'conversation', 'send', 'stop', 'remove', 'restart', 'retry', 'info', 'success', 'warning', 'error',
  'repo', 'directory', 'external', 'latest', 'back', 'keyboard', 'theme-system', 'theme-light', 'theme-dark',
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

  it("draws the name's path in Material Symbols' viewBox, 16 px by default", () => {
    const svg = svgOf(render(<Icon name="copy" className="icon" />).container);
    expect(svg.getAttribute('viewBox')).toBe('0 -960 960 960');
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('height')).toBe('16');
    expect(svg.getAttribute('class')).toBe('icon');
    expect(svg.querySelectorAll('path')).toHaveLength(1);
    expect(svg.querySelector('path')?.getAttribute('d')).toBe(ICON_PATHS.copy);
  });

  it('comes at 24 px too', () => {
    const svg = svgOf(render(<Icon name="send" size={24} />).container);
    expect(svg.getAttribute('width')).toBe('24');
    expect(svg.getAttribute('height')).toBe('24');
  });

  it("has every name in the design system's table, and no others", () => {
    expect(Object.keys(ICON_PATHS).sort()).toEqual([...NAMES].sort());
  });

  it.each(Object.keys(ICON_PATHS) as IconName[])('%s has path data and nothing else', (name) => {
    expect(ICON_PATHS[name]).toMatch(/^[Mm][MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+[Zz]$/);
  });
});
