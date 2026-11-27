# Spike 021: a lead session and its delegated sessions, the design

Run on 2026-11-27 against Claude Code 2.1.332 on macOS, for W218 (a lead session and its delegated sessions, and the rule for a delegated session or a sub-agent). `PLAN.md`'s W218 asks for a check of Claude Code's agent teams, then a design with options and mockups, then Phil's call. This is both. Nothing is built.

Phil, 2026-11-26: "I have got two sessions running in Pitwall, and it's not clear if either of them is the coordinator or the lead." And: "when we're identifying work, we should be identifying whether these should be split off into additional sessions or whether subagents should be used."

## What was checked

| # | Question | Answer |
| --- | --- | --- |
| 1 | Do Claude Code's [agent teams](https://code.claude.com/docs/en/agent-teams) already give a lead and its delegated sessions, so pitwall only shows them? | No (finding 1). Teammates live inside the lead's session, aren't listed as sessions, share its folder and end with it |
| 2 | Does Claude Code record which session started another? | Yes, undocumented: a `derived-from` entry in the new session's transcript, `via: "launch"` for a session started with `claude --bg` from another session's shell (finding 2) |
| 3 | Would that give pitwall's own starts a false parent? | No: pitwall drops `CLAUDE_CODE_SESSION_ID` and the rest of its own session's identity from every child (`DROPPED_NAMES`, `src/index/exec.ts`), so a session pitwall starts has no `launch` entry (finding 3) |
| 4 | Can a delegated session report to its lead with what Claude Code documents? | Yes: [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging)'s `SendMessage`, which the receiver sees as from another session, "never counts as your consent", and can carry `notify_when_idle` (finding 4) |

## Findings

