import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import actionsCss from '../actions.css?raw';
import relayCss from '../relay.css?raw';
import stylesCss from '../styles.css?raw';
import { withoutComments } from '../test/css.js';
import { Button } from './Button.js';

/**
 * Presses a button from the keyboard as a browser does: Enter or Space on a focused <button> fires
 * its click. happy-dom doesn't, so the key and the click it would bring are fired together.
 */
function pressKey(button: HTMLElement, key: 'Enter' | ' ') {
  button.focus();
  const go = fireEvent.keyDown(button, { key });
  if (go) fireEvent.click(button);
}

describe('Button', () => {
  it('is an outline md button by default, of type button, with its icon before the label', () => {
    render(
      <Button icon="send" onClick={() => {}}>
        Send
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Send' });
    expect(button.className).toBe('button md');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.firstElementChild?.tagName.toLowerCase()).toBe('svg');
  });

  it('when disabled, is aria-disabled, stays focusable, and ignores clicks and the keys that click it', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Send
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    pressKey(button, 'Enter');
    pressKey(button, ' ');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('when disabled, doesn’t submit its form', () => {
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent as SubmitEvent)}>
        <Button type="submit" disabled>
          Start session
        </Button>
      </form>,
    );
    const button = screen.getByRole('button', { name: 'Start session' });
    expect(fireEvent.click(button)).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits its form when it isn’t disabled', () => {
    const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
    render(
      <form onSubmit={(event) => onSubmit(event.nativeEvent as SubmitEvent)}>
        <Button type="submit">Start session</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start session' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('when busy: a spinner in the icon’s place, the -ing label, aria-busy, and activation ignored', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button variant="danger" icon="stop" busyLabel="Stopping…" onClick={onClick}>
        Stop session
      </Button>,
    );
    rerender(
      <Button variant="danger" icon="stop" busy busyLabel="Stopping…" onClick={onClick}>
        Stop session
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Stopping…' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    expect(button.querySelector('svg')).toBeNull();
    const spinner = button.querySelector('.spinner.in-button');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(button);
    pressKey(button, 'Enter');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps its idle width while busy', () => {
    vi.spyOn(HTMLButtonElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 96, 28));
    const { rerender } = render(<Button busyLabel="Sending…">Send</Button>);
    rerender(
      <Button busy busyLabel="Sending…">
        Send
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Sending…' }).style.minWidth).toBe('96px');
  });

  it('passes its ref on, and the other attributes', () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(
      <Button ref={ref} variant="ghost" size="sm" aria-label="Clear" title="Clear">
        ×
      </Button>,
    );
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Clear' }));
    expect(ref.current?.className).toBe('button ghost sm');
    expect(ref.current?.title).toBe('Clear');
  });
});

describe('the stylesheets', () => {
  const sheets = { 'styles.css': withoutComments(stylesCss), 'actions.css': withoutComments(actionsCss), 'relay.css': withoutComments(relayCss) };

  it.each(Object.entries(sheets))('%s styles no button by :disabled or opacity: disabled is aria-disabled', (_name, css) => {
    expect(css).not.toMatch(/button[^{]*:disabled/);
    expect(css).not.toMatch(/opacity:\s*0\.6/);
  });

  it('gives disabled buttons --pw-text-disabled on --pw-surface-sunken, with the control edge', () => {
    const rule = /\.button\[aria-disabled='true'\]:not\(\[aria-busy='true'\]\),[^{]*\{([^}]*)\}/.exec(sheets['styles.css'])?.[1] ?? '';
    expect(rule).toContain('background: var(--pw-surface-sunken)');
    expect(rule).toContain('color: var(--pw-text-disabled)');
    expect(rule).toContain('box-shadow: var(--pw-shadow-control)');
    expect(rule).toContain('cursor: not-allowed');
  });
});

describe('placeholders', () => {
  /** The declarations of the rule for `selector`, exactly. */
  const rule = (css: string, selector: string) =>
    new RegExp(`(?:^|\\})\\s*${selector.replace(/[.:[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(withoutComments(css))?.[1] ?? '';

  it('are --pw-text-subtle in the New session dialog’s fields and textarea, at full opacity', () => {
    const body = rule(actionsCss, '.field-input::placeholder');
    expect(body).toContain('color: var(--pw-text-subtle)');
    expect(body).toContain('opacity: 1');
  });

  it('are --pw-text-subtle in the message box', () => {
    const body = rule(relayCss, '.relay-text::placeholder');
    expect(body).toContain('color: var(--pw-text-subtle)');
    expect(body).toContain('opacity: 1');
  });
});
