# Spike 004: which repos a session works in

Run on 2026-10-20 against Claude Code 2.1.303 on macOS, for W33, read-only. The sessions are every session pitwall lists under Phil's root (the folder that holds his work repos), live and recently finished, through pitwall's own adapter (`claude agents --json --all`): 15 sessions, 14 of them with a readable transcript. Of those 14, seven started in the root itself and seven inside a repo. One of the seven started in the root is the coordinator session that ran this spike, so its sub-agent transcripts include the spike's own commands.

No session was messaged, attached to, stopped or started, and nothing from a session was written to disk. The measurement script is [`004-repo-grouping.mjs`](004-repo-grouping.mjs). It holds no data and only reads. The judged repos were passed to it as an argument.

## Questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Which repos under the root do a session's tool calls touch, and what does each signal add? | File tools find 20 of the 89 session-repo pairs; Bash and GitHub find the rest (findings 1 and 2) |
| 2 | How many repos does each session touch? | Raw touches spread wide: 12 of 14 touch three or more. Under the recommended rule, 5 sessions show under three or more (finding 3) |
| 3 | Does the mapping match the title and first prompt? | The top repo matches in 12 of 14 sessions; the other 2 name no repo (finding 4) |
| 4 | Which rule? | A change, or at least 5% of the session's tool calls, over the whole transcript: 1 false positive and 3 misses on 28 repos (findings 5 to 7) |
| 5 | Do sub-agent transcripts matter? | Yes. They hold 44% of all tool calls, and two sessions changed a repo only through a sub-agent (finding 8) |
| 6 | What does it cost? | Reading is cheap (723 MiB in 1.8 s); git is not: once per directory, it took 25.6 s. Mapping at repo boundaries takes 2.4 s (finding 9) |
| 7 | What to build? | A `workedIn` list on each session summary, kept by a background scanner that the poll never waits on (Recommendation) |

## Method

- **Sessions:** the 15 rows of `claude agents --json --all` whose cwd is under the root, through `createAgentsSource`, with transcripts found by `createTranscriptReader`. The one without a transcript is a stale background job.
- **Reading:** every main transcript and every sub-agent transcript beside it, in full.
  - Only lines containing `"type":"tool_use"` are parsed: 28% of all lines.
  - Each `tool_use` block becomes one call, with its tool, input, timestamp and the entry's `cwd`.
- **Signals, per call:**
  - **file:** the path of a Read, Edit, Write, MultiEdit or NotebookEdit call, and of Grep and Glob, though no Grep or Glob call appears in any transcript.
  - **cwd:** the entry's own `cwd` field: the shell's working directory at that call. It follows `cd`, needs no parsing, and wasn't on the original list.
  - **cd:** the targets of `cd`, `pushd` and `git -C` in Bash and Monitor commands. A small shell lexer finds them, dropping here-document bodies and the values of `-m`, `--body` and `--title`.
  - **abs:** any other absolute or `~` path in a command.
  - **rel:** relative words in a command that contain `/`, or follow `ls`, `cat`, `find`, `rg`, `grep` and the like. Each is kept only if the path exists.
  - **gh:** GitHub repos named in a call, matched to a local repo by its remotes (`git remote -v`), and by directory name when several clones share a remote. The sources:
    - `gh ... --repo` or `-R`;
    - `gh api repos/<owner>/<name>`;
    - github.com URLs in `gh` and `git clone` commands, and in `WebFetch`;
    - the GitHub MCP tools' `owner` and `repo`.
- **Mapping:** each path goes to its nearest existing directory, then through `createGroupResolver`, so a worktree maps to its main repo and a submodule to its own top level.
  - A path under a top-level directory of the root that no longer exists counts as a missing repo.
  - Paths outside the root are counted by place (`~/.claude`, temp directories, other home directories, system paths) and ignored, unless they're a worktree or clone of a repo under the root.
