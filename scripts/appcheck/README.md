# The app check

A headless check of pitwall's whole web UI. It drives the production build in headless Chrome through the main flows, at five window sizes in both themes, and fails on anything wrong.

It serves the build from a fake pitwall server and uses made-up sessions, so it never needs Claude Code, a real session or a token.

```
npm run appcheck:install-shell      once: the browser it runs in on macOS (see Chrome on macOS)
npm run build
npm run appcheck -- --out scratch/appcheck
```

`scratch/` is gitignored, so it's a good place for the output.

- **What it writes:** `<dir>/summary.json`, with every step's pass or fail, and screenshots.
  - `<dir>/shots/<part>/` holds each part's named screenshots.
  - `<dir>/failures/<part>/` holds a screenshot of the page as each failed step left it.
- **Exit code:** 0 when every step passed, 1 when any failed, 2 when it couldn't run, such as with no build or no Chrome.
- **Time:** about 9 minutes for a full run, 16 parts in 160 cases and about 1,380 steps, on the Mac it was written on (W95). One part at one size takes seconds.

## Running part of it

```
npm run appcheck -- --list                                   the parts, and what each checks
npm run appcheck -- --out <dir> --only terminal              one part
npm run appcheck -- --out <dir> --only links,lists --widths 375,1440 --themes dark
npm run appcheck -- --out <dir> --skip new-session-selected
npm run appcheck -- --out <dir> --bail                       stop at the first failed step
```

| Option | What it does |
| --- | --- |
| `--out <dir>` | Where the summary and screenshots go. Required |
| `--only`, `--skip` | Parts by name, comma-separated |
| `--widths` | Any of `375` (375 × 812), `900`, `1200`, `1440` (each × 900) and `375x540`. All five by default |
| `--themes` | `light`, `dark`, or both, the default |
| `--ports <from>-<to>` | The only ports it may use, 5690-5699 by default. It needs two: the fake server's, then Chrome's debugging port |
| `--web-root <dir>` | Another web build to serve, such as a scratch copy's, to see a part fail. `dist/web` by default |
| `--dist <dir>` | The build to import pitwall's server code from. `dist` by default |
| `--shots key\|failures\|none` | Every named screenshot and each failure's (the default), failures alone, or none |
| `--pending` | Also run the parts marked pending |
| `--timeout <minutes>` | Stop everything and fail after this long. 20 by default |

**The browser:** `CHROME_PATH`, when it's set. Otherwise `chrome-headless-shell` where `npm run appcheck:install-shell` puts it, `~/.cache/pitwall/chrome-headless-shell/155.0.8059.39/`. Otherwise `/Applications/Google Chrome.app`, which on macOS it then refuses, as the next section says.

## Chrome on macOS

On macOS the check runs only in `chrome-headless-shell`, and refuses Google Chrome.

- **Why:** Google Chrome's headless mode (`--headless=new`) is the whole browser without windows. On macOS it plays the system alert sound for every key a page doesn't handle, as a window would.
  - The check presses hundreds of those on purpose, such as Enter after a reload, to show that the key reaches no session.
  - Its first runs made the Mac they ran on chime about 40 times a run.
- **The fix:** `chrome-headless-shell` is Chrome's old headless mode as a binary of its own, and plays none.
  - In a probe, one Enter in Google Chrome played one alert sound, and the same Enter in the shell played none.
- **How it refuses:**
  - Before starting anything, it exits 2 unless the browser's file is `chrome-headless-shell`.
  - After starting it, it checks that the browser calls itself `HeadlessChrome`.
  - The tab refuses to press a key otherwise.
  - Off macOS, Google Chrome is fine.
- **Getting it:** `npm run appcheck:install-shell` runs `install-headless-shell.sh`. It isn't an npm dependency.
  - It downloads one pinned build from Chrome for Testing, `155.0.8059.39`, published 2026-10-06. That was the newest at least 14 days old on 2026-10-23, as the repo's rule for dependencies asks.
  - It checks the zip's MD5 against the one Google's bucket gives, and unpacks it to `~/.cache/pitwall/chrome-headless-shell/155.0.8059.39/`, where the check looks for it.
  - It covers Apple silicon and Intel Macs, and x64 Linux.
