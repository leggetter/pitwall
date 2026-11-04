# NOW

The file every session reads first and updates before it ends (the `handoff` skill, `.claude/skills/handoff/SKILL.md`, does this). It says where the work stands and which parts of the plan to read. It is a pointer, so it links to the detail instead of copying it. Keep it under 100 lines.

Last updated: 2026-11-04, on `m5.1/integration`: W134 (the supervisor takes longer messages, 100K) merged ([#155](https://github.com/leggetter/pitwall/pull/155)) after a fresh review. Phil agreed W136 (the supervisor's context, visible and clearable, and taller cards), next, before W135 (attach a file in the supervisor's message box).

## Current milestone

**M5.1, efficiency, in progress** on `m5.1/integration` (branched from `main` 2026-11-02). Merged into it: W134 [#155](https://github.com/leggetter/pitwall/pull/155) (the supervisor takes 100K-character messages), the M5 archive, [#141](https://github.com/leggetter/pitwall/pull/141) (fixes #140, recaps of sessions you ended), W130 [#142](https://github.com/leggetter/pitwall/pull/142) (D27: New session in the selected session's directory; fixes #139), [#144](https://github.com/leggetter/pitwall/pull/144) (plan) W131 [#145](https://github.com/leggetter/pitwall/pull/145) (`scripts/usage-report.ts`), W132 [#146](https://github.com/leggetter/pitwall/pull/146) (recaps kept across restarts) and W133 [#148](https://github.com/leggetter/pitwall/pull/148), [#149](https://github.com/leggetter/pitwall/pull/149) (the hand-off hook and the context gauge). M5 is in `main` ([#138](https://github.com/leggetter/pitwall/pull/138)); its detail is in `docs/plan-archive.md`.

- **What the usage showed** (W131; 14 days to 11-02, every repo): 11.35B tokens, 97.7% of them cache reads, 87% of those at more than 200K of context; sub-agents 58%. On 11-02 the pitwall coordinator and its 44 sub-agent runs were about half the day. Phil: "The problem isn't the global rules. It's pitwall" (2026-11-03), so the global rules are set aside for W133.
- **Effort:** Phil's `~/.claude/settings.json` sets Opus 5.5 to high since 10-30 (it was xhigh from about 10-08). The week from 11-02 is the test against 10-20 to 10-29.
- **Security notes left from M5** (Info): a look-alike name doesn't trigger the resume card's shared-name note; resume errors show a folder outside `untrusted`; the `claude` command list isn't checked against Claude Code 2.1.316's hidden commands.

## Open work

| Item | State |
| --- | --- |
| W132, recaps when they're worth it | Merged ([#146](https://github.com/leggetter/pitwall/pull/146)). Its security review's Info notes, left: expiry only at start; `RECAP_STORE_MAX_FILES` isn't ordered by age; a planted file chooses its session's recap text (no wider than writing the transcript) |
| W133, a context gauge and a hand-off hook | Merged on 2026-11-03. B ([#148](https://github.com/leggetter/pitwall/pull/148), [spike 012](docs/spikes/012-handoff-hook.md)): a Stop hook in `.claude/settings.json`, nudging at 200K and 400K; it fired in an interactive session too (the coordinator's, at 206K, 2026-11-04), and a session's first turn is never nudged (the transcript lags a call). A ([#149](https://github.com/leggetter/pitwall/pull/149)): "ctx 245K" on rows over 200K, red over 400K, and the number in the session view; forgotten at a compaction until the next call. C, "Hand off" in Needs you, later (Phil, 2026-11-03) |
| [#143](https://github.com/leggetter/pitwall/issues/143) (Session view: expand the conversation or terminal to the full page) | Later (Phil, 2026-11-03) |
| W89, the first paste into New session's prompt is lost | Parked (Phil, 2026-11-02): he'll say if it happens again; Grammarly, which injects itself into the box, is suspected but not confirmed |
| A flaky `src/cli.test.ts` clean-up (`ENOTEMPTY`) | In "Nice to have, later" |
| M6, triage | After M5.1; not started |

## Next, in order

1. **W136 (the supervisor's context, visible and clearable, and taller cards)**, in review on `m5.1/supervisor-context`: New conversation (a confirmation in the page; stops it, forgets `state.json`, keeps the transcript and hides its id), "Context 84K" in its header, the box's note, cards' text and editor to half the window. Next: a fresh review, merge. The drafts band now grows to 70% of the view, and What it sent and started to 15% while there are drafts (Phil, 2026-11-04).
2. **W135 (attach a file in the supervisor's message box)** in a worktree, then a fresh review, merge, hand off. The row in `PLAN.md`'s "M5.1 work breakdown". The app check's fake server takes a message body up to 800 KiB now (W134), for a real send of a big file.
3. **Phil runs the latest version and uses it:** `npm ci && npm run build` in the main checkout, restart 4518.
4. **Then break the rest of M5.1 into work items** (work profiles, the Usage view with a run rate, the supervisor applying them; "M5.1 - Efficiency" in `PLAN.md`), with Phil.
5. **On 2026-11-09:** `npx tsx scripts/usage-report.ts --days 7` against the 10-20 to 10-29 figures, for the high-effort week; then one blog-editing session on Sonnet for Phil to judge (agreed; not the evals post).
6. **M6 (triage),** on the coordination model ("M6 - Triage" and "Considering: Peers" in `PLAN.md`), with Peers part of it, show only.

## Open questions for Phil

None. Answered (Phil, 2026-11-04): the supervisor gets options A and B, W134 and W135, not C; the rest of M5.1 is broken into work items after those, once Phil runs the latest version and uses it.

## Standing context

Read these as the work needs them, not all at the start.

- **[`AGENTS.md`](AGENTS.md):** the rules (never touch a real session, pinned dependencies at least 14 days old, security rules, worktrees in `.worktrees/<name>`), "Efficiency", and the commands and layout.
- **[`PLAN.md`](PLAN.md):** read the section the work is in. "Architecture" and "Interfaces pitwall relies on" for what pitwall depends on; "Security" before touching the server, a spawned process or storage; "M5.1", "M6", "Considering: Peers" and "Later: chatting with a session" for what's next; "Nice to have, later" for small items.
- **[`docs/decisions.md`](docs/decisions.md):** settled decisions D1 to D27 with their reasoning. D4 (the supervisor), D8 (the relay), D24 (the config file) and D26 (recaps) matter for what's next.
- **[`docs/design-system.md`](docs/design-system.md):** tokens, layout and components, before a UI change. A UI change runs the app check: [`scripts/appcheck/README.md`](scripts/appcheck/README.md).
- **[`docs/plan-archive.md`](docs/plan-archive.md):** history, for M0 to M5: work breakdowns, findings, reviews and decisions. Look a W number up here when an old one is cited.
- **[`docs/spikes/`](docs/spikes/):** what each spike measured; 009 (the supervisor process), 010 (recaps) and 011 (resuming a finished session with a message) are M5's.
- **[`README.md`](README.md):** for newcomers; update it when what pitwall does changes.
