import { appendFile, chmod, mkdir, mkdtemp, rename, rm, truncate as truncateFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aiTitleOf,
  applyEntry,
  applyLine,
  ASSISTANT_TEXT_KEEP,
  assistantTextOf,
  createTranscriptReader,
  defaultConfigDir,
  encodeProjectDir,
  isSafeSessionId,
  isTypedPrompt,
  readNewestEntries,
  setNameOf,
  stripSystemReminders,
  TITLE_MAX,
  userPromptOf,
  type Fields,
  type TranscriptReaderOptions,
} from './transcripts.js';

// Synthetic transcript entries, shaped like Claude Code 2.1.301's JSONL. No real content.

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

/** Claude Code's generated title entry. It has no timestamp. */
function aiTitle(title: unknown): Record<string, unknown> {
  return { type: 'ai-title', aiTitle: title, sessionId: 'pitwall-test-session' };
}

const text = (t: string) => ({ type: 'text', text: t });
const thinking = (t: string) => ({ type: 'thinking', thinking: t, signature: 'sig' });
const toolUse = (name: string) => ({ type: 'tool_use', id: `toolu_${name}`, name, input: { command: 'ls' } });
const toolResult = (t: string) => ({ type: 'tool_result', tool_use_id: 'toolu_x', content: t });

/** A line the index ignores, to pad files out. Roughly `bytes` long. */
function filler(bytes: number): Record<string, unknown> {
  return { type: 'attachment', timestamp: nextTimestamp(), attachment: { type: 'note', body: 'x'.repeat(Math.max(0, bytes - 90)) } };
}

function jsonl(...entries: unknown[]): string {
  return entries.map((e) => `${JSON.stringify(e)}\n`).join('');
}

function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/** A few milliseconds is typical; the margin is for slow CI. The quadratic versions took seconds. */
const FAST_MS = 200;

function fieldsOf(...entries: unknown[]): Fields {
  const fields: Fields = {};
  for (const entry of entries) applyEntry(fields, entry);
  return fields;
}

describe('userPromptOf', () => {
  it('takes string content, and text blocks joined', () => {
    expect(userPromptOf(user('fix the flaky test'))).toBe('fix the flaky test');
    expect(userPromptOf(user([text('first part'), { type: 'image', source: {} }, text('second part')]))).toBe(
      'first part\nsecond part',
    );
  });

  it('strips system reminders and trims', () => {
    const content = '<system-reminder>\nnote from the harness\n</system-reminder>\n  ship it  <system-reminder>x</system-reminder>';
    expect(userPromptOf(user(content))).toBe('ship it');
    expect(userPromptOf(user('<system-reminder>only a reminder</system-reminder>'))).toBeUndefined();
  });

  it('excludes cross-session messages', () => {
    const crossSession = user(
      'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="pitwall-test-sup" from-mode="prompting">ping</cross-session-message>',
      { isMeta: true, origin: { kind: 'peer' } },
    );
    expect(userPromptOf(crossSession)).toBeUndefined();
  });

  it('excludes cross-session content defensively, even without isMeta or origin', () => {
    expect(userPromptOf(user('Another Claude session sent a message: hello'))).toBeUndefined();
    expect(userPromptOf(user('before <cross-session-message from="x">hi</cross-session-message>'))).toBeUndefined();
    expect(userPromptOf(user([text('<cross-session-message from="x">hi</cross-session-message>')]))).toBeUndefined();
  });

  it('does not exclude a prompt whose only cross-session mention is inside a system reminder', () => {
    expect(userPromptOf(user('<system-reminder>a <cross-session-message> arrived</system-reminder>real prompt'))).toBe(
      'real prompt',
    );
  });

  it('excludes meta entries, compact summaries and sidechains', () => {
    expect(userPromptOf(user('meta note', { isMeta: true }))).toBeUndefined();
    expect(userPromptOf(user('This session is being continued from a previous conversation…', { isCompactSummary: true }))).toBeUndefined();
    expect(userPromptOf(user('subagent prompt', { isSidechain: true }))).toBeUndefined();
  });

  it('excludes tool results, including ones next to text', () => {
    expect(userPromptOf(user([toolResult('file listing')]))).toBeUndefined();
    expect(userPromptOf(user([toolResult('file listing'), text('and some text')]))).toBeUndefined();
  });

  it('excludes entries from another session or a task notification by origin', () => {
    expect(userPromptOf(user('hello', { origin: { kind: 'peer' } }))).toBeUndefined();
    expect(userPromptOf(user('done', { origin: { kind: 'task-notification' } }))).toBeUndefined();
    expect(userPromptOf(user('typed', { origin: { kind: 'human' } }))).toBe('typed');
  });

  it("excludes Claude Code's own wrappers", () => {
    for (const content of [
      '<command-name>/clear</command-name>',
      '<command-message>review</command-message>',
      '<local-command-stdout>ok</local-command-stdout>',
      '<local-command-caveat>Caveat: …</local-command-caveat>',
      '<task-notification><task-id>t1</task-id></task-notification>',
      'Caveat: The messages below were generated by the user while running local commands.',
      '[Request interrupted by user]',
      '[Request interrupted by user for tool use]',
      '<bash-input>git status</bash-input>',
      '<bash-stdout>clean</bash-stdout>',
      '<bash-stderr></bash-stderr>',
    ]) {
      expect(userPromptOf(user(content)), content).toBeUndefined();
    }
  });

  it('keeps a prompt with an image placeholder', () => {
    expect(userPromptOf(user([text('[Image #1] what is wrong here?')]))).toBe('[Image #1] what is wrong here?');
  });

  it('truncates to 300 characters', () => {
    const prompt = userPromptOf(user('p'.repeat(1000)));
    expect(prompt).toHaveLength(300);
    expect(prompt?.endsWith('…')).toBe(true);
  });

  it('ignores entries without usable content', () => {
    expect(userPromptOf({ type: 'user' })).toBeUndefined();
    expect(userPromptOf({ type: 'user', message: { content: 42 } })).toBeUndefined();
    expect(userPromptOf(user([{ type: 'image', source: {} }]))).toBeUndefined();
    expect(userPromptOf(user('   '))).toBeUndefined();
  });
});

