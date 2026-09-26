// Theme boot: apply stored/system theme before first paint (no reload flash, FR-U1).
// Kept as a small blocking external script so CSP can stay `script-src 'self'`.
(function () {
  try {
    var raw = localStorage.getItem('tk.theme');
    var pref = raw ? JSON.parse(raw) : 'system';
    var dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = pref === 'system' ? (dark ? 'dark' : 'light') : pref;
    document.documentElement.dataset.themePref = pref;
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
