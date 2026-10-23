// Headless Chrome for the app check: found at its standard macOS path or CHROME_PATH, started with a
// throwaway profile and a debugging port the caller passes, and stopped by the PID this process
// started, every time. It's never pointed at a browser it didn't start: the port must be free before
// Chrome starts, and the debugging socket's address is the one this run's own Chrome prints as it
// opens it ("DevTools listening on ..."), on the port passed, so a busy port fails the run rather
// than reaching another browser.
//
// Every host name but the loopback address fails to resolve (--host-resolver-rules), and the
// background services that would reach the network are off, so nothing leaves the machine.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Cdp } from './cdp.js';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** CHROME_PATH, or Chrome at its standard macOS path. Undefined when neither is there. */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const given = env.CHROME_PATH;
  if (given !== undefined && given !== '') return existsSync(given) ? given : undefined;
  return existsSync(MAC_CHROME) ? MAC_CHROME : undefined;
}

export interface Chrome {
  readonly pid: number;
  readonly cdp: Cdp;
  readonly version: string;
  /** Closes the browser, by its PID if it doesn't close, and deletes the profile. Safe to call twice. */
  stop(): Promise<void>;
  /** For process exit, when nothing can be awaited: signals the PID this run started. */
  killNow(): void;
}

export interface LaunchOptions {
  path: string;
  debugPort: number;
  /** A folder to make the throwaway profile in. It's deleted on stop. */
  profileParent: string;
}

const ARGS = [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--disable-breakpad',
  '--metrics-recording-only',
  '--no-pings',
  '--use-mock-keychain',
  '--password-store=basic',
  '--hide-scrollbars',
  '--mute-audio',
  '--force-device-scale-factor=1',
  '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
  // Every name fails to resolve; 127.0.0.1 is an address, not a name, so the fake server still works.
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
];

export async function launchChrome({ path, debugPort, profileParent }: LaunchOptions): Promise<Chrome> {
  await assertFree(debugPort);
  const profile = await mkdtemp(join(profileParent, 'chrome-profile-'));
  const child = spawn(path, [...ARGS, `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let stopping: Promise<void> | undefined;
  const removeProfile = async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(profile, { recursive: true, force: true });
        return;
      } catch {
        await sleep(200);
      }
    }
  };
  const stopProcess = async (cdp: Cdp | undefined) => {
    if (isRunning(child)) {
      if (cdp && !cdp.closed) await cdp.send('Browser.close').catch(() => {});
      if (!(await within(exited, 3000))) child.kill('SIGTERM');
      if (!(await within(exited, 3000))) child.kill('SIGKILL');
      await within(exited, 3000);
    }
    cdp?.close();
    await removeProfile();
  };

  try {
    const url = await devToolsUrl(debugPort, child);
    const cdp = await Cdp.connect(url);
    const { product } = await cdp.send<{ product: string }>('Browser.getVersion');
    return {
      pid: child.pid ?? -1,
      cdp,
      version: product,
      stop: () => (stopping ??= stopProcess(cdp)),
      killNow: () => {
        if (isRunning(child)) child.kill('SIGKILL');
      },
    };
  } catch (error) {
    await stopProcess(undefined);
    throw error;
  }
}

/** Fails when something already listens on the port, so the run never drives a browser it didn't start. */
async function assertFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`port ${port}, for Chrome's debugging socket, is already in use`)));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => probe.close(() => resolve()));
  });
}

/**
 * The browser's DevTools socket, from the line this run's Chrome prints on stderr as it opens it:
 * `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/<id>`. The rest of stderr is drained
 * and dropped, so Chrome never blocks on a full pipe.
 */
function devToolsUrl(debugPort: number, child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = '';
    let found = false;
    const done = (error: Error | undefined, url?: string) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(url!);
    };
    const onExit = () => done(new Error(`Chrome exited (code ${child.exitCode}) before it opened its debugging port`));
    const timer = setTimeout(() => done(new Error(`Chrome didn't open debugging port ${debugPort} within 20 s`)), 20_000);
    child.once('exit', onExit);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (found) return;
      seen += chunk;
      const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/[\w-]+)/.exec(seen);
      if (match) {
        found = true;
        seen = '';
        const port = Number(match[2]);
        if (port !== debugPort) done(new Error(`Chrome opened debugging port ${port}, not ${debugPort}`));
        else done(undefined, match[1]);
      } else if (seen.length > 64 * 1024) seen = seen.slice(-1024);
    });
  });
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function within(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)))]);
  clearTimeout(timer);
  return result;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
