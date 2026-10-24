// F7 — Project Detail, Bid Review, Acceptance & Escrow Funding.
// Dual-role page for CLIENT (owner) and CONTRACTOR.
//
// Data flow:
//   1. requireAuth() before paint.
//   2. Read project ID from URL query ?id=<id> or ?project=<id>.
//   3. Parallel fetch:
//        - GET /api/projects/:id (project meta, access level, myBid if contractor)
//        - GET /api/system/environment (platform constants, payment enabled flag)
//   4. If CLIENT (project owner):
//        - GET /api/bids/project/:projectId -> list of contractor bids
//        - "Accept Bid" calls PUT /api/bids/:bidId/accept with idempotency key
//        - If contract formed (status ASSIGNED/IN_PROGRESS and ledger exists):
//          GET /api/contracts/by-project/:projectId -> Escrow Funding Card
//          Initiate payment via POST /api/payment/initiate/:ledgerId with idempotency key
//   5. If CONTRACTOR:
//        - If bid submitted (project.myBid): display sealed proposal and status
//        - If project is OPEN and no bid: render CTA to /app/submit-bid.html?project=:id
//        - If awarded: show Milestone Workspace CTA
//
// Security & Invariants:
//   - Network calls exclusively via get(), post(), put() from ../api.js.
//   - Pure DOM APIs (createElement, textContent, append, replaceChildren) — zero innerHTML.
//   - Never declare a local 'location' identifier (shadows window.location).
//   - Money formatted via formatTaka(); dates via formatRelativeTime().
//   - 100% i18n parity via data-i18n and t().
//   - Idempotency key via newIdempotencyKey() on mutating requests.

import { initShell } from '../shell.js';
import { get, post, put, ApiError, newIdempotencyKey, setActiveShareToken } from '../api.js';
import { t, applyLang, formatTaka, formatRelativeTime } from '../i18n.js';
import { requireAuth, getMe } from '../session.js';
import { openDialog, closeDialog } from '../dialog.js';
import { showConfirmDialog } from '../components/confirmDialog.js';

const $ = (id) => document.getElementById(id);

let currentUser = null;
let currentProject = null;
let currentContract = null;
let currentEnvironment = null;
let currentBids = [];
let isSubmitting = false;
let activeChatBid = null;
let chatMessages = [];
let isChatSubmitting = false;

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

// ── UI Helpers ───────────────────────────────────────────────────────────────
function createStatusBadge(statusText, kind) {
  const badge = document.createElement('span');
  let colorClasses = 'bg-surface-container text-on-surface-variant';
  if (kind === 'OPEN') {
    colorClasses = 'bg-primary-fixed text-on-primary-fixed';
  } else if (kind === 'ASSIGNED') {
    colorClasses = 'bg-primary-container/20 text-primary-container font-semibold';
  } else if (kind === 'IN_PROGRESS' || kind === 'ACCEPTED') {
    colorClasses = 'bg-success/15 text-on-surface border border-success/40 font-semibold';
  } else if (kind === 'PENDING') {
    colorClasses = 'bg-primary-fixed text-on-primary-fixed';
  } else if (kind === 'REJECTED' || kind === 'CANCELLED') {
    colorClasses = 'bg-error-container text-on-error-container';
  } else if (kind === 'WITHDRAWN') {
    colorClasses = 'bg-surface-container text-on-surface-variant';
  }

  badge.className = `inline-flex items-center rounded-md px-sm py-xs text-body-sm ${colorClasses}`;
  badge.textContent = statusText;
  return badge;
}

function renderBreakdownTable(items) {
  const container = document.createElement('div');
  container.className = 'mt-md border border-border-subtle rounded-lg overflow-hidden bg-surface-container-low';

  const heading = document.createElement('div');
  heading.className = 'px-md py-sm bg-surface-container text-body-sm font-semibold text-on-surface border-b border-border-subtle';
  heading.textContent = t('detail.breakdownTitle');
  container.append(heading);

  const list = document.createElement('div');
  list.className = 'divide-y divide-border-subtle';

  items.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'p-md flex flex-col sm:flex-row sm:items-center justify-between gap-xs text-body-sm';

    const info = document.createElement('div');
    info.className = 'space-y-xs';
    const title = document.createElement('span');
    title.className = 'font-semibold text-on-surface';
    title.textContent = `${idx + 1}. ${item.title || `${t('detail.breakdownItem')} ${idx + 1}`}`;
    info.append(title);

    const values = document.createElement('div');
    values.className = 'flex items-center gap-md text-on-surface-variant';

    if (item.estimatedDays) {
      const daysSpan = document.createElement('span');
      daysSpan.className = 'inline-flex items-center gap-xs';
      const daysIcon = document.createElement('span');
      daysIcon.className = 'icon text-[18px]';
      daysIcon.setAttribute('aria-hidden', 'true');
      daysIcon.textContent = 'schedule';
      const daysText = document.createElement('span');
      daysText.textContent = `${item.estimatedDays} d`;
      daysSpan.append(daysIcon, daysText);
      values.append(daysSpan);
    }

    const amt = document.createElement('span');
    amt.className = 'font-bold text-primary';
    amt.textContent = formatTaka(item.amount || 0);
    values.append(amt);

    row.append(info, values);
    list.append(row);
  });

  container.append(list);
  return container;
}

