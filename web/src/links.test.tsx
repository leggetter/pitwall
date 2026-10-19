import { describe, expect, it, vi } from 'vitest';
import { openTerminalLink, terminalLinkHandler } from './links.js';

describe('openTerminalLink', () => {
  it('opens http: and https: URLs in a new tab with noopener and noreferrer', () => {
    for (const uri of ['https://example.com/a?b=c#d', 'http://127.0.0.1:4517/', 'HTTPS://EXAMPLE.COM']) {
      const open = vi.fn();
      expect(openTerminalLink(uri, open), uri).toBe(true);
      expect(open).toHaveBeenCalledWith(new URL(uri).href, '_blank', 'noopener,noreferrer');
    }
  });

  it('opens nothing for any other scheme, a relative URL or garbage', () => {
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
      expect(openTerminalLink(uri, open), uri).toBe(false);
      expect(open).not.toHaveBeenCalled();
    }
  });

  it("uses window.open by default, and the terminal's handler never asks with confirm()", () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    try {
      const range = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } };
      terminalLinkHandler.activate(new MouseEvent('click'), 'https://example.com/', range);
      terminalLinkHandler.activate(new MouseEvent('click'), 'javascript:alert(1)', range);
      expect(open.mock.calls).toEqual([['https://example.com/', '_blank', 'noopener,noreferrer']]);
      expect(confirm).not.toHaveBeenCalled();
      expect(terminalLinkHandler.allowNonHttpProtocols).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
