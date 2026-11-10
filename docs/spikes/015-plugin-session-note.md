# Spike 015: a plugin's `SessionStart` note, and proposing a session from inside a session

Run on 2026-11-10 against Claude Code 2.1.321 on macOS, for W176 (a pitwall plugin: every session knows it's watched, links sessions, and can propose one). It answers three questions: can a plugin from a local folder add a note to every session at its start, which events add it, and what does it cost? It also answers Phil's question of the same day: "I think I want to be able to spawn new sessions from within an existing session."

The prototype plugin is in [`015-plugin-session-note/plugin/`](015-plugin-session-note/plugin/). It's a spike and not for installing: W176 builds the real one. It has a `SessionStart` hook, `hooks/sessionNote.mjs`, and a `pitwall` skill, which is W163's `spin-off` skill (proposals for a new session, the first piece) under the plugin's name, with its block unchanged.

Everything ran against a test pitwall with its own `PITWALL_HOME` in the worktree's `scratch/`, `--no-recaps --no-prs --no-supervisor`, on port 4655, watching one root with one throwaway repo. The throwaway sessions were named `pitwall-test-015-*`: `-p`, interactive in tmux, and background. All of them were stopped and removed afterwards, and their transcript folder was deleted. No other session was touched.

## Questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Can a plugin from a local folder ship a skill and a `SessionStart` hook, and does the hook's output reach the model? | Yes, both ways: per session with `--plugin-dir <folder>`, and installed from a local-folder marketplace. `hookSpecificOutput.additionalContext` reached the model, which quoted the URL. The skill is listed as `pitwall:pitwall` (finding 1) |
| 2a | Start, `/clear`, compact and resume: once each? | Yes, once per event. Resume adds the note only when its text changed, and then the old note stays too (findings 2 and 4) |
| 2b | `claude attach` and pitwall's terminal view? | Nothing while the session runs. Attaching to a stopped background session restarts it, and that runs the hook as `resume` (finding 5) |
| 2c | `claude --bg` and `claude -p`? | Both run the hook. A background session's hooks don't get the launching shell's environment, so `PITWALL_HOME` doesn't reach them (finding 3) |
| 2d | pitwall's own `claude -p` calls (recaps, the supervisor, the relay)? | Not loaded at all. With `--setting-sources "" --strict-mcp-config`, the installed plugin wasn't in the session's plugin list, and the model saw no note (finding 6) |
| 3 | The cost? | About 345 tokens on a fresh session's first call: about 160 for the skill's listing and about 185 for the note. From 31,579 to 31,925 (finding 7) |
| 4 | How should a session propose a new session? | With W163's `spin-off` block, shipped as the plugin's `pitwall` skill. It worked end to end with the test pitwall (the comparison and the prototype below) |

## Findings

1. **A plugin from a local folder works both ways.**
   - **Per session:** `--plugin-dir <folder>` loads the plugin for that session only. It's listed as `pitwall@inline`, and `system/init` lists the skill as `pitwall:pitwall`. Claude Code also created an empty `~/.claude/plugins/data/pitwall-inline/` for it, which isn't removed by itself.
   - **Installed:** `claude plugin marketplace add <folder> --scope project`, then `claude plugin install pitwall@<marketplace> --scope project`. This wrote `extraKnownMarketplaces` and `enabledPlugins` into the throwaway folder's `.claude/settings.json`, and copied the plugin into `~/.claude/plugins/cache/<marketplace>/`. The hook's `CLAUDE_PLUGIN_ROOT` was the marketplace folder itself, so a local install runs in place.
   - **The note reached the model:** `hookSpecificOutput.additionalContext` was recorded as a `hook_additional_context` attachment. Asked "what URL does pitwall watch this session at?", the model quoted `http://127.0.0.1:4655/?session=<its id>` and said it came from the SessionStart hook. The hooks reference documents plain stdout as well, capped at 10,000 characters ([hooks](https://code.claude.com/docs/en/hooks)).
   - `claude plugin validate` passes.
2. **Which events run it, on an interactive session in tmux:** one `startup` after the trust prompt. `/clear` ran it as `clear`, with the new session id, and the note named the new id. `/compact` ran it as `compact`, and its note came after the compaction summary. `claude --resume <id>` ran it as `resume`. Each ran once, as the hook's own log showed. After the compaction and the resume, the model counted one note.
3. **Background and `-p` sessions run it, but a background session gets the background service's environment.**
   - `claude -p` ran it at start, and the note reached the model (finding 1).
   - `claude --bg` ran it at start: its screen showed "running SessionStart hooks… 0/3", and an environment probe in the scratch copy of the hook logged a `startup` run. But `PITWALL_HOME` and the spike's log variable, set in the shell that ran `claude --bg`, weren't in the hook's environment. Its `CLAUDE_*` variables were the background service's, such as `CLAUDE_JOB_DIR`.
   - So the hook found no `server.json` and added nothing, which is right: the test pitwall wasn't at `~/.pitwall`. Sessions pitwall starts are background sessions too.
   - **For W176:** the hook must find pitwall at a fixed place, `~/.pitwall/server.json`, and not rely on the environment. A test pitwall with its own `PITWALL_HOME` then never shows in Phil's sessions' notes, which is what's wanted.
4. **Resume adds the note again only when its text changed, and then keeps both.**
   - Resumed twice with the same note, the transcript held one `hook_additional_context`. Claude Code recorded nothing for the second hook run, not even its `hook_success`.
   - A session that started with no note (no pitwall listening), then resumed with pitwall up, got the note.
   - Resumed with the URL changed to another port, the transcript held two notes, and the model listed both URLs as claiming the session.
   - pitwall changes its port when 4517 is busy, and a fork gets a new session id, so a note can change. The prototype's note now ends "This replaces any earlier pitwall note in this conversation", and its matcher includes `fork`.
5. **Attaching adds nothing to a running session.**
   - `claude attach <id>` to a running background session ran no hook: the log had no new line.
   - pitwall's terminal view runs the same `claude attach <short id>` in a PTY (`src/server/attach.ts`), so it's the same case.
   - **The exception:** attaching to a stopped background session restarts it, and that ran the hook as `resume`. pitwall's view asks before it does that (D9, at most four attached sessions and a confirmation before restarting one). Such a session gets the note then, or keeps its earlier one if the text is unchanged (finding 4).
6. **pitwall's own `claude -p` calls don't get it.**
   - With the plugin installed in the folder, a `-p` call with `--setting-sources "" --strict-mcp-config --tools ""`, as recaps, the supervisor and the relay run (`src/recaps/prompt.ts`, `src/supervisor/prompt.ts`, `src/server/relayPrompt.ts`), listed no `pitwall` plugin and no skill, and the model answered NONE.
   - The same call without those flags got the note.
   - **Why:** `--setting-sources ""` leaves out every `enabledPlugins`, so only Claude Code's built-in plugins load. The same holds for Phil's own installed plugins, which loaded without the flags and not with them.
   - A plugin given by `--plugin-dir` would still load, but pitwall never passes it.
7. **The cost**, measured as `AGENTS.md`'s Efficiency section says: `claude -p "Reply with OK." --output-format json --no-session-persistence --max-turns 1`, twice each, in a scratch folder in the worktree, with Phil's own settings and plugins. The total is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.

   | Run | First call |
   | --- | --- |
   | Without the plugin | 31,579 |
   | With the plugin, no pitwall running, so the skill's listing only | 31,737 (+158) |
   | With the plugin and the note | 31,923 and 31,925 (+344, +346) |

   The note is three lines and about 185 tokens, a little more with the fourth line added after finding 4. Every call re-reads it, but it's cached with the rest of the start.
8. **The session chose the skill without being told to.** In the prototype run, an interactive session in the throwaway repo was asked for "a new session for this, separate from you". It loaded `pitwall:pitwall` and ended its turn with a `spin-off` block.

## How a session proposes a session

Phil's question: "I think I want to be able to spawn new sessions from within an existing session." Whatever the way, D4 (the supervisor acts only after Phil's click, [`decisions.md`](../decisions.md)) and the security rules hold:

- A session never holds pitwall's token or apiKey, so whatever it does can only propose.
- The card, the checks (`checkSpawn()` in `supervisorActions.ts`, which the spin-off route already uses) and Start stay pitwall's. A proposal becomes a session only after Phil reads it and starts it in pitwall's UI, through New session's own request.

### The threat

Anything running as Phil can do whatever a session's proposal can do: write a transcript line, write a file under `~/.pitwall`, or make a local HTTP call. It can also skip pitwall altogether and run `claude --bg` with any prompt. So a proposal channel gives a local process nothing it doesn't already have, except one thing: a card in pitwall that looks like it came from one of Phil's sessions, which he may start because he trusts that session.

The risks that matter:

- **A steered session:** a session that read hostile text (an issue, a web page, a PR from someone else) proposes a harmful session.
- **A forged card:** a local process makes a card that looks like a session's.
- **A web page:** a site Phil visits reaches a local endpoint from his browser.
- **Flooding:** many proposals hide a real one.

In every way below, the defence against the first two is the same as W163's: the card shows the whole prompt, the folder and the name exactly, with anything that doesn't show as itself refused. The checks run before New session opens and again on Start, and nothing starts without the click.

### The three ways, and what each needs to reach pitwall

| | W163's `spin-off` block | A `pitwall` skill in the plugin | A tool the plugin provides (an MCP server, or a command in its `bin/`) |
| --- | --- | --- | --- |
| How it reaches pitwall | The session's transcript, which pitwall already reads behind its adapter | The same block: the skill is W163's under the plugin's name | It needs a new channel: an HTTP route, a file under `~/.pitwall`, or the inbox |
| Who it's from | The session whose transcript holds it, newest message only | The same | Whatever the caller claims. pitwall can't tell a session's call from any process's |
| New attack surface | None; built and reviewed (W163, W164's security review) | None | A new unauthenticated route or folder, read as untrusted, and its own review |
| pitwall down | The block waits in the transcript while it's the last message | The same | The call fails |
| Feedback to the session | None until the card. A folder outside the roots shows as refused on the card | The same | Immediate: the tool can say "not under a root" |
| Context and machine cost | The skill's listing, about 160 tokens | The same, already measured above | An MCP server is one more process in every session: with 15 to 20 sessions running, 15 to 20 Node processes. A `bin/` command costs nothing until it runs, but needs Bash and its permission |
| One turn | The block ends the turn, one proposal a turn | The same | Several, and the turn goes on |
| Installed | Today, a personal skill, which Phil declined to install on its own | With the plugin, once, beside the note that points at it | With the plugin |

**What each new channel would take:**

- **HTTP:** a route like `/mcp`, outside `/api/*`, with the `Host` check, any `Origin` refused (a browser always sends one on a cross-origin POST, so a web page can't reach it), and no token, since none can be given to a session. It would answer any local process. It could create only a card, and it would need rate and size limits.
- **A file under `~/.pitwall`:** a 0700 folder pitwall watches, each file read as untrusted, as the flag log and the snoozes are: a regular file of Phil's, not a link, bounded, each field checked. It's the same as HTTP, without the feedback.
- **The inbox:** a session has `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` in its environment, its Bash tool's included. pitwall would have to take messages in, which the relay and the supervisor both refuse today (W113's review: otherwise any session could start an Opus turn at Phil's expense). The wire format is internal (`AGENTS.md`: behind one adapter, failing soft). This is the weakest of the three.

### Recommendation

**The `spin-off` block, shipped as the plugin's `pitwall` skill (ways 1 and 2 together), with the `SessionStart` note pointing at it.**

- It needs no new route, no new file and no new review of a channel. It's attributed to the session whose transcript holds it, which a tool's call can't be. And it costs the skill's listing only.
- The plugin fixes what kept W163 from use: Phil wouldn't install a personal skill on its own, and every session now learns of it from the note.
- **What it doesn't give:** feedback before the card, and more than one proposal a turn. If daily use shows those matter, add a `bin/` command later that only checks a proposal, read-only (the folder under a root, the name, the characters) and says what's wrong. It wouldn't send anything to pitwall, so it could also run with pitwall down. The block stays the only way in.

## The prototype, end to end

1. **pitwall:** the worktree's `npm run build`, run with its own `PITWALL_HOME`, a fixed `PITWALL_TOKEN`, `--port 4655 --no-open --no-prs --no-recaps --no-supervisor`, and a config with one root. `server.json` was written by hand into that home, since pitwall doesn't write it yet.
2. **The session:** an interactive session in the root's throwaway repo, with the plugin installed there and `PITWALL_HOME` in its environment. It got the note.
3. **The proposal:** asked for "a new session for this, separate from you … named `pitwall-test-015-spawned`, it should create hello.txt", it loaded `pitwall:pitwall` and ended its turn with a `spin-off` block (finding 8).
4. **The card:** within a poll, pitwall's `/api/snapshot`, read with the token, had `spinOff: { kind: 'proposal', folder, name, prompt }` on that session.
5. **The check:** a script signed in as the page does (the WebSocket's challenge and HMAC, then the apiKey and `Origin`), POSTed the proposal's key to `spinOffPath()` and got 200, with the folder by its real path.
6. **Start:** the script POSTed that to `SPAWN_PATH` with `model: 'haiku'` and got 201. `pitwall-test-015-spawned` started as a background session in the folder. It stopped to ask before writing the file, because of Phil's own `AGENTS.md`. Both sessions were then stopped and removed.

No pitwall code changed. The only new piece W176 needs on pitwall's side is `server.json`.

## What was installed and removed

- **Installed at project scope**, in `scratch/spike015/root/demo/.claude/settings.json` only: a directory marketplace, `pitwall-spike015`, pointing at a copy of the plugin in `scratch/`, and `pitwall@pitwall-spike015`. Removed with `claude plugin uninstall pitwall@pitwall-spike015 --scope project` and `claude plugin marketplace remove pitwall-spike015`.
- **Left behind by Claude Code, then removed by hand:** `~/.claude/plugins/cache/pitwall-spike015/`, which uninstall marked with `.orphaned_at` but didn't delete, and the empty `~/.claude/plugins/data/pitwall-inline/`, which `--plugin-dir` created.
- **Checked unchanged** against copies taken before the install: `~/.claude/plugins/installed_plugins.json`, `known_marketplaces.json`, `blocklist.json`, the `marketplaces/` and `data/` folders, and `~/.claude/settings.json` (same SHA-1).
- **Left in place:** the throwaway folder's entry in `~/.claude.json`. The trust prompt was accepted and external `CLAUDE.md` imports declined for it, since an interactive session needs a trusted folder.

## Not verified

- **Auto-compaction.** Only `/compact` was run. The hooks reference gives both the same `compact` source.
- **A background session with the note.** Its environment kept the test pitwall's `server.json` out of reach (finding 3), and writing `~/.pitwall/server.json` would have touched Phil's pitwall home. That the hook ran there, and found no file, was confirmed with an environment probe in the scratch copy.
- **`--fork-session`.** It wasn't run; the matcher includes `fork` from the hooks reference.
- **Plugin MCP servers' environment.** The memory and process count per session for the tool way are from how stdio MCP servers run (one process per session), not measured.
- **Session names.** The interactive throwaway sessions, started with `--name pitwall-test-015-*`, were listed by pitwall under an unrelated title, "mcp events asset audit". That probably came from a title something in Phil's setup gave them. It wasn't looked into, since it isn't the plugin's.