function renderCryptographicBadges(bid) {
  const row = document.createElement('div');
  row.className = 'flex items-center gap-sm flex-wrap pt-xs';

  if (bid.bidFingerprint) {
    const fpBadge = document.createElement('span');
    fpBadge.className = 'inline-flex items-center gap-xs rounded-md bg-surface-container-low border border-border-subtle px-sm py-xs text-label-caps text-on-surface-variant font-mono';
    const lockIcon = document.createElement('span');
    lockIcon.className = 'icon text-[16px] text-primary';
    lockIcon.setAttribute('aria-hidden', 'true');
    lockIcon.textContent = 'lock';
    const fpText = document.createElement('span');
    fpText.textContent = `SHA-256: ${bid.bidFingerprint.slice(0, 12)}…`;
    fpBadge.title = bid.bidFingerprint;
    fpBadge.append(lockIcon, fpText);
    row.append(fpBadge);
  }

  if (bid.cryptographicProof && bid.cryptographicProof.signature) {
    const proofBadge = document.createElement('span');
    proofBadge.className = 'inline-flex items-center gap-xs rounded-md bg-success/10 border border-success/30 px-sm py-xs text-body-sm font-medium text-money-fill';
    const shieldIcon = document.createElement('span');
    shieldIcon.className = 'icon text-[16px]';
    shieldIcon.setAttribute('aria-hidden', 'true');
    shieldIcon.textContent = 'verified_user';
    const proofText = document.createElement('span');
    proofText.textContent = t('detail.biometricSigned');
    proofBadge.append(shieldIcon, proofText);
    row.append(proofBadge);
  }

  return row;
}

// ── Render Project Meta ──────────────────────────────────────────────────────
function renderProjectDetails() {
  const proj = currentProject;
  if (!proj) return;

  $('project-title').textContent = proj.title || '';
  $('project-posted').textContent = t('detail.postedOn', { time: formatRelativeTime(proj.createdAt) });
  $('project-category').textContent = proj.category || '';

  const statusKey = `detail.status.${proj.status}`;
  const statusLabel = t(statusKey) || proj.status;
  const statusBadge = $('project-status');
  statusBadge.textContent = statusLabel;
  statusBadge.className = `inline-flex items-center rounded-md px-sm py-xs text-body-sm font-semibold ${
    proj.status === 'OPEN' ? 'bg-primary-fixed text-on-primary-fixed'
    : proj.status === 'ASSIGNED' ? 'bg-primary-container/20 text-primary-container'
    : proj.status === 'IN_PROGRESS' ? 'bg-success/15 text-on-surface border border-success/40'
    : proj.status === 'CANCELLED' ? 'bg-error-container text-on-error-container'
    : 'bg-surface-container text-on-surface-variant'
  }`;

  const cancelBtn = $('btn-cancel-project');
  if (cancelBtn) {
    const isOwner = currentUser && !currentUser.isDelegate && currentUser.role === 'CLIENT' && String(proj.clientId) === String(currentUser.id || currentUser.userId);
    cancelBtn.hidden = !(isOwner && proj.status === 'OPEN');
  }

  $('project-budget').textContent = (currentUser?.isDelegate && currentUser?.hideFinancials) || proj.budget === null
    ? t('delegate.budgetHidden')
    : formatTaka(proj.budget || 0);
  $('project-location').textContent = proj.location || '';
  $('project-description').textContent = proj.description || '';

  if (proj.hasSiteCoordinates) {
    $('project-coords-notice').hidden = false;
  } else {
    $('project-coords-notice').hidden = true;
  }

  // Delegated viewer banner + direct Material Delivery Ledger CTA
  let delegateBanner = document.getElementById('delegate-access-banner');
  if (currentUser?.isDelegate) {
    if (!delegateBanner) {
      delegateBanner = document.createElement('section');
      delegateBanner.id = 'delegate-access-banner';
      delegateBanner.className = 'card p-md border border-primary/30 bg-primary-fixed/20 mb-lg flex flex-col sm:flex-row sm:items-center justify-between gap-md';
      const viewRoot = $('project-view');
      if (viewRoot) viewRoot.prepend(delegateBanner);
    }
    delegateBanner.replaceChildren();
    const isWatcher = currentUser.role === 'SITE_WATCHER';
    const textWrap = document.createElement('div');
    textWrap.className = 'space-y-xs';
    const titleRow = document.createElement('p');
    titleRow.className = 'text-title-md font-bold text-on-surface flex items-center gap-xs';
    const ic = document.createElement('span');
    ic.className = 'icon text-primary';
    ic.setAttribute('aria-hidden', 'true');
    ic.textContent = isWatcher ? 'local_shipping' : 'visibility';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = t(isWatcher ? 'delegate.banner.watcherTitle' : 'delegate.banner.viewerTitle');
    titleRow.append(ic, titleSpan);

    const descRow = document.createElement('p');
    descRow.className = 'text-body-sm text-on-surface-variant';
    descRow.textContent = t(isWatcher ? 'delegate.banner.watcherDesc' : 'delegate.banner.viewerDesc');
    textWrap.append(titleRow, descRow);

    const matLink = document.createElement('a');
    const urlToken = new URLSearchParams(window.location.search).get('token') || '';
    matLink.href = `/app/project-materials.html?id=${encodeURIComponent(proj._id)}${urlToken ? `&token=${encodeURIComponent(urlToken)}` : ''}`;
    matLink.className = 'btn-primary min-h-[44px] px-md inline-flex items-center gap-xs whitespace-nowrap';
    const matIcon = document.createElement('span');
    matIcon.className = 'icon';
    matIcon.setAttribute('aria-hidden', 'true');
    matIcon.textContent = 'inventory_2';
    const matTxt = document.createElement('span');
    matTxt.textContent = t('delegate.openMaterials');
    matLink.append(matIcon, matTxt);

    delegateBanner.append(textWrap, matLink);
    delegateBanner.hidden = false;
  } else if (delegateBanner) {
    delegateBanner.hidden = true;
  }

  // Adjust back link
  const backBtn = $('back-link');
  if (currentUser?.isDelegate) {
    backBtn.href = '/app/';
  } else if (currentUser && currentUser.role === 'CONTRACTOR') {
    backBtn.href = '/app/tenders.html';
  } else {
    backBtn.href = '/app/dashboard.html';
  }
}