describe('assistantTextOf', () => {
  it('joins text blocks and leaves out thinking and tool_use', () => {
    const entry = assistant([thinking('private reasoning'), text('Here is the plan.'), toolUse('Bash'), text('Done.')]);
    expect(assistantTextOf(entry)).toEqual({ id: 'msg_a', text: 'Here is the plan.\nDone.' });
  });

  it('is undefined for an entry with only thinking or tool_use', () => {
    expect(assistantTextOf(assistant([thinking('hmm')]))).toBeUndefined();
    expect(assistantTextOf(assistant([toolUse('Read')]))).toBeUndefined();
    expect(assistantTextOf(assistant([text('   ')]))).toBeUndefined();
  });

  it('skips sidechains', () => {
    expect(assistantTextOf(assistant([text('from a subagent')], 'msg_s', { isSidechain: true }))).toBeUndefined();
  });

  it('accepts string content', () => {
    expect(assistantTextOf({ type: 'assistant', message: { content: '  plain  ' } })).toEqual({ text: 'plain' });
  });
});

describe('applyEntry', () => {
  it('keeps the newest timestamp on user and assistant entries only', () => {
    const early = user('a', { timestamp: '2026-10-16T09:00:00.000Z' });
    const late = assistant([toolUse('Bash')], 'm', { timestamp: '2026-10-16T09:05:00.000Z' });
    const outOfOrder = user([toolResult('r')], { timestamp: '2026-10-16T09:01:00.000Z' });
    const other = { type: 'attachment', timestamp: '2026-10-16T12:00:00.000Z' };
    const fields = fieldsOf(early, late, outOfOrder, other);
    expect(fields.lastActivityMs).toBe(Date.parse('2026-10-16T09:05:00.000Z'));
  });

  it('keeps the newest assistant message that has text', () => {
    const fields = fieldsOf(assistant([text('older')], 'm1'), assistant([text('newer')], 'm2'), assistant([toolUse('Bash')], 'm3'));
    expect(fields.assistantText).toBe('newer');
  });

  it('joins text written on separate lines of the same message', () => {
    const fields = fieldsOf(
      assistant([text('part one')], 'm1'),
      assistant([toolUse('Bash')], 'm1'),
      assistant([text('part two')], 'm1'),
    );
    expect(fields.assistantText).toBe('part one\npart two');
  });

  it('records whether a prompt came after the newest assistant text, in file order', () => {
    expect(fieldsOf(user('go'), assistant([text('Should I push?')])).promptAfterText).toBe(false);
    expect(fieldsOf(assistant([text('Should I push?')]), user('yes')).promptAfterText).toBe(true);
    expect(fieldsOf(user('a'), assistant([text('q?')], 'm1'), user('b'), assistant([text('r')], 'm2')).promptAfterText).toBe(
      false,
    );
    // Neither a tool result nor a cross-session message is a prompt.
    const notPrompts = fieldsOf(
      assistant([text('Should I push?')]),
      user([toolResult('output')]),
      user('Another Claude session sent a message:\n<cross-session-message from="x">hi</cross-session-message>', {
        isMeta: true,
        origin: { kind: 'peer' },
      }),
    );
    expect(notPrompts.promptAfterText).toBe(false);
  });

  it('keeps the whole raw text of the newest message, up to 64 KiB', () => {
    const fields = fieldsOf(assistant([text(`**${'a'.repeat(3000)}**`)], 'm1'), assistant([text('b'.repeat(70_000))], 'm1'));
    expect(fields.assistantText?.startsWith(`**${'a'.repeat(3000)}**\nbbb`)).toBe(true);
    expect(fields.assistantText).toHaveLength(ASSISTANT_TEXT_KEEP);
  });

  it('keeps a cut message at 64 KiB as more blocks arrive, and starts again with a new message', () => {
    const exact = fieldsOf(assistant([text('e'.repeat(ASSISTANT_TEXT_KEEP))], 'm1'));
    expect(exact.assistantText).toHaveLength(ASSISTANT_TEXT_KEEP);

    const first = assistant([text('a'.repeat(40_000))], 'm2');
    const second = assistant([text('b'.repeat(40_000))], 'm2');
    const third = assistant([text('c')], 'm2');
    const cut = fieldsOf(first, second, third);
    expect(cut.assistantText).toHaveLength(ASSISTANT_TEXT_KEEP);

    // A new message starts again.
    const next = fieldsOf(first, second, assistant([text('fresh')], 'm3'));
    expect(next.assistantText).toBe('fresh');
  });

  it("keeps the newest ai-title entry's title, which is not activity", () => {
    const prompt = user('go');
    const fields = fieldsOf(prompt, aiTitle('First title'), aiTitle('  Second\n  title  '));
    expect(fields.aiTitle).toBe('Second title');
    expect(fields.lastActivityMs).toBe(Date.parse(prompt.timestamp as string));
    const only = fieldsOf(aiTitle('Only a title'));
    expect(only).toEqual({ aiTitle: 'Only a title' });
  });

  it('ignores ai-title entries without a usable title', () => {
    for (const value of [undefined, 42, null, '', '   ', { text: 'x' }]) {
      expect(fieldsOf(aiTitle('kept'), aiTitle(value)).aiTitle, String(value)).toBe('kept');
    }
  });

  it('keeps the newest real prompt, skipping cross-session messages and tool results after it', () => {
    const fields = fieldsOf(
      user('first prompt'),
      user('second prompt'),
      user('Another Claude session sent a message:\n<cross-session-message from="x">hi</cross-session-message>', {
        isMeta: true,
      }),
      user([toolResult('output')]),
    );
    expect(fields.userPrompt).toBe('second prompt');
  });
});

