// F8 — Milestone Governance Workspace, Zero-RAM Proof Upload, Approval, Offline Settlement & Dispute.
//
// Dual-role page for CLIENT and CONTRACTOR.
//
// Data flow:
//   1. requireAuth() before paint.
//   2. Read project ID from URL query ?id=<id> or ?project=<id>.
//   3. GET /api/governance/escrow/:projectId -> retrieve EscrowLedger with milestones & evidenceLog.
//   4. Contractor flow (for milestones with status === 'IN_PROGRESS'):
//        - Pick/capture site photo.
//        - Read navigator.geolocation.getCurrentPosition with fallback.
//        - Compute SHA-256 subtle crypto digest client-side.
//        - GET /api/governance/proof/presigned-url
//        - Direct zero-RAM upload via uploadPresigned (PUT/POST branching).
//        - Commit via POST /api/governance/proof/evidence/live/:ledgerId/milestone/:idx (or /evidence/)
//   5. Client flow (for milestones with status === 'PROOF_SUBMITTED'):
//        - Display verification badges (CRYPTOGRAPHIC_PROOF, GPS_ONLY, etc.) & distance from site.
//        - Action A: Approve & Release Online Escrow -> POST /api/governance/approve/:ledgerId/milestone/:idx
//        - Action B: Record Offline Payment (bKash/Nagad/Cash/Bank) ->
//                    GET /api/settlement/receipt/presigned-url -> uploadPresigned ->
//                    POST /api/settlement/milestone/:milestoneId/submit-payment
//        - Action C: Dispute Milestone -> POST /api/governance/dispute/:ledgerId/milestone/:idx (reason >= 10 chars)
//   6. Contractor confirmation flow:
//        - For milestones with status === 'PAID_OFFLINE':
//          POST /api/settlement/milestone/:milestoneId/confirm-receipt
//
// Security & Invariants:
//   - Network calls exclusively via get, post, uploadPresigned from ../api.js (zero raw window.fetch).
//   - Strict DOM APIs only (createElement, textContent, append, replaceChildren) — zero innerHTML.
//   - Never declare a local 'location' variable.
//   - Idempotency key via newIdempotencyKey() on all mutations.
//   - 100% i18n parity via data-i18n and t().

import { initShell } from '../shell.js';
import { get, post, uploadPresigned, ApiError, newIdempotencyKey } from '../api.js';
import { t, applyLang, formatTaka, formatRelativeTime } from '../i18n.js';
import { requireAuth } from '../session.js';
import { openDialog, closeDialog } from '../dialog.js';

const $ = (id) => document.getElementById(id);

let currentUser = null;
let currentProject = null;
let currentLedger = null;
let activeModalMilestone = null;
let isSubmitting = false;

// ── Alert Helpers ────────────────────────────────────────────────────────────
function showAlert(kind, text) {
  const box = $('alert');
  box.replaceChildren();
  if (!text) {
    box.hidden = true;
    return;
  }
  const div = document.createElement('div');
  div.className = kind === 'error' ? 'alert-error' : kind === 'info' ? 'alert-info' : 'alert-success';
  const ic = document.createElement('span');
  ic.className = 'icon text-[20px]';
  ic.setAttribute('aria-hidden', 'true');
  ic.textContent = kind === 'error' ? 'error' : kind === 'info' ? 'info' : 'check_circle';
  const msg = document.createElement('span');
  msg.textContent = text;
  div.append(ic, msg);
  box.append(div);
  box.hidden = false;
}

function parseProjectId() {
  const params = new URLSearchParams(window.location.search);
  return params.get('id') || params.get('project');
}

// ── Cryptographic & Geolocation Helpers ──────────────────────────────────────
async function computeSha256Hex(file) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function getLiveGeolocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      }),
      () => resolve(null),
      { timeout: 7000, enableHighAccuracy: true }
    );
  });
}