// ── Escrow Funding Card ──────────────────────────────────────────────────────
function renderEscrowCard() {
  const card = $('escrow-card');
  if (!currentContract || !currentContract.ledger) {
    card.hidden = true;
    return;
  }

  const ledger = currentContract.ledger;
  card.hidden = false;

  $('escrow-total-amount').textContent = formatTaka(ledger.totalContractValue || 0);
  const statusKey = `detail.escrow.${ledger.ledgerStatus}`;
  $('escrow-status-text').textContent = t(statusKey) || ledger.ledgerStatus;

  const fundBtn = $('btn-fund-escrow');
  const disabledNotice = $('escrow-disabled-notice');
  const workspaceBtn = $('btn-open-workspace');

  const paymentsEnabled = Boolean(currentEnvironment?.payments?.enabled);

  workspaceBtn.href = `/app/contract.html?id=${encodeURIComponent(currentProject._id)}`;
  if (ledger.ledgerStatus === 'PENDING_FUNDING') {
    if (paymentsEnabled) {
      fundBtn.hidden = false;
      disabledNotice.hidden = true;
      workspaceBtn.hidden = false;
    } else {
      fundBtn.hidden = true;
      disabledNotice.hidden = false;
      workspaceBtn.hidden = false;
    }
  } else {
    fundBtn.hidden = true;
    disabledNotice.hidden = true;
    workspaceBtn.hidden = false;
  }
}

async function handleFundEscrow() {
  if (isSubmitting || !currentContract?.ledger?._id) return;
  isSubmitting = true;

  const btn = $('btn-fund-escrow');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('detail.fundingInProgress');

  try {
    const res = await post(
      `/payment/initiate/${currentContract.ledger._id}`,
      {},
      { idempotencyKey: newIdempotencyKey() }
    );

    if (res && res.gatewayUrl) {
      window.location.href = res.gatewayUrl;
    } else {
      showAlert('error', t('err.generic'));
      btn.disabled = false;
      btn.textContent = originalText;
      isSubmitting = false;
    }
  } catch (err) {
    console.error('Escrow funding initiation failed:', err);
    showAlert('error', err.message || t('err.generic'));
    btn.disabled = false;
    btn.textContent = originalText;
    isSubmitting = false;
  }
}

