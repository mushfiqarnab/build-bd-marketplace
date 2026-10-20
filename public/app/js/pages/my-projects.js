// frontend/js/pages/my-projects.js
// Client / Probashi Multi-Project Hub controller
// Pure DOM, zero innerHTML, zero insertAdjacentHTML
'use strict';

import { get, post, del } from '../api.js';
import { t, toBengaliDigits, getLang, initI18n } from '../i18n.js';
import { requireSession, formatTaka, formatDate } from '../session.js';
import { openDialog, closeDialog } from '../dialog.js';
import { renderProgressTimeline } from '../components/progressTimeline.js';
import { renderFamilyRolePicker } from '../components/familyRolePicker.js';

let currentStatusFilter = '';
let activeProjectsData = [];
let currentProjectIdForDelegation = null;
let currentProjectTitleForDelegation = '';
let selectedScopedRole = 'FAMILY_VIEWER';

const $ = (id) => document.getElementById(id);

function showAlert(message, isError = false) {
  const alert = $('alert');
  if (!alert) return;
  alert.replaceChildren();
  alert.className = `p-md rounded-lg text-body-sm font-medium ${
    isError
      ? 'bg-error/15 text-error border border-error/30'
      : 'bg-success/15 text-on-surface border border-success/30'
  }`;
  alert.textContent = message;
  alert.hidden = false;
  alert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearAlert() {
  const alert = $('alert');
  if (alert) {
    alert.hidden = true;
    alert.replaceChildren();
  }
}

async function loadProjects() {
  const loading = $('loading');
  const content = $('content');
  const empty = $('empty-state');
  const container = $('projects-container');

  clearAlert();
  if (loading) loading.hidden = false;
  if (content) content.hidden = true;

  try {
    const qs = currentStatusFilter ? `?status=${encodeURIComponent(currentStatusFilter)}` : '';
    const response = await get(`/projects/my-projects${qs}`);

    if (loading) loading.hidden = true;
    if (content) content.hidden = false;

    if (response.status !== 'success') {
      showAlert(response.message || 'Failed to load projects.', true);
      return;
    }

    const { summary, projects } = response;
    activeProjectsData = projects || [];

    // Render KPI Overview
    const kpiTotal = $('kpi-total-projects');
    const kpiActive = $('kpi-active-contracts');
    const kpiCommitted = $('kpi-committed-taka');
    const kpiActions = $('kpi-pending-actions');
    const kpiBadge = $('kpi-actions-badge');

    if (kpiTotal) kpiTotal.textContent = getLang() === 'bn' ? toBengaliDigits(summary.totalProjectsCount || 0) : String(summary.totalProjectsCount || 0);
    if (kpiActive) kpiActive.textContent = getLang() === 'bn' ? toBengaliDigits(summary.activeContractsCount || 0) : String(summary.activeContractsCount || 0);
    if (kpiCommitted) kpiCommitted.textContent = formatTaka(summary.totalCommittedBDT || 0);
    if (kpiActions) kpiActions.textContent = getLang() === 'bn' ? toBengaliDigits(summary.pendingActionsCount || 0) : String(summary.pendingActionsCount || 0);
    if (kpiBadge) kpiBadge.hidden = (summary.pendingActionsCount || 0) === 0;

    // Render Project Cards
    container.replaceChildren();

    if (!projects || projects.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }

    if (empty) empty.hidden = true;

    projects.forEach((p) => {
      container.appendChild(createProjectCard(p));
    });
  } catch (err) {
    if (loading) loading.hidden = true;
    if (content) content.hidden = false;
    showAlert(err.message || 'Error communicating with server.', true);
  }
}

function createProjectCard(p) {
  const card = document.createElement('article');
  card.className = 'card p-md sm:p-lg bg-surface-card border border-outline-variant shadow-elevation-1 rounded-card space-y-md';
  card.dataset.projectId = String(p._id);

  // Top header: Status badge + Title + Category
  const headerRow = document.createElement('div');
  headerRow.className = 'flex items-start justify-between gap-sm flex-wrap';

  const titleCol = document.createElement('div');
  titleCol.className = 'space-y-xs max-w-2xl';

  const badgeRow = document.createElement('div');
  badgeRow.className = 'flex items-center gap-xs flex-wrap';

  const catBadge = document.createElement('span');
  catBadge.className = 'badge-category bg-primary-container/20 text-on-surface border border-primary/30 text-[11px] font-bold';
  catBadge.textContent = t(`post.cat.${p.category}`) || p.category;
  badgeRow.appendChild(catBadge);

  const statusBadge = document.createElement('span');
  statusBadge.className = 'badge-category text-[11px] font-bold ';
  if (p.status === 'ASSIGNED') {
    statusBadge.className += 'bg-success/15 text-on-surface border border-success/40';
    statusBadge.textContent = t('myProjects.status.assigned') || 'ACTIVE CONSTRUCTION';
  } else if (p.status === 'OPEN') {
    statusBadge.className += 'bg-secondary/15 text-secondary border border-secondary/40';
    statusBadge.textContent = t('myProjects.status.open') || 'UNDER BIDDING';
  } else if (p.status === 'COMPLETED') {
    statusBadge.className += 'bg-surface-container text-on-surface-variant border border-outline-variant';
    statusBadge.textContent = t('myProjects.status.completed') || 'COMPLETED';
  } else {
    statusBadge.className += 'bg-outline-variant text-on-surface';
    statusBadge.textContent = p.status;
  }
  badgeRow.appendChild(statusBadge);

  if (p.hasSiteCoordinates) {
    const gpsBadge = document.createElement('span');
    gpsBadge.className = 'inline-flex items-center gap-[2px] text-[11px] text-on-surface-variant font-medium';
    const placeIcon = document.createElement('span');
    placeIcon.className = 'icon text-[14px] text-primary';
    placeIcon.setAttribute('aria-hidden', 'true');
    placeIcon.textContent = 'place';
    gpsBadge.append(placeIcon, document.createTextNode(p.location));
    badgeRow.appendChild(gpsBadge);
  }

  titleCol.appendChild(badgeRow);

  const titleLink = document.createElement('a');
  titleLink.href = `/app/project-detail.html?id=${encodeURIComponent(p._id)}`;
  titleLink.className = 'text-h3 font-bold text-on-surface hover:text-primary transition-colors block mt-xs';
  titleLink.textContent = p.title;
  titleCol.appendChild(titleLink);

  headerRow.appendChild(titleCol);

  // Financial Summary Box
  const finBox = document.createElement('div');
  finBox.className = 'p-sm rounded-lg bg-surface-container text-right sm:text-right w-full sm:w-auto shrink-0 space-y-[2px]';

  const budgetLabel = document.createElement('p');
  budgetLabel.className = 'text-label-sm text-on-surface-variant uppercase tracking-wider text-[11px]';
  budgetLabel.textContent = t('myProjects.card.budget') || 'Planned Budget';

  const budgetVal = document.createElement('p');
  budgetVal.className = 'text-title-md font-bold text-primary';
  budgetVal.textContent = formatTaka(p.budget || 0);

  finBox.append(budgetLabel, budgetVal);

  if (p.financials?.committedBDT > 0) {
    const releasedLine = document.createElement('p');
    releasedLine.className = 'text-[11px] text-on-surface-variant';
    releasedLine.textContent = `${t('myProjects.card.released') || 'Released'}: ${formatTaka(p.financials.releasedBDT)}`;
    finBox.appendChild(releasedLine);
  }

  headerRow.appendChild(finBox);
  card.appendChild(headerRow);

  // Queue / Attention Needed Chips
  const queueRow = document.createElement('div');
  queueRow.className = 'flex items-center gap-xs flex-wrap pt-xs border-t border-border-subtle';

  if (p.queue?.unreviewedBidsCount > 0) {
    const bidChip = document.createElement('span');
    bidChip.className = 'badge-category bg-secondary/15 text-secondary border border-secondary/30 text-[11px] font-bold inline-flex items-center gap-[4px]';
    const icon = document.createElement('span');
    icon.className = 'icon text-[14px]';
    icon.textContent = 'handyman';
    const countText = getLang() === 'bn' ? toBengaliDigits(p.queue.unreviewedBidsCount) : String(p.queue.unreviewedBidsCount);
    bidChip.append(icon, document.createTextNode(`${countText} ${t('myProjects.chip.unreviewedBids') || 'New Bids'}`));
    queueRow.appendChild(bidChip);
  }

  if (p.queue?.pendingProofsCount > 0) {
    const proofChip = document.createElement('span');
    proofChip.className = 'badge-category bg-primary-container text-on-primary-container text-[11px] font-bold inline-flex items-center gap-[4px]';
    const icon = document.createElement('span');
    icon.className = 'icon text-[14px]';
    icon.textContent = 'photo_camera';
    const countText = getLang() === 'bn' ? toBengaliDigits(p.queue.pendingProofsCount) : String(p.queue.pendingProofsCount);
    proofChip.append(icon, document.createTextNode(`${countText} ${t('myProjects.chip.pendingProofs') || 'Milestone Proofs'}`));
    queueRow.appendChild(proofChip);
  }

  if (p.queue?.variancesCount > 0) {
    const varChip = document.createElement('span');
    varChip.className = 'badge-category bg-secondary/15 text-secondary border border-secondary/30 text-[11px] font-bold inline-flex items-center gap-[4px]';
    const icon = document.createElement('span');
    icon.className = 'icon text-[14px]';
    icon.textContent = 'warning';
    const countText = getLang() === 'bn' ? toBengaliDigits(p.queue.variancesCount) : String(p.queue.variancesCount);
    varChip.append(icon, document.createTextNode(`${countText} ${t('myProjects.chip.materialVariances') || 'Material Notices'}`));
    queueRow.appendChild(varChip);
  }

  if (queueRow.children.length > 0) {
    card.appendChild(queueRow);
  }

  // Active Delegation Shares Strip
  const activeShares = p.activeShares || [];
  const sharesRow = document.createElement('div');
  sharesRow.className = 'flex items-center justify-between gap-sm flex-wrap text-body-sm pt-xs';

  const sharesInfo = document.createElement('div');
  sharesInfo.className = 'flex items-center gap-xs text-on-surface-variant text-[12px]';

  const shareIcon = document.createElement('span');
  shareIcon.className = 'icon text-[16px] text-primary';
  shareIcon.textContent = 'share';
  sharesInfo.appendChild(shareIcon);

  const shareCountText = getLang() === 'bn' ? toBengaliDigits(activeShares.length) : String(activeShares.length);
  const shareLabel = document.createElement('span');
  shareLabel.textContent = `${shareCountText} ${t('myProjects.activeDelegates') || 'Active Family/Site Delegates'}`;
  sharesInfo.appendChild(shareLabel);

  sharesRow.appendChild(sharesInfo);

  // Actions Bar
  const actionsBar = document.createElement('div');
  actionsBar.className = 'flex items-center gap-xs flex-wrap';

  // Delegate Button
  const btnDelegate = document.createElement('button');
  btnDelegate.type = 'button';
  btnDelegate.className = 'btn-outline min-h-[44px] px-md py-xs text-body-sm inline-flex items-center gap-xs';
  const delIcon = document.createElement('span');
  delIcon.className = 'icon text-[16px]';
  delIcon.textContent = 'share';
  btnDelegate.append(delIcon, document.createTextNode(t('myProjects.btnDelegate') || 'Delegate Access'));
  btnDelegate.addEventListener('click', () => openDelegationDialog(p));
  actionsBar.appendChild(btnDelegate);

  // Manage Shares Button (if any exist)
  if (activeShares.length > 0) {
    const btnManage = document.createElement('button');
    btnManage.type = 'button';
    btnManage.className = 'btn-ghost min-h-[44px] px-sm py-xs text-body-sm inline-flex items-center gap-xs text-primary';
    const eyeIcon = document.createElement('span');
    eyeIcon.className = 'icon text-[16px]';
    eyeIcon.textContent = 'visibility';
    btnManage.append(eyeIcon, document.createTextNode(t('myProjects.btnManageShares') || 'Manage Shares'));
    btnManage.addEventListener('click', () => openManageSharesDialog(p));
    actionsBar.appendChild(btnManage);
  }

  // View Project Detail CTA
  const linkDetail = document.createElement('a');
  linkDetail.href = `/app/project-detail.html?id=${encodeURIComponent(p._id)}`;
  linkDetail.className = 'btn-primary min-h-[44px] px-md py-xs text-body-sm inline-flex items-center gap-xs';
  const arrIcon = document.createElement('span');
  arrIcon.className = 'icon text-[16px]';
  arrIcon.textContent = 'arrow_forward';
  linkDetail.append(document.createTextNode(t('myProjects.btnViewDetails') || 'View Project'), arrIcon);
  actionsBar.appendChild(linkDetail);

  sharesRow.appendChild(actionsBar);
  card.appendChild(sharesRow);

  return card;
}

// ── Delegation Dialog Handlers ────────────────────────────────────────────────
function openDelegationDialog(project) {
  currentProjectIdForDelegation = project._id;
  currentProjectTitleForDelegation = project.title;

  $('modal-project-id').value = String(project._id);
  $('modal-project-title').textContent = project.title;
  $('delegate-name').value = '';
  $('delegate-phone').value = '';
  $('hide-financials-check').checked = true;
  $('expiry-select').value = '30';
  $('share-result').hidden = true;
  $('btn-submit-share').disabled = false;

  $('delegate-name-error').hidden = true;
  $('delegate-phone-error').hidden = true;

  selectedScopedRole = 'FAMILY_VIEWER';
  renderRolePicker();

  openDialog($('delegation-modal'), document.activeElement);
}

function renderRolePicker() {
  const mount = $('role-picker-mount');
  if (!mount) return;
  mount.replaceChildren();

  const picker = renderFamilyRolePicker({
    selected: selectedScopedRole,
    onChange: (role) => {
      selectedScopedRole = role;
      const hideCheck = $('hide-financials-check');
      if (role === 'FAMILY_VIEWER' && hideCheck) {
        hideCheck.checked = true;
      }
    }
  });
  mount.appendChild(picker);
}

async function handleDelegationSubmit(e) {
  e.preventDefault();
  clearAlert();

  const nameInput = $('delegate-name');
  const phoneInput = $('delegate-phone');
  const hideFinancials = $('hide-financials-check').checked;
  const expiresInDays = parseInt($('expiry-select').value, 10) || 30;

  const nameErr = $('delegate-name-error');
  const phoneErr = $('delegate-phone-error');
  nameErr.hidden = true;
  phoneErr.hidden = true;

  const nameVal = nameInput.value.trim();
  const phoneVal = phoneInput.value.trim();

  if (nameVal.length < 2 || nameVal.length > 80) {
    nameErr.textContent = t('delegation.err.nameLength') || 'Name must be between 2 and 80 characters.';
    nameErr.hidden = false;
    nameInput.focus();
    return;
  }

  if (selectedScopedRole === 'SITE_WATCHER' && !phoneVal) {
    phoneErr.textContent = t('delegation.err.phoneRequired') || 'Phone number is mandatory for Site-Watcher delegates.';
    phoneErr.hidden = false;
    phoneInput.focus();
    return;
  }

  const submitBtn = $('btn-submit-share');
  submitBtn.disabled = true;

  try {
    const res = await post(`/projects/${currentProjectIdForDelegation}/shares`, {
      scopedRole: selectedScopedRole,
      delegateName: nameVal,
      delegatePhone: phoneVal || null,
      hideFinancials,
      expiresInDays
    });

    submitBtn.disabled = false;

    if (res.status !== 'success') {
      showAlert(res.message || 'Failed to create delegation link.', true);
      return;
    }

    const { rawToken, shareUrl, whatsappUrl } = res.data;
    const fullUrl = `${window.location.origin}${shareUrl}`;

    $('generated-url-input').value = fullUrl;
    $('btn-whatsapp-share').href = whatsappUrl || `https://wa.me/?text=${encodeURIComponent(fullUrl)}`;

    $('share-result').hidden = false;
    $('share-result').scrollIntoView({ behavior: 'smooth' });

    // Refresh projects list in background
    loadProjects();
  } catch (err) {
    submitBtn.disabled = false;
    showAlert(err.message || 'Error communicating with server.', true);
  }
}

// ── Manage Active Shares Dialog ────────────────────────────────────────────────
async function openManageSharesDialog(project) {
  const modal = $('shares-list-modal');
  const container = $('shares-list-content');
  container.replaceChildren();

  const loadingP = document.createElement('p');
  loadingP.className = 'text-body-sm text-on-surface-variant italic';
  loadingP.textContent = t('delegation.loadingShares') || 'Loading active shares...';
  container.appendChild(loadingP);

  openDialog(modal, document.activeElement);

  try {
    const res = await get(`/projects/${project._id}/shares`);
    container.replaceChildren();

    if (res.status !== 'success' || !res.shares || res.shares.length === 0) {
      const emptyP = document.createElement('p');
      emptyP.className = 'text-body-sm text-on-surface-variant';
      emptyP.textContent = t('delegation.noShares') || 'No shares found for this project.';
      container.appendChild(emptyP);
      return;
    }

    res.shares.forEach((s) => {
      const row = document.createElement('div');
      row.className = `p-sm rounded-lg border flex items-center justify-between gap-sm flex-wrap ${
        s.isRevoked ? 'bg-surface-container/50 border-border-subtle opacity-60' : 'bg-surface-card border-outline-variant shadow-elevation-1'
      }`;

      const left = document.createElement('div');
      left.className = 'space-y-[2px]';

      const nameRow = document.createElement('div');
      nameRow.className = 'flex items-center gap-xs';

      const roleBadge = document.createElement('span');
      roleBadge.className = `text-[10px] font-bold uppercase tracking-wider px-xs py-[1px] rounded ${
        s.scopedRole === 'SITE_WATCHER' ? 'bg-primary-container text-on-primary-container' : 'bg-secondary/15 text-secondary'
      }`;
      roleBadge.textContent = s.scopedRole === 'SITE_WATCHER' ? 'SITE WATCHER' : 'FAMILY VIEWER';
      nameRow.appendChild(roleBadge);

      const nameText = document.createElement('span');
      nameText.className = 'font-semibold text-on-surface text-body-sm';
      nameText.textContent = s.delegateName;
      nameRow.appendChild(nameText);

      left.appendChild(nameRow);

      const expDate = document.createElement('p');
      expDate.className = 'text-[11px] text-on-surface-variant';
      expDate.textContent = `${t('delegation.expires') || 'Expires'}: ${formatDate(s.expiresAt)}`;
      left.appendChild(expDate);

      row.appendChild(left);

      // Revoke Action
      if (!s.isRevoked) {
        const btnRevoke = document.createElement('button');
        btnRevoke.type = 'button';
        btnRevoke.className = 'btn-outline min-h-[44px] px-sm text-error border-error/40 hover:bg-error/10 text-body-sm';
        btnRevoke.textContent = t('delegation.btnRevoke') || 'Revoke Access';
        btnRevoke.addEventListener('click', async () => {
          btnRevoke.disabled = true;
          try {
            await del(`/projects/${project._id}/shares/${s._id}`);
            showAlert(t('delegation.revokedSuccess') || 'Share token revoked successfully.');
            openManageSharesDialog(project);
            loadProjects();
          } catch (err) {
            btnRevoke.disabled = false;
            showAlert(err.message || 'Revocation failed', true);
          }
        });
        row.appendChild(btnRevoke);
      } else {
        const revokedTag = document.createElement('span');
        revokedTag.className = 'text-[11px] font-medium text-error';
        revokedTag.textContent = t('delegation.revoked') || 'REVOKED';
        row.appendChild(revokedTag);
      }

      container.appendChild(row);
    });
  } catch (err) {
    container.replaceChildren();
    const errP = document.createElement('p');
    errP.className = 'text-body-sm text-error';
    errP.textContent = err.message || 'Failed to load shares.';
    container.appendChild(errP);
  }
}

// ── Initialisation ────────────────────────────────────────────────────────────
async function init() {
  await initI18n();
  const session = await requireSession(['CLIENT']);
  if (!session) return;

  // Filter Buttons
  const filterButtons = [
    { id: 'filter-all', status: '' },
    { id: 'filter-assigned', status: 'ASSIGNED' },
    { id: 'filter-open', status: 'OPEN' },
    { id: 'filter-completed', status: 'COMPLETED' }
  ];

  filterButtons.forEach(({ id, status }) => {
    const btn = $(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      filterButtons.forEach((b) => {
        const el = $(b.id);
        if (el) {
          el.className = b.status === status
            ? 'btn-primary min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap'
            : 'btn-outline min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap';
          el.setAttribute('aria-selected', b.status === status ? 'true' : 'false');
        }
      });
      currentStatusFilter = status;
      loadProjects();
    });
  });

  // Modal Closers
  const delModal = $('delegation-modal');
  $('modal-delegation-close')?.addEventListener('click', () => closeDialog(delModal));
  $('delegation-modal')?.addEventListener('cancel', () => closeDialog(delModal));

  const listModal = $('shares-list-modal');
  $('modal-shares-list-close')?.addEventListener('click', () => closeDialog(listModal));
  $('shares-list-modal')?.addEventListener('cancel', () => closeDialog(listModal));

  // Form Submit
  $('delegation-form')?.addEventListener('submit', handleDelegationSubmit);

  // Copy Link Button
  $('btn-copy-url')?.addEventListener('click', () => {
    const input = $('generated-url-input');
    if (!input || !input.value) return;
    navigator.clipboard?.writeText(input.value).then(() => {
      const btn = $('btn-copy-url');
      const originalText = btn.textContent;
      btn.textContent = t('delegation.copied') || 'Copied!';
      setTimeout(() => { btn.textContent = originalText; }, 2000);
    });
  });

  await loadProjects();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
