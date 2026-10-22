import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, rename, rm, stat, truncate as truncateFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConversationEntry, ConversationPage } from '../shared/protocol.js';
import {
  ConversationCursorError,
  ENTRY_TEXT_MAX,
  isWellFormedCursor,
  LEAN_TEXT_MAX,
  NOTICE_MAX,
  PAGE_ENTRIES,
  PAGE_READ_BUDGET,
  PAGE_TEXT_BUDGET,
  readConversationPage,
  RELAY_ADDRESSES_MAX,
  RelayAddressBook,
  toolSummary,
  type ConversationReadOptions,
} from './conversation.js';
import { RELAY_NAME } from '../server/relayPrompt.js';
import { RELAY_SESSION_NAME } from '../../web/src/relayName.js';

// Synthetic transcripts only, shaped like Claude Code 2.1.301's JSONL. No real content.

const SID = 'pitwall-test-session';
let clock = Date.parse('2026-10-16T10:00:00.000Z');
function nextTimestamp(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

function user(content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'user', isSidechain: false, timestamp: nextTimestamp(), message: { role: 'user', content }, ...extra };
}

function assistant(blocks: unknown[], id = 'msg_a', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'assistant',
    isSidechain: false,
    timestamp: nextTimestamp(),
    message: { id, role: 'assistant', model: 'test-model', content: blocks },
    ...extra,
  };
}

const text = (t: string) => ({ type: 'text', text: t });
const thinking = (t: string) => ({ type: 'thinking', thinking: t, signature: 'sig' });
const toolUse = (id: string, name: string, input: unknown = {}) => ({ type: 'tool_use', id, name, input });
function toolResult(id: string, isError?: boolean): Record<string, unknown> {
  const block: Record<string, unknown> = { type: 'tool_result', tool_use_id: id, content: 'the tool output' };
  if (isError !== undefined) block.is_error = isError;
  return user([block]);
}

/** A line the reader ignores, to pad files out. Roughly `bytes` long. */
function filler(bytes: number): Record<string, unknown> {
  return { type: 'attachment', timestamp: nextTimestamp(), attachment: { type: 'note', body: 'x'.repeat(Math.max(0, bytes - 90)) } };
}

function jsonl(...entries: unknown[]): string {
  return entries.map((e) => `${JSON.stringify(e)}\n`).join('');
}

let tmp: string;
let fileCounter = 0;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-conversation-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function transcript(content: string | Buffer): Promise<string> {
  const file = path.join(tmp, `t${fileCounter++}.jsonl`);
  await writeFile(file, content);
  return file;
}

async function page(file: string, before?: string, options?: ConversationReadOptions): Promise<ConversationPage> {
  const result = await readConversationPage(file, SID, before, options);
  if (!result) throw new Error('no page');
  return result.page;
}

/** Every page from newest to oldest, and their entries joined oldest first. */
async function allPages(file: string, options?: ConversationReadOptions) {
  const pages: ConversationPage[] = [];
  const bytes: number[] = [];
  let before: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const result = await readConversationPage(file, SID, before, options);
    if (!result) throw new Error('no page');
    pages.push(result.page);
    bytes.push(result.stats.bytesRead);
    before = result.page.before;
    if (before === undefined) break;
  }
  const entries = [...pages].reverse().flatMap((p) => p.entries);
  return { pages, entries, bytes };
}

async function entriesOf(...lines: unknown[]): Promise<ConversationEntry[]> {
  return (await page(await transcript(jsonl(...lines)))).entries;
}

