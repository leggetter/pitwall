// The design system's icons (docs/design-system.md, 2.14): Material Symbols
// Rounded, as inline SVG path data from icons/paths.ts, asked for by meaning
// rather than by glyph. Decorative: the control or text next to an icon says
// what it means, so it's hidden from assistive technology. It takes the text
// colour, so it follows the theme. Not used by the UI yet; today's icons are
// in icons.tsx.

import { ICON_PATHS, type IconName } from '../icons/paths.js';

export type { IconName };

export interface IconProps {
  name: IconName;
  /** In px: 16 (--pw-icon-sm, the default) or 24 (--pw-icon-lg). */
  size?: 16 | 24;
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
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
