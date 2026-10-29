# Spike 009: the supervisor process

Run on 2026-10-29 against Claude Code v2.1.312 on macOS, for M5 step 1 (PLAN.md, "M5 - Supervisor"; D4 reopened). Phil approved running it (2026-10-29). It asks whether a headless `claude -p` stream-json session, run the way pitwall runs the relay (D8), can be pitwall's supervisor: across restarts, with pitwall's MCP server, with approvals, and with replies from the sessions it messages.

## Setup

- **The supervisor stand-in:** `pitwall-test-supervisor`, `claude -p` with stream-json in and out, on Opus 5.5 (`claude-opus-5-5`). A small Node driver stood in for pitwall: it owned the process's stdin and stdout, scrubbed its environment as `relayEnvironment()` does, and ran it in an empty 0700 temp directory that was never trusted. Its tools were `SendMessage` and the stand-in MCP server's, with no Bash, file or web tools.
- **The gate:** a `PreToolUse` hook on `SendMessage`, in exec form with `onFailure: "block"`, that denied (exit 2) any call whose `to` or `recipient` wasn't the target's name or inbox address.
- **The stand-in MCP server:** about 150 lines of Node speaking JSON-RPC 2.0 over stdio, and over HTTP for one run. Its tools were `list_sessions` and `session_turns` (read-only, made-up data), `spawn_session` (a stub that starts nothing) and, for one run, `approve` (a permission prompt tool). It refused tool calls without the right token.
- **The target:** `pitwall-test-target`, a background session on Haiku 5.5 (`claude-haiku-5-5`) in a trusted checkout, with `SendMessage` and `ListAgents`. It was told to echo any message from a `pitwall-test-*` sender, and its own hook allowed replies only to the supervisor's name and addresses.
- **The approval helper:** a local HTTP server that held each request from the approval hook until I wrote a decision file, or answered by a timed policy.
- **Clean-up:** every session was removed afterwards, with the one socket file a SIGKILL left behind. `claude agents --json` listed the same 12 sessions before and after, none named `pitwall-test-*`, and `--all` lists none either. No process from the spike is left.
- **Spend:** 39 supervisor results on Opus 5.5 came to $0.44 as Claude Code estimates it (`costBasis: "list"`), on the Max login (`apiKeySource: "none"`), plus a few cents of Haiku turns.

## Answers

| # | Question | Answer |
| --- | --- | --- |
| 1 | Restart | **Yes.** After SIGTERM, `--resume <id>` carried the conversation over: same session id, same transcript, and the name came back even without `--name`. The inbox address moves with the process id, and a reply sent to the old one fails at the sender. Resuming the id as a background session starts a copy while pitwall's process runs. While it's down, the background session takes the id, and pitwall's resume then exits 1. Resume needs no trust in an untrusted directory (findings 2 and 3) |
| 2 | pitwall's MCP server | **Yes.** A server in a `--mcp-config` file loads with `--setting-sources ""` and `--strict-mcp-config`, and its tools appear as `mcp__pitwall__<tool>`. A token file the server reads, or an `Authorization` header in the config file for an HTTP server, keeps the token out of `ps`. `env` in the config file puts it in the server's environment (finding 4) |
| 3 | Approvals | **Both work; recommend (b).** (a) A hook can wait as long as its `timeout` (a 610 s wait passed with `timeout: 900`). A timeout blocks the call only with `onFailure: "block"`: without it, `SendMessage` ran unapproved. (b) `--permission-prompts host` needs a permission host. With `--permission-prompt-tool stdio`, which the Agent SDK passes but the CLI reference doesn't list, each ask arrives as a `can_use_tool` control request on stdout and is answered on stdin, with no timeout. It works with `--permission-mode default` and an `ask` rule, `SendMessage` included (findings 5 and 6, recommendation) |
| 4 | Replies | **Yes.** A reply starts a new turn on the supervisor's stdout. Its `result` carries `origin`, with the sender, its pid and the reply's text. With `--replay-user-messages`, a `user` event carries it as well (finding 7) |
| 5 | Cost and time | **On Opus 5.5 at its default `medium` effort:** a short turn cost $0.002 to $0.004 in about 2 s, and a turn with a tool call $0.008 to $0.010 in about 4 s. The overview turn cost $0.023 in 3.8 s, and the follow-up $0.007. A cold first turn cost $0.040. The prompt cache is the 1-hour kind and survives restarts. `--effort` and `/effort` change the level (finding 8) |
| 6 | Visibility | **Listed as `interactive`** in `claude agents --json`, with `id` and `state` null, from the moment it starts. The target's `ListAgents` showed `pitwall-test-supervisor [<ref>] · interactive · busy`. The transcript goes under `~/.claude/projects/`, from the first prompt (finding 9) |
| 7 | Anything else | It starts in about 0.3 s and stderr stays quiet. Its RSS is 150 to 220 MB. When stdin closes, it finishes the turn and exits 0. A turn is stopped with an `interrupt` control request. The appended system prompt is frozen at the first request (finding 10) |

