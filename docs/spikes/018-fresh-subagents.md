# Spike 018: can the pitwall plugin stop a session reusing a big finished sub-agent? (W197)

Run on 2026-11-17 against Claude Code 2.1.326 on macOS (the plan's findings were on 2.1.322), for W197 (fresh sub-agents: a plugin hook that refuses a message to a big, finished sub-agent and tells the session to start a fresh one). It answers five questions; it doesn't build the feature.

The probe was a throwaway plugin, [`018-fresh-subagents/plugin/`](018-fresh-subagents/plugin/): one script, `hooks/log.mjs`, registered for `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop` and `SubagentStop`. It logs each hook input, can deny a `SendMessage` (by JSON or by exit 2, chosen from a file), probes the target sub-agent's state and size, and adds `additionalContext` inside sub-agents. Sessions were `claude -p` on Haiku 5.5 (`claude-haiku-5-5`) with `--plugin-dir`, tiny prompts and `--max-turns` of 14 to 24 (five runs, named `pitwall-test-018-a` to `-e`), plus one `claude --bg` session. The sub-agents were `general-purpose` ones started with `run_in_background`. No real session was touched, and nothing here needed a large context (the size is read off the transcript, not grown).

## Questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Can a plugin's `PreToolUse` hook match `SendMessage`, and does the model see the deny reason? | Yes, both. The input has `tool_input.to` and `recipient_kind`. A JSON deny reaches the model as an error `tool_result` with exactly the reason (finding 1) |
| 2 | Can the hook tell a sub-agent's state, and does `SendMessage` to a finished one resume it? | Yes to both. The sub-agent's `meta.json` has `"finished": true` once it has finished and loses the key when resumed; the task notifications in the transcript stay `completed` after a resume (findings 2 and 3) |
| 3 | Is the usage on a sub-agent's latest reply its context size? | Yes: input + cache creation + cache read was 57,213, then 57,266 on the resumed agent's next reply, up by the 53 tokens the new turn added (finding 4) |
| 4 | Can sessions pitwall starts load the plugin without a global install? | Yes: `--plugin-dir <folder>` works for `claude --bg` and `claude -p`, also with `--setting-sources ""`, and the `SessionStart` hook runs. `--settings` with a marketplace also works but writes to `~/.claude/plugins/known_marketplaces.json` (finding 5) |
| 5 | Does a hook fire inside a sub-agent, name it, and add text it sees? | `PreToolUse` and `PostToolUse` do, with `agent_id` and `agent_type`; `additionalContext` reached the sub-agent. `Stop` doesn't fire for it, `SubagentStop` does (finding 6) |

## Findings

1. **A `PreToolUse` hook matches `SendMessage`, and a JSON deny shows the model the reason.**
   - Input keys: `cwd`, `effort`, `hook_event_name`, `permission_mode`, `prompt_id`, `session_id`, `tool_input`, `tool_name`, `tool_use_id`, `transcript_path`. `tool_input` held `to`, `summary`, `message`, `type`, `recipient`, `recipient_kind` and `content`.
   - **The target:** to a sub-agent, `to` was the agent id (`a65f915610a93f47e`) and `recipient_kind` was `"agent"`. In run `a` the model said the Agent tool had no name for the agent, so it addressed it by id. To another session by its name, `to` was `pitwall-test-018-bg1` and `recipient_kind` was `"name"`. I didn't send to a `uds:` address, so its `recipient_kind` isn't seen; W197 should act only on a `to` that is an agent id with a file in `subagents/`, and leave every other target alone.
   - **JSON deny** (`hookSpecificOutput.permissionDecision: "deny"` with `permissionDecisionReason`): the model's `tool_result` was `is_error: true` with the content `SPIKE018 DENY-JSON: start a fresh Agent for new work.`, nothing added. The sub-agent wasn't resumed: one `SubagentStop`, not two.
   - **Exit 2** with the reason on stderr: also `is_error: true`, and the model sees `PreToolUse:SendMessage hook error: [node <path to the script>]: <stderr>` then `This hook comes from the p018@inline plugin.` It works, but it shows the script's path to the model, so use JSON.
   - A matcher of `.*` matched every tool; W197's can be `SendMessage`.
2. **`SendMessage` to a finished sub-agent resumes it.** The result was `{"success":true,"message":"Resuming agent a65f915","resumedAgentId":"a65f915610a93f47e","revivedAgentId":"a65f915610a93f47e",...}`, the same `subagents/agent-<id>.jsonl` kept growing (15 lines to 38 in run `c`), a second `SubagentStop` fired for the same id, and the session got a second `<task-notification>` for it. To a running one: `Message queued for delivery to <id> at its next tool round. If it finishes first, it is resumed with the message...`. So a refusal has to be on the finished case only, and a message to a running agent that finishes first still resumes it; that's a small race, left allowed.
3. **State: `meta.json`'s `finished` is the direct signal; the task notifications are stale after a resume.**
   - `subagents/agent-<id>.meta.json` had no `finished` key while the agent ran (probe in run `c` at the first message) and `"finished": true` once it had finished (second probe, and the final file). After a resume (run `e`, probed 3 s after the `SendMessage` returned), the key was gone again. So `finished === true` means finished and not resumed since; a missing key means running or unknown, which the rule allows.
   - The session transcript's `<task-notification>` for the agent says `<status>completed</status>` and stays so after the resume until the next one arrives (`subagents.ts` handles this with its "transcript more than 10 s newer than the end" rule). A hook that reads only notifications would call a resumed, running agent finished. Use the meta key first, and the notifications with that rule only as a fallback.
   - `finished` is an undocumented field of an internal file, seen on one version; the hook must fail soft on its absence (it already does, since absent means allow).
4. **A sub-agent's size is the usage on its latest `assistant` entry in `subagents/agent-<id>.jsonl`.**
   - Run `a`: the first reply had `input_tokens` 2, `cache_creation_input_tokens` 57,211, `cache_read_input_tokens` 0 (57,213 in all); the reply after the resume had 4 + 31,229 + 26,033 = 57,266. The difference is 53, which is the first reply's 12 output tokens plus the new message and framing, so the sum is the context the call sent, as in W133's rule for the main session.
   - A sub-agent starts at about 57K here (Phil's setup: plugins, skills, system prompt), so 200K is about 143K of work. The same assistant message appears on two lines (one per content block) with the same usage; the last one is fine.
   - While an agent runs, the latest reply is the last finished call, a step behind, as at `Stop` (spike 012). That's fine for a warning and for refusing on a finished agent, whose last reply is final.
   - I didn't grow a real 200K context. The logic is the probe's: `ctx` was computed per target at each `SendMessage` (57,190 to 68,183 in these runs); the threshold is a number compared to it, which a test can lower.
5. **Plugin loading for sessions pitwall starts.**
   - **`--plugin-dir <folder>`** worked for `claude --bg` (`SessionStart` ran with `source: "startup"`, then `Stop`), for `claude -p`, and for `claude -p --setting-sources ""` (pitwall's own calls' flags). It needs no install and no change to settings, and it creates an empty `~/.claude/plugins/data/<name>-inline/` (as in spike 015). `claude --bg` also needs the folder to be trusted, which is unrelated to the plugin: from an untrusted folder it stopped with "Workspace not trusted".
   - **`--settings <file>`** with `extraKnownMarketplaces` (a `directory` source) and `enabledPlugins` also loaded the plugin, with and without `--setting-sources ""`. But it added the marketplace to `~/.claude/plugins/known_marketplaces.json` and its copy under `~/.claude/plugins/cache`, a global change that outlived the run (I removed it with `claude plugin marketplace remove`). Not recommended for pitwall.
   - A `--bg` session's hook environment lacks the launching shell's variables (`env` in the probe's log was empty), as in spike 015, finding 3: the hook finds pitwall at `~/.pitwall/server.json` only.
   - Sessions started in a terminal, or by anything but pitwall, still need the plugin installed once, as in W176.
6. **Hooks inside a sub-agent.**
   - `PreToolUse` and `PostToolUse` fired for the sub-agent's own tool calls (`Bash`), with two extra fields: `agent_id` and `agent_type` (`general-purpose`). `transcript_path` is the parent session's, not the sub-agent's; `agent_transcript_path` was `null` there. The sub-agent's file is `<transcript_path minus .jsonl>/subagents/agent-<agent_id>.jsonl`.
   - `hookSpecificOutput.additionalContext` from both reached the sub-agent: its transcript has `hook_additional_context` attachments for `PreToolUse:Bash` and `PostToolUse:Bash`, and it quoted `SPIKE018 SUBAGENT NOTE: finish this piece now and report.` twice, saying it came from the hook context and not the tool result.
   - `Stop` fired only for the main session (no `agent_id`). `SubagentStop` fired for each finish, including after a resume, with `agent_id`, `agent_type`, `agent_transcript_path` (the sub-agent's file), `last_assistant_message` and the parent's `transcript_path`. I didn't test whether `SubagentStop` can block or add context; it needs a test before W197 relies on it.
   - So W133's `handoffNudge.mjs` as a plugin `Stop` hook still leaves sub-agents alone, and a sub-agent growing within one piece is told by a `PostToolUse` hook that reads the size as in finding 4. It runs on every tool call of every sub-agent, so it must exit at once when pitwall isn't running or the agent is under the threshold, and read only the file's tail.

## What W197's build should do

1. **Hook:** a `PreToolUse` hook, matcher `SendMessage`, in `plugin/hooks/hooks.json`; decide only when `tool_input.to` is an agent id (letters and digits) with a regular `agent-<id>.jsonl` and `.meta.json` beside the session's transcript, under `subagents.ts`' file rules. Anything else, or any error, prints nothing and exits 0.
2. **State:** `meta.finished === true` is finished; anything else is allowed. Drop the plan's "state from the task notifications" as the first read; keep it, with the 10 s rule, only if the meta key turns out to be missing on other versions. That makes the hook simpler than the plan's.
3. **Size:** the last `assistant` entry's usage sum in the sub-agent's file, from its tail, as in `handoffNudge.mjs`. Over 200K (an environment variable lowers it for tests) and finished: deny with JSON and a reason that says to start a new Agent call with a brief from the repo and the agent's last report. Running and over: allow, with `additionalContext` (a `PreToolUse` hook can add it on the main session's call too).
4. **Deny by JSON, not exit 2** (finding 1), with a short reason with no paths.
5. **Sub-agent growth in a single piece:** a `PostToolUse` hook (not `Stop`) that reads `agent_id`, sizes the file, and adds `additionalContext` once per agent per level (200K, 400K), with state per agent id as `handoffNudge.mjs` keeps per session. Test `SubagentStop` blocking first, as a second route.
6. **Loading:** pitwall adds `--plugin-dir <its plugin/ folder>` to the sessions it starts with `claude --bg`, which needs no install. Keep the install for terminal sessions. pitwall's `-p` calls need nothing (they have no `SendMessage` to guard).
7. **Plan change:** W197's "also in the plugin: W133's `handoffNudge.mjs`" needs the sub-agent route in item 5, since `Stop` doesn't fire in a sub-agent. The spike's list of open questions is answered, apart from `uds:` targets and `SubagentStop` blocking.

## Not tested

- A `SendMessage` to a `uds:` address (its `recipient_kind`).
- `SubagentStop` returning a block or context.
- The hook's cost at scale (every sub-agent tool call); the probe took a few tens of ms per call.
- Other Claude Code versions; `meta.finished` and `agent_id` are undocumented.

## Clean-up

Sessions: `pitwall-test-018-bg1` (`claude --bg`, id `bca03957`) stopped and removed with `claude stop` and `claude rm`; `claude agents --json --all` lists none named `pitwall-test-018-*`. The `-p` runs `pitwall-test-018-a` to `-e` weren't listed as sessions, and their transcripts folder under `~/.claude/projects` was deleted. The marketplace `p018mkt` was removed (`claude plugin marketplace remove`), and so was `~/.claude/plugins/data/p018-inline`. The probe's working files were in the gitignored `scratch/p018/`.
