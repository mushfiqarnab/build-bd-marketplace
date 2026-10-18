// Contractor Profile — view and creation for CONTRACTOR role.
//
// Invariants (Lane 1 audit rules):
//   - Pure DOM (replaceChildren, append, createElement, textContent) — no innerHTML.
//   - Network via ../api.js (get, post).
//   - requireAuth({ roles: ['CONTRACTOR'] }) before content reveal.
//   - All copy via t() with en and bn keys.
//   - Money via formatTaka(), dates via formatDate().

import { initShell } from '../shell.js';
import { get, post, ApiError } from '../api.js';
import { t, applyLang, formatTaka, formatDate } from '../i18n.js';
import { requireAuth } from '../session.js';

const $ = (id) => document.getElementById(id);

let profile = null;
let submitting = false;

function showAlert(kind, text) {
  const box = $('alert');
  box.replaceChildren();
  if (!text) {
    box.hidden = true;
    return;
  }
  const div = document.createElement('div');
  div.className = kind === 'error' ? 'alert-error' : 'alert-success';
  const icon = document.createElement('span');
  icon.className = 'icon text-[20px]';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = kind === 'error' ? 'error' : 'check_circle';
  const msg = document.createElement('span');
  msg.textContent = text;
  div.append(icon, msg);
  box.append(div);
  box.hidden = false;
}

