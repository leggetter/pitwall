# Plan

The living plan for pitwall. Read it before picking up work, and update it in the same commit as the work. Settled decisions move to `README.md` with their reasoning; this file keeps what is true now and what happens next.

## Summary

| | |
| --- | --- |
| **Decision** | Build pitwall: a local CLI and web UI that lists, groups and drives the Claude Code sessions already running on this machine, spawns new ones, and puts a supervisor session in front of them. |
| **Status** | M0 and M1 done. M1, a read-only index, merged into `main` on 2026-10-16 in [PR #6](https://github.com/leggetter/pitwall/pull/6). M2, interacting with sessions from the web UI, is in progress on `m2/integration`: the security gate, session view, attach, and spawn, stop and remove, finished sessions and the relay are merged. |
| **Risk** | Pitwall can reach an interactive session in Warp or Cursor only through cross-session messaging. That reaches the session's Claude as a message from another session, not as my prompt, so it can't approve anything, and the receiving session's own rules decide whether it acts at all (spike 002). Full control needs the session moved to the background with `/bg` (D2). |
| **Next steps** | - The security-first review (W14), and its fixes<br>- Then Phil's try-out (W15) |

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
- **See my open pull requests,** grouped by org, then repo, with review and CI state, next to the sessions working on them.
- **Talk to a supervisor.** One conversation that knows about every session: what's waiting, what's urgent and why. It can message or spawn sessions on my behalf. Going to a session directly stays possible.

## Non-goals, for now

- **Remote access.** Localhost only. Claude Code's Remote Control already gives phone and browser access to individual sessions.
- **Other agents** (Codex, Cursor's own agents). Keep one seam, a session-source adapter, so they can be added later, but don't build for them yet.
- **Multi-user or team use.**

## Measures of success

- I open pitwall instead of cycling through terminal tabs to find out what needs me. This is qualitative. The real test is whether I still lose track of a session after two weeks of use.
- A session that appears in `claude agents --json` under the root shows in pitwall within one poll: 5 s by default, plus the poll's own 0.2-1.3 s.
- The supervisor's triage matches a manual sweep like the one on 2026-10-16 (15 live sessions, 10 waiting on me) without me prompting each session.

## Context

### Why not an existing tool

Checked on 2026-10-16: Claude Code's agent view and Remote Control, Agent Deck, Muxara, Nimbalyst (formerly Crystal), Conductor, Claude Squad, crystl, opcode, Claude Code UI and kandev. Two gaps decided it:

- **Discovery.** The third-party managers only see sessions they launch, usually inside tmux. My sessions start in Warp and Cursor, and only Claude Code's own registry sees those.
- **Supervision.** Nothing ranks what every session needs from me. Agent view's per-row summaries and Agent Deck's "conductor" session come closest.

Agent view (`claude agents`) does much of the per-session work well. But it's a terminal UI, it only shows background sessions in the view, and it has no cross-session triage.

### Why not agent-control-room and kandev

kandev only manages agents it starts from its own cards. I start most sessions by hand, so it never saw most of my work. Pitwall adopts the sessions that already exist.

## Architecture

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

Observed while building M1 (Claude Code v2.1.301):

- **`claude agents --json` works from an untrusted directory.** The index runs it from the temp directory, so the result doesn't depend on where pitwall was started.
- **`startedAt` is epoch milliseconds,** not a string.
- **Transcripts write one content block per line,** and about two thirds of assistant messages are `tool_use` only. Text blocks with the same `message.id` belong together.
- **Transcripts also carry `origin.kind` and `last-prompt` entries.** Both are internal, but `last-prompt` is a cheaper source for the latest prompt if it's ever needed.
- **A snapshot is about 20 KB for 20 sessions,** and a poll takes 0.2 to 1.3 s.

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
- Don't write the token or session content anywhere outside `~/.claude`, except the launch file (D7): one HTML file at 0600 in `~/.pitwall/` at 0700, deleted on exit.

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

In the order they'll be built. Each starts when the one before it has merged into `main`.

### M0 - Spikes (done)

Spikes 001 and 002 confirmed every interface pitwall relies on. See "M0: spike" above.

### M1 - Read-only index (done)

`pitwall [root...]` starts the server and opens the UI. Sessions are grouped by repo, with kind, state, waiting reason, last activity and the last assistant message, refreshing on their own. Merged on 2026-10-16 in [PR #6](https://github.com/leggetter/pitwall/pull/6). The work items are in "M1 work breakdown" below.

- **Stale jobs:** flag those blocked with no activity for 7 days, process or not.
- **`askedYou`:** flag sessions that finished their turn by asking me something, as a heuristic over the transcript.
- **Transcripts:** read them from a byte offset, never whole files (434 KB after two one-word turns).
- **Cross-session messages:** tell them apart from my own prompts. They're `user` entries with `isMeta: true` and content starting `Another Claude session sent a message:`.

### M2 - Interact with sessions from the web UI (next)

Open a session from its row, drive background sessions fully in the browser, start new sessions, and stop or remove them. Prioritised ahead of the PR view by Phil on 2026-10-16.

**What can be driven from the browser, by session kind:**

| Session kind | In the web UI | How |
| --- | --- | --- |
| Background, including sessions pitwall starts | Full interaction: type prompts, answer permission prompts and dialogs | xterm.js over a PTY running `claude attach <id>` (D3, spike S3) |
| Interactive, in Warp or Cursor | **Send it a message.** The message starts a turn, and the session does the work within its own permissions and rules. It can't take a permission approval from me, and it sees the message as coming from another session (spike 002) | A relay: a headless Claude session (`claude -p`) that pitwall runs, limited to `ListAgents` and `SendMessage` (D2, D8). The M4 supervisor later takes over this role |
| Interactive, moved with `/bg` | Full interaction, like any background session. The row explains the route: "Type `/bg` in its terminal to drive it fully from here" | `claude attach`, as above |

**Order of work:**

1. **Security gate.** Nothing that accepts input ships before this (W6 finding 1). Another local user can currently learn the token, which is harmless only while pitwall is read-only.
   - **WebSocket auth by challenge-response:** the server sends a nonce, and the client answers with HMAC(token, nonce) using WebCrypto. The raw token never leaves the page, so a process squatting on the port learns nothing it can reuse.
   - **No token in process arguments:** `ps` shows other users the `open <url#token>` command line. Use a 0600 redirect file or a single-use launch code instead.
   - **Dev readiness:** `npm run dev` opens the browser only after the CLI child reports it's listening, not when anything answers on 4517.
   - **Every new input path** (the attach WebSocket, spawn, stop, remove) sits behind the token, `Host` and `Origin` checks, and only acts on sessions in the current snapshot.
2. **Session view.** Clicking a row opens the session: the full last message, and the conversation read from the transcript a page at a time, from the end, with tool calls collapsed. Read-only, so it works for every kind of session.
3. **Attach for background sessions.**
   - A PTY per open view, running `claude attach <id>` through `node-pty`, shown with xterm.js. It supports resize and input. Closing the view detaches, and the session keeps running.
   - `node-pty` is the first native dependency, so the build needs its install script approved, and CI builds it.
   - `claude attach` restarts a background session that isn't running (done, stopped or failed). That's an action, so the UI asks first: "This session isn't running. Attaching restarts it."
4. **Message interactive sessions through a relay.**
   - **The relay:** on first use, pitwall starts one headless session as its own child process, `claude -p` with stream-json input and output, named `pitwall-relay`, on Haiku, in `~/.pitwall/relay/`. Its tools are limited to `ListAgents` and `SendMessage`, and it's instructed to pass my text on verbatim. Pitwall writes each request to its stdin, so the text never appears in process arguments, and restarts it if it exits (D8).
   - **Sending:** a "Message this session" box on interactive rows. The relay reports what `SendMessage` returned (delivered, held for approval, or refused), and pitwall shows it.
   - **Replies:** the target's work shows in its own transcript, in the session view. A reply it sends back reaches the relay, and pitwall shows it on the target's row. The relay stops with pitwall, so a reply that arrives after that shows only in the target's own conversation.
   - **Cost:** one Haiku turn in the relay, plus one turn on the target's own model and effort, which is the same as typing the prompt there.
   - **Limits:**
     - The message can't approve prompts.
     - A target that bypasses permission prompts holds the message for approval in its terminal.
     - The target's own rules decide whether it acts.
     - No idle-notice subscriptions: each prints a notice in the target's terminal, and polling already sees busy-to-idle changes.
   - **Tests:** only `pitwall-test-*` targets, as in spike 002.
5. **The `/bg` route for full control.** The row explains it. Once moved, the session reappears as a background session with the same id, and attach works.
6. **Spawn.** A "New session" dialog with a directory under a root, picked from the grouped repos, a name, an optional model and the first prompt.
   - It runs `claude --bg --name <name> [--model <m>] "<prompt>"` with `execFile` (no shell) in that directory. The new session shows up in the list and can be attached straight away.
   - Show Claude Code's `Workspace not trusted` error with the command to run. Never grant trust for me.
7. **Stop and remove** a background session, with `claude stop <id>` and `claude rm <id>`, after a confirmation. `rm` keeps a worktree that has unpushed commits; show Claude Code's message when it does.

**Also in M2:**
- **Contract additions suggested during M1:**
  - my home directory in the snapshot, so the UI doesn't guess `~`;
  - an auth acknowledgement on the WebSocket, which the challenge-response handshake provides;
  - worktree branch names for sessions in worktrees;
  - a background job's "needs" line from `state.json`, behind the adapter.
- **Detect a transcript rewritten in place** within one poll (W6 finding 7), if Claude Code ever does that.
- **Tests never touch a real session.** Anything that attaches, spawns, stops or removes uses throwaway `pitwall-test-*` sessions on Haiku, removed afterwards. Live checks stay behind `PITWALL_LIVE=1`.

### M3 - My open pull requests

Read-only, and separate from the session index. Requested by Phil on 2026-10-16, and scheduled after M2 at his request.

- **Source:** one GraphQL search through `gh api graphql` (`is:pr is:open author:@me archived:false`), run with `execFile` and no shell, so the GitHub token stays inside `gh`.
  - One query returns the repo, number, title, draft, `reviewDecision`, `mergeable`, the latest commit's `statusCheckRollup` and `updatedAt`.
  - Measured on 2026-10-16: 44 PRs, 1 rate-limit point of 5,000 an hour, about 8 s.
  - `gh search prs` takes 2.6 s but has no CI or review state.
- **Cadence:** its own poller, every 3 minutes by default, plus a refresh button. Never tied to the 5 s session poll.
- **Grouping:** org, then repo, then PR, with the same collapsed-by-default groups and saved state as sessions.
  - Highlight failing CI, merge conflicts and changes requested.
  - Show draft and approved as quieter states.
- **Noise:** 45 open PRs across 12 orgs on 2026-10-16, many of them years-old PRs to other people's repos. Default to PRs updated in the last 90 days, with a count of the hidden ones and a toggle to show them. Consider an org allowlist flag later.
- **Linking to sessions:** a PR whose URL appears in a session's recent turns shows that session's name on the PR row, and the session row gets a PR badge.
- **Contract:** a separate `prs` message type and `GET /api/prs`, behind the same token and `Origin` checks. PR titles from private repos are as sensitive as session data.
- **Fails soft:** if `gh` is missing or not logged in, the panel says so, and the sessions view is unaffected.

### M4 - Supervisor

Pitwall starts and owns a supervisor session, shown in its own panel. The supervisor can list, summarise, message and spawn sessions. It's a background Claude Code session (D4), and it takes over M2's relay. How pitwall prompts it is decided at the start of M4: a running background session can't take a new prompt without a terminal (spike 003), which is why M2's relay is a headless process instead.

- **First: titles from each session's recent turns** (W7 decision C), replacing Claude Code's first-prompt titles from M1.
  - **Spike first:**
    - Can `claude -p --bare --no-session-persistence --model haiku` run on Phil's Max login, rather than needing an API key?
    - Does it stay out of `claude agents --json` and cross-session listings, so pitwall's own calls don't show up as sessions?
    - What does each title cost, and how long does it take?
  - **Then:** regenerate a session's title after new activity, once it's idle, at most every few minutes, within a token budget.
- **Relayed messages** are labeled in the UI as coming from the supervisor, because that's how the receiving session sees them.
- **Status comes from pitwall's index** (D1 polling and transcripts), not from messaging sessions. Each relayed message costs a full turn on the receiving session's model and effort, which was Opus 5.5 at xhigh in spike 002.
- **Don't subscribe to idle notices broadly.** Each subscription prints a notice in the watched session's terminal that names a raw socket address. Pitwall's own polling already sees busy-to-idle changes.

### M5 - Triage

Urgency ranking with reasons (time-sensitive, waiting on a decision, housekeeping, closeable), using the session index, the supervisor and M3's PR and CI state.

- **The supervisor refines M1's `askedYou` heuristic:** it reads each idle session's latest turns and judges whether it really needs me, and how urgently.
- **Age is a signal.** In the W5a calibration, five flagged sessions had been quiet for 2 to 14 days, and at least one question was moot.
- **PRs and sessions together,** for example: "CI is failing on your PR, and the session that opened it is idle."

## M2 work breakdown

Same way of working as M1. The coordinator owns the contract and the docs, sub-agents build in their own worktrees, a reviewer checks the integrated change, and Phil approves the merge. The rules for M1 below still apply.

| Item | What | Branch | Owner | Status |
| --- | --- | --- | --- | --- |
| W8 | Security gate: challenge-response WebSocket auth, the token kept out of process arguments (D7), dev readiness, and one guard shared by every input path | `m2/security-gate` | Sub-agent | Merged ([#11](https://github.com/leggetter/pitwall/pull/11)) |
| W9 | Session view: the conversation read-only, paged from the end, with tool calls collapsed | `m2/session-view` | Sub-agent | Merged ([#10](https://github.com/leggetter/pitwall/pull/10)) |
| W10 | Attach for background sessions: `node-pty` and xterm.js, asking before attaching restarts a session that isn't running (D9) | `m2/attach` | Sub-agent | Merged ([#13](https://github.com/leggetter/pitwall/pull/13)) |
| W11 | Message interactive sessions through the relay (D8) | `m2/relay` | Sub-agent | Merged ([#15](https://github.com/leggetter/pitwall/pull/15)): design D, decided by Phil on 2026-10-19 after spike [003](docs/spikes/003-relay.md) |
| W12 | Spawn, stop and remove | `m2/spawn` | Sub-agent | Merged ([#12](https://github.com/leggetter/pitwall/pull/12)) |
| W13 | Integration, and a live check with throwaway `pitwall-test-*` sessions | `m2/integration` | Coordinator | In progress: finished sessions listed muted, merged ([#14](https://github.com/leggetter/pitwall/pull/14)); the live check of the integrated branch passed on 2026-10-19 |
| W14 | Review with the `role-reviewer` skill, security first | - | Sub-agent | After W13 |
| W15 | Try it, and approve the merge | - | Phil | After W14 |

### Security gate as built (W8, 2026-10-16)

| Credential | Where it lives | Can |
| --- | --- | --- |
| Token | Printed to stdout, in the 0600 launch file while pitwall runs, and in the page's `sessionStorage` | Prove itself over the WebSocket through an HMAC, never sent. Authorize HTTP GETs, for scripts |
| `apiKey` | Server memory, and the page's API client only | Authorize every HTTP API call. State-changing calls (any method other than GET or HEAD) also need `Origin: http://127.0.0.1:<port>`, otherwise 403 |

- **Input routes:** every route that takes a session id resolves it with `resolveSession()` (`src/server/sessions.ts`), and builds commands from the returned summary, never from the raw parameter. Register input routes inside `createApp`, before the `/api/*` catch-all.
- **Web:** HTTP calls go through `ApiContext`/`api.get` in `web/src/api.ts`. A 401 means a stale `apiKey`, so the client reconnects; the page never sends the raw token.
- **Environment:** `PITWALL_HOME` overrides `~/.pitwall`. `PITWALL_OPEN_MARKER` is set by `npm run dev`, so the CLI child opens the browser once, after it's listening.
- **Residual risk, found by W8:** a relay attack. A squatter that could also reach a live pitwall using the *same* token could pass the challenge to the page and the proof back to the server. Per-run tokens and the fixed dev port rule this out today. Protocol v3 could close it by putting the origin into the HMAC. Low priority on a single-user Mac.

### Findings while building M2

- **Stopped background sessions left the list** (W12). After `claude stop`, a session has no process and appears only in `claude agents --json --all`, so it couldn't be removed, or attached to restart it.
  - **Decision (coordinator):** the index lists with `--all`, and the UI shows done, stopped and failed background sessions muted, like agent view's Completed group. Built at integration (W13) in [#14](https://github.com/leggetter/pitwall/pull/14): a `SessionSummary.finished` field, a muted, collapsed "Finished (n)" list per group that also counts the questions inside it, and group order that ignores finished sessions.
- **`--all` costs nothing measurable** (W13). 15 alternating runs of each form on Claude Code 2.1.302, with 16 sessions, or 18 with `--all`: a median of 0.14 s wall time, 0.145 s of CPU and about 150 MB at peak, either way.
- **A slow window in `claude agents --json`** (W13). For about 8 minutes on 2026-10-19, both forms took 18 to 34 s, about 4 s of CPU and 320 to 415 MB. It didn't reproduce, and the cause is unknown. During a window like that, pitwall's 10 s timeout fails every poll and shows the failure banner. Watch for it in the live check.
- **The live check of the integrated branch passed** (W13, `07f43c2`, 2026-10-19). 11 checks against the built CLI with throwaway Haiku sessions: the index (finished rows, the relay hidden), spawn (and the untrusted-directory error, with no trust granted), session view paging, attach (and the limit of 4), stop, restart by attaching, remove, the relay (delivered with a reply, 409 for a background session, ambiguous names), the security negatives (`Origin`, the raw token, `Host`, unknown ids, wrong proofs, no token or message text in `ps`), shutdown by SIGTERM and by SIGKILL with no orphans, and a headless UI smoke.
- **A stopped idle session stays `done`** (W13). Claude Code reports `stopped` only for a session stopped mid-turn. `finished` covers both.
- **Left for the review's fixes** (W13):
  - A just-spawned session lists for one poll with no pid, so attaching would ask to restart a session that's still starting.
  - A relay that fails before sending still records an exchange with `sentAt`.
  - When pitwall runs inside a Claude Code session, its children inherit `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION` and `CLAUDE_PID`.
- **Test transcripts stay behind** (W13). `claude rm` keeps a session's transcript, and `-p` sessions can't be removed, so each live check leaves its throwaway transcripts, which show in `claude --resume` in that directory.
- **"Done" isn't "not running"** (W10). A background session can be `done` with its process still alive and idle. Attaching to it doesn't restart anything, so pitwall asks before attaching only when there's no live process.
- **Inherited inbox credentials** (W10). When pitwall itself runs inside a Claude Code session, the processes it starts would inherit that session's `CLAUDE_CODE_MESSAGING_*` credentials and `CLAUDE_JOB_DIR`. They're now scrubbed, for attach and for spawn, stop and remove.
- **`node-pty` 1.1.0 on macOS** ships `spawn-helper` without its execute bit, so pitwall sets it on first use. On Linux with npm 11, the install script needs `npm install-scripts approve node-pty`. CI uses npm 10, which runs it.
- **The relay can't be a prompted `--bg` session without a terminal** (W11, spike 003). A running background session can't be given a new prompt over plain pipes: `--resume <id> --bg` starts a copy per message. The options are B (prompt a background relay through a PTY, which needs a one-time trust step) or D (pitwall runs the relay itself as a `claude -p` stream-json process). **Decided by Phil on 2026-10-19: D** (see D8).
- **`ListAgents` shows no directories** (W11). Two running sessions with the same name can't be told apart. So pitwall first checks the name against the unfiltered `claude agents --json --all`: exactly one live session must have it, and it must be the one asked for. Otherwise nothing is sent, and the message fails as an ambiguous name that `/rename` fixes.
- **The relay's send is checked, not prevented** (W11). Pitwall compares the relay's `SendMessage` call with the request byte for byte, but sees the call only after the tool has run. Haiku once kept a line break from the framing as part of the text: the check caught it, and the framing now puts the text inline, but the message had already arrived. A mismatch fails the request with "It may still have reached the session" and restarts the relay.
  - **For W14:** check whether a `PreToolUse` hook in the relay's `--settings` (if `--safe-mode` allows one), or the Agent SDK's `canUseTool`, can turn the check into a gate.
- **Relay live results** (W11). Delivered in 5.4 to 8.7 s through the relay manager, and about 3.9 s through the built CLI. Replies attached after 7 to 12 s. Targets set to `hold` and `refuse` gave `held` and `refused`. The relay exits within about 1 s of pitwall being killed with SIGKILL, because its stdin closes. Not tested: targets that bypass permissions, and the release, denial and expiry notices, which are matched by their wording.

### Decisions for M2

All three decided by Phil on 2026-10-16. D8 was revised on 2026-10-19, after spike 003. The reasoning is in `README.md`. Phil's Mac has only his account, so the gate is defense in depth rather than an urgent fix.

**Contract changes (W0 for M2), already on `m2/integration`:**
- **The handshake:** a `challenge` with `PROTOCOL_VERSION` 2, an `auth` proof (an HMAC of the nonce) and an `authenticated` reply carrying a per-process `apiKey`.
- **HTTP API calls** use the `apiKey`. The raw token is accepted only for scripts.
- **Session view types:** `ConversationEntry`, `ConversationPage` and `conversationPath()`.
- **Transition:** `LegacyClientAuth` keeps M1's raw-token auth compiling until W8 removes it.

- **D7 - Keep the token out of process arguments.**
  - (a) The CLI writes a page that sends the browser to the token URL, in a file only my user can read (0600, in a 0700 `~/.pitwall/` directory, removed on exit), and opens that file. This is the approach Jupyter takes.
  - (b) The CLI opens a URL with a single-use launch code, which the server swaps for the token once. The code is still visible in `ps` for a moment, so another user who wins the race gets the token and the real browser fails.
  - **Decided: (a).** The token rule now allows `~/.pitwall/` at 0700 (see Security).
- **D8 - The relay:** pitwall runs one headless session as its own child process: `claude -p --input-format stream-json --output-format stream-json`, named `pitwall-relay`, on Haiku, in `~/.pitwall/relay/`, with `--tools` and `--allowed-tools` both `ListAgents,SendMessage`, `--permission-mode dontAsk`, `--strict-mcp-config` and `--safe-mode`. `dontAsk` means nothing can prompt, and keeps the relay in the prompting permission class whatever my default mode is, so targets that prompt deliver rather than hold. It starts on first use, takes one request at a time on stdin, is restarted if it exits, and stops with pitwall.
  - **Not a background session,** as first decided on 2026-10-16. A running background session can't take a new prompt without a terminal. Prompting it through a PTY (option B in spike 003) works, but it scrapes a screen meant for people, puts the text in `ps`, and needs a one-time trust step.
  - **`crossSessionInbound: accept`, in its `--settings`:** a `-p` session can't show an approval dialog, so a message held at the relay, such as a reply from a target that bypasses permissions, expires after 5 minutes. The [docs](https://code.claude.com/docs/en/cross-session-messaging#non-interactive-sessions) advise `accept` for `-p` workers. It only changes messages from sessions that bypass permissions: the default already delivers the rest.
  - **Trust:** `-p` skips the trust dialog, which guards against a directory's own config running before you agree. The relay's directory is pitwall's own, empty and 0700.
  - **Trade-off:** a reply that arrives after pitwall exits isn't shown in pitwall. The target's conversation still has it.
  - **Decided: D, by Phil on 2026-10-19.** The M4 supervisor replaces it.
- **D9 - Attach limits:** one PTY per open session view, at most 4 at once, and closing the view or the tab detaches. Attaching to a background session that isn't running asks first, because `claude attach` restarts it. **Decided: as described.**

## M1 work breakdown

The coordinator, a Claude Code session working with Phil, owns `src/shared/protocol.ts`, the contract the pieces are built against. Sub-agents build W1-W4 and review in W6. Phil tries the result and approves merges.

| Item | What | Branch | Owner | Status |
| --- | --- | --- | --- | --- |
| W0 | The contract: `src/shared/protocol.ts` | `m1/scaffold` | Coordinator | Done |
| W1 | Scaffold: package, TypeScript, Vitest, Vite, CI, and stubbed module signatures | `m1/scaffold` | Sub-agent | Done |
| W2 | Index: `claude agents --json` source, root filter, git grouping, transcript adapter, poller | `m1/index` | Sub-agent | Merged ([#4](https://github.com/leggetter/pitwall/pull/4)) |
| W3 | Server and CLI: Hono, `ws`, token, `Host`/`Origin` checks, `pitwall [root...]` | `m1/server` | Sub-agent | Merged ([#3](https://github.com/leggetter/pitwall/pull/3)) |
| W4 | Web UI: grouped session list, live updates over the WebSocket | `m1/web` | Sub-agent | Merged ([#2](https://github.com/leggetter/pitwall/pull/2)) |
| W5 | Integration and a read-only run against real roots | `m1/integration` | Coordinator | Done; findings below |
| W5a | Fixes from W5: "asked you" heuristic, stale rule, markdown stripping, missing directories | `m1/followups` | Sub-agent | Merged ([#5](https://github.com/leggetter/pitwall/pull/5)) |
| W6 | Review of the integrated change, with the `role-reviewer` skill | - | Sub-agent | Done: approve with follow-ups |
| W6a | Fixes from the W6 review, plus groups collapsed by default with their state saved (W7 feedback) | `m1/review-fixes` | Sub-agent | Merged ([#7](https://github.com/leggetter/pitwall/pull/7)) |
| W7a | W7 feedback: full replies on expand, change-only pushes with a heartbeat, a 5 s default poll with `--interval`, and Claude Code's session titles | `m1/w7-feedback` | Sub-agent | Merged ([#8](https://github.com/leggetter/pitwall/pull/8)) |
| W7 | Try it, and approve the merge | - | Phil | Approved; merged in [#6](https://github.com/leggetter/pitwall/pull/6) |

### W5 findings (2026-10-16)

Run read-only against `~/hookdeck/git`: 17 of 17 sessions found and grouped by repo, live updates every poll, no console errors, clean shutdown, 315 tests passing.

- **"Needs you" missed most of what needed Phil.** 1 of 17 sessions was flagged, against 10 in the manual sweep that morning. Interactive sessions only report busy or idle, so one that ended its turn with questions looks the same as one that's done.
  - **Decision (Phil):** option C. Add a transcript heuristic now (`askedYou` in the contract). M5 triage, with the M4 supervisor, refines it later.
- **Stale missed abandoned jobs that still had a process.** A background job blocked since 24 Sep was flagged as needing Phil. Stale is now 7 days without activity, with or without a process.
- **Raw markdown made the rows hard to read.** The index now strips markdown syntax before truncating.
- **A deleted working directory grouped as a plain folder.** Rows now say the directory no longer exists (`cwdMissing`).
- **Calibration after W5a:** 12 of 17 sessions flagged (11 asked you, 1 blocked).
  - **Matched the morning sweep:** every session it had rated as waiting that still was, 7 sessions.
  - **Correctly cleared:** two sessions that had moved on since the morning.
  - **Extra flags:** small or moot questions the morning sweep had rated as housekeeping or closeable, including one whose question went moot when its PR merged.
  - **What that means:** the heuristic finds what's waiting; judging urgency and spotting moot questions is M5's job.
- **Heuristic rules decided:**
  - **An "Open questions: None" section decides,** even if a later line ends in a question mark. That matches how Phil's sessions write.
  - **Ranking older questions lower is left for M5.**

### W6 review findings (2026-10-16)

Verdict: approve with follow-ups. The reviewer probed the built CLI and found these hold:
- **Host, Origin and token checks,** including DNS rebinding, absolute-form targets and encoded-path bypasses.
- **Static-file containment.**
- **The token kept out of child processes.**
- **No code path that acts on a session.**
- **A transcript reader that survives hostile files.**

- **Fixed before the merge (W6a):**
  - blocked background jobs sorting to the bottom of their group (#2);
  - text patterns that can block the event loop for about 20 s on pathological output (#3);
  - a CLI test that ran the real `claude` (#4);
  - submodule grouping (#6);
  - attach ids starting with `-` (#8);
  - trusting `localhost` when the server only listens on 127.0.0.1 (#9);
  - a duplicate React key (#10);
  - and the missing tests (#12).
- **Fixed by the coordinator:** stale status lines (#5) and real session names in this file (#11).
- **Moved to M2:** the token exposure to other local users (#1), as a security gate before any input path, and in-place transcript rewrites (#7).

### W7 feedback (2026-10-16)

From Phil's first look at the running UI.

- **Replies were cut off, even when expanded.** The snapshot carries at most 500 characters per reply.
  - **Decision:** fetch the full reply when a row is expanded, from `lastMessagePath(sessionId)`. Keep the 500-character preview in the snapshot.
- **The first view was a wall of text.**
  - **Decision:** groups start collapsed, and each group's open or closed state is saved in `localStorage` (pruned, failing safe to collapsed). This went into W6a, because it touches the same code.
- **Polling cost.** Each `claude agents --json` call takes about 0.18 s of CPU and peaks at about 150 MB of memory. At a 2 s interval that's roughly 9% of a core, and the server pushed the full 20 KB snapshot after every poll.
  - **Decision:** poll every 5 s by default, with `pitwall --interval <seconds>`. Push the full snapshot only when it changed, and a heartbeat otherwise.
- **Session names like `git-a0` don't say what a session is about.**
  - **Decision:** option C.
    - **Now:** show Claude Code's own generated title after the name (`titleSource: 'claude-code'`). It's free, but it's set once from the first prompt and never updated.
    - **M4:** replace it with a title pitwall generates from the session's recent turns (`titleSource: 'pitwall'`).

### Module layout

```
src/shared/protocol.ts   the contract (W0)
src/index/               W2. Entry point index.ts: startIndexer(options) -> Indexer
src/server/              W3. Entry point index.ts: startServer(options) -> running server
src/cli.ts               W3. Parses arguments, starts the indexer and the server, opens the browser
web/                     W4. Vite + React app, built to dist/web and served by the server
```

### Rules for M1

- **Token transport** (M1; superseded in M2 by the challenge-response handshake, the `apiKey` and the launch file, under "Security gate as built"): the CLI opens `http://127.0.0.1:<port>/#token=<token>`. The UI reads the token from the fragment, keeps it in `sessionStorage`, and removes it from the address bar.
  - HTTP API calls send `Authorization: Bearer <token>`.
  - The WebSocket sends `{ "type": "auth", "token": ... }` as its first message.
  - Static assets need no token. `Host` is checked on every request, and `Origin` on every API request and WebSocket upgrade.
- **No Vite dev server in M1.** `npm run dev` rebuilds the UI on change and the pitwall server serves it, so the UI is always same-origin and the security checks never need a dev exception.
- **Dev token:** `npm run dev` generates one token per run and passes it as `PITWALL_TOKEN`, which must be at least 32 base64url characters. It also uses a fixed port, 4517, and opens the browser once. The CLI removes `PITWALL_TOKEN` from its environment, so processes it starts don't inherit it.
- **CSP:** `connect-src` names the WebSocket origin explicitly (`ws://127.0.0.1:<port>`), because older Safari may not match `ws:` against `'self'`.
- **Only `127.0.0.1` is trusted,** for `Host`, `Origin` and the CSP, never `localhost`. The server listens on 127.0.0.1 only, and `localhost` can resolve to `::1`, where another local user could listen (W6 finding 9).
- **No `node-pty` in M1.** It arrives with attach in M2, so CI doesn't build a native module yet.
- **Merges:** the coordinator merges W1 into `main`, and W2-W4 into `m1/integration`, once CI is green and the coordinator has reviewed the diff. The integration PR into `main` gets the W6 review and needs Phil's approval.
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
- [x] Build M1 (merged in #6)
- [ ] M2: interact with sessions, security gate first
- [ ] M3: my open pull requests
- [ ] M4: supervisor
- [ ] M5: triage

---

_Drafted with Claude Code on 2026-10-16, from the session that ran the first manual sweep of 15 live sessions._
