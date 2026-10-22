// The message box's and the relay alert's words and looks (W24). Made-up text only.
import { describe, expect, it } from 'vitest';
import type { ConversationEntry, RelayAlert, RelayExchange } from '../../src/shared/protocol.js';
import { characterCount, relayAlertText, replyInConversation, resultLook } from './relay.js';

describe('characterCount', () => {
  it.each([
    [0, undefined],
    [6553, undefined],
    [6554, { text: '6,554 / 8,192', over: false }],
    [8192, { text: '8,192 / 8,192', over: false }],
    [8193, { text: '1 character over the 8,192 limit', over: true }],
    [9192, { text: '1,000 characters over the 8,192 limit', over: true }],
  ])('%i characters: %o', (length, expected) => {
    expect(characterCount(length)).toEqual(expected);
  });

  it('starts at 80 % of whatever the limit is', () => {
    expect(characterCount(79, 100)).toBeUndefined();
    expect(characterCount(80, 100)).toEqual({ text: '80 / 100', over: false });
  });
});

describe('resultLook', () => {
  it.each([
    ['delivered', 'success', 'status'],
    ['held', 'warning', 'alert'],
    ['uncertain', 'warning', 'alert'],
    ['refused', 'danger', 'alert'],
    ['failed', 'danger', 'alert'],
    ['error', 'danger', 'alert'],
  ] as const)('%s is %s, role="%s"', (status, tone, role) => {
    expect(resultLook(status)).toEqual({ tone, role });
  });
});