## Findings

### 1. The command line

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-hook-events
  --name <name> --model claude-opus-5-5 --tools SendMessage --permission-mode dontAsk
  --setting-sources "" --strict-mcp-config --mcp-config <0600 file>
  --allowed-tools mcp__pitwall__list_sessions,mcp__pitwall__session_turns
  --settings <0600 file> --append-system-prompt <text> [--resume <session id>]
```

- **`--tools` limits built-in tools only.** `system/init`'s `tools` was `SendMessage` and all four `mcp__pitwall__*` tools. It also lists bundled skills, built-in agents and three built-in plugins, but without the Skill or Agent tool the model can't use them.
- **MCP tools outside `--allowed-tools` are denied** in `dontAsk` mode: `system/permission_denied` with `decision_reason_type: "mode"`.
- **`system/init` comes at the start of every turn,** not when the process starts. Before the first prompt, the stream has only the SessionStart hook's events and `system/session_title_changed`. Its fields include `session_id`, `messaging_socket_path`, `permissionMode`, `apiKeySource`, `per_turn_effort_active` and `capabilities` (`interrupt_receipt_v1`, `interrupt_cancel_queued_v1` and others).
- **Each turn also brings a `rate_limit_event`**: `rate_limit_info.status`, `rateLimitType: "five_hour"`, `resetsAt` and `unifiedWindows.five_hour.utilization`. Pitwall could show plan usage from it.
- **`ps` shows the whole command line,** including the appended system prompt and every path, but no message text: that goes over stdin.

### 2. Restarting and resuming

| Step | What happened |
| --- | --- |
| SIGTERM | Exit 143 within 0.3 s. The MCP server's process went with it, the socket file was removed, and the row left `claude agents` |
| SIGKILL | The stdio MCP server exited on end of stdin (the stand-in does; pitwall's must too). The socket file `/tmp/cc-socks/<pid>.sock` was left behind |
| `--resume <id>` with the same flags | The SessionStart hook ran with `source: "resume"`, under the same `session_id`. The model recalled the facts from turn 1 and the MCP result from turn 2. One transcript file kept growing |
| `--resume <id>` without `--name` | The name was kept: `session_title_changed` carried it, and `claude agents` listed it |
| Untrusted directory | `-p --resume` asked nothing. `claude --bg --resume <id>` there exits 1: ``Workspace not trusted. Run `claude` in <dir> once and accept the trust prompt, then retry.`` |
| Inbox address | `uds:/tmp/cc-socks/<pid>.sock`, new with each process: three restarts gave three addresses |
| Prompt cache | The first turn after a restart read 5,407 cached tokens and cost $0.0023 |

- **A reply to the old address fails at the sender.** The target's reply was held back 25 s by its hook while the supervisor restarted. Its `SendMessage` then returned `{"success":false,"message":"Failed to send to uds:/tmp/cc-socks/<old pid>.sock: ENOENT: no such file or directory, lstat '…' — the peer process may have restarted, so this socket path is stale. Call ListAgents to get the current address."}`, and the new process received nothing. The target had been told not to retry. An ordinary session may call `ListAgents` and retry by name, as in spike 003, and that reaches whichever session has the name.
- **A reply while the supervisor is up but idle** starts a turn at once, even 25 s after the send.
- **Cost totals are for the whole conversation.** `total_cost_usd`, `modelUsage` and `duration_api_ms` include earlier processes on the same session id. A turn's own cost is `model_usage_since_last_result.<model>.costUSD`.
- **The system prompt is frozen at the first request.** On a resume with a different `--append-system-prompt`, the model didn't follow the new text. With `--system-prompt-snapshot off` it did, but that turn wrote the whole 12,390-token prefix to the cache again: $0.103 instead of about $0.007.

### 3. A background session on the supervisor's id

- **While pitwall's process runs:** `claude --bg --resume <id>`, from a trusted directory, prints `note: session <id8> is open in another Claude Code process, so this started a copy as <new id8>. The original conversation is unchanged.`
- **While it's down:** the same command continues the id itself, as a background session, and appends its turns to the supervisor's conversation. After it was removed, the supervisor recalled the background session's turn as its own.
- **Pitwall's resume then fails.** `claude -p --resume <id>` exited 1 within 0.66 s, with nothing on stdout and this on stderr: ``Error: That session is running in the background (<id8>). Run `claude attach <id8>` to open it, or `claude stop <id8>` first to resume it here. Add --fork-session to branch off a copy instead.`` The docs say "Two processes can't write to the same transcript."
- **After `claude stop` and `claude rm`,** the transcript was still there and `-p --resume` worked again.
- **How it could happen:** Phil resuming the supervisor by id or by name from any trusted directory while pitwall is stopped.

### 4. pitwall's MCP server

| How | Loaded | Where the token is |
| --- | --- | --- |
| stdio, with the path of a 0600 token file in `args` | Yes | Only in the file |
| stdio, with `env` in the config file | Yes | In the 0600 config file and the server's environment, which `ps -E` shows to the same user. Not in `claude`'s environment |
| `type: "http"` with `url` and `headers: {"Authorization": "Bearer …"}` | Yes, and every request carried the header | Only in the 0600 config file: not in `claude`'s arguments or environment |
| Inline JSON as the `--mcp-config` value | Not tried | It would be in `claude`'s arguments, so `ps` would show it |

- **The handshake:** a `server/discover` request first (the stand-in answered "method not found", which was harmless), then `initialize` with `protocolVersion: "2025-11-25"` and `clientInfo.name: "claude-code"`, `notifications/initialized` and `tools/list`, done 0.23 to 0.53 s after start. `system/init` reports `mcp_servers: [{"name":"pitwall","status":"connected","source":"dynamic"}]`.
- **HTTP needs no extra process,** since pitwall's server can answer MCP itself. A tool call over HTTP ran as over stdio.
- **The cache is shared across sessions.** A fresh session in a new process with the same system prompt and tools read 9,283 cached tokens on its first turn, which cost $0.010.

### 5. Approvals, (a): a PreToolUse hook that asks pitwall

The hook matched `SendMessage|mcp__pitwall__spawn_session`, in exec form, with `onFailure: "block"`. It checked the recipient as the gate does, then POSTed the call to the helper and waited. An allow was `permissionDecision: "allow"` JSON on stdout; a deny was exit 2 with the reason on stderr. The permission mode was `dontAsk`, and `spawn_session` wasn't on the allow list.

- **Allow:** `spawn_session` ran after a 5.4 s wait. A hook's allow is enough in `dontAsk` mode.
- **Deny:** the model's tool result was `is_error: true`, `PreToolUse:SendMessage hook error: [<node> <hook script> approve <state dir> supervisor]: <reason>`, so it also shows the hook's command line. `result.permission_denials` listed the call, and Opus didn't retry.
- **Long waits:** with `timeout: 900`, the helper answered after 610 s, the call ran, and the turn ended after 612 s. The docs give 600 s as the default for command hooks, and state no upper limit.
- **A timeout with `onFailure: "block"`:** `PreToolUse:mcp__pitwall__spawn_session hook error: [<command>]: timed out; blocking because onFailure is "block"`. The `hook_response` event had `exit_code: 143` and `outcome: "cancelled"`.
- **A timeout without `onFailure`:** the `SendMessage` was sent, with nobody's approval. `spawn_session` was denied only because `dontAsk` denies a tool that isn't allowed (`decision_reason_type: "mode"`). `SendMessage` needs no permission, so nothing stopped it.
- **Input during the wait:** stdin is still read. A prompt sent mid-turn waited and ran as its own turn afterwards. An `interrupt` control request was answered within 9 ms, and the hook got SIGTERM (`exit_code: 143`, `outcome: "cancelled"`). The tool result was "The user doesn't want to proceed with this tool use. …", followed by `[Request interrupted by user for tool use]` and a `result` with subtype `error_during_execution`.

### 6. Approvals, (b): permission prompts sent to pitwall

Run with `--permission-mode default --permission-prompts host` and `permissions.ask: ["SendMessage", "mcp__pitwall__spawn_session"]` in `--settings`, with the deny-only gate hook still on `SendMessage`.

- **Without a prompt tool, every ask is denied.** The tool result was `Claude requested permissions to use mcp__pitwall__spawn_session, but you haven't granted it yet.`, with `system/permission_denied` and `decision_reason_type: "rule"`. Sending the SDK's `initialize` control request didn't change that. Its response came back with `pending_permission_requests: []` and the session's commands, agents and models.
- **`--permission-prompt-tool stdio` is the switch.** It's what Agent SDK 0.3.312 passes when `canUseTool` is set (`--permission-prompt-tool=stdio` in its `sdk.mjs`), and it isn't in the CLI reference. With it, the request arrives on stdout:

