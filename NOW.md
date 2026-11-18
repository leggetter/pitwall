# NOW

The file every session reads first and updates before it ends (the `handoff` skill, `.claude/skills/handoff/SKILL.md`, does this). It says where the work stands and which parts of the plan to read. It is a pointer, so it links to the detail instead of copying it. Keep it under 100 lines.


Last updated: 2026-11-18, on `docs/w202-merged`, by the backlog lead (handing off): W202 (the attached terminal leaks a PTY on every attach) merged into `main` in [#304](https://github.com/leggetter/pitwall/pull/304) at 58a7066 (Phil: "yes, merge it and restart 4518"), after its review's F2 and F3 tests; `main`'s CI green; pitwall-b2 restarted 4518 from it. Before it, on `docs/handoff-w202`, by the backlog lead, handing off at 201K: W202 (the attached terminal leaks a PTY on every attach) is in review in [#304](https://github.com/leggetter/pitwall/pull/304) (Open work); 4518 restarted from `main` at 1f38b53 by pitwall-b2; safe cleanup done (Housekeeping). Before it, on `docs/m5.4-merged`: **M5.4 merged into `main`** in [#302](https://github.com/leggetter/pitwall/pull/302) (Phil: "yes"), at e6c4aae, `main`'s CI green. Before it: W174 (a working session's to-dos for you aren't hidden behind CI) merged in [#296](https://github.com/leggetter/pitwall/pull/296), with Phil's rule (a session waits on you only when you can act now; a wait on another session no longer hides your step); W201 (M5.4's security review, xhigh, of W175, W197 and W168) approved, H3 and H4 (Low) fixed in [#300](https://github.com/leggetter/pitwall/pull/300); [#301](https://github.com/leggetter/pitwall/pull/301) merged `main` back into the integration branch (`src/server/actions.ts` to the integration side); the full app check passed (two runs: the full run hit its 20-minute timeout after 235 cases, then terminal, usage and working-line passed; the default is now 40). M5.4's done items are archived (`docs/plan-archive.md`, "M5.4 work breakdown"). Older entries are in this file's git history. The next free W number is W205.

**Servers:** 4518 runs `main` at 58a7066 (M5.4 and W202), pid 74959, restarted 2026-11-18 at 17:31 by pitwall-b2 (d99e9499, the interactive session that runs it with `nohup node dist/cli.js ~/hookdeck/git ~/leggetter/git --port 4518 --no-open`, logging to `~/.pitwall/pitwall-4518.log`); 0 ptmx open before any attach. Phil's rule (2026-11-18): the lead drives restarts by messaging the session running pitwall. `~/pitwall-plugin-source` is on `main` at 1f38b53 (W202 doesn't touch the plugin).

**Housekeeping done** (Phil, 2026-11-18, "do any cleanup that is safe"): the 53 version-1 kept recaps in `~/.pitwall/recap-store` deleted (pitwall ignores that format since W189; 62 current ones kept), so the "ignored 53 kept recaps" notice stops; 11 local branches merged into `main` and the 5 remote branches this lead merged deleted; `.worktrees/toast-top-align`, `working-job-todos` and `m54-security-review` removed. Kept: `m5.4/integration` and older integration branches on GitHub; `scratch/` outputs. Left as a nice-to-have: pitwall could delete kept recaps of an older version itself on load.

## Current milestone

**After M5.4: small items off `main`** (`PLAN.md`, "After M5.4" and "Open items"). By Phil's answer of 2026-11-18, each item branches from `main` (`w<number>-<name>`, in `.worktrees/<name>`) and merges into `main` for him to try; an integration branch only for a significant change. M5.4 (W165, W167, W168, W171, W173, W174, W175, W193, W197, W201) is in `docs/plan-archive.md`.

- **Coordination** (Phil, 2026-11-10): one coordinating session directs pitwall's work and keeps `NOW.md`. Builders and reviewers are sub-agents, in `.worktrees/<name>`. Each PR gets a fresh sub-agent review and is merged only on green CI.
- **How the backlog lead works** (Phil, 2026-11-18): one item at a time in Next's order; a fresh builder sub-agent, the lead reads the diff and CI, a fresh reviewer (xhigh where the plan asks a security review; a live check on a `pitwall-test-*` job where real typing or processes are involved), small fixes by the lead, `NOW.md` and `PLAN.md` in the same PR, a short update to Phil. Never release or restart 4518; stop and ask on a product or design decision or a second failure. Hand off at about five items or 200K.
- **Merging into `main`:** each PR into `main` is shown to Phil verbatim and merged on his yes (auto mode refuses a `gh pr merge` into `main` without it, 2026-11-09). Docs and plan PRs merge on green.
- **What the usage showed** (W131, 14 days to 11-02): 97.7% of tokens were cache reads, 87% of those past 200K of context; sub-agents 58%. Effort: Opus 5.5 at high since 10-30; the 11-02 to 11-09 drop (-33% a day) was shorter contexts, not effort.

