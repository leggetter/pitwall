# NOW

The file every session reads first and updates before it ends (the `handoff` skill, `.claude/skills/handoff/SKILL.md`, does this). It says where the work stands and which parts of the plan to read. It is a pointer, so it links to the detail instead of copying it. Keep it under 100 lines.


Last updated: 2026-11-12, on `docs/now-w190`: W190 (a session's title stays on what the session is about) is planned, from Phil's report, in [#254](https://github.com/leggetter/pitwall/pull/254). Before it, 2026-11-12, on `docs/now-coordinator-recovery`: the coordinating session ("NOW.md", job 5277166f) ended at 23:29 on 11-11, after its hand-off, and wasn't restarted with the other background sessions at 23:30; Phil made a new session the coordinator (see "Housekeeping" below). Before it, 2026-11-11: the first M5.3 batch is merged into `m5.3/integration` and nothing is in flight. Before that, 2026-11-10: M5.2 merged into `main` ([#234](https://github.com/leggetter/pitwall/pull/234)) and `m5.3/integration` branched from it. The next free W number is W191.

**Servers:** 4518 runs `main` at f4458a7. A try-out on 4519 runs `m5.3/integration` at 1c07eb9 (before #244), from `.worktrees/tryout`, with its own home (`.worktrees/tryout/scratch/home`) and recaps on; Phil is trying it. Stop it and remove the worktree when he's done.

**Housekeeping** (found 2026-11-12, waiting for Phil's yes): stop the "pitwall-slack-notion-access" session (9443332c, in `.worktrees/connectors`), restarted at 00:49 on 11-12 although its work (#237, D28 and spike 016) is merged. Then remove three worktrees whose PRs are merged: `.worktrees/connectors` (#237), `.claude/worktrees/fix-badges-overlap-activity` (#206, a row's badges over its time) and `.claude/worktrees/fix-pr-open-unknown` (#236, list_sessions' prOpen; locked by pid 72124, which has exited). Also stop a85671eb, an empty session with the coordinator's name, started at 09:59 on 11-12 with no transcript.

## Current milestone

**M5.3, after M5.2, in progress,** on `m5.3/integration` (`PLAN.md`, "M5.3 - After M5.2" and "M5.3 work breakdown"). M5.2 (efficiency) is done and merged: its detail is in `docs/plan-archive.md` ("M5.2 - Efficiency", "M5.2 work breakdown"), with M0 to M5.1 before it.

- **Coordination** (Phil, 2026-11-10): one coordinating session directs pitwall's work and keeps `NOW.md`. Other pitwall sessions open PRs into `m5.3/integration` and report to the coordinator; they don't edit `NOW.md`. Builders and reviewers are sub-agents, in `.worktrees/<name>`. Each PR gets a fresh sub-agent review and is merged only on green CI. No other pitwall session has work in progress (asked 2026-11-10).
- **What the usage showed** (W131, the usage report; 14 days to 11-02, every repo): 11.35B tokens, 97.7% of them cache reads, 87% of those at more than 200K of context; sub-agents 58%. Phil: "The problem isn't the global rules. It's pitwall" (2026-11-03).
- **Effort:** Phil's `~/.claude/settings.json` sets Opus 5.5 to high since 10-30 (it was xhigh from about 10-08). Measured 2026-11-09 (`usage-report.ts --days 21 --json`, by day, every repo): 10-20 to 10-29 at xhigh, 9 active days, 1.12B tokens a day, 3,264 calls, 2.56M output, 785 output and 344K total a call; 11-02 to 11-09 at high, 7 active days, 750M a day (-33%), 3,294 calls (flat), 2.43M output (-5%), 739 output (-6%) and 228K total a call (-34%). The drop is shorter contexts (cache reads), not effort: output, which holds the thinking, fell only 6% a call. The work mix differs between the weeks.
- **The merge rule** (Phil, 2026-11-06): merge each item after a fresh sub-agent review and its fixes, without waiting for a try-out; his feedback from real use becomes new work items. Claude Code's auto mode refused a `gh pr merge` into `main` until Phil said "you merge" (2026-11-09).

## Open work

**Nothing is in flight:** no sub-agents are running. Merged into `m5.3/integration` on 2026-11-11, each after a fresh review, its fixes and green CI (details in `PLAN.md`'s items):

- [#240](https://github.com/leggetter/pitwall/pull/240) and [#241](https://github.com/leggetter/pitwall/pull/241): NOW.md answers.
- [#242](https://github.com/leggetter/pitwall/pull/242): W176 (the pitwall plugin), after an xhigh security review.
- [#243](https://github.com/leggetter/pitwall/pull/243): W185 (spike 017, Slack and Notion credentials).
- [#244](https://github.com/leggetter/pitwall/pull/244): W184 (the supervisor's connectors). W186 (its xhigh security review) found F1 to F8, an xhigh verification checked the fixes, and **W186 is done**. F3's residual is accepted: a result under 11,000 tokens but over 50,000 characters is saved whole by Claude Code, in a 0700 folder.
- [#245](https://github.com/leggetter/pitwall/pull/245): W187 (the supervisor pushes the other panels left from 1,200 px).
- [#246](https://github.com/leggetter/pitwall/pull/246) and [#249](https://github.com/leggetter/pitwall/pull/249): W188 (Not for me: dismiss a PR) and its follow-ups.
- [#251](https://github.com/leggetter/pitwall/pull/251): W189 (recaps a cold reader can act on). Phil: "Let's just go with what you've implemented, and I'll provide feedback if I'm still finding that the recaps aren't that effective." His note that the summary repeated other fields led to a prompt fix, not yet measured. Haiku at low effort, the fuller length kept. Re-check repetition and length after a few days of use.

Still to do:

| Item | State |
| --- | --- |
| W165 (a diagnostics log: why a row is in Needs you) | Planned; approved for planning 2026-11-09 ([#199](https://github.com/leggetter/pitwall/pull/199)) |
| W167 (session lineage), W168 (Clear and continue: a hand-off you start with one click; spike 014 is done) | Planned; Phil approved both on 2026-11-09 |
| W171 (a team's open request doesn't keep a reviewed PR in Needs you), W173 (a moved-past to-do), W174 (a working session's to-dos), W175 (a pitwall link opens in a new tab; needs a security review) | Planned (Phil, 2026-11-09, planning only) |
| W178 (ask the supervisor about this session, and why it's in its state), W179 (the supervisor keeps its conversation short) | Planned (Phil, 2026-11-09); W178 uses W165's reasons |
| W190 (a session's title stays on what the session is about: a recap update no longer moves the title off the subject) | Planned (Phil's report, 2026-11-12, [#254](https://github.com/leggetter/pitwall/pull/254)); independent of the rest of M5.3 |
| Left from W164 (M5.1's security review) | F5 (a snooze trusts the relay's name, not its msg_ids), I3's note on attached files, I4 (by design); in the archive's W164 item |
| Left from M5's security notes (Info) | A look-alike name doesn't trigger the resume card's shared-name note; resume errors show a folder outside `untrusted`; the `claude` command list isn't checked against Claude Code 2.1.316's hidden commands |
| Left from M5.1's items | Each item's "Left" is in its archive entry: for example W153's (flag) no retry of a failed ask, W154's (snooze) unseen scheduled wake-ups, W163's (spin-off proposals) overlap check, "Ask the supervisor" and the profile's model, with M6 |
| [#143](https://github.com/leggetter/pitwall/issues/143) (Session view: expand the conversation or terminal to the full page) | Later (Phil, 2026-11-03) |
| W89, the first paste into New session's prompt is lost | Parked (Phil, 2026-11-02): he'll say if it happens again; Grammarly is suspected, not confirmed |
| A flaky test: `src/cli.test.ts` clean-up (`ENOTEMPTY`) | In "Nice to have, later". `src/index/exec.test.ts` "after an abort…" was widened from 2.6 s to 4 s in W188's follow-ups |
| M6, triage | After M5.3; not started |

## Next, in order

1. **Phil's feedback from the 4519 try-out** (`m5.3/integration` at 1c07eb9, before #244): it becomes new work items. Stop that server and remove `.worktrees/tryout` when he's done.
2. **The rest of M5.3** (`PLAN.md`), one session per item (`AGENTS.md`, Efficiency): W165 (a diagnostics log), W167 (session lineage), W168 (Clear and continue), W171 (a team's open request), W173 (a moved-past to-do), W174 (a working session's to-dos), W175 (a pitwall link in a new tab), W178 (ask the supervisor about a session), W179 (the supervisor keeps its conversation short) and W190 (a session's title stays on its subject).
3. **M6 (triage),** on the coordination model ("M6 - Triage" and "Considering: Peers" in `PLAN.md`), with Peers part of it, show only.

## Open questions for Phil

1. **Hosted connectors and policy:** may the supervisor use Slack's and Notion's hosted MCP servers, given that your organisation's managed policy blocks the claude.ai versions? Lean: check with the policy's owner first.
2. **Slack scope:** public channels only, with 4 read scopes? Lean: yes, to start.
3. **Read arguments unguarded by a card (W186's F1):** accept that a connector's read arguments are guarded only by the prompt rule and your choice of tools, with no approval card, with `--connector-tools` flagging URL-fetching tools as the mitigation? Lean: yes.
4. **Spike 017's leftovers:** it left OAuth discovery entries (`notion`, `slack`, `pitwall-test-slack`) inside the `Claude Code-credentials` keychain item. They're harmless; don't delete that item. Lean: leave them.

Answered (Phil, 2026-11-11): go with the leans on the supervisor panel (it pushes, as W187); build W188 now; W176, W184, W185 and W187 run in parallel as sub-agents.

Answered (Phil, 2026-11-11, "go with your leans"): W184 goes ahead after W176; W185 uses Slack and Notion first, Gmail later; finished pitwall sessions are stopped once their work merges (`claude attach <id>` resumes one).

Answered (Phil, 2026-11-10, "go with your leans"): M5.2 → `main` PR as drafted; split M5.2 at W180; build W176 next; builders' decisions confirmed as built (archive's M5.2 work breakdown); the Supervisor button below 1,000 px stays as built (W182).

Older answers (2026-11-06 to 11-09: no user guide for now, W163's card as built, W155 work profiles and the Usage view) were cut from here; they are in this file's git history.

## Standing context

Read these as the work needs them, not all at the start.

- **[`AGENTS.md`](AGENTS.md):** the rules (never touch a real session, pinned dependencies at least 14 days old, security rules, worktrees in `.worktrees/<name>`), "Efficiency", and the commands and layout.
- **[`PLAN.md`](PLAN.md):** read the section the work is in. "Architecture" and "Interfaces pitwall relies on" for what pitwall depends on; "Security" before touching the server, a spawned process or storage; "M5.3" and "M6" for what's next; "Nice to have, later" for small items.
- **[`docs/decisions.md`](docs/decisions.md):** settled decisions D1 to D27 with their reasoning. D4 (the supervisor), D24 (the config file) and D26 (recaps) matter for M5.3.
- **[`docs/design-system.md`](docs/design-system.md):** tokens, layout and components, before a UI change. A UI change runs the app check: [`scripts/appcheck/README.md`](scripts/appcheck/README.md).
- **[`docs/plan-archive.md`](docs/plan-archive.md):** history, for M0 to M5.2: work breakdowns, findings, reviews and decisions. Look a W number up here when an old one is cited.
- **[`docs/spikes/`](docs/spikes/):** what each spike measured; 009 (the supervisor process), 010 (recaps) and 011 (resuming a finished session with a message) are M5's.
- **[`README.md`](README.md):** for newcomers; update it when what pitwall does changes.
