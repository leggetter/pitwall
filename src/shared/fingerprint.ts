// A short, non-cryptographic fingerprint of a text (W209, F2): FNV-1a over its UTF-16 code units, 8 hex
// digits. The server sends one for each spin-off block it read, and the page recomputes it from the fence
// body it rendered, so a card replaces only the code block the server read, never a look-alike. It is a
// match check between two parsers, not a security boundary: Start still sends only the block's key, and
// the server finds the block in the transcript again.
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
