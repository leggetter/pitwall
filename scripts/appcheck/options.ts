// The app check's command line: what to run, where to write, and the ports it may use.
//
//   npm run appcheck -- --out <dir> [--only <parts>] [--skip <parts>] [--widths <list>]
//                       [--themes light,dark] [--ports <from>-<to>] [--web-root <dir>] [--dist <dir>]
//                       [--shots key|failures|none] [--pending] [--bail] [--timeout <minutes>] [--list]
//
// Ports: the harness uses only the ports in --ports, which defaults to DEFAULT_PORTS. It refuses a
// range that holds pitwall's own ports, 4517 and 4518, where a real pitwall may be running.

import { resolve } from 'node:path';

/** A window size the check runs at. The name is what --widths takes and the summary shows. */
export interface Viewport {
  name: string;
  width: number;
  height: number;
}

/** The five windows every part runs at, unless a part says otherwise: four widths, and a short phone. */
export const VIEWPORTS: readonly Viewport[] = [
  { name: '375', width: 375, height: 812 },
  { name: '900', width: 900, height: 900 },
  { name: '1200', width: 1200, height: 900 },
  { name: '1440', width: 1440, height: 900 },
  { name: '375x540', width: 375, height: 540 },
];

export type Theme = 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark'];

/** What --shots keeps: the parts' named screenshots and failures, failures alone, or nothing. */
export type ShotMode = 'key' | 'failures' | 'none';

export interface PortRange {
  from: number;
  to: number;
}

/** The ports the harness uses when --ports isn't given. */
export const DEFAULT_PORTS: PortRange = { from: 5690, to: 5699 };

/** pitwall's default port and the dev one: never inside the range, since a real pitwall may be there. */
const PITWALL_PORTS = [4517, 4518];

export interface Options {
  out: string;
  only: string[] | undefined;
  skip: string[];
  viewports: Viewport[];
  themes: Theme[];
  ports: PortRange;
  /** The built web UI to serve: dist/web by default. Another build, such as a scratch copy's, to see a part fail. */
  webRoot: string;
  /** The server build to import pitwall's security headers, checks and static files from: dist/server. */
  dist: string;
  shots: ShotMode;
  /** Run the parts marked pending too, such as one waiting for its feature to merge. */
  pending: boolean;
  /** Stop at the first failed step. */
  bail: boolean;
  /** The whole run's limit, after which everything is stopped and the run fails. */
  timeoutMs: number;
  list: boolean;
}

export class UsageError extends Error {
  override name = 'UsageError';
}

export const USAGE = `usage: npm run appcheck -- --out <dir> [options]

Runs pitwall's headless app check against the production build. Run npm run build first.

  --out <dir>           where the JSON summary and screenshots go (required)
  --only <parts>        run these parts alone, comma-separated (see --list)
  --skip <parts>        run every part but these
  --widths <list>       windows to run at: 375, 900, 1200, 1440 and 375x540 (default: all five)
  --themes <list>       light, dark or both (default: both)
  --ports <from>-<to>   the only ports the harness may use (default: ${DEFAULT_PORTS.from}-${DEFAULT_PORTS.to}); it needs 2
  --web-root <dir>      the web build to serve (default: dist/web)
  --dist <dir>          the build to import pitwall's server code from (default: dist)
  --shots <mode>        key (default): each part's screenshots and every failure; failures; or none
  --pending             run the parts marked pending too
  --bail                stop at the first failed step
  --timeout <minutes>   stop everything and fail after this long (default: 20)
  --list                list the parts and exit`;

/** Parses argv (without node and the script). Throws UsageError on anything it doesn't accept. */
export function parseOptions(argv: readonly string[], repo: string): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const FLAGS = new Set(['--pending', '--bail', '--list', '--help']);
  const VALUES = new Set(['--out', '--only', '--skip', '--widths', '--themes', '--ports', '--web-root', '--dist', '--shots', '--timeout']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const [name, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (FLAGS.has(name) && inline === undefined) flags.add(name);
    else if (VALUES.has(name)) {
      const value = inline ?? argv[(i += 1)];
      if (value === undefined || value === '') throw new UsageError(`${name} needs a value`);
      values.set(name, value);
    } else throw new UsageError(`unknown option ${arg}`);
  }
  if (flags.has('--help')) throw new UsageError('');

  const list = (name: string) =>
    values
      .get(name)
      ?.split(',')
      .map((each) => each.trim())
      .filter((each) => each !== '');

  const out = values.get('--out');
  if (out === undefined && !flags.has('--list')) throw new UsageError('--out <dir> is required');

  const widths = list('--widths');
  const viewports = widths === undefined ? [...VIEWPORTS] : widths.map((name) => VIEWPORTS.find((each) => each.name === name) ?? fail(`--widths: no window called ${name}`));

  const themes = (list('--themes') ?? [...THEMES]).map((name) => (THEMES as readonly string[]).includes(name) ? (name as Theme) : fail(`--themes: ${name} isn't light or dark`));

  const shots = values.get('--shots') ?? 'key';
  if (shots !== 'key' && shots !== 'failures' && shots !== 'none') throw new UsageError(`--shots: ${shots} isn't key, failures or none`);

  const timeout = Number(values.get('--timeout') ?? 20);
  if (!(timeout > 0)) throw new UsageError('--timeout takes a number of minutes');

  const dist = resolve(values.get('--dist') ?? resolve(repo, 'dist'));
  return {
    out: resolve(out ?? '.'),
    only: list('--only'),
    skip: list('--skip') ?? [],
    viewports: dedupe(viewports),
    themes: dedupe(themes),
    ports: parsePorts(values.get('--ports')),
    webRoot: resolve(values.get('--web-root') ?? resolve(dist, 'web')),
    dist,
    shots,
    pending: flags.has('--pending'),
    bail: flags.has('--bail'),
    timeoutMs: timeout * 60_000,
    list: flags.has('--list'),
  };
}

/** `5690-5699`, inside 1024 to 65535, and never over pitwall's own ports. */
export function parsePorts(value: string | undefined): PortRange {
  if (value === undefined) return DEFAULT_PORTS;
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match) throw new UsageError(`--ports takes a range such as ${DEFAULT_PORTS.from}-${DEFAULT_PORTS.to}`);
  const range = { from: Number(match[1]), to: Number(match[2]) };
  if (range.from < 1024 || range.to > 65535 || range.from > range.to) throw new UsageError(`--ports: ${value} isn't a range inside 1024 to 65535`);
  const clash = PITWALL_PORTS.find((port) => port >= range.from && port <= range.to);
  if (clash !== undefined) throw new UsageError(`--ports: ${value} holds ${clash}, where a real pitwall may be listening`);
  return range;
}

/**
 * Hands out the range's ports in order, and refuses one outside it, so nothing the harness starts or
 * connects to is anywhere else.
 */
export class PortGuard {
  readonly #range: PortRange;
  #next: number;

  constructor(range: PortRange) {
    this.#range = range;
    this.#next = range.from;
  }

  take(what: string): number {
    if (this.#next > this.#range.to) throw new UsageError(`--ports ${this.#range.from}-${this.#range.to} has no port left for ${what}`);
    return this.#next++;
  }

  /** Throws unless `port` is inside the range: called before any connection the harness makes. */
  check(port: number, what: string): void {
    if (!(port >= this.#range.from && port <= this.#range.to)) throw new Error(`${what}: port ${port} is outside ${this.#range.from}-${this.#range.to}`);
  }
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function fail(message: string): never {
  throw new UsageError(message);
}
