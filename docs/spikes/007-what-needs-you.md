# Spike 007: what says a session needs you

Run on 2026-10-27 against Claude Code 2.1.311 on macOS, after W66's live check found that a session pitwall resumed counted in Needs you though it had asked nothing. Phil, the same day: "only show 'needs you' if I (the user) specifically clicks attach/restart. At startup, I think there needs to be an assessment of whether a session does Need me (the user). In fact, the context of the session should really determine if anything is needed of the user."

Two throwaway Haiku background sessions, `pitwall-test-needs-a` and `-b`, ran in the pitwall checkout and were removed afterwards, with their transcripts and `session-env` folders. Phil's own sessions were read for field names, entry types and counts: `claude agents --json --all`, the keys of each background job's `state.json`, and the entry types of his recent transcripts. The one exception: to check whether they were questions, the `needs` lines of his four blocked jobs were read, cut to 60 characters. None is quoted here.

## Why

- **Today's rule** (`needsAttention()`, `web/src/sessions.ts`): a session needs you when it's `waiting`, `blocked` or has `askedYou`, and isn't stale or finished.
- **The W66 live check:** an ended interactive session that pitwall resumed came back `blocked`, because Claude Code's job said `needs: "send a prompt to start"`. So it showed a solid Blocked badge and counted in Needs you, though it had asked nothing.

## Questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | What does Claude Code record about what a background session needs? | A one-line `needs` in the job's `state.json`, absent when it needs nothing (finding 1) |
| 2 | Is that in a documented interface? | No. `claude agents --json` doesn't carry it (finding 2) |
| 3 | Does it survive a stop and a restart? | No. A stop clears it, and a restarted session has none (finding 3) |
| 4 | What does survive? | The transcript: the question is still the newest assistant message, and the turn's end is marked (finding 4) |
| 5 | What about interactive sessions? | No `needs` line. Claude Code's recap, `away_summary`, is the nearest thing (findings 5 and 8) |
| 6 | Is Claude Code's `busy` a sign that a turn is running? | Not while a plugin's monitor runs (finding 6) |
| 7 | How do Phil's sessions look today? | 4 blocked jobs, each with a real question in its `needs` line (finding 7) |

## Findings

1. **Claude Code writes its own line on what a background job needs.**
   - **a** asked a question and stopped: `state: "blocked"`, `tempo: "blocked"`, and `needs` and `detail` both the question, "Do you prefer tea or coffee?".
   - **b** replied and finished: `state: "done"`, `tempo: "idle"`, `detail` a one-line account of what it did, and no `needs`.
   - Some of Phil's jobs also have `suggestedReply`, a short reply Claude Code offers.
   - `state.json` is internal; the interfaces table in `PLAN.md` already lists the `needs` line as "documented as not stable".

2. **`claude agents --json` doesn't carry it.** Phil's 11 rows had 9 keys between them: `id`, `cwd`, `kind`, `startedAt`, `sessionId`, `name`, `state`, `pid` and `status`. None had `waitingFor`, which comes only with a live prompt.

3. **The line doesn't survive a restart.**
   - **Stop:** `claude stop` on a set `state: "stopped"` and `detail: "stopped"`, and removed `needs`.
   - **Resume:** `claude --resume <id> --bg` on the stopped job printed `note: woke session a6f62031 with its saved options (--name, --model).` It came back `state: "running"` with an empty `detail` and no `needs`. That's unlike an ended interactive session, which gets a new job, `blocked` with `needs: "send a prompt to start"` (spike 006, finding 2).
   - **Attach:** `claude attach` on the stopped job, as pitwall runs it after you confirm a restart (D9), printed "Waking session…", showed the transcript, and left the same state: running, with no `needs`.
   - **So:** what Claude Code knew about the question goes with the stop. A restarted session says nothing, or "send a prompt to start".

4. **The transcript keeps the context.**
   - After both restarts, a's newest assistant message was still the question. No restart wrote a `user` or `assistant` entry.
   - Its turn ended with two `system` entries, `stop_hook_summary` and `turn_duration`.
   - Across Phil's 27 interactive transcripts written in the last 7 days, all 27 have `turn_duration` entries. 23 end with one after their newest assistant message; the other 4 were mid-turn.
   - So pitwall can tell a finished turn from the transcript alone, without Claude Code's status.

5. **Interactive sessions have no `needs` line.** `~/.claude/sessions/<pid>.json` holds `status`, the name and the messaging socket, and nothing like `needs`. Claude Code reports `status: "waiting"` with `waitingFor` only while a prompt is on screen. So for an interactive session, the context is the transcript: pitwall's `askedYou` heuristic, and the recap in finding 8.

6. **A plugin's monitor keeps a session busy.**
   - After each restart, a reported `status: "busy"` and `state: "working"` with no turn running. Its screen said "1 monitor still running".
   - `askedYou` is set only when Claude Code's status says the turn is over (`turnIsOver()`, `src/index/summaries.ts`). So it never fired on a, though its last turn asked a question.
   - One of Phil's live background sessions was listed as `working` while its `state.json` said `blocked`. Whether a monitor caused that wasn't checked.

7. **Phil's sessions on 2026-10-27:**
   - **Listed:** 11 rows: 4 background jobs blocked with no process, 4 done, 1 working, and 2 interactive sessions busy.
   - **The 4 blocked jobs:** all have a `needs` line, each a question for Phil, and none is "send a prompt to start".
   - **So:** on today's sessions, a rule based on the `needs` line and today's rule agree. They differ after a restart.

8. **Claude Code's recap, `away_summary`.**
   - When you've been away from a session, Claude Code writes a `system` entry, `subtype: "away_summary"`, whose `content` is a short recap of where things stand. It's in interactive and background sessions alike. `/config` can turn recaps off.
   - **How often:** 642 in Phil's transcripts from the last 7 days, about 230 characters each.
   - **What they say:** the one read in full, from the coordinator's own session, named the next thing the user had to do, a merge.
   - **Its limits:** it's prose, not a yes or no, so deciding from it whether a session needs you would need a model. That's M6's job: "the supervisor reads each idle session's latest turns and judges whether it really needs me".

## Recommendation

**The rule:** a session needs you when its context says so. Each reason is checked on every snapshot, including pitwall's first, so after a restart Needs you is this assessment, not Claude Code's bare state.

1. **A prompt on screen:** `status: "waiting"`, as now.
2. **Claude Code's line:** a background job's `needs`, shown as the reason. Its start placeholder, "send a prompt to start", doesn't count.
3. **The last turn asked you:** `askedYou`, with the turn's end read from the transcript (finding 4), so a monitor or a restart doesn't hide it.
4. **You brought it back:** you pressed Resume, or confirmed a restart, in pitwall. It counts until a prompt is sent to it (Phil's words above).
5. **Nothing else.** `state: "blocked"` alone stops counting whenever pitwall could read the job's `state.json`. If it couldn't, because the file is missing, unreadable or changed, the old rule applies, so a question is never hidden.

**Not now:** using the recap, or a model's judgement, to decide. Both are M6's refinement of rule 3, and they can start from these reasons.
