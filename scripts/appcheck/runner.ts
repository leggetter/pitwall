// Parts, cases and steps. A part is one area of the app, in its own file under parts/. It runs once
// for each window and theme, a case, on a fresh page, as a list of named steps. Each step passes or
// fails on its own: on its own checks (t.expect), on anything it throws, such as a wait that timed
// out or a click on something covered, and, after every step, on the page itself: a console error or
// warning, an exception, a CSP violation, a failed request, a request off the fake server, or the
// page scrolling sideways. A failed request the step brings about on purpose, which it names with
// t.allow, is reported but passes. A step that throws leaves the page in a state the next can't trust, so the
// rest of that case is skipped; the next case starts afresh.

import { join } from 'node:path';
import type { FakeServer } from './server.js';
import type { Theme, Viewport, ShotMode } from './options.js';
import type { FreshOptions, Page, Problem } from './page.js';

export type Layout = 'drawer' | 'sidebar' | 'three-columns';

export interface Part {
  /** What --only and --skip take, and the folder its screenshots go in: the file's name. */
  name: string;
  /** One line on what it checks, for --list and the summary. */
  title: string;
  /** The windows it runs at, by name. All five when not given. */
  viewports?: readonly string[];
  /** Why it doesn't run by default, such as a change it checks that isn't merged yet. --pending runs it. */
  pending?: string;
  run(t: Case): Promise<void>;
}

export interface StepResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  ms: number;
  failures: string[];
  problems: Array<Omit<Problem, 'step'>>;
  /** Problems the step said it brings about, with why (Case.allow): reported, but not failures. */
  allowed?: Array<Omit<Problem, 'step'> & { why: string }>;
  /** A screenshot taken when it failed, relative to the output folder. */
  shot?: string;
}

export interface CaseResult {
  part: string;
  viewport: string;
  theme: Theme;
  ms: number;
  steps: StepResult[];
}

export class BailError extends Error {
  override name = 'BailError';
}

/** The layout pitwall's web UI uses at a width (web/src/layout.ts). */
export function layoutAt(width: number): Layout {
  if (width >= 1200) return 'three-columns';
  return width >= 900 ? 'sidebar' : 'drawer';
}

export interface CaseOptions {
  part: Part;
  page: Page;
  server: FakeServer;
  viewport: Viewport;
  theme: Theme;
  out: string;
  shots: ShotMode;
  bail: boolean;
  log: (line: string) => void;
}

/** One part at one window and theme: what a part's run() gets as `t`. */
export class Case {
  readonly page: Page;
  readonly server: FakeServer;
  readonly viewport: Viewport;
  readonly theme: Theme;
  readonly layout: Layout;
  /** `375-light`, `1440-dark` and so on: for step names and screenshots. */
  readonly at: string;
  readonly result: CaseResult;
  readonly #options: CaseOptions;
  #current: StepResult | undefined;
  #broken: string | undefined;
  /** What the step running now said it brings about (allow). */
  #allowed: Array<{ pattern: RegExp; why: string }> = [];

  constructor(options: CaseOptions) {
    this.#options = options;
    this.page = options.page;
    this.server = options.server;
    this.viewport = options.viewport;
    this.theme = options.theme;
    this.layout = layoutAt(options.viewport.width);
    this.at = `${options.viewport.name}-${options.theme}`;
    this.result = { part: options.part.name, viewport: options.viewport.name, theme: options.theme, ms: 0, steps: [] };
  }

  /** The run's output folder (--out), for files a part makes to hand to the page, such as ones to attach (W82). */
  get out(): string {
    return this.#options.out;
  }

  /** Below 600 px: the session view is full width, with Back to sessions in place of Close. */
  get compact(): boolean {
    return this.viewport.width <= 600;
  }

  /** A fresh page in this case's window and theme: see Page.fresh. */
  fresh(options: FreshOptions = {}): Promise<void> {
    return this.page.fresh(this.viewport, this.theme, options);
  }

