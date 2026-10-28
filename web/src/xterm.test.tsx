// createXterm() with xterm.js replaced: the options it gives the terminal, and when it opens it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import terminalCss from './components/Terminal.css?raw';
import terminalSource from './components/Terminal.tsx?raw';
import tokensCss from './tokens.css?raw';
import xtermSource from './xterm.ts?raw';

const created = vi.hoisted(() => ({ options: [] as unknown[], events: [] as string[], hooks: [] as string[], terminals: [] as { options: Record<string, unknown>; textarea: HTMLTextAreaElement | undefined }[] }));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    // xterm.js's live options: setting one, as a late font sets fontFamily, is recorded.
    options: Record<string, unknown>;
    textarea: HTMLTextAreaElement | undefined;
    constructor(options: Record<string, unknown>) {
      created.options.push(options);
      created.events.push('created');
      this.options = new Proxy({ ...options }, {
        set: (target, key, value) => {
          created.events.push(`set ${String(key)}`);
          target[String(key)] = value;
          return true;
        },
      });
      created.terminals.push(this);
    }
    // The public parser hooks keepCursorSteady() registers (W45), recorded in order with the terminal's opening and disposal.
    parser = {
      registerCsiHandler: (id: Record<string, string>) => {
        created.hooks.push(`csi ${JSON.stringify(id)}`);
        return { dispose: () => created.hooks.push(`disposed csi ${JSON.stringify(id)}`) };
      },
      registerEscHandler: (id: Record<string, string>) => {
        created.hooks.push(`esc ${JSON.stringify(id)}`);
        return { dispose: () => created.hooks.push(`disposed esc ${JSON.stringify(id)}`) };
      },
    };
    loadAddon() {}
    open(container: HTMLElement) {
      created.events.push('opened');
      created.hooks.push('opened');
      this.textarea = document.createElement('textarea');
      container.append(this.textarea);
    }
    onData() {}
    write() {}
    focus() {}
    dispose() {
      created.hooks.push('terminal disposed');
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      created.events.push('fit');
    }
  },
}));

const { createXterm, FONT_WAIT_MS, THEME_TOKENS, waitForFont } = await import('./xterm.js');
const { terminalLinkHandler } = await import('./links.js');

/** The options createXterm() gave the terminal it just created. */
function lastOptions(): Record<string, unknown> {
  return (created.options.at(-1) ?? {}) as Record<string, unknown>;
}

const lastTheme = () => lastOptions().theme;

/** A token's value as tokens.css declares it, in its first (light) block. */
function declared(token: string): string {
  const match = new RegExp(`${token}:\\s*([^;]+);`).exec(tokensCss);
  if (!match?.[1]) throw new Error(`${token} isn't in tokens.css`);
  return match[1].trim();
}

/** The same font family list, whichever quotes the browser gives it back with. */
const sameFamilies = (value: unknown) => String(value).replaceAll('"', "'");

function withTokens() {
  const style = document.createElement('style');
  style.textContent = tokensCss;
  document.head.append(style);
}

/** A stand-in for document.fonts, whose loads settle when the test says. */
function fontSet() {
  const loads: { font: string; resolve: () => void; reject: (error: unknown) => void }[] = [];
  const fonts = {
    load: vi.fn(
      (font: string) =>
        new Promise<FontFace[]>((resolve, reject) => {
          loads.push({ font, resolve: () => resolve([]), reject });
        }),
    ),
  };
  return { fonts, loads };
}

beforeEach(() => {
  created.options.length = 0;
  created.events.length = 0;
  created.terminals.length = 0;
});