- **Changes:**
  - an Edit, Write, MultiEdit or NotebookEdit changes the file's repo;
  - `git commit` or `git push` changes the `cd` or `git -C` target, or the shell's cwd when there's none;
  - `gh pr create` or `gh pr merge` changes the repo it names.
- **Judging (questions 3 and 4):** for each session I read its title, its first prompt and the calls behind each repo it touched, in my own context only. A session works in a repo if:
  - it changed the repo; or
  - the task is about the repo: named in the prompt, or investigated as the deliverable.

  Reading a repo for reference while working elsewhere doesn't count. That gives 28 repos to find beyond the sessions' start groups.
- **Caveat:** one person judged them, and the rules were compared on the same 14 sessions, so treat the scores as a guide, not a measurement. The rule caught one judging error of mine: I had first marked a repo as reference, but the session had opened a draft PR there from a scratchpad worktree.

## Findings

1. **Bash carries the signal, and file tools alone find under a quarter of it.**
   - **The calls:** 16,354 tool calls, 81% of them Bash. Read, Write and Edit make up 11%.
   - **No Grep or Glob:** neither appears in any transcript. Searching runs through Bash.

   | Signal | Calls naming a repo under the root | Session-repo pairs | Pairs beyond file tools | Pairs found by it alone |
   | --- | --- | --- | --- | --- |
   | file | 586 | 20 | - | - |
   | cwd | 11,704 | 39 | 25 | 0 |
   | cd (`cd`, `pushd`, `git -C`) | 2,917 | 71 | 52 | 3 |
   | abs | 290 | 51 | 33 | 5 |
   | rel | 3,841 | 63 | 45 | 2 |
   | gh | 524 | 50 | 33 | 10 |
   | Every signal | | 89 | 69 | |

   - **File tools alone** leave 4 of the 7 sessions started in the root under no repo at all.
   - **cwd** never finds a repo on its own, because every change of cwd comes from a `cd` the parser also sees. But it carries the volume, and it costs nothing: it's in every entry.
   - **gh is the only trace of some work.** It covers PRs opened from a clone or worktree in a session's scratchpad that has since been removed, and read-only GitHub checks. One session's whole task, checking CI across three repos named in its prompt, shows mostly through it.
   - **abs and rel are noisy.** They produced 18,848 relative words that named nothing on disk and 486 absolute words that weren't paths. Under the recommended rule they add nothing (finding 6).
   - **Sub-agents need cd.** 109 of 111 sub-agent transcripts record a single `cwd` for every entry, because an agent's shell resets between calls. So their work in other repos shows only in `cd` and `git -C` targets. Main transcripts move: 11 of 14 record several directories.
   - **gh matching:** 308 GitHub references named repos not cloned under the root, and 176 matched more than one local clone.

2. **Nearly half the paths are outside the root.**
   - **The share:** of 12,153 calls that name a path, leaving cwd aside, 5,681 (47%) name only places outside the root.
   - **By place:**
     - other home directories: 3,073 calls;
     - temp directories and scratchpads: 2,580;
     - system paths, mostly `/dev/null`: 2,240;
     - `~/.claude`: 321.
   - **Nothing mapped back** to a repo under the root through a worktree or clone: the scratchpad worktrees had already been removed.
   - **Repos that no longer exist:** 12 session-repo pairs (277 calls) point to repos and worktrees under the root that have since been deleted, so git can't place them. The rules ignore them.
   - **Plain directories:** no pair is a plain, non-git directory under the root.

3. **Raw touches spread wide; the rule keeps a few repos per session.** Repos per session, counting a session's own start repo:

   | | None | One | Two | Three or more |
   | --- | --- | --- | --- | --- |
   | Any touch, file tools only: started in the root (7) | 4 | 1 | 2 | 0 |
   | Any touch, file tools only: started in a repo (7) | 0 | 3 | 1 | 3 |
   | Any touch, every signal: started in the root | 0 | 0 | 1 | 6 |
   | Any touch, every signal: started in a repo | 0 | 1 | 0 | 6 |
   | Recommended rule: started in the root | 1 | 0 | 3 | 3 |
   | Recommended rule: started in a repo | 0 | 3 | 2 | 2 |

   - **"None" under the rule:** the coordinator session, which works mostly outside the root.
   - **The most:** one 2.5-month session shows under 6 repos.

