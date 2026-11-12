# Spike 017: how Slack and Notion get their credentials under the supervisor's strict command line

Run on 2026-11-11 against Claude Code 2.1.322 on macOS, for W185 (Slack, Notion and Gmail with real accounts), for **Slack and Notion only**: Phil's OK on 2026-11-11 was "Slack and Notion first, Gmail later". Gmail wasn't touched. It answers D28's open point (the supervisor reads through connectors you choose, read-only): how a connector gets its credentials when the supervisor runs with `--setting-sources ""` and `--strict-mcp-config`, which of its tools read, and what a minimal read-only setup looks like.

**No Slack or Notion data was read.** No route was signed in to, so no call reached either service past its "authentication required" answer, and nothing was posted, edited or created. The spike stops where a route needs Phil to sign in or make a token, and the [Needs Phil](#needs-phil) section says exactly what he would run and what it grants. No token was made, printed or written anywhere.

**Correction (2026-11-12): finding 2 didn't reproduce.** From a folder outside pitwall, `claude mcp list` on the same machine showed claude.ai Slack, Notion and Gmail connected, with no policy message. Inside pitwall's checkout they're absent, because pitwall's `.claude/settings.json` sets `disableClaudeAiConnectors`. Where the spike's "blocked by the organization's managed policy" came from wasn't found. W191 (the supervisor reads through the connectors your sessions already have) follows from this.

Each run was `claude -p "Reply with OK." --model haiku --max-turns 1 --no-session-persistence --output-format stream-json --verbose --tools "" --setting-sources "" --strict-mcp-config --mcp-config <file> --permission-mode default`, as spike 016 (read-only connectors under the strict command line) ran, and the result is the `system/init` message's `mcp_servers` and tool list, plus `--debug-file` where it says so. About 12 runs on Haiku, a few cents in all. The credential runs used a throwaway server, [`017-connector-credentials/probe-mcp.mjs`](017-connector-credentials/probe-mcp.mjs), on loopback or stdio, with a made-up value; it logs only whether the value arrived, and the names of the environment variables it was given.

## Questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Can the supervisor use Claude Code's own claude.ai connectors (claude.ai Slack, claude.ai Notion)? | **No.** `--strict-mcp-config` leaves them out (finding 1), and a managed policy on the author's machine blocks them anyway (finding 2). |
| 2 | Can it reach Slack's and Notion's own hosted MCP servers from an `--mcp-config` entry? | **Yes, up to sign-in.** Both load under the strict flags with status `needs-auth`; the policy doesn't hide them (finding 3). That they load is not permission; the policy owner decides (Needs Phil, step 1). |
| 3 | Where would their OAuth sign-in live? | **In Claude Code's own credential store,** keyed by the server's name and its type, URL and headers; a `-p` run looks it up there (finding 4). Pitwall would hold no secret. |
| 4 | Can a header or a stdio server's environment take a token from a variable, under `--mcp-config`? | **Yes.** `${VAR}` expands in both, from Claude Code's environment; `SLACK_USER_TOKEN` and `NOTION_TOKEN` aren't on Claude Code's list of names it blanks (finding 5). |
| 5 | Does a stdio connector get only the variables its entry names? | **No.** It inherits Claude Code's whole environment, the cross-session messaging socket and token included (finding 6). |
| 6 | Can Slack's grant be read-only at the source? | **Yes, by the scopes asked for:** an `oauth.scopes` entry narrows what Claude Code requests (finding 7). Notion's hosted server has no scopes (finding 8). |
| 7 | Which tools read? | Slack and Notion document their tools by group; the exact names come from `tools/list` after sign-in (finding 9). |

## Results

| Run | `--mcp-config` entry | `mcp_servers` in `system/init` | MCP tools listed |
| --- | --- | --- | --- |
| empty | `{}` | none (debug: 18 claude.ai connectors fetched, none loaded) | none |
| notion | `{"type":"http","url":"https://mcp.notion.com/mcp"}` | `notion`, `needs-auth` | none |
| slack | `{"type":"http","url":"https://mcp.slack.com/mcp","oauth":{"clientId":"1601185624273.8899143856786","callbackPort":3118}}` | `slack`, `needs-auth` | none |
| slack, read scopes | the same, plus `"scopes":"search:read.public channels:history channels:read users:read"` | `needs-auth` | none |
| header from `${PROBE_SRC}` | loopback HTTP, `"Authorization":"Bearer ${PROBE_SRC}"` | `connected`; the server saw the expected value | `probe_read` |
| header from `${SLACK_USER_TOKEN}` | the same | `connected`; expected value | `probe_read` |
| header from `${NOTION_TOKEN}` | the same | `connected`; expected value | `probe_read` |
| literal header | `"Authorization":"Bearer <made-up>"` | `connected`; expected value | `probe_read` |
| stdio, env from `${PROBE_SRC}` | `"env":{"PROBE_TOKEN":"${PROBE_SRC}", …}` | `connected`; expected value; the child had Claude Code's whole environment | `probe_read` |
| stdio behind `/usr/bin/env -i` | `"command":"/usr/bin/env","args":["-i","PATH=/usr/bin:/bin","PROBE_TOKEN=${PROBE_SRC}", …, node, probe-mcp.mjs]` | `connected`; expected value; the child had only the named variables | `probe_read` |

The header and stdio runs started `claude` under `env -i` with `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `PATH`, a marker variable and the made-up values, so the stdio child's variables could only have come from that environment or from Claude Code.

## Findings

1. **The claude.ai connectors aren't a route under the strict command line.**
   - With `--strict-mcp-config` and an empty `--mcp-config`, `system/init` listed no MCP server, although the debug log shows Claude Code still fetched the account's 18 claude.ai connectors from `api.anthropic.com`. Claude Code's MCP docs say the same: with `--strict-mcp-config`, "Claude Code then uses only the MCP servers you pass with `--mcp-config`".
   - Claude Code does have a connector entry type, `claudeai-proxy`, that a host can pass in `--mcp-config` (the cloud sessions use it). It's internal: `claude mcp add` refuses it ("is used only by claude.ai connectors and cannot be declared"), the settings schema mentions it only under `disableClaudeAiConnectors`, and the docs don't describe it for users. AGENTS.md's rule is documented interfaces first, and on the author's machine it would also be the way around the policy in finding 2, so it wasn't tried.
   - Pitwall's own `.claude/settings.json` sets `disableClaudeAiConnectors`, but the supervisor runs with `--setting-sources ""`, so that setting isn't what keeps them out; `--strict-mcp-config` is. The setting's schema text in the binary says `true` also stops a `claudeai-proxy` server passed in `--mcp-config`, but Claude Code's MCP docs say servers passed with `--mcp-config` are unaffected by it. The two disagree, and the spike didn't test which holds.
2. **The block on the author's machine is on the claude.ai connectors, not on the services.** A managed policy there blocks the claude.ai Slack and Notion connectors ("blocked by the organization's managed policy"). There's no `managed-settings.json` or `managed-mcp.json` under `/Library/Application Support/ClaudeCode/`, so the policy arrives another way; the spike didn't look further. What matters here is that Claude Code hides a server a denylist or allowlist blocks (Claude Code's managed MCP docs: "A previously configured server is now blocked by policy: the server disappears from `/mcp` and `claude mcp list`"), and both lists also filter `--mcp-config` servers, `--strict-mcp-config` or not. Slack's and Notion's own URLs weren't hidden (finding 3), so the policy as it stands doesn't deny them by URL. **Whether it's meant to is a question for whoever set it, not something this spike can read** (Needs Phil, step 1). The policy can also change under the supervisor: a later managed allowlist that leaves these URLs out would drop the connectors without a word (they'd be missing from `mcp_servers`), and a `managed-mcp.json` would make Claude Code refuse to start with `--strict-mcp-config` at all. W184 (the supervisor's connectors) should fail soft in both: a missing connector shows as unavailable, and a refused start says why and can run without connectors.
3. **Slack's and Notion's hosted servers load under the strict flags and stop at sign-in.**
   - Notion: `https://mcp.notion.com/mcp`, OAuth 2.0 with PKCE and dynamic client registration, so no client ID is needed. Claude Code defers registering a client until someone signs in (debug: "client registration is deferred until the user authenticates").
   - Slack: `https://mcp.slack.com/mcp` doesn't support dynamic registration, so the entry needs a client ID. `1601185624273.8899143856786` is the published client ID of Slack's own Claude Code plugin, as Slack's "connect to harnesses" page gives it; `callbackPort` 3118 matches its redirect URI. It needs no client secret (PKCE) but does need the workspace admin's approval. Using it from another host, such as pitwall's supervisor, is this spike's inference; Slack doesn't document it. Slack's docs say an MCP client must be a Marketplace-listed or internal app **approved by the workspace admin**.
   - In `-p`, neither opened a browser or offered a sign-in tool to the model; the server stayed `needs-auth` with no tools, and the turn ran normally. So a supervisor whose connector isn't signed in runs without it, and `mcp_servers` says why.
   - **A side effect:** each `needs-auth` connect wrote OAuth discovery state to Claude Code's credential store (debug: "Saving discovery state"; for Slack also a PKCE code verifier for the URL it built). No token, and nothing granted, but it's a write to the keychain on every supervisor start while a connector isn't signed in, so W184 should skip a connector that isn't signed in rather than start it each time. Where it went: the reviewer found one generic-password item in the login keychain, service `Claude Code-credentials`, account `leggetter`. That `notion`, `slack` and `pitwall-test-slack` are keys inside that item's JSON is an inference from the debug log, not checked. **Don't delete that item: it holds Claude Code's own login.** The entries are discovery metadata and an unused PKCE verifier, harmless, and can stay. To clear one anyway, the supported way is probably (unverified) an interactive `claude --setting-sources "" --strict-mcp-config --mcp-config <file>` with the same entry, then `/mcp`, the server, and clear its authentication.
4. **An OAuth sign-in is Claude Code's, keyed by name and endpoint, so pitwall never holds the token.**
   - Claude Code's docs: tokens "are stored securely and refreshed automatically", and it "stores OAuth sign-ins per endpoint, so when you authenticate the definition that loads in one project, you still need to sign in separately in a project where a different definition loads".
   - The 2.1.322 binary keys a sign-in as `<server name>|<first 16 hex of sha256 of {type, url, headers}>`. The `oauth` block (client ID, scopes, callback port) isn't part of the key. This is internal and can change; the documented part is "per endpoint", and W184 should treat the key as an implementation detail it verifies, not a contract.
   - So pitwall's entry must keep **the same server name, type, URL and no headers** as the entry Phil signed in with, and sign-in can be done once in an interactive session started with that same `--mcp-config` file (Needs Phil, steps 2 and 3). The `-p` debug log shows the lookup ("No token data found"), so a supervisor run reads the store; that it then **finds** a token made in an interactive session is the one thing left to check after Phil signs in.
5. **`${VAR}` expands in `--mcp-config` entries.** In an HTTP entry's `headers` and a stdio entry's `env` (and `args`), a `${NAME}` became the value from Claude Code's own environment. Claude Code's docs say it blanks a set of credential names (`ANTHROPIC_API_KEY`, cloud provider keys, `NPM_TOKEN` and others) in a remote server's `url` and `headers`; `SLACK_USER_TOKEN` and `NOTION_TOKEN` aren't in it, since both expanded in a header. The docs describe the blanking only for `url` and `headers`; whether it applies to a stdio entry's `env` is untested here. A literal value works too, which is how pitwall already gives the supervisor its own token (the 0600 `--mcp-config` file).
6. **A stdio connector inherits Claude Code's whole environment, including its messaging socket and token.** The probe child under the supervisor's flags had every variable `claude` was started with (the marker and the made-up source value included), plus `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE` and `CLAUDE_PROJECT_DIR` that Claude Code adds. Two consequences for D28:
   - D28's "a stdio connector gets only the variables its entry names" doesn't happen by itself. With `/usr/bin/env -i` as the command the child got only `PATH` and the named variables (and macOS's `__CF_USER_TEXT_ENCODING`). But `env -i NAME=value` puts the value in the child's arguments, which `ps` shows; W184 needs a wrapper that keeps only the named variables from its own environment, or no stdio connectors.
   - The messaging token is the supervisor's way to reach other sessions. A stdio connector holding it could, untested, message a session without a card or your click, which D4 (the supervisor: read-only tools, acts only after your click) and D28 rule out. That's for W186 (the security review of the connectors) to test, and a reason to strip it in the wrapper.
   - The same inheritance means any secret in Claude Code's environment reaches every stdio connector. A header's value is better written literally into the 0600 `--mcp-config` file than passed as a variable.
7. **Slack can be read-only at the grant.** By default Claude Code asked Slack for every scope its metadata lists, writes included (`chat:write`, `canvases:write`, `files:write`, `reactions:write`, `lists:write`, `channels:write` and the other `*:write` scopes). With `"oauth": {"scopes": "search:read.public channels:history channels:read users:read"}` the authorisation URL it built asked for exactly those four. A token with no write scope can't post even if a write tool were reached, so this is a layer under spike 016's `--allowed-tools` and `--disallowed-tools`. Whether Slack's app grants a subset as asked is confirmed at sign-in.
8. **Notion's hosted server has no read-only grant.** Its OAuth asks for no Notion scopes, so a sign-in has everything you can do in the workspace, writes included; read-only rests on pitwall's tool choice alone (spike 016). Notion's FAQ says a workspace admin "may limit the tools in a workspace-owned connection", and `notion-get-tool-access` reports what a connection may use. The alternative with a read-only credential is the local `@notionhq/notion-mcp-server` (2.6.1) with an internal integration token given only "Read content", which also sees only the pages shared with the integration. Its README says it is "no longer actively maintained or supported" and points to the hosted server, so it's a fallback, not the recommendation. Notion's access tokens last about eight hours and are refreshed by Claude Code; a grant ends 180 days after sign-in, or after 30 days unused, and then needs signing in again.
9. **The read tools, as documented; the names come from `tools/list` after sign-in.**
   - **Slack** (docs.slack.dev, Slack MCP server overview). Read: search messages and files, users, channels, the channels you're in, emoji; read a channel's history and a thread; get reactions; read a canvas; read a user's profile; list a channel's members; read files; read lists. Write: send, schedule and draft messages, create conversations, add reactions, create and update canvases, upload files, create and update lists. Third-party listings name `slack_search_public` and `slack_read_channel` among the reads and `slack_send_message` and `slack_send_message_draft` among the writes; not confirmed here.
   - **Notion** (developers.notion.com). Read: `notion-search`, `notion-fetch`, `notion-get-users`, `notion-get-self`, `notion-get-tool-access`, plus search across connected sources. Everything that creates, updates, moves, duplicates, comments or deletes is a write; comments count as writes.
   - The minimal read-only sets below are what W184's tool choice should preselect; Phil still ticks them (D28: a hint preselects, decides nothing).

## Proposal for D28's open point (for Phil)

How a connector gets its credentials, in order of preference:

1. **An HTTP connector signed in through Claude Code's own OAuth.** The config entry is a name, a URL and, for Slack, `oauth.clientId`, `oauth.callbackPort` and `oauth.scopes`; no header, no secret in pitwall's config or files. You sign in once in an interactive Claude Code session started with the same entry; the supervisor's `-p` runs use the stored sign-in, and Claude Code refreshes it. Pitwall shows a connector whose `mcp_servers` status is `needs-auth` as "needs sign-in", with the command. This is the route for Slack and Notion, subject to the managed policy owner agreeing (spike 017, Needs Phil step 1).
2. **An HTTP connector with a header from a variable you name,** for a service that issues a token instead (D28's config already allows it). Pitwall reads the variable from its own environment at launch and writes the value into the 0600 `--mcp-config` file, as it does its own token, rather than into Claude Code's environment, where every stdio connector would inherit it (finding 6).
3. **A stdio connector, only behind a wrapper** that starts the server with nothing but `PATH` and the variables its entry names, values passed in the environment, never in the arguments. Without one, it gets the supervisor's messaging token. If W184 can't build the wrapper, stdio connectors wait.

Minimal read-only setup:

| | Slack | Notion |
| --- | --- | --- |
| Entry | `{"type":"http","url":"https://mcp.slack.com/mcp","oauth":{"clientId":"1601185624273.8899143856786","callbackPort":3118,"scopes":"search:read.public channels:history channels:read users:read"}}` | `{"type":"http","url":"https://mcp.notion.com/mcp"}` |
| Read-only at the grant | Yes, by the scopes: public channels only, no write scope. Add `groups:history`, `search:read.private` and the `im`/`mpim` reads only if the supervisor should see private channels and DMs | No; by pitwall's tool choice only |
| Tools to allow | the search, read-channel, read-thread, user and channel-list tools, by their `tools/list` names | `notion-search`, `notion-fetch`, `notion-get-users`, `notion-get-self` |
| Who must agree | Slack workspace admin approves the app | none beyond you, unless a Notion admin limits MCP |
| Re-sign-in | when Slack revokes it | at most every 180 days |

What changes in D28 if Phil agrees: "Not decided yet: how a connector gets its credentials" becomes the three routes above, the Environment bullet gains the wrapper, and the claude.ai connectors are out of scope.

## Needs Phil

Nothing here has been done. Each step says what it grants. The sign-in sessions below run with `--setting-sources ""`, so they don't load your usual settings and hooks; without it, an interactive session loads them as any other would.

1. **Check the policy's intent.** The claude.ai Slack and Notion connectors are blocked by a managed policy on the author's machine, and the direct servers aren't (finding 2). Before signing in to either, confirm with whoever administers that policy that a direct Slack or Notion MCP server is acceptable. If it isn't, stop here: the answer is "not on this machine".
2. **Notion: sign in once.** It grants Claude Code, acting as you, read and write access to everything you can see in the Notion workspace you pick; pitwall's supervisor would only ever be given the read tools.
   ```
   mkdir -p ~/pitwall-connector-signin && cd ~/pitwall-connector-signin
   printf '%s\n' '{"mcpServers":{"notion":{"type":"http","url":"https://mcp.notion.com/mcp"}}}' > notion.json
   claude --setting-sources "" --strict-mcp-config --mcp-config notion.json
   ```
   In the session, run `/mcp`, choose `notion`, then Authenticate, and approve in the browser; then `/exit`. You can revoke it from Notion's settings.
3. **Slack: sign in once, with read scopes only,** after the workspace admin has approved the Slack MCP app. It grants a Slack user token, acting as you, that can search and read public channels, list channels and read user profiles, and nothing else.
   ```
   cd ~/pitwall-connector-signin
   printf '%s\n' '{"mcpServers":{"slack":{"type":"http","url":"https://mcp.slack.com/mcp","oauth":{"clientId":"1601185624273.8899143856786","callbackPort":3118,"scopes":"search:read.public channels:history channels:read users:read"}}}}' > slack.json
   claude --setting-sources "" --strict-mcp-config --mcp-config slack.json
   ```
   In the session, `/mcp`, `slack`, Authenticate, approve; then `/exit`. Port 3118 must be free. You or the workspace admin can revoke it in Slack.
4. **Then, without Phil:** rerun the probe below with each file. A pass is `status: connected`, its tool names recorded (names only), and one smallest read (one search with a made-up term, its result count only). That confirms finding 4's lookup, finding 7's scopes, and the read tools' names for W184's preselection.

## What the spike didn't answer

- **That a `-p` run finds a token made interactively,** and that Slack grants the narrowed scopes: both need step 2 or 3.
- **The exact tool names and their annotations** for both services: `tools/list` needs a sign-in.
- **Whether a stdio connector can use the inherited messaging token** to reach a session: W186.
- **Whether Slack's server takes a user token from your own Slack app as a `Bearer` header** (route 2 for Slack): its docs show a client sending a user token, but not one from a token you paste. Not needed if route 1 works.
- **Gmail:** not touched (Phil, 2026-11-11). Claude Code's docs say Gmail is one of the Anthropic-hosted connectors that "don't support local OAuth from Claude Code because the upstream identity provider only accepts the redirect URL that claude.ai registered", so route 1 likely doesn't apply to it; W185's Gmail half needs its own look.

## Rerunning it

```
cd scratch/<dir>    # in the worktree; scratch/ is gitignored
NODE=$(node -p process.execPath); P=<repo>/docs/spikes/017-connector-credentials/probe-mcp.mjs
# HTTP header from a variable: start the probe, then point an entry at it
PROBE_EXPECT=made-up-value PROBE_LOG=$PWD/probe.log $NODE $P http 47185 &
printf '%s\n' '{"mcpServers":{"probe":{"type":"http","url":"http://127.0.0.1:47185/mcp","headers":{"Authorization":"Bearer ${PROBE_SRC}"}}}}' > h.json
timeout 90 env -i HOME="$HOME" USER="$USER" TMPDIR="$TMPDIR" PATH="/usr/bin:/bin:$HOME/.local/bin" PROBE_SRC=made-up-value \
  claude -p "Reply with OK." --model haiku --max-turns 1 --no-session-persistence --output-format stream-json --verbose \
  --tools "" --setting-sources "" --strict-mcp-config --mcp-config h.json --permission-mode default > out.jsonl
grep -o '"mcp_servers":\[[^]]*\]' out.jsonl; cat probe.log
# stdio: "command": "$NODE", "args": ["$P"], "env": {"PROBE_TOKEN": "${PROBE_SRC}", "PROBE_EXPECT": "made-up-value", "PROBE_LOG": "<file>"}
# Slack or Notion: the entries in the Results table; add --debug-file debug.log to see the scopes in the authorisation URL
```

An asdf or other shim as `command` fails under `env -i`; use the real binary (`node -p process.execPath`).