// ── Client View: Bid List & Acceptance ───────────────────────────────────────
function renderBidsList() {
  const section = $('bids-section');
  section.hidden = false;

  const countBadge = $('bids-count-badge');
  countBadge.textContent = t('detail.bidCount', { count: currentBids.length });

  const noBidsBox = $('no-bids');
  const listContainer = $('bids-list');
  listContainer.replaceChildren();

  if (currentBids.length === 0) {
    noBidsBox.hidden = false;
    return;
  }

  noBidsBox.hidden = true;

  currentBids.forEach((bid) => {
    const card = document.createElement('div');
    card.className = 'card p-lg sm:p-xl space-y-md border border-border-subtle';

    // Header: Contractor info & status
    const header = document.createElement('div');
    header.className = 'flex flex-col sm:flex-row sm:items-center sm:justify-between gap-sm border-b border-border-subtle pb-sm';

    const contractorBox = document.createElement('div');
    contractorBox.className = 'flex items-center gap-xs';
    const personIcon = document.createElement('span');
    personIcon.className = 'icon text-primary text-[20px]';
    personIcon.setAttribute('aria-hidden', 'true');
    personIcon.textContent = 'person';
    const contractorTitle = document.createElement('span');
    contractorTitle.className = 'font-semibold text-on-surface text-body-md';
    const contractorName = bid.contractorName || t('role.contractor');
    const phone = bid.status === 'ACCEPTED' ? bid.contractorId?.phoneNumber : null;
    contractorTitle.textContent = phone ? `${contractorName} (${phone})` : contractorName;
    contractorBox.append(personIcon, contractorTitle);

    const bidStatusKey = `bid.status.${bid.status.toLowerCase()}`;
    const badge = createStatusBadge(t(bidStatusKey) || bid.status, bid.status);
    header.append(contractorBox, badge);
    card.append(header);

    // Financial & Timeline overview
    const numbersRow = document.createElement('div');
    numbersRow.className = 'grid grid-cols-1 sm:grid-cols-2 gap-md';

    const amtBox = document.createElement('div');
    const amtLabel = document.createElement('span');
    amtLabel.className = 'text-label-caps uppercase text-on-surface-variant';
    amtLabel.textContent = t('detail.breakdownAmount');
    const amtVal = document.createElement('p');
    amtVal.className = 'text-h2 font-bold text-primary mt-xs';
    amtVal.textContent = formatTaka(bid.bidAmount || 0);
    amtBox.append(amtLabel, amtVal);

    const daysBox = document.createElement('div');
    const daysLabel = document.createElement('span');
    daysLabel.className = 'text-label-caps uppercase text-on-surface-variant';
    daysLabel.textContent = t('detail.breakdownDays');
    const daysVal = document.createElement('p');
    daysVal.className = 'text-h3 font-semibold text-on-surface mt-xs flex items-center gap-xs';
    const daysIcon = document.createElement('span');
    daysIcon.className = 'icon text-[22px] text-on-surface-variant';
    daysIcon.setAttribute('aria-hidden', 'true');
    daysIcon.textContent = 'schedule';
    const daysText = document.createElement('span');
    daysText.textContent = `${bid.estimatedDays || 0} d`;
    daysVal.append(daysIcon, daysText);
    daysBox.append(daysLabel, daysVal);

    numbersRow.append(amtBox, daysBox);
    card.append(numbersRow);

    // Proposal text
    const proposalBox = document.createElement('div');
    proposalBox.className = 'space-y-xs';
    const proposalLabel = document.createElement('span');
    proposalLabel.className = 'text-label-caps uppercase text-on-surface-variant';
    proposalLabel.textContent = t('bid.field.proposal');
    const proposalBody = document.createElement('p');
    proposalBody.className = 'text-body-md text-on-surface whitespace-pre-wrap leading-relaxed';
    proposalBody.textContent = bid.proposalText || '';
    proposalBox.append(proposalLabel, proposalBody);
    card.append(proposalBox);

    // Itemized breakdown if provided
    if (Array.isArray(bid.itemizedBreakdown) && bid.itemizedBreakdown.length > 0) {
      card.append(renderBreakdownTable(bid.itemizedBreakdown));
    }

    // Cryptographic seal badges
    card.append(renderCryptographicBadges(bid));

    // Action buttons: Negotiate / Chat & Accept Bid (only when project is OPEN/UNDER_BIDDING and bid is PENDING)
    if (['OPEN', 'UNDER_BIDDING'].includes(currentProject.status) && bid.status === 'PENDING') {
      const actions = document.createElement('div');
      actions.className = 'pt-sm border-t border-border-subtle flex items-center justify-end gap-sm flex-wrap';

      const chatBtn = document.createElement('button');
      chatBtn.type = 'button';
      chatBtn.className = 'btn-outline min-h-[44px] inline-flex items-center gap-xs';
      const chatIcon = document.createElement('span');
      chatIcon.className = 'icon text-[18px]';
      chatIcon.setAttribute('aria-hidden', 'true');
      chatIcon.textContent = 'edit';
      const chatText = document.createElement('span');
      chatText.textContent = t('chat.negotiateBtn');
      chatBtn.append(chatIcon, chatText);
      chatBtn.addEventListener('click', (e) => openChatModal(bid, e.currentTarget));

      const acceptBtn = document.createElement('button');
      acceptBtn.type = 'button';
      acceptBtn.className = 'btn-primary min-h-[44px]';
      const checkIcon = document.createElement('span');
      checkIcon.className = 'icon';
      checkIcon.setAttribute('aria-hidden', 'true');
      checkIcon.textContent = 'approval';
      const btnText = document.createElement('span');
      btnText.textContent = t('detail.acceptBid');
      acceptBtn.append(checkIcon, btnText);

      acceptBtn.addEventListener('click', () => handleAcceptBid(bid._id, acceptBtn));
      actions.append(chatBtn, acceptBtn);
      card.append(actions);
    }

    listContainer.append(card);
  });
}

async function handleAcceptBid(bidId, btnElement) {
  if (isSubmitting) return;

  const confirmed = await showConfirmDialog({
    title: t('detail.acceptBid'),
    message: t('detail.acceptConfirm'),
    confirmLabel: t('detail.acceptBid')
  });
  if (!confirmed) return;

  isSubmitting = true;
  const originalText = btnElement.textContent;
  btnElement.disabled = true;
  btnElement.textContent = t('detail.accepting');

  try {
    await put(
      `/bids/${bidId}/accept`,
      {},
      { idempotencyKey: newIdempotencyKey() }
    );

    showAlert('success', t('detail.acceptedNotice'));
    await refreshProjectData();
  } catch (err) {
    console.error('Accept bid failed:', err);
    showAlert('error', err.message || t('err.generic'));
    btnElement.disabled = false;
    btnElement.textContent = originalText;
  } finally {
    isSubmitting = false;
  }
}

