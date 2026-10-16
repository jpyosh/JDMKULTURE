// Looks: Classic (the original), Telemetry (industrial brutalist, dark) and Editorial (minimalist, light).
// Purely visual: public/themes/*.css restyle the same screens under <html data-theme="…">.
// The choice is per device (localStorage). index.html applies it before the first paint; this module
// wires the sidebar switch and animates the change.
const KEY = 'gmops-theme';
export const THEMES = [
  { key: 'classic', label: 'Classic', color: '#000000' },
  { key: 'telemetry', label: 'Telemetry', color: '#0A0A0A' },
  { key: 'editorial', label: 'Editorial', color: '#F7F6F3' },
];
const byKey = key => THEMES.find(t => t.key === key);
const root = document.documentElement;

export const currentTheme = () => (byKey(root.dataset.theme) ? root.dataset.theme : 'classic');

// Browser chrome follows the theme (status bar colour on phones, light or dark form controls).
function syncChrome() {
  const theme = byKey(currentTheme());
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.color);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme.key === 'editorial' ? 'light' : 'dark');
}

function syncSwitch() {
  const key = currentTheme();
  document.querySelectorAll('.theme-switch [data-theme-choice]').forEach(btn => {
    const on = btn.dataset.themeChoice === key;
    btn.setAttribute('aria-checked', String(on));
    btn.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('.theme-switch [data-theme-name]').forEach(el => { el.textContent = byKey(key).label; });
}

export function setTheme(key) {
  if (!byKey(key) || key === currentTheme()) return;
  try { localStorage.setItem(KEY, key); } catch { /* storage blocked: the theme lasts until the page is closed */ }
  const apply = () => {
    root.dataset.theme = key;
    syncChrome();
    syncSwitch();
    window.dispatchEvent(new CustomEvent('gmops:theme', { detail: key }));
  };
  // Each theme has its own entrance (see the ::view-transition rules in the theme files).
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || still) return apply();
  root.classList.add('theme-switching');
  const transition = document.startViewTransition(apply);
  transition.finished.catch(() => {}).finally(() => root.classList.remove('theme-switching'));
}

export function installThemeSwitch() {
  syncChrome();
  syncSwitch();
  document.querySelectorAll('.theme-switch').forEach(group => {
    group.addEventListener('click', event => {
      const btn = event.target.closest('[data-theme-choice]');
      if (btn) setTheme(btn.dataset.themeChoice);
    });
    // Arrow keys move between the choices, as in any radio group.
    group.addEventListener('keydown', event => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const i = THEMES.findIndex(t => t.key === currentTheme());
      const next = THEMES[(i + step + THEMES.length) % THEMES.length].key;
      setTheme(next);
      group.querySelector(`[data-theme-choice="${next}"]`)?.focus();
    });
  });
  // The desktop app's View → Theme menu uses this too.
  window.gmopsSetTheme = setTheme;
}
