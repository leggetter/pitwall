// pitwall.draft.v1:<sessionId> (W44): what's stored, what's read back, and storage that's missing,
// throws or is full. Made-up drafts only.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { draftKey, readDraft, writeDraft, type DraftStorageSource } from './drafts.js';

const ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';
const KEY = `pitwall.draft.v1:${ID}`;
const AT = '2026-03-02T12:00:00.000Z';

function memory(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
    removeItem: vi.fn((key: string) => void values.delete(key)),
  };
  return { source: (() => storage) as DraftStorageSource, storage, values };
}

const blocked = () => new DOMException('The operation is insecure.', 'SecurityError');
const full = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

afterEach(() => {
  window.sessionStorage.clear();
});

describe('the key', () => {
  it('is pitwall.draft.v1: then the session’s id, one per conversation', () => {
    expect(draftKey(ID)).toBe(KEY);
    expect(draftKey(OTHER)).not.toBe(draftKey(ID));
  });
});

describe('writeDraft', () => {
  it('stores the text, versioned, and nothing else', () => {
    const { source, values } = memory();
    writeDraft(ID, { text: 'A made-up draft.\nTwo lines.' }, source);
    expect([...values]).toEqual([[KEY, '{"v":1,"text":"A made-up draft.\\nTwo lines."}']]);
  });

  it('stores a send that was out, or that pitwall couldn’t tell about, with its time', () => {
    const { source, values } = memory();
    writeDraft(ID, { text: 'A made-up draft.', send: { at: AT, state: 'out' } }, source);
    expect(values.get(KEY)).toBe(`{"v":1,"text":"A made-up draft.","send":{"at":"${AT}","state":"out"}}`);
    writeDraft(ID, { text: 'A made-up draft.', send: { at: AT, state: 'uncertain' } }, source);
    expect(JSON.parse(values.get(KEY)!)).toEqual({ v: 1, text: 'A made-up draft.', send: { at: AT, state: 'uncertain' } });
  });

  it('removes the key for no draft, or an empty one', () => {
    const { source, values } = memory({ [KEY]: '{"v":1,"text":"old"}' });
    writeDraft(ID, { text: '' }, source);
    expect(values.has(KEY)).toBe(false);
    values.set(KEY, '{"v":1,"text":"old"}');
    writeDraft(ID, undefined, source);
    expect(values.has(KEY)).toBe(false);
  });

  it('touches only its own session’s key', () => {
    const { source, values } = memory({ [draftKey(OTHER)]: '{"v":1,"text":"the other one"}' });
    writeDraft(ID, { text: 'mine' }, source);
    writeDraft(ID, undefined, source);
    expect([...values]).toEqual([[draftKey(OTHER), '{"v":1,"text":"the other one"}']]);
  });

  it('removes what was stored when the write fails, as over quota, so a reload never brings back an older copy', () => {
    const { source, storage, values } = memory({ [KEY]: '{"v":1,"text":"an older copy"}' });
    storage.setItem.mockImplementation(() => {
      throw full();
    });
    expect(() => writeDraft(ID, { text: 'the newer copy' }, source)).not.toThrow();
    expect(values.has(KEY)).toBe(false);
  });

  it('never throws when storage is blocked: reading it, writing to it, or removing from it', () => {
    const throwing: DraftStorageSource = () => {
      throw blocked();
    };
    expect(() => writeDraft(ID, { text: 'x' }, throwing)).not.toThrow();
    const { source, storage } = memory();
    storage.setItem.mockImplementation(() => {
      throw blocked();
    });
    storage.removeItem.mockImplementation(() => {
      throw blocked();
    });
    expect(() => writeDraft(ID, { text: 'x' }, source)).not.toThrow();
    expect(() => writeDraft(ID, undefined, source)).not.toThrow();
    expect(() => writeDraft(ID, { text: 'x' }, () => null)).not.toThrow();
  });

  it('uses the tab’s sessionStorage by default, never localStorage', () => {
    writeDraft(ID, { text: 'A made-up draft.' });
    expect(window.sessionStorage.getItem(KEY)).toBe('{"v":1,"text":"A made-up draft."}');
    expect(window.localStorage.length).toBe(0);
    writeDraft(ID, undefined);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });
});

describe('readDraft', () => {
  it('reads back what writeDraft stored', () => {
    const { source } = memory();
    writeDraft(ID, { text: 'A made-up draft.' }, source);
    expect(readDraft(ID, source)).toEqual({ text: 'A made-up draft.' });
    writeDraft(ID, { text: 'A made-up draft.', send: { at: AT, state: 'out' } }, source);
    expect(readDraft(ID, source)).toEqual({ text: 'A made-up draft.', send: { at: AT, state: 'out' } });
    expect(readDraft(OTHER, source)).toBeUndefined();
  });

  it.each([
    ['nothing', undefined],
    ['an empty string', ''],
    ['not JSON', '{"v":1,'],
    ['another version', '{"v":2,"text":"x"}'],
    ['no version', '{"text":"x"}'],
    ['empty text', '{"v":1,"text":""}'],
    ['text that isn’t a string', '{"v":1,"text":42}'],
    ['an array', '[1]'],
    ['null', 'null'],
  ])('reads %s as no draft', (_, raw) => {
    const { source } = memory(raw === undefined ? {} : { [KEY]: raw });
    expect(readDraft(ID, source)).toBeUndefined();
  });

  it.each([
    ['no time', '{"state":"out"}'],
    ['a time that isn’t one', '{"at":"soon","state":"out"}'],
    ['another state', `{"at":"${AT}","state":"delivered"}`],
    ['not an object', '"out"'],
  ])('keeps the text and leaves out a send with %s', (_, send) => {
    const { source } = memory({ [KEY]: `{"v":1,"text":"x","send":${send}}` });
    expect(readDraft(ID, source)).toEqual({ text: 'x' });
  });

  it('reads no draft when storage is missing, throws when reached, or throws on getItem', () => {
    expect(readDraft(ID, () => null)).toBeUndefined();
    expect(
      readDraft(ID, () => {
        throw blocked();
      }),
    ).toBeUndefined();
    const { source, storage } = memory({ [KEY]: '{"v":1,"text":"x"}' });
    storage.getItem.mockImplementation(() => {
      throw blocked();
    });
    expect(readDraft(ID, source)).toBeUndefined();
  });
});
