// frontend/js/pages/project-materials.js
// 🧱 Phase 3: Material Transparency Ledger Page
// 100% pure DOM architecture (zero innerHTML/insertAdjacentHTML), WCAG AA compliant.
'use strict';

import { initShell } from '../shell.js';
import { getMe } from '../session.js';
import { get, post, patch } from '../api.js';
import { t, formatTaka, formatDate } from '../i18n.js';
import { renderFlagChip } from '../components/flagChip.js';
import { showDeliveryConfirmSheet } from '../components/deliveryConfirmSheet.js';

const $ = (id) => document.getElementById(id);

let currentProjectId = null;
let currentDeliveries = [];
let currentFilter = 'all';
let currentUser = null;
let isOwner = false;
let isSiteWatcher = false;
let hideFinancials = false;

function showAlert(messageKey, isError = false) {
  const alertEl = $('alert');
  if (!alertEl) return;
  alertEl.textContent = '';
  alertEl.className = isError
    ? 'mb-lg alert-error p-md rounded-lg flex items-center gap-xs text-body-sm'
    : 'mb-lg alert-success p-md rounded-lg flex items-center gap-xs text-body-sm';

  const icon = document.createElement('span');
  icon.className = 'icon text-[20px]';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = isError ? 'error' : 'check_circle';

  const text = document.createElement('span');
  text.textContent = t(messageKey) || messageKey;

  alertEl.append(icon, text);
  alertEl.hidden = false;
}

function clearAlert() {
  const alertEl = $('alert');
  if (alertEl) alertEl.hidden = true;
}

export async function initProjectMaterials() {
  await initShell();
  currentUser = await getMe().catch(() => null);

  const params = new URLSearchParams(window.location.search);
  currentProjectId = params.get('id') || params.get('project');

  if (!currentProjectId) {
    window.location.href = '/app/my-projects.html';
    return;
  }

  $('btn-back').href = `/app/project-detail.html?id=${encodeURIComponent(currentProjectId)}`;

  // Tab filtering
  $('tab-all-deliveries').addEventListener('click', () => setFilter('all'));
  $('tab-flagged-deliveries').addEventListener('click', () => setFilter('flagged'));

  await loadLedger();
}

function setFilter(filter) {
  currentFilter = filter;
  $('tab-all-deliveries').className = filter === 'all'
    ? 'btn-primary min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap'
    : 'btn-outline min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap';
  $('tab-all-deliveries').setAttribute('aria-selected', filter === 'all' ? 'true' : 'false');

  $('tab-flagged-deliveries').className = filter === 'flagged'
    ? 'btn-primary min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap'
    : 'btn-outline min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap';
  $('tab-flagged-deliveries').setAttribute('aria-selected', filter === 'flagged' ? 'true' : 'false');

  renderDeliveries();
}

async function loadLedger() {
  $('loading').hidden = false;
  $('content').hidden = true;
  clearAlert();

  try {
    const res = await get(`/projects/${encodeURIComponent(currentProjectId)}/materials`);
    const data = res?.data || res;

    hideFinancials = !!data.hideFinancials;
    currentDeliveries = data.deliveries || [];

    $('project-title-heading').textContent = data.projectTitle || t('materialsLedger.title');

    // Financial redaction banner
    $('privacy-redacted-banner').hidden = !hideFinancials;

    // KPI values
    const summary = data.summary || {};
    $('kpi-planned-cost').textContent = hideFinancials ? '—' : formatTaka(summary.totalPlannedCost || 0);
    $('kpi-actual-cost').textContent = hideFinancials ? '—' : formatTaka(summary.totalActualCost || 0);
    $('kpi-variance-cost').textContent = hideFinancials ? '—' : formatTaka(summary.costVariance || 0);
    $('kpi-flags-count').textContent = String(summary.totalFlags || 0);

    // Permission checks
    isOwner = currentUser && (currentUser.role === 'CLIENT' || currentUser.role === 'ADMIN');
    isSiteWatcher = (currentUser && currentUser.role === 'CONTRACTOR') ||
      (currentUser && currentUser.isDelegate && currentUser.role === 'SITE_WATCHER');

    const recordBtn = $('btn-record-delivery');
    if (recordBtn) {
      recordBtn.hidden = !isSiteWatcher && !isOwner;
      recordBtn.onclick = () => {
        showDeliveryConfirmSheet({
          projectId: currentProjectId,
          onSubmit: async (payload) => {
            try {
              await post(`/projects/${encodeURIComponent(currentProjectId)}/materials/deliveries`, payload, {
                headers: { 'X-Idempotency-Key': crypto.randomUUID() }
              });
              showAlert('materialsLedger.deliveryRecordedSuccess', false);
              await loadLedger();
            } catch (err) {
              showAlert(err?.message || 'materialsLedger.errRecordFailed', true);
            }
          }
        });
      };
    }

    renderDeliveries();
    $('loading').hidden = true;
    $('content').hidden = false;
  } catch (err) {
    $('loading').hidden = true;
    showAlert(err?.message || 'materialsLedger.errLoadFailed', true);
  }
}

