// The theme switch (docs/design-system.md, section 4): System, Light and Dark as three icon buttons
// in a group. Pressing one stores the choice and changes the theme at once (theme.ts).

import { useTheme, type ThemeChoice } from '../theme.js';
import { Icon, type IconName } from './Icon.js';
import './ThemeSwitch.css';

const OPTIONS: { choice: ThemeChoice; label: string; icon: IconName }[] = [
  { choice: 'system', label: 'System theme', icon: 'theme-system' },
  { choice: 'light', label: 'Light theme', icon: 'theme-light' },
  { choice: 'dark', label: 'Dark theme', icon: 'theme-dark' },
];

export function ThemeSwitch() {
  const { choice, setChoice } = useTheme();
  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      {OPTIONS.map((option) => (
        <button
          key={option.choice}
          type="button"
          className="theme-switch-option"
          aria-pressed={choice === option.choice}
          aria-label={option.label}
          // Until the design system's tooltips exist (W25), the browser's shows the same name.
          title={option.label}
          onClick={() => setChoice(option.choice)}
        >
          <Icon name={option.icon} />
        </button>
      ))}
    </div>
  );
}
