// Clone and start (W107, D25): clone a not-cloned PR's repo into the root that claims its owner, so
// New session can start there. The page names only the repo; everything else is the server's.
//
// POST CLONE_PATH comes after the /api/* checks in server.ts, so it already has the apiKey (never the
// raw token), this server's Origin and its exact Host, as every state-changing request. Then:
//
//   POST CLONE_PATH               body: CloneRequest as JSON           answers: CloneResult
//     201  cloned: { ok: true, cwd, hint? }, `hint` the command that trusts it (trustHint())
//     400  the body isn't a CloneRequest, or the repo's name is one pitwall won't make a directory of
//     404  no PR in the current list is in that repo
//     409  pull requests are off; its PRs aren't placed 'not-cloned'; the root isn't one of the
//          snapshot's, or isn't a directory at its own real path; the target exists, or appeared
//          while it cloned; or a clone of it is already running
//     413  the body is over 4 KiB;  415  it isn't application/json
//     429  another clone is running, or CLONE_RATE's limit. Retry-After is set
//     502  gh isn't installed, isn't logged in, or failed;  503  no snapshot yet;  504  it took too long
//
// What's checked, in order, and why:
//
//   the repo     `owner/name`, by GITHUB_OWNER_PATTERN and GITHUB_REPO_NAME_PATTERN, compared with the
//                list's lowercase PullRequestSummary.repo. Only a repo with a PR in the list the
//                server has now, placed 'not-cloned' (W105), is cloned, so a page can't name any
//                other: the list is from gh's own searches, of your PRs, those asking your review and
//                those mentioning you
//   the root     the place's, never the request's, and only while the snapshot lists it as a root and
//                it's a directory at its own real path; never your home folder or a folder above it
//                (W108's finding): a root at `~`, which the config file allows, would let a clone make
//                `~/bin`, which Ubuntu's default profile puts on PATH, or `~/Applications`, where
//                editors.ts looks for editors' bundles
//   the name     GitHub's spelling of the repo's name (repoLabel), as `gh repo clone` would name the
//                directory; refused when it's `.`, `..` or starts with `.`, which would be the root, its
//                parent or a hidden directory pitwall's discovery and New session's list skip
//   the target   `<root>/<name>`, which must not exist as anything, a broken symlink included (lstat)
//
// How it clones: `gh repo clone <owner>/<name> <temp>/<name> -- --quiet`, gh's documented form, with
// gh's own login, so a private repo works and pitwall never sees GitHub's token. Through the index's
// runFile: no shell, stdin and stderr ignored, childEnvironment(), plus ghEnvironment()'s
// GH_PROMPT_DISABLED, GH_HOST=github.com and GIT_TERMINAL_PROMPT=0, in a process group of its own
// (processGroup), so it has no controlling terminal, nothing in it can prompt in pitwall's, and a
// timeout stops gh's git too. `<temp>` is a fresh `mkdtemp(<root>/.pitwall-clone-)`, in the root so the rename stays on one
// file system, and hidden, so nothing lists it. gh's output is never shown: what failed is said in
// pitwall's words.
//
// Into place: mkdir(<root>/<name>), which fails if anything is there now, claims the name; then
// rename(<temp>/<name>, <root>/<name>), which replaces only that empty directory pitwall just made.
// So a target that appears after the lstat, the rename race, is never overwritten: mkdir fails, or,
// if something was put inside the claimed directory meanwhile, rename does, and the claimed directory
// is removed only with rmdir, which removes it only while it's empty.
//
// Removals: only the temp directory this request made, recursively, and only after checking that
// it's directly in the root and named CLONE_TEMP_PREFIX + mkdtemp's suffix (ownTempDir()); and the
// claimed target with rmdir, only while empty. On a timeout or a signal, the temp directory is
// removed again a moment later, in case gh's git was still writing to it when it was stopped.
//
// Shutting down (close(), from the server's): gh and git run in a session of their own, so Ctrl-C or
// closing pitwall's terminal never reaches them. close() aborts a clone that's running, which sends
// its whole group SIGTERM (runFile's `signal`), then SIGKILL 2 s later to whatever is left of it,
// waits until gh has exited and nothing in its group is left, 2.5 s at most, and removes the temp
// directory.
// A pitwall killed outright can't, so start() sweeps, once, with the first snapshot's roots: a direct
// child of a root, by its real path, named as ownTempDir() says, a real directory (lstat, never a
// symlink) owned by this user, whose own time and its entries' are all older than CLONE_TIMEOUT_MS
// and CLONE_SWEEP_MARGIN_MS, so another pitwall's clone in progress is left alone.
//
// gh runs in a 0700 directory of pitwall's own, a fresh `mkdtemp(<tmpdir>/pitwall-gh-)` removed after,
// never the shared temp directory itself, and without the GIT_* variables that would put the clone
// somewhere else (gitEnvironment(), with the GIT_CONFIG_* ones and GIT_TEMPLATE_DIR too).

