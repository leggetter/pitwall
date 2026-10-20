// The foundations (W19): the --pw-* tokens as the page has them, the bundled fonts at the type
// scale's sizes, every icon, and the theme switch (W20).

import { useEffect, useState, type CSSProperties } from 'react';
import { Icon } from '../components/Icon.js';
import { ChevronIcon, FolderIcon, GitIcon } from '../components/icons.js';
import { ThemeSwitch } from '../components/ThemeSwitch.js';
import { ICON_PATHS, type IconName } from '../icons/paths.js';
import type { StorageSource } from '../groupState.js';
import { createThemeStore, THEME_KEY, ThemeStoreContext, useTheme, type ThemeChoice, type ThemeStore } from '../theme.js';
import { Specimen } from './kit.js';

interface Token {
  name: string;
  value: string;
}

/** Every --pw-* custom property set on :root by the page's stylesheets, in the order they're declared. */
function tokenNames(): string[] {
  const names = new Set<string>();
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if ('selectorText' in rule && 'style' in rule && String(rule.selectorText).includes(':root')) {
        for (const property of Array.from((rule as CSSStyleRule).style)) if (property.startsWith('--pw-')) names.add(property);
      }
      if ('cssRules' in rule && rule.cssRules) visit(rule.cssRules as CSSRuleList);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // A stylesheet from another origin can't be read. pitwall has none.
    }
  }
  return [...names];
}

function isColour(value: string): boolean {
  return value !== '' && typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', value);
}

/**
 * A colour in the doc's notation, #RRGGBB or rgb(r g b / a), whatever the minifier made of it
 * (#fff, #00000059). The browser resolves it on a probe element.
 */
function inDocNotation(value: string, probe: HTMLElement): string {
  probe.style.color = '';
  probe.style.color = value;
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(getComputedStyle(probe).color);
  if (!match) return value;
  const [r, g, b] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (alpha === 1) return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return `rgb(${r} ${g} ${b} / ${Math.round(alpha * 100) / 100})`;
}

/** The tokens' values for the theme now on screen, read again whenever the theme changes. */
function useTokens(): { colours: Token[]; others: Token[] } {
  const { resolved } = useTheme();
  const [tokens, setTokens] = useState<{ colours: Token[]; others: Token[] }>({ colours: [], others: [] });
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const all = tokenNames().map((name) => ({ name, value: style.getPropertyValue(name).trim() }));
    const probe = document.body.appendChild(document.createElement('span'));
    const colours = all.filter((token) => isColour(token.value)).map((token) => ({ ...token, value: inDocNotation(token.value, probe) }));
    probe.remove();
    setTokens({ colours, others: all.filter((token) => !isColour(token.value)) });
  }, [resolved]);
  return tokens;
}

export function Tokens() {
  const { colours, others } = useTokens();
  const { resolved } = useTheme();
  return (
    <>
      <Specimen
        title={`Colour tokens (${colours.length})`}
        note={`Read at runtime from the custom properties the stylesheets set on :root, with the values the ${resolved} theme gives them now.`}
      >
        {colours.length === 0 ? (
          <p className="uikit-note">No --pw-* colour tokens found on this page.</p>
        ) : (
          <ul className="uikit-swatches">
            {colours.map((token) => (
              <li key={token.name}>
                <span className="uikit-swatch" style={{ background: `var(${token.name})` }} />
                <code>{token.name}</code>
                <span className="uikit-value">{token.value}</span>
              </li>
            ))}
          </ul>
        )}
      </Specimen>
      <Specimen title={`Other tokens (${others.length})`} note="Fonts, radii and shadows, which aren't colours.">
        <ul className="uikit-token-list">
          {others.map((token) => (
            <li key={token.name}>
              <code>{token.name}</code>
              <span className="uikit-value">{token.value}</span>
            </li>
          ))}
        </ul>
      </Specimen>
    </>
  );
}

const INTER = "'Inter'";
const MONO = "'JetBrains Mono'";