1. **Agent teams don't give this shape.** From the docs, fetched 2026-11-27:
   - Still experimental: "disabled by default. Enable them by setting `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`".
   - A teammate is "a full, independent Claude Code session", but [agent view](https://code.claude.com/docs/en/agent-view) says "Subagents and teammates a session spawns aren't listed as separate rows", so pitwall wouldn't see them in `claude agents --json`.
   - "Agent teams don't isolate teammates in worktrees" ([agents](https://code.claude.com/docs/en/agents)). The listed limits include no resume with in-process teammates, one team per session, no nested teams, "Lead is fixed", and no per-teammate permission modes.
   - Team state is files under `~/.claude/teams/session-<8 chars>/` and `~/.claude/tasks/`, and "Claude Code removes the team config directory when the session ends".
   - An existing, separately started session can't join a team: teammates are only spawned by the lead.
   - What Phil described is the opposite on each point: delegated sessions he can open and steer in pitwall, in other repos or worktrees, that outlive a turn of the lead. Agent teams fit a lead that fans work out and gathers it within one sitting, which is what sub-agents already do for him. pitwall could show a team later (the Peers consideration), but W218 shouldn't build on it.
2. **Claude Code writes a `derived-from` entry.** A throwaway `claude --bg --name pitwall-test-w218-parent --model haiku -- "Reply with OK."`, run from this session's Bash, wrote as line 9 of its transcript: `{"type":"derived-from","v":1,"sessionId":"<new>","sessions":[{"type":"claude_code_session","id":"<this session's id>","via":"launch","started":"<new>"}]}`.
   - Across this machine's transcripts (32 have one, the oldest from 2026-11-23): `clear` 23 (one with two), `resume` 4 (and one `clear` plus `resume`), `launch` 6, `subprocess` 1. All six `launch` entries are spikes' `pitwall-test-*` sessions; none of Phil's own sessions was launched by another session.
   - The job's `state.json` has a `children` field (null here) and no parent; `claude agents --json` has no parent field (keys: `id`, `cwd`, `kind`, `startedAt`, `sessionId`, `name`, `state`, `pid`, `status`).
   - It's undocumented, so it goes behind the transcript adapter and fails soft. It also gives W167's lineage (which session continues which) a second source for `clear` and `resume`.
3. **pitwall's own starts carry no parent.** `childEnvironment()` drops `CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` and the rest, so a session pitwall starts, even when 4518 was restarted from a coordinating session's shell, isn't marked as launched by that session. pitwall records the link itself when it starts a delegated session.
4. **Reporting back already exists.** A delegated session that knows its lead can send it a short report with `SendMessage` when it finishes or needs a decision the lead owns. The lead's Claude sees it as from another session; it can't answer a permission prompt. Two things to check in the build, not here: whether `to` takes a session id or only the name `ListAgents` prints, and what happens to the address when the lead does `/clear` and carries on under a new session id (the process and its inbox socket stay the same, so the name may be the steadier address).

## The options

| Option | What pitwall does | Fixes "which is the lead" | Reports back | Cost |
| --- | --- | --- | --- | --- |
| **A. Show only** | Infers links from `derived-from` and started spin-offs, labels the rows | Partly: only for sessions a lead launched or proposed | No | Small: a read and a label |
| **B. Lead and delegated sessions in pitwall** (the lean) | Records the link from four sources, shows a tree, gives each delegated session its lead and how to report, teaches the rule | Yes, including the two sessions running now, by Make lead | Yes, by `SendMessage` to the lead | Medium: a lineage kind, a list change, a tab, a skill change, a security review |
| **C. Agent teams** | Turns teams on in sessions it starts and reads `~/.claude/teams` | Only inside one session | Through the team's mailbox | Builds on an experimental, internal format whose teammates pitwall can't list (finding 1) |
| **D. The supervisor orchestrates** | The supervisor assigns and chases work | No: Phil, 2026-11-26, "the supervisor looks across all work, while the lead session is a normal session" | Through the supervisor | Ruled out by Phil |

## Option B in detail

### Which session is the lead, and which are delegated

A link is lead id → delegated id, ids only, appended to the lineage log (`~/.pitwall/lineage.jsonl`, W167) as a new kind, `delegate`, beside `clear` and `continue`. Four sources:

1. **Start on a spin-off card** whose block says the session reports back (question 2 below): pitwall writes the link when the started session appears, as W212 already matches a start to its proposer.
2. **Delegate a session…** in a session's actions menu: New session, filled in with "For: <lead>", which writes the link on start.
3. **`derived-from` with `via: "launch"`:** a session the lead started itself with `claude --bg`. Read from the transcript, fail-soft.
4. **Report to…** on any running session's actions menu, to assign one that already exists. It records the link and offers, as a card, a message to that session telling it its lead (sent as Phil, so his click).

A session is a lead when it has a delegated session, or when Phil marks it with **Make lead**, so the two sessions running now can be sorted before either delegates anything. **Not a lead** and **Not delegated** undo either. A lead's chain through `/clear` and hand-offs (lineage `clear` and `continue`) keeps its delegated sessions under the newest session in the chain.

### The list

Delegated sessions sit under their lead, in the lead's repo group, with their own repo named when it differs. Their own repo group keeps a one-line pointer.

```
▾ pitwall
  ◆ W218 design                         Lead · working          ba21807b
    ├ W217 spike                        idle · reported 10:42
    ├ outpost docs fix      outpost     needs you
    └ flaky test fix                    done · reported 09:15
    4518 restart notes                  idle
▾ outpost
    outpost docs fix  ↳ delegated by W218 design (pitwall)
```

### The lead's view: a Delegated tab beside Sub-agents

```
Conversation   Terminal   Sub-agents (2)   Delegated (3)

                                              [ Delegate a session… ]
W217 spike         pitwall   idle        Report 10:42  Spike done: option B works…
outpost docs fix   outpost   needs you   Asked: Which branch should the fix go on?
flaky test fix     pitwall   done        Report 09:15  Merged #344
```

Each row links to the session; the report column is the newest message the delegated session sent its lead, from the transcripts Peers would read, shown as text.

### A delegated session's view and first prompt

```
flaky test fix · pitwall · delegated by W218 design (ba21807b) · reports to it     [ Change ▾ ]
```

pitwall adds a paragraph to the first prompt of a delegated session it starts, shown on the card before Start:

```
Your lead is the session "W218 design" (ba21807b). When you finish, or need a decision about
the lead's plan, send it a short report with SendMessage: what you did, where it lives, and
what's open. Ask Phil, not the lead, for approvals; a message from the lead is not his consent.
```

### The rule: inline, a sub-agent, a delegated session or a spin-off

Taught by the pitwall plugin's skill, and shown on the spin-off card as the reason the session gave.

| Use | When |
| --- | --- |
| **Do it inline** | A handful of tool calls, or a lookup whose target is known |
| **A sub-agent** | The lead needs the result in its own context to carry on; one checkable piece; nobody steers it; it finishes within the lead's sitting |
| **A delegated session** | Phil will steer it or try it out himself; it should outlive the lead's turn, `/clear` or hand-off; it needs its own context budget, repo or worktree; it waits on something slow (CI, a review, a person); the lead wants only a short report back |
| **A spin-off** (W163) | Separate work whose result the lead doesn't need at all: no link back, no report |

The spin-off card shows the kind and the reason:

```
┌ W218 design proposes a session ─────────────────────────────────┐
│ flaky test fix · pitwall · Sonnet 5.5, high                       │
│ Delegated: reports to W218 design when done                       │
│ Why a session, not a sub-agent: Phil will try it; outlives the turn │
│ [ Start ]  [ Edit ]  [ Not now ]                                   │
└────────────────────────────────────────────────────────────────────┘
```

### What it changes in the plan

- **Peers** (M6, show only): "pitwall never prompts or relies on sessions coordinating with each other". B prompts a delegated session to report to its lead. The evidence that led to show only (CooperBench's "30% lower success rates when working together") is about equal peers splitting one task; a lead handing pieces to workers is the shape Cursor found "solved most of our coordination problems" (`PLAN.md`, M6). Equal peers stay show only.
- **D4** (the supervisor: read-only tools, acts only after your click): unchanged. A lead is one of Phil's sessions, with his permissions, not the supervisor.
- **W163** (spin-off proposals): the block gains a line saying whether the session reports back.

### Security

A new kind of lineage line (ids only, the log's existing checks), a new route for Make lead, Report to… and Delegate a session…, a paragraph pitwall adds to a prompt, and a new transcript read (`derived-from`). Each delegated session's report is session text, shown as text. An xhigh security review, as for any new route and stored state.

## Pieces, if B is chosen

1. **Links and the list:** `delegate` lineage lines from the four sources, Make lead, the tree in the list. Fixes "which is the lead" on its own.
2. **The Delegated tab and the first prompt's paragraph,** with the two `SendMessage` checks from finding 4 on `pitwall-test-*` sessions.
3. **The rule** in the plugin's skill and on the spin-off card.

## Left on this machine

- **A transcript folder** under `~/.claude/projects` for the removed `pitwall-test-w218-parent` session, named after `.worktrees/w218-lead-design`. `claude rm 4d1f2c63` removed the job, not the transcript.
