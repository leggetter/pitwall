# NOW

The file every session reads first and updates before it ends (the `handoff` skill, `.claude/skills/handoff/SKILL.md`, does this). It says where the work stands and which parts of the plan to read. It is a pointer, so it links to the detail instead of copying it. Keep it under 100 lines.

Last updated: 2026-11-09, on `m5.2/work-profiles`, after building W155 (work profiles), for a fresh review before it merges into `m5.2/integration`. Before that, on `docs/handoff-m5.1`, after the usage comparison, the rebuild for 4518 and pushing `m5.2/integration`; before that, a hand-off after M5.1 merged into `main` ([#197](https://github.com/leggetter/pitwall/pull/197), feat: M5.1, the work after M5), closing [#139](https://github.com/leggetter/pitwall/issues/139) (New session defaults to the selected session's directory) and [#140](https://github.com/leggetter/pitwall/issues/140) (Needs you: a recap keeps a session you said is done under Needs you). Before it: the full app check passed 2,235 of 2,236 steps on `0ec493b`; 26 stale checks were fixed in [#195](https://github.com/leggetter/pitwall/pull/195) and the one failure, a check racing the Plan status live region, in [#196](https://github.com/leggetter/pitwall/pull/196). Next: M5.2, efficiency, starting with W155 (work profiles).

## Current milestone

**M5.2, efficiency, next,** on `m5.2/integration`, to be branched from `main` at `e4886ab` (`PLAN.md`, "M5.2 - Efficiency" and "M5.2 work breakdown"). M5.1 is done; its detail is in `docs/plan-archive.md` ("M5.1 - After M5", "M5.1 work breakdown"), and M0 to M5 before it.

- **What the usage showed** (W131, the usage report; 14 days to 11-02, every repo): 11.35B tokens, 97.7% of them cache reads, 87% of those at more than 200K of context; sub-agents 58%. Phil: "The problem isn't the global rules. It's pitwall" (2026-11-03).
- **Effort:** Phil's `~/.claude/settings.json` sets Opus 5.5 to high since 10-30 (it was xhigh from about 10-08). Measured 2026-11-09 (`usage-report.ts --days 21 --json`, by day, every repo): 10-20 to 10-29 at xhigh, 9 active days, 1.12B tokens a day, 3,264 calls, 2.56M output, 785 output and 344K total a call; 11-02 to 11-09 at high, 7 active days, 750M a day (-33%), 3,294 calls (flat), 2.43M output (-5%), 739 output (-6%) and 228K total a call (-34%). The drop is shorter contexts (cache reads), not effort: output, which holds the thinking, fell only 6% a call. The work mix differs between the weeks.
- **The merge rule** (Phil, 2026-11-06): merge each item after a fresh sub-agent review and its fixes, without waiting for a try-out; his feedback from real use becomes new work items. Claude Code's auto mode refused a `gh pr merge` into `main` until Phil said "you merge" (2026-11-09).

## Open work

| Item | State |
| --- | --- |
| M5.2, W155 to W160 | W155 (work profiles) built on `m5.2/work-profiles`, for review: its skill check passed (`PLAN.md`'s W155 item). Then W156 (the supervisor proposes sessions with a profile), W157 (spike 013: reading the plan's percentages without changing your settings), W158 (the Usage view), W159 (the run rate against a weekend reserve), W160 (the supervisor reads the run rate), in that order (`PLAN.md`, "M5.2 work breakdown") |
| Left from W164 (M5.1's security review) | F5 (a snooze trusts the relay's name, not its msg_ids), I3's note on attached files, I4 (by design); in the archive's W164 item |
| Left from M5's security notes (Info) | A look-alike name doesn't trigger the resume card's shared-name note; resume errors show a folder outside `untrusted`; the `claude` command list isn't checked against Claude Code 2.1.316's hidden commands |
| Left from M5.1's items | Each item's "Left" is in its archive entry: for example W153's (flag) no retry of a failed ask, W154's (snooze) unseen scheduled wake-ups, W163's (spin-off proposals) overlap check, "Ask the supervisor" and the profile's model, with M6 |
| [#143](https://github.com/leggetter/pitwall/issues/143) (Session view: expand the conversation or terminal to the full page) | Later (Phil, 2026-11-03) |
| W89, the first paste into New session's prompt is lost | Parked (Phil, 2026-11-02): he'll say if it happens again; Grammarly is suspected, not confirmed |
| A flaky `src/cli.test.ts` clean-up (`ENOTEMPTY`) | In "Nice to have, later" |
| M6, triage | After M5.2; not started |

## Next, in order

1. **One blog-editing session on Sonnet for Phil to judge** (agreed; not the evals post). The usage comparison is done (Current milestone, Effort).
2. **Phil restarts 4518:** the main checkout is on `main` at `e4886ab` and built (2026-11-09), so the restart picks up W161 to W164. After it, the supervisor begins a new conversation once (prompt version 6, W138, the supervisor's messages say they're from it), if it hasn't already.
3. **W155 (work profiles) is built** on `m5.2/work-profiles`, in `.worktrees/work-profiles`, and pushed. Next: a fresh review, the coordinator's fixes, its PR into `m5.2/integration`, merge, CI there. `PLAN.md`'s W155 item has what was built and decided.
4. **Then W156 to W160,** one session per item (`AGENTS.md`, Efficiency), then M5.2's security review and the merge into `main`, with its PR text shown to Phil first.
5. **M6 (triage),** on the coordination model ("M6 - Triage" and "Considering: Peers" in `PLAN.md`), with Peers part of it, show only.

## Open questions for Phil

None.

Answered (Phil, 2026-11-09, "go with your leans"): no user guide for now; the README stays the only user-facing description of what pitwall does, and is revisited when its "What it does" outgrows a screen or someone asks how a feature works (the repo is already public, so the earlier "until it goes public" didn't apply). W163's (spin-off proposals) card stays as built: over Needs you's rows, dismissals kept per browser, the folder checked at Start. W138's (the supervisor's messages say they're from it) footer stays, though it wraps to 3 lines in a draft card at 1,200 px.

Answered (Phil, 2026-11-09): the M5.1 → `main` PR text, opened as written ([#197](https://github.com/leggetter/pitwall/pull/197)), and merged on green.

Answered (Phil, 2026-11-06): W155 (work profiles) sets the sub-agent model as a default only, not forced, revisited with W158's (the Usage view) figures; profiles are launch settings plus an optional skill to start with; the run rate's target line is a weekend reserve; profiles first; the four built-in profiles; and the stand-in cost, set against `/usage`, only if spike 013 can't read the percentage.

## Standing context

Read these as the work needs them, not all at the start.

- **[`AGENTS.md`](AGENTS.md):** the rules (never touch a real session, pinned dependencies at least 14 days old, security rules, worktrees in `.worktrees/<name>`), "Efficiency", and the commands and layout.
- **[`PLAN.md`](PLAN.md):** read the section the work is in. "Architecture" and "Interfaces pitwall relies on" for what pitwall depends on; "Security" before touching the server, a spawned process or storage; "M5.2" and "M6" for what's next; "Nice to have, later" for small items.
- **[`docs/decisions.md`](docs/decisions.md):** settled decisions D1 to D27 with their reasoning. D4 (the supervisor), D24 (the config file) and D26 (recaps) matter for M5.2.
- **[`docs/design-system.md`](docs/design-system.md):** tokens, layout and components, before a UI change. A UI change runs the app check: [`scripts/appcheck/README.md`](scripts/appcheck/README.md).
- **[`docs/plan-archive.md`](docs/plan-archive.md):** history, for M0 to M5.1: work breakdowns, findings, reviews and decisions. Look a W number up here when an old one is cited.
- **[`docs/spikes/`](docs/spikes/):** what each spike measured; 009 (the supervisor process), 010 (recaps) and 011 (resuming a finished session with a message) are M5's.
- **[`README.md`](README.md):** for newcomers; update it when what pitwall does changes.
