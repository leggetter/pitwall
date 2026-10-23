// pitwall's headless app check: the production web UI, served by a fake pitwall server under
// pitwall's own security headers and CSP, driven in headless Chrome through each part's steps, at
// every window and theme asked for. It writes summary.json and screenshots to --out, and exits 1 if
// any step failed, 2 if it couldn't run. See README.md in this folder.
//
//   npm run build && npm run appcheck -- --out <dir>
//
// It stops what it starts, the browser by the PID it started, on success, failure, Ctrl+C or
// --timeout. It never runs `claude`, never reads ~/.claude, a .env or ~/.pitwall, and connects to no
// port outside --ports.

import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultHeadlessShell, findChrome, HEADLESS_SHELL, isHeadlessShell, launchChrome, type Chrome } from './chrome.js';
import { parseOptions, PortGuard, UsageError, USAGE, type Options } from './options.js';
import { Page } from './page.js';
import { BailError, Case, type CaseResult, type Part } from './runner.js';
import { importBuilt, madeUpToken, startFakeServer, type FakeServer } from './server.js';

const HERE = import.meta.dirname;

/** Why the check won't drive Google Chrome on macOS. */
const SILENT_ONLY =
  `appcheck: on macOS, Google Chrome's headless mode plays the system alert sound for every key a page doesn't handle, and the check presses hundreds. ` +
  `It runs in ${HEADLESS_SHELL} instead, which plays none: npm run appcheck:install-shell installs it where the check looks, or set CHROME_PATH to one. ` +
  `See "Chrome on macOS" in scripts/appcheck/README.md.`;
const REPO = resolve(HERE, '..', '..');
const started = Date.now();
const log = (line: string) => console.log(line);

let chrome: Chrome | undefined;
let server: FakeServer | undefined;
let page: Page | undefined;
const cases: CaseResult[] = [];
let summaryContext: { options: Options; parts: Part[]; chromeVersion: string } | undefined;

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2), REPO);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (error.message !== '') console.error(`appcheck: ${error.message}\n`);
    console.error(USAGE);
    return error.message === '' ? 0 : 2;
  }

  const all = await loadParts();
  if (options.list) {
    for (const part of all) log(`${part.name.padEnd(22)} ${part.title}${part.pending ? `\n${''.padEnd(22)} pending: ${part.pending}` : ''}`);
    return 0;
  }
  let parts: Part[];
  try {
    parts = selectParts(all, options);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`appcheck: ${error.message}`);
    return 2;
  }

  const missing = ['server/security.js', 'server/static.js', 'shared/protocol.js'].map((path) => join(options.dist, path)).concat(join(options.webRoot, 'index.html')).filter((path) => !existsSync(path));
  if (missing.length > 0) {
    console.error(`appcheck: no build at ${missing.map((path) => relative(process.cwd(), path)).join(', ')}. Run npm run build first.`);
    return 2;
  }
  warnIfStale(options);

  const chromePath = findChrome();
  if (chromePath === undefined) {
    console.error(`appcheck: no browser at CHROME_PATH, ${defaultHeadlessShell() ?? 'the headless shell path'} or /Applications/Google Chrome.app. Run npm run appcheck:install-shell, or set CHROME_PATH.`);
    return 2;
  }
  if (process.platform === 'darwin' && !isHeadlessShell(chromePath)) {
    console.error(SILENT_ONLY);
    return 2;
  }

  const ports = new PortGuard(options.ports);
  const serverPort = ports.take('the fake server');
  const debugPort = ports.take("Chrome's debugging port");
  await mkdir(options.out, { recursive: true });

  const token = madeUpToken();
  server = await startFakeServer({ port: serverPort, webRoot: options.webRoot, built: await importBuilt(options.dist), token });
  chrome = await launchChrome({ path: chromePath, debugPort, profileParent: options.out });
  if (!chrome.silent) {
    console.error(SILENT_ONLY);
    return 2;
  }
  summaryContext = { options, parts, chromeVersion: chrome.version };
  page = await Page.open(chrome.cdp, server, token, { keys: chrome.silent });

  const windows = (part: Part) => options.viewports.filter((each) => part.viewports === undefined || part.viewports.includes(each.name));
  const total = parts.reduce((sum, part) => sum + windows(part).length * options.themes.length, 0);
  log(`appcheck: ${parts.length} parts, ${total} cases, ${chrome.version} (pid ${chrome.pid}), fake server on port ${serverPort}, debugging port ${debugPort}`);

  try {
    for (const part of parts) {
      for (const theme of options.themes) {
        for (const viewport of windows(part)) {
          const t = new Case({ part, page, server, viewport, theme, out: options.out, shots: options.shots, bail: options.bail, log });
          const caseStarted = Date.now();
          try {
            await part.run(t);
            await t.finish();
          } catch (error) {
            if (error instanceof BailError) throw error;
            // A throw outside any step: the part itself is broken.
            await t.step('runs to the end', () => Promise.reject(error));
          }
          t.result.ms = Date.now() - caseStarted;
          cases.push(t.result);
          if (chrome.cdp.closed) throw new Error("Chrome's debugging connection closed in the middle of the run");
          const failed = t.result.steps.filter((each) => each.status === 'failed').length;
          const skipped = t.result.steps.filter((each) => each.status === 'skipped').length;
          log(`  ${failed > 0 ? 'FAIL' : 'ok  '} ${part.name.padEnd(22)} ${t.at.padEnd(14)} ${String(t.result.steps.length).padStart(3)} steps${failed > 0 ? `, ${failed} failed` : ''}${skipped > 0 ? `, ${skipped} skipped` : ''}  ${(t.result.ms / 1000).toFixed(1)} s`);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof BailError)) throw error;
    log(`appcheck: stopped at the first failure (--bail): ${error.message}`);
  }

  const counts = await writeSummary(undefined);
  log(
    `\n${counts.steps} steps in ${cases.length} cases: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, in ${formatDuration(Date.now() - started)}.` +
      `\nSummary: ${join(options.out, 'summary.json')}${options.shots === 'key' ? `\nScreenshots: ${join(options.out, 'shots')}` : ''}`,
  );
  return counts.failed > 0 || counts.steps === 0 ? 1 : 0;
}

