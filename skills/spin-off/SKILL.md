---
name: spin-off
description: Propose a new, separate Claude Code session for a piece of work that shouldn't run in this one, and leave it to the user to start it from pitwall's Needs you. Use when the user asks to spin off, hand off or split out work into a new session, or when you find separate work whose result this session doesn't need back, such as a fix in another repo, a follow-up, or a side task that would fill this session's context. Not for work whose result you need now: use a sub-agent for that.
---

# Spin off a new session

You propose a new top-level session; the user starts it. pitwall, which watches this machine's Claude Code sessions, reads the proposal from the end of your message and shows it as a card in Needs you, with the folder, the name and the whole prompt. The user reads it, can change any of it in New session, and starts it there. Nothing starts until they do.

The new session works on its own. Its result never comes back to this session, so this session's context stays small. If you need the result to carry on, use a sub-agent instead.

## How

1. Say in a sentence or two what you're proposing and why it's a separate session.
2. End your message with one `spin-off` block, as the very last thing in it. Nothing after it, not even a sign-off.
3. Then stop. Don't start the work yourself, don't run `claude --bg` or any other command to start a session, and don't wait for it.

```spin-off
folder: ~/code/demo-app
name: fix-export-test
prompt:
Fix the flaky export test in test/export.test.ts. It fails about one run in ten on CI with a timeout in the CSV step.

Find the cause, fix it, and run npm test three times to check it passes each time. Open a pull request with the fix and tell me what the cause was.
```

## The block

- **The fence:** three backticks and `spin-off`, closed by three backticks. If the prompt has a fenced block of its own, open and close the spin-off block with four backticks instead.
- **`folder:`** (required): the directory the new session starts in, as an absolute path or one starting with `~/`. It must already exist, under one of the roots pitwall watches. Usually a repo's own folder.
- **`name:`** (optional): a short name for the session, at most 64 characters: letters, digits, spaces, `.`, `_` and `-`, starting with a letter, digit, `.` or `_`.
- **`prompt:`** (required): everything after this line is the new session's first prompt, up to 16,384 characters. Put text on the same line as `prompt:` or start on the next line.
- Only `folder:` and `name:` go before `prompt:`, each once.

## The prompt

The new session knows nothing of this conversation. Write the prompt so it stands on its own:

- What to do, and where: the files, the issue or pull request by its URL, the commands.
- What you already know that saves it time: the cause you suspect, what you ruled out.
- What done looks like, and what to report.
- No secrets, tokens or anything copied from a transcript that the new session doesn't need.

Write plain text. pitwall won't show a block with a control, zero-width, bidi or other invisible character in it, and says so on the card instead.

## One at a time

pitwall shows the last block of your newest message, and only while it ends the message. A later message without one clears it. To propose two sessions, propose one, and the next in a later turn.