function createStatusBadge(statusText, kind) {
  const badge = document.createElement('span');
  let colorClasses = 'bg-surface-container text-on-surface-variant';

  if (kind === 'IN_PROGRESS') {
    colorClasses = 'bg-primary-fixed text-on-primary-fixed font-semibold';
  } else if (kind === 'PROOF_SUBMITTED') {
    colorClasses = 'bg-cta-amber/20 text-on-surface border border-cta-amber font-semibold';
  } else if (kind === 'CLIENT_APPROVED' || kind === 'COMPLETED') {
    colorClasses = 'bg-success/15 text-on-surface border border-success/40 font-semibold';
  } else if (kind === 'PAID_OFFLINE') {
    colorClasses = 'bg-primary-container/20 text-primary-container font-semibold';
  } else if (kind === 'DISPUTED') {
    colorClasses = 'bg-error-container text-on-error-container font-semibold';
  }

  badge.className = `inline-flex items-center rounded-md px-sm py-xs text-body-sm ${colorClasses}`;
  badge.textContent = statusText;
  return badge;
}

function renderVerificationBadge(tier) {
  const badge = document.createElement('span');
  let colorClasses = 'bg-surface-container text-on-surface-variant';
  let iconName = 'info';

  if (tier === 'CRYPTOGRAPHIC_PROOF') {
    colorClasses = 'bg-success/15 text-on-surface border border-success/40';
    iconName = 'verified_user';
  } else if (tier === 'GPS_ONLY') {
    colorClasses = 'bg-primary-fixed text-on-primary-fixed';
    iconName = 'place';
  } else if (tier === 'TIME_ONLY') {
    colorClasses = 'bg-surface-container-high text-on-surface';
    iconName = 'schedule';
  } else if (tier === 'REQUIRES_CLIENT_AUDIT') {
    colorClasses = 'bg-cta-amber/20 text-on-surface border border-cta-amber/50';
    iconName = 'warning';
  }

  badge.className = `inline-flex items-center gap-xs rounded-md px-sm py-xs text-body-sm font-semibold ${colorClasses}`;
  const ic = document.createElement('span');
  ic.className = 'icon text-[18px]';
  ic.setAttribute('aria-hidden', 'true');
  ic.textContent = iconName;
  const label = document.createElement('span');
  label.textContent = t(`contract.tier.${tier}`) || tier;
  badge.append(ic, label);
  return badge;
}

// ── Overview Rendering ───────────────────────────────────────────────────────
function renderOverview() {
  const ledger = currentLedger;
  if (!ledger) return;

  const statusKey = `detail.escrow.${ledger.ledgerStatus}`;
  const statusBadge = $('ledger-status');
  statusBadge.textContent = t(statusKey) || ledger.ledgerStatus;
  statusBadge.className = `inline-flex items-center rounded-md px-sm py-xs text-body-sm font-semibold ${
    ledger.ledgerStatus === 'FUNDED' ? 'bg-success/15 text-on-surface border border-success/40'
    : ledger.ledgerStatus === 'PARTIALLY_DISBURSED' ? 'bg-primary-container/20 text-primary-container'
    : ledger.ledgerStatus === 'IN_ARBITRATION' ? 'bg-error-container text-on-error-container'
    : 'bg-surface-container text-on-surface-variant'
  }`;

  $('contract-total-value').textContent = formatTaka(ledger.totalContractValue || 0);
  $('contract-client-info').textContent = ledger.clientId ? String(ledger.clientId).slice(-6) : 'Client';
  $('contract-contractor-info').textContent = ledger.contractorId ? String(ledger.contractorId).slice(-6) : 'Contractor';

  if (currentProject) {
    $('project-title').textContent = currentProject.title || '';
  }

  const backBtn = $('back-link');
  const projectId = parseProjectId();
  backBtn.href = `/app/project-detail.html?id=${encodeURIComponent(projectId)}`;
}