/** The roles in docs/design-system.md, 2.7, at their sizes and weights. */
const ROLES: { role: string; size: string; rem: string; leading: string; weight: number; font: string; sample: string }[] = [
  { role: 'Body', size: 'm 14/20', rem: '0.875rem', leading: '1.25rem', weight: 400, font: INTER, sample: 'The export job retries a failed batch three times, then gives up.' },
  { role: 'Row and group name', size: 'm 14/20', rem: '0.875rem', leading: '1.25rem', weight: 500, font: INTER, sample: 'pitwall-test-app · Export retries' },
  { role: 'Panel and dialog title', size: 'l 16/24', rem: '1rem', leading: '1.5rem', weight: 600, font: INTER, sample: 'New session' },
  { role: 'Wordmark', size: 'l 16/24', rem: '1rem', leading: '1.5rem', weight: 600, font: INTER, sample: 'pitwall' },
  { role: 'Meta', size: 's 13/20', rem: '0.8125rem', leading: '1.25rem', weight: 400, font: INTER, sample: 'Active 5m ago · 4 sessions · 2 need you' },
  { role: 'Label', size: 'xs 12/20', rem: '0.75rem', leading: '1.25rem', weight: 500, font: INTER, sample: 'Waiting: permission prompt' },
  { role: 'Path and ID', size: 'xs 12/20', rem: '0.75rem', leading: '1.25rem', weight: 400, font: MONO, sample: '~/code/pitwall-test-app/packages/exporter · 00000000-0000-4000-8000-000000000001' },
  { role: 'Code', size: 's 13/20', rem: '0.8125rem', leading: '1.25rem', weight: 400, font: MONO, sample: 'claude attach pt000002 // -> != === <= >=' },
  { role: 'Scale step xl', size: 'xl 20/28', rem: '1.25rem', leading: '1.75rem', weight: 600, font: INTER, sample: 'No role uses xl yet' },
];

const WEIGHTS: { font: string; label: string; weights: number[]; rem: string }[] = [
  { font: INTER, label: 'Inter', weights: [400, 500, 600], rem: '0.875rem' },
  { font: MONO, label: 'JetBrains Mono', weights: [400, 500], rem: '0.8125rem' },
];

const role = (font: string, rem: string, leading: string, weight: number): CSSProperties => ({
  fontFamily: font,
  fontSize: rem,
  lineHeight: leading,
  fontWeight: weight,
});

/** Which bundled font files the browser has loaded, from document.fonts. */
function useFontFiles(): string[] {
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    let alive = true;
    const read = () => {
      if (!alive) return;
      const faces: string[] = [];
      fonts.forEach((face) => {
        // Latin starts at U+0000 (which browsers may write as U+0); Latin Extended at U+0100.
        const subset = Number.parseInt(face.unicodeRange.replace(/^U\+/i, ''), 16) === 0 ? 'latin' : 'latin-ext';
        faces.push(`${face.family.replace(/"/g, '')} ${face.weight} ${subset}: ${face.status}`);
      });
      setFiles(faces);
    };
    void fonts.ready.then(read);
    fonts.addEventListener?.('loadingdone', read);
    return () => {
      alive = false;
      fonts.removeEventListener?.('loadingdone', read);
    };
  }, []);
  return files;
}

/** Each font token's stack without its first family, read from the page, so it can't drift from tokens.css. */
function useFallbacks(): Record<'--pw-font-sans' | '--pw-font-mono', string> {
  const [stacks, setStacks] = useState({ '--pw-font-sans': 'sans-serif', '--pw-font-mono': 'monospace' });
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const rest = (token: string, generic: string) => style.getPropertyValue(token).split(',').slice(1).join(',').trim() || generic;
    setStacks({ '--pw-font-sans': rest('--pw-font-sans', 'sans-serif'), '--pw-font-mono': rest('--pw-font-mono', 'monospace') });
  }, []);
  return stacks;
}

