# Spike 012: a hook that tells a session to hand off

Run on 2026-11-03 against Claude Code 2.1.317 on macOS, for W133 B: can a Claude Code hook see how large a session's context is, and tell the session to hand off with the `handoff` skill once it passes 200K tokens? It ran as one throwaway `claude -p` session on Haiku, `pitwall-test-handoff`, in a temp folder under `$TMPDIR`. It used `--setting-sources ""`, a `--settings` file with the hook at a 1K threshold, and a second Stop hook that copied each input and the transcript as they were when the hook ran. The session ran once and was resumed once.

No other session was touched. The test session's transcript folder and the temp folder were deleted afterwards. It was a `-p` session, so there was nothing to stop or remove.

## Questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Does a hook's input give the context size? | No. No hook input carries the main session's token usage. SessionStart's `context_tokens` is set only on resume or fork, and PostToolUse's `usage` belongs to a sub-agent ([hooks reference](https://code.claude.com/docs/en/hooks)) |
| 2 | Can it be read from the transcript? | Yes, through `transcript_path`: the last main-chain `assistant` entry's `message.usage`, `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. But it's a step behind (finding 2) |
| 3 | Which event? | Stop, with `hookSpecificOutput.additionalContext`. The session acted on it at once (finding 3) |
| 4 | Does it loop? | No. The continuation's Stop came with `stop_hook_active: true`, and the hook stayed silent. Claude Code also seemed to cap Stop continuations at 8 in a row (observed, not found in the hooks docs) |

## Findings

1. **Stop's input**, on 2.1.317: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort`, `hook_event_name: "Stop"`, `stop_hook_active`, `last_assistant_message`, `background_tasks` and `session_crons`. Stop fires in `-p` mode too.
2. **The transcript is a step behind at Stop.**
   - On the first turn, the copy taken at Stop had no `assistant` entry. That turn's `assistant` entry, with its usage, was written after the hook ran. The hooks reference warns of this: "the transcript file isn't guaranteed to include the final message at Stop time on all versions".
   - So the hook reads the call before the turn's last one: the previous turn's last call, or an earlier call in the same turn when it used tools. That call is no more than one step smaller, which is fine for a 200K line. A session's first turn, or a resumed session's, isn't nudged; the next one is.
   - Each call also writes `api-request-shape` and `api-request-blob` lines, and a large `attachment` after the reply. These were 1.5 to 1.9 MB here, with the user's MCP servers loaded. The hook skips `api-request*` lines without parsing them, and reads 256 KB of the tail, then 4 MB, then 32 MB, until it finds a usage entry.
3. **`additionalContext` from Stop continues the session at once.**
   - On the resumed turn, the hook read the first turn's usage, 589,621 tokens (the user's MCP tool definitions, which `--strict-mcp-config` left out on the resume), and printed `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"…"}}`.
   - The transcript recorded a `hook_success` attachment, a `hook_additional_context` attachment and a `stop_hook_summary`. Then came a new assistant turn that started on the handoff skill, reading `.claude/skills/handoff/SKILL.md` and `NOW.md`. With `--tools ""` it couldn't actually do it.
   - The second Stop had `stop_hook_active: true`. The hook printed nothing, and the run ended.
4. **The settings shape works as documented:** exec form, `"command": "node", "args": ["<path>/handoffNudge.mjs"]`, with `env` in the same settings file reaching the hook.

## Decisions

- **Stop, not UserPromptSubmit.** A UserPromptSubmit hook's `additionalContext` waits for the next prompt, and a session that's left running, or that the supervisor drives, may not get one soon. A coordinator at 760K tokens also re-reads its context on every call of the turn in hand. Stop acts at the end of the turn that crossed the line, and the message tells the session to finish safely first.
- **`additionalContext`, not `decision: "block"`.** Both continue the session through the same loop protections. `additionalContext` is recorded as hook feedback, not shown as a hook error, and the nudge isn't an error.
- **Once per level per session:** at 200K, then at 400K. The levels nudged are kept in `os.tmpdir()/pitwall-handoff-nudge-<uid>/<session id>.json`, used only when that folder is a real folder owned by the user, never in the transcript's folder. A compaction that brings the context back under a level re-arms it. A compaction entry after the last usage means the size is unknown, so the hook says nothing until the next call.
- **Sub-agents are left alone.** Claude Code fires SubagentStop, not Stop, when a sub-agent finishes, and that event isn't hooked. Sidechain entries in the main transcript, where older versions wrote a sub-agent's calls, are skipped. A Stop input with an `agent_id` is ignored as well.
- **pitwall's own `claude -p` calls don't get it.** The supervisor and recaps run with `--setting-sources ""`, so the repo's `.claude/settings.json` isn't loaded. Sessions started in this repo, from pitwall or a terminal, do get it, and so do worktrees, since the file is checked in.

## Not verified

- An interactive session. The behaviour was seen in `-p` mode only. The hooks reference describes Stop the same way for both.
- How `/clear` treats the state. It starts a new session id, so the new session is nudged afresh, which is what's wanted.
