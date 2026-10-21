import { applyLang, toggleLang, t } from './i18n.js';
import { getMe, logout } from './session.js';
import { get } from './api.js';

export { clearFormDraft } from './formPersist.js';

export async function initShell() {
  applyLang();
  for (const el of document.querySelectorAll('[data-lang-toggle]')) el.addEventListener('click', toggleLang);
  for (const el of document.querySelectorAll('[data-logout]')) el.addEventListener('click', (e) => { e.preventDefault(); logout(); });

  // Test mode / payments disabled banner: render non-alarming banner above header
  try {
    const envRes = await get('/environment');
    const payments = envRes?.data?.payments;
    let bannerKey = null;
    if (payments?.enabled === false) {
      bannerKey = 'banner.paymentsOff';
    } else if (payments?.gateway === 'mock') {
      bannerKey = 'banner.testMode';
    }
    if (bannerKey) {
      let banner = document.getElementById('test-mode-banner');
      if (!banner) {
        banner = document.createElement('aside');
        banner.id = 'test-mode-banner';
        banner.className = 'bg-amber-500/10 border-b border-amber-500/30 text-amber-900 px-md py-1.5 text-center text-label-sm font-medium flex items-center justify-center gap-xs';
        banner.setAttribute('role', 'status');
        const icon = document.createElement('span');
        icon.className = 'icon text-[18px] text-amber-700';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'info';
        const txt = document.createElement('span');
        txt.setAttribute('data-i18n', bannerKey);
        txt.textContent = t(bannerKey);
        banner.append(icon, txt);
        const header = document.querySelector('header');
        if (header && header.parentNode) {
          header.parentNode.insertBefore(banner, header);
        } else {
          document.body.prepend(banner);
        }
      } else {
        banner.hidden = false;
      }
    }
  } catch (_) { /* offline: skip banner */ }

  // Header shows "Log in" or the account controls; failures stay silent here
  // (pages render their own error states).
  let me = null;
  try { me = await getMe(); } catch (_) { /* offline: header stays signed-out */ }
  for (const el of document.querySelectorAll('[data-when="signed-in"]')) el.hidden = !me;
  for (const el of document.querySelectorAll('[data-when="signed-out"]')) el.hidden = !!me;
  for (const el of document.querySelectorAll('[data-role]')) {
    if (el.dataset.role) {
      el.hidden = !me || me.role !== el.dataset.role;
    }
  }
  for (const el of document.querySelectorAll('[data-me-phone]')) el.textContent = me ? me.phoneNumber : '';
  return me;
}
