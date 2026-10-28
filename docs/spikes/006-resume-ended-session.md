# Spike 006: resuming an ended interactive session

Run on 2026-10-26 against Claude Code 2.1.310 on macOS, for "M3.1 - After M3" item 2 (W65). Three throwaway interactive sessions on Haiku, `pitwall-test-resume-a` to `-c`, each started in a PTY with the variables pitwall's `childEnvironment()` drops removed. B and C ran in the pitwall checkout, a directory Phil had already trusted.

No real session was messaged, attached to, resumed, stopped or removed. What the test sessions left, one transcript and two `session-env` folders, was deleted afterwards. The counts of Phil's own sessions in finding 7 read only entry types, timestamps and the `entrypoint`, `cwd` and `sessionKind` fields, never message text.

## Questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Does an ended interactive session leave `claude agents`? | Yes, from `--all` too, once its process exits. Its transcript stays (finding 1) |
| 2 | Does `claude --resume <id> --bg` bring it back without a prompt? | Yes: exit 0 in 0.7 s, the same session id, idle in the background, waiting for a prompt (finding 2) |
| 3 | Does it keep its name and model? | Both. The model comes from the transcript, not from saved flags (finding 3) |
| 4 | Can pitwall drive it then? | Yes, with `claude attach`, as any background session (finding 4) |
| 5 | What if its terminal is still open? | Claude Code starts an unnamed copy under a new id, and still exits 0 (finding 5) |
| 6 | Do `claude stop` and `claude rm` delete its conversation? | No. The transcript stays (finding 6) |
| 7 | How does pitwall find one, and how many are there? | From transcripts, by four fields. 17 under Phil's two roots in the last 7 days (finding 7) |

## Method

- **Driver:** a Python script that runs `claude` in a 120 × 40 PTY, waits for output to go quiet, types a prompt and Enter, and ends with `/exit`. It types nothing while a trust prompt or any "Enter to confirm" dialog is on screen, and stops the session instead.
- **Environment:** `env -u` for each variable `childEnvironment()` drops (`src/index/exec.ts`), as pitwall's own children run.
- **Sessions:**
  - **A:** a first run, discarded (finding 8).
  - **B:** asked for "pong", then `/exit`; then resumed with `claude --resume <id> --bg`, attached to with `claude attach`, given one more prompt, stopped and removed.
  - **C:** held open with no prompt while `claude --resume <id> --bg` ran on it; the copy it started was stopped and removed.
- **Checks:** `claude agents --json [--all]` after each step, the job's `~/.claude/jobs/<id>/state.json`, and the session's transcript.

## Findings

1. **An ended interactive session leaves the list, and its transcript stays.**
   - After `/exit`, B was gone from `claude agents --json --all` at the next call.
   - That matches what Phil saw after the 2026-10-23 restart: only background sessions were left.

2. **`claude --resume <id> --bg` needs no prompt.**
   - Run in B's directory with stdin closed, it exited 0 in 0.7 s.
   - It printed `backgrounded · 5e66fcb3 (idle — send a prompt to start)`, then the `attach`, `logs` and `stop` commands.
   - `claude agents --json` then listed it with the same `sessionId`, `kind: "background"`, `status: "idle"`, `state: "blocked"` and a new pid. Its `id`, the short id, is the session id's first 8 characters.
   - The job's `state.json` said `needs: "send a prompt to start"`.
   - With no prompt, no message text reaches the command line. Spike 003 saw the prompt in `ps` when one is passed.

3. **It keeps its name and its model.**
   - The name `pitwall-test-resume-b` carried over.
   - The job's `respawnFlags` were empty, so `--model haiku` wasn't saved as a flag. The next turn still ran on `claude-haiku-5-5`: Claude Code takes the model from the transcript.
   - Its permission mode, `auto`, carried over too.

4. **pitwall can drive it.**
   - `claude attach 5e66fcb3` in a PTY took a typed prompt, and the reply landed in the same transcript file.
   - Closing the PTY detached. The session stayed alive and idle, with `state: "done"`.

5. **A session still open in a terminal gets a copy.**
   - With C's terminal open, `claude --resume <id> --bg` exited 0 and printed: `note: session bea3e368 is open in another Claude Code process, so this started a copy as ee8a7a26. The original conversation is unchanged.`
   - The copy was a background session with a new id and no name.
   - The exit code doesn't tell a copy from a resume. So pitwall has to check `claude agents` just before it resumes, and read the note after.

