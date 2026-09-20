import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { store } from './lib/store';
import { watchSystemTheme } from './lib/theme';

// PWA app-shell cache (FR-U6) — network-first for /api, cache-first for the shell
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

void store.boot();
watchSystemTheme();

// 1 Hz heartbeat: running-timer display, pomodoro ring, toast expiry (FR-S2).
// Gated on auth — pumping the store on the login screen just re-renders
// nothing, once a second (audit).
setInterval(() => { if (store.get().authed) store.tickServerNow(); }, 1000);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
