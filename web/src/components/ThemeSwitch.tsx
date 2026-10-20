// The theme switch (docs/design-system.md, section 4): System, Light and Dark as three icon buttons
// in a group, each named by its tooltip. Pressing one stores the choice and changes the theme at once
// (theme.ts).

import { useTheme, type ThemeChoice } from '../theme.js';
import { Icon, type IconName } from './Icon.js';
import { Tooltip } from './Tooltip.js';
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
        // Each option's name is its tooltip (6.1, item 5).
        <Tooltip key={option.choice} content={option.label} relation="label">
          <button type="button" className="theme-switch-option" aria-pressed={choice === option.choice} onClick={() => setChoice(option.choice)}>
            <Icon name={option.icon} />
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
