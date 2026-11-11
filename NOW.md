# NOW

The file every session reads first and updates before it ends (the `handoff` skill, `.claude/skills/handoff/SKILL.md`, does this). It says where the work stands and which parts of the plan to read. It is a pointer, so it links to the detail instead of copying it. Keep it under 100 lines.


Last updated: 2026-11-11, on `docs/m5.3-answers`: Phil's answers on W184, W185 and stopping finished sessions; the supervisor's click-away close asked. Before it, 2026-11-10, evening, on `docs/m5.3-coordination`: M5.2 is merged into `main` ([#234](https://github.com/leggetter/pitwall/pull/234)), and `m5.3/integration` is branched from it with [#236](https://github.com/leggetter/pitwall/pull/236) (fix(mcp): list_sessions reports `prOpen` null, not false, for a PR it didn't fetch; merged straight into `main`), [#237](https://github.com/leggetter/pitwall/pull/237) (docs: D28, the supervisor reads through read-only connectors; spike 016 (read-only connectors under the strict command line); W183 to W186) and [#238](https://github.com/leggetter/pitwall/pull/238) (fix(web): the supervisor's Sent and started rows on one line, the name said once). Phil answered the five M5.2 questions ("go with your leans"), listed below. The next free W number is W187.

**Servers:** 4518 runs `main` at f4458a7, restarted 21:44 on 2026-11-10. The 4519 try-out is stopped and its worktree removed.

## Current milestone

**M5.3, after M5.2, in progress,** on `m5.3/integration` (`PLAN.md`, "M5.3 - After M5.2" and "M5.3 work breakdown"). M5.2 (efficiency) is done and merged: its detail is in `docs/plan-archive.md` ("M5.2 - Efficiency", "M5.2 work breakdown"), with M0 to M5.1 before it.

- **Coordination** (Phil, 2026-11-10): one coordinating session directs pitwall's work and keeps `NOW.md`. Other pitwall sessions open PRs into `m5.3/integration` and report to the coordinator; they don't edit `NOW.md`. Builders and reviewers are sub-agents, in `.worktrees/<name>`. Each PR gets a fresh sub-agent review and is merged only on green CI. No other pitwall session has work in progress (asked 2026-11-10).
- **What the usage showed** (W131, the usage report; 14 days to 11-02, every repo): 11.35B tokens, 97.7% of them cache reads, 87% of those at more than 200K of context; sub-agents 58%. Phil: "The problem isn't the global rules. It's pitwall" (2026-11-03).
- **Effort:** Phil's `~/.claude/settings.json` sets Opus 5.5 to high since 10-30 (it was xhigh from about 10-08). Measured 2026-11-09 (`usage-report.ts --days 21 --json`, by day, every repo): 10-20 to 10-29 at xhigh, 9 active days, 1.12B tokens a day, 3,264 calls, 2.56M output, 785 output and 344K total a call; 11-02 to 11-09 at high, 7 active days, 750M a day (-33%), 3,294 calls (flat), 2.43M output (-5%), 739 output (-6%) and 228K total a call (-34%). The drop is shorter contexts (cache reads), not effort: output, which holds the thinking, fell only 6% a call. The work mix differs between the weeks.
- **The merge rule** (Phil, 2026-11-06): merge each item after a fresh sub-agent review and its fixes, without waiting for a try-out; his feedback from real use becomes new work items. Claude Code's auto mode refused a `gh pr merge` into `main` until Phil said "you merge" (2026-11-09).

## Open work

| Item | State |
| --- | --- |
| **W176 (a pitwall plugin: every session knows it's watched, links sessions, and can propose one)** | **First in M5.3** (Phil, 2026-11-10), from spike 015's design (`docs/spikes/015-plugin-session-note.md`): a fresh session; the plugin's `SessionStart` note points a session at W163's (spin-off proposals) `spin-off` block |
| list_sessions `pr` lookup said `prOpen: false` for an open PR it never fetched (hookdeck/hookdeck-cli#490, 2026-11-10) | PR open: `prOpen` is now `true` (listed) or `null` (not fetched, state unknown) with a `prNote`. Which PRs are fetched is unchanged (Phil: it works as wanted). A per-repo opt-in is noted in PLAN.md's Nice to have |
| W165 (a diagnostics log: why a row is in Needs you) | Planned; approved for planning 2026-11-09 ([#199](https://github.com/leggetter/pitwall/pull/199)) |
| W167 (session lineage), W168 (Clear and continue: a hand-off you start with one click; spike 014 is done) | Planned; Phil approved both on 2026-11-09 |
| W171 (a team's open request doesn't keep a reviewed PR in Needs you), W173 (a moved-past to-do), W174 (a working session's to-dos), W175 (a pitwall link opens in a new tab; needs a security review) | Planned (Phil, 2026-11-09, planning only) |
| W178 (ask the supervisor about this session, and why it's in its state), W179 (the supervisor keeps its conversation short) | Planned (Phil, 2026-11-09); W178 uses W165's reasons |
| Left from W164 (M5.1's security review) | F5 (a snooze trusts the relay's name, not its msg_ids), I3's note on attached files, I4 (by design); in the archive's W164 item |
| Left from M5's security notes (Info) | A look-alike name doesn't trigger the resume card's shared-name note; resume errors show a folder outside `untrusted`; the `claude` command list isn't checked against Claude Code 2.1.316's hidden commands |
| Left from M5.1's items | Each item's "Left" is in its archive entry: for example W153's (flag) no retry of a failed ask, W154's (snooze) unseen scheduled wake-ups, W163's (spin-off proposals) overlap check, "Ask the supervisor" and the profile's model, with M6 |
| [#143](https://github.com/leggetter/pitwall/issues/143) (Session view: expand the conversation or terminal to the full page) | Later (Phil, 2026-11-03) |
| W89, the first paste into New session's prompt is lost | Parked (Phil, 2026-11-02): he'll say if it happens again; Grammarly is suspected, not confirmed |
| A flaky `src/cli.test.ts` clean-up (`ENOTEMPTY`) | In "Nice to have, later" |
| M6, triage | After M5.3; not started |

## Next, in order

1. **W176 (the pitwall plugin) first,** in a fresh session, from spike 015's design (`docs/spikes/015-plugin-session-note.md`).
2. **Then the rest of M5.3** (`PLAN.md`), one session per item (`AGENTS.md`, Efficiency): W165, W167, W168, W171, W173, W174, W175, W178, W179.
3. **W184 (the supervisor's connectors), W185 (spike: Slack, Notion and Gmail with real accounts) and W186 (their security review),** once Phil says go (open questions); one session each.
4. **One blog-editing session on Sonnet for Phil to judge** (agreed; not the evals post).
5. **M6 (triage),** on the coordination model ("M6 - Triage" and "Considering: Peers" in `PLAN.md`), with Peers part of it, show only.

## Open questions for Phil

1. **The supervisor's panel closes when you click away?** (Phil, 2026-11-11: "the supervisor dialog should probably close when you click away".) Lean: **only where it covers the page,** below 1,200 px, where the view behind is inert: a click on the covered part closes it. At 1,200 px and wider it sits beside the view and stays open while you change the selection, which was W177's (the supervisor opens over the page) point. Never when it would lose work: a message typed in its box, or a card being edited, keeps it open, as Escape already does. Escape and the header's Supervisor button (W182) still close it. If yes, it's W187.

Answered (Phil, 2026-11-11, "go with your leans"): W184 (the supervisor's connectors) goes ahead after W176 (the pitwall plugin); W185 (spike: real accounts) uses Slack and Notion first, Gmail later; finished pitwall sessions are stopped once their work merges ("supervisor table layout" and "pitwall-slack-notion-access" stopped 2026-11-11; `claude attach <id>` resumes one).

Answered (Phil, 2026-11-10, "go with your leans"): (a) the M5.2 → `main` PR as drafted; (b) split M5.2 at W180, as M5.1 was at W164; (c) build W176 (the pitwall plugin) next, as M5.3's first item; (d) the builders' decisions are confirmed as built (recorded in the archive's M5.2 work breakdown: W156, W158, W159, W160, W177, W180); (e) the Supervisor button below 1,000 px stays as built (W182, the supervisor's button in the header).

Answered (Phil, 2026-11-09, "go with your leans"): no user guide for now; the README stays the only user-facing description of what pitwall does, and is revisited when its "What it does" outgrows a screen or someone asks how a feature works (the repo is already public, so the earlier "until it goes public" didn't apply). W163's (spin-off proposals) card stays as built: over Needs you's rows, dismissals kept per browser, the folder checked at Start. W138's (the supervisor's messages say they're from it) footer stays, though it wraps to 3 lines in a draft card at 1,200 px.
Answered (Phil, 2026-11-09): the M5.1 → `main` PR text, opened as written ([#197](https://github.com/leggetter/pitwall/pull/197)), and merged on green.
Answered (Phil, 2026-11-06): W155 (work profiles) sets the sub-agent model as a default only, not forced, revisited with W158's (the Usage view) figures; profiles are launch settings plus an optional skill to start with; the run rate's target line is a weekend reserve; profiles first; the four built-in profiles; and the stand-in cost, set against `/usage`, only if spike 013 can't read the percentage.

## Standing context

Read these as the work needs them, not all at the start.

- **[`AGENTS.md`](AGENTS.md):** the rules (never touch a real session, pinned dependencies at least 14 days old, security rules, worktrees in `.worktrees/<name>`), "Efficiency", and the commands and layout.
- **[`PLAN.md`](PLAN.md):** read the section the work is in. "Architecture" and "Interfaces pitwall relies on" for what pitwall depends on; "Security" before touching the server, a spawned process or storage; "M5.3" and "M6" for what's next; "Nice to have, later" for small items.
- **[`docs/decisions.md`](docs/decisions.md):** settled decisions D1 to D27 with their reasoning. D4 (the supervisor), D24 (the config file) and D26 (recaps) matter for M5.3.
- **[`docs/design-system.md`](docs/design-system.md):** tokens, layout and components, before a UI change. A UI change runs the app check: [`scripts/appcheck/README.md`](scripts/appcheck/README.md).
- **[`docs/plan-archive.md`](docs/plan-archive.md):** history, for M0 to M5.2: work breakdowns, findings, reviews and decisions. Look a W number up here when an old one is cited.
- **[`docs/spikes/`](docs/spikes/):** what each spike measured; 009 (the supervisor process), 010 (recaps) and 011 (resuming a finished session with a message) are M5's.
- **[`README.md`](README.md):** for newcomers; update it when what pitwall does changes.
