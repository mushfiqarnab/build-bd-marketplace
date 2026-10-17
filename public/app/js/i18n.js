// frontend/js/i18n.js — Bangla / English.
// Pages ship English text in the HTML (works without JS); this swaps text for
// elements marked data-i18n / data-i18n-placeholder / data-i18n-aria.
// Default language is Bangla; the choice is remembered on this device.
import { MESSAGES } from './messages.js';

const KEY = 'bb_lang';
const SUPPORTED = ['bn', 'en'];

export function getLang() {
  try {
    const saved = localStorage.getItem(KEY);
    if (SUPPORTED.includes(saved)) return saved;
  } catch (_) { /* storage blocked */ }
  return 'bn';
}

export function t(key, vars) {
  const lang = getLang();
  let s = (MESSAGES[lang] && MESSAGES[lang][key]) || MESSAGES.en[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export function applyLang(root = document) {
  const lang = getLang();
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-lang-toggle]')) {
    el.textContent = lang === 'bn' ? 'English' : 'বাংলা';
    el.setAttribute('aria-label', lang === 'bn' ? 'Switch to English' : 'বাংলায় দেখুন');
  }
}

export function setLang(lang) {
  if (!SUPPORTED.includes(lang)) return;
  try { localStorage.setItem(KEY, lang); } catch (_) { /* storage blocked: session-only */ }
  applyLang();
  document.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
}

export function toggleLang() {
  setLang(getLang() === 'bn' ? 'en' : 'bn');
}

const bnDigits = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
/** Bangladeshi grouping (৳44,35,200), Bengali digits in Bangla mode. */
export function formatTaka(amount) {
  const grouped = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(amount) || 0));
  const digits = getLang() === 'bn' ? grouped.replace(/\d/g, (d) => bnDigits[d]) : grouped;
  return `৳${digits}`;
}
