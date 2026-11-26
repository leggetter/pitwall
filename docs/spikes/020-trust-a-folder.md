# Spike 020: can pitwall let you answer Claude Code's trust prompt in the page?

Run on 2026-11-26 against Claude Code 2.1.332 on macOS, for W214 (trust a folder from pitwall). Today New session in a folder Claude Code hasn't trusted fails with Claude Code's `Workspace not trusted` line and a command to copy into a terminal (`trustHint()` in `src/server/actions.ts`). Phil wants to answer the trust prompt inside pitwall instead. This spike answers six questions; it doesn't build anything.

The probe, [`020-trust-a-folder/trust_probe.py`](020-trust-a-folder/trust_probe.py), runs `claude` with no arguments in a PTY (a pseudo-terminal, what a terminal emulator gives a program) in a given folder, with the environment pitwall's `childEnvironment()` would give it, types the keys it's told, ends `claude` one of five ways, and prints the screen's lines, the exit status, that folder's own `hasTrustDialogAccepted` flag in `~/.claude.json`, and whether a transcript folder appeared. The folders were throwaway `pitwall-test-trust-<n>` folders in `$TMPDIR` and, for the inheritance check, two in `~/oss`. The background sessions were `pitwall-test-trust-*` on Haiku with the prompt "Reply with OK."; all were stopped and removed, and the folders deleted.

## Questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | What does `claude` show in an untrusted folder, and can a script tell where it is? | A two-option menu, **No, exit** selected first, then **Yes, I trust this folder**, moved with the arrow keys. Each stage has a stable line to match (finding 1) |
| 2 | How does pitwall end it, and does ending it lose the answer or leave a session behind? | Any way works: `/exit`, Ctrl-C twice, SIGTERM or SIGHUP. Trust is written the moment Yes is chosen. No transcript is written; the process is listed in `claude agents --json` only while it runs, and only after Yes (finding 2) |
| 3 | Does the answer hold for the next `claude --bg` started the way pitwall starts one? | Yes: the same `claude --bg --name … --model … -- <prompt>` that failed with `Workspace not trusted` started after Yes (finding 3) |
| 4 | Do subfolders inherit trust? Does a repo under a trusted root need its own? | A plain subfolder inherits; a git repo inside a trusted folder doesn't, nor do its subfolders. Answering Yes in a repo's subfolder trusts the repo's root. `~/oss` and `~/work` are trusted (finding 4) |
| 5 | What does No do? | `claude` prints "Claude Code didn't start because this folder isn't trusted." and exits, code 1 for No and 0 for Esc. Nothing is written and nothing in the folder runs (finding 5) |
| 6 | What can the first `claude` in a folder run, and does answering in pitwall change the risk? | Before the answer, nothing from the folder. After Yes, the project's hooks and `statusLine` command run at once, and a project `.mcp.json` server asks a second question. The same happens in a terminal; what's new is a key channel from the page into an interactive `claude` (finding 6) |

## Findings

1. **The trust prompt, and what to match on.**
   - In an untrusted folder `claude` draws, within 0.3 s: "Accessing workspace:", the folder's path, "Quick safety check: Is this a project you created or one you trust? …", "Claude Code'll be able to read, edit, and execute files here.", "Security guide", then the menu `❯ No, exit` / `Yes, I trust this folder` and "Enter to confirm · Esc to cancel".
   - **No is the default.** Enter on the first screen answers No. Yes is Down, then Enter. The options have no numbers in this version, and typing `2` does nothing. One Ctrl-C at the menu does nothing either.
   - When the folder's `.claude/settings.json` has hooks, the prompt adds "⚠ This folder configures hooks that can run commands without asking, declared in .claude/settings.json" and "Trusting this folder loads .claude/settings.json (runs commands) and .mcp.json here or above (MCP servers)."
   - **After Yes** the screen clears to the welcome banner, `Claude Code v2.1.332`, the model line and the folder, then the prompt box, in about 1.7 s. In a trusted folder `claude` goes straight to that banner, so the banner never shows while the trust prompt is up.
   - **After No or Esc** it prints "Claude Code didn't start because this folder isn't trusted." and "Run claude again and choose Yes, or run it in another folder.", then exits.
   - So a script can tell the stages apart by these lines, after stripping terminal escapes: "Enter to confirm · Esc to cancel" with "Yes, I trust this folder" (the prompt is up), `Claude Code v` (answered Yes), "didn't start because this folder isn't trusted" plus the process exiting (answered No). They're Claude Code's display text, not an interface, so they can change in any release; the process exiting is the sturdier signal for No, and the next `claude --bg` succeeding is the only real proof of Yes (finding 3).
   - The prompt box's placeholder (`Try "…"`) changes each run, so it isn't a marker. `? for shortcuts` didn't appear at 120 columns.
