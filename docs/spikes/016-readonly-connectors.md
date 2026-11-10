# Spike 016: read-only connectors for the supervisor, under `--strict-mcp-config`

Run on 2026-11-10 against Claude Code 2.1.322 on macOS, for W183 (D28: the supervisor can read through connectors you choose). It answers one question first: with the supervisor's strict command line (`--tools ""`, `--setting-sources ""`, `--strict-mcp-config`, `--permission-mode default`), can pitwall add one more MCP server and let the model call only the tools it names as read-only?

Nothing here touched a real service or a real session. The server is a throwaway of about 20 lines, [`016-readonly-connectors/fake-mcp.mjs`](016-readonly-connectors/fake-mcp.mjs): `fake_search` (read) and `fake_post` (write, which appends to a log file so a run shows whether it was ever called). [`summarize.mjs`](016-readonly-connectors/summarize.mjs) prints what a run's `stream-json` shows. Each run was `claude -p … --model haiku --max-turns 4 --no-session-persistence --output-format stream-json --verbose --tools "" --setting-sources "" --strict-mcp-config --mcp-config <file> --permission-mode default`, with the flags in the table.

## Results

| # | Flags added | What the init message listed | What the model did | Did `fake_post` run? |
| --- | --- | --- | --- | --- |
| A | `--allowed-tools mcp__fake__fake_search`, prompt asks for search then post | both tools; server `connected` | called `fake_search` (twice), never tried `fake_post` | no |
| A2 | the same, prompt orders a `fake_post` call first | both tools | called `fake_post`; Claude Code answered "requested permissions … but you haven't granted it yet" (an error result) | no |
| B | A2 plus `--disallowed-tools mcp__fake__fake_post` | `fake_search` only | called `fake_post` anyway; Claude Code answered "No such tool available" | no |

## Findings

1. **A stdio MCP server loads under the strict command line.** `--strict-mcp-config --mcp-config <file>` with a second server entry connected (`status: connected`), alongside nothing else. Nothing from the user's own MCP setup came with it.
2. **`--allowed-tools` is an allowlist for running, not for seeing.** In A the unlisted write tool was still in the model's tool list. In `-p` mode with no prompt tool, calling it was refused (A2). In the supervisor, whose `--permission-prompt-tool` is pitwall's `approve`, the same call would reach `approve`, which denies anything it wasn't built to show a card for (D4), so the result is the same. Two layers, not one.
3. **`--disallowed-tools` takes the tool out of the model's list.** In B it was missing from `system/init`, and a forced call failed with "No such tool available". That is the better second layer, because the model never plans with a tool it can't use. The flag takes the full `mcp__<server>__<tool>` name; the value after an unquoted `--disallowed-tools` must be one argument (a shell that splits it makes Claude Code print `unknown option`).
4. **Tool hints are not trusted.** `fake_search` carries `readOnlyHint: true`, and `fake_post` doesn't. Claude Code did not treat the hint as permission in any run, and pitwall shouldn't either: a server's hints are its own claim. Use them only to preselect, never to decide.
5. **The allowlist has to come from pitwall's own record of the server's tools,** since a server can add a tool tomorrow. So: ask the server for `tools/list` when you set the connector up, show the tools, keep the ones you ticked as read-only, and at launch allow exactly those and disallow every other tool seen. A tool that appears later is covered by finding 2.

## What the spike didn't answer

- **Credentials and OAuth.** The throwaway needs none. Slack, Notion and Gmail do, and Claude Code's own connectors (the ones `disableClaudeAiConnectors` turns off) keep their OAuth in Claude Code, which `--strict-mcp-config` leaves out. Whether a connector can be used under the strict command line, or whether pitwall has to be given a server entry (a command with a token in its environment, or an HTTP URL with a header), needs a real account. That is W185, and it needs Phil's OK for each service.
- **How large a result may be** and what to do with an oversized one. W184 decides, with `MAX_MCP_OUTPUT_TOKENS` in mind.
- **Prompt injection from a real channel.** The fake data can't carry it. W186 (the security review) tests with planted instructions in a fake result.

## Rerunning it

```
cd docs/spikes/016-readonly-connectors
# write an mcp.json with one stdio server, "command": "node", "args": ["<this folder>/fake-mcp.mjs"], "env": {"FAKE_LOG": "<a file>"}
claude -p "Call mcp__fake__fake_post with text 'hello' right now." --model haiku --max-turns 4 --no-session-persistence \
  --output-format stream-json --verbose --tools "" --setting-sources "" --strict-mcp-config --mcp-config mcp.json \
  --permission-mode default --allowed-tools mcp__fake__fake_search --disallowed-tools mcp__fake__fake_post > out.jsonl
node summarize.mjs out.jsonl
```
