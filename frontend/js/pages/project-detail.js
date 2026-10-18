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
import { get, post, put, ApiError, newIdempotencyKey } from '../api.js';
import { t, applyLang, formatTaka, formatRelativeTime } from '../i18n.js';
import { requireAuth } from '../session.js';

const $ = (id) => document.getElementById(id);

let currentUser = null;
let currentProject = null;
let currentContract = null;
let currentEnvironment = null;
let currentBids = [];
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
    colorClasses = 'bg-surface-container text-outline';
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
    proofBadge.className = 'inline-flex items-center gap-xs rounded-md bg-success/10 border border-success/30 px-sm py-xs text-body-sm font-medium text-success';
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
    : 'bg-surface-container text-on-surface-variant'
  }`;

  $('project-budget').textContent = formatTaka(proj.budget || 0);
  $('project-location').textContent = proj.location || '';
  $('project-description').textContent = proj.description || '';

  if (proj.hasSiteCoordinates) {
    $('project-coords-notice').hidden = false;
  } else {
    $('project-coords-notice').hidden = true;
  }

  // Adjust back link
  const backBtn = $('back-link');
  if (currentUser && currentUser.role === 'CONTRACTOR') {
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
    // Funded, partially disbursed, or completed
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
    contractorTitle.textContent = bid.contractorId?.phoneNumber || 'Contractor';
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

    // Action button: Accept Bid (only when project is OPEN and bid is PENDING)
    if (currentProject.status === 'OPEN' && bid.status === 'PENDING') {
      const actions = document.createElement('div');
      actions.className = 'pt-sm border-t border-border-subtle flex justify-end';

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
      actions.append(acceptBtn);
      card.append(actions);
    }

    listContainer.append(card);
  });
}

async function handleAcceptBid(bidId, btnElement) {
  if (isSubmitting) return;

  const confirmed = window.confirm(t('detail.acceptConfirm'));
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

    if (myBid.status === 'PENDING') {
      manageBtn.hidden = false;
      manageBtn.href = `/app/submit-bid.html?project=${encodeURIComponent(currentProject._id)}`;
    } else {
      manageBtn.hidden = true;
    }

    if (
      (currentProject.status === 'ASSIGNED' || currentProject.status === 'IN_PROGRESS') &&
      currentProject.awardedContractorId === currentUser.userId
    ) {
      workspaceBtn.hidden = false;
    } else {
      workspaceBtn.hidden = true;
    }

  } else {
    // No bid submitted yet
    myBidCard.hidden = true;
    ctaCard.hidden = false;

    const submitBtn = $('btn-submit-proposal');
    if (currentProject.status === 'OPEN') {
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

  const isClient = currentUser.role === 'CLIENT' || currentProject.clientId === currentUser.userId;

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
