// Admin Verification Queue — review pending contractor profiles and verify or reject.
//
// Invariants (Lane 1 audit rules):
//   - Pure DOM (replaceChildren, append, createElement, textContent) — no innerHTML.
//   - Network via ../api.js (get, patch).
//   - requireAuth({ roles: ['ADMIN'] }) before content reveal.
//   - All copy via t() with en and bn keys.
//   - Dates via formatDate().

import { initShell } from '../shell.js';
import { get, patch, ApiError } from '../api.js';
import { t, applyLang, formatDate } from '../i18n.js';
import { requireAuth } from '../session.js';

const $ = (id) => document.getElementById(id);

let pendingProfiles = [];

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
    el('dd', 'text-body-md text-on-surface break-all', value || '—')
  );
  return wrap;
}

function buildCard(profile) {
  const li = el('li');
  const card = el('article', 'card p-lg flex flex-col gap-md');

  const head = el('div', 'flex flex-wrap items-start justify-between gap-sm border-b border-border-subtle pb-sm');
  const left = el('div');
  left.append(
    el('h2', 'text-h3 font-bold text-on-surface', profile.fullName || '—'),
    el('p', 'text-body-sm text-on-surface-variant mt-xs',
      profile.businessType === 'COMPANY'
        ? t('profile.businessType.company')
        : t('profile.businessType.individual')
    )
  );

  const status = profile.verificationStatus || 'PENDING';
  const badge = el('span', 'badge-category bg-cta-amber/20 text-on-surface border border-cta-amber',
    t(`profile.status.${status.toLowerCase()}`) || status
  );
  head.append(left, badge);

  const facts = el('dl', 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-sm');
  facts.append(
    field('adminVerify.field.phone', profile.phoneNumber),
    field('adminVerify.field.tradeLicense', profile.tradeLicense),
    field('adminVerify.field.submitted', formatDate(profile.submittedAt))
  );

  const areasStr = (profile.serviceAreas && profile.serviceAreas.length > 0)
    ? profile.serviceAreas.map((a) => (typeof a === 'string' ? a : a.district || a.areas?.join(', '))).filter(Boolean).join(', ')
    : null;
  facts.append(field('adminVerify.field.serviceAreas', areasStr));

  card.append(head, facts);

  // Verification Action Controls
  const actionsForm = el('form', 'mt-sm pt-md border-t border-border-subtle flex flex-col sm:flex-row flex-wrap sm:items-end gap-md');
  actionsForm.noValidate = true;

  // Level selector
  const levelCol = el('div', 'flex flex-col gap-xs');
  const levelLabel = el('label', 'text-label-sm font-semibold text-on-surface', t('adminVerify.level.label'));
  const levelSelect = el('select', 'field py-xs text-body-sm min-h-[44px]');
  const optBasic = el('option', '', t('adminVerify.level.basic'));
  optBasic.value = 'BASIC';
  const optStandard = el('option', '', t('adminVerify.level.standard'));
  optStandard.value = 'STANDARD';
  const optPremium = el('option', '', t('adminVerify.level.premium'));
  optPremium.value = 'PREMIUM';
  levelSelect.append(optBasic, optStandard, optPremium);
  levelCol.append(levelLabel, levelSelect);

  // Clear probation checkbox
  const probCol = el('label', 'flex items-center gap-xs cursor-pointer min-h-[44px] text-body-sm text-on-surface');
  const probCheck = el('input');
  probCheck.type = 'checkbox';
  const probLabel = el('span', '', t('adminVerify.probation.label'));
  probCol.append(probCheck, probLabel);

  // Approve button
  const approveBtn = el('button', 'btn-primary min-h-[44px] flex items-center gap-xs');
  approveBtn.type = 'submit';
  const approveIcon = el('span', 'icon', 'done_all');
  approveIcon.setAttribute('aria-hidden', 'true');
  const approveTxt = el('span', '', t('adminVerify.action.verify'));
  approveTxt.dataset.i18n = 'adminVerify.action.verify';
  approveBtn.append(approveIcon, approveTxt);

  // Reject button
  const rejectBtn = el('button', 'btn-outline min-h-[44px] flex items-center gap-xs text-error');
  rejectBtn.type = 'button';
  const rejectIcon = el('span', 'icon', 'close');
  rejectIcon.setAttribute('aria-hidden', 'true');
  const rejectTxt = el('span', '', t('adminVerify.action.reject'));
  rejectTxt.dataset.i18n = 'adminVerify.action.reject';
  rejectBtn.append(rejectIcon, rejectTxt);

  const btnGroup = el('div', 'flex flex-wrap gap-sm ml-auto');
  btnGroup.append(approveBtn, rejectBtn);

  actionsForm.append(levelCol, probCol, btnGroup);

  let inFlight = false;

  actionsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (inFlight) return;
    inFlight = true;
    busy(approveBtn, true, 'adminVerify.action.verifying');
    rejectBtn.disabled = true;

    try {
      await patch(`/contractor-profile/${encodeURIComponent(profile.userId)}/verify`, {
        status: 'VERIFIED',
        verificationLevel: levelSelect.value,
        clearProbation: probCheck.checked
      });
      showAlert('success', t('adminVerify.done'));
      await loadQueue();
    } catch (err) {
      showAlert('error', err instanceof ApiError ? err.message : t('err.generic'));
      busy(approveBtn, false);
      rejectBtn.disabled = false;
      inFlight = false;
    }
  });

  rejectBtn.addEventListener('click', async () => {
    if (inFlight) return;
    inFlight = true;
    busy(rejectBtn, true, 'adminVerify.action.rejecting');
    approveBtn.disabled = true;

    try {
      await patch(`/contractor-profile/${encodeURIComponent(profile.userId)}/verify`, {
        status: 'REJECTED'
      });
      showAlert('success', t('adminVerify.done'));
      await loadQueue();
    } catch (err) {
      showAlert('error', err instanceof ApiError ? err.message : t('err.generic'));
      busy(rejectBtn, false);
      approveBtn.disabled = false;
      inFlight = false;
    }
  });

  card.append(actionsForm);
  li.append(card);
  return li;
}

function render() {
  const list = $('queue-list');
  list.replaceChildren(...pendingProfiles.map(buildCard));
  $('queue-empty').hidden = pendingProfiles.length > 0;
  $('summary').textContent = t('adminVerify.summary', { count: pendingProfiles.length });
}

async function loadQueue() {
  const res = await get('/contractor-profile/pending');
  pendingProfiles = (res && res.data && res.data.profiles) || [];
  render();
}

document.addEventListener('langchange', () => {
  applyLang();
  render();
});

(async () => {
  await initShell();
  const me = await requireAuth({ roles: ['ADMIN'] });
  if (!me) return;

  try {
    await loadQueue();
    $('loading').hidden = true;
    $('content').hidden = false;
  } catch (err) {
    $('loading').hidden = true;
    const bootError = $('boot-error');
    bootError.textContent = t('err.generic');
    bootError.hidden = false;
  }
})();
