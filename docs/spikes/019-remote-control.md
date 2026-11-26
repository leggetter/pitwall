# Spike 019: can pitwall turn on Remote Control for the supervisor and for other sessions?

Run on 2026-11-26 against Claude Code 2.1.332 on macOS, for Phil's ask: keep the supervisor reachable from the Claude mobile app, let pitwall turn on Remote Control (Claude Code's link that shows a local session in claude.ai/code and the mobile app) in sessions that are already running, and find out whether Remote Control on every session is noisy or costly. It answers five questions; it doesn't build anything.

The probes were three throwaway background sessions, `pitwall-test-rc-on`, `pitwall-test-rc-off` and `pitwall-test-rc-setting`, on Haiku with the prompt "Reply with OK.", plus one `claude -p` run. All were removed afterwards.

## Questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Does `claude -p --remote-control` connect, as the supervisor runs? | No sign of it: the flag is accepted silently, and a `--debug-file` log of the run has no Remote Control lines (finding 1) |
| 2 | Does `claude --bg --remote-control <name>` connect? | Yes: the job's `state.json` gains a `bridgeSessionId`; the session without the flag has none (finding 2) |
| 3 | Can a running background session be switched on from outside? | Not through pitwall's relay, which sends with `SendMessage`. Yes through `claude attach`: typing `/remote-control` and Enter connects it, and it stays connected after the attach ends (finding 3) |
| 4 | What does Remote Control cost an idle session? | Within noise for memory; about 0.2 s more CPU a minute; two more sockets (finding 4) |
| 5 | Does `remoteControlAtStartup` reach background sessions? | Yes, through `--settings '{"remoteControlAtStartup":true}'`. The user settings file wasn't tried, since it changes every session (finding 5) |

## Findings

1. **Print mode doesn't connect.** `claude -p --remote-control pitwall-test-rc --max-turns 1 --no-session-persistence "Reply with OK."` exited 0 with a normal result. The same run with `--debug --debug-file` wrote 551 lines, none about Remote Control or a bridge. `claude --help` describes the flag as "Start an interactive session with Remote Control enabled". The supervisor (`src/supervisor/prompt.ts`, `claude -p --input-format stream-json`) therefore can't be reached from the app as it runs today.
2. **`--bg --remote-control` connects, and `state.json` says so.**
   - `~/.claude/jobs/<short id>/state.json` of `pitwall-test-rc-on` had `bridgeSessionId` (`cse_<id>`), `bridgeOutboundOnly: false`, and the owner's account and organization ids. `pitwall-test-rc-off`'s had none of these.
   - `claude agents --json` shows nothing about Remote Control: the same keys for both (`pid`, `id`, `cwd`, `kind`, `startedAt`, `sessionId`, `name`, `status`, `state`).
   - The URL the session printed in finding 3 was `https://claude.ai/code/session_<id>`, with the same `<id>` as its `cse_<id>`. Seen once; an internal file and an undocumented mapping, so a reader goes behind the adapter and fails soft.
3. **Typing `/remote-control` through `claude attach` switches a running session on.**
   - The probe ([`019-remote-control/attach_rc.py`](019-remote-control/attach_rc.py)) opened `claude attach <short id>` in a PTY, typed `/remote-control`, pressed Enter, waited 8 s and hung up. The screen showed `/rc connecting…`, then `/remote-control is active · Continue here, on your phone, or at https://claude.ai/code/session_<id>`.
   - `state.json` gained a `bridgeSessionId`, and the session stayed alive and idle after the attach ended.
   - The relay can't do this. A message sent with `SendMessage` reaches the session as another session's message, not as typed input, so a `/remote-control` in it is text for the model (read from how the inbox delivers messages; not tried).
   - Not tried: typing it while the session is mid-turn, turning it off (the docs say `/remote-control` again shows a panel with Disconnect), and an interactive session in a terminal, which `claude attach` can't reach.
4. **The idle cost is small.** Both sessions were idle after replying; six samples 10 s apart:

   | | Memory (RSS) | CPU time over 60 s | Internet sockets |
   | --- | --- | --- | --- |
   | With Remote Control | 334 to 379 MB | 1.04 s | 16 |
   | Without | 379 to 392 MB | 0.82 s | 14 |

   One pair of sessions for one minute, so a direction, not a measurement. The docs state no per-session cost.
5. **The startup setting reaches background sessions.** `claude --bg --settings '{"remoteControlAtStartup":true}' …` had a `bridgeSessionId` 12 s after start. The docs say `remoteControlAtStartup: true` is honoured in `~/.claude/settings.json` and ignored in a project's `.claude/settings.json`.

## What pitwall could build

- **New and resumed sessions:** add `--remote-control <title>` to `spawnArgs` and `resumeArgs` (`src/server/actions.ts`), behind an "Available on mobile" choice, or leave it to `remoteControlAtStartup` in the user's own settings.
- **A running background session:** a "Turn on Remote Control" action that types `/remote-control` and Enter through the attach PTY (`src/server/attach.ts`, `pty.ts`), only while the session is idle, then reads `bridgeSessionId` and shows the claude.ai/code link.
- **Showing it:** a mark on a session whose `state.json` has a `bridgeSessionId`.
- **The supervisor:** option A runs it as an interactive `--bg` session with `--remote-control`, which means rewriting how pitwall reads it (the panel, the approval cards and the recipient gate read the `-p` stream). Option B adds a second, phone-facing interactive session with pitwall's read-only MCP tools. Either way approvals stay on pitwall's page (D4, the supervisor: read-only tools, acts only after your click), which is localhost only.
- **Security:** Remote Control lets anyone signed in to the account drive the session, through Anthropic's service, not through pitwall. pitwall's own rules (localhost, token, `Host` and `Origin` checks) are unchanged; a session with Remote Control is reachable outside them by design.
- **Noise:** every session with Remote Control is listed in claude.ai/code and the app. Push notifications are separate settings in `/config` ("Push when Claude decides", "Push when actions required").
