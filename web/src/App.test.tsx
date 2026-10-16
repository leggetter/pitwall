import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

// Proves the web test setup (TSX, React, the shared contract) works. W4 replaces it.
describe('App (placeholder)', () => {
  it('renders the pitwall heading', () => {
    expect(renderToStaticMarkup(<App />)).toContain('<h1>pitwall</h1>');
  });
});
