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
    showAlert('success', res.message || t('onboarding.success'));

    // Check if next query param was passed originally
    const nextDest = safeNext(params.get('next'));
    const finalDest = nextDest || res.nextUrl || '/app/dashboard.html';

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
    location.replace('/app/login.html');
    return;
  }

  // If role is already established, one number registers once -> forward directly to their workplace
  if (me.role && me.role !== 'PENDING_ONBOARDING') {
    location.replace(safeNext(params.get('next')) || homeFor(me));
    return;
  }

  const workBtn = $('btn-track-work');
  const hireBtn = $('btn-track-hire');
  const supplyBtn = $('btn-track-supply');

  if (workBtn) workBtn.addEventListener('click', () => selectTrack('WORK'));
  if (hireBtn) hireBtn.addEventListener('click', () => selectTrack('HIRE'));
  if (supplyBtn) supplyBtn.addEventListener('click', () => selectTrack('SUPPLY'));
})();