```json
{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool","tool_name":"SendMessage","display_name":"SendMessage","input":{"to":"pitwall-test-target","summary":"…","message":"…","type":"message","recipient":"pitwall-test-target","recipient_kind":"name","content":"…"},"decision_reason_type":"rule","decision_reason_rule_source":"flagSettings","server_policy_ask_only":false,"tool_use_id":"toolu_…"}}
```

  An MCP tool's request also has `mcp_server: {"name":"pitwall","source":"dynamic"}`, and `display_name: "Spawn Session"`. Pitwall answers on stdin:

```json
{"type":"control_response","response":{"subtype":"success","request_id":"<uuid>","response":{"behavior":"allow","updatedInput":{…}}}}
{"type":"control_response","response":{"subtype":"success","request_id":"<uuid>","response":{"behavior":"deny","message":"Phil declined this message in pitwall"}}}
```

- **`SendMessage` asks under an `ask` rule,** although it normally needs no permission. The gate hook ran first (no decision), then the request came.
- **Allow and deny:** an allow after 22 s ran the call. On a deny, the model saw exactly pitwall's message. The tool result's `tool_result_meta.permission_decision` reads `{decision: "accept", source: "user_temporary"}` for a host's allow, `{decision: "reject", source: "user_reject"}` for a deny, and `{decision: "accept", source: "config"}` for a call no rule asked about.
- **Edit before sending:** an allow whose `updatedInput` had a changed `message` sent the edited text, which the target echoed. The model wasn't told: its tool result showed only the summary, and it quoted the original. The gate hook had checked the original input, not the edit.
- **A malformed answer** (`behavior: "maybe"`) became a tool error, `The canUseTool callback returned an invalid permission result. Expected {behavior: 'allow', updatedInput?: object} or {behavior: 'deny', message: string}. …`, and the call didn't run.
- **An interrupt while a request is pending:** the CLI sent `{"type":"control_cancel_request","request_id":"<the can_use_tool request's id>"}`, then the interrupt's receipt, and rejected the call.
- **Stdin closing while a request is pending:** `Tool permission request failed: AbortError: Tool permission stream closed before response received`. The turn finished and the process exited 0.
- **No timeout:** the SDK reference says "permission prompts don't time out". A request waited, unanswered, until I answered it.
- **How documented:** the Agent SDK's TypeScript reference describes the envelope (`control_request`, `request_id`, `control_response`, and `pending_permission_requests` on `initialize`, which redelivers unanswered requests), and speaks of parsing "the wire protocol yourself". The request's fields and the `stdio` value aren't documented for the CLI.

