# Plan

The living plan for pitwall. Read it before picking up work, and update it in the same commit as the work. Settled decisions move to `README.md` with their reasoning; this file keeps what is true now and what happens next.

## Summary

| | |
| --- | --- |
| **Decision** | Build pitwall: a local CLI and web UI that lists, groups and drives the Claude Code sessions already running on this machine, spawns new ones, and puts a supervisor session in front of them. |
| **Status** | M0 done on 2026-10-16. Spikes [001](docs/spikes/001-session-control.md) and [002](docs/spikes/002-supervisor-to-interactive.md) pass, including a background supervisor messaging an interactive session and getting a reply. No app code yet. |
| **Risk** | Pitwall can reach an interactive session in Warp or Cursor only through cross-session messaging. That reaches the session's Claude as a message from another session, not as my prompt, so it can't approve anything, and the receiving session's own rules decide whether it acts at all (spike 002). Full control needs the session moved to the background with `/bg` (D2). |
| **Next steps** | - Build M1 |

## Who is this for

- Phil, who runs 15+ Claude Code sessions at once across Warp and Cursor.
- Agents working in this repo.

## Purpose

Stop losing track of Claude Code sessions: one place to see every session under a directory, what each one is waiting on, and act on it.

## Goals

- **See everything under a root.** `pitwall ~/hookdeck/git` lists every live Claude Code session whose working directory is the root or below it, wherever the session was started.
- **Group by directory.** Sessions sit under their git repo, with worktrees under the main repo, and fall back to the plain directory when it isn't a repo.
- **Act on a session.** Open it, read its conversation, reply, answer its prompts.
- **Spawn sessions.** Start a new session in any directory under the root.
- **Talk to a supervisor.** One conversation that knows about every session: what's waiting, what's urgent and why. It can message or spawn sessions on my behalf. Going to a session directly stays possible.

## Non-goals, for now