describe('applyEntry: what the ended-session scanner needs (W66)', () => {
  const named = (type: 'custom-title' | 'agent-name', name: unknown) =>
    type === 'custom-title' ? { type, customTitle: name, sessionId: 'pitwall-test-session' } : { type, agentName: name, sessionId: 'pitwall-test-session' };

  it('keeps whether the newest user or assistant entry, in file order, ran in the background', () => {
    expect(fieldsOf(user('go'), assistant([text('done')], 'm1', { sessionKind: 'bg' })).inBackground).toBe(true);
    expect(fieldsOf(user('go', { sessionKind: 'bg' }), assistant([text('done')])).inBackground).toBe(false);
    // A tool call or thinking with no text still counts: it's the newest entry.
    expect(fieldsOf(assistant([text('done')]), assistant([toolUse('Bash')], 'm2', { sessionKind: 'bg' })).inBackground).toBe(true);
    expect(fieldsOf(aiTitle('only a title')).inBackground).toBeUndefined();
  });

  it('keeps the newest name set with --name, from either entry, which is not activity', () => {
    const prompt = user('go');
    const fields = fieldsOf(named('custom-title', 'first'), named('agent-name', 'first'), prompt, named('custom-title', '  second\n name '));
    expect(fields.setName).toBe('second name');
    expect(fields.lastActivityMs).toBe(Date.parse(prompt.timestamp as string));
    expect(fieldsOf(named('custom-title', 'a'), named('agent-name', 'b')).setName).toBe('b');
    for (const value of [undefined, 42, '', '   ', { name: 'x' }]) {
      expect(fieldsOf(named('agent-name', 'kept'), named('agent-name', value)).setName, String(value)).toBe('kept');
    }
    const fromLines: Fields = {};
    applyLine(fromLines, JSON.stringify(named('agent-name', 'from a line')));
    expect(fromLines.setName).toBe('from a line');
  });

  it('notes a typed prompt: promptSource typed, on a user entry that is not meta', () => {
    expect(fieldsOf(user('typed', { promptSource: 'typed' })).typedPrompt).toBe(true);
    for (const extra of [{ promptSource: 'sdk' }, { promptSource: 'queued' }, { promptSource: 'typed', isMeta: true }, {}]) {
      expect(fieldsOf(user('x', extra)).typedPrompt, JSON.stringify(extra)).toBeUndefined();
    }
    expect(isTypedPrompt({ type: 'assistant', promptSource: 'typed' })).toBe(false);
    expect(setNameOf({ type: 'ai-title', aiTitle: 'not a name' })).toBeUndefined();
  });
});

