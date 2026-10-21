// ScrollBox (W31): a Tab stop, named, only while its content overflows, so the keyboard can scroll it
// in Safari and Firefox. happy-dom has no layout, so the sizes are set as a laid-out page would have them.

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScrollBox } from './ScrollBox.js';

/** Gives every element `sizes` for scrollHeight and clientHeight. */
function layout(sizes: { scrollHeight: number; clientHeight: number }) {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => sizes.scrollHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => sizes.clientHeight);
  return sizes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ScrollBox', () => {
  it('is a plain element while everything fits: no Tab stop, no role, no name', () => {
    layout({ scrollHeight: 100, clientHeight: 100 });
    render(<ScrollBox className="made-up" label="Alerts">A made-up alert.</ScrollBox>);
    const box = screen.getByText('A made-up alert.');
    expect(box.tagName).toBe('DIV');
    expect(box.hasAttribute('tabindex')).toBe(false);
    expect(box.hasAttribute('role')).toBe(false);
    expect(box.hasAttribute('aria-label')).toBe(false);
    expect(box.className).toBe('made-up scroll-box');
  });

  it('is a named region and a Tab stop while it overflows, and stops being one when it fits again', async () => {
    const sizes = layout({ scrollHeight: 400, clientHeight: 100 });
    render(
      <ScrollBox as="p" label="Reply">
        A made-up reply.
      </ScrollBox>,
    );
    const box = screen.getByRole('region', { name: 'Reply' });
    expect(box.tagName).toBe('P');
    expect(box.tabIndex).toBe(0);

    sizes.scrollHeight = 100;
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.getByText('A made-up reply.').hasAttribute('tabindex')).toBe(false);
  });
});
