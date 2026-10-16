# AGENTS.md

Instructions for agents working in this repo.

## What this is

pitwall is a local CLI and web UI for supervising the Claude Code sessions on this machine. It lists and groups them, lets you act on them, spawns new ones, and has a supervisor session you can talk to instead of visiting each session.

Read `PLAN.md` first. It says what exists, what's next and which decisions are still open.

## Status

M0 (the spikes) is done and every decision in `PLAN.md` is settled. M1, the read-only index, is next. There is no app code yet.

## Rules

- **The plan is the source of truth.** Update `PLAN.md` in the same commit as the work. A settled decision moves to `README.md` with its reasoning.
- **Prefer documented Claude Code interfaces:** `claude agents --json`, `claude --bg`, `claude attach`, `claude logs`, and cross-session messaging. Anything internal goes behind one adapter module and fails soft: show "unavailable", never crash. That covers transcript JSONL, `~/.claude/jobs/*/state.json` and the inbox socket wire format.
- **Never touch a real session.** During development and tests, don't message, stop, attach to or remove a session the user didn't name. Spikes and tests use throwaway sessions named `pitwall-test-*`, and remove them afterwards.
- **Keep the security rules in `PLAN.md`:** localhost only, a token on every request, `Host` and `Origin` checks. Don't weaken them for convenience, including in dev mode.
- **TypeScript in strict mode,** Node >= 22, npm.
- **Commits and PRs:** conventional commits for commit messages and PR titles. Keep the PR summary short and put detail in a `<details>` block.
- **Write as if the repo may go public.** It's private, but don't commit tokens, transcripts, session content or internal Hookdeck details, including in fixtures.

## Layout

```
PLAN.md                  the living plan: status, decisions, milestones
README.md                what pitwall is, and settled decisions with reasons
docs/spikes/             spike write-ups, one file per spike
```
