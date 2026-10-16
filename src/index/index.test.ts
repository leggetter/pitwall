import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexSnapshot } from '../shared/protocol.js';
import { startIndexer } from './index.js';

// Tests the W1 stub. W2 replaces the stub and this test with the real index.
describe('startIndexer (stub)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits one empty snapshot with the given roots', () => {
    const roots = ['/tmp/pitwall-test-a', '/tmp/pitwall-test-b'];
    const indexer = startIndexer({ roots });
    const received: IndexSnapshot[] = [];
    indexer.subscribe((snapshot) => received.push(snapshot));

    expect(indexer.latest()).toBeUndefined();

    vi.advanceTimersByTime(10_000);

    expect(received).toHaveLength(1);
    const [snapshot] = received;
    expect(snapshot).toEqual({
      generatedAt: expect.any(String),
      roots,
      groups: [],
      source: { ok: true },
    });
    expect(new Date(snapshot!.generatedAt).toISOString()).toBe(snapshot!.generatedAt);
    expect(indexer.latest()).toBe(snapshot);

    indexer.stop();
  });
});
