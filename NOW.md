# NOW

The file every session reads first and updates before it ends (the `handoff` skill, `.claude/skills/handoff/SKILL.md`, does this). It says where the work stands and which parts of the plan to read. It is a pointer, so it links to the detail instead of copying it. Keep it under 100 lines.

Last updated: 2026-11-02, on `m5.1/usage-report`: W131's usage report built and run once over the last 14 days; in review.

## Current milestone

**M5, the supervisor, is done:** merged into `main` in [#138](https://github.com/leggetter/pitwall/pull/138) on 2026-11-02, built on `m5/integration` as W109 to W129 ([#110](https://github.com/leggetter/pitwall/pull/110) to [#137](https://github.com/leggetter/pitwall/pull/137)). Phil tried it on port 4519 and gave the word; the full app check ran before the merge (1,976 steps; its two stale checks fixed in #137).

- **Security:** W116's review and W120's fixes ([#122](https://github.com/leggetter/pitwall/pull/122)); the re-review of W124 to W128 and W129's fixes ([#133](https://github.com/leggetter/pitwall/pull/133)), whose re-check approved M5 for `main`. Its unfixed Info notes: a look-alike name doesn't trigger the resume card's shared-name note; resume errors show a folder outside `untrusted`; the `claude` command list isn't checked against Claude Code 2.1.316's hidden commands.
- **M5.1, efficiency, is next,** on `m5.1/integration`, branched from `main` on 2026-11-02, as M4 and M5 were built. M5's detail is in `docs/plan-archive.md` ("M5 - Supervisor" and "M5 work breakdown"), with a one-line pointer in `PLAN.md`.

## Open work

| Item | State |
| --- | --- |
| M5.1, efficiency | Not started |
| [#140](https://github.com/leggetter/pitwall/issues/140) (Needs you: a recap keeps a session you said is done under Needs you) | Fixed in the recap prompt ([#141](https://github.com/leggetter/pitwall/pull/141)), merged into `m5.1/integration`. Checked live on Haiku: an ended session, old prompt 3 of 3 "you", new 2 of 2 "nothing"; one that asks you something, or that's done with only part of the work, still "you" (2 of 2 each). A "Not needed" action is in "Nice to have, later" |
| W131, the usage report ("M5.1 work breakdown") | Built: `npx tsx scripts/usage-report.ts [--days 14] [--json]` (`src/usage/`), a PR into `m5.1/integration`. Run once over every repo's last 14 days (Phil agreed, 2026-11-02); the numbers went to Phil in chat, and the output stays in the worktree's gitignored `scratch/`. The global efficiency rules wait for Phil to read them, then go into the global `AGENTS.md` |
| W86, bump `vite` and `happy-dom` | Phil approved (2026-10-28); on or after 2026-11-04, when the fixes are 14 days old |
| W89, the first paste into New session's prompt is lost | Parked (Phil, 2026-11-02): he'll say if it happens again; Grammarly, which injects itself into the box, is suspected but not confirmed |
| A flaky `src/cli.test.ts` clean-up (`ENOTEMPTY`) | In "Nice to have, later" |
| M6, triage | After M5.1; not started |

## Next, in order

1. **W131, the usage report** (`m5.1/usage-report`, in `.worktrees/usage-report`): built and run; review and merge its PR, then draft the global efficiency rules from its numbers for Phil's approval.
2. **The rest of M5.1:** work profiles, the Usage view with a run rate, the supervisor applying them ("M5.1 - Efficiency" in `PLAN.md`), as W items from W132, shaped by W131's numbers.
3. **W86** on or after 2026-11-04: `npm install <pkg>@<version> --before=<date>`, the newest version at least 14 days old.
4. **M6, triage,** on the coordination model: split work, shared state, graded oversight, and shared decisions first with a goal check at the end, with Peers part of it, show only (Phil, 2026-11-02): "M6 - Triage" and "Considering: Peers" in `PLAN.md`. Then the considerations: chatting with a session, a session asking the supervisor to spin off work.

## Open questions for Phil

- None open. Decided on 2026-11-02: Peers is show only; W89 is parked; the IDE extension is used rarely, so no spike; the supervisor survives restarts, as built.

## Standing context

Read these as the work needs them, not all at the start.

- **[`AGENTS.md`](AGENTS.md):** the rules (never touch a real session, pinned dependencies at least 14 days old, security rules, worktrees in `.worktrees/<name>`), "Efficiency", and the commands and layout.
- **[`PLAN.md`](PLAN.md):** read the section the work is in. "Architecture" and "Interfaces pitwall relies on" for what pitwall depends on; "Security" before touching the server, a spawned process or storage; "M5.1", "M6", "Considering: Peers" and "Later: chatting with a session" for what's next; "Nice to have, later" for small items.
- **[`docs/decisions.md`](docs/decisions.md):** settled decisions D1 to D27 with their reasoning. D4 (the supervisor), D8 (the relay), D24 (the config file) and D26 (recaps) matter for what's next.
- **[`docs/design-system.md`](docs/design-system.md):** tokens, layout and components, before a UI change. A UI change runs the app check: [`scripts/appcheck/README.md`](scripts/appcheck/README.md).
- **[`docs/plan-archive.md`](docs/plan-archive.md):** history, for M0 to M5: work breakdowns, findings, reviews and decisions. Look a W number up here when an old one is cited.
- **[`docs/spikes/`](docs/spikes/):** what each spike measured; 009 (the supervisor process), 010 (recaps) and 011 (resuming a finished session with a message) are M5's.
- **[`README.md`](README.md):** for newcomers; update it when what pitwall does changes.
