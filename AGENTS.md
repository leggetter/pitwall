# AGENTS.md

Instructions for agents working in this repo.

## What this is

pitwall is the pit wall for the Claude Code sessions on this machine: it watches every one, lets you steer it, and starts new ones, from a local web UI. It lists them grouped by repo, and will have a supervisor session (M5) you can talk to instead of visiting each session.

Read `PLAN.md` first. It says what exists, what's next and which decisions are still open.

## Status

M1, the read-only index, M2, interacting with sessions from the web UI, M3, the design system and restyle, and M3.1, the work after M3, are merged into `main` ([PR #6](https://github.com/leggetter/pitwall/pull/6), [PR #19](https://github.com/leggetter/pitwall/pull/19), [PR #51](https://github.com/leggetter/pitwall/pull/51), [PR #87](https://github.com/leggetter/pitwall/pull/87)).

M3.1 was built on `m3.1/integration` ([PR #69](https://github.com/leggetter/pitwall/pull/69) to [PR #86](https://github.com/leggetter/pitwall/pull/86)) and merged on 2026-10-28, after W85's security review approved it. End session for interactive sessions (spike 005) is built as W90, in review in [PR #93](https://github.com/leggetter/pitwall/pull/93), and W85's non-blocking findings were W87. Next is M4, Phil's open pull requests. See "M3.1 work breakdown" in `PLAN.md` and `docs/design-system.md`.

## Rules

- **A UI change runs the app check:** `npm run build && npm run appcheck -- --out <dir>`, and adds or extends its part in `scripts/appcheck/parts/`. On macOS, never send key presses to Google Chrome's headless mode: it plays the user's alert sound for each key a page doesn't handle (W64). The harness refuses any browser but the pinned `chrome-headless-shell` there.
- **The plan is the source of truth.** Update `PLAN.md` in the same commit as the work. A settled decision moves to `docs/decisions.md` with its reasoning, under the ID it had in the plan.
- **Prefer documented Claude Code interfaces:** `claude agents --json`, `claude --bg`, `claude attach`, `claude logs`, and cross-session messaging. Anything internal goes behind one adapter module and fails soft: show "unavailable", never crash. That covers transcript JSONL, sub-agents' `subagents/` folders, `~/.claude/jobs/*/state.json` and the inbox socket wire format.
- **Never touch a real session.** During development and tests, don't message, stop, attach to or remove a session the user didn't name. Spikes and tests use throwaway sessions named `pitwall-test-*`, and remove them afterwards.
- **Keep the security rules in `PLAN.md`:** localhost only, a token on every API request and WebSocket, `Host` and `Origin` checks. Don't weaken them for convenience, including in dev mode.
- **TypeScript in strict mode,** Node >= 22, npm.
- **Dependencies are pinned exactly and must be at least 14 days old.** Pick the newest version published 14 or more days ago (`npm view <pkg> time --json`) and install with `npm install <pkg>@<version> --before=<date>`, so transitive dependencies follow the same cutoff. `.npmrc` enforces exact versions. Prefer a few lines of code over a new dependency.
- **Commits and PRs:** conventional commits for commit messages and PR titles. Keep the PR summary short and put detail in a `<details>` block.
- **Worktrees go in `.worktrees/<name>`** inside the main checkout, which `.gitignore` ignores (Phil, 2026-10-27), not in folders beside it. ripgrep, the editors' search, vitest and tsc leave them alone, and New session's directory list skips hidden folders. A plain `git clean -fdx` skips them as nested repositories; only `-ff` would delete them.
- **Write for a public repo.** It's going public (Phil, 2026-10-28), so don't commit tokens, transcripts, session content or internal Hookdeck details, including in fixtures. In the docs, `~/work` and `~/oss` stand for Phil's two roots (Phil, 2026-10-23).

## Commands

Use Node 22 (CI runs 22.x) and npm.

```
npm ci                   install exactly what package-lock.json records
npm run build            server with tsc to dist/, web UI with Vite to dist/web
npm run dev -- [root...] rebuild the web UI and restart the server on change. Uses port 4517
                         (PITWALL_DEV_PORT overrides it), refuses to start if it's busy, and opens
                         the browser once, through the launch file, after the server listens.
                         One token per run, unless PITWALL_TOKEN is set in the environment or
                         the repo's .env (see .env.example)
npm run typecheck        server (tsconfig.json) and web UI (web/tsconfig.json)
npm test                 vitest run: src/**/*.test.ts and web/**/*.test.tsx
npm start -- [root...]   run the built CLI, node dist/cli.js. `--interval <seconds>` sets the poll (default 5),
                         `--port <n>` the port (default 4517, or a free one if it's busy), and
                         `--no-open` leaves the browser alone
npm run appcheck -- --out <dir>   the headless app check of the production build, after npm run build
                         (scripts/appcheck/README.md); --list, --only <part>, --widths, --themes, --ports
npm run appcheck:install-shell    once on macOS: the pinned chrome-headless-shell it runs in
```

There is no Vite dev server. `npm run dev` runs `vite build --watch --mode development` and `tsx watch src/cli.ts`, and the pitwall server serves `dist/web`. Development mode adds the design system's gallery at `http://127.0.0.1:4517/#uikit` (`docs/design-system.md`); `npm run build` leaves it out.

## Layout

```
PLAN.md                  the living plan: status, decisions, milestones
README.md                for newcomers: what pitwall is, how to run it, how it works, the roadmap
docs/decisions.md        settled decisions, D1 to D22, with their reasoning
docs/design-system.md    the web UI's design system: tokens, layout, components, content, accessibility
docs/images/             screenshots for README.md
docs/spikes/             spike write-ups, one file per spike, with a script beside some
src/shared/protocol.ts   the contract between the index, the server and the web UI
src/index/               the session index. Entry point index.ts: startIndexer()
src/server/              the local HTTP and WebSocket server. Entry point index.ts: startServer()
src/cli.ts               the `pitwall` command (bin, built to dist/cli.js)
src/test/                test helpers shared across test files, such as the v3 proof, and noClaude.ts,
                         which fails any server test that would run `claude` without PITWALL_LIVE=1, or
                         open an editor at all; not built
web/                     the React web UI, built by Vite to dist/web
web/public/theme-init.js sets the theme before first paint (a same-origin script, for the CSP)
web/src/uikit/           the dev-only `#uikit` gallery; `npm run build` leaves it out
web/src/test/            test helpers and fixtures shared across the web UI's tests; not built
scripts/dev.ts           runs the two watchers behind `npm run dev`
scripts/extract-icons.ts regenerates web/src/icons/paths.ts from a pinned Material Symbols commit
scripts/readme-screenshot.ts
                         writes <outDir>/hero-<theme>.png from made-up sessions on the app check's fake
                         server; after a UI change it shows, copy it to docs/images/pitwall-light.png
scripts/appcheck/        the app check: a fake server using pitwall's own security code, a Chrome driver,
                         and one part per area in parts/; typechecked, not built, not in npm test
LICENSE                  Apache-2.0 (D21, docs/decisions.md)
THIRD_PARTY_NOTICES.md   licences for the bundled fonts and icons
.env.example             how to make a fixed PITWALL_TOKEN for npm run dev (D7); .env is gitignored
CLAUDE.md                imports this file for Claude Code
tsconfig.json            server typecheck: src/ with tests, scripts/, config files
tsconfig.build.json      server build: src/ to dist/, without tests
web/tsconfig.json        web UI typecheck (DOM, react-jsx, bundler resolution)
vite.config.ts           web UI build
vitest.config.ts         test runner config
.github/workflows/ci.yml CI: npm ci, typecheck, test, build on Node 22.x
```
