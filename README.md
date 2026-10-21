# pitwall

A local CLI and web UI for supervising the Claude Code sessions running on your machine.

- **Lists every live session under a directory,** wherever it was started (Warp, Cursor, any terminal), grouped by git repo.
- **Lets you act on a session:** read it, reply, answer its prompts.
- **Spawns new sessions** in any directory under the root.
- **Has a supervisor session** you can talk to instead of visiting each session. It knows what each one is waiting on and what's urgent.

**Status:** M1, a read-only index, and M2, interacting with sessions from the web UI, are done. M3, a design system and restyle, is in progress on `m3/integration`. See [`PLAN.md`](PLAN.md).

## Use

```
npm ci && npm run build
node dist/cli.js [root...] [--interval <seconds>] [--port <n>] [--no-open]
```

- **Roots:** a directory, or several. The default is the current directory. Sessions whose working directory is under a root are listed.
- **Opening it:** the CLI opens your browser through a launch file in `~/.pitwall/` (D7), which sends it to `http://127.0.0.1:<port>/#token=...`. The token is per run and never appears in a process's arguments. The page moves it out of the address bar, and never sends it to the server: it proves it with an HMAC over the WebSocket. `PITWALL_HOME` overrides `~/.pitwall`.
- **Port:** the default is 4517, falling back to a free port if it's busy. An explicit `--port` fails instead.
- **Interval:** `--interval` sets the poll, in seconds (default 5).
- **Acting on sessions:** open a session to read its conversation; attach to a background session in a terminal in the page; message an interactive session through the relay (D8); start, stop and remove background sessions. Finished background sessions stay listed, in a Finished section at the end of the list.
- **Layout:** repos, then the selected repo's sessions, then the open session (D11). `/` filters, `n` starts a session, `?` lists the shortcuts and `j`/`k` move through the list; a setting turns them off (D13).

## Decisions

Settled decisions move here from `PLAN.md`, with their reasoning. The evidence is in [`docs/spikes/001-session-control.md`](docs/spikes/001-session-control.md).

### D1 - The session list comes from `claude agents --json --all`

- **Why:** it's a documented interface and returns in about 0.2 s with 20 sessions. It includes interactive sessions started in any terminal or IDE, not just background ones. Third-party session managers only see sessions they launch themselves, which is why pitwall exists.
- **Caveat:** interactive rows aren't in the agent view docs, which describe background sessions only. If they disappear in a later Claude Code release, pitwall loses most of its value, so watch the changelog.
- **How:** poll every 5 s by default (`pitwall --interval <seconds>`). The full snapshot is pushed only when it changed, with a heartbeat after other polls. Each `claude agents --json` call costs about 0.18 s of CPU, so a 2 s interval used about 9% of a core; that was the M1 behavior until W7a. Interactive rows give `status` (busy/idle) only; background rows add `state` and, when waiting, `waitingFor`.
- **`--all`, from M2:** background sessions that have finished or been stopped stay listed, muted, so they can still be opened, attached to (which restarts them) or removed. Plain `--json` drops them once their process has gone. It costs nothing measurable.

### D2 - Interactive sessions: relay through the supervisor, or `/bg` for full control

- **Why:** an interactive session in Warp or Cursor belongs to that terminal. The only documented way in from outside is cross-session messaging. The receiving session sees such a message as coming from another session, "not typed by your user", so it can't approve a permission prompt or change configuration.
- **So:** pitwall relays messages, and labels them in the UI as coming from the supervisor. A relayed message still triggers real work: it starts a turn, and the session acts within its own permissions (spike 002). The relay arrives in M2, as a headless session pitwall runs, limited to `SendMessage` behind a gate (D8), which the M5 supervisor later takes over. For anything that needs full control, it asks me to run `/bg` in the session, then attaches.
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

- **Why:** macOS lets any user read every process's arguments with `ps`, so `open http://127.0.0.1:<port>/#token=...` exposes the token to other accounts on the machine. Instead, the CLI writes a small HTML page that sends the browser on to the token URL. The page sits in a file only you can read (0600, in a 0700 `~/.pitwall/` directory), and the CLI opens that file, so `ps` shows only a path. The file is deleted once the page has used it, after 60 s, or on exit, whichever comes first. Jupyter uses a launch file the same way.
- **Rejected:** a single-use launch code in the URL. It's still visible in `ps` briefly, and another user who used it first would get the token while your browser failed.
- **Context:** W6 review finding 1. It's part of the M2 security gate, together with challenge-response WebSocket auth and dev readiness, because from M2 on the token authorizes typing into agents.

### D8 - Messages to interactive sessions go through one headless relay session