import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { RunError, runFile as realRunFile, type RunFile } from '../index/exec.js';
import { gitEnvironment } from '../index/grouping.js';
import type { Indexer } from '../index/index.js';
import { GH_CWD_PREFIX, GH_EXIT_AUTH, ghEnvironment } from '../prs/fetch.js';
import type { PrSource } from '../prs/index.js';
import {
  CLONE_PATH,
  CLONE_RATE,
  CLONE_TEMP_PREFIX,
  CLONE_TIMEOUT_MS,
  GITHUB_OWNER_PATTERN,
  GITHUB_REPO_NAME_PATTERN,
  type CloneResult,
  type PullRequestList,
} from '../shared/protocol.js';
import { RateWindow, trustHint } from './actions.js';

/** The largest body accepted: `{"repo":"<owner>/<name>"}` is at most about 220 bytes. */
export const MAX_CLONE_BODY_BYTES = 4 * 1024;

/** How long after a stopped clone the temp directory is removed again. */
export const CLONE_SWEEP_AGAIN_MS = 10_000;

/** How much older than CLONE_TIMEOUT_MS a temp directory must be before start() sweeps it. */
export const CLONE_SWEEP_MARGIN_MS = 5 * 60_000;

const REPO = new RegExp(`^(${GITHUB_OWNER_PATTERN})/(${GITHUB_REPO_NAME_PATTERN})$`);
const NAME = new RegExp(`^${GITHUB_REPO_NAME_PATTERN}$`);

/** The file system calls a clone makes. Tests pass wrapped ones, as for the rename race. */
export interface CloneFs {
  readdir: typeof readdir;
  lstat: typeof lstat;
  stat: typeof stat;
  realpath: typeof realpath;
  mkdtemp: typeof mkdtemp;
  mkdir: typeof mkdir;
  rename: typeof rename;
  rm: typeof rm;
  rmdir: typeof rmdir;
}

const realFs: CloneFs = { readdir, lstat, stat, realpath, mkdtemp, mkdir, rename, rm, rmdir };

export interface CloneOptions {
  /** Default the index's runFile. Tests pass a fake, so they never run gh. */
  runFile?: RunFile;
  /** Default `gh`, found on the child's PATH. */
  ghBin?: string;
  /** What gh's environment is made from, before runFile scrubs it. Default process.env, read per call. */
  env?: NodeJS.ProcessEnv;
  /** Default CLONE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Default CLONE_RATE. */
  rate?: { max: number; windowMs: number };
  /** Milliseconds since the epoch, for the rate. Default Date.now. */
  now?: () => number;
  /** Default the real fs/promises calls. */
  fs?: CloneFs;
  /** Schedules the second removal after a stopped clone. Default an unref'd setTimeout. */
  later?: (callback: () => void, ms: number) => void;
  /** The user start()'s sweep removes temp directories of. Default process.getuid(); none, as on Windows, sweeps nothing. */
  uid?: number | undefined;
  /** The system's temp directory, where gh's own working directory goes. Default os.tmpdir(). */
  tmpdir?: string;
  /** Your home folder, which no clone goes into, nor into a folder above it. Default os.homedir(), read per request. */
  home?: string;
}

/** What a clone will do, from a request that passed every check that needs no disk. */
export interface ClonePlan {
  /** `owner/name` as GitHub spells it, for gh. */
  slug: string;
  /** The directory's name, GitHub's spelling of the repo's. */
  name: string;
  /** The real-path root the place names. */
  root: string;
  /** `<root>/<name>`. */
  target: string;
}

export type PlanResult = { ok: true; plan: ClonePlan } | { ok: false; status: 400 | 404 | 409; error: string };

/** True when `root` is `home` or a folder above it, both real paths. */
export function holdsHome(root: string, home: string): boolean {
  const relative = path.relative(root, home);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Why pitwall doesn't clone into `root`, which is your home folder or holds it (W108's finding): a
 * clone there could make a folder that changes what runs, `~/bin` or `~/Applications`.
 */
