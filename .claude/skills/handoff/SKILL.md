---
name: handoff
description: Close out a piece of pitwall work so a fresh session can start cheaply. Use when a work item or PR is finished, or when this session's context is large. Updates NOW.md, updates PLAN.md only where the design changed, commits, then ends with a spin-off block (W168) that pitwall shows as a Clear and continue card.
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
5. **End with a hand-off block, and nothing after it (W168).** Say in a sentence that the work is committed and that the next session starts from `NOW.md`. If questions are open, say how many, and that they're in `NOW.md` and the next session asks any still open first, so there's no need to answer before continuing. Then put them in the message too, as the **Needs your decision:** block, each in full with your lean: pitwall reads that block to list the session in Needs you at once, and a question left only in `NOW.md` showed nowhere until a recap came (W225). Then end the message with one `spin-off` block (the pitwall plugin's `pitwall` skill describes it), as the very last thing in it:

   ````
   ```spin-off
   folder: <this repo's absolute path, from git rev-parse --show-toplevel>
   prompt:
   Continues session <this session's id>.
   Read NOW.md, then start with the first item under "Next, in order". Ask the open questions in NOW.md first.
   ```
   ````

   - **This session's id** is the one in the pitwall note at the start of this session (its `?session=` link). The prompt's first line must be exactly `Continues session <id>.`: pitwall shows the block as a card with Clear and continue only for that line.
   - **Leave out `name:`.** For a background job, Clear and continue keeps the job's name.
   - **Don't type `/clear` yourself and don't start anything.** pitwall's card does it when the user clicks, and the prompt is typed as one message.
   - **No block if pitwall isn't running** (the session has no pitwall note), or you can't find your id: end with "run `/clear`, then start the next session with 'Read NOW.md'" instead.

## Open questions across a `/clear`

Phil (2026-11-04): with questions open at a hand-off, it wasn't clear whether to answer them first or run `/clear`, or whether they'd be lost. The rule:

- **They're never lost.** The hand-off writes every open question to `NOW.md`'s "Open questions for Phil", in full, with its lean (step 1). That's the only place they're carried across the `/clear`; the hand-off message repeats them in its Needs your decision block so Phil sees them now (step 5).
- **Either order works.** Answered in this session: record each answer in `NOW.md` (under "Answered", with the date, and in "Next" or `PLAN.md` where it changes the work), commit, then `/clear`. Not answered: `/clear` anyway.
- **The next session asks first.** After reading `NOW.md`, a session with open questions puts them to Phil before it starts any work they affect, each with its lean, and records the answers as above.