function renderDeliveries() {
  const container = $('deliveries-container');
  const emptyState = $('empty-state');
  container.textContent = '';

  const filtered = currentDeliveries.filter((d) => {
    if (currentFilter === 'flagged') {
      return (d.informationalFlags || []).length > 0;
    }
    return true;
  });

  if (!filtered.length) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  for (const item of filtered) {
    const card = document.createElement('div');
    card.className = 'card p-md sm:p-lg border border-outline-variant bg-surface-card space-y-md shadow-elevation-1';

    // Top row: Item Name, Category, Date
    const topRow = document.createElement('div');
    topRow.className = 'flex flex-wrap items-start justify-between gap-sm border-b border-border-subtle pb-sm';

    const itemTitleGroup = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.className = 'text-title-md font-bold text-on-surface';
    h3.textContent = item.itemName;

    const metaP = document.createElement('p');
    metaP.className = 'text-body-sm text-on-surface-variant flex items-center gap-xs mt-0.5';

    const catBadge = document.createElement('span');
    catBadge.className = 'badge-category';
    catBadge.textContent = t(`category.${item.category}`) || item.category;

    const dateSpan = document.createElement('span');
    dateSpan.textContent = formatDate(item.createdAt);

    metaP.append(catBadge, document.createTextNode(' · '), dateSpan);
    itemTitleGroup.append(h3, metaP);

    topRow.append(itemTitleGroup);

    // Specs comparison grid
    const specGrid = document.createElement('div');
    specGrid.className = 'grid grid-cols-1 sm:grid-cols-2 gap-sm p-sm rounded-lg bg-surface-container';

    // Planned block
    const planBlock = document.createElement('div');
    planBlock.className = 'space-y-0.5 text-body-sm';
    const planTitle = document.createElement('p');
    planTitle.className = 'text-label-sm font-semibold text-on-surface-variant uppercase tracking-wider';
    planTitle.textContent = t('materialsLedger.plannedSpecHeading');

    const planBrand = document.createElement('p');
    planBrand.className = 'text-on-surface';
    planBrand.textContent = `${t('materialsLedger.brand')}: ${item.plannedSpec?.brand || '—'}`;

    const planQty = document.createElement('p');
    planQty.className = 'text-on-surface';
    planQty.textContent = `${t('materialsLedger.qty')}: ${item.plannedSpec?.plannedQty || 0} ${item.plannedSpec?.unit || ''}`;

    planBlock.append(planTitle, planBrand, planQty);
    if (!hideFinancials && item.plannedSpec?.estimatedUnitPrice) {
      const planRate = document.createElement('p');
      planRate.className = 'text-on-surface font-mono';
      planRate.textContent = `${t('materialsLedger.estRate')}: ${formatTaka(item.plannedSpec.estimatedUnitPrice)}/${item.plannedSpec.unit || 'unit'}`;
      planBlock.append(planRate);
    }

    // Actual delivered block
    const actualBlock = document.createElement('div');
    actualBlock.className = 'space-y-0.5 text-body-sm';
    const actualTitle = document.createElement('p');
    actualTitle.className = 'text-label-sm font-semibold text-primary uppercase tracking-wider';
    actualTitle.textContent = t('materialsLedger.actualDeliveredHeading');

    const actualBrand = document.createElement('p');
    actualBrand.className = 'text-on-surface font-medium';
    actualBrand.textContent = `${t('materialsLedger.brand')}: ${item.actualSpec?.brand || '—'}`;

    const actualQty = document.createElement('p');
    actualQty.className = 'text-on-surface font-medium';
    actualQty.textContent = `${t('materialsLedger.qty')}: ${item.actualSpec?.actualQty || 0} ${item.actualSpec?.unit || ''}`;

    actualBlock.append(actualTitle, actualBrand, actualQty);
    if (!hideFinancials && item.actualSpec?.totalActualCost) {
      const actualCost = document.createElement('p');
      actualCost.className = 'text-money-fill font-bold font-mono';
      actualCost.textContent = `${t('materialsLedger.totalCost')}: ${formatTaka(item.actualSpec.totalActualCost)}`;
      actualBlock.append(actualCost);
    }

    specGrid.append(planBlock, actualBlock);

    // Supplier & Verification Footer
    const supplierRow = document.createElement('div');
    supplierRow.className = 'flex flex-wrap items-center justify-between gap-sm text-body-sm text-on-surface-variant pt-xs';

    const supInfo = document.createElement('div');
    supInfo.className = 'flex items-center gap-xs flex-wrap';

    if (item.supplierInfo?.chalanNo) {
      const chalanBadge = document.createElement('span');
      chalanBadge.className = 'inline-flex items-center gap-1 font-mono text-[12px]';
      const rIcon = document.createElement('span');
      rIcon.className = 'icon text-[14px]';
      rIcon.setAttribute('aria-hidden', 'true');
      rIcon.textContent = 'receipt_long';
      chalanBadge.append(rIcon, document.createTextNode(item.supplierInfo.chalanNo));
      supInfo.append(chalanBadge);
    }

    if (item.supplierInfo?.dealerName) {
      const dealerSpan = document.createElement('span');
      dealerSpan.textContent = `· ${item.supplierInfo.dealerName}`;
      supInfo.append(dealerSpan);
    }

    if (item.supplierInfo?.bstiLicenseNo) {
      const bstiLink = document.createElement('a');
      bstiLink.href = 'http://bsti.gov.bd';
      bstiLink.target = '_blank';
      bstiLink.rel = 'noopener noreferrer';
      bstiLink.className = 'btn-ghost min-h-[44px] inline-flex items-center gap-1 text-[12px] text-primary hover:underline px-2';
      const bIcon = document.createElement('span');
      bIcon.className = 'icon text-[14px]';
      bIcon.setAttribute('aria-hidden', 'true');
      bIcon.textContent = 'verified_user';
      bstiLink.append(bIcon, document.createTextNode(`BSTI: ${item.supplierInfo.bstiLicenseNo} ↗`));
      supInfo.append(bstiLink);
    }

    supplierRow.append(supInfo);

    // Truck Dimensions CFT badge if present
    if (item.truckDimensions?.calculatedCft > 0) {
      const truckBadge = document.createElement('span');
      truckBadge.className = 'inline-flex items-center gap-1 px-2 py-1 rounded bg-surface-container font-mono text-[12px] text-on-surface';
      const tIcon = document.createElement('span');
      tIcon.className = 'icon text-[14px]';
      tIcon.setAttribute('aria-hidden', 'true');
      tIcon.textContent = 'local_shipping';
      truckBadge.append(tIcon, document.createTextNode(`${item.truckDimensions.calculatedCft} CFT (${item.truckDimensions.lengthFt}×${item.truckDimensions.widthFt}×${item.truckDimensions.heightFt} ft)`));
      supplierRow.append(truckBadge);
    }

    // Flags section
    const flags = item.informationalFlags || [];
    let flagsBox = null;
    if (flags.length > 0) {
      flagsBox = document.createElement('div');
      flagsBox.className = 'space-y-xs pt-xs border-t border-border-subtle';

      for (const flag of flags) {
        const flagEl = renderFlagChip(flag, {
          isClientOwner: isOwner,
          onAcknowledge: async () => {
            try {
              await patch(`/projects/${encodeURIComponent(currentProjectId)}/materials/deliveries/${encodeURIComponent(item._id)}/acknowledge`, {}, {
                headers: { 'X-Idempotency-Key': crypto.randomUUID() }
              });
              showAlert('materialsLedger.flagAcknowledgedSuccess', false);
              await loadLedger();
            } catch (err) {
              showAlert(err?.message || 'materialsLedger.errAcknowledgeFailed', true);
            }
          }
        });
        flagsBox.append(flagEl);
      }
    }

    card.append(topRow, specGrid, supplierRow);
    if (flagsBox) card.append(flagsBox);
    container.append(card);
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initProjectMaterials);
}