function busy(btn, on, labelKey) {
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
  const label = btn.querySelector('[data-i18n]');
  if (label) label.textContent = t(on ? labelKey : label.dataset.i18n);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(labelKey, value) {
  const wrap = el('div', 'flex flex-col');
  wrap.append(
    el('dt', 'text-label-sm text-on-surface-variant', t(labelKey)),
    el('dd', 'text-body-md text-on-surface mt-xs break-all', value || '—')
  );
  return wrap;
}

function renderProfileView(p) {
  $('create-section').hidden = true;
  $('view-section').hidden = false;

  $('view-name').textContent = p.fullName || '—';
  $('view-type').textContent = p.businessType === 'COMPANY'
    ? t('profile.businessType.company')
    : t('profile.businessType.individual');

  const badges = $('view-badges');
  badges.replaceChildren();

  const status = (p.verification && p.verification.status) || 'UNVERIFIED';
  let badgeClass = 'badge-category bg-surface-variant text-on-surface border border-outline-variant';
  if (status === 'VERIFIED') {
    badgeClass = 'badge-category bg-success/15 text-on-surface border border-success/40';
  } else if (status === 'REJECTED') {
    badgeClass = 'badge-category bg-error/15 text-on-surface border border-error/40';
  } else if (status === 'PENDING') {
    badgeClass = 'badge-category bg-cta-amber/20 text-on-surface border border-cta-amber';
  }
  badges.append(el('span', badgeClass, t(`profile.status.${status.toLowerCase()}`) || status));

  if (p.verification && p.verification.verificationLevel) {
    const lvlKey = `profile.level.${p.verification.verificationLevel.toLowerCase()}`;
    badges.append(el('span', 'badge-category bg-primary-fixed text-primary-container', t(lvlKey) || p.verification.verificationLevel));
  }

  const details = $('view-details');
  details.replaceChildren();

  details.append(field('profile.tradeLicense', p.tradeLicense));

  const areasStr = (p.serviceAreas && p.serviceAreas.length > 0)
    ? p.serviceAreas.map((a) => (typeof a === 'string' ? a : a.district || a.areas?.join(', '))).filter(Boolean).join(', ')
    : null;
  details.append(field('profile.serviceAreas', areasStr));

  const current = (p.availability && p.availability.currentProjects) || 0;
  const max = (p.availability && p.availability.maxConcurrentProjects) || 3;
  details.append(field('profile.capacity', t('profile.capacityValue', { current, max })));

  if (p.createdAt) {
    details.append(field('adminVerify.field.submitted', formatDate(p.createdAt)));
  }

  // Probation details
  const prob = p.verification && p.verification.probationStatus;
  const probCard = $('view-probation-card');
  if (prob && prob.isProbation) {
    probCard.hidden = false;
    const cap = formatTaka(prob.canBidAbove || 100000);
    $('view-probation-desc').textContent = t('profile.probationActive', { cap });
    const done = prob.projectsCompleted || 0;
    const req = prob.projectsRequired || 3;
    $('view-probation-progress').textContent = t('profile.probationProgress', { done, required: req });
  } else if (prob && !prob.isProbation) {
    probCard.hidden = false;
    $('view-probation-desc').textContent = t('profile.probationCleared');
    $('view-probation-progress').textContent = '';
  } else {
    probCard.hidden = true;
  }

  // Notices
  const noticeBox = $('view-notice');
  const noticeTxt = $('view-notice-text');
  if (status === 'UNVERIFIED' || status === 'PENDING') {
    noticeBox.hidden = false;
    noticeBox.className = 'alert-info mt-md';
    noticeTxt.textContent = t('profile.noticeWaiting');
  } else if (status === 'REJECTED') {
    noticeBox.hidden = false;
    noticeBox.className = 'alert-error mt-md';
    noticeTxt.textContent = t('profile.noticeRejected');
  } else {
    noticeBox.hidden = true;
  }
}

function wireForm() {
  const form = $('profile-form');
  const nameInput = $('full-name');
  const nameErr = $('full-name-error');
  const tradeInput = $('trade-license');
  const areasInput = $('service-areas');
  const maxInput = $('max-projects');
  const submitBtn = $('submit-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;

    const fullName = nameInput.value.trim();
    if (!fullName || fullName.length < 2) {
      nameErr.textContent = t('profile.err.nameRequired');
      nameErr.hidden = false;
      nameInput.setAttribute('aria-invalid', 'true');
      nameInput.focus();
      return;
    }
    nameErr.hidden = true;
    nameInput.removeAttribute('aria-invalid');

    const businessType = form.elements.businessType.value || 'INDIVIDUAL';
    const tradeLicense = tradeInput.value.trim() || undefined;
    const areasRaw = areasInput.value.trim();
    const serviceAreas = areasRaw
      ? areasRaw.split(',').map((s) => s.trim()).filter(Boolean).map((d) => ({ district: d, willingToTravel: true }))
      : [];
    const maxConcurrentProjects = Math.max(1, Number(maxInput.value) || 3);

    submitting = true;
    showAlert(null);
    busy(submitBtn, true, 'profile.saving');

    try {
      const res = await post('/contractor-profile', {
        businessType,
        fullName,
        tradeLicense,
        serviceAreas,
        availability: { maxConcurrentProjects }
      });
      profile = (res && res.profile) || null;
      showAlert('success', t('profile.success'));
      if (profile) renderProfileView(profile);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        showAlert('error', t('profile.err.alreadyExists'));
        await loadProfile();
      } else {
        showAlert('error', err instanceof ApiError ? err.message : t('err.generic'));
      }
    } finally {
      submitting = false;
      busy(submitBtn, false);
    }
  });
}

async function loadProfile() {
  try {
    const res = await get('/contractor-profile/me');
    profile = (res && res.profile) || null;
    if (profile) {
      renderProfileView(profile);
    } else {
      $('create-section').hidden = false;
      $('view-section').hidden = true;
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // No profile exists yet — normal for new contractor
      $('create-section').hidden = false;
      $('view-section').hidden = true;
    } else {
      throw err;
    }
  }
}

document.addEventListener('langchange', () => {
  applyLang();
  if (profile) renderProfileView(profile);
});

(async () => {
  await initShell();
  const me = await requireAuth({ roles: ['CONTRACTOR'] });
  if (!me) return;

  wireForm();

  try {
    await loadProfile();
    $('loading').hidden = true;
    $('content').hidden = false;
  } catch (err) {
    $('loading').hidden = true;
    const bootError = $('boot-error');
    bootError.textContent = t('err.generic');
    bootError.hidden = false;
  }
})();
