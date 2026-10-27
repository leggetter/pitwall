// The web tests' setup (test/setup.ts) keeps every test off the network (W72's review): happy-dom's
// fetch, WebSocket and XMLHttpRequest are real, and the user's own pitwall may be listening on
// 127.0.0.1:4517, the page's origin in tests.
import { describe, expect, it } from 'vitest';
import { defaultFetch } from './api.js';
import { defaultSocketFactory } from './connection.js';

describe('the web tests are offline', () => {
  it("fail the app's default fetch, as a network error, without a request", async () => {
    await expect(defaultFetch('/api/editors', {})).rejects.toThrow(/never reach the network/);
    await expect(window.fetch('http://127.0.0.1:4517/api/snapshot')).rejects.toThrow(/never reach the network/);
  });

  it("refuse the app's default WebSocket, and any other", () => {
    expect(() => defaultSocketFactory(`ws://${window.location.host}/ws`)).toThrow(/a WebSocket was refused/);
    expect(() => new WebSocket('ws://127.0.0.1:4517/attach')).toThrow(/never reach the network/);
  });

  it('refuse an XMLHttpRequest', () => {
    expect(() => new XMLHttpRequest()).toThrow(/an XMLHttpRequest was refused/);
  });
});
