// frontend/js/theme.js — Light / Dark mode toggle with localStorage persistence.
// Pure DOM & zero inline styles (strict CSP `style-src 'self'` compliant).
import { t } from './i18n.js';

const THEME_STORAGE_KEY = 'bb_theme';
const SUPPORTED_THEMES = ['light', 'dark'];
const SVG_NS = 'http://www.w3.org/2000/svg';

export function getTheme() {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (SUPPORTED_THEMES.includes(saved)) return saved;
    }
  } catch (_) { /* storage blocked */ }
  try {
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
  } catch (_) { /* matchMedia unavailable */ }
  return 'light';
}

function buildThemeIcon(theme) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  if (theme === 'dark') {
    // Sun icon (click to switch to Light mode)
    const circle = document.createElementNS(SVG_NS, 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '4');
    const rays = document.createElementNS(SVG_NS, 'path');
    rays.setAttribute('d', 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41');
    svg.append(circle, rays);
  } else {
    // Crescent moon icon (click to switch to Dark mode)
    const moon = document.createElementNS(SVG_NS, 'path');
    moon.setAttribute('d', 'M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z');
    svg.append(moon);
  }
  return svg;
}

export function applyTheme(theme = getTheme()) {
  if (typeof document === 'undefined') return theme;
  const active = SUPPORTED_THEMES.includes(theme) ? theme : 'light';
  document.documentElement.setAttribute('data-theme', active);

  const schemeMeta = document.querySelector('meta[name="color-scheme"]');
  if (schemeMeta) schemeMeta.setAttribute('content', active);
  const colorMeta = document.querySelector('meta[name="theme-color"]');
  if (colorMeta) colorMeta.setAttribute('content', active === 'dark' ? '#080e1c' : '#002045');

  const labelKey = active === 'dark' ? 'theme.light' : 'theme.dark';
  const ariaKey = active === 'dark' ? 'theme.switchToLight' : 'theme.switchToDark';

  for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
    btn.setAttribute('aria-pressed', active === 'dark' ? 'true' : 'false');
    btn.setAttribute('aria-label', t(ariaKey));
    btn.setAttribute('title', t(ariaKey));
    const iconSlot = buildThemeIcon(active);
    const labelSpan = document.createElement('span');
    labelSpan.className = btn.dataset.themeCompact === 'true' ? 'hidden lg:inline' : '';
    labelSpan.textContent = t(labelKey);
    btn.replaceChildren(iconSlot, labelSpan);
  }
  return active;
}

export function setTheme(nextTheme) {
  if (!SUPPORTED_THEMES.includes(nextTheme)) return;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    }
  } catch (_) { /* session-only */ }
  applyTheme(nextTheme);
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: nextTheme } }));
  }
}

export function toggleTheme() {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}

export function initThemeControls() {
  if (typeof document === 'undefined') return;
  applyTheme();
  for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
    if (btn.dataset.themeBound === '1') continue;
    btn.dataset.themeBound = '1';
    btn.addEventListener('click', toggleTheme);
  }
  document.addEventListener('langchange', () => applyTheme());
}
