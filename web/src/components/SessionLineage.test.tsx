// The session view's lineage line (W167): a listed session is a link button, one pitwall doesn't
// list is words, and a session with no lineage has no line. Made-up sessions only.

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { session } from '../test/fixtures.js';
import { SessionLineage, UNLISTED_SESSION } from './SessionLineage.js';
import { SessionView } from './SessionView.js';

describe('SessionLineage', () => {
  it('renders nothing without lineage', () => {
    const { container } = render(<SessionLineage onOpen={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('links a listed session, says so in words for one it does not list, and opens by id', () => {
    const onOpen = vi.fn();
    const { container } = render(<SessionLineage from={{ sessionId: 'earlier', name: 'pitwall-test-earlier' }} to={{ sessionId: 'later' }} onOpen={onOpen} />);
    expect(container.textContent).toBe(`Continued from pitwall-test-earlierContinued in ${UNLISTED_SESSION}`);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'pitwall-test-earlier' }));
    expect(onOpen).toHaveBeenCalledWith('earlier');
  });

  it('shows a hostile name as text, never markup', () => {
    render(<SessionLineage to={{ sessionId: 'x', name: '<img src=x onerror=alert(1)>' }} onOpen={() => {}} />);
    expect(screen.getByRole('button').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
  });

  it('is in the session view only when it is given', () => {
    const s = session({ name: 'pitwall-test-view' });
    const { rerender } = render(<SessionView session={s} listed onClose={() => {}} />);
    expect(document.querySelector('[data-session-lineage]')).toBeNull();
    rerender(<SessionView session={s} listed onClose={() => {}} lineage={{ from: { sessionId: 'a', name: 'pitwall-test-a' }, onOpen: () => {} }} />);
    expect(document.querySelector('[data-session-lineage]')?.textContent).toBe('Continued from pitwall-test-a');
  });
});