- **Remote access.** Localhost only. Claude Code's Remote Control already gives phone and browser access to individual sessions.
- **Other agents** (Codex, Cursor's own agents). Keep one seam, a session-source adapter, so they can be added later, but don't build for them yet.
- **Multi-user or team use.**

## Measures of success

- I open pitwall instead of cycling through terminal tabs to find out what needs me. This is qualitative. The real test is whether I still lose track of a session after two weeks of use.
- A session that appears in `claude agents --json` under the root shows in pitwall within 5 seconds.
- The supervisor's triage matches a manual sweep like the one on 2026-10-16 (15 live sessions, 10 waiting on me) without me prompting each session.

## Context

### Why not an existing tool

Checked on 2026-10-16: Claude Code's agent view and Remote Control, Agent Deck, Muxara, Nimbalyst (formerly Crystal), Conductor, Claude Squad, crystl, opcode, Claude Code UI and kandev. Two gaps decided it:

- **Discovery.** The third-party managers only see sessions they launch, usually inside tmux. My sessions start in Warp and Cursor, and only Claude Code's own registry sees those.
- **Supervision.** Nothing ranks what every session needs from me. Agent view's per-row summaries and Agent Deck's "conductor" session come closest.

Agent view (`claude agents`) does much of the per-session work well. But it's a terminal UI, it only shows background sessions in the view, and it has no cross-session triage.

### Why not agent-control-room and kandev

kandev only manages agents it starts from its own cards. I start most sessions by hand, so it never saw most of my work. Pitwall adopts the sessions that already exist.

## Architecture (proposed, pending the spike)

```
pitwall [root...]  ->  local server (127.0.0.1, per-run token)  ->  web UI
  |
  |- Session index   claude agents --json, grouped by git common dir, plus a transcript adapter
  |- Session view    transcript (read) + a PTY running `claude attach <id>` (background sessions)
  |- Spawner         claude --bg --name <name> "<prompt>" in a directory under a root
  '- Supervisor      a background Claude Code session pitwall starts, with pitwall's MCP server
                     (list, read, spawn) and ListAgents/SendMessage to reach any local session
```

### Interfaces pitwall relies on

| Need | Interface | Stability |
| --- | --- | --- |
| List sessions with kind, state and waiting reason | `claude agents --json [--all]` | Documented |
| Start a session | `claude --bg --name ... "prompt"` | Documented. From a script it fails with `Workspace not trusted` in a directory the user hasn't trusted |
| Drive a background session fully | `claude attach <id>` in a PTY | Documented command; embedding it in a PTY is ours |
| Message any local session, including interactive ones | The supervisor's `SendMessage` and `ListAgents` tools | Documented (cross-session messaging, v2.1.224+) |
| Hear when a session goes idle | `SendMessage` with `notify_when_idle` | Documented (v2.1.236+) |
| Conversation history | `~/.claude/projects/<dir>/<session-id>.jsonl` | **Internal.** The format changes between versions. Read-only, behind one adapter |
| A background job's "needs" line | `~/.claude/jobs/<id>/state.json` | **Internal**, and documented as not stable |
| Posting into a session's inbox socket directly | Unix socket under `/tmp/cc-socks*` | Only the auth line is documented. Don't depend on it |

## Decisions

Each open one carries a lean. Settled decisions keep a one-line status here; their reasoning is in `README.md`.

- **D1 - Session list comes from `claude agents --json`.** Decided (S1).
- **D2 - Acting on an interactive session pitwall didn't start:** relay messages through the supervisor, and ask me to `/bg` the session for anything that needs full control. Decided (S4).
- **D3 - Direct interaction with background sessions: xterm.js over a PTY running `claude attach <id>`.** Decided (S3).
- **D4 - Supervisor runtime: a background Claude Code session (`claude --bg`), not the Agent SDK.** Decided (spike 002). Revisit if chatting with the supervisor through a terminal is too crude.
- **D5 - Stack: TypeScript on Node >= 22, npm, Hono and `ws`, React and Vite, `node-pty`, xterm.js.** Decided (Phil, 2026-10-16).
- **D6 - Grouping by `git rev-parse --git-common-dir`,** so worktrees sit under their repo, falling back to the working directory. Decided.

## Security

A local web UI that can type into agents running in auto mode is a local remote-code-execution surface: anything that can reach it can run code as me.

- Bind to `127.0.0.1` only.
- Generate a random token per run, pass it in the URL the CLI opens, and require it on every HTTP and WebSocket request.
- Check `Host` and `Origin` on every request, to block DNS rebinding.
- No CORS.
- Don't write the token or session content anywhere outside `~/.claude`.

## M0: spike (done)

Confirm the interfaces above before writing app code. All six passed on 2026-10-16; the results are in [`docs/spikes/001-session-control.md`](docs/spikes/001-session-control.md). [Spike 002](docs/spikes/002-supervisor-to-interactive.md) closed the two gaps it left.

| # | Question | Passes when |
| --- | --- | --- |
| S1 | What does `claude agents --json` return for interactive and background sessions, and how fast? | Fields confirmed; returns in under 1 second with ~20 sessions |
| S2 | Can a process with no TTY spawn a session with `claude --bg` and capture its id? What happens in an untrusted directory? | Id parsed from stdout; the untrusted error captured |
| S3 | Does `claude attach <id>` work inside `node-pty`, and does typed input reach the session? | Output renders and a typed prompt reaches the session |
| S4 | Can a background session use `ListAgents`/`SendMessage` to reach (a) another background session and (b) an interactive session, and get a reply? | Message delivered, starts a turn in an idle session, reply comes back |
| S5 | Does `notify_when_idle` work from a background supervisor? | The notice arrives |
| S6 | Does the transcript file grow during a turn, so the session view can tail it? | New lines appear within 1 second of output |

## Milestones

- **M0 - Spike.** Done.
- **M1 - Read-only index.** `pitwall [root...]` starts the server and opens the UI. Sessions are grouped by repo, with kind, state, waiting reason, last activity and the last assistant message, refreshing on their own.
  - Flag stale jobs: blocked, no process, old `startedAt`.
  - Read transcripts from a byte offset, never whole files (434 KB after two one-word turns).
  - Tell cross-session messages apart from my own prompts. They're `user` entries with `isMeta: true` and content starting `Another Claude session sent a message:`.
- **M2 - Act.** Session view (transcript, plus attach for background sessions), a spawn dialog, stop and remove.
  - Show the `Workspace not trusted` error with the command to run. Never grant trust for me.
- **M3 - Supervisor.** Pitwall starts and owns a supervisor session, shown in its own panel. The supervisor can list, summarise, message and spawn sessions.
  - Label relayed messages in the UI as coming from the supervisor, because that's how the receiving session sees them.
  - Get status from pitwall's index (D1 polling and transcripts), not by messaging sessions. Each relayed message costs a full turn on the receiving session's model and effort, which was Opus 5.5 at xhigh in spike 002.
  - Don't subscribe to idle notices broadly. Each subscription prints a notice in the watched session's terminal that names a raw socket address. Pitwall's own polling already sees busy-to-idle changes.
- **M4 - Triage.** Urgency ranking with reasons (time-sensitive, waiting on a decision, housekeeping, closeable), using PR and CI state from `gh`.

## M1 work breakdown

The coordinator, a Claude Code session working with Phil, owns `src/shared/protocol.ts`, the contract the pieces are built against. Sub-agents build W1-W4 and review in W6. Phil tries the result and approves merges.

| Item | What | Branch | Owner | Status |
| --- | --- | --- | --- | --- |
| W0 | The contract: `src/shared/protocol.ts` | `m1/scaffold` | Coordinator | Done |
| W1 | Scaffold: package, TypeScript, Vitest, Vite, CI, and stubbed module signatures | `m1/scaffold` | Sub-agent | In progress |
| W2 | Index: `claude agents --json` source, root filter, git grouping, transcript adapter, poller | `m1/index` | Sub-agent | Waiting on W1 |
| W3 | Server and CLI: Hono, `ws`, token, `Host`/`Origin` checks, `pitwall [root...]` | `m1/server` | Sub-agent | Waiting on W1 |
| W4 | Web UI: grouped session list, live updates over the WebSocket | `m1/web` | Sub-agent | Waiting on W1 |
| W5 | Integration and a read-only run against real roots | `m1/integration` | Coordinator | Waiting on W2-W4 |
| W6 | Review of the integrated change, with the `role-reviewer` skill | - | Sub-agent | Waiting on W5 |
| W7 | Try it, and approve the merge | - | Phil | Waiting on W6 |

### Module layout

```
src/shared/protocol.ts   the contract (W0)
src/index/               W2. Entry point index.ts: startIndexer(options) -> Indexer
src/server/              W3. Entry point index.ts: startServer(options) -> running server
src/cli.ts               W3. Parses arguments, starts the indexer and the server, opens the browser
web/                     W4. Vite + React app, built to dist/web and served by the server
```

### Rules for M1

- **Token transport:** the CLI opens `http://127.0.0.1:<port>/#token=<token>`. The UI reads the token from the fragment, keeps it in `sessionStorage`, and removes it from the address bar.
  - HTTP API calls send `Authorization: Bearer <token>`.
  - The WebSocket sends `{ "type": "auth", "token": ... }` as its first message.
  - Static assets need no token. `Host` is checked on every request, and `Origin` on every API request and WebSocket upgrade.
- **No Vite dev server in M1.** `npm run dev` rebuilds the UI on change and the pitwall server serves it, so the UI is always same-origin and the security checks never need a dev exception.
- **No `node-pty` in M1.** It arrives with attach in M2, so CI doesn't build a native module yet.
- **Tests use synthetic fixtures only:** never real transcripts or real `claude agents` output. A live test against the real `claude agents --json` runs only when `PITWALL_LIVE=1` is set, and it's read-only.

## Open questions

- **Several roots at once** (`pitwall ~/hookdeck/git ~/leggetter/git`)? Lean: yes. It costs little to support.
- **Should the supervisor survive pitwall restarts?** Lean: yes. It's a named background session, and pitwall reattaches to it by name.
- **Cursor's Claude Code extension panel:** do I use it? Its sessions keep a separate list and may not appear in `claude agents --json`.

## Suggested actions

- [x] Create the repo and this plan
- [x] Run S1-S6
- [x] Spike 002: a background supervisor messaging an interactive session
- [x] Settle D1-D4 and D6
- [x] Confirm D5, the stack (Phil)
- [ ] Build M1

---

_Drafted with Claude Code on 2026-10-16, from the session that ran the first manual sweep of 15 live sessions._
