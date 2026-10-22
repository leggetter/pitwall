# Plan

The living plan for pitwall. Read it before picking up work, and update it in the same commit as the work. Settled decisions move to `README.md` with their reasoning; this file keeps what is true now and what happens next.

## Summary

| | |
| --- | --- |
| **Decision** | Build pitwall: a local CLI and web UI that lists, groups and drives the Claude Code sessions already running on this machine, spawns new ones, and puts a supervisor session in front of them. |
| **Status** | M0, M1 and M2 done. M1, a read-only index, merged into `main` on 2026-10-16 in [PR #6](https://github.com/leggetter/pitwall/pull/6). M2, interacting with sessions from the web UI, merged on 2026-10-20 in [PR #19](https://github.com/leggetter/pitwall/pull/19), approved by Phil after his try-out. M3, a design system and restyle, is in progress on `m3/integration`: the design system doc, the `#uikit` gallery, the theme, the three-column shell, two-line rows, the session view, and the message box, alerts and confirmations are merged. |
| **Risk** | Pitwall can reach an interactive session in Warp or Cursor only through cross-session messaging. That reaches the session's Claude as a message from another session, not as my prompt, so it can't approve anything, and the receiving session's own rules decide whether it acts at all (spike 002). Full control needs the session moved to the background with `/bg` (D2). |
| **Next steps** | - W32: Phil finishes the try-out and approves M3's merge into main<br>- Then M4, my open pull requests |

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
- **Browser storage holds no token or session content.** The token is in `sessionStorage` only (M2). `localStorage` holds UI state under `pitwall.*.v1` keys: preferences (theme, sort, shortcuts, panel width) and, in `pitwall.view.v1`, `pitwall.finished.v1` and M1's `pitwall.groups.v1`, filesystem paths of roots and repos (W31, 2026-10-21).
- Don't write the token or session content anywhere outside `~/.claude`, except the launch file (D7): one HTML file at 0600 in `~/.pitwall/` at 0700, deleted once a page has used it, after 60 s, or on exit, whichever comes first. The relay gate's expectations (D8) hold a session name and a hash, never message text, in 0600 files in `~/.pitwall/relay-gate/` at 0700, each deleted when its request ends.

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

### M2 - Interact with sessions from the web UI (done)

Open a session from its row, drive background sessions fully in the browser, start new sessions, and stop or remove them. Prioritised ahead of the PR view by Phil on 2026-10-16.

**What can be driven from the browser, by session kind:**

| Session kind | In the web UI | How |
| --- | --- | --- |
| Background, including sessions pitwall starts | Full interaction: type prompts, answer permission prompts and dialogs | xterm.js over a PTY running `claude attach <id>` (D3, spike S3) |
| Interactive, in Warp or Cursor | **Send it a message.** The message starts a turn, and the session does the work within its own permissions and rules. It can't take a permission approval from me, and it sees the message as coming from another session (spike 002) | A relay: a headless Claude session (`claude -p`) that pitwall runs, limited to `SendMessage` behind a gate (D2, D8). The M5 supervisor later takes over this role |
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
   - `claude attach` restarts a background session that isn't running (done, stopped or failed). That's an action, so the UI asks first: "This session has finished, or its process has exited. Attaching restarts it." The server decides when the socket opens, re-reading `claude agents --json --all` when the snapshot's process isn't alive. A session that is still starting gets "try again in a moment" instead.
4. **Message interactive sessions through a relay.**
   - **The relay:** on first use, pitwall starts one headless session as its own child process, `claude -p` with stream-json input and output, named `pitwall-relay`, on Haiku, in `~/.pitwall/relay/`. Its only tool is `SendMessage`, behind a gate that allows only the exact message I asked for (D8), and it's instructed to pass my text on verbatim. Pitwall writes each request to its stdin, so the text never appears in process arguments, and restarts it if it exits (D8).
   - **Sending:** a "Message this session" box at the foot of an interactive session's view, which the row's Message button opens ([#20](https://github.com/leggetter/pitwall/pull/20)). The relay reports what `SendMessage` returned (delivered, held for approval, or refused), and pitwall shows it.
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
- **Tests never touch a real session.** Anything that attaches, spawns, stops or removes uses throwaway `pitwall-test-*` sessions on Haiku, removed afterwards. Live checks stay behind `PITWALL_LIVE=1`. Since W31, `src/test/noClaude.ts` enforces it: without that flag, a server test that would run `claude`, through `child_process` or node-pty, fails.

### M3 - Design system and restyle (in progress)

A design system for pitwall, inspired by Hookdeck's UX, and the web UI restyled to it. It's pitwall's own design system, not Hookdeck's. Requested by Phil on 2026-10-20 after trying M2, which also moved the message box to the foot of the session view ([#20](https://github.com/leggetter/pitwall/pull/20)). Whether pitwall is open-sourced, and how, is undecided.

- **Reference:** `docs/design-system.md`, pitwall's spec: tokens by role (surface, text, border, tone) for light and dark, type, spacing, components, states, layout and keyboard. Every text colour pair meets WCAG AA. A dev-only gallery in the app (`#uikit`) shows each component and is the living reference.
- **Look:** pitwall's own palette, type and component shapes, inspired by Hookdeck's UX, with every text pair at WCAG AA or better (`contrast.test.tsx` checks them). No Hookdeck logo, illustrations or integration logos.
- **Fonts and icons:** Inter and JetBrains Mono (both OFL 1.1), self-hosted, because the CSP (`default-src 'self'`) blocks Google Fonts. Icons from Material Symbols Rounded (Apache 2.0), bundled as SVGs behind a semantic name map. The theme's pre-paint script is a same-origin file, for the same reason.
- **Order of work:** the items in "M3 work breakdown" below, one reviewable PR each, in that order, except that the rows (W23) come before the session view (W22). The session list then gets two-line rows soon after the three columns land. The repo-grouping spike (W33) runs alongside the shell, and its build (W34) follows the rows.
- **Also from the try-out:** a plain error, not a stack trace, when pitwall runs in a directory that no longer exists. It reads the current directory even when every root is absolute.
- **Three columns** (Phil, 2026-10-20): the repo list, then the selected group's sessions, then the open session. They replace the list of grouped cards, which no longer collapse, so the earlier "collapsed groups stay as they are" call is moot.
  - The repo list starts with two views, Needs you and All sessions. Needs you replaces the "Needs attention only" checkbox.
  - Rows drop to two lines: name, title, badge and time, then what the session asked or was last asked. The last reply, relay exchange, cwd, attach command and Message button move to the session view (coordinator).
  - Rows that need you lose their yellow tint and keep the bar and the badge (coordinator). Nine of Phil's fifteen sessions needed him on 2026-10-20, and the tint turned most of the list yellow.
  - The repo list is in alphanumeric order, so it never jumps (Phil, 2026-10-20). The root's own directory comes first.
  - The session list sorts by urgency, with a Sort setting for Recent and Name (Phil, 2026-10-20).
- **Sessions also show under the repos they work in** (coordinator, 2026-10-20, a call Phil left to me). Phil starts sessions inside `~/hookdeck/git`, the folder that holds his repos. Grouping only by where a session started would put most of them in one group, and the repo list would sort little of his work. Each session's tool calls name the files it reads, edits and searches, and those paths say which repos it works in. Spike 004 (W33) measures that on his live sessions, read-only, before anything is built.
  - The root's own directory is labelled with its path, not "git". Seven of those fifteen sessions run in `~/hookdeck/git` itself, not in a repo under it.
  - **The root's own group** (Phil, 2026-10-21): it's whichever root pitwall was started with, not `~/hookdeck/git` in particular. It holds only the sessions started in the root that worked in no repo. A session started in the root that works in repos is listed under those repos.
  - **Directories below the root that aren't repos** keep their own groups (Phil, 2026-10-21), listing the sessions started in them. A session there that also worked in repos shows in both (coordinator, as a start group does).
  - **Hiding repos, not an age limit** (Phil, 2026-10-21, from the try-out). A long-running session was still listed under a clone of another project's repo that it last worked in 44 days before its latest work. W33's rule read it correctly: 135 of its 2,186 tool calls and 3 commits were there. Rather than age old repos out, a repo or directory can be hidden from the repo list, and the hidden ones are listed at its foot, to unhide (W35). Hiding is kept in browser storage under a key per root, so two pitwalls watching different roots keep separate lists (Phil). Storage is per origin as well, so a pitwall on a fallback port starts with none; a fixed `--port` keeps them.
- **Idle sessions show no badge in the list** (Phil, 2026-10-20), only "Idle" in the session view, on condition that needs-attention is still inferred. It is: `needsAttention()` comes from waiting, blocked and asked-you, never from the badge.
- **Sending stays ⌘↵,** and Enter adds a line (Phil, 2026-10-20). Each message starts a turn on the target's model and can't be taken back.
- **Disabled text is the one contrast exemption** (coordinator, 2026-10-20), as WCAG 1.4.3 allows for inactive controls.
- **W20's judgement calls stand** (coordinator, 2026-10-20). Each old type size moved to the scale step its role in the doc's 2.7 picks, and the danger button is solid, as section 4 says. The 16 px icons draw the 20 px optical size, Material's nearest. The gallery dropped its "no `data-theme`" option, because `tokens.test.tsx` checks the no-JavaScript dark block is an exact copy.
- **Markdown in the session view** (Phil, 2026-10-21, from the try-out). The conversation showed every fenced code block as "[code]", tables as lines joined with " · ", and no bold. It reused the list rows' markdown stripping (W5a), though the design system already styles code blocks. Assistant messages and messages from other sessions now come as markdown, and the page renders a safe subset as its own elements, never as HTML. Prompts come as typed (W36).
- **Links in code** (Phil, 2026-10-21, from the try-out: "Can links in quoted sections also be usable links?"). Links in a `>` quote already work. A code block's URLs were text, as CommonMark and GitHub keep code literal, so the review links in a Slack draft Claude wrote couldn't be opened. Coordinator's call: bare `http:` and `https:` URLs in code blocks and inline code become links, under W36's link rule, because Claude's drafts and commands often sit in code, and terminals such as iTerm2 make a URL cmd-clickable wherever it is. The code's text, Copy and selection don't change (W37).
- **Roots as tabs** (Phil, 2026-10-21, from the try-out: "one pitwall, two roots, roots shown as tabs", for `~/hookdeck/git` and `~/leggetter/git`). One pitwall already watches several roots, with a repo-list section per root. With two or more, the header's root path becomes a tab per root, and each tab narrows all three columns to its root, Needs you and All sessions included. Chosen over two pitwalls in two browser tabs, which double the polling, scanning and relays, and over one page showing other pitwalls, which would need each one's token and a looser CSP. Coordinator's calls: no All roots tab, since a two-root pitwall without tabs is that view; an inactive tab carries its root's needs-you badge, so nothing that needs Phil is out of sight (W38).
- **Each session in one group** (Phil, 2026-10-21, from the try-out: "The problem is duplication, where I'm seeing one session in hookdeck/git and multiple sub directories"). This reverses W34's "also listed under": a session is listed only under the group it started in. On Phil's list that day, 12 of 20 sessions were listed in more than one group, and the 7 started in `~/hookdeck/git` itself were listed under 19 repos. Their root's own group grows from 1 to 7, and five repos with no session started in them leave the list. W34's scanner and rule stay, for the session view's "worked in" line and for the filter, which still finds a session by a repo it worked in. Coordinator's reading: duplication covers a sibling repo too, so a session started in one repo isn't listed under another it worked in (W39).
- **A pinned tab survives a restart** (Phil, 2026-10-21: he pins pitwall's tab, and "the token seems to die every so often"). The page keeps the token in that one tab's `sessionStorage`, so the pinned URL has none, and each run mints a new one (D7). First chosen, then removed by Phil the same day: a hand-off, in which the tab the CLI opens passed its token to pitwall tabs already open on that origin, with `pitwall open` for browser restarts. Its residual risk was a page another account's process served on the port, still open when pitwall starts, receiving the new token. Instead (Phil: "Can't we just hardcode a token for development or override in .env ... only used on a single user machine or during dev. This is a single user machine"): `PITWALL_TOKEN`, which the CLI already took, is now also read by `npm run dev`, from the environment or the pitwall repo's own `.env`, never a `.env` in the current directory; both say at start that the token is fixed. A fallback port can't be pinned, so the CLI says to use `--port`. Rejected: the token in `localStorage` (D14), and a cookie, which browsers share across ports on 127.0.0.1. Found on the way: `npm run dev` already kept one token across its restarts, and the coordinator had wrongly told Phil to fetch a new URL after each (W40).
- **Ending a terminal session** (Phil, 2026-10-21: "close a session and kill the terminal process", worried about side effects). Claude Code documents `claude stop` and `claude rm` for background sessions only, and no way to end an interactive session from outside its terminal; signal handling is documented for `claude -p` only. Pitwall never closes a terminal tab: the parent process isn't always a shell, and killing it ends everything else in the tab. Now: the session view says how to stop one, with `/bg` in its terminal and then Stop (W40). After M3: spike 005 measures ending the Claude process itself.
- **Shift+Enter in the terminal** (Phil, 2026-10-21: "In the terminal view/pane, can Shift+Enter result in a newline?"). xterm.js sends a carriage return for Enter with or without Shift, so Claude Code submits. Claude Code's terminal docs say Ctrl+J, a line feed, adds a line break "in every terminal with no setup" (code.claude.com/docs/en/terminal-config, read 2026-10-21), so the terminal pane sends a line feed for Shift+Enter, as `/terminal-setup` binds Shift+Enter in terminals that need it (W41).
- **View preferences: how sessions are grouped** (Phil, 2026-10-21: "I'd really want 'git-76 · Build delivery plan for Hookdeck Evals' to be in the evals repo", then "can we make the options we have configurable? some sort of view preferences?"). git-76 started in `~/hookdeck/git` itself, and its 1,642 tool calls and 183 changes in evals far outrun any other repo. A View preferences menu in the header sets Group sessions by: Main repo (the default), Where it started (W39), or Every repo it worked in (W34). Main repo moves only a session started in a root itself, to the repo it changed most, ties broken by tool calls; one that worked in no repo stays in the root's group. Phil agreed the coordinator's leans: Main repo by default; a session may move to a repo under another root, and so to that root's tab; Sort stays in the session list. The page groups the snapshot itself, so switching is instant, and the server still lists each session where it started (W42).
- **The relay changed a long message** (Phil, 2026-10-22, from the try-out: the page said "pitwall blocked a message you didn't ask for"). Phil sent a 6,309-character pasted message twice. Each time the relay's model wrote line 33's no-break space (U+00A0) as a plain space, and the first time it also added 25 characters after it, so the gate blocked both and nothing was sent. The relay's own transcript showed this, compared by shape only, never printed. The alert's wording was wrong: it says another session usually causes it, but the server had logged a mismatch on Phil's own message. Agreed with Phil (2026-10-22): look-alike spaces become a plain space and CRLF becomes LF before the relay sees the text, and the gate stays exact. A changed copy that the gate blocked is tried once more, which is safe because Claude Code's own tool result says the gate denied it. The message's result says where the copy differed, by line and character code, never the text, and the alert tells a changed message apart from one nobody asked for (W43).
- **Drafts survive a reload** (Phil, 2026-10-22: "if a message isn't sent, can it be persisted between reloads? It'd need to be tied to a specific conversation"). The message box's draft lived only in the page's memory, so a reload lost it, as it lost the message W43's bug had stopped. Each conversation's draft is now kept in the tab's `sessionStorage` under `pitwall.draft.v1:<sessionId>` and cleared by the same rule as before. Phil chose `sessionStorage` over `localStorage`: a draft lasts as long as the tab, as the token does, rather than staying on disk after the tab has gone, and two tabs don't overwrite each other's drafts. D14's "no session content" in browser storage gains this one exception (W44).
- **A steady cursor in the terminal** (Phil, 2026-10-22: "The cursor doesn't need to flash in the terminal view. It's distracting."). pitwall itself set xterm.js's `cursorBlink` to true. The cursor stops blinking, and stays steady if the program asks for a blink, keeping the shape it asks for. A steady cursor is less distracting, and WCAG 2.2.2 asks that blinking can be stopped (W45).
- **Settled decisions** are in the README as D10 to D16 (2026-10-21): the design system, fonts and icons; the three columns and their widths; two-line rows, no tint, no idle badge and the urgency sort; ⌘↵, the shortcuts and F6; and a snapshot that carries only what the list shows, without each session's latest reply; markdown in the session view as pitwall's own elements; and several roots as tabs.

### Spike 005 - Ending an interactive session (after M3)

Phil, 2026-10-21: run it after M3. Whether pitwall can end a session running in a terminal by signalling its Claude process, leaving the tab at its shell prompt. Pitwall never closes the tab itself.

- **Run by:** the coordinator, never a sub-agent, on about six throwaway `pitwall-test-*` sessions on Haiku, in a scratch folder Phil creates and trusts himself.
- **Measure:** SIGTERM, SIGINT and SIGHUP; the exit code; whether the transcript is whole and `claude --resume` reopens it; what happens to a background command, a sub-agent and a stdio MCP server; whether SessionEnd hooks run; whether the row leaves `claude agents`; and what a kill during a commit leaves behind, such as `.git/index.lock`.
- **Guards, if it's built:** idle sessions only, unless Phil confirms a stronger warning; the confirmation names the session and what runs under it; pitwall refuses a process it runs under itself (on 2026-10-21, Phil's dev pitwall ran under the coordinator's session); the server looks up the PID from a fresh `claude agents` call and checks it again just before signalling; SIGTERM, never SIGKILL; and the view says how to resume.

### M4 - My open pull requests

Read-only, and separate from the session index. Requested by Phil on 2026-10-16, and scheduled after M2 at his request. M3, the design system, went in ahead of it on 2026-10-20; Phil didn't mind the order.

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

### M5 - Supervisor

Pitwall starts and owns a supervisor session, shown in its own panel. The supervisor can list, summarise, message and spawn sessions. It's a background Claude Code session (D4), and it takes over M2's relay. How pitwall prompts it is decided at the start of M5: a running background session can't take a new prompt without a terminal (spike 003), which is why M2's relay is a headless process instead.

- **First: titles from each session's recent turns** (W7 decision C), replacing Claude Code's first-prompt titles from M1.
  - **Spike first:**
    - Can `claude -p --bare --no-session-persistence --model haiku` run on Phil's Max login, rather than needing an API key?
    - Does it stay out of `claude agents --json` and cross-session listings, so pitwall's own calls don't show up as sessions?
    - What does each title cost, and how long does it take?
  - **Then:** regenerate a session's title after new activity, once it's idle, at most every few minutes, within a token budget.
- **Relayed messages** are labeled in the UI as coming from the supervisor, because that's how the receiving session sees them.
- **Status comes from pitwall's index** (D1 polling and transcripts), not from messaging sessions. Each relayed message costs a full turn on the receiving session's model and effort, which was Opus 5.5 at xhigh in spike 002.
- **Don't subscribe to idle notices broadly.** Each subscription prints a notice in the watched session's terminal that names a raw socket address. Pitwall's own polling already sees busy-to-idle changes.

### M6 - Triage

Urgency ranking with reasons (time-sensitive, waiting on a decision, housekeeping, closeable), using the session index, the supervisor and M4's PR and CI state.

- **The supervisor refines M1's `askedYou` heuristic:** it reads each idle session's latest turns and judges whether it really needs me, and how urgently.
- **Age is a signal.** In the W5a calibration, five flagged sessions had been quiet for 2 to 14 days, and at least one question was moot.
- **PRs and sessions together,** for example: "CI is failing on your PR, and the session that opened it is idle."

## M3 work breakdown

Same way of working as M2, on `m3/integration`. Each item builds from `docs/design-system.md` alone and grows the `#uikit` gallery with what it adds. Sizes: S under half a day, M one to two days, L three or more.

| Item | What | Branch | Size | Status |
| --- | --- | --- | --- | --- |
| W17 | The design system doc | `m3/design-system` | M | Merged ([#21](https://github.com/leggetter/pitwall/pull/21)) |
| W18 | Tokens renamed to `--pw-*` with no visual change, plus self-hosted fonts and icons, bundled but not yet applied | `m3/tokens` | M | Merged ([#23](https://github.com/leggetter/pitwall/pull/23)): 36 before/after screenshot pairs byte-identical, no font downloaded. The icon package has only the 48 px optical size; W19's gallery checks it at 16 px |
| W19 | A dev-only `#uikit` gallery, in both themes | `m3/uikit` | M | Merged ([#24](https://github.com/leggetter/pitwall/pull/24)). The 48 px icons are too thin at 16 px, so W20 switches to the 20 and 24 px optical sizes |
| W20 | Apply the theme: the palette, Inter and JetBrains Mono, a 14 px body, radii, shadows and the focus ring; `theme-init.js` and the theme switch; icons from the 20 and 24 px optical sizes | `m3/theme` | M | Merged ([#25](https://github.com/leggetter/pitwall/pull/25)). `contrast.test.tsx` checks every pair in the doc's 2.5 against `tokens.css`, and `tokens.test.tsx` checks the file matches 2.6. `data-theme` is set before first paint in all 9 headless cases, with no CSP errors. `paths.ts` regenerates byte-identical from the pinned commit |
| W21 | The app shell: full width, the header, three columns that scroll on their own, the repo list with Needs you and All sessions (a drawer below 900 px), the session list's header with the filter field and chips, `?view=` and `?repo=` | `m3/shell` | L | Merged ([#26](https://github.com/leggetter/pitwall/pull/26)), squashed. Checked headless at 375 to 1,440 px: the page never scrolls, each column does, and the session view opens, scrolls, sends and closes. Layout comes from the app's width (`layout.ts`, `data-layout`), with a new low-height breakpoint at 480 px where the page scrolls as a whole. `--pw-shadow-card` is now unused |
| W22 | The session view: the third column from 1,200 px or over the session list, the divider, header and actions menu, Conversation and Terminal tabs, footer, `?session=`, ↑/↓ and focus | `m3/session-view` | L | Merged ([#29](https://github.com/leggetter/pitwall/pull/29)). One session view in every layout, so crossing 1,200 px no longer remounts it, reloads the conversation or detaches. The resizing divider (`pitwall.panel-width.v1`), the actions menu (Copy session ID, Copy attach command, Stop, Remove) on a reusable `MenuButton`, Conversation and Terminal tabs (Terminal attaches, Conversation detaches), focus on the heading, ↑/↓, Escape's layers, and `?session=` that opens the view and never attaches or sends |
| W23 | Two-line rows without the needs-you tint, badges, the connection badge, the Finished section, the Sort setting, and holding row order while I'm in the list | `m3/rows` | M | Merged ([#28](https://github.com/leggetter/pitwall/pull/28)). Rows are two lines with no tint, Message button, reply or cwd; no idle badge in the list, and `needsAttention()` unchanged, checked over every combination of status, state, asked-you, stale, finished, alive and kind. Sort is Urgency, Recent or Name (`pitwall.sort.v1`), and order holds while the pointer or focus is in the list. `--pw-state-attention-row` and `--pw-shadow-card` removed. The web UI no longer calls `GET /api/sessions/:id/last-message`, so that route, `lastMessagePath()` and the `LastMessage` type now serve only tests; remove them in W31 unless something needs them |
| W33 | Spike 004: which repos a session works in, judged from the paths in its tool calls, measured read-only on live sessions | `m3/spike-repo-grouping` | S | Done ([#27](https://github.com/leggetter/pitwall/pull/27), [write-up](docs/spikes/004-repo-grouping.md)). The rule: a session shows under a repo it changed, or one that at least 5% of its tool calls touched, counting sub-agents: 1 false positive and 3 misses on 28 hand-judged repos, 10 of 14 sessions exactly right. Bash carries most of the signal. A full scan is about 2 s of reading and 2 to 3 s of git, off the poll. Two slips by the sub-agent: it ran `claude --version` once (no session started), and a backgrounded command's output briefly held session id prefixes and repo labels in the scratchpad before it deleted it |
| W34 | Show each session under the repos it works in, by W33's rule: the index, a contract field, and the repo list's counts | `m3/repo-grouping` | M | Merged ([#39](https://github.com/leggetter/pitwall/pull/39), 0200474). Phil, 2026-10-21: go, before his try-out; the root's own group is whichever root pitwall was started with, and holds only the sessions started there that worked in no repo; a directory below the root that isn't a repo keeps its own group, and a session there that also worked in repos shows in both (coordinator). Contract (coordinator, fb0ff64 and ff947d2): `SessionSummary.workedIn` and `WorkedIn`, and a group lists every session shown under it. Built as spike 004 recommends: `src/index/workedIn.ts` and `toolCalls.ts`, off the poll, in memory only, read-only git at repo boundaries, at most 2 at once, and none for a repo outside every root. A repo under any configured root counts (coordinator). Benchmark on 723 MiB of made-up transcripts: a full scan in about 2 s, about 30 MiB more memory, polls of 1 to 7 ms while it runs, and about 10 ms with no git for later updates. The web UI counts each session once, the session view says where a session started and worked, and a focused row that leaves the list hands focus on. Also fixed: the gallery's three-column frames, now scaled to fit. Coordinator's rulings: the bare start label in a repo's list, with a visually hidden "Started in"; the emptied root group says its sessions are under the repos they worked in; 0.27 scale for 1,280 px gallery frames at 375 px. For the try-out: the 5% threshold and false positives on real sessions; startup git counts and memory on real transcript sizes; nested repos reached only through `gh`. Later, from the spike: ageing a long session's old repos, re-checking the threshold after a week, and deleted worktrees |
| W24 | The message box, relay alert and app strip, and inline confirmations | `m3/message-box` | M | Merged ([#31](https://github.com/leggetter/pitwall/pull/31)), on the snapshot's new `relayOff` ([#30](https://github.com/leggetter/pitwall/pull/30), coordinator), because `relayAlert.blocked: false` also covers alerts that only restart the relay. Shared `Button` (aria-disabled and busy), `Spinner`, `Alert`, `InlineConfirm`, `KeyCaps` and `AppStrip`; every disabled button is now `aria-disabled` and ignores clicks, keys and submits; the strip shows only with `relayOff`; the relay alert's danger title is "may have sent" |
| W25 | Overlays: the new-session dialog, menus, toasts, tooltips, copy buttons and timestamps | `m3/overlays` | M | Merged ([#32](https://github.com/leggetter/pitwall/pull/32)). `Tooltip` names icon buttons (`aria-label`), describes controls (`aria-describedby`) or, on elements that are never focusable, opens on hover only; that last case replaces the doc's old rule of keeping `title` there. `InfoTip` makes the `/bg` and limits notes focusable. Toasts sit in an `aria-live` stack that's always rendered, so Started, Stopped, Removed and Copied are announced. `Dialog` traps and returns focus at `--pw-z-backdrop`/`--pw-z-dialog`, and the new-session dialog is rebuilt on it. Every copy goes through `copy.ts`; new token `--pw-copied-timeout`. `Timestamp` runs on one shared interval (`clock.ts`), so the Dashboard no longer re-renders every second. The only `title`s left are the conversation entries', and `titles.test.tsx` allows no others |
| W26 | Keyboard shortcuts and their dialog, with the off switch | `m3/keyboard` | M | Merged ([#33](https://github.com/leggetter/pitwall/pull/33)). `/`, `n`, `?` and `j`/`k` from one document listener (`shortcuts.ts` decides which key is which), ignored while typing, in `.xterm`, with ⌘, Ctrl or Alt, while an IME composes, over a dialog or the drawer, and on `n`/`?` auto-repeat; a shortcut closes an open menu first (`closeMenus()`). The shortcuts dialog is on `Dialog`, and a test checks it lists exactly 6.2's rows. The off switch is `pitwall.shortcuts.v1`, on by default and across tabs; off hides the `/` cap and single-key tooltip caps. Two coordinator-accepted calls beyond the doc, now written into it: `/` closes the overlaid view below 1,200 px, and `j`, `k` and `/` do nothing while the message box has a draft |
| W27 | The conversation: folded tool calls, "Jump to latest", speaker lines with times | `m3/conversation` | M | Merged ([#34](https://github.com/leggetter/pitwall/pull/34)). The conversation is its own component (`Conversation.tsx`), keeping `.session-view-body[role="tabpanel"]` for `j`/`k`. Speaker lines with times on every text entry; runs of two or more tool calls fold behind a real toggle with an error badge, and a fold's state is kept per call across refreshes and Load earlier. Scrolled up, the place holds and a sticky "*n* new · Jump to latest" bar counts arrivals, announced once per batch (the one exception to 6.1 rule 9). The last `title`s are gone: `titles.test.tsx` allows none. ↑/↓ now leave a message-box draft alone, as `j`/`k` do. Notices and tool calls no longer show a time anywhere |
| W28 | Skeleton, empty and error states | `m3/states` | S | Merged ([#35](https://github.com/leggetter/pitwall/pull/35)). `Waiting.tsx` reads `--pw-delay-spinner` and `--pw-delay-long`: skeleton items and two-bar skeleton rows after 500 ms behind an always-present "Loading sessions" status, and "Still waiting for `claude agents`…" after 10 s, checked with the real delays. `EmptyState.tsx` replaces `Placeholder` for every row of the doc's table, with actions on `Button`, and the unlisted view is one too. `?session=` before the first snapshot shows a waiting view instead of a blank column. The conversation's failures are alerts with Try again; a failed refresh keeps the entries and says they may be out of date. `getConversation` keeps the status and any `{ error }` reason; `couldNot()` moved to `format.ts`. The connection badge already used `Spinner` (since W24); a test now pins it. "Loading the conversation…" waits 500 ms, so `j`/`k` never flash it |
| W29 | The terminal: its theme from tokens, JetBrains Mono, the status bar, and F6 to leave it | `m3/terminal` | S | Merged ([#36](https://github.com/leggetter/pitwall/pull/36)). The bar's status badge is on `Badge` in a `role="status"` region, with the "F6 to leave the terminal" hint in `KeyCaps` and ghost sm Attach again and Detach ("Back to the conversation" once ended). xterm's font and theme come from `--pw-font-mono` and the eight `--pw-term-*` tokens, and a grep test fails on any colour or font name left in the terminal's code; it opens once JetBrains Mono's 400 and 500 faces load (3 s cap). The dark screen is told apart by a 1 px `--pw-border-strong` ring, with no token change. Plain F6 moves focus to the Terminal tab without detaching; Claude Code's public docs bind no function key (keybindings, interactive mode, terminal config, agent view, fullscreen, accessibility, read 2026-10-21). Notices are `Alert`s, neutral for an exit of 0 or a signal and danger for a non-zero exit or error, and `.banner` is gone. Fixed a real bug: the conversation came back at the bottom after the Terminal tab, because the hidden panel read as "at the bottom". One slip: the sub-agent lost uncommitted work to a `git checkout` and rebuilt it, and copied `Terminal.tsx` to `/tmp/T.bak` (repo source only); a classifier denied its `ls` of that file, so whether it's still there is unchecked |
| W30 | A plain error when pitwall runs in a directory that no longer exists | `m3/cwd-error` | S | Merged ([#22](https://github.com/leggetter/pitwall/pull/22)). Not covered: a directory deleted while pitwall runs, where `git` and the browser opener, which set no `cwd`, would start in it. Low priority |
| W35 | Hide a repo or directory from the repo list, with the hidden ones at its foot to unhide, kept per root in browser storage | `m3/hide-repos` | S | Merged ([#40](https://github.com/leggetter/pitwall/pull/40), eba8c29). Web UI only. A ghost icon button at the end of the session list's heading line, Hide from repo list or Show in repo list, with new `hide` and `show` icons from the same pinned Material Symbols commit; a "Hidden (n)" disclosure at the repo list's foot with the needs-you badge, each session counted once, and each hidden group as a link and an Unhide button; a hidden group missing from the snapshot shows "No sessions". `pitwall.hidden.v1:<root>` holds `{v: 1, open, groups: [{key, label, kind}]}`, never pruned. Focus stays on the header's button, goes to the group's item after Unhide, and is handed on when a focused item leaves the list. Also fixed: the drawer's Tab trap counted controls in the closed section, and a focused repo list item whose group left the snapshot dropped focus to the page. Tests 2,298 passed; the coordinator's app check passed at six widths, 317 to 329 steps each. Coordinator's rulings: the session list's header wraps sooner at its 360 px minimum (windows of 1,200 to about 1,280 px), which is on the try-out list; a hidden selection isn't marked on the collapsed toggle, because the header's Show in repo list says it's hidden. Later: syncing tabs through the `storage` event, clearing hidden groups that have no sessions, and naming the root in the toasts when pitwall watches several |
| W36 | Markdown in the session view: the server sends assistant messages as markdown and prompts as typed, and the page renders a safe subset | `m3/markdown` | M | Merged ([#41](https://github.com/leggetter/pitwall/pull/41), 5142ff3). Contract (coordinator, de09503): `ConversationEntry.text` by kind, `markdown`, and 32 Ki code units an entry within 256 Ki a page. The server sends assistant and cross-session text as written, and prompts as typed. `web/src/markdown.ts` parses a subset to a tree, and `Markdown.tsx` renders it as pitwall's own elements: headings are styled text, not `h*`, so the page's outline stays pitwall's; code blocks have a bar with the language and Copy; tables and code scroll sideways in their own boxes. Raw HTML, entities, reference links, footnotes, setext headings, indented code and links to any scheme but `http:` and `https:` show as text. Bounds: lists and quotes nest 8 deep, inline markup 16, tables 64 columns; every hostile 32 KiB input parses in 5 ms or less; a message over 5,000 elements shows as written, with a note. Tests 2,496 passed; the coordinator's app check passed at six widths, 309 to 314 steps each. Coordinator's rulings: the 5,000-element fallback stands (dense everyday 32 KiB markdown takes about 4,000); the caps count UTF-16 code units, as the 8 KiB cap did, and the contract now says so. Later: delete `stripMarkdownBounded`, now without a caller, and its tests; the relay reply as markdown; a page's newest copy of an entry can replace one shown in full with its 512-character cut |
| W37 | Links in code: bare `http:` and `https:` URLs in code blocks and inline code open as links, under W36's link rule | `m3/code-links` | S | Merged ([#42](https://github.com/leggetter/pitwall/pull/42), 72ed15c). Web UI only. The parser finds a code span's or block's bare URLs once, as `linked` beside `text`; Copy copies `text`. Markdown's own link syntax in code, `[text](url)` and `<url>`, stays text, and code inside a link stays plain. Links in code are the code's mono face, `--pw-link` and underlined, since the link colour against code's text is under 3:1; a link in a code block takes the inset focus ring. Tab order: Copy code, the scroll box while it scrolls, then the links. Found in review and fixed in the PR, in text and code alike: a bare URL now ends at a space, `<`, `>`, `"` or a backtick, and drops an unopened `}` as it does `)` and `]`, so URLs in HTML attributes, JSON, Python dicts and backticks link where they point; W36's raw-HTML test now expects pitwall's own link to the URL in it. Bounds: the element cap counts links in code, so at most 1,247 in a message; that block's longest main-thread task was 21 to 36 ms in headless Chrome, as dense everyday markdown's is. Tests 2,539 passed; the coordinator's fresh clone and app check passed (the paging test timed out at a load of 21 to 32 and passed with a longer timeout; the PR changes no server code). Coordinator's rulings: the ending rule; the at-cap happy-dom render test is bounded relative to dense everyday markdown on the same machine, with Chrome's absolute timings in the design doc. Later: `web/src/uikit/route.test.tsx`'s specimen timeouts failed 2 of 11 local full runs under heavy load, never in CI |
| W38 | Roots as tabs: with two or more roots, a tab per root in the header, each narrowing the repo list, the session list and the session view to its root | `m3/root-tabs` | M | Merged ([#44](https://github.com/leggetter/pitwall/pull/44), 2da2ef8). Web UI only. A tab per root in the header, in the order pitwall was given them, each narrowing the repo list (Needs you, All sessions, the groups and Hidden), the session list, its filter, `j`/`k` and New session to its root; the rest of the header, alerts, toasts, Sort and the view width stay global. An inactive tab carries a solid needs-you badge in its accessible name; the open tab shows none, since its Needs you item does; the title's count covers every root. Each tab keeps its selection, open session and filter; other tabs' session views stay mounted but hidden, so terminals stay attached and drafts and sends go on. URLs carry the root (`?view=all&root=…`), and a switch pushes one history entry; `pitwall.root-tab.v1` holds the open root's path, used only when the URL has no selection. Tabs open on Enter, Space or a click, with ←/→ and Home/End moving focus. The header wraps rather than scrolling, so every tab and badge stays visible at 320 px. Nested roots follow `SessionGroup.root`, and New session in the outer tab refuses a directory under the inner root. Rebased after W39: code and tests for a session in two tabs dropped. Tests 2,590 passed; the coordinator's fresh clone and both app checks (two roots at seven widths, one root at six) passed. Later: New session replaces an open view with a draft (existing bug); Finished's open state is shared across tabs; a shortcut to switch root tabs; hidden views refetch conversations while active |
| W39 | Each session in one group: listed only where it started, with the repos it worked in shown in the session view and matched by the filter | `m3/one-group` | S | Merged ([#43](https://github.com/leggetter/pitwall/pull/43), 1c20796). Contract (coordinator, 74d7479, rebased as 013427d): every group lists only the sessions started in it, and `WorkedIn.label` names a repo that may have no group. Server: `buildGroups` puts each session in its start group only; `addWorkedIn` labels each repo with `groupLabel` from the root its group would sit under, and never moves a session; `RepoWorkedIn` is `Omit<WorkedIn, 'label'>` plus `root`. Web: the "worked in" line names every repo by its label, as plain text; the rows' "started in" prefix, `primaryGroup`, `workedInHere`, `groupsOf`, `Listed.startedIn` and `Listed.groups` are gone, and `uniqueSessions` is `sessionsIn`; the filter matches worked-in labels in every selection. Tests 2,540 passed; the coordinator's fresh clone and app check passed. Later: the worked-in names could link to All sessions filtered by that repo; a root that is itself a repo shows as its path but matches by its basename |
| W40 | A pinned tab survives a restart, with a fixed token on a single-user machine or for development; also the Stop hint for terminal sessions | `m3/pinned-tab` | M | Merged ([#45](https://github.com/leggetter/pitwall/pull/45), 856a41b). `npm run dev` reads `PITWALL_TOKEN` from the environment or the repo's `.env` (found from the script, never the cwd; the environment wins), validated by the CLI's `resolveToken`; the CLI keeps reading its environment only, with a test that a cwd `.env` is ignored. An empty value counts as unset, so a copied `.env.example` gives a new token every run. Both print "the token is fixed by PITWALL_TOKEN …" to stderr, never the token. The CLI says a fallback port can't be pinned. The no-token and rejected notices say to paste the link pitwall prints, and that a fixed token keeps a pinned tab working on a single-user machine. The Stop hint: an interactive session's actions menu ends with Stop session, disabled, saying to type `/bg` in its terminal first; the `/bg` and Terminal tab notes match. Built first and removed before merge (Phil): the hand-off and `pitwall open`; the branch was rebuilt without them. Tests 2,625 passed; the coordinator's fresh clone and app check passed. Later: a token change remounts the dashboard, so other root tabs' places reset; `process.loadEnvFile` passes the repo `.env`'s other variables to the dev watchers |
| W41 | Shift+Enter in the terminal pane adds a line in Claude Code's prompt, by sending a line feed (Ctrl+J) | `m3/shift-enter` | S | Merged ([#46](https://github.com/leggetter/pitwall/pull/46), c49cf3f). Web UI only. Shift+Enter with no other modifier, captured before xterm.js as F6 is, sends `\n` alone, a repeat included; Enter still sends `\r`; Ctrl, ⌘ or Alt with it, a composing key (`isComposing` or keyCode 229) and Escape are unchanged, checked with real keys against the build before. The shortcuts dialog and the design doc's keyboard table list it; the terminal's F6 hint doesn't, as it would wrap the bar at 375 px. Tests passed; the coordinator's fresh clone and app check passed. To check in Phil's try-out: what a line feed does in a Claude Code dialog, such as a permission prompt. Later: Alt+Enter already sends ESC+CR, which Claude Code's docs name as a newline with Option as Meta, unverified here; the gallery's dialog frame height is fixed and would clip the next row at 375 px |
| W42 | View preferences: Group sessions by Main repo (default), Where it started, or Every repo it worked in, chosen in a header menu and kept in the browser | `m3/view-prefs` | M | Merged ([#47](https://github.com/leggetter/pitwall/pull/47), 40acbbc). Contract (coordinator, aedbdf2, rebased as b7c553e): `WorkedIn.root`, which `addWorkedIn` sets. `web/src/groupBy.ts` groups the snapshot per mode and gives each session a home group, the one its row names and `?session=` selects. Main repo moves a session in a root's own directory group (a root that is itself a repo stays a repo) to its main repo: most changes, then calls, then the newest touch, then the path; a repo with no snapshot group gets one built from the `WorkedIn`. Every repo it worked in is W34's listing. The menu: a ghost icon button (`preferences`), View preferences, between the theme switch and Keyboard shortcuts, with a radio group, Group sessions by, and one line for each mode; it opens on the chosen mode, and choosing closes it with focus on the button. Kept as `pitwall.group-by.v1` (the mode only). A switch that unlists the selected group selects All sessions in that root tab, with a toast; an open session view stays. Tests 2,699 passed; the coordinator's fresh clone and app checks passed. Later: the first snapshot has no `workedIn`, so Main repo moves root-started sessions a poll later; the mode isn't synced across browser tabs; sessions started in non-repo folders below a root don't move |
| W43 | The relay's copy of a message: look-alike spaces made plain before it copies, one retry when the gate blocks a changed copy, where the copy differed in the result, and an alert that tells a changed message from one nobody asked for | `m3/relay-text` | M | Merged ([#49](https://github.com/leggetter/pitwall/pull/49), ae0b25e). Contract (coordinator, 546ccab, rebased as f7e50f6): `RelayAlert.cause`, and what `RelayRequest.text` and the `failed` status now say. `src/server/relayText.ts`: `plainSpaces()` makes U+00A0, U+2000 to U+200A, U+202F and U+205F a plain space and CRLF LF, and nothing else, in `RelayManager.send()` before the id, the framing, the gate's expectation and the check; the 8,192 limit applies to the text as received. `describeCopyDifference()` gives the first difference by line and character code, such as "line 33: a no-break space (U+00A0) became a space (U+0020)", never the text. A changed copy the gate denied is tried once more on a new relay, with a new id and expectation, once its turn ends; never after any other result, and never twice. Blocked twice, the result is `failed` and says where each copy differed. The alert: `unrequested` or `changed`; none for a blocked changed copy, one pitwall stopped before it ran, or your own message that ran unchecked (coordinator), which still turns messaging off. The source writes every invisible character as an escape (coordinator's review). Tests 2,817 passed; the coordinator's fresh clone and app checks passed (W43's part at six widths in both themes, the integrated check at six widths, W44's part on this build), and the live relay checks, 13 of 13, including a no-break space, a CRLF and a narrow no-break space, and a made-up 6,000-character, 89-line message, each delivered exactly. Later: the second try's relay could run a stronger model than Haiku, perhaps above a size, once the logs show how often a copy is blocked; Sending… shows no progress during a retry; "The relay stopped 1 times in 1 minutes" |
| W44 | Each conversation's unsent draft survives a reload, in the tab's `sessionStorage` | `m3/drafts` | S | Merged ([#48](https://github.com/leggetter/pitwall/pull/48), 6350617). Web UI only. `web/src/drafts.ts`: one key per conversation, `pitwall.draft.v1:<sessionId>`, holding `{"v":1,"text":…}` and, while a send's outcome is unknown, `send: {at, state}` with `out` or `uncertain`. Written in the same event as each edit, and as `out` before a send goes; removed when the box empties and on delivered, held or refused; kept without `send` on failed. A restored draft whose send was out or uncertain warns, until it's edited or sent, that it may have reached the session and to check its conversation before sending it again; nothing sends by itself. `uncertain` was the sub-agent's addition, kept, so a reload after an uncertain answer still warns. Storage that fails leaves the box working from memory with no notice, and a failed write removes the stored copy. Never pruned for a missing session. The gallery keeps its drafts in memory. Tests 2,749 passed; the coordinator's fresh clone and app checks passed: W44's part at six widths in both themes, and the integrated check, whose one 1,440 px failure under load passed twice on rerun. Later: a kept draft for a session missing from the first snapshot after a reload has no box to show it; clicking another row, or Close, replaces a view that has a draft without a guard, which now keeps the draft, though 6.2 still says changing session discards it; a duplicated tab starts with a copy of the drafts; the warning could clear itself from the session's relay exchange |
| W45 | A steady cursor in the terminal pane: no blink, even when the program asks for one | `m3/steady-cursor` | S | Merged ([#50](https://github.com/leggetter/pitwall/pull/50), a03a305). Web UI only. Phil (2026-10-22): "The cursor doesn't need to flash in the terminal view. It's distracting." pitwall itself set `cursorBlink: true` in `web/src/xterm.ts`; whether Claude Code also asks for a blink is unknown. Now `cursorBlink: false` and `cursorStyle: block`, and `keepCursorSteady()` holds off both ways xterm.js 6.0.0 lets a program turn the blink back on, through its public parser hooks: DECSCUSR keeps the shape asked for without the blink, and a DECSET with 12 is applied as sent and its blink turned off in a microtask, before the next frame. RIS and DECSTR put the block back. Tests 2,849 passed; the coordinator's fresh clone and app checks passed: W45's part at six widths in both themes, sampling the cursor over 1.2 s after each request, and the integrated check at six widths. The same check fails on the build before W45, so it isn't vacuous |
| W31 | Review and live check of the integrated branch | `m3/integration` | M | Done 2026-10-21. The review, with the reviewer skill: changes requested, nothing high, and the security rules hold, in dev mode too. Every carried finding from W23 to W29 was triaged. Merged: the dead last-message route, `LastMessage`, `lastMessagePath()` and `SessionSummary.lastAssistantText` are gone ([#37](https://github.com/leggetter/pitwall/pull/37); coordinator's contract call, since the web UI read neither and every snapshot sent each session's latest reply to the browser). Gate tests went from 101 to 90, because 10 of the route's had exact twins on the conversation route; every distinct check is kept. The same PR stops `npm test` running `claude --help`: `claudeCommands.test.ts` had run it at module load wherever `claude` was installed, since d5a0c86 (2026-10-19), so every local test run since M2's review, the coordinator's and sub-agents' included, ran it (it only prints help, and starts no session). It's now behind `PITWALL_LIVE=1`, and `src/test/noClaude.ts` refuses any other test that would run `claude`. Merged: the web UI fixes ([#38](https://github.com/leggetter/pitwall/pull/38)), all 22 items, each with a test that fails without its fix, except a refactor and the gallery-only fixes. Among them: Details closes the overlay; Stop and Remove results outlive the view as toasts, and `j`/`k` wait for them; a send with no answer, a 5xx or an unexplained 2xx says it may have gone; a refresh keeps the reader's place; a draft survives its session stopping; one more ask after a 429's `Retry-After`; Make view wider, Make view narrower and Reset view width in the actions menu (WCAG 2.5.7), with a 24 px divider target; scroll boxes reachable from the keyboard; a forced-colours block; and `--pw-danger-fg` for the confirmation bar. The headless app check passes at six widths, 259 to 264 steps each, with no CSP violations, console errors or 4xx, and the coordinator's own rerun on the merged tree matches; its token step now checks itself. Coordinator's calls on the fixer's: lists the overlay partly covers are inert too; unused tokens stay where they complete a set (the space scale, icon sizes, tones and the code palette), and a test now fails on an unused one-off token; the divider's 24 px target covers the outer 8 px of the list's scrollbar rather than the view's tabs and text box (on Phil's try-out list). Found in review, from before #38: the `#uikit` gallery's three-column frames clip the session view's right edge, Send included; the app doesn't. The fixer ran one full `npm test` with `claude` on its PATH before the guard. Coordinator's calls: below 1,200 px the overlay starts below the header and makes what it covers `inert`; the low-height footer below the fold is accepted; `~/hookdeck/git` stays in this plan as Phil's real root, as since M1, while spike 004 is anonymised and the Look line no longer implies Hookdeck's palette was measured; the scratch app check's token-in-URL step had been vacuous since W25 (the reviewer's own check covered it). M3 goes into main with a merge commit (Phil, 2026-10-21: keep the incremental work where agents can look back at it; the method is the coordinator's call), so every commit keeps the id this plan cites. That brings two early commits into main's history, `b92273a` (`~/hookdeck/git` in a design-doc draft) and `4417419` (made-up fixture paths with `clients` in them), which is acceptable: this plan names the root on purpose, and the paths are made up. Later: vite 8.3.3 for advisories in Vite's dev server, which pitwall never runs |
| W32 | Phil tries it and approves the merge | - | - | Try-out list: F6, and fn+F6, in Chrome and Firefox; `claude attach`'s exit code after ←, Ctrl+Z and a double Ctrl+C, to settle whether a non-zero exit stays a danger notice; Tab under the overlay below 1,200 px; Details with the relay off; Escape after a dialog; VoiceOver on the badges' info buttons, the Alerts and Reply regions, Try again and the F6 hint; bold in the terminal; a short window; text spacing; a real Windows contrast theme; keyboard scrolling in Safari and Firefox; the divider over macOS overlay scrollbars. The session list's header with Hide, at 1,200 to 1,280 px. Markdown in the conversation on real sessions, and the relay reply's markdown shown as syntax. Found so far (2026-10-21): a long session still listed under a repo it last worked in weeks earlier (W35); code blocks, tables and bold lost in the conversation (W36); URLs in a code block not clickable (W37); two roots wanted as tabs (W38); one session listed under several groups (W39); the pinned tab losing its token on a restart (W40); Shift+Enter submitting in the terminal (W41); a long session started in the root that's really about one repo (W42). Found on 2026-10-22: a long pasted message that the relay changed by one no-break space, which the gate blocked twice (W43), and that message's draft then lost (W44); the terminal's blinking cursor (W45). Then the merge into main, with a merge commit |

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
| W14 | Review with the `role-reviewer` skill, security first | - | Sub-agent | Done 2026-10-19: changes requested, one medium finding. Fixes merged in [#16](https://github.com/leggetter/pitwall/pull/16) and [#17](https://github.com/leggetter/pitwall/pull/17). Re-check at `97e4664`: approved; follow-ups merged in [#18](https://github.com/leggetter/pitwall/pull/18) |
| W15 | Try it, and approve the merge | - | Phil | Approved 2026-10-20. Feedback: the message box belongs at the foot of the session view, as in agent UIs, and the UI should follow Hookdeck's UX (M3) |
| W16 | The message box at the foot of the session view, from W15 | `m2/composer-bottom` | Sub-agent | Merged ([#20](https://github.com/leggetter/pitwall/pull/20)) |

### Security gate as built (W8, 2026-10-16)

| Credential | Where it lives | Can |
| --- | --- | --- |
| Token | Printed to stdout, in the 0600 launch file while pitwall runs, and in the page's `sessionStorage` | Prove itself over the WebSocket through an HMAC, never sent. Authorize HTTP GETs, for scripts |
| `apiKey` | Server memory, and the page's API client only | Authorize every HTTP API call. State-changing calls (any method other than GET or HEAD) also need `Origin: http://127.0.0.1:<port>`, otherwise 403 |

- **Input routes:** every route that takes a session id resolves it with `resolveSession()` (`src/server/sessions.ts`), and builds commands from the returned summary, never from the raw parameter. Register input routes inside `createApp`, before the `/api/*` catch-all.
- **Web:** HTTP calls go through `ApiContext`/`api.get` in `web/src/api.ts`. A 401 means a stale `apiKey`, so the client reconnects; the page never sends the raw token.
- **Environment:** `PITWALL_HOME` overrides `~/.pitwall`. `PITWALL_OPEN_MARKER` is set by `npm run dev`, so the CLI child opens the browser once, after it's listening.
- **Residual risk, found by W8: closed by protocol v3** (W14, [#16](https://github.com/leggetter/pitwall/pull/16)). The proof is bound to the page's origin, so a squatter can't pass a challenge to a real pitwall page and use its proof.
  - **Still open in dev:** `npm run dev` reuses one token across restarts, and the page keeps it in `sessionStorage` for `http://127.0.0.1:<port>`. A process that grabs the port during a restart serves a page on that same origin, reads the token on the tab's next reload, and can use it for later restarts. v3 doesn't help, because the origin is the real one. Low priority on a single-user Mac; noted in `scripts/dev.ts`.
  - **Reusing `PITWALL_TOKEN`** keeps one token alive across runs, which the usage text now warns about. An old tab can then authenticate first and delete the new run's launch file before the browser reads it.

### Findings while building M2

- **Stopped background sessions left the list** (W12). After `claude stop`, a session has no process and appears only in `claude agents --json --all`, so it couldn't be removed, or attached to restart it.
  - **Decision (coordinator):** the index lists with `--all`, and the UI shows done, stopped and failed background sessions muted, like agent view's Completed group. Built at integration (W13) in [#14](https://github.com/leggetter/pitwall/pull/14): a `SessionSummary.finished` field, a muted, collapsed "Finished (n)" list per group that also counts the questions inside it, and group order that ignores finished sessions.
- **`--all` costs nothing measurable** (W13). 15 alternating runs of each form on Claude Code 2.1.302, with 16 sessions, or 18 with `--all`: a median of 0.14 s wall time, 0.145 s of CPU and about 150 MB at peak, either way.
- **No slow window: a quoting slip in a benchmark** (W13, corrected 2026-10-20). The 18 to 34 s runs on 2026-10-19 came from a timing loop that ran `claude $args` in zsh, which doesn't split an unquoted variable. `claude` got `agents --json` as one argument, took it as a prompt, and ran 16 full sessions on Opus 5.5 in a scratch directory. They used only `ListAgents` and read-only shell commands; the two checked cost $0.27 and $0.31. Pitwall isn't affected, because it passes `['agents', '--json', '--all']` to `execFile`. In live-check scripts, pass arguments as arrays.
- **The live check of the integrated branch passed** (W13, `07f43c2`, 2026-10-19). 11 checks against the built CLI with throwaway Haiku sessions: the index (finished rows, the relay hidden), spawn (and the untrusted-directory error, with no trust granted), session view paging, attach (and the limit of 4), stop, restart by attaching, remove, the relay (delivered with a reply, 409 for a background session, ambiguous names), the security negatives (`Origin`, the raw token, `Host`, unknown ids, wrong proofs, no token or message text in `ps`), shutdown by SIGTERM and by SIGKILL with no orphans, and a headless UI smoke.
- **A stopped idle session stays `done`** (W13). Claude Code reports `stopped` only for a session stopped mid-turn. `finished` covers both.
- **Left for the review's fixes** (W13), fixed in [#16](https://github.com/leggetter/pitwall/pull/16) and `m2/relay-gate`:
  - A just-spawned session lists for one poll with no pid, so attaching would ask to restart a session that's still starting. It didn't reproduce on 2.1.303, where the pid was there when `claude --bg` returned, but attach now decides when the socket opens anyway (L4).
  - A relay that fails before sending still records an exchange with `sentAt`.
  - When pitwall runs inside a Claude Code session, its children inherit `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION` and `CLAUDE_PID`.
- **`startedAt` is when the job was created** (W14). It matches `createdAt` in the job's internal state, not when the current process started, so a restarted session never looks newly started. Attach also tracks the sessions this pitwall spawned in the last 30 s.
- **A spawn prompt shows in `ps`** while `claude --bg` starts (W14). `claude --help` documents the prompt only as an argument, and `--input-format` applies to `--print` only. Accepted on a single-user Mac.
- **Test transcripts stay behind** (W13). `claude rm` keeps a session's transcript, and `-p` sessions can't be removed, so each live check leaves its throwaway transcripts, which show in `claude --resume` in that directory.
- **"Done" isn't "not running"** (W10). A background session can be `done` with its process still alive and idle. Attaching to it doesn't restart anything, so pitwall asks before attaching only when there's no live process.
- **Inherited inbox credentials** (W10). When pitwall itself runs inside a Claude Code session, the processes it starts would inherit that session's `CLAUDE_CODE_MESSAGING_*` credentials and `CLAUDE_JOB_DIR`. They're now scrubbed, together with that session's identity variables (W14, L3), for everything pitwall starts, the index's own `claude` and `git` calls included.
- **`node-pty` 1.1.0 on macOS** ships `spawn-helper` without its execute bit, so pitwall sets it on first use. On Linux with npm 11, the install script needs `npm install-scripts approve node-pty`. CI uses npm 10, which runs it.
- **The relay can't be a prompted `--bg` session without a terminal** (W11, spike 003). A running background session can't be given a new prompt over plain pipes: `--resume <id> --bg` starts a copy per message. The options are B (prompt a background relay through a PTY, which needs a one-time trust step) or D (pitwall runs the relay itself as a `claude -p` stream-json process). **Decided by Phil on 2026-10-19: D** (see D8).
- **`ListAgents` shows no directories** (W11). Two running sessions with the same name can't be told apart. So pitwall first checks the name against the unfiltered `claude agents --json --all`: exactly one live session must have it, and it must be the one asked for. Otherwise nothing is sent, and the message fails as an ambiguous name that `/rename` fixes.
- **The relay's send is checked, not prevented** (W11). Pitwall compares the relay's `SendMessage` call with the request byte for byte, but sees the call only after the tool has run. Haiku once kept a line break from the framing as part of the text: the check caught it, and the framing now puts the text inline, but the message had already arrived. A mismatch fails the request with "It may still have reached the session" and restarts the relay.
  - **For W14:** check whether a `PreToolUse` hook in the relay's `--settings` (if `--safe-mode` allows one), or the Agent SDK's `canUseTool`, can turn the check into a gate.
- **Relay live results** (W11). Delivered in 5.4 to 8.7 s through the relay manager, and about 3.9 s through the built CLI. Replies attached after 7 to 12 s. Targets set to `hold` and `refuse` gave `held` and `refused`. The relay exits within about 1 s of pitwall being killed with SIGKILL, because its stdin closes. Not tested: targets that bypass permissions, and the release, denial and expiry notices, which are matched by their wording.

### Security review (W14, 2026-10-19)

Changes requested: one medium finding blocks the merge, and the rest are low or nits.

- **Medium: the relay could be talked into sending.** Any local session could message the relay, and only Haiku following its instructions stopped it from forwarding a forged request. Pitwall saw the send only afterwards. `crossSessionInbound: accept` made it an escalation: a session that bypasses permissions, whose direct message a prompting target would hold, got it delivered through the relay as `pitwall-relay`.
  - **Fix (coordinator's call), merged in [#17](https://github.com/leggetter/pitwall/pull/17):** drop `accept`. Gate `SendMessage` with a fail-closed `PreToolUse` hook that allows only the exact pending request, one-shot, by hash, never with the text on disk. Remove `ListAgents` from the relay. Show anything the relay tried that nobody asked for as `relayAlert` in the UI.
  - **My mistake:** D8 recorded that `accept` "only changes messages from sessions that bypass permissions". That's exactly the escalation path.
- **Low, fixed in [#17](https://github.com/leggetter/pitwall/pull/17):** the name check ran once, well before the send (L1). A failure before sending overwrote the last delivered exchange and lost its reply, and a failure after the call was reported as not sent (L2; new `uncertain` status).
- **Low, fixed in [#16](https://github.com/leggetter/pitwall/pull/16):**
  - children inherited the parent session's identity variables (L3);
  - the attach restart prompt came from a snapshot up to one poll old (L4);
  - a one-word spawn prompt naming a subcommand could run it (L5);
  - the proof wasn't bound to the origin (L6; protocol v3);
  - SIGHUP left the launch file behind (L7; it's also deleted after the first handshake, or after 60 s).
  - **Nits:** xterm links limited to http(s), and concurrency caps.
- **Re-check of the fixes** (`97e4664`): **approved for `main`.** M1 and L1 to L7 are fixed. What remains: one Haiku turn between the last name check and the send (L1); a `claude` command added after 2.1.303 is caught only when the `claude --help` test runs (L5); and the dev-mode token case (L6). New lows, fixed in [#18](https://github.com/leggetter/pitwall/pull/18):
  - **N1:** a denial relied on the hook's stdout being pure JSON, which a printing `NODE_OPTIONS` preload breaks. Denials move to exit 2, and `NODE_OPTIONS` is dropped from the relay.
  - **N2:** each blocked call restarted the relay, so a peer could hit the restart cap and take it down for 10 minutes.
  - **N3:** nothing checks for Claude Code 2.1.295, which `onFailure` needs.
  - **Nits:** an allowlist of `SendMessage` input fields, and non-JSON tool errors classified as `uncertain` unless they're the gate's.
- **Inbox sockets take same-user posts without auth.** On macOS and Linux the auth line is optional, as the cross-session messaging docs say, so any process running as me can post into any session's inbox, the relay's included. That's Claude Code's design, not pitwall's; the gate covers the relay.
- **Checked and sound:** the Host, Origin and credential gate (19 crafted requests), the handshake, CSP and headers, the launch file, `resolveSession()` on every route, attach limits and cleanup, the relay's framing and lifetime, index exclusion, web rendering, and repo hygiene.

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
- **D8 - The relay:** pitwall runs one headless session as its own child process: `claude -p --input-format stream-json --output-format stream-json`, named `pitwall-relay`, on Haiku, in `~/.pitwall/relay/`, with `--tools SendMessage`, `--permission-mode dontAsk`, `--setting-sources ""`, `--strict-mcp-config`, `--include-hook-events`, the gate's hooks in `--settings`, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. `dontAsk` keeps the relay in the prompting permission class whatever my default mode is, so targets that prompt deliver rather than hold. It doesn't gate a local `SendMessage`, which needs no permission. It starts on first use, takes one request at a time on stdin, is restarted if it exits, and stops with pitwall.
  - **Not a background session,** as first decided on 2026-10-16. A running background session can't take a new prompt without a terminal. Prompting it through a PTY (option B in spike 003) works, but it scrapes a screen meant for people, puts the text in `ps`, and needs a one-time trust step.
  - **No `crossSessionInbound: accept`:** first chosen so that replies from targets that bypass permissions wouldn't expire at the relay, then dropped after the W14 review. It let such a session get a message delivered through the relay that the target would otherwise hold. Those replies now expire at the relay; the target holds pitwall's message for my approval anyway, so I read its reply in its own terminal.
  - **The gate** (W14, [#17](https://github.com/leggetter/pitwall/pull/17)): a `PreToolUse` hook, `src/server/relayGateHook.mjs`, run in exec form (no shell) with `onFailure: "block"`. It allows a `SendMessage` only when it matches the one request pitwall wrote an expectation for: the target's name exactly, the text's SHA-256, unexpired, and only once. Anything else is denied before it runs, and shows as `relayAlert` in the UI.
    - **Expectations:** they sit in `$PITWALL_HOME/relay-gate/` (0700, files 0600) and never hold the text.
    - **Readiness:** a SessionStart hook writes a ready marker, and pitwall writes no request until it appears, so a relay whose hooks didn't load is never used.
    - **A breach:** a call that gets past the gate anyway stops the relay for the rest of the run.
    - **How it answers** ([#18](https://github.com/leggetter/pitwall/pull/18)): a denial exits 2 with its reason on stderr, which blocks the call whatever else is on stdout. Only an allow is JSON on stdout. Live, a printing `NODE_OPTIONS` preload turned the earlier JSON denial into "no decision", and the message was delivered.
    - **Fields:** a `SendMessage` with any input field outside the eight 2.1.303 sends is denied.
    - **After a denial:** a stray call nobody asked for raises the alert, and the relay keeps running, so a peer can't use up the restart cap. A denial of one of pitwall's own requests restarts the relay after that turn, because its conversation may have been tampered with.
    - **Environment:** besides the shared scrub, the relay drops variables that make node or the system load code: `NODE_OPTIONS`, `NODE_REPL_EXTERNAL_MODULE`, `NODE_PATH`, `NODE_COMPILE_CACHE`, `OPENSSL_CONF`, `OPENSSL_ENGINES`, `OPENSSL_MODULES`, `LD_PRELOAD`, `LD_AUDIT` and `DYLD_INSERT_LIBRARIES`.
  - **Not `--safe-mode`:** it disables `--settings` hooks. `--setting-sources ""` with `--strict-mcp-config` loads no user `CLAUDE.md`, settings, hooks or plugins, and no MCP servers, and keeps the inbox socket.
  - **Not `--restricted`:** it runs hooks too, but binds no inbox socket, so replies and held or refused notices would be lost. With the gate, a session that messages the relay can only cost it a Haiku turn.
  - **Requires Claude Code 2.1.295 or later,** for `onFailure`. Pitwall checks `claude --version` before the relay's first start, and refuses an older or unreadable version.
  - **Trust:** `-p` skips the trust dialog, which guards against a directory's own config running before you agree. The relay's directory is pitwall's own, empty and 0700.
  - **Trade-off:** a reply that arrives after pitwall exits isn't shown in pitwall. The target's conversation still has it.
  - **Decided: D, by Phil on 2026-10-19.** The M5 supervisor replaces it.
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
  - **Decision (Phil):** option C. Add a transcript heuristic now (`askedYou` in the contract). M6 triage, with the M5 supervisor, refines it later.
- **Stale missed abandoned jobs that still had a process.** A background job blocked since 24 Sep was flagged as needing Phil. Stale is now 7 days without activity, with or without a process.
- **Raw markdown made the rows hard to read.** The index now strips markdown syntax before truncating.
- **A deleted working directory grouped as a plain folder.** Rows now say the directory no longer exists (`cwdMissing`).
- **Calibration after W5a:** 12 of 17 sessions flagged (11 asked you, 1 blocked).
  - **Matched the morning sweep:** every session it had rated as waiting that still was, 7 sessions.
  - **Correctly cleared:** two sessions that had moved on since the morning.
  - **Extra flags:** small or moot questions the morning sweep had rated as housekeeping or closeable, including one whose question went moot when its PR merged.
  - **What that means:** the heuristic finds what's waiting; judging urgency and spotting moot questions is M6's job.
- **Heuristic rules decided:**
  - **An "Open questions: None" section decides,** even if a later line ends in a question mark. That matches how Phil's sessions write.
  - **Ranking older questions lower is left for M6.**

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
  - **Decision:** fetch the full reply when a row is expanded, from `lastMessagePath(sessionId)`. Keep the 500-character preview in the snapshot. Both were removed in M3 (W31, [#37](https://github.com/leggetter/pitwall/pull/37)), once rows stopped showing replies and the session view showed the conversation.
- **The first view was a wall of text.**
  - **Decision:** groups start collapsed, and each group's open or closed state is saved in `localStorage` (pruned, failing safe to collapsed). This went into W6a, because it touches the same code.
- **Polling cost.** Each `claude agents --json` call takes about 0.18 s of CPU and peaks at about 150 MB of memory. At a 2 s interval that's roughly 9% of a core, and the server pushed the full 20 KB snapshot after every poll.
  - **Decision:** poll every 5 s by default, with `pitwall --interval <seconds>`. Push the full snapshot only when it changed, and a heartbeat otherwise.
- **Session names like `git-a0` don't say what a session is about.**
  - **Decision:** option C.
    - **Now:** show Claude Code's own generated title after the name (`titleSource: 'claude-code'`). It's free, but it's set once from the first prompt and never updated.
    - **M5:** replace it with a title pitwall generates from the session's recent turns (`titleSource: 'pitwall'`).

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

- **Several roots at once** (`pitwall ~/hookdeck/git ~/leggetter/git`): settled. It's supported, and Phil wants each root as a tab (W38).
- **Should the supervisor survive pitwall restarts?** Lean: yes. It's a named background session, and pitwall reattaches to it by name.
- **Cursor's Claude Code extension panel:** do I use it? Its sessions keep a separate list and may not appear in `claude agents --json`.

## Suggested actions

- [x] Create the repo and this plan
- [x] Run S1-S6
- [x] Spike 002: a background supervisor messaging an interactive session
- [x] Settle D1-D4 and D6
- [x] Confirm D5, the stack (Phil)
- [x] Build M1 (merged in #6)
- [x] Build M2, security gate first (merged in #19)
- [ ] M3: design system and restyle, inspired by Hookdeck's UX
- [ ] Spike 005: ending an interactive session (after M3)
- [ ] M4: my open pull requests
- [ ] M5: supervisor
- [ ] M6: triage

---

_Drafted with Claude Code on 2026-10-16, from the session that ran the first manual sweep of 15 live sessions._