/** Every part in parts/, one per file, by file name. Files starting with `_` are helpers, not parts. */
async function loadParts(): Promise<Part[]> {
  const dir = join(HERE, 'parts');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.ts') && !file.startsWith('_') && !file.endsWith('.d.ts')).sort();
  const parts: Part[] = [];
  for (const file of files) {
    const module = (await import(pathToFileURL(join(dir, file)).href)) as { default?: Part };
    const part = module.default;
    if (!part || typeof part.run !== 'function') throw new Error(`parts/${file} has no default export that is a Part`);
    if (part.name !== basename(file, '.ts')) throw new Error(`parts/${file} names itself ${part.name}: a part's name is its file's`);
    parts.push(part);
  }
  return parts;
}

function selectParts(all: Part[], options: Options): Part[] {
  const names = new Set(all.map((part) => part.name));
  for (const name of [...(options.only ?? []), ...options.skip]) if (!names.has(name)) throw new UsageError(`no part called ${name}; --list lists them`);
  // A pending part runs when it's named in --only, or with --pending.
  return all.filter((part) => (options.only ? options.only.includes(part.name) : !part.pending || options.pending) && !options.skip.includes(part.name));
}

/** Says so when the default build is older than the source, since the check runs against the build. */
function warnIfStale(options: Options) {
  if (options.webRoot !== join(REPO, 'dist', 'web')) return;
  const built = statSync(join(options.webRoot, 'index.html')).mtimeMs;
  const newest = (dir: string): number => {
    let latest = 0;
    for (const entry of readdirSafe(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) latest = Math.max(latest, newest(path));
      else latest = Math.max(latest, statSync(path).mtimeMs);
    }
    return latest;
  };
  if (Math.max(newest(join(REPO, 'web', 'src')), newest(join(REPO, 'src'))) > built) log('appcheck: the build is older than the source. Run npm run build to check what the source says.');
}

function readdirSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function writeSummary(aborted: string | undefined) {
  const steps = cases.flatMap((each) => each.steps);
  const counts = {
    steps: steps.length,
    passed: steps.filter((each) => each.status === 'passed').length,
    failed: steps.filter((each) => each.status === 'failed').length,
    skipped: steps.filter((each) => each.status === 'skipped').length,
  };
  if (!summaryContext) return counts;
  const { options, parts, chromeVersion } = summaryContext;
  const summary = {
    ok: aborted === undefined && counts.failed === 0 && counts.steps > 0,
    ...(aborted === undefined ? {} : { aborted }),
    startedAt: new Date(started).toISOString(),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    chrome: chromeVersion,
    webRoot: options.webRoot,
    windows: options.viewports.map((each) => `${each.name} (${each.width} x ${each.height})`),
    themes: options.themes,
    parts: parts.map((part) => ({ name: part.name, title: part.title, ...(part.pending ? { pending: part.pending } : {}) })),
    ...counts,
    failures: cases.flatMap((each) => each.steps.filter((step) => step.status === 'failed').map((step) => ({ part: each.part, window: each.viewport, theme: each.theme, step: step.name, failures: step.failures, shot: step.shot }))),
    cases,
  };
  await writeFile(join(options.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return counts;
}

let stopping: Promise<void> | undefined;
function stopEverything(): Promise<void> {
  stopping ??= (async () => {
    await page?.close().catch(() => {});
    await chrome?.stop().catch(() => {});
    await server?.close().catch(() => {});
  })();
  return stopping;
}

let aborting = false;
async function abort(reason: string, code: number) {
  // Once: Ctrl+C reaches this process twice, from the terminal and relayed by tsx, and a second
  // signal must not cut the cleanup short.
  if (aborting) return;
  aborting = true;
  log(`\nappcheck: ${reason}. Stopping the browser and the fake server.`);
  // If stopping hangs, the browser this run started is killed by its PID on the way out.
  setTimeout(() => process.exit(code), 15_000).unref();
  await writeSummary(reason).catch(() => {});
  await stopEverything();
  process.exit(code);
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

process.on('SIGINT', () => void abort('interrupted', 130));
process.on('SIGTERM', () => void abort('stopped by SIGTERM', 143));
process.on('SIGHUP', () => void abort('stopped by SIGHUP', 129));
// The last resort, when nothing can be awaited: the browser this run started, by its PID.
process.on('exit', () => chrome?.killNow());

const watchdog = setTimeout(() => void abort('ran past --timeout', 1), parseOptionsTimeout());
main().then(
  async (code) => {
    clearTimeout(watchdog);
    await stopEverything();
    process.exit(code);
  },
  async (error: unknown) => {
    clearTimeout(watchdog);
    // Stopping the browser on a signal makes the run in flight fail; abort() has it in hand.
    if (aborting) return;
    console.error(`appcheck: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    await writeSummary(`couldn't run: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    await stopEverything();
    process.exit(2);
  },
);

/** --timeout, read early for the watchdog; parseOptions checks it properly. */
function parseOptionsTimeout(): number {
  try {
    return parseOptions(process.argv.slice(2), REPO).timeoutMs;
  } catch {
    return 20 * 60_000;
  }
}
