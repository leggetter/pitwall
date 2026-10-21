# AGENTS.md

Instructions for agents working in this repo.

## What this is

pitwall is a local CLI and web UI for supervising the Claude Code sessions on this machine. It lists and groups them, lets you act on them, spawns new ones, and has a supervisor session you can talk to instead of visiting each session.

Read `PLAN.md` first. It says what exists, what's next and which decisions are still open.

## Status

M1, the read-only index, and M2, interacting with sessions from the web UI, are merged into `main` ([PR #6](https://github.com/leggetter/pitwall/pull/6), [PR #19](https://github.com/leggetter/pitwall/pull/19)). M3, the design system and restyle, is in progress on `m3/integration`. See "M3 work breakdown" in `PLAN.md` and `docs/design-system.md`.

## Rules

- **The plan is the source of truth.** Update `PLAN.md` in the same commit as the work. A settled decision moves to `README.md` with its reasoning.
- **Prefer documented Claude Code interfaces:** `claude agents --json`, `claude --bg`, `claude attach`, `claude logs`, and cross-session messaging. Anything internal goes behind one adapter module and fails soft: show "unavailable", never crash. That covers transcript JSONL, `~/.claude/jobs/*/state.json` and the inbox socket wire format.
- **Never touch a real session.** During development and tests, don't message, stop, attach to or remove a session the user didn't name. Spikes and tests use throwaway sessions named `pitwall-test-*`, and remove them afterwards.
- **Keep the security rules in `PLAN.md`:** localhost only, a token on every request, `Host` and `Origin` checks. Don't weaken them for convenience, including in dev mode.
- **TypeScript in strict mode,** Node >= 22, npm.
- **Dependencies are pinned exactly and must be at least 14 days old.** Pick the newest version published 14 or more days ago (`npm view <pkg> time --json`) and install with `npm install <pkg>@<version> --before=<date>`, so transitive dependencies follow the same cutoff. `.npmrc` enforces exact versions. Prefer a few lines of code over a new dependency.
- **Commits and PRs:** conventional commits for commit messages and PR titles. Keep the PR summary short and put detail in a `<details>` block.
- **Write as if the repo may go public.** It's private, but don't commit tokens, transcripts, session content or internal Hookdeck details, including in fixtures.

## Commands

Use Node 22 (CI runs 22.x) and npm.

```
npm ci                   install exactly what package-lock.json records
npm run build            server with tsc to dist/, web UI with Vite to dist/web
npm run dev -- [root...] rebuild the web UI and restart the server on change. Uses port 4517
                         and one token per run, refuses to start if 4517 is busy, and opens
                         the browser once, through the launch file, after the server listens
npm run typecheck        server (tsconfig.json) and web UI (web/tsconfig.json)
npm test                 vitest run: src/**/*.test.ts and web/**/*.test.tsx
npm start -- [root...]   run the built CLI, node dist/cli.js. `--interval <seconds>` sets the poll (default 5)
```

There is no Vite dev server. `npm run dev` runs `vite build --watch --mode development` and `tsx watch src/cli.ts`, and the pitwall server serves `dist/web`. Development mode adds the design system's gallery at `http://127.0.0.1:4517/#uikit` (`docs/design-system.md`); `npm run build` leaves it out.

## Layout

```
PLAN.md                  the living plan: status, decisions, milestones
README.md                what pitwall is, and settled decisions with reasons
docs/design-system.md    the web UI's design system: tokens, layout, components, content, accessibility
docs/spikes/             spike write-ups, one file per spike
src/shared/protocol.ts   the contract between the index, the server and the web UI
src/index/               the session index. Entry point index.ts: startIndexer()
src/server/              the local HTTP and WebSocket server. Entry point index.ts: startServer()
src/cli.ts               the `pitwall` command (bin, built to dist/cli.js)
src/test/                test helpers shared across test files, such as the v3 proof, and noClaude.ts,
                         which fails any server test that would run `claude` without PITWALL_LIVE=1; not built
web/                     the React web UI, built by Vite to dist/web
web/public/theme-init.js sets the theme before first paint (a same-origin script, for the CSP)
web/src/uikit/           the dev-only `#uikit` gallery; `npm run build` leaves it out
web/src/test/            test helpers and fixtures shared across the web UI's tests; not built
scripts/dev.ts           runs the two watchers behind `npm run dev`
scripts/extract-icons.ts regenerates web/src/icons/paths.ts from a pinned Material Symbols commit
THIRD_PARTY_NOTICES.md   licences for the bundled fonts and icons
tsconfig.json            server typecheck: src/ with tests, scripts/, config files
tsconfig.build.json      server build: src/ to dist/, without tests
web/tsconfig.json        web UI typecheck (DOM, react-jsx, bundler resolution)
vite.config.ts           web UI build
vitest.config.ts         test runner config
.github/workflows/ci.yml CI: npm ci, typecheck, test, build on Node 22.x
```
