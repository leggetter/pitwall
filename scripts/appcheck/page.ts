// One Chrome tab, driven the way a person would: real mouse clicks at an element's middle, after
// checking nothing covers it there; real key presses; typing as an input method commits it. It
// gathers everything the page does wrong, tagged with the step that was running: console errors and
// warnings, exceptions, CSP violations, failed requests and HTTP errors, and any request to anywhere
// but the fake server, which is blocked.
//
// Before the page's own scripts, an init script records CSP violations, stubs window.open (recording
// what it was asked to open), and stops any click on a link to another origin after pitwall's own
// handlers have run (recording whether pitwall had already stopped it), so no link ever opens a tab
// or leaves the fake server. Same-origin links, such as the repo list's, are left alone.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Cdp } from './cdp.js';
import type { Theme, Viewport } from './options.js';
import type { FakeServer } from './server.js';
import type { ResetOptions } from './fixtures.js';

export interface Problem {
  step: string;
  kind: string;
  text: string;
}

/** What the init script recorded for the open page. */
export interface PageRecords {
  csp: string[];
  /** window.open calls. */
  opened: Array<{ url: string; target: string; features: string }>;
  /** Clicks on links to other origins, after pitwall's handlers: `prevented` says whether pitwall stopped it. */
  clicks: Array<{ href: string; target: string; rel: string; prevented: boolean }>;
}

const INIT_SCRIPT = `(() => {
  const records = { csp: [], opened: [], clicks: [] };
  Object.defineProperty(window, '__appcheck', { value: records });
  document.addEventListener('securitypolicyviolation', (e) => records.csp.push(e.violatedDirective + ' ' + e.blockedURI));
  window.open = function (url, target, features) {
    records.opened.push({ url: String(url), target: String(target ?? ''), features: String(features ?? '') });
    return null;
  };
  const stopOffSite = (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a) return;
    let url;
    try { url = new URL(a.getAttribute('href'), location.href); } catch { return; }
    if (url.origin === location.origin) return;
    records.clicks.push({ href: a.getAttribute('href'), target: a.target, rel: a.rel, prevented: e.defaultPrevented });
    e.preventDefault();
  };
  window.addEventListener('click', stopOffSite);
  window.addEventListener('auxclick', stopOffSite);
})();`;

/** Ready once the session list shows rows or an empty state. */
export const LIST_READY = `document.querySelectorAll('.session-list [data-open-session]').length > 0 || !!document.querySelector('.session-list .empty-state')`;

export interface FreshOptions extends ResetOptions {
  /** The query, such as `?view=all` or `?session=<id>`. */
  search?: string;
  /** localStorage items set before the page loads, such as a stored preference. */
  storage?: Record<string, string>;
  /** An expression that's true once the page is ready. */
  ready?: string;
  /** Emulate forced colours, as a Windows contrast theme sets them (W75). Off again at the next fresh page. */
  forcedColors?: boolean;
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  F6: { code: 'F6', keyCode: 117 },
  '/': { code: 'Slash', keyCode: 191, text: '/' },
  '?': { code: 'Slash', keyCode: 191, text: '?' },
};

export interface KeyOptions {
  shift?: boolean;
  /** ⌘ on a Mac. */
  meta?: boolean;
  ctrl?: boolean;
}

export class Page {
  readonly problems: Problem[] = [];
  /** The step running now, which problems are tagged with. */
  step = 'start';
  #claimed = 0;
  readonly #cdp: Cdp;
  readonly #session: string;
  readonly #targetId: string;
  readonly #server: FakeServer;
  readonly #token: string;
  readonly #urls = new Map<string, string>();
  #loaded: (() => void) | undefined;
  readonly #off: Array<() => void> = [];

  readonly #keys: boolean;

  private constructor(cdp: Cdp, session: string, targetId: string, server: FakeServer, token: string, keys: boolean) {
    this.#keys = keys;
    this.#cdp = cdp;
    this.#session = session;
    this.#targetId = targetId;
    this.#server = server;
    this.#token = token;
  }