4. **The mapping agrees with the title and first prompt.**
   - **Top repo:** in 12 of 14 sessions, the repo with the most calls is the one the title or first prompt is about or names.
   - **The other 2 name no repo:**
     - one continues a handoff, in the repo its start directory was renamed to mid-session, so its cwd no longer exists;
     - the other is the coordinator, whose work is mostly outside the root.
   - **Mismatches beyond the top repo, by kind:**
     - **Scope growth (5 sessions):** the session went on to change repos its title doesn't mention. Claude Code sets the title once, from the first prompt, so the mapping is right and the title is stale.
     - **Reference reads (9 sessions):** repos read to support work elsewhere, up to 100 calls in one session.
     - **Reached only through GitHub (1 session):** most of its named repos appear only in `gh` calls.

5. **Call counts don't separate reference reads from real work; a repo's share of the session's calls does.**
   - **Counts overlap:** a repo read for reference got 100 calls in one long session, while a repo that was the point of a short investigation got 2 in another.
   - **Thresholds compared:** the recommended signals (file, cwd, cd, gh) over the whole transcript, sub-agents included, no cap. 28 repos to find; "exact" counts sessions with no false positive and no miss.

   | Threshold | Shown | False positives | Misses | Exact (of 14) |
   | --- | --- | --- | --- | --- |
   | Any touch | 68 | 40 | 0 | 5 |
   | At least 3 calls | 53 | 27 | 2 | 3 |
   | At least 5 calls | 43 | 18 | 3 | 3 |
   | At least 10 calls | 32 | 11 | 7 | 5 |
   | A change, or at least 10 calls | 32 | 11 | 7 | 5 |
   | A change | 20 | 1 | 9 | 9 |
   | At least 5% of the session's calls | 21 | 0 | 7 | 8 |
   | A change, or at least 2% | 30 | 4 | 2 | 9 |
   | **A change, or at least 5%** | **26** | **1** | **3** | **10** |
   | A change, or at least 10% | 25 | 1 | 4 | 10 |

   - **Changes are precise:** they make 1 false positive in 20, but miss investigations, which change nothing.
   - **Share catches investigations:** they happen in short sessions, where every repo touched has a large share. In an 11-call session, one call is 9%.
   - **The optimum is flat** from 5% to 10%. A share counted only over calls under the root scores the same on every row.

6. **cd and gh earn their place; abs and rel don't.** Each signal set over the whole transcript, with "a change, or at least 5%" unless marked:

   | Signals | Shown | False positives | Misses | Exact |
   | --- | --- | --- | --- | --- |
   | file | 9 | 0 | 19 | 5 |
   | file, cwd | 18 | 0 | 10 | 7 |
   | file, cwd, gh | 23 | 0 | 5 | 9 |
   | file, cwd, gh, at 2% | 24 | 0 | 4 | 10 |
   | file, cwd, cd, abs, rel: no gh | 24 | 1 | 5 | 9 |
   | **file, cwd, cd, gh** | **26** | **1** | **3** | **10** |
   | Every signal | 26 | 1 | 3 | 10 |
   | Every signal, at 2% | 31 | 4 | 1 | 10 |

   - **abs and rel:** they add nothing over cd and gh.
   - **file, cwd and gh at 2%** scores as well as the recommended set, with no shell parsing beyond `gh`. cd still matters for sub-agents (finding 1), and here it found one more repo for one more false positive.

