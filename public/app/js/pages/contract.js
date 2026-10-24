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

import { initShell, clearFormDraft } from '../shell.js';
import { get, post, uploadPresigned, ApiError, newIdempotencyKey } from '../api.js';
import { t, getLang, applyLang, formatTaka, formatRelativeTime } from '../i18n.js';
import { requireAuth } from '../session.js';
import { openDialog, closeDialog } from '../dialog.js';

const $ = (id) => document.getElementById(id);

let currentUser = null;
let currentProject = null;
let currentLedger = null;
let activeModalMilestone = null;
let isSubmitting = false;
let currentAwardedBidId = null;
let selectedStarRating = 0;
let hasSubmittedReview = false;

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

function el(tag, className = '', textOrChildren = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textOrChildren !== null && textOrChildren !== undefined) {
    if (Array.isArray(textOrChildren)) {
      for (const child of textOrChildren) {
        if (typeof child === 'string') node.appendChild(document.createTextNode(child));
        else if (child instanceof Node) node.appendChild(child);
      }
    } else if (typeof textOrChildren === 'string' || typeof textOrChildren === 'number') {
      node.textContent = String(textOrChildren);
    } else if (textOrChildren instanceof Node) {
      node.appendChild(textOrChildren);
    }
  }
  return node;
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
    colorClasses = 'bg-surface-variant text-on-surface border border-outline-variant';
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

  // Post-Settlement Review Prompt (CLIENT only, Proof-of-Work Gate)
  const reviewCtaCard = $('review-cta-card');
  if (reviewCtaCard) {
    const isClient = currentUser && (currentUser.role === 'CLIENT' || String(ledger.clientId) === String(currentUser.id));
    const hasApprovedMilestone = ledger.ledgerStatus === 'FULLY_DISBURSED' ||
      (ledger.milestones || []).some((m) => ['CLIENT_APPROVED', 'RELEASED', 'PAID_OFFLINE', 'COMPLETED'].includes(m.status));

    if (isClient && hasApprovedMilestone) {
      reviewCtaCard.hidden = false;
      const btnOpen = $('btn-open-review-modal');
      const subtitle = reviewCtaCard.querySelector('p');
      if (hasSubmittedReview) {
        if (btnOpen) btnOpen.hidden = true;
        if (subtitle) subtitle.textContent = t('contract.review.alreadyReviewed');
      } else {
        if (btnOpen) btnOpen.hidden = false;
        if (subtitle) subtitle.textContent = t('contract.review.ctaSubtitle');
      }
    } else {
      reviewCtaCard.hidden = true;
    }
  }
}