describe('aiTitleOf', () => {
  it('collapses whitespace and truncates to 120 characters', () => {
    expect(aiTitleOf(aiTitle('Review\tthe\n\nauth   flow'))).toBe('Review the auth flow');
    const long = aiTitleOf(aiTitle(`${'word '.repeat(100)}`));
    expect(TITLE_MAX).toBe(120);
    expect(long).toHaveLength(120);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('is quick on a huge title', () => {
    const started = performance.now();
    expect(aiTitleOf(aiTitle(' '.repeat(8 * 1024 * 1024) + 'x'))).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(FAST_MS);
  });
});

describe('isSafeSessionId', () => {
  it('accepts UUIDs and refuses anything that could be a path', () => {
    expect(isSafeSessionId('44444444-4444-4444-8444-444444444444')).toBe(true);
    expect(isSafeSessionId('abc.def_1')).toBe(true);
    for (const id of ['', '.', '..', '../x', 'a/b', 'a\\b', '.hidden', 'a\0b', '-rf', 'a b', '%2e%2e']) {
      expect(isSafeSessionId(id), JSON.stringify(id)).toBe(false);
    }
  });
});

describe('applyLine', () => {
  it('reads ai-title lines', () => {
    const fields: Fields = {};
    applyLine(fields, JSON.stringify(aiTitle('From a line')));
    expect(fields.aiTitle).toBe('From a line');
  });

  it('skips lines that do not parse', () => {
    const fields: Fields = {};
    applyLine(fields, '{"type":"user", broken');
    applyLine(fields, 'not json at all "user"');
    applyLine(fields, JSON.stringify(user('valid')));
    expect(fields.userPrompt).toBe('valid');
  });
});

describe('stripSystemReminders', () => {
  it('removes every reminder block, across lines', () => {
    expect(stripSystemReminders('a<system-reminder>1\n2</system-reminder>b<system-reminder>3</system-reminder>c')).toBe('abc');
  });

  it('removes from an opening tag to the first closing tag after it', () => {
    expect(stripSystemReminders('<system-reminder>a<system-reminder>b</system-reminder>c</system-reminder>d')).toBe(
      'c</system-reminder>d',
    );
  });

  it('leaves an opening tag with no closing tag after it, and text with no tags, as they are', () => {
    expect(stripSystemReminders('keep <system-reminder>unclosed')).toBe('keep <system-reminder>unclosed');
    expect(stripSystemReminders('a<system-reminder>x</system-reminder>b<system-reminder>c')).toBe('ab<system-reminder>c');
    expect(stripSystemReminders('</system-reminder>a<system-reminder>')).toBe('</system-reminder>a<system-reminder>');
    expect(stripSystemReminders('plain')).toBe('plain');
  });

  it('runs in linear time on a prompt full of unclosed tags', () => {
    const text = '<system-reminder>'.repeat(64 * 1024);
    expect(timed(() => stripSystemReminders(text))).toBeLessThan(FAST_MS);
    expect(timed(() => userPromptOf(user(text)))).toBeLessThan(FAST_MS);
  });
});

describe('defaultConfigDir and encodeProjectDir', () => {
  it('uses CLAUDE_CONFIG_DIR, or ~/.claude', () => {
    expect(defaultConfigDir({ CLAUDE_CONFIG_DIR: '/opt/claude-config' }, '/home/someone')).toBe('/opt/claude-config');
    expect(defaultConfigDir({}, '/home/someone')).toBe('/home/someone/.claude');
    expect(defaultConfigDir({ CLAUDE_CONFIG_DIR: '' }, '/home/someone')).toBe('/home/someone/.claude');
  });

  it('replaces every non-alphanumeric character with -', () => {
    expect(encodeProjectDir('/Users/someone/git/my_repo.v2')).toBe('-Users-someone-git-my-repo-v2');
  });
});

describe('createTranscriptReader', () => {
  const SID = '44444444-4444-4444-8444-444444444444';
  const CWD = '/work/pitwall-test/repo';
  let configDir: string;
  let file: string;
  let now: number;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-transcripts-'));
    const projectDir = path.join(configDir, 'projects', encodeProjectDir(CWD));
    await mkdir(projectDir, { recursive: true });
    file = path.join(projectDir, `${SID}.jsonl`);
    now = 1_000_000;
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  function reader(options: TranscriptReaderOptions = {}) {
    return createTranscriptReader({ configDir, now: () => now, ...options });
  }

  it('reads the fields from the encoded project path', async () => {
    const prompt = user('add a test');
    const reply = assistant([thinking('…'), text('Added the test.')], 'm1');
    await writeFile(file, jsonl({ type: 'queue-operation' }, prompt, reply, filler(200)));
    expect(await reader().read(SID, [CWD])).toEqual({
      transcript: 'ok',
      lastActivityAt: reply.timestamp,
      lastUserPrompt: 'add a test',
    });
  });

  it('strips markdown from the question it finds in the assistant text', async () => {
    const code = `\`\`\`\n${'x'.repeat(2000)}\n\`\`\``;
    await writeFile(file, jsonl(assistant([text(`## Result\n\n${code}\n\n**All** tests \`pass\`. Merge it?`)])));
    expect((await reader().read(SID, [CWD])).askedYou).toEqual({ reason: 'question', excerpt: 'All tests pass. Merge it?' });
  });

  it('finds the question after a long code block at the start', async () => {
    const code = `\`\`\`diff\n${'+ added line\n'.repeat(2000)}\`\`\``;
    await writeFile(file, jsonl(assistant([text(`${code}\n\nShould I apply this?`)])));
    expect((await reader().read(SID, [CWD])).askedYou).toEqual({ reason: 'question', excerpt: 'Should I apply this?' });
  });

  it('reads a hostile 64 KiB message quickly', async () => {
    await writeFile(file, jsonl(assistant([text('['.repeat(ASSISTANT_TEXT_KEEP))])));
    const started = performance.now();
    const info = await reader().read(SID, [CWD]);
    expect(performance.now() - started).toBeLessThan(FAST_MS);
    expect(info).toEqual({ transcript: 'ok', lastActivityAt: expect.any(String) });
  });

  describe('titles', () => {
    it("reads the newest ai-title entry's title", async () => {
      await writeFile(file, jsonl(aiTitle('Old title'), user('go'), aiTitle('New title'), assistant([text('ok')])));
      expect((await reader().read(SID, [CWD])).aiTitle).toBe('New title');
    });

    it('follows a title written after the first read', async () => {
      const r = reader();
      await writeFile(file, jsonl(user('go'), assistant([text('ok')])));
      expect((await r.read(SID, [CWD])).aiTitle).toBeUndefined();
      await appendFile(file, jsonl(aiTitle('Added later')));
      expect((await r.read(SID, [CWD])).aiTitle).toBe('Added later');
      await appendFile(file, jsonl(aiTitle('Changed again'), user('more')));
      expect((await r.read(SID, [CWD])).aiTitle).toBe('Changed again');
    });

    it('widens the window once for a title outside the first one', async () => {
      const r = reader({ initialWindowBytes: 1024, maxWindowBytes: 4096 });
      // The title is ~2 KB from the end, past the first window; everything else is inside it.
      const prompt = user('the prompt');
      const answer = assistant([text('the answer')]);
      await writeFile(file, jsonl(aiTitle('Further back'), filler(2000), prompt, answer));
      const info = await r.read(SID, [CWD]);
      expect(info).toMatchObject({ aiTitle: 'Further back', lastUserPrompt: 'the prompt', lastActivityAt: answer.timestamp });
    });

    it('leaves the title unset when the wider window does not have it either', async () => {
      const r = reader({ initialWindowBytes: 1024, maxWindowBytes: 4096 });
      const prompt = user('p');
      const answer = assistant([text('a')]);
      await writeFile(file, jsonl(aiTitle('Too far back'), ...Array.from({ length: 6 }, () => filler(1000)), prompt, answer));
      const info = await r.read(SID, [CWD]);
      expect(info.aiTitle).toBeUndefined();
      expect(info).toMatchObject({ transcript: 'ok', lastUserPrompt: 'p', lastActivityAt: answer.timestamp });
    });
  });

  describe('transcriptFile', () => {
    it('is the file the last read found, without reading anything', async () => {
      await writeFile(file, jsonl(user('go')));
      const r = reader();
      expect(r.transcriptFile(SID)).toBeUndefined();
      await r.read(SID, [CWD]);
      expect(r.transcriptFile(SID)).toBe(file);
      await rm(file);
      // Still the remembered path; reading it is the caller's business, and fails soft.
      expect(r.transcriptFile(SID)).toBe(file);
    });

    it('is undefined for a session with no transcript, an unsafe id, or one no longer retained', async () => {
      const r = reader();
      await r.read(SID, [CWD]);
      expect(r.transcriptFile(SID)).toBeUndefined();
      expect(r.transcriptFile('../escape')).toBeUndefined();
      await writeFile(file, jsonl(user('go')));
      now += 60_000;
      await r.read(SID, [CWD]);
      expect(r.transcriptFile(SID)).toBe(file);
      r.retain(new Set());
      expect(r.transcriptFile(SID)).toBeUndefined();
    });
  });

  describe('askedYou', () => {
    const crossSession = () =>
      user('Another Claude session sent a message:\n<cross-session-message from="x">status?</cross-session-message>', {
        isMeta: true,
        origin: { kind: 'peer' },
      });

    it('is set when the newest assistant text asks and no prompt came since', async () => {
      await writeFile(file, jsonl(user('fix it'), assistant([text('Fixed.\n\n**Open questions:**\n- Should I push it?')])));
      expect((await reader().read(SID, [CWD])).askedYou).toEqual({ reason: 'open-questions', excerpt: 'Should I push it?' });
    });

    it('reads the question from the whole message, not only its start', async () => {
      const long = `${'Long report line.\n'.repeat(100)}\nWant me to open the PR?`;
      await writeFile(file, jsonl(user('report'), assistant([text(long)])));
      const info = await reader().read(SID, [CWD]);
      expect(info.askedYou).toEqual({ reason: 'question', excerpt: 'Want me to open the PR?' });
    });

    it('joins the text blocks of the message, so a question in a later block counts', async () => {
      await writeFile(
        file,
        jsonl(user('go'), assistant([text('Ran the tests.')], 'm1'), assistant([toolUse('Bash')], 'm1'), assistant([text('Merge now?')], 'm1')),
      );
      expect((await reader().read(SID, [CWD])).askedYou?.excerpt).toBe('Merge now?');
    });

    it('is not set once the user has replied', async () => {
      await writeFile(file, jsonl(assistant([text('Should I push it?')]), user('yes, push')));
      expect((await reader().read(SID, [CWD])).askedYou).toBeUndefined();
    });

    it('is still set after a cross-session message or a tool result, which are not the user replying', async () => {
      await writeFile(file, jsonl(user('go'), assistant([text('Should I push it?')]), crossSession(), user([toolResult('ok')])));
      expect((await reader().read(SID, [CWD])).askedYou).toEqual({ reason: 'question', excerpt: 'Should I push it?' });
    });

    it('is not set when the message ends with a statement or says None', async () => {
      await writeFile(file, jsonl(user('go'), assistant([text('Should I push it?\n\nPushed anyway.')])));
      expect((await reader().read(SID, [CWD])).askedYou).toBeUndefined();

      const r = reader();
      await writeFile(file, jsonl(user('go'), assistant([text('Done.\n\n**Open questions:** None')])));
      expect((await r.read(SID, [CWD])).askedYou).toBeUndefined();
    });

    it('follows new lines: a question, then a reply, then a new question', async () => {
      const r = reader();
      await writeFile(file, jsonl(user('go'), assistant([text('Push it?')], 'm1')));
      expect((await r.read(SID, [CWD])).askedYou?.excerpt).toBe('Push it?');

      await appendFile(file, jsonl(user('yes')));
      expect((await r.read(SID, [CWD])).askedYou).toBeUndefined();

      await appendFile(file, jsonl(assistant([text('Pushed. Tag a release too?')], 'm2')));
      expect((await r.read(SID, [CWD])).askedYou?.excerpt).toBe('Pushed. Tag a release too?');

      await appendFile(file, jsonl(crossSession()));
      expect((await r.read(SID, [CWD])).askedYou?.excerpt).toBe('Pushed. Tag a release too?');
    });

    it('counts a question whose prompt is outside the window as unanswered', async () => {
      const r = reader({ initialWindowBytes: 1024, maxWindowBytes: 1024 });
      await writeFile(file, jsonl(user('far back'), filler(3000), assistant([text('Ship it?')])));
      const info = await r.read(SID, [CWD]);
      expect(info.lastUserPrompt).toBeUndefined();
      expect(info.askedYou?.excerpt).toBe('Ship it?');
    });
  });

  it('is ok with no fields for an empty file', async () => {
    await writeFile(file, '');
    expect(await reader().read(SID, [CWD])).toEqual({ transcript: 'ok' });
  });

  it('tries each cwd it is given', async () => {
    await writeFile(file, jsonl(user('found')));
    const info = await reader().read(SID, ['/some/symlinked/path', CWD]);
    expect(info.lastUserPrompt).toBe('found');
  });

  it('finds a transcript under another project directory, as for a long hashed path', async () => {
    const hashed = path.join(configDir, 'projects', '-work-pitwall-test-very-long-path-truncated-abc123');
    await mkdir(hashed, { recursive: true });
    await writeFile(path.join(hashed, `${SID}.jsonl`), jsonl(user('from the hashed dir')));
    expect((await reader().read(SID, ['/does/not/match'])).lastUserPrompt).toBe('from the hashed dir');
  });

  it('is missing when the transcript is nowhere, and searches again only after a while', async () => {
    const r = reader({ missingRetryMs: 30_000 });
    expect(await r.read(SID, ['/does/not/match'])).toEqual({ transcript: 'missing' });

    const elsewhere = path.join(configDir, 'projects', 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, `${SID}.jsonl`), jsonl(user('appeared')));
    expect(await r.read(SID, ['/does/not/match'])).toEqual({ transcript: 'missing' });

    now += 30_001;
    expect((await r.read(SID, ['/does/not/match'])).lastUserPrompt).toBe('appeared');
  });

  it('still checks the encoded path on every poll while a session is missing', async () => {
    const r = reader({ missingRetryMs: 30_000 });
    expect(await r.read(SID, [CWD])).toEqual({ transcript: 'missing' });
    await writeFile(file, jsonl(user('new session')));
    expect((await r.read(SID, [CWD])).lastUserPrompt).toBe('new session');
  });

  it('is missing when the projects directory does not exist', async () => {
    const r = createTranscriptReader({ configDir: path.join(configDir, 'nope') });
    expect(await r.read(SID, [CWD])).toEqual({ transcript: 'missing' });
  });

  it('refuses session ids that could leave the projects directory', async () => {
    const r = reader();
    for (const id of ['../escape', 'a/b', '', '.hidden']) {
      expect(await r.read(id, [CWD])).toEqual({ transcript: 'missing' });
    }
  });

  it('is missing once the file is deleted', async () => {
    const r = reader();
    await writeFile(file, jsonl(user('here')));
    expect((await r.read(SID, [CWD])).transcript).toBe('ok');
    await rm(file);
    expect(await r.read(SID, [CWD])).toEqual({ transcript: 'missing' });
  });

  it.skipIf(process.getuid?.() === 0)('is unreadable when the file cannot be opened', async () => {
    await writeFile(file, jsonl(user('secret')));
    await chmod(file, 0o000);
    try {
      expect(await reader().read(SID, [CWD])).toEqual({ transcript: 'unreadable' });
    } finally {
      await chmod(file, 0o600);
    }
  });

  describe('incremental reads', () => {
    it('reads only the bytes added since the last read', async () => {
      const r = reader();
      const first = jsonl(user('first prompt'));
      await writeFile(file, first);
      expect((await r.read(SID, [CWD])).lastUserPrompt).toBe('first prompt');

      // Rewrite the bytes already read (same length, so not a shrink) and add a
      // line. Only the new line should be seen.
      const rewritten = first.replace('first prompt', 'other prompt');
      expect(rewritten.length).toBe(first.length);
      const reply = assistant([text('reply')]);
      await writeFile(file, rewritten + jsonl(reply));

      const info = await r.read(SID, [CWD]);
      expect(info.lastUserPrompt).toBe('first prompt');
      expect(info.lastActivityAt).toBe(reply.timestamp);
    });

    it('keeps earlier fields when new lines do not replace them', async () => {
      const r = reader();
      await writeFile(file, jsonl(user('the prompt'), assistant([text('Should I ship the answer?')])));
      await r.read(SID, [CWD]);
      await appendFile(file, jsonl(assistant([toolUse('Bash')], 'm2'), user([toolResult('ok')])));
      const info = await r.read(SID, [CWD]);
      expect(info.lastUserPrompt).toBe('the prompt');
      expect(info.askedYou?.excerpt).toBe('Should I ship the answer?');
    });

    it('carries a partial last line over to the next read', async () => {
      const r = reader();
      const line = jsonl(user('héllo wörld 🎉 done'));
      const bytes = Buffer.from(line);
      // Cut inside the emoji's four UTF-8 bytes.
      const cut = bytes.indexOf(Buffer.from('🎉')) + 2;
      await writeFile(file, Buffer.concat([Buffer.from(jsonl(user('earlier'))), bytes.subarray(0, cut)]));
      expect((await r.read(SID, [CWD])).lastUserPrompt).toBe('earlier');

      await appendFile(file, bytes.subarray(cut));
      expect((await r.read(SID, [CWD])).lastUserPrompt).toBe('héllo wörld 🎉 done');
    });

    describe('a line that grows past 8 MiB without a newline', () => {
      const MIB = 1024 * 1024;
      // A user prompt that is valid JSON once its closing `"}}` and newline arrive.
      const start = '{"type":"user","message":{"role":"user","content":"';

      /** Writes a prompt, then grows one unfinished line to 9 MiB in 3 MiB steps, reading after each. */
      async function growPastTheLimit() {
        const r = reader({ maxWindowBytes: 4 * MIB });
        await writeFile(file, jsonl(user('before the long line')));
        expect((await r.read(SID, [CWD])).lastUserPrompt).toBe('before the long line');
        await appendFile(file, start + 'x'.repeat(3 * MIB - start.length));
        for (let read = 0; read < 3; read++) {
          if (read > 0) await appendFile(file, 'x'.repeat(3 * MIB));
          expect((await r.read(SID, [CWD])).lastUserPrompt).toBe('before the long line');
        }
        return r;
      }

      it('drops the line instead of keeping it: once finished, it is never applied', async () => {
        const r = await growPastTheLimit();
        // Kept and joined, the finished line would be a prompt of x's.
        await appendFile(file, '"}}\n');
        expect((await r.read(SID, [CWD])).lastUserPrompt).toBe('before the long line');

        await appendFile(file, jsonl(user('after the long line')));
        expect((await r.read(SID, [CWD])).lastUserPrompt).toBe('after the long line');
      });

      it('skips the rest of the dropped line, even when the rest on its own looks like an entry', async () => {
        const r = await growPastTheLimit();
        // Without skipping to the newline, these bytes would parse as a prompt.
        await appendFile(file, jsonl(user('the end of the long line')));
        expect((await r.read(SID, [CWD])).lastUserPrompt).toBe('before the long line');

        await appendFile(file, jsonl(user('after the long line')));
        expect((await r.read(SID, [CWD])).lastUserPrompt).toBe('after the long line');
      });
    });

    it('joins text blocks of one message written across two reads', async () => {
      const r = reader();
      await writeFile(file, jsonl(assistant([text('Done.\n\n**Open questions:**\n- Should I push it?')], 'm1')));
      expect((await r.read(SID, [CWD])).askedYou?.excerpt).toBe('Should I push it?');
      // The second block asks nothing on its own, so the question stays only if the blocks are joined.
      await appendFile(file, jsonl(assistant([toolUse('Bash')], 'm1'), assistant([text('**Next steps:**\n1. You review.')], 'm1')));
      expect((await r.read(SID, [CWD])).askedYou).toEqual({ reason: 'open-questions', excerpt: 'Should I push it?' });
    });

    it('starts again when the file shrinks', async () => {
      const r = reader();
      await writeFile(file, jsonl(user('long gone'), assistant([text('also gone')]), filler(500)));
      await r.read(SID, [CWD]);
      await truncateFile(file, 0);
      await writeFile(file, jsonl(user('fresh start')));
      expect(await r.read(SID, [CWD])).toEqual({
        transcript: 'ok',
        lastActivityAt: expect.any(String),
        lastUserPrompt: 'fresh start',
      });
    });

    it('starts again when the file is replaced', async () => {
      const r = reader();
      await writeFile(file, jsonl(user('old file')));
      await r.read(SID, [CWD]);
      const replacement = `${file}.tmp`;
      await writeFile(replacement, jsonl(user('replacement file'), filler(300)));
      await rename(replacement, file);
      expect((await r.read(SID, [CWD])).lastUserPrompt).toBe('replacement file');
    });

    it('forgets sessions that are no longer retained', async () => {
      const r = reader();
      const first = jsonl(user('first prompt'));
      await writeFile(file, first);
      await r.read(SID, [CWD]);
      r.retain(new Set());
      await writeFile(file, first.replace('first prompt', 'other prompt') + jsonl(filler(100)));
      expect((await r.read(SID, [CWD])).lastUserPrompt).toBe('other prompt');
    });
  });

  describe('windowing big files', () => {
    it('reads only the last window the first time, and widens it once for a missing field', async () => {
      const r = reader({ initialWindowBytes: 1024, maxWindowBytes: 4096 });
      // The prompt is ~2.5 KB from the end: outside the first window, inside the wider one.
      const prompt = user('the prompt');
      const answer = assistant([text('the answer')]);
      await writeFile(file, jsonl(filler(2000), prompt, filler(1200), filler(1200), answer));
      const info = await r.read(SID, [CWD]);
      expect(info.lastUserPrompt).toBe('the prompt');
      expect(info.lastActivityAt).toBe(answer.timestamp);
    });

    it('gives up on a field the wider window does not have, until new lines bring it', async () => {
      const r = reader({ initialWindowBytes: 1024, maxWindowBytes: 4096 });
      const prompt = user('too far back');
      const recent = assistant([text('recent')]);
      await writeFile(file, jsonl(prompt, ...Array.from({ length: 6 }, () => filler(1000)), recent));
      const info = await r.read(SID, [CWD]);
      expect(info.lastUserPrompt).toBeUndefined();
      expect(info.lastActivityAt).toBe(recent.timestamp);
      expect(info.transcript).toBe('ok');

      await appendFile(file, jsonl(user('a new prompt')));
      expect((await r.read(SID, [CWD])).lastUserPrompt).toBe('a new prompt');
    });

    it('keeps the first line of a window that starts on a line boundary', async () => {
      const r = reader({ initialWindowBytes: 1024, maxWindowBytes: 1024 });
      const prompt = jsonl(user('boundary prompt'));
      // The tail is exactly one window long, so the window starts on the prompt line.
      const tail = prompt + lineOfBytes(1024 - Buffer.byteLength(prompt));
      expect(Buffer.byteLength(tail)).toBe(1024);
      await writeFile(file, jsonl(user('outside the window'), filler(2000)) + tail);
      expect((await r.read(SID, [CWD])).lastUserPrompt).toBe('boundary prompt');
    });

    it('drops the partial first line of a window', async () => {
      const r = reader({ initialWindowBytes: 1024, maxWindowBytes: 1024 });
      // The window starts inside the prompt line, so it must not be half-parsed.
      const prompt = jsonl(user('cut in half'));
      const tail = jsonl(filler(900));
      const head = jsonl(filler(3000));
      await writeFile(file, head + prompt + tail);
      expect(Buffer.byteLength(prompt + tail)).toBeGreaterThan(1024);
      expect(Buffer.byteLength(tail)).toBeLessThan(1024);
      expect((await r.read(SID, [CWD])).lastUserPrompt).toBeUndefined();
    });

    it('reads afresh when a file grows by more than the wide window between polls', async () => {
      const r = reader({ initialWindowBytes: 1024, maxWindowBytes: 4096 });
      await writeFile(file, jsonl(user('before the burst')));
      await r.read(SID, [CWD]);
      const start = user('start of burst');
      const end = assistant([text('end of burst')]);
      await appendFile(file, jsonl(start, ...Array.from({ length: 6 }, () => filler(1000)), end));
      const info = await r.read(SID, [CWD]);
      expect(info.lastActivityAt).toBe(end.timestamp);
      // The burst's prompt is more than 4 KB back, so it was not read.
      expect(info.lastUserPrompt).toBeUndefined();
    });

    it('uses a 256 KiB window widened to 2 MiB by default', async () => {
      const r = reader();
      const big = (n: number) => Array.from({ length: n }, () => filler(10_000));
      // Prompt ~1 MB from the end: found by the widened window.
      const megabyte = user('a megabyte back');
      const latest = assistant([text('latest')]);
      await writeFile(file, jsonl(...big(100), megabyte, ...big(100), latest));
      const found = await r.read(SID, [CWD]);
      expect(found.lastUserPrompt).toBe('a megabyte back');
      expect(found.lastActivityAt).toBe(latest.timestamp);

      // Prompt ~3 MB from the end: past 2 MiB, so it is given up on.
      r.retain(new Set());
      const farther = user('three megabytes back');
      const newest = assistant([text('latest')]);
      await writeFile(file, jsonl(farther, ...big(300), newest));
      const missing = await r.read(SID, [CWD]);
      expect(missing.lastUserPrompt).toBeUndefined();
      expect(missing.lastActivityAt).toBe(newest.timestamp);
    });
  });
});

describe('readNewestEntries', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'pitwall-test-newest-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the newest entries once, as the reader does, with what the ended-session scanner needs', async () => {
    const file = path.join(dir, 'made-up.jsonl');
    const prompt = user('the last prompt', { promptSource: 'typed' });
    const latest = assistant([text('Shall I go on?')]);
    await writeFile(file, jsonl(user('an early prompt', { promptSource: 'typed' }), filler(5000), prompt, latest, { type: 'agent-name', agentName: 'pitwall-test-a' }, aiTitle('A title')));
    expect(await readNewestEntries(file, { initialWindowBytes: 1024, maxWindowBytes: 2048 })).toEqual({
      info: {
        transcript: 'ok',
        lastActivityAt: latest.timestamp,
        lastUserPrompt: 'the last prompt',
        askedYou: { reason: 'question', excerpt: 'Shall I go on?' },
        aiTitle: 'A title',
      },
      inBackground: false,
      setName: 'pitwall-test-a',
      typedPrompt: true,
    });
  });

  it('says nothing of the background or a typed prompt it did not read, and is undefined for a file that has gone', async () => {
    const file = path.join(dir, 'made-up.jsonl');
    await writeFile(file, jsonl(filler(200)));
    expect(await readNewestEntries(file)).toEqual({ info: { transcript: 'ok' }, typedPrompt: false });
    expect(await readNewestEntries(path.join(dir, 'gone.jsonl'))).toBeUndefined();
    await expect(readNewestEntries(dir)).rejects.toThrow();
  });
});

/** One JSONL line the index ignores, exactly `bytes` long including its newline. */
function lineOfBytes(bytes: number): string {
  const overhead = Buffer.byteLength(`${JSON.stringify({ type: 'attachment', body: '' })}\n`);
  return `${JSON.stringify({ type: 'attachment', body: 'x'.repeat(bytes - overhead) })}\n`;
}
