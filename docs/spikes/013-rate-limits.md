# Spike 013: Reading the plan's percentages without changing your settings

Run on 2026-11-10 against Claude Code 2.1.321 on macOS, for W157 (reading the plan's percentages). The question: can pitwall read the plan's five-hour and weekly percentages, and when the week resets, without a status line in `~/.claude/settings.json`, which would reach every session? W158 (the Usage view) needs the week's reset. W159 (the run rate against a weekend reserve) needs both windows' percentages.

Three ways were tried, cheapest first, in throwaway sessions named `pitwall-test-013*`, on Haiku, in a folder in the worktree's `scratch/`. No other session was touched, the one background session was removed afterwards with `claude rm`, and `~/.claude/settings.json` wasn't changed. The probes are beside this file: `013-rate-limits.mjs` runs (a) and (c), and `013-rate-limits-statusline.mjs` is (b)'s status line command. Both print or keep rate-limit fields only, never the model's or `/usage`'s text.

Checked against the current docs:

- [Status line](https://code.claude.com/docs/en/statusline): its "Available data", "When the status line updates" and "Rate limit usage" sections.
- The Agent SDK's [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript): `SDKRateLimitEvent`, `SDKAssistantMessage.usage_report` and `SDKUsageReport`.
- [Costs](https://code.claude.com/docs/en/costs): "When the usage request fails".

## Questions

| # | Question | Answer |
| --- | --- | --- |
| a | Is `rate_limit_event` in a `claude -p` stream on every call, or only near a limit? | On every call: 4 of 4 short calls, at 15% of the week, with `status: "allowed"`. But the percentage was only in undocumented fields, and only one window came per event |
| b | Does a background session run a status line passed with `--settings`? | Yes. A `claude --bg` session with nobody attached wrote the file within seconds. A `claude -p` call runs none |
| c | Does `/usage` sent to `claude -p` spend a model call? | No. Cost 0, 0 turns, 0 tokens, API time 0 ms, and the message's model was `<synthetic>`. About 3.5 s of wall time |

## Findings

1. **(a) `rate_limit_event` is on every call, but its percentage is undocumented.**
   - The docs describe `rate_limit_info` as `status`, `resetsAt` and `utilization`, all but `status` optional, "emitted when the session encounters a rate limit".
   - Every call had one, after the assistant message. Its top-level `utilization` was absent. The percentage was only in fields the docs don't list: `rateLimitType: "seven_day"` and `unifiedWindows.seven_day.utilization`, a fraction from 0 to 1 (0.15).
   - It comes with a model call, so pitwall would see it only on calls it already makes. Only the supervisor streams; recaps use `--output-format json`, whose result has no rate-limit field.
   - It lagged: 0.15 while `/usage`, a minute later, said 16%.
   - Not used: the documented fields alone don't say which window `resetsAt` is for, or how much of it is used.
2. **(b) A status line passed per session works in background sessions, and only for the sessions pitwall starts.**
   - `claude --bg --settings '{"statusLine":…}'` ran the command with nobody attached. The file had `{"seven_day":{"used_percentage":15,"resets_at":1794744000}}`, 0600 as the script wrote it.
   - `claude -p` with the same `--settings` wrote nothing: print mode runs no status line.
   - Fresh only while one of those sessions is working: the docs' triggers are a new assistant message, `/compact`, a mode change, a `refreshInterval` and a window reaching `resets_at`. A `refreshInterval` re-runs the command but not the request, so the data stays that of the session's last API response.
   - It needs a trusted folder and no `disableAllHooks` (the docs' troubleshooting), and it replaces a person's own status line in those sessions. Phil has none today; someone who does would lose theirs in sessions pitwall starts, unless pitwall's command ran theirs too.
   - Not built: it depends on a session pitwall started being busy. It stays the fallback if `usage_report` goes away.
3. **(c) `/usage` costs nothing and returns the documented, structured report.**
   - With `--output-format stream-json`, the one assistant message carries `usage_report`, the SDK's `SDKUsageReport`, marked experimental. `--output-format json`'s result has no `usage_report`, only the text.
   - `usage_report.rate_limits.limits` had a `weekly_all` row (`percent: 15`, `resets_at` an ISO time) and a `weekly_scoped` row for one model. `/usage` works from stdin too, as recap calls send their input.
   - Fresh on demand, so pitwall decides when. The usage endpoint behind it is rate limited, and shared with your own `/usage`: when it refuses, the interactive `/usage` shows the last bars from up to 60 minutes ago (the costs docs). Whether `usage_report` then carries those, or `null`, isn't documented and didn't happen here.
   - Absent when the session doesn't authenticate with a claude.ai login (an API key, Bedrock, Vertex), with a `claude setup-token` token, on usage-based billing, or `rate_limits: null` when the token lacks the `user:profile` scope (the SDK docs).
4. **No five-hour window, from any of the three, on this account on 2026-11-10.**
   - No `five_hour` in the status line, no `session` row in `/usage`, and only `seven_day` in the event's `unifiedWindows`. The `/usage` text, read locally and not kept, showed only the week's rows too.
   - The docs say each window may be absent, without saying when. So W159 has to work from the week alone.
   - The adapter maps the `session` row to the five-hour window. That follows the docs' kinds (`session`, `weekly_all`, `weekly_scoped`) and the status line's two windows; with no five-hour row here, it isn't observed.
5. **The reset times agree.**
   - (a) and (b) gave 1794744000 (Sunday 2026-11-15, 12:00 UTC). `/usage`'s three reads gave 11:59:59.87, 12:00:00.05 and 12:00:00.21 the same day.
   - So the adapter rounds a reset to the nearest minute, and two reads compare equal.
6. **Spend:** five short Haiku calls for (a) and (b)'s print-mode check, at $0.0005 to $0.0024 each at API list prices, and one background session's single reply. The five `/usage` calls, the adapter's live check included, cost nothing.

## Who needs what

| Needs | Way | How fresh | Absent when |
| --- | --- | --- | --- |
| W158: the week's reset, `seven_day.resets_at` | (c): `sevenDay.resetsAt` from `src/usage/rateLimits.ts` | Read when asked, kept 5 minutes (a failure 1 minute) | Not a claude.ai login, no weekly row, or the call fails: W158 uses the last 7 days |
| W159: the week's percentage, `seven_day.used_percentage` | (c): `sevenDay.usedPercentage` | Read when asked, kept 5 minutes | As above: W159 shows "unavailable" |
| W159: the five hours' percentage, `five_hour.used_percentage` | (c): `fiveHour.usedPercentage` | As above | Not seen on this account: W159 shows the week alone |

## Decisions

- Read the percentages from `/usage`'s `usage_report`, (c). It's documented, though experimental, spends no model call, reaches no session's settings, and pitwall chooses when to read.
- The adapter is `src/usage/rateLimits.ts`, the one module that reads the report:
  - `readRateLimits()` runs `claude -p` with `/usage` over stdin, with the recap call's isolation and environment: no transcript, no tools, none of your settings, hooks, plugins or MCP servers, output capped, so the call stays bounded should `/usage` ever reach the model.
  - `createRateLimitsReader()` runs it from a 0700 `$PITWALL_HOME/rate-limits`. It keeps a read for 5 minutes and a failure for 1, never keeps one stopped at shutdown, and shares a call in flight, so W158 and W159 can call it freely without hitting the usage endpoint's limit.
  - Its `isOwn(row)` knows the call by pid while it runs, by its folder, and by its name, `pitwall-usage`, for `OWN_NAME_MS`, as the recap engine's does. W158, the first caller, wires it into the index's exclude and the server's `isRelay`.
  - A percentage outside 0 to 1000 is unreadable and leaves its window `null`; the server sends 0 to 100. A reset that is missing or unreadable is `null`, and the percentage is kept.
  - It reads `rate_limits.limits` only and drops the message's text and session block unread.
  - Every failure is `unavailable`, with a reason: `not-found`, `failed`, `timeout`, `stopped`, `no-report` or `no-limits`. A missing window is `null`.
- Not (a): undocumented for the percentage, and only on model calls.
- Not (b) for now: it covers only sessions pitwall starts while they work, and replaces a person's own status line in them. It's the fallback if `usage_report` is withdrawn.