7. **Recency windows trade misses for precision, and windows counted from now erase idle sessions.** The best rule found for each window:

   | Window | Shown | False positives | Misses |
   | --- | --- | --- | --- |
   | Whole transcript | 24 to 26 | 0 to 1 | 3 to 4 |
   | Last 500 calls | 23 | 2 | 7 |
   | Last 200 calls | 17 | 0 | 11 |
   | Last 7 days of the session's own activity | 16 | 0 | 12 |
   | Last 3 days of the session's own activity | 17 | 2 | 13 |
   | Last 7 days from now | 4 | 0 | 24 |

   - **Windows from now:** most sessions had been idle for days, so their repos vanish.
   - **Last K calls:** this drops older work that was real, such as a PR made a month before in a long session.
   - **A cap of 3** (the recommended rule, most calls first): 22 shown, 0 false positives, 6 misses. The cap adds 3 misses, all in the two sessions with four or more repos, and drops the one false positive.

8. **Sub-agent transcripts matter.**
   - **Where they are:** separate files beside the main transcript, at `~/.claude/projects/<project>/<session id>/subagents/agent-<id>.jsonl`. Each has an `agent-<id>.meta.json` with the agent type and description.
   - **The sidechain flag:** every entry in them has `isSidechain: true`, and no main transcript has a sidechain entry.
   - **Their size:** 10 of 14 sessions have them: 111 files and 392 MiB, more than the 331 MiB of main transcripts. They make 7,196 of the 16,354 calls (44%).
   - **What they add:** 7 of the 89 pairs. Under the recommended rule they change the result for three sessions:
     - two gain a repo that only a sub-agent changed, such as a docs PR from a worktree;
     - one loses a repo, because its 3,465 sub-agent calls, mostly outside the root, dilute that repo's share.
   - **Score:** with them, 1 false positive and 3 misses; without them, 1 and 4.

9. **Reading is cheap; resolving every directory with git is not.**
   - **Sizes:** main transcripts are a median 16.5 MiB (p90 60.5 MiB, max 79.4 MiB, 331 MiB for 14). Sub-agent transcripts add 392 MiB.
   - **A full scan:** 723 MiB in 1.8 s, with a median of 51 ms and a max of 224 ms per main transcript. The page cache was warm.
   - **Mapping per directory:** 1,006 distinct directories took 25.6 s, because `createGroupResolver` runs one or two git processes for each.
   - **Mapping per repo boundary:** walking up to the nearest `.git` and running git only there took 1,158 stats and 96 git resolves, in 2.4 s. It gave the same group for 996 of 1,006 directories.
   - **Remotes for gh:** about 3 s, for `git remote -v` in every repo under the root.
   - **The existing reader's window doesn't fit.** The last 200 calls start a median 4.2 MiB from the end of a transcript (max 24 MiB). Its first 256 KiB holds a median of 11 calls, and 2 MiB holds 82.
   - **An incremental scan:** 60 s after a full scan, re-reading from the remembered offsets stat'd 125 files. One had grown (the coordinator's, from this spike), and it read 396 KiB with 8 new calls, in 10 ms in all.

10. **Failing soft works with what's there.**
    - **No transcript:** the stale background job has none anywhere under `~/.claude/projects`, so it stays in its start group.
    - **A missing start directory:** the session that renamed its own start directory still lands under the repo it works in.

## Recommendation

### The rule

Show a session under a repo when, over its whole transcript and its sub-agents' transcripts:

- **it changed the repo:** an Edit, Write, MultiEdit or NotebookEdit on a file there, a `git commit` or `git push` there, or a `gh pr create` or `gh pr merge` naming it; or
- **at least 5% of its tool calls touched it.**

The details:

- **Signals:**
  - file tool paths;
  - each entry's `cwd`;
  - `cd`, `pushd` and `git -C` targets;
  - GitHub repos named in `gh` commands, GitHub URLs and the GitHub MCP tools, matched to local repos by remote.
- **Left out:** other absolute and relative paths in commands.
- **Never shown:** the root itself, anything outside the roots, or a repo that no longer exists.
- **Order and cap:** newest touch first, with no cap.

On these sessions it shows 26 repos beyond the start groups:

