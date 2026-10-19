import { describe, expect, it, vi } from 'vitest';
import { confirmMessage, openTerminalLink, terminalLinkHandler } from './links.js';

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