// ── Milestones Rendering ─────────────────────────────────────────────────────
function renderMilestones() {
  const container = $('milestones-list');
  container.replaceChildren();

  const ledger = currentLedger;
  if (!ledger || !Array.isArray(ledger.milestones)) return;

  const isClient = currentUser.role === 'CLIENT' || String(ledger.clientId) === currentUser.userId;
  const isContractor = currentUser.role === 'CONTRACTOR' || String(ledger.contractorId) === currentUser.userId;

  ledger.milestones.forEach((milestone, idx) => {
    const card = document.createElement('div');
    card.className = 'card p-lg sm:p-xl space-y-md border border-border-subtle';

    // Header: Title, release percentage, amount, status
    const header = document.createElement('div');
    header.className = 'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-sm border-b border-border-subtle pb-md';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'space-y-xs';
    const tag = document.createElement('span');
    tag.className = 'text-label-caps uppercase text-on-surface-variant';
    tag.textContent = t('contract.milestoneNum', { num: idx + 1 });
    const name = document.createElement('h3');
    name.className = 'text-h2 font-bold text-on-surface';
    name.textContent = milestone.title || `${t('detail.breakdownItem')} ${idx + 1}`;
    titleGroup.append(tag, name);

    const metaGroup = document.createElement('div');
    metaGroup.className = 'flex items-center gap-md';
    const amt = document.createElement('span');
    amt.className = 'text-h2 font-bold text-primary';
    amt.textContent = formatTaka(milestone.amount || 0);

    const statusKey = `contract.milestoneStatus.${milestone.status}`;
    const badge = createStatusBadge(t(statusKey) || milestone.status, milestone.status);
    metaGroup.append(amt, badge);

    header.append(titleGroup, metaGroup);
    card.append(header);

    // Evidence Section
    const evidenceSection = document.createElement('div');
    evidenceSection.className = 'space-y-sm';

    const evidenceHeading = document.createElement('h4');
    evidenceHeading.className = 'text-label-caps uppercase text-on-surface-variant';
    evidenceHeading.textContent = t('contract.proof.title');
    evidenceSection.append(evidenceHeading);

    if (Array.isArray(milestone.evidenceLog) && milestone.evidenceLog.length > 0) {
      const evidenceList = document.createElement('div');
      evidenceList.className = 'space-y-sm';

      milestone.evidenceLog.forEach((ev) => {
        const evItem = document.createElement('div');
        evItem.className = 'bg-surface-container-low p-md rounded-lg flex flex-col sm:flex-row sm:items-center justify-between gap-sm text-body-sm border border-border-subtle';

        const tierBadge = renderVerificationBadge(ev.verificationTier);

        const details = document.createElement('div');
        details.className = 'flex items-center gap-sm flex-wrap text-on-surface-variant';

        if (ev.distanceMeters !== null && ev.distanceMeters !== undefined) {
          const distSpan = document.createElement('span');
          distSpan.className = 'inline-flex items-center gap-xs font-medium';
          const distIcon = document.createElement('span');
          distIcon.className = 'icon text-[18px] text-primary';
          distIcon.setAttribute('aria-hidden', 'true');
          distIcon.textContent = 'place';
          const distText = document.createElement('span');
          distText.textContent = t('contract.proof.distance', { meters: Math.round(ev.distanceMeters) });
          distSpan.append(distIcon, distText);
          details.append(distSpan);
        }

        const dateSpan = document.createElement('span');
        dateSpan.textContent = formatRelativeTime(ev.submittedAt);
        details.append(dateSpan);

        evItem.append(tierBadge, details);
        evidenceList.append(evItem);
      });

      evidenceSection.append(evidenceList);
    } else {
      const noEv = document.createElement('p');
      noEv.className = 'text-body-sm text-on-surface-variant';
      noEv.textContent = t('contract.proof.empty');
      evidenceSection.append(noEv);
    }

    card.append(evidenceSection);

    // Dispute reason notice if DISPUTED
    if (milestone.status === 'DISPUTED' && milestone.disputeReason) {
      const disputeNotice = document.createElement('div');
      disputeNotice.className = 'alert alert-error';
      const warnIcon = document.createElement('span');
      warnIcon.className = 'icon text-[20px]';
      warnIcon.setAttribute('aria-hidden', 'true');
      warnIcon.textContent = 'warning';
      const disputeText = document.createElement('span');
      disputeText.textContent = `${t('contract.action.dispute')}: ${milestone.disputeReason}`;
      disputeNotice.append(warnIcon, disputeText);
      card.append(disputeNotice);
    }

    // Contractor Actions: Upload Proof of Work (when IN_PROGRESS)
    if (isContractor && milestone.status === 'IN_PROGRESS') {
      const uploadArea = document.createElement('div');
      uploadArea.className = 'pt-md border-t border-border-subtle space-y-sm';

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/jpeg,image/png,image/webp';
      fileInput.className = 'hidden';

      const uploadBtn = document.createElement('button');
      uploadBtn.type = 'button';
      uploadBtn.className = 'btn-primary min-h-[44px]';
      const camIcon = document.createElement('span');
      camIcon.className = 'icon';
      camIcon.setAttribute('aria-hidden', 'true');
      camIcon.textContent = 'photo_camera';
      const uploadBtnText = document.createElement('span');
      uploadBtnText.textContent = t('contract.proof.uploadCta');
      uploadBtn.append(camIcon, uploadBtnText);

      const statusMsg = document.createElement('p');
      statusMsg.className = 'text-body-sm text-primary font-medium';
      statusMsg.hidden = true;

      uploadBtn.addEventListener('click', () => fileInput.click());

      fileInput.addEventListener('change', async () => {
        if (!fileInput.files || fileInput.files.length === 0) return;
        const file = fileInput.files[0];
        await handleContractorProofUpload(idx, file, uploadBtn, statusMsg);
      });

      uploadArea.append(fileInput, uploadBtn, statusMsg);
      card.append(uploadArea);
    }

    // Client Actions: Approve, Record Offline Payment, Dispute (when PROOF_SUBMITTED)
    if (isClient && milestone.status === 'PROOF_SUBMITTED') {
      const clientActions = document.createElement('div');
      clientActions.className = 'pt-md border-t border-border-subtle flex flex-wrap gap-sm';

      // 1. Approve & Release Escrow
      const approveBtn = document.createElement('button');
      approveBtn.type = 'button';
      approveBtn.className = 'btn-primary min-h-[44px]';
      const checkIcon = document.createElement('span');
      checkIcon.className = 'icon';
      checkIcon.setAttribute('aria-hidden', 'true');
      checkIcon.textContent = 'check_circle';
      const approveText = document.createElement('span');
      approveText.textContent = t('contract.action.approve');
      approveBtn.append(checkIcon, approveText);
      approveBtn.addEventListener('click', () => handleClientApprove(idx, approveBtn));

      // 2. Record Offline Payment
      const offlineBtn = document.createElement('button');
      offlineBtn.type = 'button';
      offlineBtn.className = 'btn-outline min-h-[44px]';
      const walletIcon = document.createElement('span');
      walletIcon.className = 'icon text-primary';
      walletIcon.setAttribute('aria-hidden', 'true');
      walletIcon.textContent = 'account_balance_wallet';
      const offlineText = document.createElement('span');
      offlineText.textContent = t('contract.action.recordPayment');
      offlineBtn.append(walletIcon, offlineText);
      offlineBtn.addEventListener('click', (e) => openPaymentModal(milestone, idx, e.currentTarget));

      // 3. Dispute Milestone
      const disputeBtn = document.createElement('button');
      disputeBtn.type = 'button';
      disputeBtn.className = 'btn-outline text-error border-error hover:bg-error-container min-h-[44px]';
      const warnIcon = document.createElement('span');
      warnIcon.className = 'icon';
      warnIcon.setAttribute('aria-hidden', 'true');
      warnIcon.textContent = 'warning';
      const disputeText = document.createElement('span');
      disputeText.textContent = t('contract.action.dispute');
      disputeBtn.append(warnIcon, disputeText);
      disputeBtn.addEventListener('click', (e) => openDisputeModal(idx, e.currentTarget));

      // An escrow funded online (SSLCommerz) already holds this milestone's
      // money — offering an offline payment too would make the client pay twice.
      if (currentLedger.paidByValId) {
        clientActions.append(approveBtn, disputeBtn);
      } else {
        clientActions.append(approveBtn, offlineBtn, disputeBtn);
      }
      card.append(clientActions);
    }

    // Contractor Confirmation: Confirm Payment Received (when PAID_OFFLINE)
    if (
      isContractor &&
      milestone.status === 'PAID_OFFLINE'
    ) {
      const confirmArea = document.createElement('div');
      confirmArea.className = 'pt-md border-t border-border-subtle flex flex-wrap gap-sm';

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'btn-primary min-h-[44px]';
      const checkIcon = document.createElement('span');
      checkIcon.className = 'icon';
      checkIcon.setAttribute('aria-hidden', 'true');
      checkIcon.textContent = 'check_circle';
      const confirmText = document.createElement('span');
      confirmText.textContent = t('contract.action.confirmReceipt');
      confirmBtn.append(checkIcon, confirmText);

      confirmBtn.addEventListener('click', () => handleContractorConfirmReceipt(milestone._id, confirmBtn));
      confirmArea.append(confirmBtn);
      card.append(confirmArea);
    }

    container.append(card);
  });
}

