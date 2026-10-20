// Sets data-theme on <html> before the first paint, so pitwall never shows a frame in the wrong
// theme (docs/design-system.md, 2.2). index.html loads it as a plain blocking script, before the
// stylesheet. It's a file rather than inline because the CSP (default-src 'self') blocks inline
// scripts. Vite copies it into dist/web unchanged, so it's plain JavaScript, not TypeScript.
//
// It does what web/src/theme.ts does when the app starts, and theme.test.tsx checks the two agree.
(function (window, document) {
  var choice = 'system';
  try {
    var stored = window.localStorage.getItem('pitwall.theme.v1');
    if (stored === 'system' || stored === 'light' || stored === 'dark') choice = stored;
  } catch (error) {
    // Storage is blocked, as in some private windows: follow the system.
  }
  var theme = choice;
  if (choice === 'system') {
    // With no matchMedia, leave data-theme unset: tokens.css then follows prefers-color-scheme itself.
    if (typeof window.matchMedia !== 'function') return;
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
})(window, document);
