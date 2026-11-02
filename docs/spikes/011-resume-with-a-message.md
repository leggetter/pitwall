# Spike 011: resuming a finished session with a message

Run on 2026-11-02 against Claude Code 2.1.316 on macOS, for W127: can the supervisor resume a finished session and give it a message in one step, rather than telling the user to open it and paste the text? Two throwaway sessions on Haiku in the pitwall checkout, a directory already trusted, each started with the variables `childEnvironment()` drops removed: `pitwall-test-resume`, a background session, and `pitwall-test-resume-i`, an interactive one in a PTY.

No real session was messaged, attached to, resumed, stopped or removed. Each test session, and the copy one of them made, was stopped and removed with `claude stop` and `claude rm`, and its transcript, `session-env` and `file-history` folders deleted.

## Questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Does `claude --resume <id> --bg -- "<prompt>"` take a prompt in the same call? | Yes. It ran as the next turn, under the same session id, in the same transcript (findings 1 and 2) |
| 2 | What does it print? | `backgrounded · <id> · <name>` for a stopped background job, with `note: woke session <id> with its saved options (--name, --model).` on stderr; `backgrounded · <id>` alone for an ended interactive one. Exit 0 in about 0.7 s |
| 3 | What if the session is still open elsewhere? | Claude Code starts a copy under a new id and gives the prompt to the copy, not the original, and still exits 0 (finding 3) |
| 4 | Is a second step needed, such as resume, wait, then SendMessage? | No, so there's no race between the resume and the message |

## Findings

1. **A stopped background job takes the prompt.**
   - After `claude stop`, `claude --resume <uuid> --bg -- 'Reply with exactly the word resumed…'` exited 0 in 0.71 s.
   - stdout: `backgrounded · e3518930 · pitwall-test-resume`, then the attach, logs and stop commands; stderr: `note: woke session e3518930 with its saved options (--name, --model).`
   - `claude agents --json --all` listed it under the same `sessionId`, `kind: "background"`, with a new pid. Its transcript gained a `user` entry with the prompt, `promptSource: "typed"`, `sessionKind: "bg"`, and the assistant's reply. Name and model kept, from the job's `respawnFlags`.
2. **An ended interactive session takes it too, and may be renamed.**
   - Ended by closing its PTY, then resumed the same way: exit 0, stdout `backgrounded · 5c7aaff7`, nothing on stderr.
   - The prompt ran as the next turn, under the same id, in the same transcript, now with `sessionKind: "bg"`.
   - Claude Code then named the background session itself, `ping pong exchange` in a new `agent-name` entry, though the session had been started with `--name`: an interactive session's name isn't a saved flag. So pitwall follows a resumed session by its id, never its name.
3. **A session that's running gets a copy, and the copy gets the prompt.**
   - With `pitwall-test-resume` still running, the same command exited 0. stdout: `backgrounded · b821060d`; stderr: ``note: session e3518930 is already running in the background, so this started a copy as b821060d. `claude attach e3518930` opens the original.``
   - The copy's transcript held the whole conversation, then the prompt and its reply; the original's was unchanged. Claude Code named the copy itself.
   - So the note's wording differs from spike 006's for a session open in a terminal, but `parseCopyNote()`'s "started a copy as <id>" matches both. The exit code still doesn't tell a copy from a resume, so pitwall checks a fresh `claude agents` first, as W66 does, and reports a copy after.
4. **The prompt is on the command line.** As for spawn's first prompt (spike 003), anyone who can list this user's processes can read it in `ps` while `claude --resume` runs, about a second. That's the same exposure as spawn_session's, for text you've read and approved.
5. **Driver note.** The interactive session didn't exit on SIGTERM or SIGHUP sent to it while the driver had stopped reading its PTY; killing the driver, which closed the PTY, ended it. The cause wasn't looked into.

## Recommendation

Build `resume_session` on the Resume route's own code: `claude --resume <uuid> --bg -- <message>`, with the message last after `--`, in the session's real path, after the fresh `claude agents` check, under the same limits. With a message, don't mark the session as needing a prompt (NeedsYou's 'restarted'). On a copy, tell the user and the supervisor that the message went to the copy, and follow the copy by its short id.