  /**
   * Runs one named step. Its checks, anything it throws, and the page's problems and sideways scroll
   * after it decide whether it passed. Skipped when an earlier step of this case threw.
   */
  async step(name: string, body: () => Promise<void>): Promise<void> {
    const result: StepResult = { name, status: 'passed', ms: 0, failures: [], problems: [] };
    this.result.steps.push(result);
    if (this.#broken !== undefined) {
      result.status = 'skipped';
      result.failures.push(`skipped: "${this.#broken}" didn't finish`);
      return;
    }
    const started = Date.now();
    this.#current = result;
    this.#allowed = [];
    this.page.step = `${this.#options.part.name} ${this.at}: ${name}`;
    let threw = false;
    try {
      await body();
    } catch (error) {
      threw = true;
      result.failures.push(error instanceof Error ? error.message : String(error));
    }
    try {
      // What the step's last action set off arrives a moment later.
      await this.page.settle(30);
      for (const csp of await this.page.takeCsp()) this.page.problems.push({ step: this.page.step, kind: 'csp', text: csp });
      if (await this.page.evaluate<boolean>('document.documentElement.scrollWidth > innerWidth')) {
        const by = await this.page.evaluate<number>('document.documentElement.scrollWidth - innerWidth');
        result.failures.push(`the page scrolls sideways, by ${by} px`);
      }
    } catch (error) {
      result.failures.push(`couldn't check the page after the step: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const { kind, text } of this.page.claimProblems()) {
      const allowed = this.#allowed.find(({ pattern }) => pattern.test(`${kind} ${text}`));
      if (allowed) {
        (result.allowed ??= []).push({ kind, text, why: allowed.why });
        continue;
      }
      result.problems.push({ kind, text });
      result.failures.push(`${kind}: ${text}`);
    }
    this.#allowed = [];
    this.#current = undefined;
    result.ms = Date.now() - started;
    if (result.failures.length > 0) {
      result.status = 'failed';
      if (this.#options.shots !== 'none') {
        const file = join('failures', this.#options.part.name, `${this.at}-${slug(name)}.png`);
        await this.page.shot(join(this.#options.out, file)).then(
          () => (result.shot = file),
          () => {},
        );
      }
      this.#options.log(`      FAIL ${this.#options.part.name} ${this.at}: ${name}\n${result.failures.map((each) => `           ${each}`).join('\n')}`);
      if (threw) this.#broken = name;
      if (this.#options.bail) throw new BailError(`${this.#options.part.name} ${this.at}: ${name}`);
    }
  }

  /**
   * After the part's last step: anything the page did wrong once that step had been checked, such
   * as an error a moment later, fails a step of its own here, rather than the next case's first.
   */
  async finish(): Promise<void> {
    if (this.#broken !== undefined || this.result.steps.length === 0) {
      // The case has failed already; what's left is its own, not the next case's.
      this.page.claimProblems();
      return;
    }
    await this.page.settle(50);
    for (const csp of await this.page.takeCsp()) this.page.problems.push({ step: this.page.step, kind: 'csp', text: csp });
    if (this.page.unclaimed > 0) await this.step('nothing went wrong after the last step', async () => {});
  }

  /**
   * Inside a step: a problem the step brings about on purpose, such as the HTTP error a refused request
   * gets, which the page reports as a failed request. A problem whose `kind text` matches `pattern` is
   * reported in the summary with `why`, and doesn't fail the step. Only for this step, and only what
   * it names: keep the pattern to the one request, by its path.
   */
  allow(pattern: RegExp, why: string): void {
    if (!this.#current) throw new Error(`t.allow(${pattern}) outside a step`);
    this.#allowed.push({ pattern, why });
  }

  /** A check inside a step: when `ok` is falsy, the step fails with `what`, and `detail` if given. It doesn't stop the step. */
  expect(ok: unknown, what: string, detail?: unknown): void {
    if (!this.#current) throw new Error(`t.expect("${what}") outside a step`);
    if (ok) return;
    const shown = detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    this.#current.failures.push(`${what}${shown}`);
  }

  /** Like expect, but equal by JSON, with what came instead in the failure. */
  expectEqual(actual: unknown, expected: unknown, what: string): void {
    this.expect(JSON.stringify(actual) === JSON.stringify(expected), what, `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
  }

  /** A named screenshot, in shots/<part>/<window>-<theme>-<name>.png, unless --shots says otherwise. */
  async shot(name: string): Promise<void> {
    if (this.#options.shots !== 'key') return;
    await this.page.shot(join(this.#options.out, 'shots', this.#options.part.name, `${this.at}-${slug(name)}.png`));
  }
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'step'
  );
}
