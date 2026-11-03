# NOW

The file every session reads first and updates before it ends (the `handoff` skill, `.claude/skills/handoff/SKILL.md`, does this). It says where the work stands and which parts of the plan to read. It is a pointer, so it links to the detail instead of copying it. Keep it under 100 lines.

Last updated: 2026-11-03, on `m5.1/integration`: W132 merged ([#146](https://github.com/leggetter/pitwall/pull/146)) after its security review; Phil answered its three questions. W133 next.

## Current milestone

**M5.1, efficiency, in progress** on `m5.1/integration` (branched from `main` 2026-11-02). Merged into it: the M5 archive, [#141](https://github.com/leggetter/pitwall/pull/141) (fixes #140, recaps of sessions you ended), W130 [#142](https://github.com/leggetter/pitwall/pull/142) (D27: New session in the selected session's directory; fixes #139), [#144](https://github.com/leggetter/pitwall/pull/144) (plan) and W131 [#145](https://github.com/leggetter/pitwall/pull/145) (`scripts/usage-report.ts`). M5 is in `main` ([#138](https://github.com/leggetter/pitwall/pull/138)); its detail is in `docs/plan-archive.md`.

- **What the usage showed** (W131; 14 days to 11-02, every repo): 11.35B tokens, 97.7% of them cache reads, 87% of those at more than 200K of context; sub-agents 58%. On 11-02 the pitwall coordinator and its 44 sub-agent runs were about half the day. Phil: "The problem isn't the global rules. It's pitwall" (2026-11-03), so the global rules are set aside for W133.
- **Effort:** Phil's `~/.claude/settings.json` sets Opus 5.5 to high since 10-30 (it was xhigh from about 10-08). The week from 11-02 is the test against 10-20 to 10-29.
- **Security notes left from M5** (Info): a look-alike name doesn't trigger the resume card's shared-name note; resume errors show a folder outside `untrusted`; the `claude` command list isn't checked against Claude Code 2.1.316's hidden commands.

## Open work

| Item | State |
| --- | --- |
| W132, recaps when they're worth it | Merged in [#146](https://github.com/leggetter/pitwall/pull/146) on 2026-11-03: recaps kept in `$PITWALL_HOME/recap-store/` (D26's "What's kept"), updates 15 minutes after a turn, the strip asking on open only when it's worth it, 500 a day. Security review (2026-11-03, xhigh): approve with fixes. Fixed: `remove()` now checks the folder as `load()` and `save()` do, so it never deletes through a linked `recap-store`; README says expired recaps go when pitwall starts. Info, left: expiry only at start; `RECAP_STORE_MAX_FILES` isn't ordered by age; a planted file chooses its session's recap text (no wider than writing the transcript) |
| W133, a context gauge and a hand-off hook ("M5.1 work breakdown") | Planned (Phil, 2026-11-03: A and B; C later) |
| [#143](https://github.com/leggetter/pitwall/issues/143) (Session view: expand the conversation or terminal to the full page) | Later (Phil, 2026-11-03) |
| W86, bump `vite` and `happy-dom` | Phil approved (2026-10-28); on or after 2026-11-04, when the fixes are 14 days old |
| W89, the first paste into New session's prompt is lost | Parked (Phil, 2026-11-02): he'll say if it happens again; Grammarly, which injects itself into the box, is suspected but not confirmed |
| A flaky `src/cli.test.ts` clean-up (`ENOTEMPTY`) | In "Nice to have, later" |
| M6, triage | After M5.1; not started |

## Next, in order

1. **W133** in a worktree (`.worktrees/<name>`), A and B. Then hand off; a coordinator hands off after each merged work item.
2. **W86** on or after 2026-11-04: `npm install <pkg>@<version> --before=<date>`, the newest version at least 14 days old.
3. **On 2026-11-09:** `npx tsx scripts/usage-report.ts --days 7` against the 10-20 to 10-29 figures, for the high-effort week; then one blog-editing session on Sonnet for Phil to judge (agreed; not the evals post).
4. **The rest of M5.1** from W134: work profiles, the Usage view with a run rate, the supervisor applying them ("M5.1 - Efficiency" in `PLAN.md`).
5. **M6, triage,** on the coordination model ("M6 - Triage" and "Considering: Peers" in `PLAN.md`), with Peers part of it, show only.

## Open questions for Phil

None. W132's three were answered (Phil, 2026-11-03): kept recaps last 30 days; a session with no recap yet still gets one on open; `cleanupPeriodDays` is a follow-up in `PLAN.md`'s "Nice to have, later".

## Standing context

Read these as the work needs them, not all at the start.

- **[`AGENTS.md`](AGENTS.md):** the rules (never touch a real session, pinned dependencies at least 14 days old, security rules, worktrees in `.worktrees/<name>`), "Efficiency", and the commands and layout.
- **[`PLAN.md`](PLAN.md):** read the section the work is in. "Architecture" and "Interfaces pitwall relies on" for what pitwall depends on; "Security" before touching the server, a spawned process or storage; "M5.1", "M6", "Considering: Peers" and "Later: chatting with a session" for what's next; "Nice to have, later" for small items.
- **[`docs/decisions.md`](docs/decisions.md):** settled decisions D1 to D27 with their reasoning. D4 (the supervisor), D8 (the relay), D24 (the config file) and D26 (recaps) matter for what's next.
- **[`docs/design-system.md`](docs/design-system.md):** tokens, layout and components, before a UI change. A UI change runs the app check: [`scripts/appcheck/README.md`](scripts/appcheck/README.md).
- **[`docs/plan-archive.md`](docs/plan-archive.md):** history, for M0 to M5: work breakdowns, findings, reviews and decisions. Look a W number up here when an old one is cited.
- **[`docs/spikes/`](docs/spikes/):** what each spike measured; 009 (the supervisor process), 010 (recaps) and 011 (resuming a finished session with a message) are M5's.
- **[`README.md`](README.md):** for newcomers; update it when what pitwall does changes.
