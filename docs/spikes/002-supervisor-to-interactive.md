# Spike 002: a background supervisor messaging an interactive session

Run on 2026-10-16 against Claude Code v2.1.301 on macOS. It closes the two S4 gaps from [spike 001](001-session-control.md): a background session messaging an interactive one, and the reply coming back. Phil opened the target session for the test and asked for it to run.

## Setup

- **Target:** `pitwall-test-target`, an interactive session Phil started in Warp with `claude -n pitwall-test-target` in `~/leggetter/git/pitwall`. Idle, auto mode.
- **Supervisor stand-in:** `pitwall-test-supervisor`, a background session on Haiku in the same directory. It was limited to `ListAgents` and `SendMessage` and allowed to message the target only. Removed afterwards.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 11:08:06 | Supervisor spawned with `claude --bg` |
| 11:08:10 | `ListAgents` returned 20 peers; the target was listed as interactive and idle |
| 11:08:12 | `SendMessage` to `pitwall-test-target [6615fe]`, with `notify_when_idle: true` |
| 11:08:13 | Message queued in the target, which started a turn |
| 11:08:19 | The target replied with `SendMessage`; the reply started a new turn in the supervisor |
| 11:08:25 | The idle notice arrived at the supervisor |

## Results

- **Not blocked.** The supervisor's own auto-mode classifier allowed `SendMessage` to a live interactive session. The block in spike 001 came from my session's classifier: I was setting up an agent to message a live session without the user having asked for that.
- **Fast enough.** About 1 s from send until the target started its turn. The whole round trip took 7 s, most of it the target's model time.
- **The reply leg works.** The target replied by using the message's `from` attribute, a socket path like `uds:/tmp/cc-socks/<pid>.sock`, as its `to`.
- **Idle notices cross session kinds.** The background supervisor got the interactive target's notice 6 s after the reply, including the target's one-line status: «I sent pong to `pitwall-test-supervisor`, which asked for it as part of pitwall spike 002.»
- **The receiver applies its own rules.** Before replying, the target checked the repo's `AGENTS.md` rules (never touch a real session; spike sessions are named `pitwall-test-*`). A relayed request is only acted on if the receiving session's own instructions and permissions allow it. That's good for safety, and it means the supervisor can ask but never force.
- **What the transcript looks like on an interactive receiver:** a `queue-operation` entry (`enqueue`), then a `user` entry with `isMeta: true`. Its content starts `Another Claude session sent a message:` and wraps `<cross-session-message from="..." from-name="..." from-mode="...">`.

## What the target's terminal showed

From Phil's screenshot of the target session in Warp:

- **The message preview:** a dim italic line, `› Message from @pitwall-test-supervi…: pitwall spike 002: test message from pitwall-test-supervisor. Please reply to this session using SendMessage with the s… (ctrl+o to expand)`. This matches the docs.
- **The idle subscription is visible:** a notice reading "A process claiming the address uds:/tmp/cc-socks/24011.sock asked to be told when this session is next idle…". It names a raw socket address, not the supervisor's session name.
- **The reply is visible as a tool call:** `"Reply pong to pitwall spike 002 test" → uds:/tmp/cc-socks/24011.sock`.
- **The reply ran on the session's own model:** the target's header shows Opus 5.5 at xhigh effort. A relayed message costs a full turn on whatever model and effort the receiving session uses.
- **The receiver talks to the user about it:** the target ended its turn with next steps for Phil, including removing the supervisor as `AGENTS.md` requires.

## Not tested

- A message to a target that is mid-turn. The docs say it's read between tool calls.
- A target in the other permission class, bypassing permissions. The docs say the message is held for approval in a dialog.

## What changes in the plan

- **D4:** settled. The supervisor is a background Claude Code session.
- **M3:** no longer needs to start with this test.
- **M1 transcript adapter:** classify a cross-session entry by `isMeta: true` and its `Another Claude session sent a message:` prefix.
- **M3 supervisor behavior:**
  - Get status from pitwall's index, not by messaging sessions, because each relayed message costs a turn on the receiver's model.
  - Don't subscribe to idle notices broadly: each subscription prints a raw-address notice in the watched session's terminal. Pitwall's polling of `claude agents --json` already sees busy-to-idle changes without touching the session.