export function homeRefusal(root: string, home: string): string {
  const where = root === home ? 'your home folder' : `${root}, which holds your home folder`;
  return `pitwall doesn't clone into ${where}: a new folder there could be ~/bin, which some shells' profiles put on PATH, or ~/Applications, where pitwall looks for editors. Give a folder inside your home folder this owner in pitwall's config file, or clone it yourself.`;
}

/** Why a name can't be a directory pitwall makes, or undefined when it can. */
export function unsafeName(name: string): string | undefined {
  if (!NAME.test(name)) return 'Its name has characters a GitHub repo name never has.';
  if (name === '.' || name === '..') return `Its name is "${name}", which isn't a directory pitwall can make.`;
  if (name.startsWith('.')) return 'Its name starts with ".", which would make a hidden directory that pitwall doesn’t list.';
  return undefined;
}

/**
 * What cloning `body`'s repo would do, from the current PR list and the snapshot's roots alone: the
 * repo must have a PR in the list placed 'not-cloned', for a root the snapshot lists. Pure.
 */
export function planClone(body: unknown, list: PullRequestList, roots: readonly string[]): PlanResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse(400, 'The body must be a JSON object.');
  const { repo } = body as Record<string, unknown>;
  if (typeof repo !== 'string' || !REPO.test(repo)) return refuse(400, 'The repo must be owner/name, as GitHub names it.');
  const key = repo.toLowerCase();
  const prs = list.prs.filter((pr) => pr.repo === key);
  if (prs.length === 0) return refuse(404, `${repo} isn't the repo of any of your open pull requests that pitwall lists.`);
  const cloned = prs.find((pr) => pr.place?.kind === 'cloned');
  if (cloned?.place?.kind === 'cloned') return refuse(409, `${cloned.repoLabel} is cloned already, at ${cloned.place.key}.`);
  const pr = prs.find((each) => each.place?.kind === 'not-cloned');
  if (pr === undefined || pr.place?.kind !== 'not-cloned') {
    return refuse(409, `No root claims ${repo}'s owner, so pitwall doesn't know where to clone it. The README's Configuration section says how to give a root its owners.`);
  }
  const root = pr.place.root;
  if (!roots.includes(root)) return refuse(409, `${root} isn't one of pitwall's roots now, so pitwall didn't clone into it.`);
  // GitHub's spelling, which the list's reader checked against the same patterns (src/prs/parse.ts).
  const match = REPO.exec(pr.repoLabel);
  if (!match || pr.repoLabel.toLowerCase() !== key) return refuse(409, `pitwall can't tell how GitHub spells ${repo}, so it didn't clone it.`);
  const name = match[2] as string;
  const why = unsafeName(name);
  if (why !== undefined) return refuse(400, `pitwall doesn't clone ${pr.repoLabel}. ${why}`);
  return { ok: true, plan: { slug: pr.repoLabel, name, root, target: path.join(root, name) } };
}

function refuse<S extends 400 | 404 | 409>(status: S, error: string): { ok: false; status: S; error: string } {
  return { ok: false, status, error };
}

/** gh's arguments: its documented `gh repo clone <repository> [<directory>] [-- <gitflags>...]`. */
export function cloneArgs(slug: string, dir: string): string[] {
  return ['repo', 'clone', slug, dir, '--', '--quiet'];
}

/**
 * The environment gh starts from: ghEnvironment()'s; `GH_HOST=github.com`, since the PR list is
 * github.com's (the searches' `--hostname github.com`) and an `owner/name` would otherwise go to gh's
 * default host, which GH_HOST or gh's config can make an Enterprise one; and git never asking for a
 * username or password. gh's own `git_protocol`, https or ssh, still decides how it clones.
 */
export function cloneEnvironment(env: NodeJS.ProcessEnv, tmpdir: string = os.tmpdir()): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...gitEnvironment(ghEnvironment(env, tmpdir)), GH_HOST: 'github.com', GIT_TERMINAL_PROMPT: '0' };
  // Configuration from the environment can redirect a repository too (core.worktree), and a template
  // directory installs hooks into the new clone: the clone takes only the user's own config files.
  for (const name of Object.keys(result)) {
    if (name === 'GIT_TEMPLATE_DIR' || name === 'GIT_CONFIG_PARAMETERS' || name === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete result[name];
  }
  return result;
}