describe('replyInConversation', () => {
  const sentAt = '2026-03-02T11:50:00.000Z';
  const exchange = (text: string): RelayExchange => ({ sentAt, status: 'delivered', reply: { at: '2026-03-02T11:52:00.000Z', text } });
  const said = (text: string, at = '2026-03-02T11:51:00.000Z'): ConversationEntry => ({ kind: 'assistant', at, text });
  const LONG = 'The export job retries three times now, and every test passes.';

  it('is false with no reply, or no entry that has it', () => {
    expect(replyInConversation({ sentAt, status: 'delivered' }, [said('anything')])).toBe(false);
    expect(replyInConversation(exchange(LONG), [said('Something else.')])).toBe(false);
  });

  it('is true when one of Claude’s entries since the send is the reply, whitespace aside', () => {
    expect(replyInConversation(exchange('Done.'), [said('  Done.\n')])).toBe(true);
    expect(replyInConversation(exchange(`${LONG}\n\nThat’s all.`), [said(`${LONG} That’s all.`)])).toBe(true);
  });

  it('lets a long reply sit inside a longer entry, but never a short one', () => {
    expect(replyInConversation(exchange(LONG), [said(`Replying to pitwall:\n${LONG}`)])).toBe(true);
    expect(replyInConversation(exchange('Done.'), [said('Done. The tests pass.')])).toBe(false);
  });

  it('matches a reply written in markdown against the markdown the entry now carries (W36)', () => {
    const markdown = '**Done.** The export retries three times now, and `npm test` passes:\n\n- one\n- two';
    expect(replyInConversation(exchange(markdown), [{ ...said(markdown), markdown: true }])).toBe(true);
    expect(replyInConversation(exchange('**Done.**'), [{ ...said('**Done.**\n'), markdown: true }])).toBe(true);
  });

  it('matches a reply the relay cut short by what was kept', () => {
    expect(replyInConversation(exchange(`${LONG.slice(0, 50)}…`), [said(LONG)])).toBe(true);
  });

  it('ignores entries from before the send, your own messages, and tool calls', () => {
    expect(replyInConversation(exchange(LONG), [said(LONG, '2026-03-02T11:40:00.000Z')])).toBe(false);
    expect(replyInConversation(exchange(LONG), [{ kind: 'user', at: '2026-03-02T11:51:00.000Z', text: LONG }])).toBe(false);
    expect(replyInConversation(exchange(LONG), [{ kind: 'tool', at: '2026-03-02T11:51:00.000Z', text: 'SendMessage', toolName: 'SendMessage' }])).toBe(false);
  });

  describe('a message to pitwall in the conversation (W46)', () => {
    const toPitwall = (at: string | undefined, text = LONG, truncated = false): ConversationEntry => ({
      kind: 'to-pitwall',
      text,
      markdown: true,
      ...(at === undefined ? {} : { at }),
      ...(truncated ? { truncated: true as const } : {}),
    });
    const after = '2026-03-02T11:51:00.000Z';

    it('is true for one at or after the send whose text is the reply the relay received, whitespace aside', () => {
      expect(replyInConversation(exchange(LONG), [toPitwall(after)])).toBe(true);
      expect(replyInConversation(exchange(LONG), [toPitwall(sentAt)])).toBe(true);
      expect(replyInConversation(exchange('Done.'), [toPitwall(after, '\n  Done.\n\n')])).toBe(true);
      expect(replyInConversation({ ...exchange(LONG), status: 'held' }, [toPitwall(after)])).toBe(true);
    });

    it('matches the start of the message when the relay cut its copy, so the conversation shows at least as much', () => {
      const whole = `${LONG} ${'More words in the made-up reply. '.repeat(80)}`;
      expect(replyInConversation(exchange(`${whole.slice(0, 2000)}…`), [toPitwall(after, whole)])).toBe(true);
      // The server's 32 Ki cut still shows more than the relay's 2 KiB copy.
      expect(replyInConversation(exchange(`${whole.slice(0, 2000)}…`), [toPitwall(after, whole.slice(0, 2600), true)])).toBe(true);
    });

    it("is false for an entry the server cut shorter than the relay's copy, past its page's budget: the footer keeps it (W48's G1)", () => {
      const whole = `${LONG} ${'More words in the made-up reply. '.repeat(80)}`;
      expect(replyInConversation(exchange(`${whole.slice(0, 2000)}…`), [toPitwall(after, whole.slice(0, 512), true)])).toBe(false);
      expect(replyInConversation(exchange(whole.slice(0, 900)), [toPitwall(after, whole.slice(0, 512), true)])).toBe(false);
    });

    it("is false for a different message, as from a session that took the relay's name, so the relay's own copy stays in the footer", () => {
      expect(replyInConversation(exchange(LONG), [toPitwall(after, 'Something else entirely, sent to whoever took the name.')])).toBe(false);
      // Only the whole reply: a message that merely starts like an uncut one isn't it.
      expect(replyInConversation(exchange('Done.'), [toPitwall(after, 'Done. And something else.')])).toBe(false);
    });

    it('is false with no reply from the relay, for one before the send, one with no time or a time that is not one, and for no entries', () => {
      expect(replyInConversation({ sentAt, status: 'delivered' }, [toPitwall(after)])).toBe(false);
      expect(replyInConversation(exchange(LONG), [toPitwall('2026-03-02T11:49:59.999Z')])).toBe(false);
      expect(replyInConversation(exchange(LONG), [toPitwall(undefined)])).toBe(false);
      expect(replyInConversation(exchange(LONG), [toPitwall('not a time')])).toBe(false);
      // Before the conversation loads: the reply stays in the footer.
      expect(replyInConversation(exchange(LONG), [])).toBe(false);
    });

    it('keeps the text match on Claude’s entries as the fallback', () => {
      expect(replyInConversation(exchange(LONG), [toPitwall('2026-03-02T11:40:00.000Z'), said(LONG)])).toBe(true);
    });
  });
});

