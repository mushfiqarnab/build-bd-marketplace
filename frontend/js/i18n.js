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

function toBengaliDigits(s) {
  return String(s).replace(/\d/g, (d) => bnDigits[d]);
}

/** Bangladeshi grouping (৳4,35,200 — lakh/crore). en-IN uses the same
 *  2,2,3 grouping as Bangladesh (NOT en-US's 3,3,3), so we lock to en-IN
 *  intentionally — do NOT "fix" to en-US. */
export function formatTaka(amount) {
  const grouped = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(amount) || 0));
  const digits = getLang() === 'bn' ? toBengaliDigits(grouped) : grouped;
  return `৳${digits}`;
}

const DAY_MS = 86_400_000;

/** Absolute date, Dhaka timezone, in the active language. */
export function formatDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d)) return '';
  const lang = getLang();
  const locale = lang === 'bn' ? 'bn-BD' : 'en-GB';
  // Intl in modern browsers handles Bangla months; manual fallback if unavailable.
  try {
    return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Dhaka' }).format(d);
  } catch (_) {
    const s = d.toISOString().slice(0, 10);
    return lang === 'bn' ? toBengaliDigits(s) : s;
  }
}

/** Short relative time: "3h ago" / "৩ ঘণ্টা আগে". Falls back to formatDate
 *  past 30 days. All numerals rendered in the active language's digits. */
export function formatRelativeTime(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d)) return '';
  const diffMs = Date.now() - d.getTime();
  const lang = getLang();
  const inFuture = diffMs < 0;
  const abs = Math.abs(diffMs);
  if (abs > 30 * DAY_MS) return formatDate(d);
  let value;
  let unit;
  if (abs < 60_000)         { value = Math.max(1, Math.round(abs / 1_000));   unit = 'second'; }
  else if (abs < 3_600_000) { value = Math.round(abs / 60_000);               unit = 'minute'; }
  else if (abs < 86_400_000){ value = Math.round(abs / 3_600_000);            unit = 'hour'; }
  else                      { value = Math.round(abs / DAY_MS);               unit = 'day'; }
  try {
    const rtf = new Intl.RelativeTimeFormat(lang === 'bn' ? 'bn-BD' : 'en-GB', { numeric: 'auto', style: 'short' });
    return rtf.format(inFuture ? value : -value, unit);
  } catch (_) {
    const n = lang === 'bn' ? toBengaliDigits(value) : value;
    const label = lang === 'bn'
      ? { second: 'সেকেন্ড', minute: 'মিনিট', hour: 'ঘণ্টা', day: 'দিন' }[unit]
      : unit + (value === 1 ? '' : 's');
    return lang === 'bn'
      ? (inFuture ? `${n} ${label} পরে` : `${n} ${label} আগে`)
      : (inFuture ? `in ${n} ${label}` : `${n} ${label} ago`);
  }
}

export { toBengaliDigits };