- **What it costs:** a 102 MB download (108 MB on an Intel Mac) and 201 MB on disk. It's a second browser beside your Chrome, on the same Blink, in Chrome's old headless mode.
  - It isn't updated by itself. To bump it, change the version and hashes in `install-headless-shell.sh` and `HEADLESS_SHELL_VERSION` in `chrome.ts` together, to a build at least 14 days old.

## How it works

| File | What it does |
| --- | --- |
| `appcheck.ts` | Runs the run: options, the build and Chrome checks, then each part at each window and theme, the summary, and stopping everything |
| `options.ts` | The command line, the windows, and the port range |
| `server.ts` | The fake pitwall server |
| `fixtures.ts` | The made-up sessions, conversations and links it serves |
| `chrome.ts` | Finds, starts and stops headless Chrome, and says whether it's the silent one |
| `install-headless-shell.sh` | Installs the pinned `chrome-headless-shell`, for `npm run appcheck:install-shell` |
| `cdp.ts` | A small DevTools Protocol client over `ws` |
| `page.ts` | One tab, driven as a person would, gathering everything the page does wrong |
| `runner.ts` | Parts, cases and steps, and what makes a step pass |
| `parts/*.ts` | One part per area of the app |
| `parts/_dom.ts` | What the parts share: how to find pitwall's elements, and moves several parts make |

**The fake server** serves `dist/web` as pitwall does. Its security code is imported from the build (`dist/server/security.js`, `static.js` and `dist/shared/protocol.js`), never copied, so a change there is what the check sees:

- the security headers and CSP on every response;
- the `Host` check, then the `Origin` and bearer checks on `/api/*`, and the apiKey and `Origin` that state-changing requests need;
- the static file rules;
- the v3 challenge on `/ws` and `/attach`, with a proof bound to the server's origin.

Behind those it answers from `fixtures.ts`:

