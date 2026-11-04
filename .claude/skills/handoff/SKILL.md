---
name: handoff
description: Close out a piece of pitwall work so a fresh session can start cheaply. Use when a work item or PR is finished, or when this session's context is large. Updates NOW.md, updates PLAN.md only where the design changed, commits, then tells the user to /clear.
---

# Handoff

Leave the repo so the next session can start from `NOW.md` alone. Do the steps in order, and read only what you need (AGENTS.md, "Efficiency"): `grep -n '^#'` and excerpts, never whole `PLAN.md`.

1. **Update `NOW.md`** (under 100 lines):
   - **Current milestone:** its state, and the date in "Last updated".
   - **Open work:** this item's PR or status, in one line; remove what has merged.
   - **Next, in order:** what to do next, so the next session needn't work it out.
   - **Open questions for Phil:** every pending one, in full, each with your lean. Never "see above" or "as before".
   - **Standing context:** links only. Add a link if the next session needs a new document; don't copy text in.
2. **Update `PLAN.md` only where the design changed:** a new interface, a security rule, a milestone's scope, a row in the open milestone's work breakdown. Not for status; status lives in `NOW.md`. A settled decision moves to `docs/decisions.md` under its ID. Finished milestones' detail goes to `docs/plan-archive.md`, verbatim, under the same heading.
3. **Check the docs:** `NOW.md` is under 100 lines, and `PLAN.md` hasn't grown past what the change needs.
4. **Commit** with a conventional message, such as `docs: hand off after W123`. Docs only, so no tests. Use the commit attribution the session was given. Don't push or merge unless asked.
5. **End with this to the user, and nothing after it:** work is committed; run `/clear`, then start the next session with "Read NOW.md". If any questions are open, say how many, and that they're in `NOW.md` and the next session asks them first, so there's no need to answer before `/clear`. Don't list them again in the message: one place, `NOW.md`.

## Open questions across a `/clear`

Phil (2026-11-04): with questions open at a hand-off, it wasn't clear whether to answer them first or run `/clear`, or whether they'd be lost. The rule:

- **They're never lost.** The hand-off writes every open question to `NOW.md`'s "Open questions for Phil", in full, with its lean (step 1). That's the only place they're carried.
- **Either order works.** Answered in this session: record each answer in `NOW.md` (under "Answered", with the date, and in "Next" or `PLAN.md` where it changes the work), commit, then `/clear`. Not answered: `/clear` anyway.
- **The next session asks first.** After reading `NOW.md`, a session with open questions puts them to Phil before it starts any work they affect, each with its lean, and records the answers as above.
