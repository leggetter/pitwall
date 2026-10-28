# pitwall

A local CLI and web UI for supervising the Claude Code sessions running on your machine.

![pitwall in the light theme: Needs you, All sessions, Starred and the repos on the left; the starred sessions in the middle, each with its repo, its status and what it needs from you; and on the right, an open session's conversation, ending with the question it asked you, above the message box](docs/images/pitwall-light.png)

*The sessions and the conversation in the screenshot are made up.*

- **Lists every live Claude Code session under a directory,** wherever it was started (Warp, Cursor, any terminal), grouped by git repo. Finished background sessions, and interactive sessions that ended recently, are listed too.
- **Shows which sessions need you,** judged from each session's context: a prompt on screen, a question it asked, or what Claude Code says a background session needs.
- **Lets you act on a session:** read its conversation and its sub-agents', message it, or drive a background session in a terminal in the page, permission prompts included.
- **Starts new sessions** in any directory under a root, with files attached to the first prompt, and resumes an ended interactive session in the background.
- **Opens a session's directory** in VS Code or Cursor.
- **Will have a supervisor session** (M5) you can talk to instead of visiting each session, knowing what each one is waiting on and what's urgent.

**Status:** M1, a read-only index, M2, interacting with sessions from the web UI, M3, a design system and restyle, and M3.1, the work after M3, are merged into `main`: M3 on 2026-10-23 in [PR #51](https://github.com/leggetter/pitwall/pull/51), and M3.1 on 2026-10-28 in [PR #87](https://github.com/leggetter/pitwall/pull/87). End session for interactive sessions is approved (W90), after W88. Then M4: open pull requests next to the sessions working on them. See [`PLAN.md`](PLAN.md).

## Try it

pitwall runs from a clone of this repo. It isn't published to npm.

### What you need

- **macOS.** It's only been used on macOS. CI builds and tests it on Ubuntu, but nobody has run it on Linux or Windows.
- **Node 22 or later,** with npm. CI uses Node 22.
- **Claude Code,** logged in, with `claude` on your `PATH`. pitwall has been used with Claude Code 2.1.312. The one version it checks is for messaging an interactive session: its relay needs 2.1.295 or later, and pitwall won't start it on an older one.
- **git,** to clone the repo, and for grouping sessions by repo.

### Run it

```
git clone https://github.com/leggetter/pitwall.git
cd pitwall
npm ci
npm run build
node dist/cli.js ~/code
```

- **The root:** `~/code` stands for the directory that holds your work. pitwall lists every session whose working directory is in it or below it. Give two or more roots, such as `~/work ~/oss`, to get a tab for each, or none for the current directory.
- **npm's notes:** `npm ci` may say it skipped install scripts for `esbuild`, `fsevents` and `node-pty`, as recent npm 11 releases do by default. On macOS that's fine: `node-pty`, the one native module, loads the macOS build it ships with, and pitwall makes its helper executable the first time it attaches. It may also report advisories in two dev dependencies, Vite and happy-dom. pitwall uses Vite only to build the web UI, never its dev server, and happy-dom only in `npm test`.
- **On Linux,** which is untried, `node-pty` ships no build and compiles in its install script, which needs Python, `make` and a C++ compiler. npm 10 runs that script, as CI does; npm 11 skips it unless it's approved (`npm help install-scripts`). Without it, attaching to a session fails with a message, and the rest of pitwall works.

### What happens

- **Your browser opens pitwall** at `http://127.0.0.1:4517/`. pitwall opens it through a launch file in `~/.pitwall/`, so the token is never in a command line that other users can see with `ps` (D7). The page moves the token out of the address bar.
- **If it doesn't open,** use the link pitwall prints: `pitwall is running at http://127.0.0.1:4517/#token=…`.
- **A new token every run.** A tab from an earlier run can't reconnect, so use the new link. `PITWALL_TOKEN` fixes the token, for a pinned tab on a single-user machine (D7).
- **If port 4517 is busy,** pitwall uses a free port and says so. `--port <n>` picks one, and fails if it's busy.
- **To stop pitwall,** press Ctrl+C in its terminal. Your sessions keep running: a terminal open in the page detaches without stopping its session, and pitwall's relay session, if it started one, stops with it.

### What pitwall reads, and what it does only when you ask

- **It reads, and changes nothing:**
  - `claude agents --json --all`, every 5 seconds, for the list of sessions.
  - Each session's transcript in `~/.claude/projects/`, its sub-agents' transcripts beside it, and a background job's state in `~/.claude/jobs/`, for what it's doing and whether it needs you.
  - To find ended sessions, the start of every transcript in `~/.claude/projects/` changed in the last 30 days, whatever its directory, kept in memory. Only those under your roots are listed.
  - `ps` for when a session's process started, `claude --version` before its relay starts, and `/Applications` and `~/Applications` for VS Code and Cursor.
  - Read-only `git` in the repos under your roots, to group sessions and find the repos each one worked in, and the directories under each root, for New session's list.
- **It acts only when you ask:**
  - **Message** an interactive session, through a headless Haiku session it runs, `pitwall-relay`, which can send only the exact message you wrote, to the session you picked (D8). The session sees it as a message from another session, so a message can't approve a permission prompt.
  - **Attach** to a background session, in a terminal in the page. Opening a running one's view attaches to it by default, since that's where it takes input; one that has finished asks first, because attaching restarts it (D9).
  - **Start** a session with `claude --bg`, and **stop** or **remove** a background one with `claude stop` or `claude rm`, after a confirmation.
  - **Resume** an ended interactive session in the background, with `claude --resume <id> --bg` (D17).
  - **Open** a session's directory in VS Code or Cursor (D19).
- **Its own files are all in `~/.pitwall/`:** the launch file, its relay's folders, and the files you attach to a new session's first prompt, which it deletes after an hour if they're unused, or 7 days after the session started (D20). `PITWALL_HOME` moves it.

### Security, in brief

A page that can type into your sessions can run code as you, so pitwall guards it (see "Security" in [`PLAN.md`](PLAN.md)):

- **Localhost only:** the server listens on 127.0.0.1 alone, and trusts no other host name, not even `localhost`.
- **A token:** every API request and the WebSocket need it. The page proves it holds the token over the WebSocket instead of sending it, and anything that changes state also needs a key that only that page gets.
- **`Host` and `Origin` checks:** `Host` must be `127.0.0.1:<port>` on every request, against DNS rebinding. A WebSocket must come from pitwall's own page, an API request from another origin is refused, and there's no CORS.

### Caveats

- **Undocumented rows:** pitwall finds the interactive sessions running in your terminals through their rows in `claude agents --json`, which Claude Code's docs don't describe: they describe background sessions only. If a release drops those rows, pitwall loses most of its value (D1).
- **Internal files:** transcripts, sub-agents' folders and job state are Claude Code's internal formats, which change between versions. pitwall reads them read-only, behind adapters that fail soft: a file it can't read shows as unavailable, or as less detail, never as a crash.
- **A running interactive session can only be messaged, not driven.** For anything more, such as answering a prompt, type `/bg` in the session's terminal to move it to the background, and pitwall can then attach to it (D2).
- **Untrusted directories:** Claude Code won't start a session from a script in a directory you haven't trusted. New session then shows Claude Code's error and the command to run; pitwall never grants trust for you.
- **Cost:** each message you send starts a turn on the target session's own model, plus a Haiku turn in the relay.

## Use

```
node dist/cli.js [root...] [--interval <seconds>] [--port <n>] [--no-open]
```

- **Roots:** a directory, or several. The default is the current directory. Sessions whose working directory is under a root are listed.
- **Opening it:** the CLI opens your browser through a launch file in `~/.pitwall/` (D7), which sends it to `http://127.0.0.1:<port>/#token=...`. The token is per run unless `PITWALL_TOKEN` fixes it, and never appears in a process's arguments. A per-run token is printed with the URL, since every copy dies with the run; a fixed one never is (W51). The page moves it out of the address bar, and never sends it to the server: it proves it with an HMAC over the WebSocket. `PITWALL_HOME` overrides `~/.pitwall`.
- **Port:** the default is 4517, falling back to a free port if it's busy. An explicit `--port` fails instead.
- **Interval:** `--interval` sets the poll, in seconds (default 5).
- **Acting on sessions:** open a session to read its conversation, and its sub-agents in their own tab; attach to a background session in a terminal in the page; message an interactive session through the relay (D8); start a session, with attachments (D20), and stop and remove background sessions; resume an ended interactive session (D17); open a session's directory in an editor (D19). Finished background sessions and ended interactive ones stay listed, in a Finished section at the end of the list.
- **Layout:** repos, then the selected repo's sessions, then the open session (D11). `/` filters, `n` starts a session, `?` lists the shortcuts, `j`/`k` move through the list and `s` stars the open session; a setting turns them off (D13).

## Licence

Apache-2.0: see [`LICENSE`](LICENSE) (D21). The bundled fonts and icons keep their own licences, listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Decisions

The settled decisions, D1 to D21, with their reasoning, are in [`docs/decisions.md`](docs/decisions.md).