export function Type() {
  const files = useFontFiles();
  const fallbacks = useFallbacks();
  return (
    <>
      <Specimen
        title="Roles"
        note="Each role at its size, line height and weight, in Inter or JetBrains Mono named on its own, with no fallback in the stack. A serif means the font didn't load."
      >
        <table className="uikit-table">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Size</th>
              <th scope="col">Weight</th>
              <th scope="col">Specimen</th>
            </tr>
          </thead>
          <tbody>
            {ROLES.map((entry) => (
              <tr key={entry.role}>
                <th scope="row">{entry.role}</th>
                <td>{entry.size}</td>
                <td>{entry.weight}</td>
                <td>
                  <span
                    style={{
                      ...role(entry.font, entry.rem, entry.leading, entry.weight),
                      ...(entry.font === MONO ? { fontVariantLigatures: 'none' } : {}),
                    }}
                  >
                    {entry.sample}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Specimen>
      <Specimen title="Bundled weights" note="Every weight fonts.css bundles, with tabular figures and Latin Extended text, which loads the second subset.">
        <div className="uikit-type-grid">
          {WEIGHTS.flatMap(({ font, label, weights, rem }) =>
            weights.map((weight) => (
              <div key={`${label}-${weight}`} style={role(font, rem, '1.25rem', weight)}>
                <p>
                  {label} {weight}
                </p>
                <p>The quick brown fox jumps over the lazy dog</p>
                <p style={{ fontVariantNumeric: 'tabular-nums' }}>0123456789 · 12:06:14 · 2 of 15</p>
                <p>Łódź · Ærøskøbing · Šibenik · İzmir</p>
              </div>
            )),
          )}
        </div>
      </Specimen>
      <Specimen title="Ligatures in code" note="The doc turns ligatures off in fields and code. The first line is off, the second is the font's default.">
        <p style={{ ...role(MONO, '0.8125rem', '1.25rem', 400), fontVariantLigatures: 'none' }}>{'// -> => != === <= >= :: ...'}</p>
        <p style={role(MONO, '0.8125rem', '1.25rem', 400)}>{'// -> => != === <= >= :: ...'}</p>
      </Specimen>
      <Specimen
        title="The font tokens, and their fallbacks"
        note="--pw-font-sans and --pw-font-mono as the app uses them, then the same stacks without their first family: what shows until the bundled font loads (font-display: swap)."
      >
        {(['--pw-font-sans', '--pw-font-mono'] as const).map((token) => {
          const mono = token === '--pw-font-mono';
          const size = mono ? { fontSize: 'var(--pw-text-xs)', fontVariantLigatures: 'none' } : { fontSize: 'var(--pw-text-m)' };
          const sample = mono ? '~/code/pitwall-test-app/packages/exporter' : 'The export job retries a failed batch three times, then gives up.';
          return (
            <div key={token}>
              <p style={{ fontFamily: `var(${token})`, ...size }}>
                {sample} <span className="uikit-note">{token}</span>
              </p>
              <p style={{ fontFamily: fallbacks[token], ...size }}>
                {sample} <span className="uikit-note">fallback</span>
              </p>
            </div>
          );
        })}
      </Specimen>
      <Specimen title="Font files" note="document.fonts: every face fonts.css declares, and whether this page has loaded it.">
        <ul className="uikit-token-list" aria-live="polite">
          {files.map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      </Specimen>
    </>
  );
}

const NAMES = Object.keys(ICON_PATHS) as IconName[];

export function Icons() {
  return (
    <>
      <Specimen
        title={`Every icon (${NAMES.length})`}
        note="Each name in ICON_PATHS at 16 px and 24 px, then at 16 px in a line of 14 px text. Material Symbols Rounded: 16 px draws the 20 px optical size, and 24 px the 24 px one."
      >
        <ul className="uikit-icons">
          {NAMES.map((name) => (
            <li key={name}>
              <span className="uikit-icon-sizes">
                <Icon name={name} />
                <Icon name={name} size={24} />
              </span>
              <code>{name}</code>
              <span className="uikit-icon-line">
                <Icon name={name} /> Start session
              </span>
            </li>
          ))}
        </ul>
      </Specimen>
      <Specimen
        title="Next to today's inline icons"
        note="Today's chevron (12 px), git and folder icons (14 px), from icons.tsx, then their replacements (expand, repo, directory) at 16 px, each in 14 px text."
      >
        <div className="uikit-icon-compare">
          <p>
            <ChevronIcon /> <GitIcon /> pitwall-test-app <span className="uikit-note">today</span>
          </p>
          <p>
            <Icon name="expand" /> <Icon name="repo" /> pitwall-test-app <span className="uikit-note">Icon, 16 px</span>
          </p>
          <p>
            <ChevronIcon /> <FolderIcon /> pitwall-test-notes <span className="uikit-note">today</span>
          </p>
          <p>
            <Icon name="expand" /> <Icon name="directory" /> pitwall-test-notes <span className="uikit-note">Icon, 16 px</span>
          </p>
        </div>
      </Specimen>
    </>
  );
}

/** A theme store of its own, holding `choice`, that changes nothing on the page: for a specimen of one state. */
function specimenStore(choice: ThemeChoice): ThemeStore {
  const stored = new Map<string, string>([[THEME_KEY, choice]]);
  const storage: StorageSource = () => ({ getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, value) });
  return createThemeStore({ storage, darkQuery: () => undefined, root: () => document.createElement('div') });
}

const PRESSED: { choice: ThemeChoice; title: string }[] = [
  { choice: 'system', title: 'System pressed' },
  { choice: 'light', title: 'Light pressed' },
  { choice: 'dark', title: 'Dark pressed' },
];

export function ThemeSwitches() {
  const { choice, resolved } = useTheme();
  const [stores] = useState(() => PRESSED.map(({ choice: pressed }) => specimenStore(pressed)));
  return (
    <>
      <Specimen
        title="The page's switch"
        note={`The same store as the bar above and the app's header: it's showing ${choice}, which resolves to ${resolved ?? 'whatever the system says'}. The choice is stored as ${THEME_KEY}.`}
      >
        <ThemeSwitch />
      </Specimen>
      <div className="uikit-grid">
        {PRESSED.map(({ title }, index) => (
          <Specimen key={title} title={title} note="A store of its own, so pressing these doesn't change the page.">
            <div data-own-store="">
              <ThemeStoreContext.Provider value={stores[index]}>
                <ThemeSwitch />
              </ThemeStoreContext.Provider>
            </div>
          </Specimen>
        ))}
      </div>
    </>
  );
}