describe('readConversationPage: what becomes an entry', () => {
  it('reads a typed prompt as a user entry, with system reminders stripped and nothing else', async () => {
    const at = nextTimestamp();
    const prompt = { ...user('<system-reminder>harness note</system-reminder>\nPlease fix the **flaky** test in `src/a.ts`'), timestamp: at };
    expect(await entriesOf(prompt)).toEqual([{ kind: 'user', at, text: 'Please fix the **flaky** test in `src/a.ts`' }]);
  });

  it('keeps a prompt as typed: its markdown, indents, runs of spaces and blank lines, losing only blank lines before it and whitespace after it', async () => {
    const typed = '  Two spaces first.\n\n\n\n    indented   by four,   with runs\n\t- a tab\n```\n[code] and # not a heading\n```\n| a | b |\n|---|---|';
    const [entry] = await entriesOf(user(`<system-reminder>note</system-reminder>\n \n${typed}  \n\n`));
    expect(entry).toEqual({ kind: 'user', at: expect.any(String), text: typed });
    expect(entry?.markdown).toBeUndefined();
  });

  it('reads text blocks and images as one prompt', async () => {
    const entries = await entriesOf(user([text('look at this'), { type: 'image', source: {} }, { type: 'image', source: {} }]));
    expect(entries).toMatchObject([{ kind: 'user', text: 'look at this\n\n[2 images]' }]);
    expect(await entriesOf(user([{ type: 'image', source: {} }]))).toMatchObject([{ kind: 'user', text: '[1 image]' }]);
  });

  it('leaves out meta entries, caveats, reminders alone, sidechains, other types and lines that do not parse', async () => {
    const entries = await entriesOf(
      user('skill instructions', { isMeta: true }),
      user('Caveat: the messages below were generated by the user while running local commands.'),
      user('<system-reminder>only a reminder</system-reminder>'),
      user('a sidechain prompt', { isSidechain: true }),
      assistant([text('a sidechain reply')], 'msg_side', { isSidechain: true }),
      { type: 'summary', summary: 'x' },
      { type: 'last-prompt', lastPrompt: 'x' },
      // Claude Code's internal request log names a system prompt and roles.
      { type: 'api-request', request: { system: 'x', messages: [{ role: 'user', content: 'not a prompt' }] } },
      filler(200),
      'not json at all',
      user('the only prompt'),
    );
    expect(entries.map((e) => e.text)).toEqual(['the only prompt']);
  });

  it('joins text blocks from the same assistant message, written on separate lines, and leaves thinking out', async () => {
    const first = assistant([text('First part.')], 'msg_1');
    const entries = await entriesOf(
      assistant([thinking('secret reasoning')], 'msg_1'),
      first,
      assistant([thinking('more reasoning')], 'msg_1'),
      assistant([text('Second part.')], 'msg_1'),
      assistant([text('Another message.')], 'msg_2'),
    );
    expect(entries).toEqual([
      { kind: 'assistant', at: first.timestamp, text: 'First part.\n\nSecond part.', markdown: true },
      { kind: 'assistant', at: expect.any(String), text: 'Another message.', markdown: true },
    ]);
    expect(JSON.stringify(entries)).not.toContain('reasoning');
  });

  it('keeps text, a tool call and more text from one message in file order', async () => {
    const entries = await entriesOf(
      assistant([text('Looking.')], 'msg_1'),
      assistant([toolUse('toolu_1', 'Read', { file_path: '/w/a.ts' })], 'msg_1'),
      toolResult('toolu_1'),
      assistant([text('Found it.')], 'msg_1'),
    );
    expect(entries.map((e) => [e.kind, e.text])).toEqual([
      ['assistant', 'Looking.'],
      ['tool', 'Read: /w/a.ts'],
      ['assistant', 'Found it.'],
    ]);
  });

  it('reads several blocks on one line, as older versions wrote them', async () => {
    const entries = await entriesOf(
      assistant([thinking('x'), text('One.'), text('Two.'), toolUse('toolu_1', 'Bash', { command: 'ls' }), toolUse('toolu_2', 'Grep', { pattern: 'TODO' })]),
      user([
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a' },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'b', is_error: true },
      ]),
    );
    expect(entries).toMatchObject([
      { kind: 'assistant', text: 'One.\n\nTwo.' },
      { kind: 'tool', text: 'Bash: ls', toolName: 'Bash', toolError: false },
      { kind: 'tool', text: 'Grep: TODO', toolName: 'Grep', toolError: true },
    ]);
  });

  it('collapses a tool call and its result into one entry at the call, with the error from the result', async () => {
    const call = assistant([toolUse('toolu_ok', 'Bash', { command: 'npm test' })]);
    const entries = await entriesOf(
      call,
      toolResult('toolu_ok'),
      assistant([toolUse('toolu_bad', 'Bash', { command: 'false' })]),
      toolResult('toolu_bad', true),
      assistant([toolUse('toolu_running', 'Bash', { command: 'sleep 100' })]),
    );
    expect(entries).toEqual([
      { kind: 'tool', at: call.timestamp, text: 'Bash: npm test', toolName: 'Bash', toolError: false },
      { kind: 'tool', at: expect.any(String), text: 'Bash: false', toolName: 'Bash', toolError: true },
      // No result yet: still running, or interrupted.
      { kind: 'tool', at: expect.any(String), text: 'Bash: sleep 100', toolName: 'Bash' },
    ]);
    expect(JSON.stringify(entries)).not.toContain('the tool output');
  });

  it('drops a result whose call is not in the transcript', async () => {
    expect(await entriesOf(toolResult('toolu_orphan', true), user('after'))).toEqual([
      expect.objectContaining({ kind: 'user', text: 'after' }),
    ]);
  });

  it('reads a cross-session message, with the sender and the message inside the tag', async () => {
    const entries = await entriesOf(
      user(
        'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="pitwall-test-sup" from-mode="prompting">Please **review** PR 4.</cross-session-message>\nThis came from another Claude session - not typed by your user.',
        { isMeta: true, origin: { kind: 'peer' } },
      ),
    );
    expect(entries).toEqual([{ kind: 'cross-session', at: expect.any(String), text: 'Please **review** PR 4.', markdown: true, from: 'pitwall-test-sup' }]);
  });

  it("reads newer Claude Code's agent-message form, whose from is the sender", async () => {
    const entries = await entriesOf(
      user('Another Claude session sent a message:\n<agent-message from="b3899da0">ping <with> angle brackets</agent-message>\nharness note', {
        isMeta: true,
        origin: { kind: 'peer' },
      }),
    );
    expect(entries).toMatchObject([{ kind: 'cross-session', text: 'ping <with> angle brackets', from: 'b3899da0' }]);
  });

  it('leaves the sender out when all it has is a socket address, and decodes entities in names', async () => {
    const [noName, named] = await entriesOf(
      user('Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/9.sock">hi</cross-session-message>', {
        isMeta: true,
      }),
      user('Another Claude session sent a message:\n<agent-message from="R&amp;D &quot;bot&quot;">hello</agent-message>', { isMeta: true }),
    );
    expect(noName).toEqual({ kind: 'cross-session', at: expect.any(String), text: 'hi', markdown: true });
    expect(named).toMatchObject({ from: 'R&D "bot"', text: 'hello' });
  });

  it('reads a peer entry with no prefix or tag as a cross-session message', async () => {
    expect(await entriesOf(user('[Cross-session idle notice] the session is idle now', { isMeta: true, origin: { kind: 'peer' } }))).toMatchObject([
      { kind: 'cross-session', text: '[Cross-session idle notice] the session is idle now' },
    ]);
  });

  it('turns compaction, task notifications, local commands and shell commands into short notices', async () => {
    const entries = await entriesOf(
      user('This session is being continued from a previous conversation. '.repeat(50), { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      user('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "Run tests" completed (exit code 0)</summary>\n</task-notification>', {
        origin: { kind: 'task-notification' },
      }),
      user('<task-notification><task-id>b2</task-id><status>failed</status></task-notification>'),
      user('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'),
      user('<local-command-stdout>Set model to opus</local-command-stdout>'),
      { type: 'system', subtype: 'local_command', content: '<local-command-stdout>Context: 12% used</local-command-stdout>', timestamp: nextTimestamp() },
      user('<local-command-stdout></local-command-stdout>'),
      user('<bash-input>git status</bash-input>'),
      user('<bash-stdout>On branch main</bash-stdout><bash-stderr>warning: x</bash-stderr>'),
      user('<bash-stdout></bash-stdout><bash-stderr></bash-stderr>'),
      user([text('[Request interrupted by user for tool use]')]),
      { type: 'system', subtype: 'turn_duration', durationMs: 5, timestamp: nextTimestamp() },
      { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: nextTimestamp() },
    );
    expect(entries.map((e) => [e.kind, e.text])).toEqual([
      ['notice', 'Conversation compacted: Claude continued from a summary of the earlier conversation.'],
      ['notice', 'Background command "Run tests" completed (exit code 0)'],
      ['notice', 'Task failed'],
      ['notice', '/model opus'],
      ['notice', 'Set model to opus'],
      ['notice', 'Context: 12% used'],
      ['notice', '! git status'],
      ['notice', 'On branch main\nwarning: x'],
      ['notice', '[Request interrupted by user for tool use]'],
    ]);
  });

  it('keeps notices short, and does not strip markdown from them', async () => {
    const [long, raw] = await entriesOf(
      user(`<local-command-stdout>${'output '.repeat(200)}</local-command-stdout>`),
      user('<bash-stdout>__init__.py *.ts</bash-stdout>'),
    );
    expect(long?.text.length).toBeLessThanOrEqual(NOTICE_MAX);
    expect(long?.text.endsWith('…')).toBe(true);
    expect(long?.truncated).toBe(true);
    expect(raw).toMatchObject({ text: '__init__.py *.ts' });
    expect(raw?.truncated).toBeUndefined();
  });

  it("shows Claude Code's API error messages as notices", async () => {
    expect(await entriesOf(assistant([text('API Error: 529 overloaded')], 'msg_err', { isApiErrorMessage: true }))).toMatchObject([
      { kind: 'notice', text: 'API Error: 529 overloaded' },
    ]);
  });

  it("sends Claude's markdown as written, flagged as markdown, with HTML and anything else left as text", async () => {
    const markdown = [
      '## Summary',
      '',
      'The **export** job *retries*, ~~once~~ three times. See [the docs](https://example.com/docs) or <https://example.com>.',
      '',
      '```ts',
      'const delays = [1, 4, 16]; // `seconds`',
      '```',
      '',
      '| Attempt | Wait |',
      '|:---|---:|',
      '| 1 | 1 s |',
      '',
      '- one',
      '  1. nested',
      '> quoted <b>not bold</b> <img src=x onerror=alert(1)>',
      '',
      '---',
      '\\*escaped\\* [code] · joined',
    ].join('\n');
    const [entry, rule] = await entriesOf(assistant([text(`\n${markdown}\n\n`)], 'msg_md'), assistant([text('---')], 'msg_rule'));
    expect(entry).toEqual({ kind: 'assistant', at: expect.any(String), text: markdown, markdown: true });
    // A thematic break alone is markdown too, not an empty entry.
    expect(rule).toMatchObject({ kind: 'assistant', text: '---', markdown: true });
  });

  it("sends another session's message as markdown, as written", async () => {
    const body = 'Please check:\n\n```sh\nnpm test\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    expect(await entriesOf(user(`Another Claude session sent a message:\n<agent-message from="pitwall-test-peer">\n${body}\n</agent-message>`, { isMeta: true }))).toEqual([
      { kind: 'cross-session', at: expect.any(String), text: body, markdown: true, from: 'pitwall-test-peer' },
    ]);
  });

  it('leaves tool calls and notices as they were, with no markdown flag', async () => {
    const entries = await entriesOf(
      assistant([toolUse('toolu_md', 'Bash', { command: 'echo "**not bold**"' })]),
      toolResult('toolu_md'),
      user('<local-command-stdout>**Context** `12%`</local-command-stdout>'),
    );
    expect(entries).toEqual([
      { kind: 'tool', at: expect.any(String), text: 'Bash: echo "**not bold**"', toolName: 'Bash', toolError: false },
      { kind: 'notice', at: expect.any(String), text: '**Context** `12%`' },
    ]);
  });

  it('caps an entry at 32 KiB, marked truncated, as the start of what was written', async () => {
    const source = `**bold** ${'word '.repeat(8000)}`;
    const [long, prompt, peer] = await entriesOf(
      assistant([text(source)], 'msg_long'),
      user(source),
      user(`Another Claude session sent a message:\n<agent-message from="x">${source}</agent-message>`, { isMeta: true }),
    );
    expect(ENTRY_TEXT_MAX).toBe(32 * 1024);
    for (const entry of [long, prompt, peer]) {
      expect(entry?.text).toBe(source.slice(0, ENTRY_TEXT_MAX));
      expect(entry?.truncated).toBe(true);
    }
    // One that fits isn't marked.
    expect((await entriesOf(assistant([text('a'.repeat(ENTRY_TEXT_MAX))], 'msg_fits')))[0]).toEqual({
      kind: 'assistant',
      at: expect.any(String),
      text: 'a'.repeat(ENTRY_TEXT_MAX),
      markdown: true,
    });
  });

  it('never splits a surrogate pair where it cuts', async () => {
    // The 32 KiB cut falls between the two halves of the emoji.
    const source = `${'a'.repeat(ENTRY_TEXT_MAX - 1)}😀 and more`;
    const [entry] = await entriesOf(assistant([text(source)], 'msg_pair'));
    expect(entry?.text).toBe('a'.repeat(ENTRY_TEXT_MAX - 1));
    expect(entry?.truncated).toBe(true);
    // And at the 512-character cut, past the page's budget.
    const lean = `${'b'.repeat(LEAN_TEXT_MAX - 1)}😀${'c'.repeat(ENTRY_TEXT_MAX)}`;
    const entries = await entriesOf(
      assistant([text(lean)], 'msg_lean'),
      ...Array.from({ length: 8 }, (_, i) => assistant([text('d'.repeat(ENTRY_TEXT_MAX))], `msg_full_${i}`)),
    );
    expect(entries[0]?.text).toBe('b'.repeat(LEAN_TEXT_MAX - 1));
  });

  it("carries the newest entries' text in full while the page's 256 KiB lasts, then the first 512 characters of the rest", async () => {
    const big = (i: number) => `${i} ${'word '.repeat(6000)}`; // 30,002 characters or so
    const sources = [
      'a short, old reply that still fits',
      ...Array.from({ length: 11 }, (_, i) => big(i)),
    ];
    const entries = await entriesOf(...sources.map((source, i) => assistant([text(source)], `msg_${i}`)));
    expect(PAGE_TEXT_BUDGET).toBe(256 * 1024);
    // Newest first: eight of about 30 KiB fit in 256 KiB, the ninth doesn't, and nor do the two before
    // it; the short one does, in what's left.
    expect(entries.map((e) => e.text.length === LEAN_TEXT_MAX)).toEqual([false, true, true, true, ...Array(8).fill(false)]);
    expect(entries.map((e) => e.truncated === true)).toEqual([false, true, true, true, ...Array(8).fill(false)]);
    // A cut entry is the start of what was written, so the client can tell it's the same entry.
    entries.forEach((entry, i) => expect(sources[i]?.startsWith(entry.text)).toBe(true));
    const full = entries.filter((e) => e.truncated !== true).reduce((sum, e) => sum + e.text.length, 0);
    expect(full).toBeLessThanOrEqual(PAGE_TEXT_BUDGET);
  });

  it('leaves out an entry with only whitespace, and an entry without a timestamp has no at', async () => {
    const undated = { type: 'user', message: { role: 'user', content: 'undated' } };
    expect(await entriesOf(assistant([text(' \n\t ')], 'msg_blank'), undated)).toEqual([{ kind: 'user', text: 'undated' }]);
  });
});

