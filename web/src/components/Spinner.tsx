// The spinner (docs/design-system.md, 4: Skeletons and spinners): a ring with a 2 px conic gradient,
// turning 0.8 s a turn, 12 px inline or 16 px in a button. It waits --pw-delay-spinner before it
// shows, so a fast answer never flashes it. It's decorative: the busy element carries aria-busy, or a
// status message says what's happening.

export interface SpinnerProps {
  /** 12 px beside text, as in a badge; 16 px in a button, where it takes the icon's place. */
  size?: 'inline' | 'button';
}

export function Spinner({ size = 'inline' }: SpinnerProps) {
  return <span className={size === 'button' ? 'spinner in-button' : 'spinner'} aria-hidden="true" />;
}