// ── Contractor Proof Upload Handler ──────────────────────────────────────────
async function handleContractorProofUpload(milestoneIndex, file, btnElement, statusElem) {
  if (isSubmitting) return;
  isSubmitting = true;

  btnElement.disabled = true;
  statusElem.hidden = false;

  try {
    // 1. Compute SHA-256 subtle crypto digest
    statusElem.textContent = t('contract.proof.hashing');
    const imageHash = await computeSha256Hex(file);

    // 2. Read live geolocation
    statusElem.textContent = t('contract.proof.locating');
    const coords = await getLiveGeolocation();

    // 3. Request pre-signed upload URL
    statusElem.textContent = t('contract.proof.uploading');
    const presignedRes = await get(
      `/governance/proof/presigned-url?ledgerId=${currentLedger._id}&milestoneIndex=${milestoneIndex}&contentType=${encodeURIComponent(file.type)}`
    );

    const { uploadUrl, uploadMethod, uploadHeaders, uploadFields, s3KeyToken } = presignedRes.data;

    // 4. Zero-RAM direct-to-storage upload
    await uploadPresigned(uploadUrl, {
      method: uploadMethod,
      headers: uploadHeaders,
      fields: uploadFields,
      file
    });

    // 5. Commit evidence confirmation
    statusElem.textContent = t('contract.proof.submitting');

    const hasSiteCoords = Boolean(
      currentProject?.hasSiteCoordinates ||
      (currentProject?.siteCoordinates && currentProject.siteCoordinates.latitude != null)
    );

    if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng) && hasSiteCoords) {
      await post(
        `/governance/proof/evidence/live/${currentLedger._id}/milestone/${milestoneIndex}`,
        {
          s3KeyToken,
          imageHash,
          lat: coords.lat,
          lng: coords.lng,
          accuracy: coords.accuracy
        },
        { idempotencyKey: newIdempotencyKey() }
      );
    } else {
      await post(
        `/governance/proof/evidence/${currentLedger._id}/milestone/${milestoneIndex}`,
        {
          s3KeyToken,
          imageHash,
          gpsData: coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng) ? {
            latitude: coords.lat,
            longitude: coords.lng,
            accuracy: coords.accuracy
          } : null
        },
        { idempotencyKey: newIdempotencyKey() }
      );
    }

    showAlert('success', t('contract.proof.success'));
    await refreshContractData();
  } catch (err) {
    console.error('Proof upload failed:', err);
    showAlert('error', err.message || t('err.generic'));
  } finally {
    isSubmitting = false;
    btnElement.disabled = false;
    statusElem.hidden = true;
  }
}

