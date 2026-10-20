// The tokens come first, before the stylesheets the components import. fonts.css bundles the fonts.
import './tokens.css';
import './fonts.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import { pageThemeStore } from './theme.js';

// theme-init.js has set the theme; from here on the store keeps it, following the system while
// System is chosen, including on the pages that have no theme switch.
pageThemeStore();

const container = document.getElementById('root');
if (!container) throw new Error('pitwall: #root element missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
