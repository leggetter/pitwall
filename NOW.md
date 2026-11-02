# NOW

The file every session reads first and updates before it ends (the `handoff` skill, `.claude/skills/handoff/SKILL.md`, does this). It says where the work stands and which parts of the plan to read. It is a pointer, so it links to the detail instead of copying it. Keep it under 100 lines.

Last updated: 2026-11-02, on `m5/integration`. This file lives on the integration branch, like `PLAN.md`; `main` doesn't have it until M5 merges.

## Current milestone

**M5, the supervisor, on `m5/integration`.** Built, not yet in `main`. Its pull requests, [#110](https://github.com/leggetter/pitwall/pull/110) to [#124](https://github.com/leggetter/pitwall/pull/124) (W110 to W122), are merged into the integration branch: per-session recaps, pitwall's MCP server, the supervisor process and its panel, approvals, New session from here, model and effort per kind of work, W116's findings, recaps as a summary and to-dos, and a wider Preferences.

- **Security:** W116's review of M5 blocked on F1; W120 fixed its findings, and W116's re-check left two Info items, which are in "Nice to have, later". The re-check's verdict isn't recorded in `PLAN.md`; confirm it approved before the merge into `main`.
- **Merging into `main`** waits on Phil's try-out and his word. The full app check (`npm run appcheck`) is for that merge (AGENTS.md, "Efficiency").

## Open work

| Item | State |
| --- | --- |
| W123, Plan status on the recap strip | In review, [#125](https://github.com/leggetter/pitwall/pull/125) (feat: W123, Plan status on the recap strip) |
| M5 try-out | Phil's, not started |
| W86, bump `vite` and `happy-dom` | Phil approved (2026-10-28); on or after 2026-11-04, when the fixes are 14 days old |
| W89, the first paste into New session's prompt is lost | Investigating; Phil retries on M3.1's build in Dia, then with Grammarly off, and in another field |
| M5.1, efficiency | After M5; not started |
| M6, triage | After M5.1; not started |

## Next, in order

1. **Review and merge #125 (W123)** into `m5/integration`: a fresh reviewer, then the coordinating session merges, then check CI on the branch.
2. **Phil tries M5** on `m5/integration`. Fix what he finds on the branch.
3. **Merge `m5/integration` into `main`**, on Phil's word, after the full app check.
4. **M5.1, efficiency** (work profiles, a Usage view with a run rate, the supervisor applying them): "M5.1 - Efficiency" in `PLAN.md`.
5. **W86** on or after 2026-11-04: `npm install <pkg>@<version> --before=<date>`, the newest version at least 14 days old.
6. **W89**, once Phil has retried.
7. **M6, triage.** Then the considerations: Peers, chatting with a session, a session asking the supervisor to spin off work.

## Open questions for Phil

- **Is M5 ready for `main`?** It waits on your try-out and your word. Lean: merge once the try-out is clean and #125 is in.
- **Is W116's re-check an approval?** `PLAN.md` records the F1 block and the fix (W120) and two Info items from the re-check, but not the verdict. Lean: yes, from "W116's re-check" in "Nice to have, later".
- **W89, the lost first paste:** is it pitwall or the browser? Needs you to retry on M3.1's build in Dia, with Grammarly off, and in another field. No lean; the app check's traces showed none of pitwall's handlers blocking it.
- **Should the supervisor survive pitwall restarts?** Lean: yes. It stops with pitwall and pitwall resumes its conversation by session id on the next run; spike 009 checked that `--resume` keeps the conversation, and W113 built it. Listed as open in `PLAN.md`; say if it can be closed.
- **Peers ([#99](https://github.com/leggetter/pitwall/issues/99), Peers: sessions talking to each other):** build it at all? Undecided. The name is settled. #99's lean: "To *name*" entries and links in the conversation, a Peers tab after Sub-agents, and "waiting on a peer" as one of M6's reasons.
- **Cursor's Claude Code extension panel:** do you use it? Its sessions keep a separate list and may not appear in `claude agents --json`. No lean.

## Standing context

Read these as the work needs them, not all at the start.

- **[`AGENTS.md`](AGENTS.md):** the rules (never touch a real session, pinned dependencies at least 14 days old, security rules, worktrees in `.worktrees/<name>`), "Efficiency", and the commands and layout.
- **[`PLAN.md`](PLAN.md):** read the section the work is in. "Architecture" and "Interfaces pitwall relies on" for what pitwall depends on; "Security" before touching the server, a spawned process or storage; "M5 - Supervisor" and "M5 work breakdown" for M5; "M5.1", "M6", "Considering: Peers" and "Later: chatting with a session" for what's after; "Nice to have, later" for small items.
- **[`docs/decisions.md`](docs/decisions.md):** settled decisions D1 to D26 with their reasoning. D4 (the supervisor), D8 (the relay), D24 (the config file) and D26 (recaps) matter for M5.
- **[`docs/design-system.md`](docs/design-system.md):** tokens, layout and components, before a UI change. A UI change runs the app check: [`scripts/appcheck/README.md`](scripts/appcheck/README.md).
- **[`docs/plan-archive.md`](docs/plan-archive.md):** history, for M0 to M4: work breakdowns, findings, reviews and decisions. Look a W number up here when an old one is cited.
- **[`docs/spikes/`](docs/spikes/):** what each spike measured; 009 (the supervisor process) and 010 (recaps) are M5's.
- **[`README.md`](README.md):** for newcomers; update it when what pitwall does changes.