// ── Contractor View: My Bid or Submit CTA ────────────────────────────────────
function renderContractorView() {
  const section = $('contractor-section');
  section.hidden = false;

  const myBidCard = $('my-bid-card');
  const ctaCard = $('contractor-cta-card');
  const myBid = currentProject.myBid;

  if (myBid) {
    myBidCard.hidden = false;
    ctaCard.hidden = true;

    const statusKey = `bid.status.${myBid.status.toLowerCase()}`;
    const statusText = t(statusKey) || myBid.status;
    $('my-bid-status').replaceChildren(createStatusBadge(statusText, myBid.status));

    const contentBox = $('my-bid-content');
    contentBox.replaceChildren();

    const statsGrid = document.createElement('div');
    statsGrid.className = 'grid grid-cols-1 sm:grid-cols-2 gap-md';

    const amtBox = document.createElement('div');
    const amtLabel = document.createElement('span');
    amtLabel.className = 'text-label-caps uppercase text-on-surface-variant';
    amtLabel.textContent = t('detail.breakdownAmount');
    const amtVal = document.createElement('p');
    amtVal.className = 'text-h2 font-bold text-primary mt-xs';
    amtVal.textContent = formatTaka(myBid.bidAmount || 0);
    amtBox.append(amtLabel, amtVal);

    const daysBox = document.createElement('div');
    const daysLabel = document.createElement('span');
    daysLabel.className = 'text-label-caps uppercase text-on-surface-variant';
    daysLabel.textContent = t('detail.breakdownDays');
    const daysVal = document.createElement('p');
    daysVal.className = 'text-h3 font-semibold text-on-surface mt-xs';
    daysVal.textContent = `${myBid.estimatedDays || 0} d`;
    daysBox.append(daysLabel, daysVal);

    statsGrid.append(amtBox, daysBox);
    contentBox.append(statsGrid);

    const proposalBox = document.createElement('div');
    proposalBox.className = 'space-y-xs pt-xs';
    const propLabel = document.createElement('span');
    propLabel.className = 'text-label-caps uppercase text-on-surface-variant';
    propLabel.textContent = t('bid.field.proposal');
    const propBody = document.createElement('p');
    propBody.className = 'text-body-md text-on-surface whitespace-pre-wrap leading-relaxed';
    propBody.textContent = myBid.proposalText || '';
    proposalBox.append(propLabel, propBody);
    contentBox.append(proposalBox);

    if (Array.isArray(myBid.itemizedBreakdown) && myBid.itemizedBreakdown.length > 0) {
      contentBox.append(renderBreakdownTable(myBid.itemizedBreakdown));
    }

    contentBox.append(renderCryptographicBadges(myBid));

    // Actions
    const manageBtn = $('my-bid-manage-btn');
    const workspaceBtn = $('my-bid-workspace-btn');

    let myBidChatBtn = $('my-bid-chat-btn');
    if (myBid.status === 'PENDING') {
      manageBtn.hidden = false;
      manageBtn.href = `/app/submit-bid.html?project=${encodeURIComponent(currentProject._id)}`;
      if (!myBidChatBtn) {
        myBidChatBtn = document.createElement('button');
        myBidChatBtn.id = 'my-bid-chat-btn';
        myBidChatBtn.type = 'button';
        myBidChatBtn.className = 'btn-outline min-h-[44px] inline-flex items-center gap-xs';
        const chatIcon = document.createElement('span');
        chatIcon.className = 'icon text-[18px]';
        chatIcon.setAttribute('aria-hidden', 'true');
        chatIcon.textContent = 'edit';
        const chatText = document.createElement('span');
        chatText.textContent = t('chat.negotiateBtn');
        myBidChatBtn.append(chatIcon, chatText);
        myBidChatBtn.addEventListener('click', (e) => openChatModal(myBid, e.currentTarget));
        $('my-bid-actions').prepend(myBidChatBtn);
      } else {
        myBidChatBtn.hidden = false;
      }
    } else {
      manageBtn.hidden = true;
      if (myBidChatBtn) myBidChatBtn.hidden = true;
    }

    if (
      ['ASSIGNED', 'IN_PROGRESS', 'DISPUTED', 'COMPLETED'].includes(currentProject.status) &&
      String(currentProject.awardedContractorId?._id || currentProject.awardedContractorId) === String(currentUser.id || currentUser.userId)
    ) {
      workspaceBtn.hidden = false;
      workspaceBtn.href = `/app/contract.html?id=${encodeURIComponent(currentProject._id)}`;
    } else {
      workspaceBtn.hidden = true;
    }

  } else {
    // No bid submitted yet
    myBidCard.hidden = true;
    ctaCard.hidden = false;

    const submitBtn = $('btn-submit-proposal');
    if (['OPEN', 'UNDER_BIDDING'].includes(currentProject.status)) {
      submitBtn.hidden = false;
      submitBtn.href = `/app/submit-bid.html?project=${encodeURIComponent(currentProject._id)}`;
    } else {
      submitBtn.hidden = true;
    }
  }
}

// ── Refresh & Orchestration ──────────────────────────────────────────────────
async function refreshProjectData() {
  const projectId = parseProjectId();
  const shareToken = new URLSearchParams(window.location.search).get('token');

  if (currentUser?.isDelegate && shareToken) {
    const sharedRes = await get(`/projects/shared/${encodeURIComponent(shareToken)}`);
    const sharedData = sharedRes?.data || {};
    currentProject = sharedData.project;
    currentContract = null;
    currentBids = [];
    renderProjectDetails();
    renderEscrowCard();
    return;
  }

  if (!projectId) return;

  const [projectRes, envRes] = await Promise.all([
    get(`/projects/${encodeURIComponent(projectId)}`),
    get('/system/environment').catch(() => get('/environment'))
  ]);

  currentProject = projectRes.project;
  currentEnvironment = envRes.data;

  // Try to load contract if assigned / in progress or client
  try {
    currentContract = await get(`/contracts/by-project/${encodeURIComponent(projectId)}`);
  } catch (_) {
    currentContract = null;
  }

  renderProjectDetails();
  renderEscrowCard();

  const isClient = !currentUser.isDelegate && (currentUser.role === 'CLIENT' || String(currentProject.clientId) === String(currentUser.id || currentUser.userId));

  if (isClient) {
    try {
      const bidsRes = await get(`/bids/project/${encodeURIComponent(projectId)}`);
      currentBids = bidsRes.bids || [];
    } catch (_) {
      currentBids = [];
    }
    renderBidsList();
  } else if (currentUser.role === 'CONTRACTOR') {
    renderContractorView();
  }
}