**Two other documented routes,** one tried:

- **An MCP prompt tool, `--permission-prompt-tool mcp__pitwall__approve`:** the CLI called the tool with `{tool_name, input, tool_use_id}`, and left it out of the model's tool list. The answer is the tool result's text, the same JSON as `response` above. A deny reached the model as its `message`. The docs give it MCP's timers: a stdio call aborts after 30 minutes with no response or progress notification (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`), and an HTTP call after 60 s per request unless the server's `timeout` is raised. Timeouts, interrupts and stdin closing weren't tried on this route.
- **`permissionDecision: "defer"` from a PreToolUse hook,** which the hooks reference describes for "a custom UI built on top of Claude Code": the turn ends with `stop_reason: "tool_deferred"`, and the call runs only when pitwall resumes the session with no prompt. That's a process restart per approval. Not run.

### 7. Replies

- **The stream for a reply,** with nothing on stdin: `command_lifecycle` (`command_uuid`, `state: "started"`), `system/init`, `assistant`, `rate_limit_event`, `result`, and `command_lifecycle` with `state: "completed"`. By default, no `user` event carries the reply.
- **The `result` carries it in `origin`:** `{"kind":"peer","from":"uds:/tmp/cc-socks/<pid>.sock","verifiedPeerPid":<pid>,"msg_id":"<uuid>","name":"pitwall-test-target","hopChain":["<hex>"],"fromMode":"prompting","body":"echo: ping from spike 009"}`. A turn pitwall prompted has no `origin`.
- **With `--replay-user-messages`,** a `user` event comes first, with `isReplay: true`, `isSynthetic: true`, the same `origin`, and the text as the model reads it: `Another Claude session sent a message:\n<cross-session-message from="…" from-name="…" from-mode="prompting">\n…\n</cross-session-message>`. Pitwall's own prompts are replayed too, with `isReplay: true` and no `origin`.
- **The send's tool result** has `tool_use_result: {success, message, display, msg_id}`, as spike 003 found in the transcript, and `tool_result_meta`.
- **Timing:** the Haiku target's reply arrived 2 to 5 s after the send, as its own supervisor turn costing $0.004 to $0.005.
- **The transcript** records the reply as a `user` entry with `isMeta: true` and the same `origin`, as spike 003 found for the relay.

