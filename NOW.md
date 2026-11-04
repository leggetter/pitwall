# NOW

The file every session reads first and updates before it ends (the `handoff` skill, `.claude/skills/handoff/SKILL.md`, does this). It says where the work stands and which parts of the plan to read. It is a pointer, so it links to the detail instead of copying it. Keep it under 100 lines.

Last updated: 2026-11-04, on `m5.1/integration`: W136 (the supervisor's context, visible and clearable, and taller cards) merged ([#157](https://github.com/leggetter/pitwall/pull/157)) after a fresh review and the coordinator's fixes. W137 (code blocks in messages wrap their long lines) is next, in review in [#156](https://github.com/leggetter/pitwall/pull/156). Phil's refused message is explained (Open questions 1).

## Current milestone

**M5.1, efficiency, in progress** on `m5.1/integration` (branched from `main` 2026-11-02). Merged into it: W136 [#157](https://github.com/leggetter/pitwall/pull/157) (New conversation, "Context 84K" in the supervisor's header, cards and their band taller), W134 [#155](https://github.com/leggetter/pitwall/pull/155) (the supervisor takes 100K-character messages), the M5 archive, [#141](https://github.com/leggetter/pitwall/pull/141) (fixes #140, recaps of sessions you ended), W130 [#142](https://github.com/leggetter/pitwall/pull/142) (D27: New session in the selected session's directory; fixes #139), [#144](https://github.com/leggetter/pitwall/pull/144) (plan) W131 [#145](https://github.com/leggetter/pitwall/pull/145) (`scripts/usage-report.ts`), W132 [#146](https://github.com/leggetter/pitwall/pull/146) (recaps kept across restarts) and W133 [#148](https://github.com/leggetter/pitwall/pull/148), [#149](https://github.com/leggetter/pitwall/pull/149) (the hand-off hook and the context gauge). M5 is in `main` ([#138](https://github.com/leggetter/pitwall/pull/138)); its detail is in `docs/plan-archive.md`.

- **What the usage showed** (W131; 14 days to 11-02, every repo): 11.35B tokens, 97.7% of them cache reads, 87% of those at more than 200K of context; sub-agents 58%. On 11-02 the pitwall coordinator and its 44 sub-agent runs were about half the day. Phil: "The problem isn't the global rules. It's pitwall" (2026-11-03), so the global rules are set aside for W133.
- **Effort:** Phil's `~/.claude/settings.json` sets Opus 5.5 to high since 10-30 (it was xhigh from about 10-08). The week from 11-02 is the test against 10-20 to 10-29.
- **Security notes left from M5** (Info): a look-alike name doesn't trigger the resume card's shared-name note; resume errors show a folder outside `untrusted`; the `claude` command list isn't checked against Claude Code 2.1.316's hidden commands.

## Open work

| Item | State |
| --- | --- |
| W132, recaps when they're worth it | Merged ([#146](https://github.com/leggetter/pitwall/pull/146)). Its security review's Info notes, left: expiry only at start; `RECAP_STORE_MAX_FILES` isn't ordered by age; a planted file chooses its session's recap text (no wider than writing the transcript) |
| W136 (the supervisor's context, visible and clearable, and taller cards) | Merged ([#157](https://github.com/leggetter/pitwall/pull/157)). The review's blocking finding, fixed before merge: New conversation refused while your messages were queued, which, after a failed resume, left no way out; now it drops them, and its confirmation says so. Its non-blocking finding left: no test of a message or Start arriving while the old process takes time to exit (the code reads right). Not live-checked that `claude -p`'s stream carries `message.usage` |
| W137 (code blocks in messages wrap their long lines) | In review: [#156](https://github.com/leggetter/pitwall/pull/156), `m5.1/wrap-code` (`.worktrees/wrap-code`). `pre-wrap` and `overflow-wrap: anywhere` on `.md-code-scroll`; the `conversation` app check part passed at 375 and 1200, light and dark. Not yet reviewed. It edits `NOW.md` and `PLAN.md`'s M5.1 table, so expect a small conflict |
| W133, a context gauge and a hand-off hook | Merged on 2026-11-03. B ([#148](https://github.com/leggetter/pitwall/pull/148), [spike 012](docs/spikes/012-handoff-hook.md)): a Stop hook in `.claude/settings.json`, nudging at 200K and 400K; it fired in an interactive session too (the coordinator's, at 206K, 2026-11-04), and a session's first turn is never nudged (the transcript lags a call). A ([#149](https://github.com/leggetter/pitwall/pull/149)): "ctx 245K" on rows over 200K, red over 400K, and the number in the session view; forgotten at a compaction until the next call. C, "Hand off" in Needs you, later (Phil, 2026-11-03) |
| [#143](https://github.com/leggetter/pitwall/issues/143) (Session view: expand the conversation or terminal to the full page) | Later (Phil, 2026-11-03) |
| W89, the first paste into New session's prompt is lost | Parked (Phil, 2026-11-02): he'll say if it happens again; Grammarly, which injects itself into the box, is suspected but not confirmed |
| A flaky `src/cli.test.ts` clean-up (`ENOTEMPTY`) | In "Nice to have, later" |
| M6, triage | After M5.1; not started |

## Next, in order

1. **W137, [#156](https://github.com/leggetter/pitwall/pull/156):** a fresh review (high effort), small fixes by the coordinator, merge, `gh run list --branch m5.1/integration` after.
2. **W138 and W139, if Phil agrees** (Open questions 1 and 2), each a row in `PLAN.md`'s "M5.1 work breakdown" first.
3. **W135 (attach a file in the supervisor's message box)** in a worktree, then a fresh review, merge, hand off. The row in `PLAN.md`'s "M5.1 work breakdown". The app check's fake server takes a message body up to 800 KiB now (W134), for a real send of a big file.
4. **Phil runs the latest version and uses it:** `npm ci && npm run build` in the main checkout, restart 4518.
5. **Then break the rest of M5.1 into work items** (work profiles, the Usage view with a run rate, the supervisor applying them; "M5.1 - Efficiency" in `PLAN.md`), with Phil.
6. **On 2026-11-09:** `npx tsx scripts/usage-report.ts --days 7` against the 10-20 to 10-29 figures, for the high-effort week; then one blog-editing session on Sonnet for Phil to judge (agreed; not the evals post).
7. **M6 (triage),** on the coordination model ("M6 - Triage" and "Considering: Peers" in `PLAN.md`), with Peers part of it, show only.

## Open questions for Phil

1. **Replies to the supervisor, refused (proposed W138).** Found (2026-11-04): the "Cross-session message refused" Phil saw in a session's view was that session's own reply to the supervisor, not a message of his; pitwall's relay sent it nothing. The supervisor (`claude -p --name pitwall-supervisor`) runs with `crossSessionInbound: 'refuse'` on purpose (`src/supervisor/prompt.ts`, D4: otherwise any local session could start an Opus turn at his expense), but its messages don't say so, so a session it briefs reports back, spends a turn, and shows Claude Code's notice. Lean: A, pitwall adds one fixed line to every message the supervisor sends, at approval (the approve answer's `updatedInput`, `src/server/supervisorActions.ts`), shown on the card: the supervisor doesn't take replies, report to the user here; and B, the conversation says in pitwall's words when a session's reply to the supervisor was refused, and that its report is above. Not C, taking replies. After W137, before W135.
2. **Selecting a repo with a session open (proposed W139).** Phil (2026-11-04): clicking between repos changes `?repo=` but leaves `?session=`, so a session of another repo stays open; should it open the repo's first session? Lean: not that, since opening a running background session attaches its terminal (W54), and below 1,200 px the view covers the list just chosen. Instead B, keep the session if it's in the selected group's list, otherwise close it to "Select a session"; or D, B plus reopening the session last open in that group, as root tabs keep their place (W38). Lean B now, D if he misses it.

Answered (Phil, 2026-11-04): W136 before W135; W137, code blocks wrap; the drafts band grows to 70% (done in #157); the session under the wrong repo was `?session=` kept across a repo click, by design so far (question 2).

## Standing context

Read these as the work needs them, not all at the start.

- **[`AGENTS.md`](AGENTS.md):** the rules (never touch a real session, pinned dependencies at least 14 days old, security rules, worktrees in `.worktrees/<name>`), "Efficiency", and the commands and layout.
- **[`PLAN.md`](PLAN.md):** read the section the work is in. "Architecture" and "Interfaces pitwall relies on" for what pitwall depends on; "Security" before touching the server, a spawned process or storage; "M5.1", "M6", "Considering: Peers" and "Later: chatting with a session" for what's next; "Nice to have, later" for small items.
- **[`docs/decisions.md`](docs/decisions.md):** settled decisions D1 to D27 with their reasoning. D4 (the supervisor), D8 (the relay), D24 (the config file) and D26 (recaps) matter for what's next.
- **[`docs/design-system.md`](docs/design-system.md):** tokens, layout and components, before a UI change. A UI change runs the app check: [`scripts/appcheck/README.md`](scripts/appcheck/README.md).
- **[`docs/plan-archive.md`](docs/plan-archive.md):** history, for M0 to M5: work breakdowns, findings, reviews and decisions. Look a W number up here when an old one is cited.
- **[`docs/spikes/`](docs/spikes/):** what each spike measured; 009 (the supervisor process), 010 (recaps) and 011 (resuming a finished session with a message) are M5's.
- **[`README.md`](README.md):** for newcomers; update it when what pitwall does changes.