afterEach(() => {
  for (const style of document.head.querySelectorAll('style')) style.remove();
  document.documentElement.removeAttribute('style');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('createXterm', () => {
  it("sets pitwall's link handler, so xterm.js never uses its default confirm() and window.open, nor any scheme but http and https", async () => {
    await createXterm(document.createElement('div'));
    expect(created.options).toHaveLength(1);
    expect(lastOptions()).toMatchObject({ linkHandler: terminalLinkHandler });
    expect(terminalLinkHandler.allowNonHttpProtocols).toBe(false);
  });

  it('takes its font family from --pw-font-mono, and the rest of its options from 4: Terminal', async () => {
    withTokens();
    await createXterm(document.createElement('div'));
    expect(sameFamilies(lastOptions().fontFamily)).toBe(sameFamilies(declared('--pw-font-mono')));
    expect(sameFamilies(lastOptions().fontFamily)).toMatch(/^'JetBrains Mono', /);
    expect(lastOptions()).toMatchObject({ fontSize: 13, cursorBlink: false, cursorStyle: 'block', scrollback: 5000 });
  });

  it('keeps the cursor steady from before it opens to after it closes: its parser hooks go in first and out before it (W45)', async () => {
    created.hooks.length = 0;
    const handle = await createXterm(document.createElement('div'));
    const hooks = [
      'csi {"intermediates":" ","final":"q"}',
      'csi {"prefix":"?","final":"h"}',
      'esc {"final":"c"}',
      'csi {"intermediates":"!","final":"p"}',
    ];
    expect(created.hooks).toEqual([...hooks, 'opened']);
    created.hooks.length = 0;
    handle.dispose();
    expect(created.hooks).toEqual([...hooks.map((hook) => `disposed ${hook}`), 'terminal disposed']);
  });

  it('takes its colours from the --pw-term-* tokens in tokens.css: background, foreground, cursor, selection, red, green, yellow and blue', async () => {
    withTokens();
    await createXterm(document.createElement('div'));
    expect(lastTheme()).toEqual({
      background: '#141412',
      foreground: '#F5F5F5',
      cursor: '#F5F5F5',
      selectionBackground: declared('--pw-term-selection'),
      red: '#E07B72',
      green: '#66B38C',
      yellow: '#FFE066',
      blue: '#668FE0',
    });
    expect(Object.keys(lastTheme() as object)).toEqual(THEME_TOKENS.map(([key]) => key));
  });

  it('reads the tokens when the terminal is created, not before', async () => {
    const root = document.documentElement;
    root.style.setProperty('--pw-term-bg', '#010203');
    root.style.setProperty('--pw-term-fg', '#040506');
    root.style.setProperty('--pw-term-cursor', '#070809');
    root.style.setProperty('--pw-font-mono', "'Made Up Mono', monospace");
    await createXterm(document.createElement('div'));
    expect(lastTheme()).toEqual({ background: '#010203', foreground: '#040506', cursor: '#070809' });
    expect(sameFamilies(lastOptions().fontFamily)).toBe("'Made Up Mono', monospace");

    root.style.setProperty('--pw-term-bg', '#0a0b0c');
    await createXterm(document.createElement('div'));
    expect(lastTheme()).toMatchObject({ background: '#0a0b0c' });
  });

  it("leaves out a token that isn't set, so xterm.js uses its default for it", async () => {
    document.documentElement.style.setProperty('--pw-term-bg', '#010203');
    await createXterm(document.createElement('div'));
    expect(lastTheme()).toEqual({ background: '#010203' });
    expect('fontFamily' in lastOptions()).toBe(false);
  });

  it("opens only once the terminal's font has loaded, so its cells are measured in JetBrains Mono, not the fallback", async () => {
    withTokens();
    const { fonts, loads } = fontSet();
    // happy-dom has no document.fonts.
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    try {
      const opening = createXterm(document.createElement('div'));
      await vi.waitFor(() => expect(loads).toHaveLength(2));
      expect(loads.map((load) => sameFamilies(load.font))).toEqual([400, 500].map((weight) => sameFamilies(`${weight} 13px ${declared('--pw-font-mono')}`)));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(created.events).toEqual([]);

      for (const load of loads) load.resolve();
      await opening;
      expect(created.events).toEqual(['created', 'opened', 'fit']);
    } finally {
      delete (document as { fonts?: unknown }).fonts;
    }
  });

  it('draws bold with the 500 face, the heaviest bundled, so the browser never synthesises a heavier one (W31)', async () => {
    await createXterm(document.createElement('div'), { fonts: undefined });
    expect(lastOptions().fontWeightBold).toBe(500);
  });

  it("describes xterm.js's textarea by the F6 hint, once it's open (W31)", async () => {
    const container = document.createElement('div');
    await createXterm(container, { describedBy: 'made-up-hint', fonts: undefined });
    expect(container.querySelector('textarea')?.getAttribute('aria-describedby')).toBe('made-up-hint');
  });

  it('measures its cells again, fits, and says its new size, when the font arrives after the wait (W31)', async () => {
    vi.useFakeTimers();
    withTokens();
    const { fonts, loads } = fontSet();
    const resized = vi.fn();
    const opening = createXterm(document.createElement('div'), { fonts, onResize: resized });
    await vi.advanceTimersByTimeAsync(FONT_WAIT_MS);
    await opening;
    // Opened with the fallback's cells.
    expect(created.events).toEqual(['created', 'opened', 'fit']);
    const family = lastOptions().fontFamily;

    for (const load of loads) load.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(created.events).toEqual(['created', 'opened', 'fit', 'set fontFamily', 'fit']);
    // A different string for the same list, so xterm.js measures again.
    const again = created.terminals.at(-1)!.options.fontFamily;
    expect(again).not.toBe(family);
    expect(String(again).trim()).toBe(String(family).trim());
    expect(resized).toHaveBeenCalledWith(80, 24);
  });

  it('leaves a terminal that opened in time, or was closed meanwhile, alone when the font arrives', async () => {
    vi.useFakeTimers();
    withTokens();
    const late = fontSet();
    const resized = vi.fn();
    const handle = await (async () => {
      const opening = createXterm(document.createElement('div'), { fonts: late.fonts, onResize: resized });
      await vi.advanceTimersByTimeAsync(FONT_WAIT_MS);
      return opening;
    })();
    handle.dispose();
    for (const load of late.loads) load.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(created.events).not.toContain('set fontFamily');
    expect(resized).not.toHaveBeenCalled();

    const inTime = fontSet();
    const opening = createXterm(document.createElement('div'), { fonts: inTime.fonts, onResize: resized });
    await vi.advanceTimersByTimeAsync(0);
    for (const load of inTime.loads) load.resolve();
    await opening;
    await vi.advanceTimersByTimeAsync(FONT_WAIT_MS);
    expect(created.events.filter((event) => event === 'set fontFamily')).toEqual([]);
    expect(resized).not.toHaveBeenCalled();
  });
});

describe('waitForFont', () => {
  it('asks document.fonts for the regular and medium faces of the whole family list', async () => {
    const { fonts, loads } = fontSet();
    const waiting = waitForFont("'Made Up Mono', monospace", fonts);
    await vi.waitFor(() => expect(loads).toHaveLength(2));
    expect(loads.map((load) => load.font)).toEqual(["400 13px 'Made Up Mono', monospace", "500 13px 'Made Up Mono', monospace"]);
    for (const load of loads) load.resolve();
    await expect(waiting).resolves.toBeUndefined();
  });

  it("opens with the fallback when the font can't load, without an unhandled rejection", async () => {
    const { fonts, loads } = fontSet();
    const waiting = waitForFont("'Made Up Mono'", fonts);
    await vi.waitFor(() => expect(loads).toHaveLength(2));
    loads[0]!.reject(new Error('made up: the font failed to load'));
    await expect(waiting).resolves.toBeUndefined();
  });

  it(`opens anyway after ${FONT_WAIT_MS} ms when the font never arrives`, async () => {
    vi.useFakeTimers();
    const { fonts } = fontSet();
    let done = false;
    void waitForFont("'Made Up Mono'", fonts).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(FONT_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('waits for nothing with no font family, or no document.fonts', async () => {
    const { fonts } = fontSet();
    await expect(waitForFont(undefined, fonts)).resolves.toBeUndefined();
    expect(fonts.load).not.toHaveBeenCalled();
    await expect(waitForFont("'Made Up Mono'", undefined)).resolves.toBeUndefined();
  });
});

describe("the terminal's code", () => {
  /** The source without its comments, which may name what the tokens hold. */
  const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  const FILES = { 'xterm.ts': xtermSource, 'components/Terminal.tsx': terminalSource, 'components/Terminal.css': terminalCss };

  it('hard-codes no colour: every colour is a token', () => {
    for (const [name, source] of Object.entries(FILES)) {
      expect(code(source).match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklch|oklab|color)\(/gi), name).toBeNull();
    }
  });

  it('hard-codes no font family: the terminal takes --pw-font-mono', () => {
    for (const [name, source] of Object.entries(FILES)) {
      expect(code(source).match(/font-family|fontFamily:\s*['"`]|JetBrains|Menlo|Consolas|Courier|SFMono|ui-monospace|\bmonospace\b|\bInter\b|sans-serif/g), name).toBeNull();
    }
  });

  /** A rule's declarations in Terminal.css, by its whole selector, as property and value. */
  function declarations(selector: string): Record<string, string> {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(code(terminalCss))?.[1];
    if (body === undefined) throw new Error(`${selector} isn't in Terminal.css`);
    return Object.fromEntries(
      body
        .split(';')
        .map((declaration) => declaration.trim())
        .filter((declaration) => declaration !== '')
        .map((declaration) => [declaration.slice(0, declaration.indexOf(':')).trim(), declaration.slice(declaration.indexOf(':') + 1).trim()]),
    );
  }

  it("keeps the screen's padding, edge and fill outside the box xterm.js opens in, which fills the screen's content box with none of its own (W74)", () => {
    // The fit addon takes the box's computed height and width, which border-box sizing would count any padding in.
    expect(declarations('.attach-terminal')).toMatchObject({
      display: 'flex',
      'flex-direction': 'column',
      padding: 'var(--pw-space-1-5)',
      'border-radius': 'var(--pw-radius-md)',
      background: 'var(--pw-term-bg)',
      'box-shadow': '0 0 0 1px var(--pw-border-strong)',
    });
    const box = declarations('.attach-terminal-fit');
    expect(box).toMatchObject({ flex: '1 1 0', 'min-width': '0', 'min-height': '0' });
    expect(Object.keys(box).filter((property) => /^(padding|border|margin)/.test(property))).toEqual([]);
  });
});
