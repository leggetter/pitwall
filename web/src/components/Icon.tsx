// The design system's icons (docs/design-system.md, 2.14): Material Symbols
// Rounded, as inline SVG path data from icons/paths.ts, asked for by meaning
// rather than by glyph. Each size draws its own optical size: 16 px the 20 px
// design and 24 px the 24 px one, so strokes keep their weight when small.
// Decorative: the control or text next to an icon says what it means, so it's
// hidden from assistive technology. It takes the text colour, so it follows the
// theme. Today's inline icons are still in icons.tsx; later PRs swap them for this.

import { ICON_PATHS, type IconName, type IconSize } from '../icons/paths.js';

export type { IconName, IconSize };

export interface IconProps {
  name: IconName;
  /** In px: 16 (--pw-icon-sm, the default) or 24 (--pw-icon-lg). */
  size?: IconSize;
  className?: string;
}

export function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 -960 960 960"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[name][size]} />
    </svg>
  );
}