- **Why:** only a Claude session can call `SendMessage`, and the socket's message format isn't documented (D2). Pitwall runs one headless session as its own child process, `claude -p` with stream-json input and output, named `pitwall-relay`, on Haiku, with `SendMessage` as its only tool. It passes your text on verbatim. It starts on first use, takes each message on stdin, so the text never appears in `ps`, and stops with pitwall.
- **The gate:** a `PreToolUse` hook allows each `SendMessage` only when it's the exact message you asked for, to the session you picked, once, and fails closed. The relay loads none of your settings, hooks, plugins or `CLAUDE.md`. Added after the M2 security review found that any local session could talk the relay into sending; anything it tries that you didn't ask for shows as an alert in the UI. Needs Claude Code 2.1.295 or later, which pitwall checks before it starts the relay. A denial exits with code 2, so nothing else printed alongside it can turn it into an allow, and the relay runs without code-loading variables such as `NODE_OPTIONS`.
- **Not a background session:** that was the first decision, on 2026-10-16. Spike 003 found that a running background session can't take a new prompt without a terminal. Driving it through a PTY works, but it scrapes a screen meant for people, puts your text in `ps`, and needs a one-time trust step.
- **Duplicate names:** `ListAgents` doesn't show directories, so when two running sessions share a name, nothing is sent and pitwall asks you to `/rename` one.
- **Trade-off:** a reply that arrives after pitwall exits isn't shown in pitwall. The target's own conversation still has it.
- **Later:** the M5 supervisor replaces it.

### D9 - At most four attached sessions, and a confirmation before restarting one

- **Why:** each attach is a PTY and a `claude attach` process. Closing the view or the tab detaches, and the session keeps running. `claude attach` restarts a background session that isn't running, which is an action, so the UI asks first.

### D6 - Group sessions by the repo they started in, and name the repos they worked in

- **Start group:** the repo of the session's working directory, by `git rev-parse --git-common-dir`, so worktrees sit under the repo they belong to. A directory below a root that isn't in a repo groups as itself.
- **One group each** (Phil, 2026-10-21): a session is listed only under the group it started in. The root's own group lists every session started in the root.
- **Worked in:** the session view names every repo under a configured root that the session changed (an edit or write, a commit or push, a PR created or merged), or that at least 5% of its tool calls touched, sub-agents' included. The filter finds a session by any of them, so typing a repo's name in All sessions lists every session that started or worked there. Spike 004 scored that rule at 1 false positive and 3 misses on 28 hand-judged repos.
- **Why not list it under each repo it worked in:** M3 did that at first (W34), because most sessions start in the folder that holds the repos. In the try-out, 12 of 20 sessions were in more than one group, and Phil found the duplication worse than a large root group ("The problem is duplication").
- **How:** a background scanner reads each session's transcripts, sub-agents' included, and the poll never waits on it. It keeps what it finds in memory only, and runs read-only git at repo boundaries, at most two processes at once. A scan never moves a session.
- **Counts:** a group's count is the sessions started in it, so the groups' counts under a root add up to that root's sessions.
- **Hiding** (Phil, 2026-10-21): a repo or directory can be hidden from the repo list, and the hidden ones are listed at its foot, to select or unhide. It changes only the repo list: its sessions still show in Needs you and All sessions. Chosen over ageing old repos out, after the try-out found a long session still listed under a repo it last worked in 44 days before its latest work.

### D10 - pitwall's own design system, inspired by Hookdeck's UX

- **What:** [`docs/design-system.md`](docs/design-system.md) is the spec: tokens by role (surface, text, border, tone) for light and dark, type, spacing, components, states, layout and keyboard. A dev-only gallery in the app (`#uikit`) shows each component, and the production build leaves it out. It's pitwall's own design system, not Hookdeck's, and it uses no Hookdeck logos or artwork.
- **Contrast:** every text color pair meets WCAG AA in both themes, and `contrast.test.tsx` checks them. Disabled text is the one exemption, as WCAG 1.4.3 allows for inactive controls.
- **Fonts and icons:** Inter and JetBrains Mono (both OFL 1.1), self-hosted, because the CSP (`default-src 'self'`) blocks Google Fonts. Icons are Material Symbols Rounded (Apache 2.0), bundled as SVGs behind a name map that `scripts/extract-icons.ts` generates. The theme's pre-paint script is a same-origin file for the same reason. The licenses are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

### D11 - Three columns: repos, then sessions, then the open session

