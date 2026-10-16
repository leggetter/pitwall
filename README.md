# pitwall

A local CLI and web UI for supervising the Claude Code sessions running on your machine.

- **Lists every live session under a directory,** wherever it was started (Warp, Cursor, any terminal), grouped by git repo.
- **Lets you act on a session:** read it, reply, answer its prompts.
- **Spawns new sessions** in any directory under the root.
- **Has a supervisor session** you can talk to instead of visiting each session. It knows what each one is waiting on and what's urgent.

**Status:** M1, a read-only index, is built and in review. See [`PLAN.md`](PLAN.md).

## Decisions

Settled decisions move here from `PLAN.md`, with their reasoning. The evidence is in [`docs/spikes/001-session-control.md`](docs/spikes/001-session-control.md).

### D1 - The session list comes from `claude agents --json`

- **Why:** it's a documented interface and returns in about 0.2 s with 20 sessions. It includes interactive sessions started in any terminal or IDE, not just background ones. Third-party session managers only see sessions they launch themselves, which is why pitwall exists.
- **Caveat:** interactive rows aren't in the agent view docs, which describe background sessions only. If they disappear in a later Claude Code release, pitwall loses most of its value, so watch the changelog.
- **How:** poll every 5 s by default (`pitwall --interval <seconds>`). The full snapshot is pushed only when it changed, with a heartbeat after other polls. Each `claude agents --json` call costs about 0.18 s of CPU, so a 2 s interval used about 9% of a core; that was the M1 behavior until W7a. Interactive rows give `status` (busy/idle) only; background rows add `state` and, when waiting, `waitingFor`.

### D2 - Interactive sessions: relay through the supervisor, or `/bg` for full control

- **Why:** an interactive session in Warp or Cursor belongs to that terminal. The only documented way in from outside is cross-session messaging. The receiving session sees such a message as coming from another session, "not typed by your user", so it can't approve a permission prompt or change configuration.
- **So:** pitwall relays messages, and labels them in the UI as coming from the supervisor. A relayed message still triggers real work: it starts a turn, and the session acts within its own permissions (spike 002). The relay arrives in M2, as a background session limited to `ListAgents` and `SendMessage`, which the M4 supervisor later takes over. For anything that needs full control, it asks me to run `/bg` in the session, then attaches.
- **Rejected:** posting to a session's inbox socket directly. Only the socket's auth line is documented, not the message format.

### D3 - Background sessions are driven through a PTY running `claude attach <id>`, shown with xterm.js

- **Why:** it gives the full Claude Code interface, including permission prompts and dialogs, without pitwall modeling any of it. `node-pty` works on Node 25. Closing the PTY detaches without stopping the session.
- **Rejected:** a custom chat UI over the transcript plus `claude --resume <id> --bg "prompt"`. It would look better but can't answer dialogs. It may come back later as a read-only view.

### D4 - The supervisor is a background Claude Code session, not an Agent SDK app

- **Why:** a background session runs on the normal Claude login and shows up in agent view, and the web UI attaches to it like any other session (D3). Spike 002 showed it can do the job: it listed sessions, messaged a live interactive session without being blocked, got the reply back, and received that session's idle notice.
- **Limit:** a relayed request is only acted on if the receiving session's own instructions and permissions allow it. The supervisor can ask, not force.
- **Rejected for now:** the Agent SDK. Its structured message stream would make a better chat UI than a terminal. But it raises auth questions and parity questions, such as whether an SDK session binds an inbox socket (bare mode doesn't). Revisit if chatting with the supervisor through a terminal is too crude.

### D5 - Stack: TypeScript on Node >= 22, npm, Hono and `ws`, React and Vite, `node-pty`, xterm.js

- **Why:** TypeScript is the preferred language.
  - **Server:** Hono is small and runs on Node's HTTP server, and `ws` carries the PTY streams and live index updates.
  - **UI:** React and Vite, for a UI that's mostly lists and panels.
  - **Terminal:** `node-pty` and xterm.js are the usual pair for a terminal in the browser. VS Code's integrated terminal is built on both, and `node-pty@1.0.0` worked on Node 25.1.0 in spike 001.
- **Packaging:** `@leggetter/pitwall` on npm, because the unscoped `pitwall` is taken. The binary is `pitwall`.
- **Watch:** `node-pty` is a native module. npm warned in spike 001 that its install script isn't covered by `allowScripts`, so a clean install may need that script approved.

### D6 - Group sessions by `git rev-parse --git-common-dir`

- **Why:** worktrees sit under the repo they belong to. A directory that isn't a git repo groups as itself.
