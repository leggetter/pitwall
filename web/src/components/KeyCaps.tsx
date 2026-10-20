// Key caps (docs/design-system.md, 4: Key caps): each key a <kbd>, 2 px apart with no "+" between
// them. ⌘ on Apple platforms and "Ctrl" elsewhere. The caps are hidden from assistive technology,
// which reads the combination's text alternative ("Command Enter") instead.

type NavigatorWithData = Navigator & { userAgentData?: { platform?: string } };

/** Whether the modifier is ⌘: macOS, or an iPad or iPhone with a keyboard. */
export function usesCommandKey(nav: NavigatorWithData | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  const platform = nav?.userAgentData?.platform ?? nav?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** ⌘ ↵ or Ctrl ↵, and how to read it out. */
export function modEnter(command = usesCommandKey()): { keys: string[]; label: string } {
  return command ? { keys: ['⌘', '↵'], label: 'Command Enter' } : { keys: ['Ctrl', '↵'], label: 'Control Enter' };
}

export interface KeyCapsProps {
  keys: readonly string[];
  /** The combination in words, for screen readers. */
  label: string;
}

export function KeyCaps({ keys, label }: KeyCapsProps) {
  return (
    <span className="key-caps">
      <span className="key-caps-keys" aria-hidden="true">
        {keys.map((key) => (
          <kbd key={key} className="key-cap">
            {key}
          </kbd>
        ))}
      </span>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