- **1 false positive:** a command that started with `cd` into one repo, to remove an old worktree, before committing work for another. The command can't tell where the commit landed.
- **3 misses:** two repos touched by one or two calls in short investigations, at 3% and 4%; and one repo in the coordinator session, at under 1%.

### What to build (W34)

- **A scanner module,** `src/index/workedIn.ts`, behind the transcript adapter, failing soft like the rest of it.
  - **The poll reads its results synchronously,** like `lastMessage`, and never waits on a scan, so the 5 s poll keeps its 0.2 to 1.3 s.
  - **First sight of a session:** queue a full scan of its main and sub-agent transcripts, one file at a time, yielding between chunks. Until it finishes, the session has no `workedIn` and shows only in its start group.
  - **Every poll after that:** stat each known file, `readdir` the `subagents` directory for new ones, and read only what was appended. That's about 10 ms.
- **What to cache, in memory only:**
  - **Per file:** `{ dev, ino, offset, carry }`. Resume from the offset when `dev` and `ino` match and the file hasn't shrunk; otherwise rescan from 0. Size and mtime alone can't resume a read.
  - **Per session:** per group `{ calls, changes, lastAt }` and the session's call total. Keep no paths.
  - **Per directory:** its group, found by walking up to the nearest `.git` and running git only at that boundary. Remotes for gh matching come from the same repos. Both refresh on the resolver's TTL.
  - **Nothing on disk:** paths and repo names are session content. So the full scan repeats at every start: about 2 s of reading and 2 to 3 s of git, off the poll.
- **A contract field** (the coordinator's call) on `SessionSummary`:

  ```ts
  /**
   * Repos under a root that this session worked in, beyond its own group,
   * newest first (spike 004). Absent until its transcripts have been
   * scanned, and when they can't be read.
   */
  workedIn?: WorkedIn[];

  export interface WorkedIn {
    /** The configured root. */
    root: string;
    /** The group's key, as SessionGroup.key. */
    key: string;
    /** Tool calls that touched it, sub-agents included. */
    calls: number;
    /** Edits, commits, pushes and PRs in it. */
    changes: number;
    /** ISO 8601: the newest touch. */
    lastAt: string;
  }
  ```

- **The repo list:**
  - **Where a session shows:** under its start group and under every `workedIn` group. The UI can tell the two apart by checking the group's key against `workedIn`, so groups need no new field.
  - **New groups:** a repo that only appears through `workedIn` gets a group like any other.
  - **Counts:** a repo's count is the number of distinct sessions under it. Repo counts can add up to more than the number of sessions; All sessions shows the true total.
  - **Needs-you badges:** a repo's badge counts every session under it that needs Phil, so one such session raises the badge in each of its repos.
  - **Needs you and All sessions** list each session once, deduplicated by `sessionId`.
  - **The root's own directory:** either it keeps every session started there, or it lists only those with no `workedIn` repo. The first is simpler, but it stays the biggest group: 7 of 15 sessions today. The second makes it an "unsorted" group: 1 of those 7 today. Lean: the second. It's Phil's call (open questions).
- **Failure:** a missing or unreadable transcript, a scan error, or no repo passing the rule leaves `workedIn` absent, and the session sits in its start group alone. A scan error never fails a poll.

## Open questions

- **The root's group:** every session started in the root, or only those with no `workedIn` repo? Phil's call.
- **Ageing:** should a repo drop off a long session's list once its last touch is old, measured against the session's own last activity? A 7-day window cost 12 misses here, so not by default. The longest session (2.5 months) shows under 6 repos, one last touched 52 days ago.
- **The threshold:** 5% fits 14 sessions judged by one person. Check it again after a week of use; 10% gives one more miss and no fewer false positives.
- **Deleted worktrees:** they can't be mapped from history. A live scanner resolves them while they exist, but at pitwall's start they're gone. Accept that, or match a missing directory to a repo by its name (such as `<repo>-<suffix>`)? Not measured.
- **Several roots:** a session under one root that works in another root's repos. Show it there? Not measured, with one root here.
