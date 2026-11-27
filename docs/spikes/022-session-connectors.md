# Spike 022: the supervisor reads through the claude.ai connectors your sessions already have

Run on 2026-11-27 against Claude Code 2.1.332 on macOS, for W191 (the supervisor reads through the connectors your sessions already have). It revises W184's route (sign in to each hosted server again) but not D28's rule (read-only, tools you choose).

**No connector data was read and nothing was posted.** No run called a claude.ai tool: the claude.ai runs were `Reply with OK.` turns on Haiku, or no turn at all (a control request). Every "does the model get held out" test (finding 4) ran against a throwaway local stdio server, [`022-session-connectors/fake-mcp.mjs`](022-session-connectors/fake-mcp.mjs), with `ENABLE_CLAUDEAI_MCP_SERVERS=false` so no claude.ai connector was even loaded. About 25 runs, under $2 in all (the unrestricted runs cost about $0.60 each, finding 5). All runs started in an empty scratch folder outside the repo, as the supervisor does (pitwall's own `.claude/settings.json` sets `disableClaudeAiConnectors`, which would hide the connectors).

## Questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Without `--strict-mcp-config`, but with `--setting-sources ""`, which servers load? | **Only the claude.ai connectors, plus what `--mcp-config` names.** `~/.claude.json`'s user servers, plugins' servers and a project `.mcp.json` don't load. `--setting-sources user` (or the default) loads all of them too. `--setting-sources ""` is already the fewest-others combination (finding 1). |
| 2 | Do the deny flags hold everything else out, a mid-turn tool included? | **Yes, with two caveats.** `--disallowed-tools` removes a tool from the model's list, a tool added later by `tools/list_changed` included. A tool on neither list is not held out by the flags, but the permission prompt tool (pitwall's `approve`) denies it before it runs. A deny entry beats an allow entry, so "deny every `mcp__claude_ai_*` but allow these" does not work (findings 3 and 4). |
| 3 | Do the connectors' tools carry `readOnlyHint` where pitwall can see it? | **Yes, as `annotations.readOnly`, through the stream's `mcp_status` control request,** with no model call and no tool call. Names and annotations only: no description, no input schema (finding 6). 16 of Notion's 77 tools carry no annotation. |
| 4 | Is there a documented way to load only some connectors, or to deny whole servers? | **To deny, yes: `deniedMcpServers` in `--settings`, by `serverName`.** A denied connector isn't connected at all. **To allow, no:** an `allowedMcpServers` list blocks every claude.ai connector, the ones it names included, by `serverName` and by the connector's `serverUrl` (finding 2). `claudeai-proxy` is not needed. |
| 5 | What are the connectors' exact names? | **Server name `claude.ai <Display name>`, tool prefix `mcp__claude_ai_<Display_name>__`:** `mcp__claude_ai_Slack__slack_read_channel`, `mcp__claude_ai_Notion__notion-fetch`. Every character outside `A-Za-z0-9_-` becomes `_` (finding 7). |

## Findings

1. **Which servers load without `--strict-mcp-config`.** Every run: `claude -p … --tools SendMessage --permission-mode default --max-turns 1 --model haiku --no-session-persistence --output-format stream-json --verbose`, plus the flags in the table, stdin held open 4 s (finding 8).

   | Run | Flags | Servers in `system/init` |
   | --- | --- | --- |
   | A | `--setting-sources "" --settings '{"autoMemoryEnabled":false,"crossSessionInbound":"refuse"}'` | **20 claude.ai connectors only**: Slack, Notion, Gmail, Google Drive and Calendar connected among them; none of `~/.claude.json`'s user servers, no plugin's |
   | B | `--settings …` only (default sources) | the 20 connectors, plus 6 user and plugin servers (a browser tool, Cloudflare's, Figma's plugin and an events plugin) |
   | C | `--setting-sources user --settings …` | the same as B |
   | T1 | A, plus `--mcp-config` (two fake servers) and a `.mcp.json` in the cwd | the two `--mcp-config` servers; **the project's `.mcp.json` server did not load** |

   - The supervisor's folder is `$PITWALL_HOME/supervisor/session`, an empty folder (`prompt.ts`, `supervisor.ts`), so a project `.mcp.json` can't be there anyway; `--setting-sources ""` would hold it out regardless.
   - `claude mcp list` and `claude mcp get "claude.ai Slack"` show `✔ Connected` from the scratch folder, with `Scope: claude.ai config`, and no tool list.
