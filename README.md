# pitwall

A local CLI and web UI for supervising the Claude Code sessions running on your machine.

- **Lists every live session under a directory,** wherever it was started (Warp, Cursor, any terminal), grouped by git repo.
- **Lets you act on a session:** read it, reply, answer its prompts.
- **Spawns new sessions** in any directory under the root.
- **Has a supervisor session** you can talk to instead of visiting each session. It knows what each one is waiting on and what's urgent.

**Status:** M1, a read-only index, is done. M2, interacting with sessions from the web UI, is next. See [`PLAN.md`](PLAN.md).

## Use

```
npm ci && npm run build
node dist/cli.js [root...] [--interval <seconds>] [--port <n>] [--no-open]
```

- **Roots:** a directory, or several. The default is the current directory. Sessions whose working directory is under a root are listed.
- **Opening it:** the CLI opens your browser through a launch file in `~/.pitwall/` (D7), which sends it to `http://127.0.0.1:<port>/#token=...`. The token is per run and never appears in a process's arguments. The page moves it out of the address bar, and never sends it to the server: it proves it with an HMAC over the WebSocket. `PITWALL_HOME` overrides `~/.pitwall`.
- **Port:** the default is 4517, falling back to a free port if it's busy. An explicit `--port` fails instead.
- **Interval:** `--interval` sets the poll, in seconds (default 5).
- **Read-only:** M1 never messages, attaches to or stops a session.

## Decisions

Settled decisions move here from `PLAN.md`, with their reasoning. The evidence is in [`docs/spikes/001-session-control.md`](docs/spikes/001-session-control.md).

### D1 - The session list comes from `claude agents --json`

- **Why:** it's a documented interface and returns in about 0.2 s with 20 sessions. It includes interactive sessions started in any terminal or IDE, not just background ones. Third-party session managers only see sessions they launch themselves, which is why pitwall exists.
- **Caveat:** interactive rows aren't in the agent view docs, which describe background sessions only. If they disappear in a later Claude Code release, pitwall loses most of its value, so watch the changelog.
- **How:** poll every 5 s by default (`pitwall --interval <seconds>`). The full snapshot is pushed only when it changed, with a heartbeat after other polls. Each `claude agents --json` call costs about 0.18 s of CPU, so a 2 s interval used about 9% of a core; that was the M1 behavior until W7a. Interactive rows give `status` (busy/idle) only; background rows add `state` and, when waiting, `waitingFor`.

### D2 - Interactive sessions: relay through the supervisor, or `/bg` for full control

- **Why:** an interactive session in Warp or Cursor belongs to that terminal. The only documented way in from outside is cross-session messaging. The receiving session sees such a message as coming from another session, "not typed by your user", so it can't approve a permission prompt or change configuration.
- **So:** pitwall relays messages, and labels them in the UI as coming from the supervisor. A relayed message still triggers real work: it starts a turn, and the session acts within its own permissions (spike 002). The relay arrives in M2, as a headless session pitwall runs, limited to `ListAgents` and `SendMessage` (D8), which the M4 supervisor later takes over. For anything that needs full control, it asks me to run `/bg` in the session, then attaches.
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

### D7 - The browser is opened through a launch file, not a URL with the token in it

- **Why:** macOS lets any user read every process's arguments with `ps`, so `open http://127.0.0.1:<port>/#token=...` exposes the token to other accounts on the machine. Instead, the CLI writes a small HTML page that sends the browser on to the token URL. The page sits in a file only you can read (0600, in a 0700 `~/.pitwall/` directory), and the CLI opens that file, so `ps` shows only a path. The file is deleted on exit. Jupyter does the same.
- **Rejected:** a single-use launch code in the URL. It's still visible in `ps` briefly, and another user who used it first would get the token while your browser failed.
- **Context:** W6 review finding 1. It's part of the M2 security gate, together with challenge-response WebSocket auth and dev readiness, because from M2 on the token authorizes typing into agents.

### D8 - Messages to interactive sessions go through one headless relay session

- **Why:** only a Claude session can call `SendMessage`, and the socket's message format isn't documented (D2). Pitwall runs one headless session as its own child process, `claude -p` with stream-json input and output, named `pitwall-relay`, on Haiku and allowed only `ListAgents` and `SendMessage`. It passes your text on verbatim. It starts on first use, takes each message on stdin, so the text never appears in `ps`, and stops with pitwall.
- **Not a background session:** that was the first decision, on 2026-10-16. Spike 003 found that a running background session can't take a new prompt without a terminal. Driving it through a PTY works, but it scrapes a screen meant for people, puts your text in `ps`, and needs a one-time trust step.
- **Trade-off:** a reply that arrives after pitwall exits isn't shown in pitwall. The target's own conversation still has it.
- **Later:** the M4 supervisor replaces it.

### D9 - At most four attached sessions, and a confirmation before restarting one

- **Why:** each attach is a PTY and a `claude attach` process. Closing the view or the tab detaches, and the session keeps running. `claude attach` restarts a background session that isn't running, which is an action, so the UI asks first.

### D6 - Group sessions by `git rev-parse --git-common-dir`

- **Why:** worktrees sit under the repo they belong to. A directory that isn't a git repo groups as itself.