describe('toolSummary', () => {
  it('summarises the common tools on one line', () => {
    expect(toolSummary('Bash', { command: 'npm test', description: 'Run the tests' })).toBe('Bash: npm test');
    expect(toolSummary('Bash', { command: "\n  cat <<'EOF' > a.txt\nhello\nEOF" })).toBe("Bash: cat <<'EOF' > a.txt …");
    expect(toolSummary('Read', { file_path: '/w/src/cli.ts', limit: 10 })).toBe('Read: /w/src/cli.ts');
    expect(toolSummary('Edit', { file_path: '/w/a.ts', old_string: 'secret old', new_string: 'secret new' })).toBe('Edit: /w/a.ts');
    expect(toolSummary('Write', { file_path: '/w/b.ts', content: 'the whole file' })).toBe('Write: /w/b.ts');
    expect(toolSummary('Grep', { pattern: 'TODO|FIXME', path: '/w' })).toBe('Grep: TODO|FIXME');
    expect(toolSummary('WebFetch', { url: 'https://example.com/a', prompt: 'summarise' })).toBe('WebFetch: https://example.com/a');
    expect(toolSummary('Agent', { description: 'Review the diff', prompt: 'long instructions' })).toBe('Agent: Review the diff');
  });

  it('falls back to the tool name, and never shows other input', () => {
    expect(toolSummary('mcp__example__do_thing', { secret: 'value' })).toBe('mcp__example__do_thing');
    expect(toolSummary('Bash', { command: 42 })).toBe('Bash');
    expect(toolSummary('Read', 'not an object')).toBe('Read');
    expect(toolSummary('Bash', { command: '   ' })).toBe('Bash');
  });

  it('keeps the summary to 200 characters on one line', () => {
    const summary = toolSummary('Read', { file_path: `/w/${'deep/'.repeat(100)}\nfile.ts` });
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary).not.toContain('\n');
    expect(toolSummary('x'.repeat(500), {}).length).toBeLessThanOrEqual(200);
  });
});