describe('relayAlertText', () => {
  const alert: RelayAlert = { at: '2026-03-02T11:50:00.000Z', detail: 'made up', count: 1, blocked: false, cause: 'unrequested' };
  const off = { since: '2026-03-02T11:50:00.000Z', reason: "its gate didn't check a SendMessage call." };

  it('says a blocked one nobody asked for sent nothing, and usually came from another session', () => {
    const text = relayAlertText({ ...alert, blocked: true, count: 2 });
    expect(text).toEqual({
      title: "pitwall blocked a message you didn't ask for",
      summary: "Its relay tried to send it, and pitwall's gate stopped it, so nothing was sent. That usually means another session messaged the relay.",
      count: '2 times since pitwall started.',
    });
  });

  it('says one nobody asked for that wasn’t blocked may have been sent, and says messaging is off only with relayOff', () => {
    const text = relayAlertText(alert);
    expect(text).toEqual({
      title: "pitwall's relay may have sent a message you didn't ask for",
      summary: "That usually means another session messaged the relay. Check your sessions' conversations for a message from pitwall-relay.",
      count: 'Once since pitwall started.',
    });
    expect(relayAlertText(alert, off).summary).toMatch(/Messaging is off until you restart pitwall\.$/);
  });

  it('says a changed copy that wasn’t blocked may have been sent, to the session you messaged, and never blames another session (W43)', () => {
    const text = relayAlertText({ ...alert, cause: 'changed' });
    expect(text).toEqual({
      title: "pitwall's relay may have sent a changed copy of your message",
      summary: "pitwall's gate may not have stopped it. Check the conversation of the session you messaged for a message from pitwall-relay.",
      count: 'Once since pitwall started.',
    });
    expect(relayAlertText({ ...alert, cause: 'changed' }, off).summary).toMatch(/pitwall-relay\. Messaging is off until you restart pitwall\.$/);
  });

  it('says a blocked changed copy sent nothing, and never blames another session (W43)', () => {
    const text = relayAlertText({ ...alert, cause: 'changed', blocked: true, count: 3 });
    expect(text).toEqual({
      title: 'pitwall blocked a changed copy of your message',
      summary: "Its relay's copy didn't match what you sent, so pitwall stopped it, and nothing was sent.",
      count: '3 times since pitwall started.',
    });
  });

  it('says a blocked repeat is the relay trying your message again, never another session, and that the repeat wasn’t sent (W52)', () => {
    const text = relayAlertText({ ...alert, cause: 'repeated', blocked: true });
    expect(text).toEqual({
      title: 'pitwall blocked a repeated send of your message',
      summary: "After pitwall's gate stopped its relay's copy of your message, the relay tried again in the same turn. The gate stopped that too, so the repeat wasn't sent.",
      count: 'Once since pitwall started.',
    });
    expect(`${text.title} ${text.summary}`).not.toMatch(/another session|didn't ask for/);
  });

  it('says a repeat that wasn’t blocked may have been sent, says where to look, and says messaging is off only with relayOff (W52)', () => {
    const text = relayAlertText({ ...alert, cause: 'repeated', count: 2 });
    expect(text).toEqual({
      title: "pitwall's relay may have repeated a send of your message",
      summary:
        "After pitwall's gate stopped its relay's copy of your message, the relay tried again in the same turn, and the gate may not have stopped it. Check your sessions' conversations for a message from pitwall-relay.",
      count: '2 times since pitwall started.',
    });
    expect(text.summary).not.toMatch(/another session/);
    expect(relayAlertText({ ...alert, cause: 'repeated' }, off).summary).toMatch(/pitwall-relay\. Messaging is off until you restart pitwall\.$/);
    expect(relayAlertText({ ...alert, cause: 'repeated', blocked: true }, off).summary).toMatch(/wasn't sent\. Messaging is off until you restart pitwall\.$/);
  });

  it('uses the same count, of every alert, for every cause', () => {
    expect(relayAlertText({ ...alert, count: 1200 }).count).toBe('1,200 times since pitwall started.');
    expect(relayAlertText({ ...alert, cause: 'changed', count: 1200 }).count).toBe('1,200 times since pitwall started.');
    expect(relayAlertText({ ...alert, cause: 'repeated', count: 1200 }).count).toBe('1,200 times since pitwall started.');
  });
});