  /**
   * A new tab, attached, with the problem listeners, the request guard and the init script in place.
   * `keys` says whether key presses may be sent: only when the browser can't make the machine play a
   * sound for one the page doesn't handle (Chrome.silent).
   */
  static async open(cdp: Cdp, server: FakeServer, token: string, { keys }: { keys: boolean }): Promise<Page> {
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(cdp, sessionId, targetId, server, token, keys);
    page.#listen();
    for (const domain of ['Page', 'Runtime', 'Network', 'Log']) await page.send(`${domain}.enable`);
    // Every request is held until it's checked: the fake server's go on, anything else fails.
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INIT_SCRIPT });
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    return page;
  }

  get origin(): string {
    return this.#server.origin;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.#cdp.send<T>(method, params, this.#session);
  }

  #listen() {
    const mine = (listener: (params: Record<string, any>) => void) => (params: Record<string, unknown>, sessionId: string | undefined) => {
      if (sessionId === this.#session) listener(params);
    };
    const on = (method: string, listener: (params: Record<string, any>) => void) => this.#off.push(this.#cdp.on(method, mine(listener)));
    const problem = (kind: string, text: string) => this.problems.push({ step: this.step, kind, text });

    on('Runtime.consoleAPICalled', ({ type, args }) => {
      if (type === 'error' || type === 'assert' || type === 'warning') {
        problem(`console.${type}`, (args as Array<{ value?: unknown; description?: string }>).map((arg) => String(arg.value ?? arg.description ?? '')).join(' '));
      }
    });
    on('Runtime.exceptionThrown', ({ exceptionDetails }) => problem('exception', exceptionDetails.exception?.description ?? exceptionDetails.text));
    on('Log.entryAdded', ({ entry }) => {
      // With the URL it's about, when it has one, such as a failed request's, shown as every URL is.
      const about = typeof entry.url === 'string' && entry.url !== '' ? ` ${this.#shown(entry.url)}` : '';
      if (entry.level === 'error' || entry.source === 'security') problem(`log.${entry.source}.${entry.level}`, `${entry.text}${about}`);
    });
    on('Network.requestWillBeSent', ({ requestId, request }) => this.#urls.set(requestId, this.#shown(request.url)));
    on('Network.responseReceived', ({ response }) => {
      if (response.status >= 400) problem('http', `${response.status} ${this.#shown(response.url)}`);
    });
    on('Network.loadingFailed', ({ requestId, errorText, canceled, type }) => {
      if (!canceled) problem('request-failed', `${errorText} ${type} ${this.#urls.get(requestId) ?? ''}`.trim());
    });
    on('Network.webSocketFrameError', ({ errorMessage }) => problem('websocket', errorMessage));
    on('Fetch.requestPaused', ({ requestId, request }) => {
      const url = String(request.url);
      if (url.startsWith(`${this.#server.origin}/`)) {
        void this.send('Fetch.continueRequest', { requestId }).catch(() => {});
      } else {
        problem('off-server', `blocked a request to ${this.#shown(url)}`);
        void this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      }
    });
    on('Page.loadEventFired', () => this.#loaded?.());
  }

  /** A URL as problems show it: without its query or fragment, so no token is ever in a message. */
  #shown(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return '(a URL that does not parse)';
    }
  }

  /** The expression's value in the page. Throws, with the page's message, when it throws. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const { result, exceptionDetails } = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`in the page: ${exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text}`);
    return result.value as T;
  }

  /** Waits until `expression` is truthy, and returns its value. Throws after `timeoutMs`, naming `what`. */
  async waitFor<T = unknown>(what: string, expression: string, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    for (;;) {
      try {
        const value = await this.evaluate<T>(expression);
        if (value) return value;
      } catch (error) {
        // A page navigating away has no context for a moment; anything else is the expression's own fault.
        if (!/context|Cannot find|navigat/i.test(String(error))) throw error;
        last = error;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? ` (${String(last)})` : ''}`);
      await sleep(40);
    }
  }

  /** Two animation frames, so what the last action changed has been laid out and painted. */
  async settle(ms = 0): Promise<void> {
    await this.evaluate('new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok(true))))').catch(() => {});
    if (ms > 0) await sleep(ms);
  }

  /**
   * A real click at the middle of the element `expression` finds, as a person would make it. The
   * element is brought into view by scrolling what a reader can scroll, never an overflow: hidden box,
   * and the click fails when the element has no box, is outside the window, or something covers it.
   */
  async click(what: string, expression: string, { button = 'left', timeoutMs = 5000 }: { button?: 'left' | 'middle'; timeoutMs?: number } = {}): Promise<void> {
    await this.waitFor(what, `!!(${expression})`, timeoutMs);
    const point = await this.evaluate<{ x: number; y: number } | { error: string }>(`(() => {
      const el = ${expression};
      const held = [];
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        const x = /hidden|clip/.test(s.overflowX), y = /hidden|clip/.test(s.overflowY);
        if (x || y) held.push([p, x, y, p.scrollLeft, p.scrollTop]);
      }
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      for (const [p, x, y, left, top] of held) { if (x) p.scrollLeft = left; if (y) p.scrollTop = top; }
      const box = [...el.getClientRects()].find((r) => r.width > 0 && r.height > 0);
      if (!box) return { error: 'has no box on screen' };
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { error: 'is outside the window, at ' + Math.round(x) + ', ' + Math.round(y) };
      const hit = document.elementFromPoint(x, y);
      const mine = hit && (el === hit || el.contains(hit) || [...(el.labels ?? [])].some((label) => label.contains(hit)));
      if (!mine) return { error: 'is covered by ' + (hit ? hit.tagName.toLowerCase() + (hit.className && typeof hit.className === 'string' ? '.' + hit.className.trim().split(/\\s+/).join('.') : '') : 'nothing') };
      return { x, y };
    })()`);
    if ('error' in point) throw new Error(`can't click ${what}: it ${point.error}`);
    const buttons = button === 'left' ? 1 : 4;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, buttons, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount: 1 });
    await this.settle();
  }

  /** A real key press: one of KEYS, or a single character, with Shift, ⌘ or Ctrl if asked. */
  async key(name: string, { shift = false, meta = false, ctrl = false }: KeyOptions = {}): Promise<void> {
    if (!this.#keys) throw new Error(`refused to press ${name}: on macOS only chrome-headless-shell presses keys without the system alert sound (README.md)`);
    const known = KEYS[name];
    const upper = name.toUpperCase();
    const code = known?.code ?? (/^[a-z]$/i.test(name) ? `Key${upper}` : /^\d$/.test(name) ? `Digit${name}` : name);
    const keyCode = known?.keyCode ?? upper.charCodeAt(0);
    const modifiers = (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift || name === '?' ? 8 : 0);
    const text = meta || ctrl ? undefined : (known ? known.text : name);
    const key = { key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: text === undefined ? 'rawKeyDown' : 'keyDown', ...key, ...(text === undefined ? {} : { text, unmodifiedText: text }) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    await this.settle();
  }

  /** Types into whatever has focus, as an input method commits text. */
  async type(text: string): Promise<void> {
    await this.send('Input.insertText', { text });
    await this.settle();
  }

  async shot(path: string): Promise<void> {
    await this.settle();
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(data, 'base64'));
  }

  /** How many problems no step has claimed yet. */
  get unclaimed(): number {
    return this.problems.length - this.#claimed;
  }

  /** The problems no step has claimed yet, now claimed: each is reported once, by the step that ends next. */
  claimProblems(): Problem[] {
    const claimed = this.problems.slice(this.#claimed);
    this.#claimed = this.problems.length;
    return claimed;
  }

  /** What the init script recorded since this document loaded. */
  records(): Promise<PageRecords> {
    return this.evaluate<PageRecords>('JSON.parse(JSON.stringify(window.__appcheck))');
  }

  /** CSP violations since the last call, in this document. */
  takeCsp(): Promise<string[]> {
    return this.evaluate<string[]>('window.__appcheck ? window.__appcheck.csp.splice(0) : []').catch(() => []);
  }

  /**
   * A fresh page: the app left, the fake server's data reset, storage cleared and any `storage` set,
   * the window and theme set, then the app loaded with the token in its fragment, as the CLI's
   * launch opens it, and waited on until it's ready.
   */
  async fresh(viewport: Viewport, theme: Theme, { search = '?view=all', storage = {}, ready = LIST_READY, forcedColors = false, ...reset }: FreshOptions = {}): Promise<void> {
    await this.#blank();
    this.#server.reset(reset);
    await this.send('Storage.clearDataForOrigin', { origin: this.origin, storageTypes: 'local_storage,session_storage' });
    // DOMStorage needs a frame on the origin, and about:blank isn't one, so the items are set by a
    // script that runs before the app's own on this one load, then goes, so a reload keeps what the app wrote.
    const seeded =
      Object.keys(storage).length === 0
        ? undefined
        : await this.send<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', {
            source: `(() => { if (location.origin !== ${JSON.stringify(this.origin)}) return; for (const [key, value] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(key, value); })()`,
          });
    await this.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
    const media = [{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }];
    if (forcedColors) media.push({ name: 'forced-colors', value: 'active' });
    await this.send('Emulation.setEmulatedMedia', { features: media });
    try {
      await this.#load(() => this.send('Page.navigate', { url: `${this.origin}/${search}#token=${this.#token}` }), 'the app');
    } finally {
      if (seeded) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seeded.identifier });
    }
    await this.waitFor('the app to be ready', ready, 15_000);
    await this.evaluate('document.fonts.ready.then(() => true)');
    await this.settle();
  }

  /** Loads a path on the fake server in this tab, which keeps its sessionStorage, and so its token. */
  async navigate(pathAndSearch: string): Promise<void> {
    await this.#load(() => this.send('Page.navigate', { url: `${this.origin}${pathAndSearch}` }), pathAndSearch);
  }

  async reload(): Promise<void> {
    await this.#load(() => this.send('Page.reload', {}), 'the reload');
  }

  async #blank(): Promise<void> {
    await this.send('Page.navigate', { url: 'about:blank' });
    await this.waitFor('about:blank', `location.href === 'about:blank'`, 10_000);
  }

  async #load(start: () => Promise<unknown>, what: string): Promise<void> {
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no load event for ${what} in 15 s`)), 15_000);
      this.#loaded = () => {
        clearTimeout(timer);
        this.#loaded = undefined;
        resolve();
      };
    });
    const result = (await start()) as { errorText?: string };
    if (result.errorText) throw new Error(`couldn't load ${what}: ${result.errorText}`);
    await loaded;
  }

  async close(): Promise<void> {
    for (const off of this.#off) off();
    await this.#cdp.send('Target.closeTarget', { targetId: this.#targetId }).catch(() => {});
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