- the snapshot, over the socket and from `/api/snapshot`;
- conversation pages;
- the relay, which answers `delivered` after 400 ms;
- attach, with a made-up terminal screen that fills the terminal at the size the page gives it, as Claude Code's does: a prompt box across every column, and a footer pinned to the last row that ends in the last column (`FOOTER_END`). It's drawn again on each resize, as Claude Code redraws;
- spawn, whose session is listed 800 ms later, as the index lists one on a later poll;
- stop and remove;
- the editor list, both VS Code and Cursor, and open in an editor (W72), with pitwall's checks on the body and the directory, which records each open and opens nothing; an open of `OPEN_LIMITED`'s directory (`running2`) gets 429 with `Retry-After`, past the opens a minute (W87);
- resume, for the ended sessions (W67), chosen by each one's name in `NAMES`, with the status and words pitwall's own resume route gives (W66, `src/server/actions.ts`): `ended` resumes, and is listed 800 ms later as a running background session under the same id; `endedAsked` gets 422, Claude Code's "Workspace not trusted" line with the command that trusts the directory, or, once a step has moved it to a directory whose path has a `'` (`world.move()`), the line with no command (W87); `endedCopy` gets 409 with `copyShortId`, a copy started instead; `endedBusy` gets 429 with `Retry-After`; `endedRefused` gets 409, running again; `endedSlow` gets 504, `claude --resume` too slow; and `endedNoAnswer` gets no answer at all, the connection closed. `resumeOrder` turns two of them around for the steps that check the other order, until the next reset: with `listedFirst`, `ended` is listed first and answered 800 ms later; with `copyReopens`, 800 ms after `endedCopy`'s 409, the original is listed as running in its terminal again.

- New session's uploads (W82), at `ATTACHMENTS_PATH`, with the checks the contract gives W79's route: 415 for a type not in `ATTACHMENT_TYPES`, a `Content-Encoding` other than `identity`, an image or a PDF whose first bytes aren't that type's, or text that isn't UTF-8 with no NUL; 400 for a name it refuses or an empty file; 413 past 10 MiB; 429 past 30 unused uploads. A name starting `pitwall-test-slow` is answered after 1.2 s, so a step can see an upload on its way and Remove it; one starting `pitwall-test-fail` gets a 500 the first time it's sent; one starting `pitwall-test-unavailable` a 503, as from a pitwall that keeps no attachments; and one starting `pitwall-test-stalled` a 408, as for an upload that stalls (Chrome sends a request again, a few times, when a reused connection answers 408). Its order and statuses follow W79's route, `src/server/attachments.ts`, and a 429 has `Retry-After`. It keeps each file's name, type and size, never its bytes. `DELETE attachmentPath(id)` removes an unused one, 204, or answers 404 for an id it doesn't know and 409 for one a spawn used. Spawn takes `attachments`, ids it kept that no spawn has used, each once, or answers 400.

- End session (W90), at `endSessionPath(id)`, with the server's body check, `{}` or `{ whileWorking: true }`, and its words (`src/server/end.ts`), chosen by the session's name: `END_WORKING` (`waiting`) gets 409 with `working: { turn: 'running' }` and `END_SUBAGENTS` (`inApi`) 409 with `working: { subagents: 2 }`, each until it's sent `whileWorking`; `END_REFUSED` (`conversation`) gets 409, its process changed while pitwall checked it; `END_LIMITED` (`fromRoot`) gets 429 with `Retry-After`, past 5 ends a minute; any other running interactive session ends, answered 300 ms later, and is listed as ended 800 ms after that (W67). It signals nothing.

- your made-up open pull requests (W95), `PRS` in `fixtures.ts`, in made-up repos and public-looking ones with invented titles, covering every state, two of them older than 90 days, and some sessions' links to them of each kind, and three that aren't yours (W101): one asking your review by name, one asking it of a made-up team, `PR_TEAM`, and one that mentions you. `GET PRS_PATH`, the `'prs'` message right after the first snapshot, and `POST PRS_REFRESH_PATH`, recorded in `refreshes`, which answers as W93's route does, in its order: 409 with pull requests off, 200 while a fetch runs, 429 with `Retry-After` within a minute (`PRS_REFRESH_MIN_MS`, W100) of the latest fetch's start, and otherwise 200, sending the list refreshing, then fetched 700 ms later. `t.fresh({ prs })`, or `world.setPrs()` then `broadcastPrs()`, puts the source in a state: `ok`, `mine`, the list with only your own, as once you've reviewed each one asked, `partial`, your own search worked and the other two failed, one kept from two hours ago and one never listed, `loading`, `off`, `gh-missing`, `gh-auth`, `error`, or `stale`, a failed fetch that keeps a list two hours old.

- a session's sub-agents and each one's transcript (W77): `inApi` has five, in `SUBAGENTS`, two running, one of them started by the other, then done, failed and stopped ones, and its conversation names them; every other session has none. `drafting`'s transcript has a page behind Load earlier, and a cursor the fake server doesn't know gets 410.

It records what the page sent, such as attaches, keys typed into a terminal, the sizes it gave each attached session, spawns and the files they named, uploads and the status each got, uploads removed, relayed messages, resumes, opens in an editor, ends and refreshes of the PR list, for parts to check through `t.server.records`.

**A case** is one part at one window and theme, on a fresh page: storage cleared, the fake server's data reset, and the app loaded with the token in its fragment, as the CLI opens it. A part's steps run in order. `t.fresh({ storage })` sets `localStorage` items before the app's own scripts run, on that load alone, such as a starred session. `t.fresh({ forcedColors: true })` emulates forced colours, as a Windows contrast theme sets them, until the next fresh page, and `t.fresh({ labels: { [key]: label } })` gives groups other names, such as a longer one for a heading.

**What every step checks,** on top of its own checks:

- no console error or warning, and no exception;
- no CSP violation;
- no failed request or HTTP error, except one the step said it brings about with `t.allow` (below);
- no request to anywhere but the fake server, which is blocked;
- the page doesn't scroll sideways.

A step that throws, such as a wait that timed out or a click on something covered, leaves the page in a state the next step can't trust. So the rest of that case is skipped, and the next case starts afresh.

**Clicks are real** mouse events at an element's middle, after scrolling only what a reader can scroll. A click fails when the element has no box, is outside the window or is covered, so a hidden or covered button fails the step that needed it. **Keys are real** key events. **Typing** is inserted as an input method commits it.

**Links never open.** The page's init script records each click on a link to another origin, after pitwall's own handlers, then stops it. It also records `window.open`'s calls in place of opening a tab. `page.records()` returns both, and the CSP violations.

## Adding a part

Add a file to `parts/`, named for the area, such as `parts/sub-agents.ts`. The runner finds it by its name, so nothing else changes. A file starting with `_` is a helper, not a part.

```ts
import { NAMES } from '../fixtures.js';
import type { Part } from '../runner.js';
import { openFromRow, VIEW } from './_dom.js';