### 8. Cost and time per turn

From the stream's `result` events: `model_usage_since_last_result`, `duration_ms` and `ttft_ms`. Effort was the default, `medium`.

| Turn | Model calls | Cache read | Cache written | Output (thinking) | Cost | Time |
| --- | --- | --- | --- | --- | --- | --- |
| First turn, cold cache | 1 | 0 | 4,965 | 21 (0) | $0.040 | 2.0 s |
| Short answer after a restart | 1 | 5,407 | 67 | 33 (0) | $0.0023 | 2.0 s |
| `list_sessions` and an answer | 2 | 9,620 | 800 | 76 (0) | $0.0099 | 3.5 s |
| `SendMessage` and an answer | 2 | 11,005 | 304 | 155 (0) | $0.0078 | 4.1 s |
| A reply arriving | 1 | 5,778 | 285 | 24 (0) | $0.0039 | 1.9 s |
| Overview: 20 recaps (5,089 characters, mean 246 each) and "What should I work on next?" | 1 | 6,634 | 1,929 | 286 (96) | $0.0225 | 3.8 s |
| Follow-up on the overview | 1 | 8,563 | 318 | 134 (85) | $0.0070 | 2.9 s |
| A new conversation, prefix cached by another | 2 | 9,283 | 734 | 116 (0) | $0.0101 | 2.9 s |
| A changed system prompt, snapshot off | 1 | 0 | 12,390 | 206 (168) | $0.103 | 4.5 s |
| Haiku 5.5, with a tool call | 2 | 5,786 | 5,913 | 96 (0) | $0.0013 | 2.3 s of model time |