describe('readConversationPage: paging', () => {
  /** A transcript of `count` prompts, each followed by noise the reader skips. */
  function prompts(count: number): string {
    const lines: unknown[] = [];
    for (let i = 0; i < count; i++) lines.push(user(`prompt ${i}`), filler(300), assistant([thinking('t')], `msg_${i}`));
    return jsonl(...lines);
  }

  it('returns the newest 50 entries oldest first, then older pages, with no duplicates or gaps', async () => {
    const { pages, entries } = await allPages(await transcript(prompts(120)));
    expect(PAGE_ENTRIES).toBe(50);
    expect(pages.map((p) => p.entries.length)).toEqual([50, 50, 20]);
    expect(pages[0]?.entries[0]?.text).toBe('prompt 70');
    expect(pages[0]?.entries[49]?.text).toBe('prompt 119');
    expect(entries.map((e) => e.text)).toEqual(Array.from({ length: 120 }, (_, i) => `prompt ${i}`));
    expect(pages.at(-1)?.before).toBeUndefined();
    expect(pages.every((p) => p.sessionId === SID)).toBe(true);
  });

  it('gives a short transcript one page with no cursor, and an empty file an empty page', async () => {
    expect(await page(await transcript(prompts(3)))).toEqual({
      sessionId: SID,
      entries: [expect.objectContaining({ text: 'prompt 0' }), expect.objectContaining({ text: 'prompt 1' }), expect.objectContaining({ text: 'prompt 2' })],
    });
    expect(await page(await transcript(''))).toEqual({ sessionId: SID, entries: [] });
  });

  it('pages a mixed transcript to the same entries as one big page, whatever the chunk size', async () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 40; i++) {
      lines.push(
        user(`ask ${i}`),
        assistant([thinking('t')], `msg_${i}`),
        assistant([text(`reply ${i} part 1`)], `msg_${i}`),
        assistant([text(`reply ${i} part 2`)], `msg_${i}`),
        assistant([toolUse(`toolu_${i}`, 'Bash', { command: `echo ${i}` })], `msg_${i}`),
        filler(150),
        toolResult(`toolu_${i}`, i % 3 === 0),
        user('<bash-input>ls</bash-input>'),
      );
    }
    const file = await transcript(jsonl(...lines));
    const whole = await page(file, undefined, { pageEntries: 10_000 });
    expect(whole.before).toBeUndefined();
    expect(whole.entries).toHaveLength(160);
    for (const options of [{ pageEntries: 7 }, { pageEntries: 3, chunkBytes: 64 }, { pageEntries: 50, chunkBytes: 1 }, { pageEntries: 1 }]) {
      const { entries } = await allPages(file, options);
      expect(entries, JSON.stringify(options)).toEqual(whole.entries);
    }
  });

  it('never splits a joined assistant message across pages', async () => {
    const file = await transcript(
      jsonl(
        user('older prompt'),
        assistant([text('block 1')], 'msg_split'),
        assistant([thinking('t')], 'msg_split'),
        assistant([text('block 2')], 'msg_split'),
        assistant([text('block 3')], 'msg_split'),
        user('newest prompt'),
      ),
    );
    const { pages } = await allPages(file, { pageEntries: 2 });
    expect(pages.map((p) => p.entries.map((e) => e.text))).toEqual([['block 1\n\nblock 2\n\nblock 3', 'newest prompt'], ['older prompt']]);
  });

  it('pairs a tool call with its result when they fall on different pages', async () => {
    const file = await transcript(
      jsonl(
        user('start'),
        assistant([toolUse('toolu_far', 'Agent', { description: 'Long review' })]),
        user('<bash-input>a</bash-input>'),
        user('<bash-input>b</bash-input>'),
        user('<bash-input>c</bash-input>'),
        toolResult('toolu_far', true),
        assistant([toolUse('toolu_near', 'Read', { file_path: '/w/a' })]),
        toolResult('toolu_near', false),
      ),
    );
    const { pages, entries } = await allPages(file, { pageEntries: 2 });
    // The result is on the newest page; the call is two pages older.
    expect(pages.map((p) => p.entries.map((e) => e.text))).toEqual([
      ['! c', 'Read: /w/a'],
      ['! a', '! b'],
      ['start', 'Agent: Long review'],
    ]);
    expect(entries.find((e) => e.toolName === 'Agent')).toMatchObject({ toolError: true });
    expect(entries.find((e) => e.toolName === 'Read')).toMatchObject({ toolError: false });
  });

  it('pairs results with calls when parallel calls straddle a page boundary', async () => {
    const file = await transcript(
      jsonl(
        assistant([toolUse('toolu_p1', 'Read', { file_path: '/w/1' })], 'msg_p'),
        assistant([toolUse('toolu_p2', 'Read', { file_path: '/w/2' })], 'msg_p'),
        assistant([toolUse('toolu_p3', 'Read', { file_path: '/w/3' })], 'msg_p'),
        toolResult('toolu_p1', true),
        toolResult('toolu_p2', false),
        toolResult('toolu_p3', true),
      ),
    );
    const { pages, entries } = await allPages(file, { pageEntries: 1 });
    expect(pages).toHaveLength(3);
    expect(entries.map((e) => e.toolError)).toEqual([true, false, true]);
  });

  it('keeps the newest entries when one line holds more than a page', async () => {
    const blocks = Array.from({ length: 5 }, (_, i) => toolUse(`toolu_${i}`, 'Read', { file_path: `/w/${i}` }));
    const { pages } = await allPages(await transcript(jsonl(user('before'), assistant(blocks))), { pageEntries: 3 });
    expect(pages.map((p) => p.entries.map((e) => e.text))).toEqual([['Read: /w/2', 'Read: /w/3', 'Read: /w/4'], ['before']]);
  });
});

describe('readConversationPage: the cursor', () => {
  async function twoPages() {
    const lines: unknown[] = [];
    for (let i = 0; i < 80; i++) lines.push(user(`prompt ${i}`));
    const file = await transcript(jsonl(...lines));
    const newest = await page(file);
    if (newest.before === undefined) throw new Error('expected a cursor');
    return { file, newest, before: newest.before };
  }

  it('is opaque base64url, well formed, and returns the older page', async () => {
    const { file, before } = await twoPages();
    expect(before).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(before.length).toBeLessThan(400);
    expect(isWellFormedCursor(before)).toBe(true);
    const older = await page(file, before);
    expect(older.entries.map((e) => e.text)).toEqual(Array.from({ length: 30 }, (_, i) => `prompt ${i}`));
    expect(older.before).toBeUndefined();
  });

  it('stays valid while the transcript grows, and gives the same older page', async () => {
    const { file, before } = await twoPages();
    const first = await page(file, before);
    await appendFile(file, jsonl(user('a new prompt'), assistant([text('a new reply')], 'msg_new')));
    expect(await page(file, before)).toEqual(first);
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'abc+/='],
    ['too long', 'A'.repeat(9000)],
    ['not JSON', Buffer.from('not json').toString('base64url')],
    ['another version', Buffer.from(JSON.stringify({ v: 2, o: 10, d: '1', i: '2', f: 'AAAAAAAAAAA' })).toString('base64url')],
    ['a negative offset', Buffer.from(JSON.stringify({ v: 1, o: -1, d: '1', i: '2', f: 'AAAAAAAAAAA' })).toString('base64url')],
    ['a zero offset', Buffer.from(JSON.stringify({ v: 1, o: 0, d: '1', i: '2', f: 'AAAAAAAAAAA' })).toString('base64url')],
    ['a fractional offset', Buffer.from(JSON.stringify({ v: 1, o: 1.5, d: '1', i: '2', f: 'AAAAAAAAAAA' })).toString('base64url')],
    ['a non-numeric inode', Buffer.from(JSON.stringify({ v: 1, o: 1, d: '1', i: 'x', f: 'AAAAAAAAAAA' })).toString('base64url')],
    ['a bad fingerprint', Buffer.from(JSON.stringify({ v: 1, o: 1, d: '1', i: '2', f: 'short' })).toString('base64url')],
    ['a bad pending id', Buffer.from(JSON.stringify({ v: 1, o: 1, d: '1', i: '2', f: 'AAAAAAAAAAA', p: [['../x', 1]] })).toString('base64url')],
    ['a bad pending flag', Buffer.from(JSON.stringify({ v: 1, o: 1, d: '1', i: '2', f: 'AAAAAAAAAAA', p: [['toolu_1', true]] })).toString('base64url')],
    ['an array', Buffer.from('[1]').toString('base64url')],
  ])('refuses a cursor that is %s as invalid', async (_name, cursor) => {
    const { file } = await twoPages();
    expect(isWellFormedCursor(cursor)).toBe(false);
    await expect(readConversationPage(file, SID, cursor)).rejects.toMatchObject({ name: 'ConversationCursorError', reason: 'invalid' });
  });

  it('refuses a cursor as stale after the file is rotated', async () => {
    const { file, before } = await twoPages();
    await rename(file, `${file}.old`);
    // A new file at the same path, as long as the old one, with the same lines.
    await writeFile(file, jsonl(...Array.from({ length: 80 }, (_, i) => user(`prompt ${i}`))));
    const error = await readConversationPage(file, SID, before).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConversationCursorError);
    expect(error).toMatchObject({ reason: 'stale' });
  });

  it('refuses a cursor as stale after the file is rewritten in place', async () => {
    const { file, before } = await twoPages();
    // Same inode, same size, different bytes before the cursor.
    const handle = await open(file, 'r+');
    try {
      const { size } = await handle.stat();
      const content = Buffer.alloc(size);
      await handle.read(content, 0, size, 0);
      await handle.write(Buffer.from(content.toString('utf8').replaceAll('prompt', 'PROMPT')), 0, size, 0);
    } finally {
      await handle.close();
    }
    await expect(readConversationPage(file, SID, before)).rejects.toMatchObject({ reason: 'stale' });
  });

  it('refuses a cursor as stale after the file is truncated below it', async () => {
    const { file, before } = await twoPages();
    await truncateFile(file, 100);
    await expect(readConversationPage(file, SID, before)).rejects.toMatchObject({ reason: 'stale' });
  });

  it('refuses a well-formed cursor made for another file as stale', async () => {
    const { before } = await twoPages();
    const other = await twoPages();
    await expect(readConversationPage(other.file, SID, before)).rejects.toMatchObject({ reason: 'stale' });
  });

  it('answers undefined for a file that has gone, or is not a file', async () => {
    const { file, before } = await twoPages();
    await rm(file);
    expect(await readConversationPage(file, SID)).toBeUndefined();
    expect(await readConversationPage(file, SID, before)).toBeUndefined();
    const dir = path.join(tmp, `dir${fileCounter++}`);
    await mkdir(dir);
    expect(await readConversationPage(dir, SID)).toBeUndefined();
  });
});

