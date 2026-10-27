# Spike 005: ending an interactive session with a signal

Run on 2026-10-27 against Claude Code 2.1.311 on macOS, for "M3.1 - After M3" item 3. The question: can pitwall end a session running in a terminal by signalling its Claude process, leaving the tab at its shell prompt? (Phil, 2026-10-21: run it after M3.)

Eight throwaway interactive sessions on Haiku, `pitwall-test-end-a` to `-g`, ran in a PTY in `~/oss/pitwall-sandbox`, a plain folder that Phil made. They ran with the variables pitwall's `childEnvironment()` drops removed. Each had these:

- **A stub MCP server** (`--mcp-config`): a stdio MCP server that answers `initialize` and an empty `tools/list`, and records its pid and any signal it gets.
- **A SessionEnd hook** (`--settings`) that appends its input to a log.
- **The user's own MCP servers and plugins**, which every session of Phil's loads: two more stdio MCP servers, a plugin's monitor, and `caffeinate`.

No real session was signalled, messaged or attached to. Every test session, its transcript, sub-agent folder, `session-env` and `file-history` were removed afterwards, along with the sandbox's project folder. The process listings printed for the spike showed one of Phil's MCP servers with an API key in its URL. Those lines went only to the coordinator's session, and the spike's inspector was then changed to redact query strings and `KEY=` arguments.

## Questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Do SIGTERM, SIGINT and SIGHUP end an interactive session, and how fast? | All three, in 0.6 to 1.8 s (finding 1) |
| 2 | What exit code does each give? | SIGTERM 143, SIGINT 0, SIGHUP 129 (finding 1) |
| 3 | Do SessionEnd hooks run? | Yes, for all three, with `reason: "other"` (finding 2) |
| 4 | What happens to MCP servers, background commands and sub-agents? | All end with it. Nothing was orphaned (finding 3) |
| 5 | Is the transcript whole, and can `claude --resume` reopen it? | Whole and resumable, but a reply being written is lost (findings 4 and 6) |
| 6 | Does the row leave `claude agents`? | At once (finding 5) |
| 7 | What does a kill during a commit leave behind? | No lock, no commit, and the change still staged (finding 7) |

## Method

- **Driver:** the PTY driver from spike 006. It types nothing while a trust prompt or any "Enter to confirm" dialog is on screen, and stops the session instead.
- **Sessions:**
  - **A, B and C:** prompted once ("pong"), then signalled while idle: A with SIGTERM, B with SIGINT, C with SIGHUP.
  - **D:** started a background Bash command (`sleep 600`); signalled with it running.
  - **D2:** started a background sub-agent whose Bash call ran a 5-minute `node` timer; signalled with it running.
  - **E:** ran `git commit --allow-empty` in a nested repo whose pre-commit hook holds it for 60 s; signalled during the hook.
  - **G:** the same, committing a staged file.
  - **F:** asked to count to 600; signalled while the reply was still streaming.
- **Checks:**
  - before the signal: the session's process tree;
  - after it: which processes were still alive 3 s later, any process left with parent pid 1, the driver's exit code, the hook log, the stub's log, whether every transcript line parses, `claude agents --json --all`, and the repo's state.

## Findings

1. **All three signals end a session cleanly, in about a second.**

   | Signal | Session | Exit code | Time to exit |
   | --- | --- | --- | --- |
   | SIGTERM | A (idle), D, D2, E, F, G | 143 | 0.6 to 1.8 s |
   | SIGINT | B (idle) | 0 | 1.3 s |
   | SIGHUP | C (idle) | 129 | 1.5 s |

   Each printed `Resume this session with: claude --resume <sessionId>` as it exited. So the terminal tab is left at its shell prompt, with that line above it.

2. **SessionEnd hooks run,** for every signal, with `reason: "other"`, the session's id, transcript path and `cwd`.

3. **Everything under the session ends with it.** Nothing was left with parent pid 1.
   - **MCP servers:** the stub logged a SIGINT from Claude Code; Phil's two other stdio servers were gone too.
   - **The rest:** the plugin's monitor and `caffeinate`.
   - **D's background command:** its `sleep 600` was killed.
   - **D2's sub-agent:** its running command was killed. The session's transcript recorded the sub-agent's task notification with `<status>killed</status>`, and the sub-agent's own transcript stayed valid. W76 maps `killed` to the contract's 'stopped'.
   - **E's and G's Bash call:** the whole tree (zsh, `git`, the hook, `sleep`) was killed.

   So a signal doesn't move background work to the background, as `/exit`'s dialog offers (spike 006, finding 10). It ends it.

4. **The transcript stays whole.** Every line of every transcript parsed, the sub-agents' included.

5. **The row leaves `claude agents --all` at once.** W66's scanner then lists it as an ended interactive session, which pitwall can resume (W67).

6. **A reply being written is lost.** F was at about 316 of its 600 lines when signalled. Its transcript kept the prompt but has no assistant entry at all, because Claude Code writes a reply when it's finished. `claude --resume <id> --bg` brought back both A, signalled idle, and F, signalled mid-reply, as idle background sessions under their own ids, as in spike 006.

7. **A kill during a commit leaves the repo consistent.**
   - **No lock:** a plain `git commit` writes the index and releases `index.lock` before the pre-commit hook runs. So during the hook, where nearly all of a slow commit's time goes, there's no lock to leave behind. It's held for milliseconds, too briefly to hit on purpose.
   - **E's and G's commits:** never happened. G's change was left staged.
   - **Not measured:** a signal landing inside those milliseconds. Git removes its lock files when it gets a fatal signal it can catch, as SIGTERM is, but not on SIGKILL; that's from git's lock-file code, not from this spike.

8. **"Busy" isn't a guard pitwall can use as it is.** Every idle session here showed `status: "busy"` in `claude agents`, because of the plugin's monitor (spike 007, finding 6). "Idle sessions only" has to come from the transcript's turn end, W69's `turn_duration` rule, not from Claude Code's status.

## Recommendation

Ending an interactive session with SIGTERM is safe enough to build, with the guards the plan already lists. It ends in about a second, runs SessionEnd hooks, leaves no processes, keeps the transcript, and the session can be resumed.

**What it costs,** which the confirmation must say:
- a reply being written is lost;
- running commands, background commands and sub-agents are killed;
- a commit in progress doesn't happen.

**Guards:**
- **Idle only:** idle by the transcript, with no turn running, unless Phil confirms a stronger warning naming what's running: commands, sub-agents, a reply being written.
- **A fresh pid:** the server looks up the pid from a fresh `claude agents --json`, checks it again just before signalling, and refuses a process pitwall itself runs under.
- **SIGTERM only,** never SIGKILL. SIGINT exits 0, which a shell can't tell from a normal `/exit`; SIGTERM's 143 can be.
- **Afterwards,** the view says how to resume: W67's Resume in background and Copy command already do.

Whether to build it is Phil's call (`PLAN.md`, "Spike 005").