2. **Ending it keeps the answer, and leaves nothing behind.**

   | Ending | Exit | Trust after |
   | --- | --- | --- |
   | `/exit` and Enter | code 0 | kept |
   | Ctrl-C, then Ctrl-C again ("Press Ctrl-C again to exit") | code 0 | kept |
   | SIGTERM | code 143 | kept |
   | SIGHUP (what closing the PTY sends, as node-pty's `kill()` does by default) | code 129 | kept |
   | SIGKILL | signal 9 | kept |

   - The folder's flag was `true` straight after Yes, before any ending, so no way of ending it can undo the answer.
   - No transcript folder appeared under `~/.claude/projects` for any of these runs, since no message was sent.
   - While it runs after Yes, `claude agents --json` lists it as an `interactive` row, status `busy`, named after the folder (`pitwall-test-trust-8-62`), with its own session id and pid. While the trust prompt is up it isn't listed, and after it ends the row is gone. pitwall would show it for the seconds it runs unless it hides the row by pid.
   - `/exit` typed while another dialog is up (finding 6's MCP question) goes to that dialog, not the prompt box. A signal doesn't depend on what's on screen.
3. **The answer holds for `claude --bg`.** In the folder answered No, `claude --bg --name pitwall-test-trust-bg-2 --model haiku -- "Reply with OK."`, with the scrubbed environment and `PWD` set as `spawnArgs()` and `childEnvironment()` do, exited 1 with "Workspace not trusted. Run `claude` in <path> once and accept the trust prompt, then retry." The same command in the folder answered Yes printed `backgrounded · <id> · pitwall-test-trust-bg-4` and the session reached `done`. pitwall's `--plugin-dir` wasn't added; it changes nothing about trust.
4. **Inheritance.**
   - Reading only the flags: `~/oss` and `~/work` are trusted (`true`); `~` has an entry with `false`; the folders between `~` and each root have none.
   - In a folder trusted from a PTY, a plain subfolder two levels down started `claude --bg`. So did a plain folder made under `~/oss`.
   - A `git init` folder inside the trusted folder refused, and so did a `git init` folder under `~/oss` and its subfolder. This matches the README's caveat: Claude Code's trust in a folder doesn't cover a git repo inside it.
   - Answering Yes in that repo's subfolder (the prompt said "Accessing workspace: …/pitwall-test-trust-11/sub") wrote `true` on the repo's root, not the subfolder, and afterwards both the root and the subfolder started `claude --bg`.
   - Starting `claude --bg` in an inherited folder made an entry for it with `false`, though it was allowed.
   - So the flag at a folder's own path isn't the answer, either way: trust can come from a parent, and a Yes can land on the repo's root. pitwall shouldn't read `~/.claude.json` to decide; retrying the start is the check.
5. **No and Esc.** No (Enter on the default) exits with code 1 and Esc with code 0, both with "Claude Code didn't start because this folder isn't trusted." No entry is written. A folder with a SessionStart hook, a `statusLine` command and a `.mcp.json` server ran none of them. So the card can say: "Claude Code didn't trust this folder, so the session wasn't started. You can try again, or choose another folder." Answering No changes nothing, and the trust prompt shows again next time.
6. **What the first `claude` runs.** A folder had a `.claude/settings.json` with a SessionStart hook and a `statusLine` command, each touching a marker file outside the folder, a `.mcp.json` server that touched one too, and a `CLAUDE.md`.
   - **Before the answer, and after No:** no marker appeared.
   - **After Yes:** a second dialog, "New MCP server found in this project: probe", with "Use this MCP server", "Use this and all future MCP servers in this project" and `❯ Continue without using this MCP server` (the default), "Enter to confirm · Esc to reject". After Enter on the default, the banner showed and the SessionStart hook and `statusLine` command both ran, with no message sent. The MCP server didn't start.
   - **Ended at the MCP question:** in a second folder, `claude` was ended with SIGTERM while the MCP question was up. Trust was kept and the hook hadn't run. The next `claude --bg` there sat `blocked` on the same MCP question (seen with `claude logs`), so it would land in Needs you; the one in the folder where the question was answered reached `done`.
   - `CLAUDE.md` is read only when a turn runs, and none did. On the machine the spike ran on, the prompt box said "auto mode on", so anything typed and sent there would run tools without asking.
   - All of this is the same in a terminal. What answering in pitwall adds is a channel from the page's key presses into an interactive `claude` that, once trusted, will take a prompt.

## Recommended design for W214

1. **The button.** The "Workspace not trusted" card gets **Trust this folder…** wherever it shows `hint` today, so only for a folder that passed New session's checks (`checkDirectory()`, `trustHint()` having a word for it). The card keeps the command for people who'd rather use a terminal. W198 (the attachments folder's trust) can use the same button.
2. **The terminal.** A new route opens a PTY through `src/server/pty.ts` running `claude` with no arguments, in that folder, with `childEnvironment()` and `PWD`, at the page's size. It goes over a WebSocket with the same token, `Host` and `Origin` checks as attach (`src/server/attach.ts`), one at a time, and the page shows it as the Terminal tab does. No `--plugin-dir`, model or prompt: the smallest `claude` that shows the prompt.
3. **Keys.** Forward only Up, Down, Enter and Esc. They answer the trust prompt and the MCP question, and they can't type a prompt into the trusted `claude`. Closing the card or the page kills the PTY. A time limit, for example five minutes, kills it too.
4. **Reading the answer.** pitwall strips escapes from the PTY's output and watches for three things:
   - the process exits by itself: No or Esc. Show finding 5's text, and don't start the session.
   - `Claude Code v` (the banner) and no "Enter to confirm" after it for about a second: Yes, and no other question is open. End it.
   - "Enter to confirm" after the banner, or the MCP question: leave the terminal open for Phil to answer, then wait for the prompt box again.
5. **Ending it.** Kill the PTY (SIGHUP, as attach does), SIGKILL after a grace period. No `/exit`, which a dialog can swallow. Hide the row with the PTY's pid from the session list while it runs, or accept a few seconds' blink.
6. **Then the session.** Re-send the original New session request unchanged. Its result is the proof: started, or the `Workspace not trusted` 422 again, which brings the card back. pitwall never reads or writes `~/.claude.json` for this (finding 4).
7. **Resume** returns the same 422 with `hint` today (`actions.ts`, resume), so the button can serve it as well, re-sending the resume.

## Open questions for Phil

- **Key filter:** forward only Up, Down, Enter and Esc to the trust terminal (recommended), or every key, as the Terminal tab does? The filter means the in-page terminal can't be used as a general `claude`.
- **Auto-start:** start the session as soon as the banner shows (recommended), or show a "Start the session" button once it does?
- **The MCP question:** when a project's `.mcp.json` asks after Yes, keep the terminal open for Phil to answer (recommended), or end at the banner anyway and let the session sit in Needs you on that question?

## Left behind

- **Trust entries** in `~/.claude.json` for throwaway folders that no longer exist: `pitwall-test-trust-4`, `-5`, `-6`, `-7`, `-8`, `-13` and `-14` (`true`) and `pitwall-test-trust-4/sub/deeper` (`false`), all under `$TMPDIR` (`/private/var/folders/…/T/`), and `~/oss/pitwall-test-trust-10` (`false`) and `~/oss/pitwall-test-trust-11` (`true`). They weren't edited out, per the spike's rules.
- **Transcript folders** under `~/.claude/projects` from the removed `--bg` sessions, named after `pitwall-test-trust-4`, `-4-sub-deeper`, `-13`, `-10`, `-11` and `-11-sub`. `claude rm` keeps a session's conversation.