/** The CPU time an async read takes, best of three, as text.test.ts measures. */
async function bestOf3(fn: () => Promise<unknown>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < 3; run++) {
    const start = process.cpuUsage();
    await fn();
    const used = process.cpuUsage(start);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}

/** The shared limit for hostile input, as in text.test.ts. */
const FAST_MS = 200;

describe('readConversationPage: bounded on hostile files', () => {
  it('reads at most 8 MiB for a page, and pages on through a transcript of skipped lines', async () => {
    const lines: unknown[] = [user('the first prompt')];
    // About 20 MiB of lines the reader skips, after the prompt.
    for (let i = 0; i < 20 * 32; i++) lines.push(filler(32 * 1024));
    lines.push(user('the newest prompt'));
    const file = await transcript(jsonl(...lines));
    const { pages, entries, bytes } = await allPages(file);
    expect(PAGE_READ_BUDGET).toBe(8 * 1024 * 1024);
    expect(Math.max(...bytes)).toBeLessThanOrEqual(PAGE_READ_BUDGET);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages[0]?.entries.map((e) => e.text)).toEqual(['the newest prompt']);
    expect(entries.map((e) => e.text)).toEqual(['the first prompt', 'the newest prompt']);
  });

  it('skips a line longer than the whole budget, and reads the lines on both sides of it', async () => {
    const huge = `${JSON.stringify(user(`big ${'y'.repeat(PAGE_READ_BUDGET + 1024 * 1024)}`))}\n`;
    const file = await transcript(jsonl(user('before the huge line')) + huge + jsonl(user('after the huge line')));
    const { entries, bytes } = await allPages(file);
    expect(Math.max(...bytes)).toBeLessThanOrEqual(PAGE_READ_BUDGET);
    expect(entries.map((e) => e.text)).toEqual(['before the huge line', 'after the huge line']);
  });

  it('skips a huge line at the very start or the very end, unfinished or not', async () => {
    const huge = `${JSON.stringify(user('z'.repeat(PAGE_READ_BUDGET + 3 * 1024 * 1024)))}`;
    const atStart = await allPages(await transcript(`${huge}\n${jsonl(user('kept'))}`));
    expect(atStart.entries.map((e) => e.text)).toEqual(['kept']);
    const atEnd = await allPages(await transcript(`${jsonl(user('kept'))}${huge.slice(0, -10)}`));
    expect(atEnd.entries.map((e) => e.text)).toEqual(['kept']);
    expect(Math.max(...atEnd.bytes)).toBeLessThanOrEqual(PAGE_READ_BUDGET);
  });

  it('survives binary garbage, with and without newlines, and keeps the entries around it', async () => {
    const garbage = randomBytes(600 * 1024);
    const content = Buffer.concat([
      Buffer.from(jsonl(user('before the garbage'))),
      garbage,
      Buffer.from('\n'),
      randomBytes(3000).map((b) => (b === 0x0a ? 0x20 : b)),
      Buffer.from(`\n${jsonl(user('after the garbage'))}`),
    ]);
    const { entries } = await allPages(await transcript(content));
    expect(entries.filter((e) => e.kind === 'user' && e.text.includes('the garbage')).map((e) => e.text)).toEqual([
      'before the garbage',
      'after the garbage',
    ]);
  });

  it('reads a file cut off mid-line, as one being written', async () => {
    const whole = jsonl(user('complete'), assistant([text('also complete')], 'msg_1'));
    const cut = `${whole}${JSON.stringify(user('half written')).slice(0, 25)}`;
    expect((await page(await transcript(cut))).entries.map((e) => e.text)).toEqual(['complete', 'also complete']);
  });

  const N = 64 * 1024;

  // 40 KiB each, more than an entry keeps, so a page cuts every one; 50 of them fit in its 8 MiB.
  const M = 40 * 1024;
  it.each([
    ['emphasis that never closes', '*\\\\ '.repeat(M / 4)],
    ['unclosed emphasis', '*a '.repeat(M / 3)],
    ['a run of [', '['.repeat(M)],
    ['a link opener and spaces', `[a](${' '.repeat(M - 4)}`],
    ['short lines of escapes and emphasis', Array.from({ length: M / 130 }, () => '*\\\\ '.repeat(33).slice(0, 129)).join('\n')],
  ])('reads a page of 50 hostile assistant messages of %s quickly', async (_name, hostile) => {
    const lines = Array.from({ length: 50 }, (_, i) => assistant([text(hostile)], `msg_${i}`));
    const file = await transcript(jsonl(...lines));
    expect(await bestOf3(() => readConversationPage(file, SID))).toBeLessThan(FAST_MS);
    const { page: first } = (await readConversationPage(file, SID))!;
    expect(first.entries).toHaveLength(50);
    const cut = hostile.trim().length > ENTRY_TEXT_MAX;
    expect(first.entries.every((e) => e.text.length <= ENTRY_TEXT_MAX && (e.truncated === true) === cut)).toBe(true);
    const full = first.entries.filter((e) => e.text.length > LEAN_TEXT_MAX).reduce((sum, e) => sum + e.text.length, 0);
    expect(full).toBeLessThanOrEqual(PAGE_TEXT_BUDGET);
  });

  it.each([
    ['hostile prompts', () => user(`<system-reminder>${'<system-reminder>'.repeat(N / 17)}`)],
    ['cross-session messages full of tags', () => user(`Another Claude session sent a message:\n${'<agent-message from="'.repeat(N / 21)}`, { isMeta: true })],
    ['cross-session attributes that never close', () => user(`Another Claude session sent a message:\n<cross-session-message ${'from-name="x '.repeat(N / 13)}`, { isMeta: true })],
    ['tool calls with huge inputs', () => assistant([toolUse('toolu_h', 'Bash', { command: `${' \t'.repeat(N)}x` })], `msg_${Math.random()}`)],
    ['notices full of tags', () => user(`<bash-stdout>${'<bash-stdout>'.repeat(N / 13)}`)],
  ])('reads a page of 50 %s quickly', async (_name, line) => {
    const file = await transcript(jsonl(...Array.from({ length: 50 }, line)));
    expect(await bestOf3(() => readConversationPage(file, SID))).toBeLessThan(FAST_MS);
  });

  it('reads 8 MiB of lines that parse but give nothing quickly', async () => {
    const file = await transcript(jsonl(...Array.from({ length: 8192 }, () => toolResult('toolu_none'))) + jsonl(...Array.from({ length: 16000 }, () => filler(400))));
    expect(await bestOf3(() => readConversationPage(file, SID))).toBeLessThan(FAST_MS);
  });
});