// ── Client Actions Handlers ──────────────────────────────────────────────────
async function handleClientApprove(milestoneIndex, btnElement) {
  if (isSubmitting) return;
  isSubmitting = true;

  const originalText = btnElement.textContent;
  btnElement.disabled = true;
  btnElement.textContent = t('contract.action.approving');

  try {
    await post(
      `/governance/approve/${currentLedger._id}/milestone/${milestoneIndex}`,
      {},
      { idempotencyKey: newIdempotencyKey() }
    );

    showAlert('success', t('contract.action.approveSuccess'));
    await refreshContractData();
  } catch (err) {
    console.error('Approval failed:', err);
    showAlert('error', err.message || t('err.generic'));
    btnElement.disabled = false;
    btnElement.textContent = originalText;
  } finally {
    isSubmitting = false;
  }
}

// ── Offline Payment Modal Handlers ───────────────────────────────────────────
function openPaymentModal(milestone, milestoneIndex, opener) {
  activeModalMilestone = { ...milestone, index: milestoneIndex };
  $('payment-modal-amount').textContent = formatTaka(milestone.amount || 0);

  const modal = $('payment-modal');
  openDialog(modal, opener);

  $('payment-form').reset();
  $('payment-trx-id-error').hidden = true;
  $('payment-receipt-error').hidden = true;
}