function wireCancelProject() {
  const cancelBtn = $('btn-cancel-project');
  const modal = $('cancel-project-modal');
  const closeBtn = $('btn-close-cancel-modal');
  const abortBtn = $('btn-abort-cancel');
  const confirmBtn = $('btn-confirm-cancel');
  if (!cancelBtn || !modal) return;

  let cancelIdempotencyKey = null;

  cancelBtn.addEventListener('click', () => openDialog(modal, cancelBtn));
  closeBtn?.addEventListener('click', () => closeDialog(modal));
  abortBtn?.addEventListener('click', () => closeDialog(modal));

  confirmBtn?.addEventListener('click', async () => {
    if (isSubmitting) return;
    isSubmitting = true;
    confirmBtn.disabled = true;
    confirmBtn.setAttribute('aria-busy', 'true');
    showAlert(null);

    if (!cancelIdempotencyKey) {
      cancelIdempotencyKey = newIdempotencyKey();
    }

    try {
      await post(`/projects/${currentProject._id}/cancel`, {}, { idempotencyKey: cancelIdempotencyKey });
      cancelIdempotencyKey = null;
      closeDialog(modal);
      currentProject.status = 'CANCELLED';
      renderProjectDetails();
      const bidSection = $('bid-list-section');
      if (bidSection) bidSection.hidden = true;
      showAlert('success', t('detail.cancelSuccess'));
    } catch (err) {
      closeDialog(modal);
      if (err instanceof ApiError) {
        if (err.status === 409) {
          showAlert('error', t('detail.err.cancelConflict') || err.message);
          await refreshProjectData();
          renderProjectDetails();
        } else if (err.status === 401 || err.status === 403) {
          await requireAuth();
        } else if (err.status === 0) {
          showAlert('error', t('err.offline') || 'Network error — please retry');
        } else {
          showAlert('error', err.message || t('err.generic'));
        }
      } else {
        showAlert('error', t('err.generic'));
      }
    } finally {
      isSubmitting = false;
      confirmBtn.disabled = false;
      confirmBtn.setAttribute('aria-busy', 'false');
    }
  });
}

// ── Bid Negotiation & Chat Handlers (Launch Blocker L5.2) ───────────────────
function openChatModal(bid, opener) {
  activeChatBid = bid;
  const modal = $('chat-modal');
  openDialog(modal, opener);

  // Reset forms and errors
  const msgForm = $('chat-message-form');
  if (msgForm) msgForm.reset();
  const offerForm = $('chat-offer-form');
  if (offerForm) offerForm.reset();
  const offerDetails = $('chat-offer-details');
  if (offerDetails) offerDetails.open = false;

  const amtErr = $('chat-offer-amount-error');
  if (amtErr) amtErr.hidden = true;
  const daysErr = $('chat-offer-days-error');
  if (daysErr) daysErr.hidden = true;

  // Header info
  const name = bid.contractorName || t('role.contractor');
  const amt = formatTaka(bid.bidAmount || 0);
  const days = `${bid.estimatedDays || 0} d`;
  const summaryEl = $('chat-bid-summary');
  if (summaryEl) {
    summaryEl.textContent = `${name} — ${amt} (${days})`;
  }

  loadChatMessages(bid._id);
}

function closeChatModal() {
  const modal = $('chat-modal');
  closeDialog(modal);
  activeChatBid = null;
}

async function loadChatMessages(bidId) {
  if (!bidId) return;

  const loading = $('chat-loading');
  const empty = $('chat-empty');
  const list = $('chat-messages-list');

  if (loading) loading.hidden = false;
  if (empty) empty.hidden = true;
  if (list) list.replaceChildren();

  try {
    const res = await get(`/chat/${encodeURIComponent(bidId)}`);
    chatMessages = (res.data && res.data.messages) || [];
    renderChatMessages();
  } catch (err) {
    console.error('Failed to load chat messages:', err);
    if (loading) loading.hidden = true;
    if (empty) empty.hidden = false;
  }
}