2. **Allowing only some connectors doesn't work; denying does.**
   - `deniedMcpServers` in `--settings`: `[{"serverName":"claude.ai Gmail"}]` removed Gmail from `mcp_servers` and its tools, and Claude Code printed `claude.ai MCP server blocked by enterprise policy: claude.ai Gmail`. The server isn't connected at all, so it costs nothing at start. Documented: Claude Code's MCP docs name `{ "serverName": "claude.ai Slack" }` as the way to block one connector, and warn the display name "can change" (a `serverUrl` entry is sturdier, but a claude.ai connector's URL is a per-account proxy ID).
   - `allowedMcpServers` in `--settings`: every claude.ai connector was blocked, Slack and Notion too, whether the entries were `serverName`s (`claude.ai Slack`, `Slack`, `claude_ai_Slack`) or `serverUrl`s (the connectors' proxy URLs from the debug log). The docs say an allowlist's `serverName` is limited to `A-Za-z0-9_-` and to use `serverUrl` for a claude.ai connector, but the `serverUrl` test didn't admit them either. The failure is plausibly the policy applying to flag settings differently, but that wasn't isolated, and managed policy wasn't touched.
   - `ENABLE_CLAUDEAI_MCP_SERVERS=false` (and `disableClaudeAiConnectors`) turns all claude.ai connectors off, so no use here except for the fake-server tests.
   - **`mcp_toggle` persists.** The stream-json control request `{"subtype":"mcp_toggle","serverName":"claude.ai Gmail","enabled":false}` disabled Gmail for the session, and **wrote `disabledMcpServers` to `~/.claude.json` under the folder's project entry** (documented as the per-project toggle's behaviour). It's a write to your file on every start; don't use it. This run left a `disabledMcpServers` entry for the scratch folder `/Volumes/Work/claude-jobs/4e431219/tmp/s22/cwd` in `~/.claude.json`.
   - **`claudeai-proxy`** (spike 017, finding 1) wasn't needed and wasn't tried; it stays internal and undocumented.
3. **Deny flags hold the connectors' tools out, and a deny beats an allow.**
   - `--disallowed-tools mcp__claude_ai_Slack__slack_send_message,mcp__claude_ai_Gmail` took the one Slack tool and Gmail's 31 out of `init`'s tool list (Slack 13 to 12); the server-level form `mcp__claude_ai_Gmail` works.
   - `--disallowed-tools 'mcp__claude_ai_*'` removed all 780 connector tools. Adding `--allowed-tools mcp__claude_ai_Slack__slack_search_public` brought nothing back (and `T3`, on the fake server, the same). **There's no catch-all deny with exceptions.** pitwall has to deny each server and tool by name.
   - `--tools SendMessage` does **not** hold MCP tools out: all 782 tools were in `init`. Only the deny rules do.
4. **Mid-turn tools and a model that tries a tool it shouldn't** (fake server only, W186's F6).
   - T1: `--allowed-tools mcp__fake__fake_read --disallowed-tools mcp__fake__fake_write`, a permission prompt tool `mcp__fakeprompt__approve` that logs and denies. The server announced `fake_late_write` with `notifications/tools/list_changed` 4 s in, during `fake_read`'s 8 s call. The model called it; **Claude Code asked the prompt tool, which denied it, and the tool's log shows it was never reached.** `fake_write` never reached `init`.
   - T2: the same with `mcp__fake__fake_late_write` also disallowed: the late tool was filtered the moment it arrived, and the model never tried it.
   - So three layers hold: the deny list (named tools, including late ones), the prompt tool (any tool on neither list: pitwall's `approve` already denies "anything else it would ask about", W115), and `supervisorInitTools` (stops a turn whose `init` lists a tool outside the set). A tool a **new** connector adds after pitwall's config was written is on neither list, so layer two holds it. Not tested for the real connectors by design: the same mechanism, since a claude.ai tool is an MCP tool by name.
5. **Cost of the unrestricted route.** An `A` run (connectors all on, `Reply with OK.`, Haiku) cost **$0.62**, because 782 tool definitions go into the prompt; with every connector but Slack and Notion denied by name, the 47 chosen read tools (the `readOnly` ones) and the other 43 of their tools disallowed, the same run cost **$0.011**, with only Slack and Notion connected and 48 tools listed. For an Opus supervisor on a long conversation the difference is a large share of every turn, so pitwall must deny every connector but the chosen.
6. **`mcp_status` gives each connector's tool names and annotations, with no model call.** Send `{"type":"control_request","request_id":"r1","request":{"subtype":"mcp_status"}}` on a stream-json session's stdin; `control_response` carries `response.mcpServers[]` with `name`, `status`, `serverInfo`, `config` (type `claudeai-proxy`, the service's real URL and a connector ID), `scope`, `source: "claudeai"` and `tools[]`.
   - **Each tool has only `name` and `annotations`:** `{readOnly, destructive, openWorld}`. No description and no `inputSchema`. W186's F1 check (a tool that takes a URL, by an input named like an address) can't run on this surface; see decision 3.
   - Slack: 13 tools, 8 `readOnly` (`slack_search_public`, `slack_search_public_and_private`, `slack_search_channels`, `slack_search_users`, `slack_read_channel`, `slack_read_thread`, `slack_read_canvas`, `slack_read_user_profile`); the five without it are the send, schedule, draft and canvas create/update tools. Notion: 77 tools, 39 `readOnly` (including `notion-search`, `notion-fetch`, `notion-get-users`, `notion-query-data-sources`, `notion-get-comments`, the `list-*` tools) and 16 with an empty annotation; the writes are unmarked or `destructive`.
   - The hint is the server's own claim (spike 016, finding 4: it preselects, you decide). Notion also lists agent-session tools (`notion-spawn-session`, `notion-send-message-to-session`, `notion-stop-session`), none `readOnly`.
   - A denied connector's tools still list here, so a probe can run with the connector denied at the tool level; a connector denied with `deniedMcpServers` is absent.
7. **Names.** The server name is `claude.ai <display name>` (`claude.ai Slack`, `claude.ai Notion`, `claude.ai Gmail`, `claude.ai Google Drive`, `claude.ai Customer.io`, `claude.ai Typefully - Social Media Scheduler`); the tool prefix is `mcp__` plus the name with each character outside `A-Za-z0-9_-` as `_` (`mcp__claude_ai_Customer_io__…`, `mcp__claude_ai_Typefully_-_Social_Media_Scheduler__…`). The display name comes from claude.ai and can change; a rename makes a deny list miss the connector, and the permission prompt tool then holds its tools out.
8. **Connectors load asynchronously.** The debug log says `claude.ai connectors running fully async (nonblocking)`: they were fetched about 0.5 s after start and connected over 1 to 3 s (Slack 13 tools by the fourth second). A stream-json run that sends its first message at once can see `init` without them. Four runs with the message at once had `mcp_servers: []`; with the input held for 4 s they were all there. In a supervisor that stays up this matters at the first turn only. `mcp_status` polled once a second showed Slack and Notion `pending`, then `connected` in the third second. With tool search on, a server that finishes connecting mid-turn has its tools listed on the next request in the same turn (Claude Code's MCP docs), so a late connector isn't lost, and a denied one isn't added.

## Commands

Scratch folder `$SCRATCH/cwd` (empty), `DELAY` = seconds stdin is held before the message. No secrets: the connector IDs in the debug log aren't recorded here.

```sh
# 1. which servers load without --strict-mcp-config (init event's mcp_servers and tools)
(sleep 4) | claude -p "Reply with OK." --model haiku --max-turns 1 --no-session-persistence \
  --output-format stream-json --verbose --tools SendMessage --permission-mode default \
  --setting-sources "" --settings '{"autoMemoryEnabled":false,"crossSessionInbound":"refuse"}'

# 2. deny one connector (not connected at all) / one tool / all (all tools gone, an allow doesn't help)
… --settings '{"autoMemoryEnabled":false,"deniedMcpServers":[{"serverName":"claude.ai Gmail"}]}'
… --disallowed-tools 'mcp__claude_ai_Gmail,mcp__claude_ai_Slack__slack_send_message'
… --disallowed-tools 'mcp__claude_ai_*' --allowed-tools mcp__claude_ai_Slack__slack_search_public

# 3. tool names and annotations, no turn, no tokens
(sleep 5; echo '{"type":"control_request","request_id":"r1","request":{"subtype":"mcp_status"}}'; sleep 6) | \
  claude -p --input-format stream-json --output-format stream-json --verbose --model haiku \
  --no-session-persistence --tools SendMessage --setting-sources "" \
  --settings '{"autoMemoryEnabled":false}' --disallowed-tools 'mcp__claude_ai_*'

# 4. the design's flags (Slack and Notion only; each denied server a deniedMcpServers entry)
… --settings "$(cat design.settings.json)" --allowed-tools "$(cat design.allow)" --disallowed-tools "$(cat design.dis)"

# 5. mid-turn and prompt-tool tests, on the fake server only
ENABLE_CLAUDEAI_MCP_SERVERS=false claude -p --input-format stream-json --output-format stream-json --verbose \
  --model haiku --tools SendMessage --permission-mode default --permission-prompt-tool mcp__fakeprompt__approve \
  --setting-sources "" --mcp-config cfg.json --allowed-tools mcp__fake__fake_read \
  --disallowed-tools mcp__fake__fake_write
```

`cfg.json` names two stdio entries running `node fake-mcp.mjs`, `fake` and (with `FAKE_ROLE=prompt`) `fakeprompt`; `FAKE_LOG` is a file each call is appended to.

## Recommended design for the build

**Route:** drop `--strict-mcp-config`, keep `--setting-sources ""`, and hold everything but the chosen connectors out with documented settings and flags. No `claudeai-proxy`, no second sign-in, no secret in pitwall's files.

1. **Command line** (`supervisorArgs`):
   - Remove `--strict-mcp-config`. `--mcp-config` stays (pitwall's server, and W184's `server`-kind connectors, still go there); with `--setting-sources ""` nothing of yours but the claude.ai connectors loads (finding 1).
   - `--settings` gains `deniedMcpServers`: `{ "serverName": "claude.ai <name>" }` for **every claude.ai connector on the account that isn't chosen**. A denied connector isn't connected and costs no tool definitions (findings 2 and 5).
   - `--allowed-tools` gains the chosen tools, `mcp__claude_ai_<Name>__<tool>`. `--disallowed-tools` gains every other tool of each chosen connector (the `readOnly` hint's complement, plus those you didn't tick). As today, each flag and its value are two arguments.
   - `supervisorInitTools` takes the chosen tool names; a tool in `init` outside the set still stops the turn.
2. **Config** (`~/.pitwall/config.json`, D24), in `supervisor.connectors` beside W184's entries, one new kind:

   ```jsonc
   "supervisor": { "connectors": {
     "slack":  { "claudeAi": "Slack",  "tools": ["slack_search_public", "slack_read_channel", "slack_read_thread", "slack_search_users", "slack_read_user_profile"] },
     "notion": { "claudeAi": "Notion", "tools": ["notion-search", "notion-fetch", "notion-get-users"] }
   } }
   ```

   - `claudeAi` is the display name after `claude.ai `; pitwall derives the server name (`claude.ai Slack`) and the prefix (`mcp__claude_ai_Slack__`). It takes no `server`, no header, no `env`, no `oauth`: the sign-in is Claude Code's, from claude.ai. `tools` is the list you chose, as for the other kinds (D28).
   - A `claudeAi` entry, with `--no-connectors`, is off as the others are.
3. **`--connector-tools <name>`** for a `claudeAi` entry: start `claude -p --input-format stream-json --output-format stream-json --verbose --tools "" --setting-sources "" --disallowed-tools 'mcp__claude_ai_*'` with no model turn, poll `mcp_status` once a second until the connector is `connected` (about 3 s; give up after 15 s), print its tools with `[read-only]` from `annotations.readOnly` and `[no hint]` where there is none, then exit. Zero tokens (finding 6). Also print every other connector name on the account, which is how pitwall learns what to deny: save that list (names only) to `$PITWALL_HOME` and refresh it each time `--connector-tools` runs and when the supervisor starts (below).
4. **Everything else stays out, in layers:**
   - Servers: `deniedMcpServers` for each known unchosen claude.ai connector (not connected); no user, plugin or project servers (`--setting-sources ""`).
   - Tools: `--disallowed-tools` for the chosen servers' unticked tools, mid-turn ones included (T2).
   - Anything on neither list, such as a connector added to claude.ai after the list was saved, or a renamed one: `approve` denies it (T1), and an `init` that lists it stops the turn. After the supervisor starts, pitwall sends `mcp_status` once the connectors are in (finding 8), and compares the connected server names with pitwall's, the chosen and the denied; an unknown one is shown on the panel as "a new connector, held out; run `pitwall --connector-tools` to review", and pitwall refreshes its saved list for the next start. Don't use `mcp_toggle` (it writes `~/.claude.json`, finding 2).
5. **Fails soft:**
   - Not signed in to claude.ai (an API key or provider login, where Claude Code doesn't fetch connectors, per its docs), no such connector, or `needs-auth` / `failed` at `mcp_status`: the supervisor runs without it and the panel says why (`mcp_servers` status). Never start a sign-in.
   - A chosen tool that the connector no longer lists: ignored, listed in the panel's connector note.
   - The connectors not connected by the first message (finding 8): the first turn may lack them; the panel shows the connector as "connecting".
   - `mcp_status` unavailable or unparseable on a future version: pitwall runs the supervisor with the denies it has and the prompt tool as the backstop, and shows "connector list unavailable".
6. **The pitch for the prompt** (`SUPERVISOR_PROMPT_VERSION` +1): the names are `mcp__claude_ai_<Name>__<tool>` now, not `mcp__<connector>__<tool>`.

**Fragility:** the display name (a rename leaves a connector undenied until the list refreshes; the backstop is `approve` and the `init` check); `mcp_status` and `mcp_toggle` are SDK control requests whose shape is documented in the Agent SDK, not in the CLI reference, so wrap `mcp_status` in the adapter module (AGENTS.md's rule) and fail soft; `deniedMcpServers` in `--settings` is documented; `allowedMcpServers` isn't a route (finding 2).

## Needs Phil

1. **Is "the supervisor starts with all your claude.ai connectors visible, and pitwall denies all but the ones you chose" acceptable?** There is no allow-only route (finding 2), so a connector you add on claude.ai tomorrow is connected and its tools are defined until pitwall's list catches up, held out only by `approve` and the `init` check. Recommended: yes, with the start-time `mcp_status` check and a panel note, since the prompt tool denial was measured to hold.
2. **Should Slack's `slack_search_public_and_private` (a `readOnly` hint; reads private channels and DMs) be preselected?** Your 2026-11-12 line was "read whatever permissions the Claude session has unless there's a reason to override". Recommended: preselect every `readOnly` tool, and you untick, as D28 says a hint preselects and decides nothing.
3. **W186's F1 accepted risk rests on "no tool that fetches any URL"; the claude.ai surface gives pitwall no schema or description to check it** (finding 6). Notion's `notion-fetch` and the attachment-download tools take URLs or IDs. Recommended: mark by name (`fetch`, `download`, `url`, `link`) as `[may take a URL]` and don't preselect them; you tick them knowingly; and keep the panel's argument display (W192's G2).
