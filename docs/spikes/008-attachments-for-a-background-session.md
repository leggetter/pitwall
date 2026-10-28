# Spike 008: getting a file or an image to a background session

Run on 2026-10-28 against Claude Code 2.1.311 on macOS, for "Attachments in New session's first prompt" (Phil, 2026-10-27: "It should be possible to drop items/attachments, paste items, into the opening session prompt"). `claude --bg` takes the first prompt as one argument, so the question is how a file the user drops or pastes can reach the session.

Eight throwaway Haiku background sessions, `pitwall-test-att-*`, ran in `~/oss/pitwall-sandbox` and were removed afterwards, with their transcripts and folders. They were given two files outside their working directory: a 64 × 64 PNG, red on the left half and blue on the right, and a text file holding a made-up secret word.

## Questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Is there a documented way to attach a file at start? | Not a local one. `--file` downloads from Anthropic's Files API, and image input needs `--print` (finding 1) |
| 2 | Does an `@path` mention in a `--bg` prompt attach the file? | Yes: Claude Code attaches it, an image as an image, before the first turn, with no tool call (finding 2) |
| 3 | Does a plain path work? | Yes, through the Read tool, but in `default` permission mode only with `--add-dir` (finding 3) |
| 4 | Does `--add-dir` need care? | Yes: it takes several values, and swallows the prompt unless written `--add-dir=<dir>` (finding 4) |
| 5 | How long must pitwall keep the file? | Only until the session has started: the transcript keeps the attachment's content (finding 5) |

## Findings

1. **No local attach flag.**
   - `--file <file_id:path>` downloads resources from Anthropic's Files API at startup, so a file would first have to be uploaded to Anthropic.
   - `--input-format` (stream-json, which can carry image blocks) works only with `--print`.
   - `--add-dir <directories...>` lets a session's tools use another directory.

2. **An `@` mention attaches the file.**
   - **The test:** a prompt naming `@/abs/path/halves.png` and `@/abs/path/note.txt`, run in `auto` mode with `--add-dir`, and in `default` mode without.
   - **The transcript:** an `attachment` entry of type `file` for each. The PNG's content is `{ base64, type, originalSize, dimensions }`, and the text file's is `{ filePath, content, numLines, … }`.
   - **The model:** made no tool call, and answered "left red, right blue; secret word marmalade".
   - **Permissions:** in `default` mode it worked without `--add-dir` too, because the mention is expanded before any tool runs.

3. **A plain path needs the Read tool.**
   - In `auto` mode the model called Read twice and answered correctly, with or without `--add-dir`.
   - In `default` mode without `--add-dir`, the session stopped `blocked` with Claude Code's line `approve Read: /…/halves.png`: a permission prompt, which pitwall would show in Needs you.
   - With `--add-dir`, it answered without asking.

4. **`--add-dir` takes the prompt if written with a space.** `claude --bg --add-dir <dir> "<prompt>"` started two sessions that printed `(idle — send a prompt to start)`, because the prompt became a second directory. `--add-dir=<dir>` worked. The same goes for any option with several values, such as `--mcp-config`.

5. **The transcript keeps the content.** The PNG went into the transcript as base64; the transcript was 420 KB for a 137-byte image, mostly Claude Code's own start-up entries. So once the session has started, it no longer needs pitwall's copy, unless the model reads the file again with a tool.

## Recommendation

- **The mechanism:** an upload route stores each file in its own private folder. Spawn then:
  - appends one `@<absolute path>` line per file to the first prompt, after a blank line;
  - passes `--add-dir=<that folder>` for each, so a later Read of the same file doesn't ask permission in `default` mode.
- **Storage:** `~/.pitwall/attachments/<id>/` (folders 0700, files 0600), never inside the session's directory.
  - The stored name is a safe slug, since an `@` mention ends at a space; the original name is kept for display.
  - Uploads never used are removed after an hour. Used ones are removed after 7 days, since the transcript holds their content.
- **Limits:**
  - images (PNG, JPEG, GIF, WebP), PDF and plain-text types only;
  - at most 10 MB each, and at most 10 per session;
  - names cleaned of path separators, control and bidi characters.
- **Not now:** attachments in the session view's message box. That needs a different route, since a running session isn't started with a prompt.