// ── Milestones Rendering ─────────────────────────────────────────────────────
function renderMilestones() {
  const container = $('milestones-list');
  container.replaceChildren();

  const ledger = currentLedger;
  if (!ledger || !Array.isArray(ledger.milestones)) return;

  const isClient = currentUser.role === 'CLIENT' || String(ledger.clientId) === String(currentUser.id || currentUser.userId);
  const isContractor = currentUser.role === 'CONTRACTOR' || String(ledger.contractorId) === String(currentUser.id || currentUser.userId);

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

      milestone.evidenceLog.forEach((ev, evIdx) => {
        const evItem = document.createElement('div');
        evItem.className = 'bg-surface-container-low p-md rounded-lg flex flex-col gap-sm text-body-sm border border-border-subtle';

        const topRow = document.createElement('div');
        topRow.className = 'flex flex-col sm:flex-row sm:items-center justify-between gap-sm';

        const tierBadge = renderVerificationBadge(ev.verificationTier);

        const details = document.createElement('div');
        details.className = 'flex items-center gap-sm flex-wrap text-on-surface-variant';

        if (ev.distanceMeters !== null && ev.distanceMeters !== undefined) {
          const distSpan = document.createElement('span');
          distSpan.className = 'inline-flex items-center gap-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200';
          const distIcon = document.createElement('span');
          distIcon.className = 'icon text-[18px] text-emerald-600';
          distIcon.setAttribute('aria-hidden', 'true');
          distIcon.textContent = 'place';
          const distText = document.createElement('span');
          distText.textContent = t('contract.proof.distance', { meters: Math.round(ev.distanceMeters) });
          distSpan.append(distIcon, distText);
          details.append(distSpan);
        } else {
          const noGpsSpan = document.createElement('span');
          noGpsSpan.className = 'inline-flex items-center gap-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded border border-amber-200 text-xs font-medium';
          noGpsSpan.textContent = '📡 জিপিএস তথ্য অনুপস্থিত (ম্যানুয়াল অডিট)';
          details.append(noGpsSpan);
        }

        const dateSpan = document.createElement('span');
        dateSpan.textContent = formatRelativeTime(ev.submittedAt);
        details.append(dateSpan);

        topRow.append(tierBadge, details);

        // Photo thumbnail & preview
        const photoContainer = document.createElement('div');
        photoContainer.className = 'mt-xs flex flex-col sm:flex-row items-start sm:items-center gap-md pt-sm border-t border-border-subtle';

        const imgUrl = `/api/governance/proof/view/${encodeURIComponent(currentLedger._id)}/milestone/${idx}/${evIdx}`;

        const img = document.createElement('img');
        img.src = imgUrl;
        img.alt = 'Site proof photo';
        img.className = 'w-32 h-24 object-cover rounded-lg border border-border-subtle shadow-sm cursor-pointer hover:opacity-90';
        img.loading = 'lazy';
        img.addEventListener('click', () => { window.open(imgUrl, '_blank'); });

        const hashInfo = document.createElement('div');
        hashInfo.className = 'text-xs text-on-surface-variant space-y-1 flex-1';

        const hashLabel = document.createElement('p');
        hashLabel.className = 'font-mono text-[11px] break-all';
        hashLabel.textContent = `SHA-256: ${ev.imageHash || 'N/A'}`;

        const viewLink = document.createElement('a');
        viewLink.href = imgUrl;
        viewLink.target = '_blank';
        viewLink.rel = 'noopener noreferrer';
        viewLink.className = 'btn-outline text-xs inline-flex items-center gap-xs py-1 px-3 min-h-[44px]';
        const eyeIcon = document.createElement('span');
        eyeIcon.className = 'icon text-[16px]';
        eyeIcon.setAttribute('aria-hidden', 'true');
        eyeIcon.textContent = 'visibility';
        const viewLinkText = document.createElement('span');
        viewLinkText.textContent = t('contract.proof.viewFull') !== 'contract.proof.viewFull'
          ? t('contract.proof.viewFull')
          : (getLang() === 'bn' ? 'পূর্ণ ছবি দেখুন' : 'View Full Photo');
        viewLink.append(eyeIcon, viewLinkText);

        hashInfo.append(hashLabel, viewLink);
        photoContainer.append(img, hashInfo);

        evItem.append(topRow, photoContainer);
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

    // Friendly restarted notice when returned to IN_PROGRESS after review/dispute
    if (milestone.status === 'IN_PROGRESS' && Array.isArray(milestone.evidenceLog) && milestone.evidenceLog.length > 0) {
      const restartNotice = document.createElement('div');
      restartNotice.className = 'alert-info flex items-center gap-xs p-md rounded-lg text-body-sm font-medium';
      const infoIcon = document.createElement('span');
      infoIcon.className = 'icon text-[20px]';
      infoIcon.setAttribute('aria-hidden', 'true');
      infoIcon.textContent = 'info';
      const restartText = document.createElement('span');
      restartText.textContent = t('contract.milestone.restarted');
      restartNotice.append(infoIcon, restartText);
      card.append(restartNotice);
    }

    // Contractor Actions: Upload Proof of Work (when IN_PROGRESS)
    if (isContractor && milestone.status === 'IN_PROGRESS') {
      const uploadArea = document.createElement('div');
      uploadArea.className = 'pt-md border-t border-border-subtle space-y-sm';

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/jpeg,image/png,image/webp';
      fileInput.capture = 'environment';
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
      if (currentLedger.fundedOnline) {
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
    clearFormDraft($('dispute-form'));
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

// ── Contractor Review Modal Handlers (Launch Blocker L5.1) ───────────────────
function setStarRating(star) {
  selectedStarRating = star;
  const buttons = document.querySelectorAll('#review-rating-group .star-btn');
  buttons.forEach((btn) => {
    const btnStar = parseInt(btn.dataset.star, 10);
    const isFilled = btnStar <= star;
    btn.setAttribute('aria-checked', isFilled ? 'true' : 'false');
    if (isFilled) {
      btn.classList.add('text-secondary');
      btn.classList.remove('text-on-surface-variant');
    } else {
      btn.classList.remove('text-secondary');
      btn.classList.add('text-on-surface-variant');
    }
  });
  const err = $('review-rating-error');
  if (err) err.hidden = true;
}

function openReviewModal(opener) {
  const modal = $('review-modal');
  openDialog(modal, opener);
  $('review-form').reset();
  setStarRating(0);
  const rErr = $('review-rating-error');
  if (rErr) rErr.hidden = true;
  const cErr = $('review-comment-error');
  if (cErr) cErr.hidden = true;
}

function closeReviewModal() {
  const modal = $('review-modal');
  closeDialog(modal);
}

async function handleReviewSubmit(e) {
  e.preventDefault();
  if (isSubmitting) return;

  if (selectedStarRating < 1 || selectedStarRating > 5) {
    const err = $('review-rating-error');
    err.textContent = t('contract.review.errRating');
    err.hidden = false;
    return;
  }

  const commentInput = $('review-comment');
  const comment = (commentInput ? commentInput.value : '').trim();
  if (comment.length < 10) {
    const err = $('review-comment-error');
    err.textContent = t('contract.review.errComment');
    err.hidden = false;
    return;
  }

  const projectId = parseProjectId();
  if (!projectId || !currentAwardedBidId) {
    showAlert('error', t('err.generic'));
    return;
  }

  const qualitySelect = $('review-quality');
  const timelineSelect = $('review-timeline');
  const commSelect = $('review-communication');
  const quality = qualitySelect ? parseInt(qualitySelect.value, 10) || 4 : 4;
  const timeline = timelineSelect ? parseInt(timelineSelect.value, 10) || 4 : 4;
  const communication = commSelect ? parseInt(commSelect.value, 10) || 4 : 4;

  isSubmitting = true;
  const btn = $('btn-submit-review');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('contract.review.submitting');

  try {
    await post(
      '/reviews',
      {
        projectId,
        bidId: currentAwardedBidId,
        rating: selectedStarRating,
        metrics: { quality, timeline, communication },
        comment
      },
      { idempotencyKey: newIdempotencyKey() }
    );

    hasSubmittedReview = true;
    closeReviewModal();
    clearFormDraft($('review-form'));
    showAlert('success', t('contract.review.success'));
    await refreshContractData();
  } catch (err) {
    console.error('Review submit failed:', err);
    if (err instanceof ApiError && err.status === 409) {
      hasSubmittedReview = true;
      closeReviewModal();
      showAlert('info', t('contract.review.alreadyReviewed'));
      await refreshContractData();
    } else {
      showAlert('error', err.message || t('err.generic'));
    }
  } finally {
    isSubmitting = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ── Materials Transparency Ledger (Work Package 1.4) ─────────────────────────
let materialsLedgerData = null;
let activeMaterialsFilter = 'all'; // 'all' or 'milestone'

async function loadMaterialsLedger(projectId) {
  try {
    const res = await get(`/materials/orders/project/${encodeURIComponent(projectId)}/ledger`);
    materialsLedgerData = res.data;
  } catch (err) {
    console.warn('Failed to load project materials ledger:', err.message);
    materialsLedgerData = null;
  }
}

function renderMaterialsLedger() {
  const container = $('materials-ledger-container');
  if (!container) return;
  container.replaceChildren();

  const projectId = parseProjectId();
  const browseBtn = $('btn-browse-materials');
  if (browseBtn && projectId) {
    browseBtn.href = `/app/materials.html?projectId=${encodeURIComponent(projectId)}`;
  }

  if (!materialsLedgerData) {
    const emptyBox = el('div', 'p-lg text-center text-on-surface-variant border border-border-subtle rounded-xl bg-surface');
    emptyBox.textContent = t('contract.materials.empty');
    container.append(emptyBox);
    return;
  }

  const { summary, items } = materialsLedgerData;

  // Update summary numbers
  const totalSpendEl = $('materials-total-spend');
  if (totalSpendEl) totalSpendEl.textContent = formatTaka(summary.totalSpendBDT || 0);

  const deliveredSpendEl = $('materials-delivered-spend');
  if (deliveredSpendEl) deliveredSpendEl.textContent = formatTaka(summary.deliveredSpendBDT || 0);

  const activeOrdersEl = $('materials-active-orders');
  if (activeOrdersEl) activeOrdersEl.textContent = String(summary.ordersCount || 0);

  const variancesEl = $('materials-variances-count');
  if (variancesEl) variancesEl.textContent = String(summary.variancesCount || 0);

  // Tab button state
  const tabAll = $('tab-materials-all');
  const tabMilestone = $('tab-materials-milestone');
  if (tabAll && tabMilestone) {
    tabAll.className = activeMaterialsFilter === 'all'
      ? 'btn-primary min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap'
      : 'btn-outline min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap';
    tabAll.setAttribute('aria-selected', activeMaterialsFilter === 'all' ? 'true' : 'false');

    tabMilestone.className = activeMaterialsFilter === 'milestone'
      ? 'btn-primary min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap'
      : 'btn-outline min-h-[44px] px-md py-xs text-body-sm whitespace-nowrap';
    tabMilestone.setAttribute('aria-selected', activeMaterialsFilter === 'milestone' ? 'true' : 'false');
  }

  if (!items || items.length === 0) {
    const emptyCard = el('div', 'p-xl text-center space-y-md border border-dashed border-border-subtle rounded-2xl bg-surface');
    const ic = el('span', 'icon text-outline text-[44px]', 'inventory_2');
    ic.setAttribute('aria-hidden', 'true');
    const msg = el('p', 'text-body-md text-on-surface-variant', t('contract.materials.empty'));
    const cta = el('a', 'btn-primary min-h-[44px] px-md py-xs inline-flex items-center gap-xs mt-sm', [
      el('span', 'icon', 'shopping_cart'),
      el('span', '', t('contract.materials.browseCta'))
    ]);
    cta.href = `/app/materials.html?projectId=${encodeURIComponent(projectId)}`;
    emptyCard.append(ic, msg, cta);
    container.append(emptyCard);
    return;
  }

  // Filter items if by milestone
  let displayedItems = items;
  if (activeMaterialsFilter === 'milestone') {
    displayedItems = [...items].sort((a, b) => (a.milestoneIndex ?? 999) - (b.milestoneIndex ?? 999));
  }

  const isBn = getLang() === 'bn';

  for (const item of displayedItems) {
    const card = el('article', 'card p-md sm:p-lg space-y-md border border-border-subtle bg-surface');

    // Header row
    const headerRow = el('div', 'flex flex-col sm:flex-row sm:items-center justify-between gap-sm border-b border-border-subtle pb-sm');
    const leftHeader = el('div', 'space-y-xs');

    const titleRow = el('div', 'flex flex-wrap items-center gap-xs');
    const categoryIcon = el('span', 'icon text-primary text-[20px]',
      item.category === 'ROD' || item.category === 'ROD_REBAR' ? 'construction'
      : item.category === 'CEMENT' ? 'layers'
      : item.category === 'BRICK' ? 'view_module'
      : item.category === 'SAND' ? 'grain'
      : 'category'
    );
    categoryIcon.setAttribute('aria-hidden', 'true');

    const itemTitle = el('h3', 'text-h3 font-bold text-on-surface', item.boqLineItem);
    titleRow.append(categoryIcon, itemTitle);

    if (item.milestoneTitle) {
      const msBadge = el('span', 'inline-flex items-center px-xs py-[2px] rounded text-label-sm font-semibold bg-primary-fixed text-on-primary-fixed', item.milestoneTitle);
      titleRow.append(msBadge);
    }
    leftHeader.append(titleRow);

    // Planned specs line
    const plannedSpecs = [];
    if (item.plannedBrand) {
      plannedSpecs.push(isBn ? `পরিকল্পনা: ${item.plannedBrand}` : `Planned: ${item.plannedBrand}`);
    }
    if (item.plannedQuantity) {
      plannedSpecs.push(isBn ? `বরাদ্দ: ${item.plannedQuantity} ${item.unit}` : `Allocated: ${item.plannedQuantity} ${item.unit}`);
    }
    if (plannedSpecs.length > 0) {
      const planLine = el('p', 'text-body-sm text-on-surface-variant', plannedSpecs.join(' · '));
      leftHeader.append(planLine);
    }

    // Right header: Action to order more materials for this line/milestone
    const rightHeader = el('div', 'flex items-center gap-xs');
    const orderForMilestoneBtn = el('a', 'btn-outline min-h-[44px] px-sm py-xs text-body-sm inline-flex items-center gap-xs', [
      el('span', 'icon text-[18px]', 'add_shopping_cart'),
      el('span', '', t('contract.materials.orderForMilestone'))
    ]);
    const mIdxParam = item.milestoneIndex !== null ? `&milestoneIndex=${item.milestoneIndex}` : '';
    const boqParam = item.boqLineItem ? `&boqItem=${encodeURIComponent(item.boqLineItem)}` : '';
    const brandParam = item.plannedBrand ? `&plannedBrand=${encodeURIComponent(item.plannedBrand)}` : '';
    orderForMilestoneBtn.href = `/app/materials.html?projectId=${encodeURIComponent(projectId)}${mIdxParam}${boqParam}${brandParam}`;
    rightHeader.append(orderForMilestoneBtn);

    headerRow.append(leftHeader, rightHeader);
    card.append(headerRow);

    // Planned vs Delivered Progress Bar
    const progressBlock = el('div', 'space-y-xs');
    const progressTextRow = el('div', 'flex items-center justify-between text-body-sm');

    const deliveredQty = item.deliveredQuantity || 0;
    const plannedQty = item.plannedQuantity || item.orderedQuantity || deliveredQty;
    const percent = plannedQty > 0 ? Math.min(100, Math.round((deliveredQty / plannedQty) * 100)) : 100;

    const progressLabel = el('span', 'font-semibold text-on-surface',
      t('contract.materials.deliveredProgress', {
        delivered: deliveredQty,
        planned: plannedQty,
        unit: item.unit,
        percent
      })
    );
    const spendLabel = el('span', 'text-primary font-bold', formatTaka(item.totalSpendBDT || 0));
    progressTextRow.append(progressLabel, spendLabel);

    const barTrack = el('div', 'w-full bg-surface-container rounded-full h-3 overflow-hidden');
    const barFill = el('div', 'h-full bg-emerald-600 rounded-full transition-all duration-300');
    barFill.style.width = `${percent}%`;
    barTrack.append(barFill);

    progressBlock.append(progressTextRow, barTrack);
    card.append(progressBlock);

    // Summary statistics line
    const summaryRateLine = el('p', 'text-caption text-on-surface-variant',
      t('contract.materials.orderSummary', {
        count: item.orders.length,
        rate: formatTaka(Math.round((item.totalSpendBDT || 0) / (item.orderedQuantity || 1)))
      })
    );
    card.append(summaryRateLine);

    // Neutral Variance notice chips (amber, inform never accuse)
    if (Array.isArray(item.variances) && item.variances.length > 0) {
      const varianceList = el('div', 'space-y-xs');
      for (const v of item.variances) {
        const chip = el('div', 'flex items-center gap-xs px-sm py-xs rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-900 dark:text-amber-200 text-body-sm font-medium');
        const chipIcon = el('span', 'icon text-amber-600 text-[18px]', 'info');
        chipIcon.setAttribute('aria-hidden', 'true');
        const chipNotice = el('span', 'badge-category bg-amber-500/20 text-amber-900 dark:text-amber-200 text-[11px] font-bold uppercase tracking-wider', t('ledger.variance.attentionBadge'));
        const chipText = el('span', '', isBn ? v.messageBn : v.messageEn);
        chip.append(chipIcon, chipNotice, chipText);
        varianceList.append(chip);
      }
      card.append(varianceList);
    }

    // Delivered Orders & Verification Proofs
    const deliveredOrders = (item.orders || []).filter((o) => o.status === 'DELIVERED' || o.status === 'COMPLETED');
    if (deliveredOrders.length > 0) {
      const proofsBlock = el('div', 'space-y-xs pt-xs border-t border-border-subtle');
      const proofsHeading = el('h4', 'text-label-caps uppercase text-on-surface-variant text-[11px]', t('contract.materials.deliveryProof'));
      proofsBlock.append(proofsHeading);

      for (const order of deliveredOrders) {
        const proofCard = el('div', 'p-sm rounded-lg bg-surface-container-low border border-border-subtle flex flex-col sm:flex-row sm:items-center justify-between gap-md');

        const proofLeft = el('div', 'space-y-xs');
        const orderLine = el('div', 'flex flex-wrap items-center gap-xs');

        const orderNum = el('span', 'font-bold text-body-sm text-on-surface', order.orderNumber);
        orderLine.append(orderNum);

        if (order.challanNumber) {
          const challanPill = el('span', 'text-caption text-on-surface-variant', t('contract.materials.challanNo', { number: order.challanNumber }));
          orderLine.append(challanPill);
        }

        const supplierText = el('span', 'text-caption text-on-surface-variant', `· ${order.supplierName}`);
        orderLine.append(supplierText);
        proofLeft.append(orderLine);

        // Metadata badges (GPS, Time, BSTI)
        const metaBadges = el('div', 'flex flex-wrap items-center gap-xs');

        if (order.siteDeliveryPhotoGps) {
          const gpsBadge = el('span', 'inline-flex items-center gap-[2px] text-[11px] font-semibold text-emerald-800 dark:text-emerald-300 bg-emerald-500/10 px-xs py-[2px] rounded border border-emerald-500/20');
          const gpsIcon = el('span', 'icon text-[14px]', 'place');
          gpsIcon.setAttribute('aria-hidden', 'true');
          gpsBadge.append(gpsIcon, el('span', '', t('contract.materials.gpsVerified')));
          metaBadges.append(gpsBadge);
        } else if (order.siteDeliveryPhotoUrl) {
          const photoBadge = el('span', 'inline-flex items-center gap-[2px] text-[11px] font-semibold text-on-surface-variant bg-surface-container px-xs py-[2px] rounded');
          const camIcon = el('span', 'icon text-[14px]', 'photo_camera');
          camIcon.setAttribute('aria-hidden', 'true');
          photoBadge.append(camIcon, el('span', '', t('contract.materials.gpsMissing')));
          metaBadges.append(photoBadge);
        }

        if (order.bstiLicenseNumber) {
          const bstiLink = el('a', 'inline-flex items-center gap-[2px] text-[11px] font-semibold text-primary underline min-h-[44px]');
          bstiLink.href = 'http://bsti.portal.gov.bd/';
          bstiLink.target = '_blank';
          bstiLink.rel = 'noopener noreferrer';
          bstiLink.setAttribute('aria-label', `${t('contract.materials.bstiVerify')} (${order.bstiLicenseNumber})`);
          bstiLink.textContent = `${t('contract.materials.bstiVerify')} (${order.bstiLicenseNumber})`;
          metaBadges.append(bstiLink);
        }

        if (metaBadges.childNodes.length > 0) {
          proofLeft.append(metaBadges);
        }
        proofCard.append(proofLeft);

        // Right side: View order CTA
        const proofRight = el('div', 'flex items-center gap-xs');
        const viewOrderBtn = el('a', 'btn-outline min-h-[44px] px-sm py-xs text-body-sm font-semibold inline-flex items-center gap-xs', [
          el('span', 'icon text-[18px]', 'receipt_long'),
          el('span', '', t('contract.materials.viewOrders'))
        ]);
        viewOrderBtn.href = `/app/material-orders.html?id=${encodeURIComponent(order.orderId)}`;
        proofRight.append(viewOrderBtn);
        proofCard.append(proofRight);

        proofsBlock.append(proofCard);
      }
      card.append(proofsBlock);
    }

    container.append(card);
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

  // Load project materials ledger (WP 1.4)
  await loadMaterialsLedger(projectId);

  // Resolve awarded bid and review state for client
  if (currentUser && currentLedger && (currentUser.role === 'CLIENT' || String(currentLedger.clientId) === String(currentUser.id))) {
    try {
      const bidsRes = await get(`/bids/project/${encodeURIComponent(projectId)}`);
      const acceptedBid = (bidsRes.bids || []).find((b) => b.status === 'ACCEPTED' || String(b.contractorId?._id || b.contractorId) === String(currentLedger.contractorId));
      if (acceptedBid) {
        currentAwardedBidId = acceptedBid._id;
      }
    } catch (_) {
      // Graceful fallback
    }

    if (currentLedger.contractorId) {
      try {
        const revRes = await get(`/reviews/contractor/${encodeURIComponent(currentLedger.contractorId)}`);
        const existing = (revRes.data?.reviews || []).find((r) => String(r.projectId) === String(projectId));
        if (existing) {
          hasSubmittedReview = true;
        }
      } catch (_) {
        // Graceful fallback
      }
    }
  }

  renderOverview();
  renderMilestones();
  renderMaterialsLedger();
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

  // Wire Review Modal handlers (Launch Blocker L5.1)
  const btnOpenReview = $('btn-open-review-modal');
  if (btnOpenReview) {
    btnOpenReview.addEventListener('click', (e) => openReviewModal(e.currentTarget));
  }
  const btnCloseReview = $('btn-close-review-modal');
  if (btnCloseReview) {
    btnCloseReview.addEventListener('click', closeReviewModal);
  }
  const btnCancelReview = $('btn-cancel-review');
  if (btnCancelReview) {
    btnCancelReview.addEventListener('click', closeReviewModal);
  }
  const reviewForm = $('review-form');
  if (reviewForm) {
    reviewForm.addEventListener('submit', handleReviewSubmit);
  }
  const starBtns = document.querySelectorAll('#review-rating-group .star-btn');
  starBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const star = parseInt(btn.dataset.star, 10);
      setStarRating(star);
    });
  });

  // Wire Materials Ledger Tab Filter handlers (WP 1.4)
  const tabAll = $('tab-materials-all');
  if (tabAll) {
    tabAll.addEventListener('click', () => {
      activeMaterialsFilter = 'all';
      renderMaterialsLedger();
    });
  }
  const tabMilestone = $('tab-materials-milestone');
  if (tabMilestone) {
    tabMilestone.addEventListener('click', () => {
      activeMaterialsFilter = 'milestone';
      renderMaterialsLedger();
    });
  }

  // Re-render on language toggle
  window.addEventListener('langchange', () => {
    applyLang();
    renderOverview();
    renderMilestones();
    renderMaterialsLedger();
  });
}

document.addEventListener('DOMContentLoaded', init);