function renderChatMessages() {
  const loading = $('chat-loading');
  if (loading) loading.hidden = true;

  const empty = $('chat-empty');
  const list = $('chat-messages-list');
  const activeOfferBanner = $('chat-active-offer');
  if (!list) return;

  list.replaceChildren();

  if (!chatMessages || chatMessages.length === 0) {
    if (empty) empty.hidden = false;
    if (activeOfferBanner) activeOfferBanner.hidden = true;
    return;
  }

  if (empty) empty.hidden = true;

  // Inspect latest pending offer
  const pendingOffer = [...chatMessages].reverse().find(
    (m) => m.messageType === 'REVISED_OFFER' && m.offerStatus === 'PENDING'
  );

  if (activeOfferBanner) {
    if (pendingOffer && activeChatBid) {
      activeOfferBanner.hidden = false;
      const amtEl = $('chat-active-offer-amount');
      if (amtEl) amtEl.textContent = formatTaka(pendingOffer.payload?.revisedAmount || 0);
      const daysEl = $('chat-active-offer-days');
      if (daysEl) daysEl.textContent = `${pendingOffer.payload?.revisedDays || 0} d`;

      const isSender = String(pendingOffer.senderId) === String(currentUser.id || currentUser.userId);
      const fromEl = $('chat-active-offer-from');
      if (fromEl) fromEl.textContent = isSender ? t('chat.offerStatus.pending') : t('chat.pendingOffer');

      const acceptBtn = $('btn-accept-active-offer');
      if (acceptBtn) {
        // Only recipient can accept, and only if bid is PENDING
        acceptBtn.hidden = isSender || activeChatBid.status !== 'PENDING';
      }

      const noteEl = $('chat-active-offer-note');
      if (noteEl) {
        if (pendingOffer.payload?.text) {
          noteEl.textContent = `"${pendingOffer.payload.text}"`;
          noteEl.hidden = false;
        } else {
          noteEl.hidden = true;
        }
      }
    } else {
      activeOfferBanner.hidden = true;
    }
  }

  const myId = String(currentUser.id || currentUser.userId);

  chatMessages.forEach((m) => {
    const isMe = String(m.senderId) === myId;
    const row = document.createElement('div');
    row.className = `flex flex-col ${isMe ? 'items-end' : 'items-start'} space-y-xs`;

    // Role badge & timestamp
    const meta = document.createElement('div');
    meta.className = 'flex items-center gap-xs text-caption text-on-surface-variant';
    const roleSpan = document.createElement('span');
    roleSpan.textContent = m.senderRole === 'CONTRACTOR' ? t('role.contractor') : t('role.client');
    const timeSpan = document.createElement('span');
    timeSpan.textContent = formatRelativeTime(m.createdAt);
    meta.append(roleSpan, document.createTextNode(' • '), timeSpan);
    row.append(meta);

    if (m.messageType === 'REVISED_OFFER') {
      const offerCard = document.createElement('div');
      offerCard.className = `p-sm rounded-xl max-w-sm border space-y-xs ${
        isMe
          ? 'bg-primary-container/15 border-primary-container text-on-surface'
          : 'bg-surface-card border-border-subtle text-on-surface'
      }`;

      const offerHeader = document.createElement('div');
      offerHeader.className = 'flex items-center justify-between gap-sm';
      const offerTitle = document.createElement('span');
      offerTitle.className = 'text-label-caps uppercase text-primary font-bold';
      offerTitle.textContent = t('chat.pendingOffer');

      const statusKey = `chat.offerStatus.${(m.offerStatus || 'pending').toLowerCase()}`;
      const statusBadge = document.createElement('span');
      statusBadge.className = `inline-flex items-center rounded-md px-xs py-[2px] text-caption font-semibold ${
        m.offerStatus === 'ACCEPTED' ? 'bg-success/15 text-on-surface border border-success/40'
        : m.offerStatus === 'PENDING' ? 'bg-cta-amber/20 text-on-surface border border-cta-amber'
        : 'bg-surface-container text-on-surface-variant'
      }`;
      statusBadge.textContent = t(statusKey) || m.offerStatus;

      offerHeader.append(offerTitle, statusBadge);

      const nums = document.createElement('div');
      nums.className = 'flex items-center gap-sm';
      const amtSpan = document.createElement('span');
      amtSpan.className = 'text-h3 font-bold text-primary';
      amtSpan.textContent = formatTaka(m.payload?.revisedAmount || 0);
      const daysSpan = document.createElement('span');
      daysSpan.className = 'text-body-sm font-semibold text-on-surface';
      daysSpan.textContent = `${m.payload?.revisedDays || 0} d`;
      nums.append(amtSpan, daysSpan);

      offerCard.append(offerHeader, nums);

      if (m.payload?.text) {
        const noteP = document.createElement('p');
        noteP.className = 'text-body-sm text-on-surface-variant italic break-words';
        noteP.textContent = m.payload.text;
        offerCard.append(noteP);
      }

      row.append(offerCard);
    } else {
      const bubble = document.createElement('div');
      bubble.className = `p-sm rounded-xl max-w-sm text-body-md break-words ${
        isMe
          ? 'bg-primary text-on-primary rounded-br-none'
          : 'bg-surface-container-high text-on-surface rounded-bl-none border border-border-subtle'
      }`;
      bubble.textContent = m.payload?.text || '';
      row.append(bubble);
    }

    list.append(row);
  });

  const scrollContainer = $('chat-messages-container');
  if (scrollContainer) {
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }
}

