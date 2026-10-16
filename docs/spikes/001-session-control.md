# Spike 001: controlling sessions pitwall didn't start

Run on 2026-10-16 against Claude Code v2.1.301 on macOS, Node 25.1.0. It covers the S1-S6 questions in `PLAN.md`. All test sessions were throwaway `pitwall-test-*` sessions on Haiku, removed afterwards.

## Results

| # | Result | Evidence |
| --- | --- | --- |
| S1 | **Pass** | `claude agents --json` returned 20 sessions in 0.2 s warm, 1.0 s cold |
| S2 | **Pass** | `claude --bg` from a script printed `backgrounded · b3899da0 · pitwall-test-a`; an untrusted dir exits 1 with a clear message |
| S3 | **Pass** | `claude attach <id>` inside `node-pty` rendered the TUI, a typed prompt reached the session and was answered in 3.6 s; killing the PTY detached without stopping the session |
| S4 | **Pass, with two gaps** | Interactive → background and background → background delivery both worked. Not tested: background → interactive (blocked, see below) and the reply leg |
| S5 | **Pass** | The idle notice arrived 4 s after the session went idle, with its one-line status |
| S6 | **Pass** | The transcript gained lines within ~0.5 s of a prompt (the poll interval, so possibly sooner) |

## S1: `claude agents --json`

- **Interactive rows** have `pid`, `cwd`, `kind`, `startedAt`, `sessionId`, `name` and `status` (`busy` or `idle`). They have no `state` and no `waitingFor`. The agent view docs only describe background sessions, so interactive rows in the JSON are observed behavior, not a documented promise.
- **Background rows** add `id` and `state` (`working`, `blocked`, `done`, `failed`, `stopped`). `pid` and `status` are present only while the process is alive.
- **Stale jobs show up.** One background job from 13 Aug was still listed as `blocked` with no `pid`, waiting on a question that was moot by 11 Sep. Pitwall should flag a blocked session with no process and an old `startedAt` as stale.
- **Gap:** no interactive session was `waiting` during the run, so whether interactive rows ever report `waitingFor` is still unknown.

## S2: spawning

- `claude --bg --name <name> --model <model> "<prompt>" < /dev/null` exits 0. Its first stdout line is `backgrounded · <id> · <name>`, which is the line to parse.
- In a directory the user hasn't trusted, it exits 1 with: ``Workspace not trusted. Run `claude` in <dir> once and accept the trust prompt, then retry.`` Pitwall must show this and tell the user what to run. It must not grant trust on the user's behalf.

## S3: PTY attach

- `node-pty@1.0.0` installed and loaded on Node 25.1.0. npm warned that its install scripts aren't covered by `allowScripts`, but the native module was present and worked. Check that again on a clean install when scaffolding M2.
- The attach rendered 3.6 KB of terminal output in the first 6 s. The output is raw TUI (spinners, cursor control), so it needs a terminal emulator (xterm.js), not parsing.
- Characters written to the PTY reached the prompt, and Enter submitted it. The session answered and went back to `idle`/`done`.
- Killing the PTY ended `claude attach` with exit code 0, and the session kept running.
- The script is in [`001-pty-attach.mjs`](001-pty-attach.mjs).

## S4: cross-session messaging

- **Interactive → background:** this session (interactive, auto mode) sent a message to an idle background session. It started a new turn about 2 s later.
- **Background → background:** a background stand-in supervisor called `ListAgents` and saw 20 peers, including interactive sessions. It then sent with `SendMessage`, and neither tool needed an approval in auto mode.
- **How the receiver sees it:** the message lands as a `user` entry wrapped in `<cross-session-message from="uds:..." from-name="..." from-mode="prompting">`, followed by a harness note that it "came from another Claude session - not typed by your user". That confirms the constraint in D2. The transcript adapter must tell these entries apart from real user prompts.
- **Gap: background → interactive.** The auto-mode classifier in my own session denied spawning a stand-in that would message a live interactive session ("Interfere With Workloads"). I didn't route around it. A supervisor that messages real sessions may hit the same classifier, so M3 needs this tested deliberately: a session the user opens for the purpose, and an explicit user instruction.
- **Gap: the reply leg.** Both receivers answered in their own transcript instead of replying, because the test prompt told them not to use tools. The reply is the same `SendMessage` mechanism, but it hasn't been observed.

## S5: idle notices

- `SendMessage` with `notify_when_idle: true` returned a subscription confirmation. The notice arrived 4 s after the receiver went idle, as `[Cross-session idle notice] "pitwall-test-a" ... is idle now - it finished a turn at 11:56. Its harness reports: «pong»`.
- The asking session was busy, so the notice was queued for its next turn rather than injected mid-turn.

## S6: tailing transcripts

- Lines were appended within ~0.5 s of the prompt being submitted.
- **Transcripts are large even for tiny sessions:** 434 KB after two one-word turns, mostly attachments and environment snapshots. The session view must tail from a byte offset, never re-read the whole file.

## What changes in the plan

- **D1, D3 and D6:** settled.
- **D2:** settled as leaned, with a UI rule. A message relayed through the supervisor must be labeled in the UI as arriving "from pitwall's supervisor", because that's how the receiving session sees it.
- **D4:** the background-session supervisor holds up. The classifier gap above is the main risk, and M3 tests it before anything else.
- **New requirements:** surface the untrusted-workspace error; flag stale blocked jobs; tail transcripts from an offset; tell cross-session message entries apart from user prompts.