- **The cache is written with a 1-hour lifetime** (`cache_creation.ephemeral_1h_input_tokens`), so a supervisor idle for under an hour keeps its prefix warm, across restarts too.
- **Time to first token** was 1.9 to 2.4 s on Opus. The first prompt reached the API 26 to 39 ms after pitwall wrote it.
- **Effort:** the default is `medium`. The docs say so for Opus 5.5, and the transcript records `"effort":"medium"` on each request. `--effort low` at start and `/effort high` mid-session changed it, as the transcript showed. `/effort` alone prints its usage, not the current level, and neither `system/init` nor `result` carries it.
- **An interrupted turn reports no usage:** its `result` had zero tokens, and `total_cost_usd` didn't change, although the model had streamed part of an answer.

### 9. Visibility

- **`claude agents --json`:** `{"pid":<pid>,"id":null,"cwd":"<temp dir>","kind":"interactive","sessionId":"<uuid>","name":"pitwall-test-supervisor","status":"idle","state":null}`, with `status` `busy` mid-turn. It's listed as soon as the process starts, before any prompt, and leaves when it exits. Background rows have an `id` and a `state`.
- **`ListAgents`, from the target:** `pitwall-test-supervisor [<ref>]  ·  interactive  ·  busy  ·  started 1m ago`, where "started" is the current process's start.
- **The transcript:** `~/.claude/projects/<the directory, with / as ->/<session id>.jsonl`, mode 0600. No file is written until the first prompt. It reached 287 KB over about 25 turns, mostly `api-request` records. A background session that continued the id from another directory wrote to the same file.
- **Inbound messages:** the supervisor runs in a prompting mode, so it receives messages from prompting sessions (`fromMode: "prompting"`). By the docs, a message from a session that bypasses permissions is held for 5 minutes and then dropped, as at the relay. Not tested.

### 10. Other things M5 needs to know

- **Start-up:** the SessionStart hook finished, and the MCP server had listed its tools, 0.23 to 0.59 s after start.
- **stderr:** empty in every run but the refused resume (finding 3). The debug log alone had a non-fatal lock message.
- **Memory:** 150 to 220 MB RSS for `claude`, and 38 to 40 MB for the Node MCP server.
- **Stdin closing:** when idle, exit 0 in about 0.5 s. Mid-turn, the turn finishes, its `result` is written, and it exits 0 about 0.3 s later, as spike 003 found for the relay.
- **Interrupting a turn:** `{"type":"control_request","request_id":"<id>","request":{"subtype":"interrupt"}}` was answered within 8 ms with `{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"still_queued":[]}}}`. The partial text came as an `assistant` event, then a `user` event `[Request interrupted by user]`, then a `result` with subtype `error_during_execution`, `is_error: true` and `stop_reason: null`. The session took the next prompt normally.
- **Hook events:** with `--include-hook-events`, `system/hook_started` and `system/hook_response` carry `hook_name` (such as `PreToolUse:SendMessage`), `exit_code`, `outcome` (`success` or `cancelled`), `stdout` and `stderr`.
- **Thinking:** some turns stream `system/thinking_tokens` events and `thinking` blocks. Thinking was 0 to 168 tokens a turn.

## Recommendation for M5

