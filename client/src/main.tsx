import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { initTheme } from './utils/theme';
import { initNativeBridge } from './native/bridge';

// Apply saved theme immediately to avoid flash of wrong theme
initTheme();
// Obli Android shell: back button, system bars following the theme,
// data-native="android" on <html>. No-op in a regular browser.
initNativeBridge();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
