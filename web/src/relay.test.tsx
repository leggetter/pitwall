// The message box's and the relay alert's words and looks (W24). Made-up text only.
import { describe, expect, it } from 'vitest';
import type { ConversationEntry, RelayExchange } from '../../src/shared/protocol.js';
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

  it('matches a reply the relay cut short by what was kept', () => {
    expect(replyInConversation(exchange(`${LONG.slice(0, 50)}…`), [said(LONG)])).toBe(true);
  });

  it('ignores entries from before the send, your own messages, and tool calls', () => {
    expect(replyInConversation(exchange(LONG), [said(LONG, '2026-03-02T11:40:00.000Z')])).toBe(false);
    expect(replyInConversation(exchange(LONG), [{ kind: 'user', at: '2026-03-02T11:51:00.000Z', text: LONG }])).toBe(false);
    expect(replyInConversation(exchange(LONG), [{ kind: 'tool', at: '2026-03-02T11:51:00.000Z', text: 'SendMessage', toolName: 'SendMessage' }])).toBe(false);
  });
});

describe('relayAlertText', () => {
  const alert = { at: '2026-03-02T11:50:00.000Z', detail: 'made up', count: 1, blocked: false };
  const off = { since: '2026-03-02T11:50:00.000Z', reason: "its gate didn't check a SendMessage call." };

  it('says a blocked one sent nothing', () => {
    const text = relayAlertText({ ...alert, blocked: true, count: 2 });
    expect(text.title).toBe("pitwall blocked a message you didn't ask for");
    expect(text.summary).toContain('so nothing was sent.');
    expect(text.count).toBe('2 times since pitwall started.');
  });

  it('says one that wasn’t blocked may have been sent, and says messaging is off only with relayOff', () => {
    const text = relayAlertText(alert);
    expect(text.title).toBe("pitwall's relay may have sent a message you didn't ask for");
    expect(text.summary).toContain("Check your sessions' conversations for a message from pitwall-relay.");
    expect(text.summary).not.toMatch(/off|stopped using/);
    expect(text.count).toBe('Once since pitwall started.');
    expect(relayAlertText(alert, off).summary).toMatch(/Messaging is off until you restart pitwall\.$/);
  });
});