6. **`claude stop` and then `claude rm` keep the conversation.**
   - Both exited 0 on the resumed B. The session left `claude agents --all`, its job folder went, and the transcript stayed, byte for byte.
   - So pitwall's Remove on a resumed session doesn't delete its conversation. The `sessionKind` marker in finding 7 keeps it from being listed as ended again.

7. **Finding ended sessions.**
   - **`entrypoint`:** `cli` for interactive and background sessions alike. `sdk-cli` is `claude -p`, pitwall's relay among them, and `sdk-ts` the Agent SDK. Across Phil's transcripts: about 80 `cli`, 175 `sdk-cli` and 50 `sdk-ts`.
   - **`sessionKind`:** every entry B wrote while it ran in the background has `sessionKind: "bg"`; interactive entries have none. 24 of Phil's transcripts have it.
   - **The rule:** a transcript is an ended interactive session when:
     - its `entrypoint` is `cli`;
     - `claude agents --all` doesn't list its session;
     - its newest `user` or `assistant` entry has no `sessionKind: "bg"`;
     - it has at least one typed prompt (`promptSource: "typed"`);
     - its `cwd` is under a root.
   - **How many:** on Phil's two roots on 2026-10-26, 17 within 7 days of their last write, 28 within 14 and 46 within 30. The rule left out 16 that last ran in the background, 8 that `claude agents` lists, 8 outside the roots and 3 with no typed prompt.
   - **Names:** none of the 17 has a `custom-title` or `agent-name` entry, which `--name` writes. `claude agents` gives an unnamed interactive session a default name, such as `pitwall-ca`, which the transcript doesn't record. 19 of the 24 recent `cli` transcripts have an `ai-title`.
   - **No prompt, no transcript:** C never got a prompt and wrote no transcript, nor did its copy. There's nothing to resume.

8. **The first run: an inherited marker and a dialog.**
   - **The marker:** A inherited the coordinator session's `CLAUDE_CODE_CHILD_SESSION`. Claude Code then saved no transcript and left A out of `claude agents`, as `childEnvironment()`'s comment says. pitwall's own children never have it.
   - **The dialog:** A ran in a gitignored folder inside the pitwall checkout, and Claude Code asked whether to allow the parent `CLAUDE.md`'s import of `AGENTS.md`. The driver then looked only for a trust prompt, so it typed into the dialog, and its Enter chose the default, "No, disable external imports".
   - With saving off, nothing about that folder reached `~/.claude.json`. The driver was changed to stop at any dialog, and B and C ran in the checkout itself, where Phil had settled both.

## Found while building it (W66, 2026-10-27)

9. **A conversation that went on under another id.**
   - Four of Phil's `cli` transcripts end with `{ type: "continued-in", continuedInSessionId, sessionId, timestamp }`, after their last turn, with no turn after it.
   - Each `continuedInSessionId` was a session `claude agents --all` listed as background, with its transcript in the same project folder, as after `/bg`.
   - Listing the old transcript as ended would show the conversation twice, and resuming it would bring back an older branch of it. So a transcript whose newest `continued-in` entry follows its last turn isn't an ended session (coordinator's review).

10. **Ending a session that runs background work.**
    - In the live check against W66, `/exit` in two test sessions opened a dialog, because a plugin's monitor was running in them: "Background work is running. The following will stop when you exit", with **Exit and stop tasks**, **Move to background and exit** and **Stay**.
    - The driver typed nothing into it and ended both with SIGTERM instead, as a closed terminal would. Each left `claude agents` and was listed as ended with its transcript whole. In the one checked for leftover processes, nothing it started outlived it.
    - Spike 005 measures this properly. The dialog also offers a second way into the background beside `/bg`.

11. **The live check through pitwall.** On W66's branch, with the server's `PWD` set to another directory:
    - pitwall listed an ended `pitwall-test-*` session with the contract's fields;
    - its resume route answered 200 in about 1 s;
    - the next snapshot listed the session as a running background one with the same id;
    - reopened in a terminal with `claude --resume`, the session got 409, "It's running again…", from the route's fresh `claude agents` check, and no copy was started.

## Recommendation

Build it, as Phil agreed on 2026-10-23, with his choices of 2026-10-27 (`PLAN.md`, "Resuming ended interactive sessions" in M3.1):

- **Find:** a scanner over the transcripts, behind the transcript adapter, that never holds up the poll. Ended sessions are listed with `ended` and `finished` set, kind `interactive`, for 30 days.
- **Resume:** `claude --resume <id> --bg` with no prompt, in the session's own directory. First check that a fresh `claude agents --json` doesn't list it; afterwards, report Claude Code's copy note if there is one.
- **Name:** the newest `custom-title` or `agent-name`. Otherwise the directory's name and the short id, since the default name isn't recorded.
