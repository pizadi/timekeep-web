// Theme handling (FR-U1): dark/light/system, applied instantly via CSS custom
// properties, persisted locally (fast boot) and server-side (cross-device).
import { store } from './store';
import { api } from './api';

export type ThemePref = 'system' | 'light' | 'dark';

export function currentThemePref(): ThemePref {
  try {
    const raw = localStorage.getItem('tk.theme');
    return raw ? (JSON.parse(raw) as ThemePref) : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePref, persistServer = false): void {
  try {
    localStorage.setItem('tk.theme', JSON.stringify(pref));
  } catch {
    /* private mode */
  }
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = pref === 'system' ? (dark ? 'dark' : 'light') : pref;
  document.documentElement.dataset.themePref = pref;
  if (persistServer && store.get().settings && store.get().settings!.theme !== pref) {
    void api('/settings', { method: 'PUT', body: { theme: pref } });
  }
}

export function watchSystemTheme(): void {
  const mq = matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', () => {
    if (currentThemePref() === 'system') applyTheme('system');
  });
}
