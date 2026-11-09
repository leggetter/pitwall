# Spike 014: Clear and continue a background job

Run on 2026-11-09 against Claude Code 2.1.321 on macOS, for W168 (Clear and continue: a hand-off you start with one click). The question: can pitwall send `/clear` and then a prompt to a background job through `claude attach` in a PTY, and confirm each step from `claude agents --json` rather than by reading the screen? The script is beside this file: `014-clear-and-continue.mjs`.

It ran against one throwaway background job, `pitwall-test-clear-014`, on Haiku, started with `claude --bg` in a pitwall worktree. The script refuses any job whose name doesn't start with `pitwall-test-`. No other session was touched, and the job was removed afterwards with `claude rm`.

## Questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Does `/clear` typed through the attach PTY clear a background job? | Yes. `claude agents --json` listed the same job id with a new `sessionId` 1.6 s after Enter |
| 2 | Is the job kept? | Yes: the same short id and name. `state.json` (internal) kept the first `sessionId` and set `resumeSessionId` to the new one |
| 3 | Can pitwall tell when to type the prompt without reading the screen? | Yes. Wait for the new `sessionId` in `claude agents --json`, then type |
| 4 | Does a two-line prompt arrive as one message? | Yes, as a bracketed paste. The job's TUI turned bracketed paste on (`ESC [?2004h`) when attached. The prompt arrived as one user message with both lines, 0.5 s after Enter |
| 5 | Does it answer? | Yes, 2.5 s later, in the new transcript |
| 6 | What does attaching do to a `done` job with a live process? | Nothing visible. It stayed `done` and `idle` until the prompt, then went to `working`. Detaching (killing the PTY) left it running |
| 7 | Does a cross-session message of `/clear` run it? | No. It arrives as text in a `<cross-session-message>`. The model answered that it can't run `/clear` and asked its user to, and the job went to `blocked` |

## Findings

1. **When to type:** the script typed once attach output had been quiet for 1 s. That took 0.75 s here. A fixed wait is fragile, but pitwall needs no screen reading for the rest: the new `sessionId` confirms the clear, and the new transcript confirms the prompt.
2. **The order matters:** type `/clear`, then Enter as a separate write about 300 ms later. Then wait for the new id, and paste the prompt bracketed, then Enter.
3. **The relay can't do it:** a cross-session message is a prompt to the model, not typed input (W128's rename note expected this). So Clear and continue needs the server's own attach PTY.
4. **The new transcript names no predecessor,** as seen in W167's finding. The prompt's first line, `Continues session <id>.`, is the only link inside it. W167's lineage log records the rest.

## Decisions

- W168 can build Clear and continue on the server's attach PTY for background jobs:
  - type `/clear`;
  - confirm the clear from `claude agents --json`, with a timeout;
  - paste the prompt bracketed, then press Enter;
  - confirm the prompt from the new transcript;
  - detach.
- If the new id doesn't appear within the timeout, it fails soft. The card says so and offers Start instead.
- Interactive sessions can't be attached to, so they get Start only.