/** Whether `dir` is a temp directory a clone makes: directly in `root`, named CLONE_TEMP_PREFIX and mkdtemp's six characters. */
export function ownTempDir(dir: string, root: string): boolean {
  return path.dirname(dir) === root && new RegExp(`^${CLONE_TEMP_PREFIX.replace(/[.]/g, '\\.')}[A-Za-z0-9]{6}$`).test(path.basename(dir));
}

/** What a failed gh says, in pitwall's words (D25): never gh's output, which runFile never reads. */
export function cloneFailure(error: unknown, slug: string, timeoutMs: number): { status: 502 | 503 | 504; error: string } {
  if (error instanceof RunError) {
    if (error.reason === 'aborted') return { status: 503, error: `pitwall is shutting down, so it stopped the clone of ${slug} and removed what it had cloned.` };
    if (error.reason === 'not-found') return { status: 502, error: "gh, GitHub's CLI, isn't installed or isn't on pitwall's PATH. Install it from https://cli.github.com, run gh auth login, then try again." };
    if (error.reason === 'exit' && error.exitCode === GH_EXIT_AUTH) return { status: 502, error: "gh isn't logged in to github.com. Run gh auth login, then try again." };
    if (error.reason === 'timeout') return { status: 504, error: `The clone of ${slug} didn't finish within ${Math.round(timeoutMs / 60_000)} minutes, so pitwall stopped it and removed what it had cloned.` };
    if (error.reason === 'exit') {
      return {
        status: 502,
        error: `gh couldn't clone ${slug}${error.exitCode === undefined ? '' : ` (exit code ${error.exitCode})`}. Check that you can open it on GitHub and that gh auth status works, then try again.`,
      };
    }
  }
  return { status: 502, error: `gh couldn't be run to clone ${slug}. Try again in a moment.` };
}

const code = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

/** Clone and start's route, with what it does at the server's start and close. */
export interface CloneRoute {
  /** Adds POST CLONE_PATH. Call it after the /api/* checks and before the catch-all, as server.ts's routes do. */
  register(app: Hono): void;
  /** Once, with the first snapshot's roots: removes temp directories a pitwall that was killed left (see the top of this file). */
  start(): void;
  /** Stops a clone that's running, its whole group, removes its temp directory, and refuses new ones with 503. */
  close(): Promise<void>;
}

/**
 * Clone and start's route. `prs` is the server's PR source, whose latest list decides what may be
 * cloned; `indexer` gives the roots.
 */
