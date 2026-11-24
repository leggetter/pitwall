import { describe, expect, it, vi } from 'vitest';
import { confirmMessage, createLinkHandler, openTerminalLink, terminalLinkHandler } from './links.js';

const RANGE = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } };

describe('openTerminalLink', () => {
  it('asks first, naming the full URL, then opens http: and https: URLs in a new tab with noopener and noreferrer', () => {
    for (const uri of ['https://example.com/a?b=c#d', 'http://127.0.0.1:4517/', 'HTTPS://EXAMPLE.COM']) {
      const open = vi.fn();
      const confirm = vi.fn(() => true);
      expect(openTerminalLink(uri, { open, confirm }), uri).toBe(true);
      const href = new URL(uri).href;
      expect(confirm).toHaveBeenCalledWith(`Open this link in a new tab?\n\n${href}`);
      expect(open).toHaveBeenCalledWith(href, '_blank', 'noopener,noreferrer');
    }
  });

  it('opens nothing when the user declines', () => {
    const open = vi.fn();
    const confirm = vi.fn(() => false);
    expect(openTerminalLink('https://example.com/', { open, confirm })).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('shows the URL as parsed, the one that opens: an internationalised host in punycode, with nothing left out', () => {
    const confirm = vi.fn((_message: string) => false);
    // The second letter of the host is U+0445, a Cyrillic letter that looks like "x", so the host isn't example.com.
    openTerminalLink('https://e\u0445ample.com/login?next=/admin#x', { open: vi.fn(), confirm });
    expect(confirm).toHaveBeenCalledWith(`Open this link in a new tab?\n\n${new URL('https://e\u0445ample.com/login?next=/admin#x').href}`);
    expect(confirm.mock.calls[0]?.[0]).toMatch(/^Open this link in a new tab\?\n\nhttps:\/\/xn--/);
    expect(confirmMessage(new URL('https://user@example.com:8443/p'))).toBe('Open this link in a new tab?\n\nhttps://user@example.com:8443/p');
  });

  it('refuses any other scheme, a relative URL or garbage without asking', () => {
    const uris = [
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'mailto:someone@example.com',
      'ftp://example.com/',
      'ws://127.0.0.1:4517/ws',
      '/relative/path',
      'example.com',
      '',
      'http://',
    ];
    for (const uri of uris) {
      const open = vi.fn();
      const confirm = vi.fn(() => true);
      expect(openTerminalLink(uri, { open, confirm }), uri).toBe(false);
      expect(confirm, uri).not.toHaveBeenCalled();
      expect(open, uri).not.toHaveBeenCalled();
    }
  });
});

describe('an OSC 8 file link whose visible text is not its file (W211)', () => {
  it('passes the text it shows, so the opener asks first, and passes none when the text is its file', () => {
    const onFile = vi.fn();
    const handler = createLinkHandler(onFile, (range) => (range.start.x === 1 ? 'NOTES.md' : 'src/a.ts:12'));
    const at = (x: number) => ({ start: { x, y: 1 }, end: { x: x + 5, y: 1 } });
    handler.activate({} as MouseEvent, 'src/a.ts#L12', at(1));
    handler.activate({} as MouseEvent, 'src/a.ts#L12', at(2));
    expect(onFile.mock.calls).toEqual([[{ path: 'src/a.ts', line: 12 }, 'NOTES.md'], [{ path: 'src/a.ts', line: 12 }]]);
  });
});

describe('openTerminalLink with a file opener (W211)', () => {
  it('sends a file: link, a relative target and #L12 to the opener, without asking, and refuses every other scheme', () => {
    const onFile = vi.fn();
    const confirm = vi.fn(() => true);
    const open = vi.fn();
    expect(openTerminalLink('file:///abs/NOW.md', { confirm, open }, onFile)).toBe(true);
    expect(openTerminalLink('src/server/editors.ts#L12', { confirm, open }, onFile)).toBe(true);
    expect(openTerminalLink('file:///a/b%20c.md', { confirm, open }, onFile)).toBe(true);
    expect(onFile.mock.calls).toEqual([[{ path: '/abs/NOW.md' }], [{ path: 'src/server/editors.ts', line: 12 }], [{ path: '/a/b c.md' }]]);
    for (const uri of ['javascript:alert(1)', 'vscode://file/x', 'data:text/html,x', 'file://evil.example/x', 'blob:http://a/b']) {
      expect(openTerminalLink(uri, { confirm, open }, onFile), uri).toBe(false);
    }
    expect(onFile).toHaveBeenCalledTimes(3);
    expect(confirm).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('still asks first for http and https, and sends them no further', () => {
    const onFile = vi.fn();
    const open = vi.fn();
    expect(openTerminalLink('https://example.com/a.md', { confirm: () => true, open }, onFile)).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(onFile).not.toHaveBeenCalled();
  });

  it('treats a file link as nothing without an opener', () => {
    expect(openTerminalLink('file:///abs/NOW.md', { confirm: () => true, open: vi.fn() })).toBe(false);
  });
});

describe('terminalLinkHandler', () => {
  it('uses window.confirm and window.open by default: opens when confirmed, not when declined', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    try {
      terminalLinkHandler.activate(new MouseEvent('click'), 'https://example.com/', RANGE);
      expect(confirm).toHaveBeenCalledWith('Open this link in a new tab?\n\nhttps://example.com/');
      expect(open.mock.calls).toEqual([['https://example.com/', '_blank', 'noopener,noreferrer']]);

      confirm.mockReturnValue(false);
      terminalLinkHandler.activate(new MouseEvent('click'), 'https://example.org/', RANGE);
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledTimes(1);

      terminalLinkHandler.activate(new MouseEvent('click'), 'javascript:alert(1)', RANGE);
      expect(confirm).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledTimes(1);
      expect(terminalLinkHandler.allowNonHttpProtocols).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
