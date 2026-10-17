// frontend/js/shell.js — wires the shared header on every page: language
// toggle, signed-in state, logout. Imported by each page module.
import { applyLang, toggleLang } from './i18n.js';
import { getMe, logout } from './session.js';

export async function initShell() {
  applyLang();
  for (const el of document.querySelectorAll('[data-lang-toggle]')) el.addEventListener('click', toggleLang);
  for (const el of document.querySelectorAll('[data-logout]')) el.addEventListener('click', (e) => { e.preventDefault(); logout(); });

  // Header shows "Log in" or the account controls; failures stay silent here
  // (pages render their own error states).
  let me = null;
  try { me = await getMe(); } catch (_) { /* offline: header stays signed-out */ }
  for (const el of document.querySelectorAll('[data-when="signed-in"]')) el.hidden = !me;
  for (const el of document.querySelectorAll('[data-when="signed-out"]')) el.hidden = !!me;
  for (const el of document.querySelectorAll('[data-me-phone]')) el.textContent = me ? me.phoneNumber : '';
  return me;
}
