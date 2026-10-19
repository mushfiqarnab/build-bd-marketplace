// Contractor Profile — view and creation for CONTRACTOR role.
//
// Invariants (Lane 1 audit rules):
//   - Pure DOM (replaceChildren, append, createElement, textContent) — no innerHTML.
//   - Network via ../api.js (get, post).
//   - requireAuth({ roles: ['CONTRACTOR'] }) before content reveal.
//   - All copy via t() with en and bn keys.
//   - Money via formatTaka(), dates via formatDate().

import { initShell } from '../shell.js';
import { get, post, patch, ApiError } from '../api.js';
import { t, applyLang, formatTaka, formatDate } from '../i18n.js';
import { requireAuth } from '../session.js';

const $ = (id) => document.getElementById(id);

let profile = null;
let submitting = false;
let formMode = 'create';
let currentReviews = [];
let currentAggregates = null;

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

function createServiceAreaRow(district = '', willingToTravel = true) {
  const row = el('div', 'flex items-center gap-sm');
  row.dataset.areaRow = '1';
  const input = el('input', 'field flex-1');
  input.type = 'text';
  input.maxLength = 60;
  input.value = district;
  input.placeholder = t('profile.districtPlaceholder');
  input.setAttribute('data-i18n-placeholder', 'profile.districtPlaceholder');
  input.required = true;

  const travelLabel = el('label', 'flex items-center gap-xs text-body-sm text-on-surface-variant whitespace-nowrap cursor-pointer min-h-[44px]');
  const checkbox = el('input', 'checkbox');
  checkbox.type = 'checkbox';
  const travelText = el('span', '', t('profile.willingToTravel'));
  travelText.setAttribute('data-i18n', 'profile.willingToTravel');
  travelLabel.append(checkbox, travelText);

  const removeBtn = el('button', 'btn-ghost text-error p-xs min-h-[44px] min-w-[44px]');
  removeBtn.type = 'button';
  removeBtn.setAttribute('aria-label', t('profile.removeDistrict'));
  removeBtn.setAttribute('data-i18n-aria', 'profile.removeDistrict');
  const removeIcon = el('span', 'icon text-[20px]', 'delete');
  removeIcon.setAttribute('aria-hidden', 'true');
  removeBtn.append(removeIcon);

  removeBtn.addEventListener('click', () => {
    row.remove();
  });

  row.append(input, travelLabel, removeBtn);
  return { row, input, checkbox };
}

function openEditMode() {
  if (!profile) return;
  formMode = 'edit';
  const formTitle = $('form-title');
  if (formTitle) {
    formTitle.dataset.i18n = 'profile.editTitle';
    formTitle.textContent = t('profile.editTitle');
  }
  const form = $('profile-form');
  if (form.elements.businessType) {
    form.elements.businessType.value = profile.businessType || 'INDIVIDUAL';
  }
  $('full-name').value = profile.fullName || '';
  $('trade-license').value = profile.tradeLicense || '';
  $('max-projects').value = profile.availability?.maxConcurrentProjects || 3;

  const container = $('service-areas-container');
  container.replaceChildren();
  const areas = Array.isArray(profile.serviceAreas) && profile.serviceAreas.length > 0
    ? profile.serviceAreas
    : [{ district: '', willingToTravel: true }];

  for (const a of areas) {
    const dist = typeof a === 'string' ? a : a.district || '';
    const travel = typeof a === 'object' && a.willingToTravel !== undefined ? a.willingToTravel : true;
    container.append(createServiceAreaRow(dist, travel).row);
  }

  $('cancel-edit-btn').hidden = false;
  $('view-section').hidden = true;
  $('create-section').hidden = false;
}

function openCreateMode() {
  formMode = 'create';
  const formTitle = $('form-title');
  if (formTitle) {
    formTitle.dataset.i18n = 'profile.createTitle';
    formTitle.textContent = t('profile.createTitle');
  }
  $('cancel-edit-btn').hidden = true;
  const container = $('service-areas-container');
  container.replaceChildren();
  container.append(createServiceAreaRow('', true).row);
  $('view-section').hidden = true;
  $('create-section').hidden = false;
}

