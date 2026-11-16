import { describe, expect, it } from 'vitest';
import { ConfirmLimit, hasLinkTag, isDocumentNavigation, isLinkCodeHash, LinkCodes, linkCodeHash, withLinkCode } from './linkCodes.js';

describe('LinkCodes', () => {
  it('returns an issued code once, for its hash, and never again', () => {
    const codes = new LinkCodes();
    const code = codes.issue();
    const hash = linkCodeHash(code);

    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isLinkCodeHash(hash)).toBe(true);
    expect(codes.redeem(hash)).toBe(code);
    expect(codes.redeem(hash)).toBeUndefined();
  });

  it('does not know a code it did not issue, or a hash that is not one', () => {
    const codes = new LinkCodes();
    codes.issue();

    expect(codes.redeem(linkCodeHash(new LinkCodes().issue()))).toBeUndefined();
    expect(codes.redeem('short')).toBeUndefined();
    expect(codes.redeem('')).toBeUndefined();
  });

  it('forgets a code after its time, and the sweep keeps the count down', () => {
    let now = 0;
    const codes = new LinkCodes({ ttlMs: 1000, now: () => now });
    const old = codes.issue();
    now = 400;
    const fresh = codes.issue();
    now = 1001;

    expect(codes.redeem(linkCodeHash(old))).toBeUndefined();
    expect(codes.size).toBe(1);
    expect(codes.redeem(linkCodeHash(fresh))).toBe(fresh);
  });

  it('holds at most max codes, pushing out the oldest, so a flood cannot fill memory', () => {
    const codes = new LinkCodes({ max: 3 });
    const issued = Array.from({ length: 10 }, () => codes.issue());

    expect(codes.size).toBe(3);
    expect(codes.redeem(linkCodeHash(issued[0]!))).toBeUndefined();
    expect(codes.redeem(linkCodeHash(issued[9]!))).toBe(issued[9]);
  });

  it('hashes as base64url(SHA-256) of the UTF-8 text: a known answer', () => {
    // printf abc | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '='
    expect(linkCodeHash('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });
});

describe('isDocumentNavigation', () => {
  const headers = (values: Record<string, string>) => (name: string) => values[name];

  it('is true only for a navigation that loads a document', () => {
    const typed = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' };
    expect(isDocumentNavigation(headers(typed))).toBe(true);
    // A navigation a page started (window.open, reload, location.href) is same-origin, and others are not none.
    for (const site of ['same-origin', 'same-site', 'cross-site']) expect(isDocumentNavigation(headers({ ...typed, 'sec-fetch-site': site }))).toBe(false);
    expect(isDocumentNavigation(headers({ 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' }))).toBe(false);
    expect(isDocumentNavigation(headers({ ...typed, 'sec-purpose': 'prefetch' }))).toBe(false);
    // A reload, or a restored tab, may be one an old page holds a handle to (W175's re-review, G2).
    expect(isDocumentNavigation(headers({ ...typed, 'cache-control': 'max-age=0' }))).toBe(false);
    expect(isDocumentNavigation(headers({ ...typed, 'cache-control': 'no-cache' }))).toBe(false);
    expect(isDocumentNavigation(headers({ ...typed, pragma: 'no-cache' }))).toBe(false);
    expect(isDocumentNavigation(headers({ ...typed, 'cache-control': 'max-age=3600' }))).toBe(true);
    // A script's fetch, a frame, a popup's opener check and a client that sends nothing.
    expect(isDocumentNavigation(headers({ 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' }))).toBe(false);
    expect(isDocumentNavigation(headers({ 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' }))).toBe(false);
    expect(isDocumentNavigation(headers({ 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'cors' }))).toBe(false);
    expect(isDocumentNavigation(headers({}))).toBe(false);
  });
});

describe('withLinkCode', () => {
  it('fills the tag, however the build writes it, and leaves a page without one alone', () => {
    expect(withLinkCode('<meta name="pitwall-link" content="">', 'abc')).toBe('<meta name="pitwall-link" content="abc">');
    expect(withLinkCode('<meta name="pitwall-link" content="" />', 'abc')).toBe('<meta name="pitwall-link" content="abc" />');
    expect(withLinkCode('<title>pitwall</title>', 'abc')).toBe('<title>pitwall</title>');
    expect(hasLinkTag('<meta name="pitwall-link" content="">')).toBe(true);
    expect(hasLinkTag('<title>pitwall</title>')).toBe(false);
  });
});

describe('ConfirmLimit', () => {
  it('allows max in the window, then again once it has passed', () => {
    let now = 0;
    const limit = new ConfirmLimit(() => now, 2, 1000);

    expect([limit.allow(), limit.allow(), limit.allow()]).toEqual([true, true, false]);
    now = 1000;
    expect(limit.allow()).toBe(true);
  });
});