1. **Run the supervisor as tested:** the relay's arguments (`relayArgs()`), plus `--mcp-config` with a 0600 file and `--allowed-tools` for the read-only MCP tools. Use Opus 5.5 at the default `medium` effort, and a fixed empty 0700 directory such as `~/.pitwall/supervisor/`. Pitwall keeps the session id and starts the process with `--resume <id>`.
2. **Serve the MCP server over HTTP from pitwall's own server,** with the token as a bearer header in the config file. That needs no extra process and keeps the token out of `ps`. It needs the same token, `Host` and `Origin` checks as the API. A stdio server reading a token file works too, but it's one more process, which must exit when its stdin ends.
3. **Approvals: (b), the permission prompts, answered by pitwall on the stream it already owns.**
   - **Flags:** `--permission-mode default`, `--permission-prompts host` and `--permission-prompt-tool stdio`, with `ask` rules for `SendMessage` and `spawn_session`. Allow only the read-only MCP tools.
   - **Keep the gate:** the deny-only `PreToolUse` hook for recipients, so a call pitwall would never send is refused before Phil sees a card.
   - **The off switch** (#101): allow rules in place of the `ask` rules.
   - **Cards:** each `can_use_tool` request is a draft card. Send answers `allow`, and Edit answers `allow` with `updatedInput`, which pitwall checks itself, since the gate saw only the original. Don't send answers `deny` with a message. A `control_cancel_request` withdraws the card.
   - **Why not (a):** its wait ends at a fixed `timeout`. It fails open on a timeout unless `onFailure: "block"` is set, which this spike showed for `SendMessage`. Its denial shows the model pitwall's hook command line. And it must name every gated tool in its matcher.
   - **The cost of (b):** the `stdio` value isn't in the CLI reference. It belongs behind the adapter, failing soft: if requests stop arriving, every ask is denied, never allowed. The documented MCP prompt tool is the fallback, with the same JSON. It worked for a deny, but it adds MCP's timers.

| Failure | (a) hook asking pitwall | (b) permission prompts to pitwall |
| --- | --- | --- |
| Nobody answers | Blocked at the hook's `timeout`, but only with `onFailure: "block"`. Without it, `SendMessage` runs | Waits: by the docs, nothing times out. Pitwall can deny after a deadline of its own |
| Pitwall exits | Not tested. By the docs, the hook's failed request blocks the call with `onFailure: "block"`; then the turn ends and the process exits | Stdin closes, so the request is denied ("stream closed"); then the turn ends and the process exits 0 |
| Garbage answer | By the docs: exit 2 blocks, and any other failure blocks only with `onFailure: "block"` | A tool error; the call doesn't run |
| Interrupt | The hook is killed and the call rejected | `control_cancel_request`, then the call is rejected |
| A tool nobody listed | Not asked about: `dontAsk` denies it unless allowed | Asks pitwall, because `default` mode prompts for it |

4. **Restarts:**
   - **Keep them rare:** a reply in flight to the old address fails at its sender.
   - **Read replies from the index:** the receiving session's transcript keeps them, as with the relay (D8).
   - **A background session holding the id:** pitwall's resume exits 1 with ``That session is running in the background``. Show that in the app strip with the `claude stop` command; don't stop it for Phil.
5. **Version the system prompt.** It's frozen at the first request, so a new prompt means a new conversation, or one turn with `--system-prompt-snapshot off`, which costs a full cache write (about $0.10 at this spike's length).
6. **The chat panel:**
   - **Reading the stream:** expect `system/init` on every turn, and show replies from `result.origin`, or from the replayed `user` event.
   - **The strip:** per-turn cost from `model_usage_since_last_result`, and plan usage from `rate_limit_event`.
   - **The Stop button:** the `interrupt` control request.

## Open questions

- **The `stdio` value:** can pitwall depend on `--permission-prompt-tool stdio` behind the adapter, as the Agent SDK does? Or should it use the documented MCP prompt tool, and accept MCP's timers?
- **A card left unanswered:** should pitwall deny it after some time, since (b) never times out? And what should the supervisor be told?
- **Edited messages:** should the supervisor learn that Phil edited its message? It believes it sent its own text.
- **A background session on the supervisor's id:** stop it, fork with `--fork-session`, or only report it?
- **Not tested:** the MCP prompt tool's timeout, interrupt and stdin-close behaviour; messages to the supervisor from a session that bypasses permissions; whether macOS shows another user a process's environment with `ps -E` (expected not).
- **The model:** only one Haiku 5.5 supervisor turn was measured ($0.0013). Spike 010 measures Haiku for recaps.
