# How pitwall decides a session's state and badges

This is pitwall's own account of what each badge on a session row means and which rule sets it. The rules live in `src/shared/sessionState.ts` and `src/shared/needsYou.ts`, which the web page and the server both import, so this page, the page and the supervisor's `why_state` tool say the same thing. A test (`src/shared/states.test.ts`) checks that every state the protocol has is named here. The supervisor reads this page through its `pitwall_states` tool.

Where Claude Code gives a value, it is quoted as Claude Code gives it: process status (`busy`, `waiting`, `idle`) and a background job's state (`working`, `blocked`, `done`, `failed`, `stopped`).

## Inputs

- **Process status:** `busy`, `waiting` or `idle`, from `claude agents --json`. `waiting` means a prompt is on screen.
- **Background state:** `working`, `blocked`, `done`, `failed` or `stopped`. Interactive sessions have none.
- **Flags on the session:** `alive` (its process is running), `finished`, `ended` (an interactive session whose process exited), `stale` (blocked with no activity for over 7 days) and `turnEnded` (the transcript says its turn is over).
- **The index's Needs you reason:** one of `prompt`, `claude-code`, `asked`, `recap`, `restarted`, `blocked` (below).
- **Its recap:** pitwall's own, made after the session's newest activity, says what it waits on.
- **Its pull requests:** the open PRs it owns (`review-requested`, `checks-failing`, `conflicts`, `changes-requested`).

## The status badge

The first rule that holds wins. A row shows no badge for `idle`; the session view says Idle.

| Status | Label | Rule |
| --- | --- | --- |
| `ended` | Ended | An interactive session whose process has exited. Checked first. |
| `waiting` | Waiting: *reason* | Claude Code shows a prompt and the Needs you reason is `prompt`. The label adds what it waits for, such as a permission prompt. |
| `blocked` | Blocked | The Needs you reason is `claude-code` (the job's own line on what it needs) or `blocked` (blocked, and pitwall could not read why). |
| `restarted` | Waiting for your prompt | You resumed or restarted it in this run of pitwall and no prompt has been sent since. |
| `asked` | Asked you | Its last turn ended by asking you something. |
| `recap` | Waiting on you | Its current recap says it waits on you. A session that is also busy keeps Busy's dot. |
| `blocked-stale` | Blocked | Claude Code says blocked, nothing needs you, and it is stale. Outlined. |
| `failed` | Failed | The background state is `failed`. |
| `waiting-on` | Waiting on CI / another session / someone else | Claude Code says `done`, but pitwall's current recap says it waits on someone else. Never needs you. |
| `done` | Done | The background state is `done` and the recap names no one else. |
| `stopped` | Stopped | The background state is `stopped`. |
| `not-running` | Not running | Its process is not alive, and it is not done, failed or stopped. |
| `busy` | Busy | The process status is `busy`. |
| `working` | Working | The background state is `working`, the process is alive, and the status is not busy or idle. |
| `idle` | Idle | The process status is `idle`, or blocked with nothing needed from you. |
| `unknown` | Unknown | None of the rules above holds. |

A flagged or snoozed session keeps its status and label, drawn outlined. Solid badges are for Needs you only.

## At work

A session is at work (the Busy dot, and the reason a PR does not put it in Needs you) when Claude Code says `busy`, or its running background job is `working`, and it has not finished, ended, gone stale or ended its turn. A transcript whose turn ended wins over a status that a plugin's monitor can hold at `busy`.

## Needs you

A session is in Needs you when it needs you itself, or a pull request it owns does while it is not at work.

Its own reason, the first that holds:

- `prompt`: Claude Code is showing a prompt; the badge says which.
- `claude-code`: a background job's own line on what it needs.
- `asked`: the last turn ended by asking you something.
- `recap`: its current recap says it waits on you.
- `restarted`: you resumed or restarted it and have not sent a prompt since.
- `blocked`: Claude Code says blocked and pitwall could not read why. Kept so a question is never hidden.

Never counted: a stale, finished or ended session. A finished session's question still shows on its row, muted.

A pull request puts a session in Needs you through one of these, when it is the session's own open PR and the session is not at work:

- `review-requested`: your review is asked for, directly or as a team.
- `checks-failing`: its checks fail (a PR you opened).
- `conflicts`: it has merge conflicts (a PR you opened).
- `changes-requested`: a reviewer asked for changes (a PR you opened).

A PR you dismissed with Not for me needs you nowhere. When a session needs you itself and through a PR, its second line explains its own reason.

## Flag and snooze

- **Flag:** you said a session does not need you. It holds only while the session needs what it needed when you flagged it; then it is cleared.
- **Snooze:** until a time, or Later until the session is woken by a turn you did not start. Its time ending, or a wake, puts it back in Needs you, and its row says why.
  It holds the PRs the session owned that needed you when you snoozed it (W199): while they are unchanged they don't keep the row in Needs you. Something new on one of them (its hash changes, or its head goes red), or another PR the session owns starting to need you, ends the snooze, and the row says which PR and why.

Either takes a session the index says needs you out of Needs you and every count. Its badge keeps its text and is outlined.

## Context

Every call re-sends the whole context. A badge appears once a session's last call carried over 200K tokens (warning) and a stronger one over 400K (danger). The thresholds are `CONTEXT_WARN_TOKENS` and `CONTEXT_HIGH_TOKENS` in `src/shared/protocol.ts`; past them it is time to hand off or compact.