const part: Part = {
  name: 'sub-agents', // the file's name
  title: 'One line on what it checks, for --list',
  // viewports: ['1440'],         // only some windows, when the others can't apply
  // pending: 'Waiting for W70',  // not run by default, until what it checks is merged
  async run(t) {
    await t.step('opens the session', async () => {
      await t.fresh({ search: '?view=all' }); // or { roots: 2 } for two root tabs
      await openFromRow(t, NAMES.conversation);
      t.expect(await t.page.evaluate(`!!${VIEW}`), 'the view is open');
      await t.shot('open');
    });
  },
};

export default part;
```

- **Steps:** name each one for what a person would see, such as "Escape closes it, with focus back on Preferences". `t.expect(ok, what, detail)` and `t.expectEqual(actual, expected, what)` fail the step without stopping it; anything thrown fails it and skips the rest of the case.
- **A failure on purpose:** a step that has the fake server refuse a request, such as a resume, calls `t.allow(pattern, why)` first. The page's problems that match `pattern`, as `kind text`, such as the 409's `http` problem and Chrome's "Failed to load resource" for it, are listed in the summary under the step's `allowed`, with `why`, and don't fail it. Keep the pattern to that one request, by its path: `ended` allows `/api/sessions/<id>/resume$` and nothing else.
- **Files for the page:** `t.out` is the run's output folder, where a part can write files to hand the page, such as those New session's step chooses with `DOM.setFileInputFiles`.
- **The case:** `t.layout` (`drawer`, `sidebar` or `three-columns`), `t.compact` (600 px or narrower), `t.viewport` and `t.theme` say where it's running. Branch on them where the app differs by width.
- **The page:** `t.page` has `click`, `key`, `type`, `waitFor`, `evaluate`, `settle`, `reload`, `navigate` and `records`.
- **Made-up data:** sessions, conversations and links go in `fixtures.ts`, named in `NAMES` or `LINKS`, so a part never depends on a fixture's details. Keep them made up: names are `pitwall-test-*`, paths are under `/Users/example/`, and links go to `example.com` or `github.com/example/...`.
- **Run it** at every window and theme with `--only <name>`, and check its screenshots look right.

## The rules it keeps

- **No sound:** on macOS it sends keys only through `chrome-headless-shell`, which plays no alert sound for a key the page doesn't handle. See [Chrome on macOS](#chrome-on-macos).
- **Nothing real:** it never runs `claude`, and never reads `~/.claude`, a `.env` or `~/.pitwall`. Its token is random per run and reaches the page only in the URL's fragment. No URL in a message or the summary has a query or fragment.
- **Only its own ports:** it listens on, and connects to, only the ports in `--ports`. It refuses a range holding 4517 or 4518, where a real pitwall may run.
  - Chrome's debugging port must be free before Chrome starts. The check connects to the address its own Chrome prints, so it can never drive another browser.
- **Nothing leaves the machine:** Chrome resolves no host name (`--host-resolver-rules`) and runs without its background services. The page's requests to anywhere but the fake server are blocked, and fail the step.
- **It stops what it starts:** Chrome, by the PID it started, and the fake server, on success, failure, Ctrl+C, SIGTERM or `--timeout`. Chrome's throwaway profile is made in `--out` and deleted.
- **Not part of `npm test`.** It needs a build and Chrome, and takes minutes. It's TypeScript, run by `tsx`, and `npm run typecheck` checks it with the rest of `scripts/`.

## In CI

It isn't in CI yet, but it can run there. A CI job would need:

- **Chrome on the runner:** GitHub's Ubuntu images come with Google Chrome. Set `CHROME_PATH` to it, for example `/usr/bin/google-chrome`, since the default path is macOS's. The guard is for macOS alone, so Google Chrome runs there, and a runner has no speaker to chime; `chrome-headless-shell`'s `linux64` build would do too.
- **The build:** `npm run build` first, as the job already does.
- **Two free ports:** the default range is fine on a fresh runner.
- **The output as an artifact:** upload `--out` with `actions/upload-artifact`, so a failure's screenshot can be seen.
- **Perhaps Chrome's sandbox:** Chrome as root in a container, or on an Ubuntu 24.04 runner that restricts user namespaces, may not start without `--no-sandbox`. That would need a way to pass Chrome arguments, which the check doesn't have yet. None of this has been tried on a runner.

Fonts are bundled with the app, so text measures the same on Linux, except for any glyph the bundled fonts lack.
