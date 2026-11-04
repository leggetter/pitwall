# NOW

The file every session reads first and updates before it ends (the `handoff` skill, `.claude/skills/handoff/SKILL.md`, does this). It says where the work stands and which parts of the plan to read. It is a pointer, so it links to the detail instead of copying it. Keep it under 100 lines.

Last updated: 2026-11-04, on `m5.1/integration`: W136 (the supervisor's context, visible and clearable) merged ([#157](https://github.com/leggetter/pitwall/pull/157)) and W137 (code blocks in messages wrap their long lines) merged ([#156](https://github.com/leggetter/pitwall/pull/156)). Then the first efficiency changes, on `m5.1/efficiency-docs`: `AGENTS.md`'s "One session per work item" and cut long lines when reading, and `docs/design-system.md`'s 6,800-character status line moved to the archive. Phil (2026-11-04): next, a fresh session runs `/context`, improves the efficiency from what it shows, then continues pitwall's work.

## Current milestone

**M5.1, efficiency, in progress** on `m5.1/integration` (branched from `main` 2026-11-02). Merged into it: W137 [#156](https://github.com/leggetter/pitwall/pull/156) (code blocks wrap), W136 [#157](https://github.com/leggetter/pitwall/pull/157) (New conversation, "Context 84K" in the supervisor's header, cards and their band taller), W134 [#155](https://github.com/leggetter/pitwall/pull/155) (the supervisor takes 100K-character messages), the M5 archive, [#141](https://github.com/leggetter/pitwall/pull/141) (fixes #140, recaps of sessions you ended), W130 [#142](https://github.com/leggetter/pitwall/pull/142) (D27: New session in the selected session's directory; fixes #139), [#144](https://github.com/leggetter/pitwall/pull/144) (plan) W131 [#145](https://github.com/leggetter/pitwall/pull/145) (`scripts/usage-report.ts`), W132 [#146](https://github.com/leggetter/pitwall/pull/146) (recaps kept across restarts) and W133 [#148](https://github.com/leggetter/pitwall/pull/148), [#149](https://github.com/leggetter/pitwall/pull/149) (the hand-off hook and the context gauge). M5 is in `main` ([#138](https://github.com/leggetter/pitwall/pull/138)); its detail is in `docs/plan-archive.md`.

- **What the usage showed** (W131; 14 days to 11-02, every repo): 11.35B tokens, 97.7% of them cache reads, 87% of those at more than 200K of context; sub-agents 58%. On 11-02 the pitwall coordinator and its 44 sub-agent runs were about half the day. Phil: "The problem isn't the global rules. It's pitwall" (2026-11-03), so the global rules are set aside for W133.
- **Effort:** Phil's `~/.claude/settings.json` sets Opus 5.5 to high since 10-30 (it was xhigh from about 10-08). The week from 11-02 is the test against 10-20 to 10-29.
- **Security notes left from M5** (Info): a look-alike name doesn't trigger the resume card's shared-name note; resume errors show a folder outside `untrusted`; the `claude` command list isn't checked against Claude Code 2.1.316's hidden commands.

## Open work

| Item | State |
| --- | --- |
| W132, recaps when they're worth it | Merged ([#146](https://github.com/leggetter/pitwall/pull/146)). Its security review's Info notes, left: expiry only at start; `RECAP_STORE_MAX_FILES` isn't ordered by age; a planted file chooses its session's recap text (no wider than writing the transcript) |
| W136 (the supervisor's context, visible and clearable, and taller cards) | Merged ([#157](https://github.com/leggetter/pitwall/pull/157)). The review's blocking finding, fixed before merge: New conversation refused while your messages were queued, which, after a failed resume, left no way out; now it drops them, and its confirmation says so. Its non-blocking finding left: no test of a message or Start arriving while the old process takes time to exit (the code reads right). Not live-checked that `claude -p`'s stream carries `message.usage` |
| W137 (code blocks in messages wrap their long lines) | Merged ([#156](https://github.com/leggetter/pitwall/pull/156)). Left: a wrapped line continues from the left edge, not under its indent (accepted); a URL in code that wraps gives its tooltip both lines' box |
| W133, a context gauge and a hand-off hook | Merged on 2026-11-03. B ([#148](https://github.com/leggetter/pitwall/pull/148), [spike 012](docs/spikes/012-handoff-hook.md)): a Stop hook in `.claude/settings.json`, nudging at 200K and 400K; it fired in an interactive session too (the coordinator's, at 206K, 2026-11-04), and a session's first turn is never nudged (the transcript lags a call). A ([#149](https://github.com/leggetter/pitwall/pull/149)): "ctx 245K" on rows over 200K, red over 400K, and the number in the session view; forgotten at a compaction until the next call. C, "Hand off" in Needs you, later (Phil, 2026-11-03) |
| [#143](https://github.com/leggetter/pitwall/issues/143) (Session view: expand the conversation or terminal to the full page) | Later (Phil, 2026-11-03) |
| W89, the first paste into New session's prompt is lost | Parked (Phil, 2026-11-02): he'll say if it happens again; Grammarly, which injects itself into the box, is suspected but not confirmed |
| A flaky `src/cli.test.ts` clean-up (`ENOTEMPTY`) | In "Nice to have, later" |
| M6, triage | After M5.1; not started |

## Next, in order

1. **`gh run list --branch m5.1/integration`** for the efficiency docs' merge and `b31eb66` (#156's merge).
2. **Efficiency, from `/context`** (Phil, 2026-11-04): Phil runs `/context` at the start of the session; read the split of the ~77K baseline with him, then cut it (connectors and plugins pitwall doesn't use, Open question 4), and restructure `PLAN.md`'s longest lines (Security, lines of 2,400 to 6,100 characters, and the M5.1 work-breakdown rows) so a grep doesn't print them whole. Measure the first call's context again after.
3. **W138, then W139** (Phil agreed, 2026-11-04; their detail is in "Answered" below): first a row each in `PLAN.md`'s "M5.1 work breakdown", then each built in its own worktree and session, with a fresh review and a merge. W138: the line is fixed text, shown on the card, added in the approve answer's `updatedInput` (`src/server/supervisorActions.ts`); the conversation's own words for Claude Code's "Cross-session message refused" when the recipient is the supervisor's socket. W139: in the selection code (`web/src/selection.ts`, `web/src/openSession.ts`), and the design system's Session view.
4. **W135 (attach a file in the supervisor's message box)** in a worktree, then a fresh review, merge, hand off. The row in `PLAN.md`'s "M5.1 work breakdown". The app check's fake server takes a message body up to 800 KiB now (W134), for a real send of a big file.
5. **Phil runs the latest version and uses it:** `npm ci && npm run build` in the main checkout, restart 4518.
6. **Then break the rest of M5.1 into work items** (work profiles, the Usage view with a run rate, the supervisor applying them; "M5.1 - Efficiency" in `PLAN.md`), with Phil.
7. **On 2026-11-09:** `npx tsx scripts/usage-report.ts --days 7` against the 10-20 to 10-29 figures, for the high-effort week; then one blog-editing session on Sonnet for Phil to judge (agreed; not the evals post).
8. **M6 (triage),** on the coordination model ("M6 - Triage" and "Considering: Peers" in `PLAN.md`), with Peers part of it, show only.

## Open questions for Phil

1. **Why sessions reach 200K so fast** (Phil, 2026-11-04). Measured on the coordinator's session that day: 77K of context on its first call, before any work (system prompt, tool definitions, the names of every deferred tool from Phil's claude.ai connectors and plugins, the skills list, MCP servers' instructions, both `AGENTS.md`); then 40K of tool results, 55K of its own output and about 37K of messages, sub-agent reports and reminders over 103 calls, 15.7M cache-read tokens in all. The two biggest tool results were greps that matched `docs/design-system.md` line 5, a status line of about 3,000 tokens; `PLAN.md`'s rows are single lines of about 800. Done on `m5.1/efficiency-docs`: the two `AGENTS.md` rules and design-system.md's status line in the archive. Left for Next 2: `PLAN.md`'s long lines, and the baseline.
2. **Phil's connectors** (his call): run `/context` in a fresh pitwall session for the real split of the 77K, and turn off the connectors and plugins pitwall work doesn't use. Whether claude.ai connectors can be turned off per project isn't checked yet.
3. **The backup branch** `backup/integration-local-docs-2026-11-04`: three hand-off commits that were never pushed, only `NOW.md`, kept when the local branch was reset to #157's merge; their content is in this file. Lean: delete it.

Answered (Phil, 2026-11-04): W138, yes, A and B (a fixed line pitwall adds to every message the supervisor sends, at approval, and the refusal of a session's reply said in pitwall's words); W139, B (a repo or directory selected keeps the open session only if it's in that group's list, otherwise closes it to "Select a session"; D, remembering one per group, only if Phil misses it); W136 before W135; W137, code blocks wrap; the drafts band grows to 70% (done in #157); the session under the wrong repo was `?session=` kept across a repo click, by design so far (question 2). Later the same day: spin-off proposals, a session proposing a new session as a card Phil starts, with an overlap check and an "Ask the supervisor" button, designed in `PLAN.md`'s M6 and built with M6; moving a session to another group is a nice-to-have (#160).

## Standing context

Read these as the work needs them, not all at the start.

- **[`AGENTS.md`](AGENTS.md):** the rules (never touch a real session, pinned dependencies at least 14 days old, security rules, worktrees in `.worktrees/<name>`), "Efficiency", and the commands and layout.
- **[`PLAN.md`](PLAN.md):** read the section the work is in. "Architecture" and "Interfaces pitwall relies on" for what pitwall depends on; "Security" before touching the server, a spawned process or storage; "M5.1", "M6", "Considering: Peers" and "Later: chatting with a session" for what's next; "Nice to have, later" for small items.
- **[`docs/decisions.md`](docs/decisions.md):** settled decisions D1 to D27 with their reasoning. D4 (the supervisor), D8 (the relay), D24 (the config file) and D26 (recaps) matter for what's next.
- **[`docs/design-system.md`](docs/design-system.md):** tokens, layout and components, before a UI change. A UI change runs the app check: [`scripts/appcheck/README.md`](scripts/appcheck/README.md).
- **[`docs/plan-archive.md`](docs/plan-archive.md):** history, for M0 to M5: work breakdowns, findings, reviews and decisions. Look a W number up here when an old one is cited.
- **[`docs/spikes/`](docs/spikes/):** what each spike measured; 009 (the supervisor process), 010 (recaps) and 011 (resuming a finished session with a message) are M5's.
- **[`README.md`](README.md):** for newcomers; update it when what pitwall does changes.
