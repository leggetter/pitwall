import { appendFile, chmod, mkdir, mkdtemp, rename, rm, truncate as truncateFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyEntry,
  applyLine,
  ASSISTANT_TEXT_KEEP,
  assistantTextOf,
  createTranscriptReader,
  defaultConfigDir,
  encodeProjectDir,
  stripSystemReminders,
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

describe('applyLine', () => {
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
      lastAssistantText: 'Added the test.',
      lastUserPrompt: 'add a test',
    });
  });

  it('truncates the assistant text to 500 characters', async () => {
    await writeFile(file, jsonl(assistant([text(`  ${'a'.repeat(800)}  `)])));
    const info = await reader().read(SID, [CWD]);
    expect(info.lastAssistantText).toHaveLength(500);
    expect(info.lastAssistantText?.endsWith('…')).toBe(true);
  });

  it('strips markdown from the assistant text before truncating it', async () => {
    const code = `\`\`\`\n${'x'.repeat(2000)}\n\`\`\``;
    await writeFile(file, jsonl(assistant([text(`## Result\n\n${code}\n\n**All** tests \`pass\`.`)])));
    expect((await reader().read(SID, [CWD])).lastAssistantText).toBe('Result\n\n[code]\n\nAll tests pass.');
  });

  it('shows the prose after a long code block at the start', async () => {
    const code = `\`\`\`diff\n${'+ added line\n'.repeat(2000)}\`\`\``;
    await writeFile(file, jsonl(assistant([text(`${code}\n\nShould I apply this?`)])));
    expect((await reader().read(SID, [CWD])).lastAssistantText).toBe('[code]\n\nShould I apply this?');
  });

  it('strips a hostile 64 KiB message quickly, reading only the start it shows', async () => {
    await writeFile(file, jsonl(assistant([text('['.repeat(ASSISTANT_TEXT_KEEP))])));
    const started = performance.now();
    const info = await reader().read(SID, [CWD]);
    expect(performance.now() - started).toBeLessThan(FAST_MS);
    expect(info.lastAssistantText).toBe(`${'['.repeat(499)}…`);
  });

  it('drops assistant text that is only markdown syntax', async () => {
    await writeFile(file, jsonl(assistant([text('---')])));
    expect(await reader().read(SID, [CWD])).toEqual({ transcript: 'ok', lastActivityAt: expect.any(String) });
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

    it('reads the question from the whole message, not the 500 characters shown', async () => {
      const long = `${'Long report line.\n'.repeat(100)}\nWant me to open the PR?`;
      await writeFile(file, jsonl(user('report'), assistant([text(long)])));
      const info = await reader().read(SID, [CWD]);
      expect(info.lastAssistantText?.length).toBe(500);
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
      await writeFile(file, rewritten + jsonl(assistant([text('reply')])));

      const info = await r.read(SID, [CWD]);
      expect(info.lastUserPrompt).toBe('first prompt');
      expect(info.lastAssistantText).toBe('reply');
    });

    it('keeps earlier fields when new lines do not replace them', async () => {
      const r = reader();
      await writeFile(file, jsonl(user('the prompt'), assistant([text('the answer')])));
      await r.read(SID, [CWD]);
      await appendFile(file, jsonl(assistant([toolUse('Bash')], 'm2'), user([toolResult('ok')])));
      const info = await r.read(SID, [CWD]);
      expect(info.lastUserPrompt).toBe('the prompt');
      expect(info.lastAssistantText).toBe('the answer');
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

    it('joins text blocks of one message written across two reads', async () => {
      const r = reader();
      await writeFile(file, jsonl(assistant([text('part one')], 'm1')));
      await r.read(SID, [CWD]);
      await appendFile(file, jsonl(assistant([toolUse('Bash')], 'm1'), assistant([text('part two')], 'm1')));
      expect((await r.read(SID, [CWD])).lastAssistantText).toBe('part one\npart two');
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
      await writeFile(file, jsonl(filler(2000), user('the prompt'), filler(1200), filler(1200), assistant([text('the answer')])));
      const info = await r.read(SID, [CWD]);
      expect(info.lastUserPrompt).toBe('the prompt');
      expect(info.lastAssistantText).toBe('the answer');
    });

    it('gives up on a field the wider window does not have, until new lines bring it', async () => {
      const r = reader({ initialWindowBytes: 1024, maxWindowBytes: 4096 });
      await writeFile(file, jsonl(user('too far back'), ...Array.from({ length: 6 }, () => filler(1000)), assistant([text('recent')])));
      const info = await r.read(SID, [CWD]);
      expect(info.lastUserPrompt).toBeUndefined();
      expect(info.lastAssistantText).toBe('recent');
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
      await appendFile(file, jsonl(user('start of burst'), ...Array.from({ length: 6 }, () => filler(1000)), assistant([text('end of burst')])));
      const info = await r.read(SID, [CWD]);
      expect(info.lastAssistantText).toBe('end of burst');
      // The burst's prompt is more than 4 KB back, so it was not read.
      expect(info.lastUserPrompt).toBeUndefined();
    });

    it('uses a 256 KiB window widened to 2 MiB by default', async () => {
      const r = reader();
      const big = (n: number) => Array.from({ length: n }, () => filler(10_000));
      // Prompt ~1 MB from the end: found by the widened window.
      await writeFile(file, jsonl(...big(100), user('a megabyte back'), ...big(100), assistant([text('latest')])));
      const found = await r.read(SID, [CWD]);
      expect(found.lastUserPrompt).toBe('a megabyte back');
      expect(found.lastAssistantText).toBe('latest');

      // Prompt ~3 MB from the end: past 2 MiB, so it is given up on.
      r.retain(new Set());
      await writeFile(file, jsonl(user('three megabytes back'), ...big(300), assistant([text('latest')])));
      const missing = await r.read(SID, [CWD]);
      expect(missing.lastUserPrompt).toBeUndefined();
      expect(missing.lastAssistantText).toBe('latest');
    });
  });
});

/** One JSONL line the index ignores, exactly `bytes` long including its newline. */
function lineOfBytes(bytes: number): string {
  const overhead = Buffer.byteLength(`${JSON.stringify({ type: 'attachment', body: '' })}\n`);
  return `${JSON.stringify({ type: 'attachment', body: 'x'.repeat(bytes - overhead) })}\n`;
}