export function createCloneRoute(indexer: Pick<Indexer, 'latest'>, prs: Pick<PrSource, 'latest' | 'rediscover'>, options: CloneOptions = {}): CloneRoute {
  const run = options.runFile ?? realRunFile;
  const fs = options.fs ?? realFs;
  const timeoutMs = options.timeoutMs ?? CLONE_TIMEOUT_MS;
  const rate = new RateWindow(options.rate ?? CLONE_RATE, options.now ?? Date.now);
  const later =
    options.later ??
    ((callback: () => void, ms: number) => {
      setTimeout(callback, ms).unref();
    });
  const now = options.now ?? Date.now;
  const tmp = options.tmpdir ?? os.tmpdir();

  /** Your home folder's real path, or as given when it can't be resolved; undefined when there's none to be found. */
  const homeFolder = async (): Promise<string | undefined> => {
    let home: string;
    try {
      home = options.home ?? os.homedir();
    } catch {
      return undefined;
    }
    if (!path.isAbsolute(home)) return undefined;
    try {
      return await fs.realpath(home);
    } catch {
      return path.resolve(home);
    }
  };
  // One clone at a time, and which repo it is.
  let cloning: string | undefined;
  // The clone running now: how to stop it, its temp directory, and when it has finished, cleaned up.
  let active: { controller: AbortController; temp?: string; finished: Promise<void> } | undefined;
  let closed = false;
  let started = false;
  let sweeping: Promise<void> = Promise.resolve();
  let waiting: NodeJS.Timeout | undefined;

  const answer = (c: Context, result: CloneResult, status: 201 | 400 | 404 | 409 | 413 | 415 | 429 | 502 | 503 | 504) => {
    c.header('Cache-Control', 'no-store');
    return c.json(result, status);
  };

  /** Removes this request's temp directory, and only that. Never throws. */
  const removeTemp = async (dir: string, root: string) => {
    if (!ownTempDir(dir, root)) return;
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Left behind: hidden, so nothing lists it, and named so it's plainly pitwall's. start() sweeps it later.
    }
  };

  /** gh's working directory, pitwall's own and empty: removed only when it's that. Never throws. */
  const removeGhCwd = async (dir: string) => {
    if (path.dirname(dir) !== tmp || !new RegExp(`^${GH_CWD_PREFIX}[A-Za-z0-9]{6}$`).test(path.basename(dir))) return;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  /** The newest of a directory's own time and its entries', or undefined when it can't be read. */
  const newestIn = async (dir: string, own: number): Promise<number | undefined> => {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return undefined;
    }
    let newest = own;
    for (const name of names) {
      try {
        newest = Math.max(newest, (await fs.lstat(path.join(dir, name))).mtimeMs);
      } catch {
        return undefined;
      }
    }
    return newest;
  };

  /** Removes the temp directories a pitwall that was killed left in `roots` (see the top of this file). Never throws. */
  const sweep = async (roots: readonly string[]) => {
    const uid = 'uid' in options ? options.uid : process.getuid?.();
    if (uid === undefined) return;
    for (const root of roots) {
      let names: string[];
      try {
        if ((await fs.realpath(root)) !== root) continue;
        names = await fs.readdir(root);
      } catch {
        continue;
      }
      for (const name of names) {
        const dir = path.join(root, name);
        if (!ownTempDir(dir, root) || dir === active?.temp) continue;
        try {
          const stats = await fs.lstat(dir);
          if (stats.isSymbolicLink() || !stats.isDirectory() || stats.uid !== uid) continue;
          const newest = await newestIn(dir, stats.mtimeMs);
          if (newest === undefined || now() - newest < CLONE_TIMEOUT_MS + CLONE_SWEEP_MARGIN_MS) continue;
          await fs.rm(dir, { recursive: true, force: true });
        } catch {
          // Left for the next start.
        }
      }
    }
  };

  const register = (app: Hono) => app.post(
    CLONE_PATH,
    bodyLimit({ maxSize: MAX_CLONE_BODY_BYTES, onError: (c) => answer(c, { ok: false, error: 'The request is too large.' }, 413) }),
    async (c) => {
      if (!/^application\/json\s*(;|$)/i.test(c.req.header('content-type') ?? '')) return answer(c, { ok: false, error: 'Send the request as application/json.' }, 415);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return answer(c, { ok: false, error: "The body isn't valid JSON." }, 400);
      }
      const list = prs.latest();
      if (!list.source.ok && list.source.reason === 'off') {
        return answer(c, { ok: false, error: 'Pull requests are off: pitwall was started with --no-prs, so it never runs gh.' }, 409);
      }
      const snapshot = indexer.latest();
      if (!snapshot) return answer(c, { ok: false, error: "pitwall hasn't listed the sessions yet. Try again in a moment." }, 503);
      const planned = planClone(body, list, snapshot.roots);
      if (!planned.ok) return answer(c, { ok: false, error: planned.error }, planned.status);
      const { slug, name, root, target } = planned.plan;

      // Synchronous from the plan to taking the one clone's place, so two requests can't both pass.
      if (closed) return answer(c, { ok: false, error: 'pitwall is shutting down.' }, 503);
      if (cloning !== undefined) {
        c.header('Retry-After', '5');
        return cloning === slug.toLowerCase()
          ? answer(c, { ok: false, error: `pitwall is already cloning ${slug}.` }, 409)
          : answer(c, { ok: false, error: `pitwall is cloning ${cloning} now, and clones one repo at a time. Try again once it's done.` }, 429);
      }
      cloning = slug.toLowerCase();
      let temp: string | undefined;
      let ghCwd: string | undefined;
      let finish: () => void = () => {};
      const current: NonNullable<typeof active> = { controller: new AbortController(), finished: new Promise<void>((resolve) => (finish = resolve)) };
      active = current;
      try {
        // The root, as it is now: a directory at its own real path, so nothing redirects the clone.
        try {
          if ((await fs.realpath(root)) !== root || !(await fs.stat(root)).isDirectory()) {
            return answer(c, { ok: false, error: `${root} isn't a directory at its own path now, so pitwall didn't clone into it.` }, 409);
          }
        } catch {
          return answer(c, { ok: false, error: `${root} can't be read, so pitwall didn't clone into it.` }, 409);
        }
        // Not your home folder, nor one above it, by real paths, as the roots are. A home folder pitwall
        // can't find refuses every clone: it can't tell.
        const home = await homeFolder();
        if (home === undefined) return answer(c, { ok: false, error: "pitwall can't tell where your home folder is, so it doesn't clone: it never clones into your home folder or a folder above it." }, 409);
        if (holdsHome(root, home)) return answer(c, { ok: false, error: homeRefusal(root, home) }, 409);
        try {
          await fs.lstat(target);
          return answer(c, { ok: false, error: `${target} already exists, so pitwall didn't clone into it. If it's a clone of ${slug}, start a session there with New session.` }, 409);
        } catch (error) {
          if (code(error) !== 'ENOENT') return answer(c, { ok: false, error: `${target} can't be checked, so pitwall didn't clone into it.` }, 409);
        }

        // Counted only now, so a request refused above takes none of the minute's clones.
        const taken = rate.take();
        if (!taken.ok) {
          c.header('Retry-After', String(taken.retryAfterSeconds));
          return answer(c, { ok: false, error: `pitwall clones at most ${rate.rate.max} repos a minute. Try again in ${taken.retryAfterSeconds}s.` }, 429);
        }
        temp = await fs.mkdtemp(path.join(root, CLONE_TEMP_PREFIX));
        current.temp = temp;
        const into = path.join(temp, name);
        // gh's working directory: its own, 0700 as mkdtemp makes it, not the shared temp directory.
        ghCwd = await fs.mkdtemp(path.join(tmp, GH_CWD_PREFIX));
        try {
          await run(options.ghBin ?? 'gh', cloneArgs(slug, into), {
            cwd: ghCwd,
            timeoutMs,
            env: cloneEnvironment(options.env ?? process.env, tmp),
            maxStdoutBytes: 1024 * 1024,
            processGroup: true,
            signal: current.controller.signal,
          });
        } catch (error) {
          const failed = cloneFailure(error, slug, timeoutMs);
          // gh's git may still be finishing a write as it stops: removed now, and again a moment later.
          if (error instanceof RunError && (error.reason === 'timeout' || error.reason === 'signal')) {
            const again = temp;
            later(() => void removeTemp(again, root), CLONE_SWEEP_AGAIN_MS);
          }
          return answer(c, { ok: false, error: failed.error }, failed.status);
        }
        try {
          if (!(await fs.lstat(path.join(into, '.git'))).isDirectory()) throw new Error('not a clone');
        } catch {
          return answer(c, { ok: false, error: `gh finished, but left no clone of ${slug}, so pitwall removed what it made.` }, 502);
        }

        // Claimed: mkdir fails if anything is at the target now, however it got there.
        try {
          await fs.mkdir(target);
        } catch (error) {
          return answer(
            c,
            {
              ok: false,
              error:
                code(error) === 'EEXIST'
                  ? `${target} appeared while pitwall was cloning, so pitwall left it alone and removed its own clone.`
                  : `${target} couldn't be made, so pitwall removed its clone.`,
            },
            409,
          );
        }
        try {
          // Replaces only the empty directory just made.
          await fs.rename(into, target);
        } catch {
          // Something was put in the claimed directory meanwhile, or the rename failed: the directory goes only while empty.
          await fs.rmdir(target).catch(() => {});
          return answer(c, { ok: false, error: `${target} changed while pitwall was moving its clone there, so pitwall left it alone and removed its own clone.` }, 409);
        }
        prs.rediscover?.();
        const hint = trustHint(target);
        return answer(c, hint === undefined ? { ok: true, cwd: target } : { ok: true, cwd: target, hint }, 201);
      } catch {
        return answer(c, { ok: false, error: `pitwall couldn't clone ${slug} into ${root}.` }, 502);
      } finally {
        if (temp !== undefined) await removeTemp(temp, root);
        if (ghCwd !== undefined) await removeGhCwd(ghCwd);
        cloning = undefined;
        active = undefined;
        finish();
      }
    },
  );

  return {
    register,
    start() {
      if (started) return;
      started = true;
      // The first snapshot's roots, looked for once a second, so the index's listeners are its clients' alone.
      const attempt = () => {
        waiting = undefined;
        if (closed) return;
        const snapshot = indexer.latest();
        if (snapshot) {
          sweeping = sweep(snapshot.roots);
          return;
        }
        waiting = setTimeout(attempt, 1000);
        waiting.unref();
      };
      attempt();
    },
    async close() {
      closed = true;
      clearTimeout(waiting);
      const running = active;
      running?.controller.abort();
      await Promise.all([running?.finished, sweeping]);
    },
  };
}