## Open work

- **W203 (the session row's "You:" line and its hover show Claude Code's `<pasted_content>` tags)** merged into `main` on 2026-11-18 in [#308](https://github.com/leggetter/pitwall/pull/308) (Phil's yes, the backlog lead's OK): `userPromptOf()` in `src/index/transcripts.ts` unwraps the tags before truncating. On 4518 after its next restart.
- **W204 (the Session view's conversation shows the same `<pasted_content>` tags)** merged into `main` on 2026-11-18 in [#310](https://github.com/leggetter/pitwall/pull/310) (Phil's yes, a fresh review): the user entry in `src/index/conversation.ts` drops the tags with `removePasteTags()` and keeps the pasted text's lines and indents; a prompt that was only an empty paste gives no entry. The backlog lead has pitwall-b2 restart 4518 once W178 lands. Not changed: the recap's input and the supervisor's rows, which are model input.
- **In review: W178 (ask the supervisor about this session, and why it's in its state)** in [#309](https://github.com/leggetter/pitwall/pull/309), from `w178-supervisor-ask-session`; fresh review: approve, Low findings fixed by the lead (a PR title cut at 120 characters in the box, the design system's entry, a comment): `why_state` and `pitwall_states` tools, `docs/states.md`, prompt version 11, and Ask the supervisor in a session's actions menu and a PR's view. See `PLAN.md`, W178.
- **W202 (the attached terminal leaks a PTY on every attach)** merged into `main` on 2026-11-18 in [#304](https://github.com/leggetter/pitwall/pull/304): `closeStrayTerminals()` in `src/server/pty.ts` closes the slave and spare `/dev/ptmx` node-pty 1.1.0 leaves per spawn on macOS. Live-checked by a fresh review (0 ptmx and 0 revoked after 5 rounds and 2 simultaneous attaches); its F2 and F3 tests added. Left: one kqueue descriptor per spawn (node-pty's). `.worktrees/attach-pty-leak` is the fix-attach-pty-leak session's; it can go once that session ends.
- **Once M5.4 is on 4518:**
  - A finished session already in Needs you from an old recap's to-do stays there until you press Refresh on its recap (W173; `RECAP_STORE_VERSION` stays 2).
  - W165's diagnostics log (`~/.pitwall/diagnostics.jsonl`, `scripts/diagnostics-report.ts`) starts writing.
- **Left from M5.4** (archive entries): W201's H1 (Clear and continue's window before each Enter: also wait for a quiet PTY) and H2 (rate-limit the link check's lsof); W174's F2 to F4; W168's: Phil's global handoff skill now ends with the `spin-off` block ([leggetter/phil-skills#10](https://github.com/leggetter/phil-skills/pull/10), merged), and a `PITWALL_HOME` not 0700 silently drops `lineage.jsonl` and `server.json`; W167's: a wake under a new id without `/clear` is logged as `clear`; W197's: the resume card still offers the profile picker for a stopped job.
- **A Resume made a copy** (2026-11-17): 4518's `main` added `--model`/`--effort` to a stopped job's resume (W197's review F1). Fixed on `main` in #290; 4518 has it after the restart. W196 (a resume's copy cleaned up) covers what's left.

Still to do:

| Item | State |
| --- | --- |
| W194 (a resumed job's recap and conversation read its latest transcript; a security review with W167's), W195 (Not for me on a session row its PR puts in Needs you) | Planned (Phil, 2026-11-16) |
| W196 (a resume that finds the session open elsewhere stops and removes the copy it caused, and says "Not resumed") | Planned (Phil, 2026-11-17) |
| W198 ("Added folder not trusted" says how to fix it: the hint, and a startup check that the attachments folder is trusted) | Planned (Phil, 2026-11-17). The failure itself is fixed on this machine: `~/.pitwall/attachments` is trusted |
| W199 (a snooze holds the session's PR too: a snoozed session's row leaves Needs you even while its PR needs attention, until the PR has something new) | Planned (Phil, 2026-11-18) |
| W200 (a mention owns a PR inside the PR's repo: no "New session for #N" row while a session in that repo works on the PR) | Planned (Phil approved fix A, 2026-11-18, via ac6ba646's investigation) |
| W178 (ask the supervisor about this session, and why it's in its state), W179 (the supervisor keeps its conversation short) | Planned (Phil, 2026-11-09); W178 uses W165's reasons |
| W191 (the supervisor reads through the connectors your sessions already have, with pitwall's read-only limits) | Planned (Phil, 2026-11-12); a spike first; revises W184's route |
| Left from W164 (M5.1's security review) | F5 (a snooze trusts the relay's name, not its msg_ids), I3's note on attached files, I4 (by design); in the archive's W164 item |
| Left from M5's security notes (Info) | A look-alike name doesn't trigger the resume card's shared-name note; resume errors show a folder outside `untrusted`; the `claude` command list isn't checked against Claude Code 2.1.316's hidden commands |
| Left from M5.1's items | Each item's "Left" is in its archive entry: for example W153's (flag) no retry of a failed ask, W154's (snooze) unseen scheduled wake-ups, W163's (spin-off proposals) overlap check, "Ask the supervisor" and the profile's model, with M6 |
| [#143](https://github.com/leggetter/pitwall/issues/143) (Session view: expand the conversation or terminal to the full page) | Later (Phil, 2026-11-03) |
| W89, the first paste into New session's prompt is lost | Parked (Phil, 2026-11-02): he'll say if it happens again; Grammarly is suspected, not confirmed |
| Flaky tests: `src/cli.test.ts` clean-up (`ENOTEMPTY`); `web/src/components/Markdown.test.tsx` "renders 32 KiB of dense everyday markdown" (507 to 551 ms against 500, all three tries, on #275's integration CI run, 2026-11-16); `src/index/conversation.test.ts` paging timed out at 5 s once under load | In "Nice to have, later". `src/index/exec.test.ts` "after an abort…" was widened from 2.6 s to 4 s in W188's follow-ups |
| M6, triage | After M5.3; not started |

## Next, in order

1. **W178 (ask the supervisor about this session, and why it's in its state),** in review in [#309](https://github.com/leggetter/pitwall/pull/309); merge into `main` on Phil's yes.
2. **The other open items** (`PLAN.md`, "Open items"), one at a time: W179 (the supervisor keeps its conversation short), W191 (the supervisor uses your sessions' connectors; a spike first), W196 (a resume's copy cleaned up), W198 (the attachments folder's trust), W194 (a resumed job's latest transcript), W195 (Not for me on a session row), W199 (a snooze holds the session's PR too) and W200 (a mention owns a PR inside the PR's repo).
3. **M6 (triage),** on the coordination model ("M6 - Triage" and "Considering: Peers" in `PLAN.md`), with Peers part of it, show only.

## Open questions for Phil

None open.

Answered (Phil, 2026-11-18): merge M5.4 into `main` ("yes", #302); remove the W174 worktree ("if it's completed, yes", done). Where hand-off files live was answered earlier that day ("go with it": committed at the root in Phil's own repos, untracked `.handoff/` in team repos, a dated `handoffs/` folder for cross-repo work), with the `spin-off` ending, in [leggetter/phil-skills#10](https://github.com/leggetter/phil-skills/pull/10). Older answers are in this file's git history.

## Standing context

Read these as the work needs them, not all at the start.

- **[`AGENTS.md`](AGENTS.md):** the rules (never touch a real session, pinned dependencies at least 14 days old, security rules, worktrees in `.worktrees/<name>`), "Efficiency", and the commands and layout.
- **[`PLAN.md`](PLAN.md):** read the section the work is in. "Architecture" and "Interfaces pitwall relies on" for what pitwall depends on; "Security" before touching the server, a spawned process or storage; "M5.4" and "M6" for what's next; "Nice to have, later" for small items.
- **[`docs/decisions.md`](docs/decisions.md):** settled decisions D1 to D27 with their reasoning. D4 (the supervisor), D24 (the config file), D26 (recaps) and D28 (the supervisor's read-only connectors) matter for M5.4.
- **[`docs/design-system.md`](docs/design-system.md):** tokens, layout and components, before a UI change. A UI change runs the app check: [`scripts/appcheck/README.md`](scripts/appcheck/README.md).
- **[`docs/plan-archive.md`](docs/plan-archive.md):** history, for M0 to M5.3: work breakdowns, findings, reviews and decisions. Look a W number up here when an old one is cited.
- **[`docs/spikes/`](docs/spikes/):** what each spike measured; 009 (the supervisor process), 010 (recaps) and 011 (resuming a finished session with a message) are M5's.
- **[`README.md`](README.md):** for newcomers; update it when what pitwall does changes.
