import { applyLang, toggleLang, t } from './i18n.js';
import { initThemeControls } from './theme.js';
import { getMe, logout } from './session.js';
import { get } from './api.js';

export { clearFormDraft } from './formPersist.js';

export async function initShell() {
  applyLang();
  initThemeControls();
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
  const currentPath = window.location.pathname;
  if (currentPath.includes('dashboard.html')) {
    const bottomDash = document.querySelector('#bottom-nav [data-bottom-nav="dashboard"]');
    const bottomLogin = document.querySelector('#bottom-nav [data-bottom-nav="login"]');
    if (bottomDash) bottomDash.hidden = false;
    if (bottomLogin) bottomLogin.hidden = true;
  }

  let me = null;
  try { me = await getMe(); } catch (_) { /* offline: header stays signed-out */ }
  for (const el of document.querySelectorAll('[data-when="signed-in"]')) el.hidden = !me;
  for (const el of document.querySelectorAll('[data-when="signed-out"]')) el.hidden = !!me;
  for (const el of document.querySelectorAll('header [data-role], [data-when="signed-in"][data-role]')) {
    if (el.dataset.role) {
      el.hidden = !me || me.role !== el.dataset.role;
    }
  }
  for (const el of document.querySelectorAll('[data-me-phone]')) el.textContent = me ? me.phoneNumber : '';

  for (const el of document.querySelectorAll('[data-hide-role]')) {
    const excluded = (el.dataset.hideRole || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (excluded.length > 0) {
      const shouldHide = Boolean(me && excluded.includes(me.role));
      el.hidden = shouldHide;
      if (shouldHide) el.classList.add('!hidden');
      else el.classList.remove('!hidden');
    }
  }

  // Active bottom navigation tab highlight
  for (const link of document.querySelectorAll('#bottom-nav [data-bottom-nav]')) {
    const navKey = link.dataset.bottomNav;
    let isActive = false;
    if (navKey === 'home' && (currentPath === '/app/' || currentPath === '/app/index.html')) isActive = true;
    else if (navKey === 'works' && currentPath.includes('works.html')) isActive = true;
    else if (navKey === 'materials' && (currentPath.includes('materials.html') || currentPath.includes('material-orders.html'))) isActive = true;
    else if (navKey === 'contractors' && (currentPath.includes('contractors.html') || currentPath.includes('contractor-profile.html'))) isActive = true;
    else if (navKey === 'dashboard' && currentPath.includes('dashboard.html')) isActive = true;
    else if (navKey === 'login' && currentPath.includes('login.html')) isActive = true;

    if (isActive) {
      link.classList.remove('text-on-surface-variant');
      link.classList.add('text-primary', 'font-bold');
      const icon = link.querySelector('.icon');
      if (icon) icon.classList.add('icon-fill');
    }
  }

  // Profile incomplete reminder notice across app pages until profile creation/service-type is completed
  if (me && (me.hasProfile === false || me.profileCompleteness === 'INCOMPLETE')) {
    const isProfilePage = window.location.pathname.includes('contractor-profile.html') || window.location.pathname.includes('onboarding.html');
    if (!isProfilePage) {
      let notice = document.getElementById('profile-incomplete-notice');
      if (!notice) {
        notice = document.createElement('aside');
        notice.id = 'profile-incomplete-notice';
        notice.className = 'bg-cta-amber/15 border-b border-cta-amber/40 text-on-surface px-md py-2 text-center text-body-sm font-medium flex items-center justify-center flex-wrap gap-xs';
        notice.setAttribute('role', 'status');
        const icon = document.createElement('span');
        icon.className = 'icon text-[20px] text-cta-amber';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'warning';
        const txt = document.createElement('span');
        txt.setAttribute('data-i18n', 'notice.profileIncomplete');
        txt.textContent = t('notice.profileIncomplete') || 'Please update your profile & service-type to unlock bidding and start receiving work.';
        const link = document.createElement('a');
        link.href = me.role === 'PENDING_ONBOARDING' ? '/app/onboarding.html' : '/app/contractor-profile.html';
        link.className = 'underline font-bold text-primary hover:text-primary-focus ml-xs';
        link.setAttribute('data-i18n', 'notice.updateProfileCta');
        link.textContent = t('notice.updateProfileCta') || 'Update Profile / Service Type';
        notice.append(icon, txt, link);
        const header = document.querySelector('header');
        if (header && header.nextSibling) {
          header.parentNode.insertBefore(notice, header.nextSibling);
        } else {
          document.body.prepend(notice);
        }
      } else {
        notice.hidden = false;
      }
    }
  }

  return me;
}