async function handleSendMessage(e) {
  e.preventDefault();
  if (isChatSubmitting || !activeChatBid) return;

  const input = $('chat-message-input');
  const text = (input ? input.value : '').trim();
  if (!text) return;

  isChatSubmitting = true;
  const sendBtn = $('btn-send-message');
  if (sendBtn) sendBtn.disabled = true;

  try {
    await post(`/chat/${encodeURIComponent(activeChatBid._id)}/message`, {
      messageType: 'TEXT',
      text
    });
    if (input) input.value = '';
    await loadChatMessages(activeChatBid._id);
  } catch (err) {
    console.error('Failed to send message:', err);
    showAlert('error', err.message || t('err.generic'));
  } finally {
    isChatSubmitting = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

async function handleSubmitOffer(e) {
  e.preventDefault();
  if (isChatSubmitting || !activeChatBid) return;

  const amtInput = $('chat-offer-amount-input');
  const daysInput = $('chat-offer-days-input');
  const noteInput = $('chat-offer-note-input');

  const amount = parseInt(amtInput ? amtInput.value : '', 10);
  const days = parseInt(daysInput ? daysInput.value : '', 10);
  const note = (noteInput ? noteInput.value : '').trim();

  const amtErr = $('chat-offer-amount-error');
  const daysErr = $('chat-offer-days-error');
  if (amtErr) amtErr.hidden = true;
  if (daysErr) daysErr.hidden = true;

  if (isNaN(amount) || amount < 100) {
    if (amtErr) {
      amtErr.textContent = t('chat.err.amountMin');
      amtErr.hidden = false;
    }
    return;
  }

  if (isNaN(days) || days < 1) {
    if (daysErr) {
      daysErr.textContent = t('chat.err.daysMin');
      daysErr.hidden = false;
    }
    return;
  }

  isChatSubmitting = true;
  const submitBtn = $('btn-submit-offer');
  const originalText = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = t('chat.sendingOffer');
  }

  try {
    await post(
      `/chat/${encodeURIComponent(activeChatBid._id)}/message`,
      {
        messageType: 'REVISED_OFFER',
        revisedAmount: amount,
        revisedDays: days,
        text: note
      },
      { idempotencyKey: newIdempotencyKey() }
    );

    const offerDetails = $('chat-offer-details');
    if (offerDetails) offerDetails.open = false;
    const offerForm = $('chat-offer-form');
    if (offerForm) offerForm.reset();

    showAlert('success', t('chat.offerSent'));
    await loadChatMessages(activeChatBid._id);
  } catch (err) {
    console.error('Failed to submit revised offer:', err);
    showAlert('error', err.message || t('err.generic'));
  } finally {
    isChatSubmitting = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  }
}

async function handleAcceptActiveOffer() {
  if (isChatSubmitting || !activeChatBid) return;

  const btn = $('btn-accept-active-offer');
  const originalText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = t('chat.accepting');
  }
  isChatSubmitting = true;

  try {
    await post(
      `/chat/${encodeURIComponent(activeChatBid._id)}/accept-offer`,
      {},
      { idempotencyKey: newIdempotencyKey() }
    );

    closeChatModal();
    showAlert('success', t('chat.acceptSuccess'));
    await refreshProjectData();
  } catch (err) {
    console.error('Failed to accept revised offer:', err);
    showAlert('error', err.message || t('err.generic'));
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  } finally {
    isChatSubmitting = false;
  }
}

// ── Page Initialization ──────────────────────────────────────────────────────
async function init() {
  await initShell();
  const urlShareToken = new URLSearchParams(window.location.search).get('token');
  if (urlShareToken) {
    setActiveShareToken(urlShareToken);
    const sessionUser = await getMe().catch(() => null);
    if (sessionUser) {
      currentUser = sessionUser;
    } else {
      try {
        const sharedRes = await get(`/projects/shared/${encodeURIComponent(urlShareToken)}`);
        const shareMeta = sharedRes?.data?.share;
        const sharedProj = sharedRes?.data?.project;
        if (!shareMeta || !sharedProj) {
          $('loading').hidden = true;
          $('not-found').hidden = false;
          return;
        }
        currentUser = {
          isDelegate: true,
          role: shareMeta.scopedRole,
          delegateName: shareMeta.delegateName,
          hideFinancials: Boolean(shareMeta.hideFinancials),
          projectId: String(sharedProj._id)
        };
      } catch (_) {
        $('loading').hidden = true;
        $('not-found').hidden = false;
        return;
      }
    }
  } else {
    currentUser = await requireAuth();
  }

  const projectId = parseProjectId() || currentUser?.projectId;
  if (!projectId) {
    $('loading').hidden = true;
    $('not-found').hidden = false;
    return;
  }

  try {
    await refreshProjectData();
    $('loading').hidden = true;
    $('project-view').hidden = false;
  } catch (err) {
    console.error('Failed to load project details:', err);
    $('loading').hidden = true;
    if (err instanceof ApiError && err.status === 404) {
      $('not-found').hidden = false;
    } else {
      showAlert('error', err.message || t('err.generic'));
    }
  }

  // Wire event handlers
  $('btn-fund-escrow').addEventListener('click', handleFundEscrow);
  wireCancelProject();

  // Wire Chat Modal event handlers (Launch Blocker L5.2)
  const btnCloseChat = $('btn-close-chat-modal');
  if (btnCloseChat) btnCloseChat.addEventListener('click', closeChatModal);

  const msgForm = $('chat-message-form');
  if (msgForm) msgForm.addEventListener('submit', handleSendMessage);

  const offerForm = $('chat-offer-form');
  if (offerForm) offerForm.addEventListener('submit', handleSubmitOffer);

  const btnAcceptOffer = $('btn-accept-active-offer');
  if (btnAcceptOffer) btnAcceptOffer.addEventListener('click', handleAcceptActiveOffer);

  window.addEventListener('langchange', () => {
    applyLang();
    renderProjectDetails();
    renderEscrowCard();
    if (currentUser?.role === 'CLIENT') {
      renderBidsList();
    } else if (currentUser?.role === 'CONTRACTOR') {
      renderContractorView();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