function closePaymentModal() {
  const modal = $('payment-modal');
  closeDialog(modal);
  activeModalMilestone = null;
}

async function handleOfflinePaymentSubmit(e) {
  e.preventDefault();
  if (isSubmitting || !activeModalMilestone) return;

  const method = $('payment-method').value;
  const trxId = $('payment-trx-id').value.trim();
  const fileInput = $('payment-receipt-file');

  if (['BKASH', 'NAGAD', 'BANK'].includes(method) && !trxId) {
    const err = $('payment-trx-id-error');
    err.textContent = t('contract.err.trxIdRequired');
    err.hidden = false;
    return;
  }

  if (!fileInput.files || fileInput.files.length === 0) {
    const err = $('payment-receipt-error');
    err.textContent = t('contract.err.receiptRequired');
    err.hidden = false;
    return;
  }

  isSubmitting = true;
  const btn = $('btn-submit-payment');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('contract.paymentModal.submitting');

  try {
    const file = fileInput.files[0];
    const receiptSha = await computeSha256Hex(file);

    // 1. Get presigned policy for receipt
    const presignedRes = await get(
      `/settlement/receipt/presigned-url?ledgerId=${currentLedger._id}&milestoneIndex=${activeModalMilestone.index}&contentType=${encodeURIComponent(file.type)}`
    );

    const { uploadUrl, uploadMethod, uploadHeaders, uploadFields, s3KeyToken } = presignedRes.data;

    // 2. Direct upload to storage
    await uploadPresigned(uploadUrl, {
      method: uploadMethod,
      headers: uploadHeaders,
      fields: uploadFields,
      file
    });

    // 3. Submit offline payment record
    await post(
      `/settlement/milestone/${activeModalMilestone._id}/submit-payment`,
      {
        paymentMethod: method,
        trxId,
        amountBDT: activeModalMilestone.amount,
        s3KeyToken,
        s3ReceiptHash: receiptSha
      },
      { idempotencyKey: newIdempotencyKey() }
    );

    closePaymentModal();
    showAlert('success', t('contract.paymentModal.success'));
    await refreshContractData();
  } catch (err) {
    console.error('Offline payment submit failed:', err);
    showAlert('error', err.message || t('err.generic'));
  } finally {
    isSubmitting = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ── Dispute Modal Handlers ───────────────────────────────────────────────────
function openDisputeModal(milestoneIndex, opener) {
  activeModalMilestone = { index: milestoneIndex };
  const modal = $('dispute-modal');
  openDialog(modal, opener);

  $('dispute-form').reset();
  $('dispute-reason-error').hidden = true;
}

function closeDisputeModal() {
  const modal = $('dispute-modal');
  closeDialog(modal);
  activeModalMilestone = null;
}

async function handleDisputeSubmit(e) {
  e.preventDefault();
  if (isSubmitting || !activeModalMilestone) return;

  const reason = $('dispute-reason').value.trim();
  if (reason.length < 10) {
    const err = $('dispute-reason-error');
    err.textContent = t('contract.err.reasonShort');
    err.hidden = false;
    return;
  }

  isSubmitting = true;
  const btn = $('btn-submit-dispute');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('contract.action.disputing');

  try {
    await post(
      `/governance/dispute/${currentLedger._id}/milestone/${activeModalMilestone.index}`,
      { reason },
      { idempotencyKey: newIdempotencyKey() }
    );

    closeDisputeModal();
    showAlert('success', t('contract.action.disputeSuccess'));
    await refreshContractData();
  } catch (err) {
    console.error('Dispute failed:', err);
    showAlert('error', err.message || t('err.generic'));
  } finally {
    isSubmitting = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ── Contractor Receipt Confirmation ──────────────────────────────────────────
async function handleContractorConfirmReceipt(milestoneId, btnElement) {
  if (isSubmitting) return;
  isSubmitting = true;

  const originalText = btnElement.textContent;
  btnElement.disabled = true;
  btnElement.textContent = t('contract.action.confirming');

  try {
    await post(
      `/settlement/milestone/${milestoneId}/confirm-receipt`,
      {},
      { idempotencyKey: newIdempotencyKey() }
    );

    showAlert('success', t('contract.action.confirmSuccess'));
    await refreshContractData();
  } catch (err) {
    console.error('Confirm receipt failed:', err);
    showAlert('error', err.message || t('err.generic'));
    btnElement.disabled = false;
    btnElement.textContent = originalText;
  } finally {
    isSubmitting = false;
  }
}

// ── Refresh & Orchestration ──────────────────────────────────────────────────
async function refreshContractData() {
  const projectId = parseProjectId();
  if (!projectId) return;

  const ledgerRes = await get(`/governance/escrow/${encodeURIComponent(projectId)}`);
  currentLedger = ledgerRes.data;

  try {
    const projectRes = await get(`/projects/${encodeURIComponent(projectId)}`);
    currentProject = projectRes.project;
  } catch (_) {
    currentProject = null;
  }

  renderOverview();
  renderMilestones();
}

// ── Page Initialization ──────────────────────────────────────────────────────
async function init() {
  await initShell();
  currentUser = await requireAuth();

  const projectId = parseProjectId();
  if (!projectId) {
    $('loading').hidden = true;
    $('not-found').hidden = false;
    return;
  }

  try {
    await refreshContractData();
    $('loading').hidden = true;
    $('contract-view').hidden = false;
  } catch (err) {
    console.error('Failed to load contract governance workspace:', err);
    $('loading').hidden = true;
    if (err instanceof ApiError && err.status === 404) {
      $('not-found').hidden = false;
    } else {
      showAlert('error', err.message || t('err.generic'));
    }
  }

  // Wire Modal handlers
  $('btn-close-payment-modal').addEventListener('click', closePaymentModal);
  $('btn-cancel-payment').addEventListener('click', closePaymentModal);
  $('payment-form').addEventListener('submit', handleOfflinePaymentSubmit);

  $('btn-close-dispute-modal').addEventListener('click', closeDisputeModal);
  $('btn-cancel-dispute').addEventListener('click', closeDisputeModal);
  $('dispute-form').addEventListener('submit', handleDisputeSubmit);

  // Re-render on language toggle
  window.addEventListener('langchange', () => {
    applyLang();
    renderOverview();
    renderMilestones();
  });
}

document.addEventListener('DOMContentLoaded', init);