- **Why:** asked for after trying M2: pick a repo, then one of its sessions, then work with that session. It replaces M2's single list of grouped cards.
- **Repo list:** Needs you and All sessions first, then the root's own directory, labelled with its path, then the repos in alphanumeric order, so the list never jumps.
- **Widths:** three columns from 1,200 px. Below that, the session view lies over the session list, starting below the header, and what it covers is inert (it can't be clicked or tabbed to). Below 900 px the repo list is a drawer, and at 600 px and narrower the session view is full width, with Back to sessions.
- **Resizing:** the session view is 760 px by default and at least 560 px, about 80 terminal columns. The divider resizes it, and so do the actions menu's Make view wider and Make view narrower, for anyone who can't drag (WCAG 2.5.7). The width is remembered.

### D12 - Two-line rows without a needs-you tint, sorted by urgency

- **Rows:** name, title, badge and time, then what the session asked or was last asked. The last reply, the relay exchange, the working directory, the attach command and the message box are in the session view.
- **No tint:** rows that need you keep their bar and badge, without a yellow background. Nine of fifteen sessions needed attention on 2026-10-20, and the tint turned most of the list yellow.
- **No idle badge in the list:** "Idle" shows only in the session view. Needs you is still inferred: `needsAttention()` comes from waiting, blocked and asked-you, never from the badge.
- **Sort:** Urgency by default, or Recent or Name. The order holds while the pointer or focus is in the list, so rows don't move under you.

### D13 - ⌘↵ sends, and the single-key shortcuts can be turned off

- **Sending:** ⌘↵ (Ctrl+Enter on other platforms) sends, and Enter adds a line. Each message starts a turn on the target session's model and can't be taken back, so a stray Enter mustn't send.
- **When a send's outcome is unknown:** no answer, a server error or a success pitwall can't read. The UI says the message may have reached the session and to check its conversation, rather than inviting a resend that would start another turn.
- **Shortcuts:** `/`, `n`, `?` and `j`/`k`. They're ignored while you type, in the terminal, with ⌘, Ctrl or Alt held, and while an input method composes. A setting in the shortcuts dialog turns them off (WCAG 2.1.4), and the browser remembers it.
- **Leaving the terminal:** F6 moves focus from the attached terminal to its tab, so the terminal isn't a keyboard trap (WCAG 2.1.2). Claude Code's docs bind nothing to F6 (checked 2026-10-21).

### D14 - The live snapshot carries only what the list shows

- **Why:** until M3, every snapshot sent to the browser held each session's latest reply, though the UI showed none of it. That's gone.
- **What it still carries:** what the list and the session view's header show: each session's title, its newest prompt (up to 300 characters), what it asked you, and the reply to a message you relayed. The conversation itself leaves the server only when you open it, through the token-gated conversation route.
- **Browser storage:** no token and no session content. The token is in `sessionStorage`. `localStorage` holds UI state under `pitwall.*.v1` keys: preferences, plus the filesystem paths of roots and repos in `pitwall.view.v1`, `pitwall.finished.v1`, `pitwall.root-tab.v1` and `pitwall.hidden.v1:<root>`. The last is one key per root, holding each hidden group's path, label and kind, so pitwalls watching different roots keep separate lists. Storage is also per origin, so a pitwall on a fallback port starts with none.

### D15 - The session view renders markdown as pitwall's own elements, never HTML

- **What:** Claude's messages, and messages from other sessions, arrive as the markdown they were written in. The page shows a subset as its own elements: paragraphs, headings, bold, italic, strikethrough, inline code, code blocks with a Copy button, lists, quotes, rules, tables and links. Your prompts show as you typed them.
- **Why:** until M3, the server stripped markdown from every message before sending it, as it does for the list's two-line rows. That turned each code block into "[code]" and flattened tables, so a draft written in a code block couldn't be read or copied (Phil's try-out, 2026-10-21).
- **Safety:** the parser is pitwall's own, with no new dependency, and builds a tree of text that React renders as text. Raw HTML, and anything outside the subset, shows as the literal text it is. Only absolute `http:` and `https:` URLs become links; each opens in a new tab with `noopener noreferrer`, with the URL it opens in its tooltip. Images are never loaded.
- **Links in code** (Phil, 2026-10-21): bare URLs in code blocks and inline code are links too, as terminals make them clickable, while Copy code copies the code as written. A bare URL ends at a space, `<`, `>`, `"` or a backtick, and drops a `)`, `]` or `}` it didn't open, so a URL in an HTML attribute, JSON or backticks links where it points.
- **Bounds:** at most 32 Ki characters a message and 256 Ki a page. A message that would take more than 5,000 elements is shown as written, with a note.

### D16 - Several roots show as tabs

- **What:** with two or more roots (`pitwall ~/hookdeck/git ~/leggetter/git`), the header shows a tab per root, and each tab narrows the repo list, Needs you, All sessions, the session list, the filter and New session to its root. With one root, the header is as before.
- **Nothing out of sight:** a tab that isn't open shows its root's needs-you badge, and the page title's count covers every root.
- **Each tab keeps its place:** its selection, open session and filter. Switching never detaches a terminal (D9's four count across tabs), drops a draft or stops a send. The open tab is in the URL (`&root=`) and in `pitwall.root-tab.v1`.
- **Nested roots:** a session belongs to the longest root that holds it, as the index decides, so the tabs always agree with the server.
- **Why:** Phil asked for one pitwall over two roots, as tabs (2026-10-21). Rejected: two pitwalls in two browser tabs, which double the polling, scanning and relays, and one page showing other pitwalls, which would need each one's token and a looser CSP.
