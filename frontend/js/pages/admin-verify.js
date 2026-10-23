// Admin Verification Queue — review pending contractor & supplier KYC profiles.
//
// Invariants (Lane 1 audit rules):
//   - Pure DOM (replaceChildren, append, createElement, textContent) — no innerHTML.
//   - Network via ../api.js (get, patch).
//   - requireAuth({ roles: ['ADMIN'] }) before content reveal.
//   - All copy via t() with en and bn keys.
//   - Dates via formatDate().
//   - Touch targets >= 44px floor on all buttons, tabs, inputs.

import { initShell } from '../shell.js';
import { get, patch, ApiError } from '../api.js';
import { t, applyLang, formatDate } from '../i18n.js';
import { requireAuth } from '../session.js';

const $ = (id) => document.getElementById(id);

let pendingContractors = [];
let pendingSuppliers = [];
let pendingDomestic = [];
let activeTab = 'contractors'; // 'contractors' | 'suppliers' | 'domestic'

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

// ── Contractor Card Builder ──
function buildContractorCard(profile) {
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

  if (profile.contractorTier) {
    const tierKey = `profile.tier.${profile.contractorTier.toLowerCase()}`;
    left.append(el('span', 'badge-category bg-primary text-on-primary mt-xs inline-block', t(tierKey) || profile.contractorTier));
  }

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

  if (Array.isArray(profile.workGenres) && profile.workGenres.length > 0) {
    const genresWrap = el('div', 'flex flex-col col-span-full');
    genresWrap.append(el('dt', 'text-label-sm text-on-surface-variant', t('profile.workGenres')));
    const chips = el('div', 'flex flex-wrap gap-xs mt-xs');
    for (const g of profile.workGenres) {
      const gKey = `profile.genre.${g.toLowerCase()}`;
      chips.append(el('span', 'badge-category bg-surface-variant text-on-surface border border-outline-variant', t(gKey) || g));
    }
    genresWrap.append(chips);
    facts.append(genresWrap);
  }

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
      await loadQueues();
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
      await loadQueues();
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

// ── Supplier Card Builder ──
function buildSupplierCard(supplier) {
  const li = el('li');
  const card = el('article', 'card p-lg flex flex-col gap-md');

  const head = el('div', 'flex flex-wrap items-start justify-between gap-sm border-b border-border-subtle pb-sm');
  const left = el('div');
  left.append(
    el('h2', 'text-h3 font-bold text-on-surface', supplier.businessName || '—'),
    el('p', 'text-body-sm text-on-surface-variant mt-xs', t('supplier.badge'))
  );

  const status = supplier.verificationStatus || 'PENDING_VERIFICATION';
  const badge = el('span', 'badge-category bg-cta-amber/20 text-on-surface border border-cta-amber',
    t('profile.status.pending')
  );
  head.append(left, badge);

  const facts = el('dl', 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-sm');
  facts.append(
    field('adminVerify.field.phone', supplier.phoneNumber),
    field('adminVerify.supplier.field.tradeLicense', supplier.tradeLicenseNumber),
    field('adminVerify.supplier.field.nid', supplier.nidNumber)
  );

  const catNames = (supplier.categories || [])
    .map((c) => t(`supplier.cat.${c.toLowerCase()}`) || c)
    .join(', ');
  facts.append(field('adminVerify.supplier.field.categories', catNames));

  const distNames = (supplier.serviceDistricts || []).join(', ');
  facts.append(field('adminVerify.supplier.field.districts', distNames));

  if (supplier.bstiLicenseNumber || supplier.bstiQrDocUrl) {
    const bstiWrap = el('div', 'flex flex-col');
    bstiWrap.append(el('dt', 'text-label-sm text-on-surface-variant', t('adminVerify.supplier.field.bsti')));
    const dd = el('dd', 'text-body-md text-on-surface break-all flex items-center gap-xs');
    dd.append(el('span', '', supplier.bstiLicenseNumber || '—'));
    if (supplier.bstiQrDocUrl) {
      const docLink = el('a', 'text-primary underline text-body-sm ml-xs min-h-[44px] inline-flex items-center', t('adminVerify.supplier.viewBstiDoc'));
      docLink.href = supplier.bstiQrDocUrl;
      docLink.target = '_blank';
      docLink.rel = 'noopener noreferrer';
      dd.append(docLink);
    }
    bstiWrap.append(dd);
    facts.append(bstiWrap);
  }

  facts.append(field('adminVerify.field.submitted', formatDate(supplier.submittedAt)));

  card.append(head, facts);

  // Supplier Verification Actions Form
  const actionsForm = el('form', 'mt-sm pt-md border-t border-border-subtle flex flex-col sm:flex-row flex-wrap sm:items-end gap-md');
  actionsForm.noValidate = true;

  // Rejection Reason Input
  const reasonCol = el('div', 'flex flex-col gap-xs flex-1 min-w-[200px]');
  const reasonInput = el('input', 'field py-xs text-body-sm min-h-[44px]');
  reasonInput.type = 'text';
  reasonInput.placeholder = t('adminVerify.supplier.rejectionReasonPlaceholder');
  reasonInput.setAttribute('aria-label', t('adminVerify.supplier.rejectionReasonPlaceholder'));
  reasonCol.append(reasonInput);

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

  const btnGroup = el('div', 'flex flex-wrap gap-sm');
  btnGroup.append(approveBtn, rejectBtn);

  actionsForm.append(reasonCol, btnGroup);

  let inFlight = false;

  actionsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (inFlight) return;
    inFlight = true;
    busy(approveBtn, true, 'adminVerify.action.verifying');
    rejectBtn.disabled = true;

    try {
      await patch(`/supplier/${encodeURIComponent(supplier.userId)}/verify`, {
        status: 'VERIFIED'
      });
      showAlert('success', t('adminVerify.supplier.verifiedSuccess'));
      await loadQueues();
    } catch (err) {
      showAlert('error', err instanceof ApiError ? err.message : t('err.generic'));
      busy(approveBtn, false);
      rejectBtn.disabled = false;
      inFlight = false;
    }
  });

  rejectBtn.addEventListener('click', async () => {
    if (inFlight) return;
    const reason = reasonInput.value.trim();
    if (!reason) {
      showAlert('error', t('adminVerify.supplier.rejectionReasonRequired'));
      reasonInput.focus();
      return;
    }

    inFlight = true;
    busy(rejectBtn, true, 'adminVerify.action.rejecting');
    approveBtn.disabled = true;

    try {
      await patch(`/supplier/${encodeURIComponent(supplier.userId)}/verify`, {
        status: 'REJECTED',
        rejectionReason: reason
      });
      showAlert('success', t('adminVerify.supplier.rejectedSuccess'));
      await loadQueues();
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

// ── Domestic Worker Card Builder ──
function buildDomesticCard(worker) {
  const li = el('li');
  const card = el('article', 'card p-lg flex flex-col gap-md');

  const head = el('div', 'flex flex-wrap items-start justify-between gap-sm border-b border-border-subtle pb-sm');
  const left = el('div');
  left.append(
    el('h2', 'text-h3 font-bold text-on-surface', worker.fullName || '—'),
    el('p', 'text-body-sm text-on-surface-variant mt-xs', `${worker.workerCategory || 'DOMESTIC_WORKER'} • ${worker.subTier || 'L2_PART_TIME_MONTHLY'}`)
  );

  const isVerified = worker.ring3_dmp_cims && worker.ring3_dmp_cims.cims_verified;
  const status = isVerified ? 'VERIFIED' : 'PENDING';
  const badge = el('span', isVerified ? 'badge-category bg-success/15 text-on-surface border border-success/40' : 'badge-category bg-cta-amber/20 text-on-surface border border-cta-amber',
    t(`profile.status.${status.toLowerCase()}`) || status
  );
  head.append(left, badge);

  const facts = el('dl', 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-sm');
  facts.append(
    field('adminVerify.field.phone', worker.phoneNumber),
    field('adminVerify.domestic.field.location', `${worker.thana || '—'}, ${worker.district || 'Dhaka'}`),
    field('adminVerify.field.submitted', formatDate(worker.createdAt))
  );

  const porichoyMatch = worker.ring1_porichoy?.face_match_percentage;
  const porichoyStr = porichoyMatch ? `${porichoyMatch}% Match (Biometric Verified)` : 'Pending Verification';
  facts.append(field('adminVerify.domestic.field.porichoy', porichoyStr));

  const guarantorsCount = Array.isArray(worker.guarantors) ? worker.guarantors.length : 0;
  facts.append(field('adminVerify.domestic.field.guarantors', `${guarantorsCount} Active Reference(s)`));

  card.append(head, facts);

  // Domestic Worker Action Controls
  const actionsForm = el('form', 'mt-sm pt-md border-t border-border-subtle flex flex-col sm:flex-row flex-wrap sm:items-end justify-end gap-md');
  actionsForm.noValidate = true;

  // Approve button: Always pair bg-primary with text-on-primary on the exact same element string literal
  const approveBtn = el('button', 'btn-primary min-h-[44px] bg-primary text-on-primary flex items-center gap-xs');
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
  actionsForm.append(btnGroup);

  let inFlight = false;
  const targetId = worker.userId || worker._id;

  actionsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (inFlight) return;
    inFlight = true;
    busy(approveBtn, true, 'adminVerify.action.verifying');
    rejectBtn.disabled = true;

    try {
      await patch(`/api/v2/labour/workers/${encodeURIComponent(targetId)}/verify`, {
        status: 'VERIFIED'
      });
      showAlert('success', t('adminVerify.domestic.verifiedSuccess'));
      await loadQueues();
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
      await patch(`/api/v2/labour/workers/${encodeURIComponent(targetId)}/verify`, {
        status: 'REJECTED'
      });
      showAlert('success', t('adminVerify.domestic.rejectedSuccess'));
      await loadQueues();
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
  // Render Contractor Queue
  const contractorList = $('queue-list');
  contractorList.replaceChildren(...pendingContractors.map(buildContractorCard));
  $('queue-empty').hidden = pendingContractors.length > 0;
  $('badge-contractors-count').textContent = pendingContractors.length;

  // Render Supplier Queue
  const supplierList = $('supplier-queue-list');
  supplierList.replaceChildren(...pendingSuppliers.map(buildSupplierCard));
  $('supplier-queue-empty').hidden = pendingSuppliers.length > 0;
  $('badge-suppliers-count').textContent = pendingSuppliers.length;

  // Render Domestic Worker Queue
  const domesticList = $('domestic-list');
  if (domesticList) {
    domesticList.replaceChildren(...pendingDomestic.map(buildDomesticCard));
    $('domestic-empty').hidden = pendingDomestic.length > 0;
    $('badge-domestic-count').textContent = pendingDomestic.length;
  }

  // Render Summary for active tab
  if (activeTab === 'contractors') {
    $('summary').textContent = t('adminVerify.summary', { count: pendingContractors.length });
  } else if (activeTab === 'suppliers') {
    $('summary').textContent = t('adminVerify.suppliersSummary', { count: pendingSuppliers.length });
  } else {
    $('summary').textContent = t('adminVerify.domesticSummary', { count: pendingDomestic.length });
  }
}

function switchTab(tab) {
  activeTab = tab;
  const isContractor = tab === 'contractors';
  const isSupplier = tab === 'suppliers';
  const isDomestic = tab === 'domestic';

  const tabActiveCls = 'px-md py-sm font-semibold border-b-2 border-primary text-primary flex items-center gap-xs min-h-[44px] whitespace-nowrap';
  const tabInactiveCls = 'px-md py-sm font-semibold border-b-2 border-transparent text-on-surface-variant hover:text-on-surface flex items-center gap-xs min-h-[44px] whitespace-nowrap';

  $('tab-contractors').setAttribute('aria-selected', isContractor ? 'true' : 'false');
  $('tab-contractors').className = isContractor ? tabActiveCls : tabInactiveCls;

  $('tab-suppliers').setAttribute('aria-selected', isSupplier ? 'true' : 'false');
  $('tab-suppliers').className = isSupplier ? tabActiveCls : tabInactiveCls;

  if ($('tab-domestic')) {
    $('tab-domestic').setAttribute('aria-selected', isDomestic ? 'true' : 'false');
    $('tab-domestic').className = isDomestic ? tabActiveCls : tabInactiveCls;
  }

  $('panel-contractors').hidden = !isContractor;
  $('panel-suppliers').hidden = !isSupplier;
  if ($('panel-domestic')) {
    $('panel-domestic').hidden = !isDomestic;
  }

  render();
}

async function loadQueues() {
  const [contractorsRes, suppliersRes, domesticRes] = await Promise.all([
    get('/contractor-profile/pending').catch(() => ({ data: { profiles: [] } })),
    get('/supplier/pending').catch(() => ({ data: { suppliers: [] } })),
    get('/api/v2/labour/directory/search?verificationStatus=PENDING').catch(() => ({ data: [] }))
  ]);

  pendingContractors = (contractorsRes && contractorsRes.data && contractorsRes.data.profiles) || [];
  pendingSuppliers = (suppliersRes && suppliersRes.data && suppliersRes.data.suppliers) || [];
  pendingDomestic = (domesticRes && Array.isArray(domesticRes.data)) ? domesticRes.data : [];
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

  $('tab-contractors').addEventListener('click', () => switchTab('contractors'));
  $('tab-suppliers').addEventListener('click', () => switchTab('suppliers'));
  if ($('tab-domestic')) {
    $('tab-domestic').addEventListener('click', () => switchTab('domestic'));
  }

  try {
    await loadQueues();
    $('loading').hidden = true;
    $('content').hidden = false;
  } catch (err) {
    $('loading').hidden = true;
    const bootError = $('boot-error');
    bootError.textContent = t('err.generic');
    bootError.hidden = false;
  }
})();
