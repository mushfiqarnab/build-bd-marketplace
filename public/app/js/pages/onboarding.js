// frontend/js/pages/onboarding.js
// Post-auth progressive onboarding: user chooses their platform track once.
'use strict';

import { initShell } from '../shell.js';
import { post, ApiError } from '../api.js';
import { t, applyLang } from '../i18n.js';
import { getMe, homeFor, safeNext } from '../session.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let submitting = false;

function showAlert(kind, text) {
  const box = $('alert');
  box.replaceChildren();
  if (!text) {
    box.hidden = true;
    return;
  }
  const div = document.createElement('div');
  div.className = kind === 'error' ? 'alert-error' : kind === 'success' ? 'alert-success' : 'alert-info';
  const icon = document.createElement('span');
  icon.className = 'icon text-[20px]';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = kind === 'error' ? 'error' : kind === 'success' ? 'check_circle' : 'info';
  const msg = document.createElement('span');
  msg.textContent = text;
  div.append(icon, msg);
  box.append(div);
  box.hidden = false;
}

function isDestCompatibleWithTrack(track, dest) {
  if (!dest) return false;
  const pathname = dest.split('?')[0];
  const adminOnly = ['/app/admin-verify.html', '/app/admin-refunds.html', '/app/moderation.html', '/app/analytics.html', '/app/onboarding.html'];
  if (adminOnly.includes(pathname)) return false;

  if (track === 'HIRE') {
    const contractorOnly = ['/app/submit-bid.html', '/app/contractor-profile.html', '/app/tenders.html'];
    return !contractorOnly.includes(pathname);
  }
  if (track === 'WORK') {
    const clientOnly = ['/app/post-project.html', '/app/my-projects.html'];
    return !clientOnly.includes(pathname);
  }
  if (track === 'SUPPLY') {
    const allowedSupplier = ['/app/dashboard.html', '/app/materials.html', '/app/material-orders.html', '/app/withdraw.html', '/app/help.html'];
    return allowedSupplier.includes(pathname);
  }
  return false;
}

async function selectTrack(track) {
  if (submitting) return;
  submitting = true;
  showAlert(null);

  const workBtn = $('btn-track-work');
  const hireBtn = $('btn-track-hire');
  const supplyBtn = $('btn-track-supply');

  if (workBtn) workBtn.disabled = true;
  if (hireBtn) hireBtn.disabled = true;
  if (supplyBtn) supplyBtn.disabled = true;

  try {
    const res = await post('/auth/select-track', { track });
    await getMe({ refresh: true }).catch(() => null);
    showAlert('success', res.message || t('onboarding.success'));

    const nextDest = safeNext(params.get('next'));
    const compatibleNext = isDestCompatibleWithTrack(track, nextDest) ? nextDest : null;

    let finalDest = res.nextUrl || '/app/dashboard.html';
    if (track === 'WORK') {
      // Newly selected contractor has no profile yet -> route via contractor-profile preserving compatible nextDest
      if (compatibleNext && compatibleNext !== '/app/contractor-profile.html') {
        finalDest = `/app/contractor-profile.html?next=${encodeURIComponent(compatibleNext)}`;
      } else {
        finalDest = '/app/contractor-profile.html';
      }
    } else if (compatibleNext) {
      finalDest = compatibleNext;
    }

    setTimeout(() => {
      location.replace(finalDest);
    }, 400);
  } catch (err) {
    submitting = false;
    if (workBtn) workBtn.disabled = false;
    if (hireBtn) hireBtn.disabled = false;
    if (supplyBtn) supplyBtn.disabled = false;
    showAlert('error', err instanceof ApiError ? err.message : t('err.generic'));
  }
}

document.addEventListener('langchange', () => {
  applyLang();
});

(async () => {
  const me = await initShell();
  if (!me) {
    const loginParams = new URLSearchParams();
    const nextDest = safeNext(params.get('next'));
    const roleHint = (params.get('role') || '').trim().toUpperCase();
    if (nextDest) loginParams.set('next', nextDest);
    if (['CLIENT', 'CONTRACTOR', 'SUPPLIER'].includes(roleHint)) loginParams.set('role', roleHint);
    const qs = loginParams.toString();
    location.replace(`/app/login.html${qs ? `?${qs}` : ''}`);
    return;
  }

  // If role is already established, one number registers once -> forward directly to their workplace
  if (me.role && me.role !== 'PENDING_ONBOARDING') {
    const nextDest = safeNext(params.get('next'));
    const trackForRole = me.role === 'CLIENT' ? 'HIRE' : me.role === 'CONTRACTOR' ? 'WORK' : me.role === 'SUPPLIER' ? 'SUPPLY' : '';
    const compatibleNext = trackForRole && isDestCompatibleWithTrack(trackForRole, nextDest) ? nextDest : null;
    if (me.role === 'CONTRACTOR' && me.hasProfile === false) {
      location.replace(compatibleNext ? `/app/contractor-profile.html?next=${encodeURIComponent(compatibleNext)}` : '/app/contractor-profile.html');
      return;
    }
    location.replace(compatibleNext || homeFor(me));
    return;
  }

  const workBtn = $('btn-track-work');
  const hireBtn = $('btn-track-hire');
  const supplyBtn = $('btn-track-supply');

  // Visually highlight the suggested track if user arrived with ?role=CLIENT|CONTRACTOR|SUPPLIER
  const roleHint = (params.get('role') || '').trim().toUpperCase();
  const hintedBtn = roleHint === 'CLIENT' ? hireBtn : roleHint === 'CONTRACTOR' ? workBtn : roleHint === 'SUPPLIER' ? supplyBtn : null;
  if (hintedBtn) {
    const card = hintedBtn.closest('article') || hintedBtn;
    card.classList.add('ring-2', 'ring-primary');
  }

  if (workBtn) workBtn.addEventListener('click', () => selectTrack('WORK'));
  if (hireBtn) hireBtn.addEventListener('click', () => selectTrack('HIRE'));
  if (supplyBtn) supplyBtn.addEventListener('click', () => selectTrack('SUPPLY'));
})();