describe('readConversationPage: messages to pitwall (W46)', () => {
  const RELAY_SOCKET = 'uds:/tmp/cc-socks/4242.sock';
  const PEER_SOCKET = 'uds:/tmp/cc-socks/5151.sock';

  /** A message pitwall's relay delivered, as the target's transcript records it. */
  function fromRelay(text: string, socket = RELAY_SOCKET, name = RELAY_NAME): Record<string, unknown> {
    return user(
      `Another Claude session sent a message:\n<cross-session-message from="${socket}" from-name="${name}" from-mode="prompting">${text}</cross-session-message>\nThis came from another Claude session - not typed by your user.`,
      { isMeta: true, origin: { kind: 'peer' } },
    );
  }

  /** SendMessage's input as seen in October 2026: `content` is a 50-character preview, never used. */
  function sendInput(to: string, message: string, kind = to.startsWith('uds:') ? 'session' : 'name'): Record<string, unknown> {
    return { to, message, summary: 'Reply to pitwall', content: message.slice(0, 50), type: 'message', recipient: to, recipient_kind: kind };
  }

  const send = (id: string, input: unknown) => assistant([toolUse(id, 'SendMessage', input)], `msg_${id}`);

  /** SendMessage's result: JSON text, `success` first. */
  function sent(id: string, to: string, success = true): Record<string, unknown> {
    return user([{ type: 'tool_result', tool_use_id: id, content: JSON.stringify({ success, message: `“Reply to pitwall” → ${to}` }) }]);
  }

  const relayed = (options: ConversationReadOptions = {}): ConversationReadOptions => ({ relay: new RelayAddressBook(RELAY_NAME), ...options });

  async function relayEntries(...lines: unknown[]): Promise<ConversationEntry[]> {
    return (await page(await transcript(jsonl(...lines)), undefined, relayed())).entries;
  }

  it('turns a call to the relay by its name into a to-pitwall entry: the message as written, as markdown, at the call', async () => {
    const message = 'Both flows:\n\n```ts\nexport const retries = 3;\n```\n\n- the **export** job\n- the import job\n';
    const call = send('toolu_name', sendInput(RELAY_NAME, message));
    const entries = await relayEntries(fromRelay('Which flows did you change?'), call, sent('toolu_name', RELAY_NAME), assistant([text('So I sent it both flows.')], 'msg_after'));
    expect(entries).toEqual([
      { kind: 'cross-session', at: expect.any(String), text: 'Which flows did you change?', markdown: true, from: RELAY_NAME },
      { kind: 'to-pitwall', at: call.timestamp, text: message, markdown: true },
      { kind: 'assistant', at: expect.any(String), text: 'So I sent it both flows.', markdown: true },
    ]);
    // Nothing but the message: not the summary, the preview or the result.
    expect(JSON.stringify(entries)).not.toContain('Reply to pitwall');
  });

  it('matches the name trimmed, in its own case only, with no request needed', async () => {
    const entries = await relayEntries(
      send('toolu_spaced', sendInput(` ${RELAY_NAME}\n`, 'Unprompted: the build is green.')),
      sent('toolu_spaced', RELAY_NAME),
      // The web UI names the recipient as the call addressed it, so another case isn't the relay's name.
      send('toolu_case', sendInput(RELAY_NAME.toUpperCase(), 'In capitals.')),
      sent('toolu_case', RELAY_NAME),
    );
    expect(entries.map((e) => [e.kind, e.text])).toEqual([
      ['to-pitwall', 'Unprompted: the build is green.'],
      ['tool', 'SendMessage'],
    ]);
  });

  it('names the relay as the web UI does, which says who a message to pitwall was addressed to', () => {
    expect(RELAY_SESSION_NAME).toBe(RELAY_NAME);
  });

  it('keeps the markdown exactly as written: leading spaces, indented code, blank lines, trailing newlines and HTML', async () => {
    const message = '    indented code\n\n\n<b>not bold</b> <img src=x onerror=alert(1)> [x](javascript:alert(1))\n\n';
    const [entry] = await relayEntries(send('toolu_exact', sendInput(RELAY_NAME, message)), sent('toolu_exact', RELAY_NAME));
    expect(entry).toMatchObject({ kind: 'to-pitwall', text: message, markdown: true });
  });

  it('turns a call to the socket a message from the relay came from, on the same page, into a to-pitwall entry', async () => {
    const options = relayed();
    const file = await transcript(jsonl(user('earlier'), fromRelay('Status?'), send('toolu_sock', sendInput(RELAY_SOCKET, 'All green.')), sent('toolu_sock', RELAY_SOCKET)));
    const result = await readConversationPage(file, SID, undefined, options);
    expect(result?.page.entries.map((e) => [e.kind, e.text])).toEqual([
      ['user', 'earlier'],
      ['cross-session', 'Status?'],
      ['to-pitwall', 'All green.'],
    ]);
    expect(result?.stats.addressBytesRead).toBe(0);
  });

  it("finds the relay's message on an earlier page, reading the transcript before the page once", async () => {
    const options = relayed({ pageEntries: 3 });
    const lines: unknown[] = [user('first'), fromRelay('Which flows?'), filler(4096)];
    for (let i = 0; i < 10; i++) lines.push(user(`working ${i}`), filler(2048));
    lines.push(send('toolu_far', sendInput(RELAY_SOCKET, 'Both flows.')), sent('toolu_far', RELAY_SOCKET), user('after the reply'));
    const file = await transcript(jsonl(...lines));
    const newest = await readConversationPage(file, SID, undefined, options);
    expect(newest?.page.entries.map((e) => [e.kind, e.text])).toEqual([
      ['user', 'working 9'],
      ['to-pitwall', 'Both flows.'],
      ['user', 'after the reply'],
    ]);
    // It read up to the page's start, and no further.
    const read = newest?.stats.addressBytesRead ?? 0;
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThan((await stat(file)).size);
    // Asked again, it has nothing new to read.
    const again = await readConversationPage(file, SID, undefined, options);
    expect(again?.page).toEqual(newest?.page);
    expect(again?.stats.addressBytesRead).toBe(0);
  });

  it('reads each byte at most once however many pages ask, and only as far as each page starts', async () => {
    const options = relayed({ pageEntries: 2 });
    const lines: unknown[] = [fromRelay('Go.')];
    for (let i = 0; i < 30; i++) lines.push(filler(1024), send(`toolu_${i}`, sendInput(i % 2 === 0 ? RELAY_SOCKET : PEER_SOCKET, `reply ${i}`)), sent(`toolu_${i}`, RELAY_SOCKET));
    const file = await transcript(jsonl(...lines));
    const size = (await stat(file)).size;
    const reads: number[] = [];
    const entries: ConversationEntry[] = [];
    let before: string | undefined;
    for (let i = 0; i < 100; i++) {
      const result = await readConversationPage(file, SID, before, options);
      reads.push(result?.stats.addressBytesRead ?? -1);
      entries.unshift(...(result?.page.entries ?? []));
      before = result?.page.before;
      if (before === undefined) break;
    }
    // The newest page read everything before it, at once; no older page needed anything more.
    expect(reads.length).toBeGreaterThan(10);
    expect(reads[0]).toBeGreaterThan(size * 0.9);
    expect(reads[0]).toBeLessThan(size);
    expect(reads.slice(1).every((bytes) => bytes === 0)).toBe(true);
    expect(entries.filter((e) => e.kind === 'to-pitwall').map((e) => e.text)).toEqual(Array.from({ length: 15 }, (_, i) => `reply ${i * 2}`));
    expect(entries.filter((e) => e.kind === 'tool')).toHaveLength(15);
    // Every page again, and the newest page after the transcript grew: only what was appended.
    await appendFile(file, jsonl(user('newer'), user('newest')));
    const grown = await readConversationPage(file, SID, undefined, options);
    expect(grown?.stats.addressBytesRead).toBe(0);
    const second = await allPages(file, options);
    expect(second.entries.slice(0, -2)).toEqual(entries);
  });

  it("leaves a call to a socket as a tool call when the relay's message from it came later, or never", async () => {
    const entries = await relayEntries(
      send('toolu_before', sendInput(RELAY_SOCKET, 'Too early.')),
      sent('toolu_before', RELAY_SOCKET),
      fromRelay('Now?'),
      // Another session's socket, which messaged this one, but not as the relay.
      user(`Another Claude session sent a message:\n<cross-session-message from="${PEER_SOCKET}" from-name="pitwall-test-peer">Hi.</cross-session-message>`, { isMeta: true, origin: { kind: 'peer' } }),
      send('toolu_peer', sendInput(PEER_SOCKET, 'Hi back.')),
      sent('toolu_peer', PEER_SOCKET),
      send('toolu_now', sendInput(RELAY_SOCKET, 'Now.')),
      sent('toolu_now', RELAY_SOCKET),
    );
    expect(entries.map((e) => [e.kind, e.kind === 'tool' ? e.toolName : e.text])).toEqual([
      ['tool', 'SendMessage'],
      ['cross-session', 'Now?'],
      ['cross-session', 'Hi.'],
      ['tool', 'SendMessage'],
      ['to-pitwall', 'Now.'],
    ]);
  });

  it("leaves a call to another session's socket with no message from the relay as a tool call, after reading what's before the page", async () => {
    const options = relayed({ pageEntries: 2 });
    const file = await transcript(jsonl(user('one'), user('two'), user('three'), send('toolu_peer', sendInput(PEER_SOCKET, 'Hello.')), sent('toolu_peer', PEER_SOCKET)));
    const result = await readConversationPage(file, SID, undefined, options);
    expect(result?.page.entries).toMatchObject([{ kind: 'user', text: 'three' }, { kind: 'tool', toolName: 'SendMessage', text: 'SendMessage' }]);
    expect(result?.stats.addressBytesRead).toBeGreaterThan(0);
  });

  it("leaves calls to a sub-agent, to another session's name, and from a sender only named like the relay as tool calls", async () => {
    const entries = await relayEntries(
      fromRelay('Hi.', PEER_SOCKET, 'pitwall-relay-not'),
      send('toolu_agent', sendInput('a1b2c3d4e5f60718', 'To the sub-agent.', 'agent')),
      sent('toolu_agent', 'a1b2c3d4e5f60718'),
      send('toolu_named', sendInput('pitwall-test-other', 'To another session.')),
      sent('toolu_named', 'pitwall-test-other'),
      send('toolu_near', sendInput(PEER_SOCKET, 'To a sender named like the relay.')),
      sent('toolu_near', PEER_SOCKET),
    );
    expect(entries.map((e) => e.kind)).toEqual(['cross-session', 'tool', 'tool', 'tool']);
  });

  it('leaves a call whose result was an error, or said success: false, as a tool call, the error flagged only for is_error', async () => {
    const entries = await relayEntries(
      send('toolu_error', sendInput(RELAY_NAME, 'Not delivered.')),
      user([{ type: 'tool_result', tool_use_id: 'toolu_error', content: 'No session is named pitwall-relay', is_error: true }]),
      send('toolu_false', sendInput(RELAY_NAME, 'Refused.')),
      sent('toolu_false', RELAY_NAME, false),
      send('toolu_blocks', sendInput(RELAY_NAME, 'Refused, in blocks.')),
      user([{ type: 'tool_result', tool_use_id: 'toolu_blocks', content: [{ type: 'text', text: '{"success":false,"message":"refused"}' }] }]),
      send('toolu_ok', sendInput(RELAY_NAME, 'Delivered.')),
      user([{ type: 'tool_result', tool_use_id: 'toolu_ok', content: [{ type: 'text', text: '{"success":true,"message":"sent"}' }] }]),
    );
    expect(entries).toEqual([
      { kind: 'tool', at: expect.any(String), text: 'SendMessage', toolName: 'SendMessage', toolError: true },
      { kind: 'tool', at: expect.any(String), text: 'SendMessage', toolName: 'SendMessage', toolError: false },
      { kind: 'tool', at: expect.any(String), text: 'SendMessage', toolName: 'SendMessage', toolError: false },
      { kind: 'to-pitwall', at: expect.any(String), text: 'Delivered.', markdown: true },
    ]);
  });

  it('shows a call with no result yet, as one that was just made, as a to-pitwall entry', async () => {
    expect(await relayEntries(send('toolu_running', sendInput(RELAY_NAME, 'On its way.')))).toMatchObject([{ kind: 'to-pitwall', text: 'On its way.' }]);
  });

  it('leaves a call with no string message, or only whitespace, as a tool call, and never reads the preview', async () => {
    const entries = await relayEntries(
      send('toolu_none', { to: RELAY_NAME, summary: 'x', content: 'A preview only' }),
      send('toolu_number', { to: RELAY_NAME, message: 42, content: 'A preview only' }),
      send('toolu_blank', sendInput(RELAY_NAME, ' \n\t ')),
      send('toolu_noto', { message: 'No recipient.' }),
      send('toolu_string', 'not an object'),
    );
    expect(entries.map((e) => e.kind)).toEqual(['tool', 'tool', 'tool', 'tool', 'tool']);
    expect(JSON.stringify(entries)).not.toContain('preview');
  });

  it('leaves every SendMessage call as a tool call without the relay', async () => {
    const entries = await entriesOf(fromRelay('Hi.'), send('toolu_x', sendInput(RELAY_NAME, 'Hello.')), send('toolu_y', sendInput(RELAY_SOCKET, 'Hello.')));
    expect(entries.map((e) => e.kind)).toEqual(['cross-session', 'tool', 'tool']);
  });

  it('caps the message at 32 KiB, marked truncated, and counts it against the page budget', async () => {
    const long = `**start** ${'word '.repeat(8000)}`;
    const [capped] = await relayEntries(send('toolu_long', sendInput(RELAY_NAME, long)));
    expect(capped).toMatchObject({ kind: 'to-pitwall', text: long.slice(0, ENTRY_TEXT_MAX), truncated: true, markdown: true });
    // Eight newer entries of 32 KiB spend the page's budget, so the older message keeps 512 characters.
    const entries = await relayEntries(
      send('toolu_old', sendInput(RELAY_NAME, long)),
      ...Array.from({ length: 8 }, (_, i) => assistant([text('d'.repeat(ENTRY_TEXT_MAX))], `msg_full_${i}`)),
    );
    expect(entries[0]).toMatchObject({ kind: 'to-pitwall', text: long.slice(0, LEAN_TEXT_MAX), truncated: true });
  });

  it('stands alone between tool calls, in the call’s place', async () => {
    const entries = await relayEntries(
      assistant([toolUse('toolu_a', 'Read', { file_path: '/w/a.ts' })], 'msg_run'),
      toolResult('toolu_a'),
      send('toolu_mid', sendInput(RELAY_NAME, 'Halfway.')),
      sent('toolu_mid', RELAY_NAME),
      assistant([toolUse('toolu_b', 'Bash', { command: 'npm test' })], 'msg_run2'),
      toolResult('toolu_b'),
    );
    expect(entries.map((e) => e.kind)).toEqual(['tool', 'to-pitwall', 'tool']);
  });

  it('carries a failed result to the older page its call is on, through the cursor', async () => {
    const options = relayed({ pageEntries: 1 });
    const file = await transcript(
      jsonl(
        send('toolu_split', sendInput(RELAY_NAME, 'Refused.')),
        user('in between'),
        sent('toolu_split', RELAY_NAME, false),
        send('toolu_split_ok', sendInput(RELAY_NAME, 'Fine.')),
        user('also in between'),
        sent('toolu_split_ok', RELAY_NAME),
      ),
    );
    const { entries } = await allPages(file, options);
    expect(entries.map((e) => e.kind)).toEqual(['tool', 'user', 'to-pitwall', 'user']);
    // The cursor's pending flag 2 is a failed result; anything past it isn't a cursor.
    const bad = Buffer.from(JSON.stringify({ v: 1, o: 1, d: '1', i: '2', f: 'AAAAAAAAAAA', p: [['toolu_1', 3]] })).toString('base64url');
    expect(isWellFormedCursor(bad)).toBe(false);
    const good = Buffer.from(JSON.stringify({ v: 1, o: 1, d: '1', i: '2', f: 'AAAAAAAAAAA', p: [['toolu_1', 2]] })).toString('base64url');
    expect(isWellFormedCursor(good)).toBe(true);
  });

  it('reads the transcript again from the start once it was replaced or rewritten before where the book stopped', async () => {
    const options = relayed({ pageEntries: 1 });
    const lines = [fromRelay('Go.'), user('between'), send('toolu_r', sendInput(RELAY_SOCKET, 'Gone.')), sent('toolu_r', RELAY_SOCKET)];
    const file = await transcript(jsonl(...lines));
    const first = await readConversationPage(file, SID, undefined, options);
    expect(first?.page.entries.map((e) => e.kind)).toEqual(['to-pitwall']);
    // Rewritten in place, so the same inode and the same size, with only its first line changed: a
    // peer's socket now. The book notices by the file's start and reads it again.
    const rewritten = jsonl(fromRelay('Go.', 'uds:/tmp/cc-socks/9999.sock'), ...lines.slice(1));
    expect(Buffer.byteLength(rewritten)).toBe((await stat(file)).size);
    await writeFile(file, rewritten);
    const second = await readConversationPage(file, SID, undefined, options);
    expect(second?.stats.addressBytesRead).toBeGreaterThan(0);
    expect(second?.page.entries.map((e) => e.kind)).toEqual(['tool']);
    // Replaced by another file, which a file system may give the same inode: read again, and the relay's socket is back.
    await rm(file);
    await writeFile(file, jsonl(...lines));
    const third = await readConversationPage(file, SID, undefined, options);
    expect(third?.stats.addressBytesRead).toBeGreaterThan(0);
    expect(third?.page.entries.map((e) => e.kind)).toEqual(['to-pitwall']);
  });

  it('remembers at most 64 addresses for a transcript, the first ones', async () => {
    const options = relayed({ pageEntries: 1 });
    const many = Array.from({ length: RELAY_ADDRESSES_MAX + 6 }, (_, i) => fromRelay(`${i}`, `uds:/tmp/cc-socks/${1000 + i}.sock`));
    const first = send('toolu_first', sendInput('uds:/tmp/cc-socks/1000.sock', 'To the first.'));
    const last = send('toolu_last', sendInput(`uds:/tmp/cc-socks/${1000 + RELAY_ADDRESSES_MAX + 5}.sock`, 'To the last.'));
    const file = await transcript(jsonl(...many, user('a'), first, user('b'), last, user('c')));
    const { entries } = await allPages(file, options);
    expect(entries.filter((e) => e.kind === 'to-pitwall').map((e) => e.text)).toEqual(['To the first.']);
  });

  it('forgets the transcripts of sessions it is not told to keep', async () => {
    const book = new RelayAddressBook(RELAY_NAME);
    const file = await transcript(jsonl(fromRelay('Go.'), user('between'), send('toolu_f', sendInput(RELAY_SOCKET, 'Done.'))));
    expect((await readConversationPage(file, SID, undefined, { relay: book, pageEntries: 1 }))?.stats.addressBytesRead).toBeGreaterThan(0);
    expect((await readConversationPage(file, SID, undefined, { relay: book, pageEntries: 1 }))?.stats.addressBytesRead).toBe(0);
    book.retain(new Set(['another-session']));
    expect((await readConversationPage(file, SID, undefined, { relay: book, pageEntries: 1 }))?.stats.addressBytesRead).toBeGreaterThan(0);
  });

  it('reads a page of 50 calls to sockets after 8 MiB of hostile lines that name the relay quickly', async () => {
    // Messages from the relay, each from a socket of its own, past the 64 kept; then lines that only mention it, which are all parsed.
    const forged = Array.from({ length: 2000 }, (_, i) =>
      i % 2 === 0 ? fromRelay(`${'x'.repeat(4000)} ${i}`, `uds:/tmp/cc-socks/${i}.sock`) : user(`${`${RELAY_NAME} `.repeat(290)}${i}`),
    );
    // None of them is to an address the relay's messages came from.
    const calls = Array.from({ length: 50 }, (_, i) => send(`toolu_h${i}`, sendInput(`uds:/tmp/cc-socks/peer-${i}.sock`, `hostile ${i}`)));
    const file = await transcript(jsonl(...forged, ...calls));
    let read = 0;
    // A new book each time, so each run reads the 8 MiB before the page.
    expect(
      await bestOf3(async () => {
        read = (await readConversationPage(file, SID, undefined, relayed()))?.stats.addressBytesRead ?? 0;
      }),
    ).toBeLessThan(FAST_MS);
    expect(read).toBeGreaterThan(8 * 1024 * 1024);
    const result = await readConversationPage(file, SID, undefined, relayed());
    expect(result?.page.entries).toHaveLength(50);
    expect(result?.page.entries.every((e) => e.kind === 'tool')).toBe(true);
  });
});