function wireForm() {
  const form = $('profile-form');
  const nameInput = $('full-name');
  const nameErr = $('full-name-error');
  const tradeInput = $('trade-license');
  const maxInput = $('max-projects');
  const submitBtn = $('submit-btn');

  $('btn-add-district').addEventListener('click', () => {
    const container = $('service-areas-container');
    container.append(createServiceAreaRow('', true).row);
  });

  $('btn-edit-profile').addEventListener('click', openEditMode);

  $('cancel-edit-btn').addEventListener('click', () => {
    if (profile) {
      $('create-section').hidden = true;
      $('view-section').hidden = false;
    }
  });

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

    const serviceAreas = [];
    const areaRows = $('service-areas-container').querySelectorAll('[data-area-row]');
    for (const r of areaRows) {
      const input = r.querySelector('input[type="text"]');
      const cb = r.querySelector('input[type="checkbox"]');
      const d = input ? input.value.trim() : '';
      if (d) {
        serviceAreas.push({ district: d, willingToTravel: cb ? cb.checked : true });
      }
    }

    const maxConcurrentProjects = Math.max(1, Number(maxInput.value) || 3);

    submitting = true;
    showAlert(null);
    busy(submitBtn, true, 'profile.saving');

    try {
      if (formMode === 'edit') {
        const res = await patch('/contractor-profile/me', {
          businessType,
          fullName,
          tradeLicense,
          serviceAreas,
          availability: { maxConcurrentProjects }
        });
        profile = (res && res.profile) || null;
        if (res && res.message && res.message.includes('re-checked')) {
          showAlert('info', t('profile.recheckNotice'));
        } else {
          showAlert('success', (res && res.message) || t('profile.success'));
        }
      } else {
        const res = await post('/contractor-profile', {
          businessType,
          fullName,
          tradeLicense,
          serviceAreas,
          availability: { maxConcurrentProjects }
        });
        profile = (res && res.profile) || null;
        showAlert('success', t('profile.success'));
      }
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

// ── Verified Reviews (Launch Blocker L5.1) ───────────────────────────────────
function renderReviews(reviews, aggregates) {
  const section = $('reviews-section');
  if (!section) return;

  const aggBadge = $('reviews-aggregate-badge');
  if (aggBadge) {
    if (aggregates && aggregates.totalReviews > 0) {
      const avg = Number(aggregates.averageRating || 0).toFixed(1);
      aggBadge.textContent = `★ ${avg} / 5 (${aggregates.totalReviews})`;
    } else {
      aggBadge.textContent = '';
    }
  }

  const list = $('reviews-list');
  const empty = $('reviews-empty');

  if (!reviews || reviews.length === 0) {
    if (list) list.replaceChildren();
    if (empty) empty.hidden = false;
    section.hidden = false;
    return;
  }

  if (empty) empty.hidden = true;
  if (!list) return;
  list.replaceChildren();

  reviews.forEach((r) => {
    const card = el('div', 'p-md rounded-xl bg-surface-container-low border border-border-subtle space-y-sm');

    // Header row: Rating + Date
    const topRow = el('div', 'flex items-center justify-between gap-sm flex-wrap');
    const ratingGroup = el('div', 'flex items-center gap-xs font-semibold text-on-surface');
    const star = el('span', 'text-amber-500 font-bold', '★');
    star.setAttribute('aria-hidden', 'true');
    const ratingText = el('span', '', `${r.rating} / 5`);
    ratingGroup.append(star, ratingText);

    const dateText = el('span', 'text-body-sm text-on-surface-variant', formatDate(r.createdAt));
    topRow.append(ratingGroup, dateText);

    // Badges row: Verified milestone + Metric chips
    const badgesRow = el('div', 'flex items-center gap-xs flex-wrap');
    const verifiedBadge = el('span', 'badge-category bg-success/15 text-on-surface border border-success/40', t('profile.reviews.verifiedProject'));
    badgesRow.append(verifiedBadge);

    if (r.metrics) {
      if (r.metrics.quality) {
        const qPill = el('span', 'badge-category bg-surface-variant text-on-surface text-caption', `${t('contract.review.qualityLabel')}: ${r.metrics.quality}/5`);
        badgesRow.append(qPill);
      }
      if (r.metrics.timeline) {
        const tPill = el('span', 'badge-category bg-surface-variant text-on-surface text-caption', `${t('contract.review.timelineLabel')}: ${r.metrics.timeline}/5`);
        badgesRow.append(tPill);
      }
      if (r.metrics.communication) {
        const cPill = el('span', 'badge-category bg-surface-variant text-on-surface text-caption', `${t('contract.review.communicationLabel')}: ${r.metrics.communication}/5`);
        badgesRow.append(cPill);
      }
    }

    // Comment
    const commentP = el('p', 'text-body-md text-on-surface mt-xs break-words');
    commentP.textContent = r.comment || '';

    card.append(topRow, badgesRow, commentP);
    list.append(card);
  });

  section.hidden = false;
}

async function loadReviews(contractorId) {
  if (!contractorId) return;
  try {
    const res = await get(`/reviews/contractor/${encodeURIComponent(contractorId)}`);
    currentReviews = (res.data && res.data.reviews) || [];
    currentAggregates = (res.data && res.data.aggregates) || null;
    renderReviews(currentReviews, currentAggregates);
  } catch (err) {
    console.error('Failed to load contractor reviews:', err);
    renderReviews([], null);
  }
}

async function loadProfile() {
  const params = new URLSearchParams(window.location.search);
  const targetId = params.get('id');

  if (targetId) {
    const editBtn = $('btn-edit-profile');
    if (editBtn) editBtn.hidden = true;

    const res = await get(`/contractor-profile/directory/${encodeURIComponent(targetId)}`);
    profile = (res && res.data && res.data.contractor) || null;
    if (profile) {
      renderProfileView(profile);
      await loadReviews(targetId);
    } else {
      openCreateMode();
    }
    return;
  }

  try {
    const res = await get('/contractor-profile/me');
    profile = (res && res.profile) || null;
    if (profile) {
      renderProfileView(profile);
      await loadReviews(profile.userId);
    } else {
      openCreateMode();
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      // No profile exists yet — normal for new contractor
      openCreateMode();
    } else {
      throw err;
    }
  }
}

document.addEventListener('langchange', () => {
  applyLang();
  if (profile) renderProfileView(profile);
  renderReviews(currentReviews, currentAggregates);
  if (formMode === 'edit') {
    const formTitle = $('form-title');
    if (formTitle) formTitle.textContent = t('profile.editTitle');
  }
});

(async () => {
  await initShell();
  const params = new URLSearchParams(window.location.search);
  const targetId = params.get('id');

  if (targetId) {
    const me = await requireAuth();
    if (!me) return;
  } else {
    const me = await requireAuth({ roles: ['CONTRACTOR'] });
    if (!me) return;
    wireForm();
  }

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
