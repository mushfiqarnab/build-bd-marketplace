// F6 — Bid submission & withdrawal for CONTRACTORS.
//
// Data flow:
//   1. requireAuth({ roles: ['CONTRACTOR'] }) before paint.
//   2. Read project ID from URL query param ?project=<id>.
//   3. GET /api/projects/:id → retrieve project details and contractor's existing bid (if any).
//   4. If existing bid exists:
//        - Render existing bid view (amount, estimated days, status badge, timestamp).
//        - If status is 'PENDING', provide "Withdraw bid" action via POST /api/bids/:bidId/withdraw.
//   5. If no bid yet:
//        - Render bid submission form.
//        - Validates bidAmount >= 100 (limits.bidFloorBdt), integer BDT.
//        - Validates estimatedDays >= 1, integer.
//        - Validates proposalText >= 10 characters.
//        - Optional itemizedBreakdown array with dynamic rows and live balance check.
//        - Submits to POST /api/bids/:projectId with submit-race lock and busy state.
//
// Security & Invariants:
//   - Network calls via get() / post() from ../api.js.
//   - Pure DOM APIs (createElement, append, textContent) — no innerHTML.
//   - Bengali digit support via bengaliToAscii() from ../phone.js.
//   - Money formatted via formatTaka(); dates via formatRelativeTime().
//   - 100% i18n parity via data-i18n and t().

import { initShell } from '../shell.js';
import { get, post, ApiError } from '../api.js';
import { t, applyLang, formatTaka, formatRelativeTime } from '../i18n.js';
import { bengaliToAscii } from '../phone.js';
import { requireAuth } from '../session.js';

const $ = (id) => document.getElementById(id);

let submitting = false;
let currentProject = null;
let currentBid = null;
let bidFloorBdt = 100;
let breakdownItems = []; // { id, title, amount, estimatedDays }

// ── Alert Helpers ────────────────────────────────────────────────────────────
function showAlert(kind, text, extraNode) {
  const box = $('alert');
  box.replaceChildren();
  if (!text) {
    box.hidden = true;
    return;
  }
  const div = document.createElement('div');
  div.className = kind === 'error' ? 'alert-error' : kind === 'info' ? 'alert-info' : 'alert-success';
  const icon = document.createElement('span');
  icon.className = 'icon text-[20px]';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = kind === 'error' ? 'error' : kind === 'info' ? 'info' : 'check_circle';
  const msg = document.createElement('span');
  msg.textContent = text;
  div.append(icon, msg);
  if (extraNode) {
    div.append(document.createTextNode(' '));
    div.append(extraNode);
  }
  box.append(div);
  box.hidden = false;
}

function fieldError(id, text) {
  const el = $(`${id}-error`);
  const input = $(id);
  if (el) {
    el.textContent = text || '';
    el.hidden = !text;
  }
  if (input) {
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function clearAllFieldErrors() {
  for (const id of ['bid-amount', 'est-days', 'proposal', 'breakdown']) {
    fieldError(id, '');
  }
}

function busy(btn, on, labelKey) {
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
  const label = btn.querySelector('[data-i18n]');
  if (label) label.textContent = t(on ? labelKey : label.dataset.i18n);
}

// ── Numeric Parsing Helpers ──────────────────────────────────────────────────
function parseWholeNumber(raw) {
  const s = bengaliToAscii(String(raw || '')).replace(/[,\s]/g, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}

// ── Status Badges ────────────────────────────────────────────────────────────
function makeStatusBadge(status) {
  const span = document.createElement('span');
  const s = String(status || '').toUpperCase();
  if (s === 'PENDING') {
    span.className = 'inline-flex items-center gap-xs px-sm py-xs rounded-full bg-secondary-container text-on-secondary-container text-label-sm font-medium';
    span.textContent = t('bid.status.pending');
  } else if (s === 'ACCEPTED') {
    span.className = 'inline-flex items-center gap-xs px-sm py-xs rounded-full bg-primary-container text-on-primary-container text-label-sm font-medium';
    span.textContent = t('bid.status.accepted');
  } else if (s === 'WITHDRAWN') {
    span.className = 'inline-flex items-center gap-xs px-sm py-xs rounded-full bg-surface-variant text-on-surface-variant text-label-sm font-medium';
    span.textContent = t('bid.status.withdrawn');
  } else if (s === 'REJECTED') {
    span.className = 'inline-flex items-center gap-xs px-sm py-xs rounded-full bg-error-container text-on-error-container text-label-sm font-medium';
    span.textContent = t('bid.status.rejected');
  } else {
    span.className = 'inline-flex items-center gap-xs px-sm py-xs rounded-full bg-surface-variant text-on-surface-variant text-label-sm font-medium';
    span.textContent = status;
  }
  return span;
}

// ── Project Summary Component ────────────────────────────────────────────────
function renderProjectSummary(container, project) {
  container.replaceChildren();

  const titleRow = document.createElement('div');
  titleRow.className = 'flex flex-wrap items-start justify-between gap-sm';

  const titleCol = document.createElement('div');
  titleCol.className = 'flex-1 min-w-0';

  const catSpan = document.createElement('span');
  catSpan.className = 'badge-category mb-xs inline-block';
  catSpan.textContent = t(`post.cat.${project.category}`) || project.category;

  const h2 = document.createElement('h2');
  h2.className = 'text-h3 text-on-surface';
  h2.textContent = project.title || '';

  titleCol.append(catSpan, h2);

  const budgetCol = document.createElement('div');
  budgetCol.className = 'text-right shrink-0';

  const budgetVal = document.createElement('p');
  budgetVal.className = 'text-label-lg text-primary font-semibold';
  budgetVal.textContent = formatTaka(project.budget);

  const budgetLbl = document.createElement('p');
  budgetLbl.className = 'text-body-sm text-on-surface-variant';
  budgetLbl.textContent = t('bid.clientBudget');

  budgetCol.append(budgetVal, budgetLbl);
  titleRow.append(titleCol, budgetCol);

  const metaRow = document.createElement('div');
  metaRow.className = 'flex flex-wrap items-center gap-md text-body-sm text-on-surface-variant pt-xs';

  const locSpan = document.createElement('span');
  locSpan.className = 'flex items-center gap-xs';
  const locIcon = document.createElement('span');
  locIcon.className = 'icon text-[16px]';
  locIcon.setAttribute('aria-hidden', 'true');
  locIcon.textContent = 'location_on';
  const locTxt = document.createElement('span');
  locTxt.textContent = project.location || '';
  locSpan.append(locIcon, locTxt);

  const timeSpan = document.createElement('span');
  timeSpan.className = 'flex items-center gap-xs';
  const timeIcon = document.createElement('span');
  timeIcon.className = 'icon text-[16px]';
  timeIcon.setAttribute('aria-hidden', 'true');
  timeIcon.textContent = 'schedule';
  const timeTxt = document.createElement('span');
  timeTxt.textContent = formatRelativeTime(project.createdAt);
  timeSpan.append(timeIcon, timeTxt);

  metaRow.append(locSpan, timeSpan);

  const desc = document.createElement('p');
  desc.className = 'text-body-sm text-on-surface-variant line-clamp-2 pt-xs';
  desc.textContent = project.description || '';

  container.append(titleRow, metaRow, desc);
}

// ── Existing Bid View ────────────────────────────────────────────────────────
function renderExistingBidView(project, bid) {
  $('new-bid-view').hidden = true;
  $('existing-bid-view').hidden = false;

  renderProjectSummary($('existing-project-summary'), project);

  const detailsBox = $('existing-bid-details');
  detailsBox.replaceChildren();

  const headerRow = document.createElement('div');
  headerRow.className = 'flex flex-wrap items-center justify-between gap-sm';

  const badgeBox = document.createElement('div');
  badgeBox.className = 'flex items-center gap-sm';
  badgeBox.append(makeStatusBadge(bid.status));

  const sealedNotice = document.createElement('span');
  sealedNotice.className = 'flex items-center gap-xs text-body-sm text-on-surface-variant';
  const lockIcon = document.createElement('span');
  lockIcon.className = 'icon text-[16px] text-primary';
  lockIcon.setAttribute('aria-hidden', 'true');
  lockIcon.textContent = 'lock';
  const lockTxt = document.createElement('span');
  lockTxt.textContent = t('bid.existing.sealedNotice');
  sealedNotice.append(lockIcon, lockTxt);
  badgeBox.append(sealedNotice);

  headerRow.append(badgeBox);

  // Financial and time details
  const metricsGrid = document.createElement('div');
  metricsGrid.className = 'grid grid-cols-1 sm:grid-cols-2 gap-md p-md bg-surface-variant rounded-xl';

  const amountCol = document.createElement('div');
  const amountLbl = document.createElement('p');
  amountLbl.className = 'text-body-sm text-on-surface-variant';
  amountLbl.textContent = t('bid.field.amount');
  const amountVal = document.createElement('p');
  amountVal.className = 'text-h2 text-primary font-semibold';
  amountVal.textContent = formatTaka(bid.bidAmount);
  amountCol.append(amountLbl, amountVal);

  const daysCol = document.createElement('div');
  const daysLbl = document.createElement('p');
  daysLbl.className = 'text-body-sm text-on-surface-variant';
  daysLbl.textContent = t('bid.field.days');
  const daysVal = document.createElement('p');
  daysVal.className = 'text-h2 text-on-surface font-semibold';
  daysVal.textContent = `${bid.estimatedDays}`;
  daysCol.append(daysLbl, daysVal);

  metricsGrid.append(amountCol, daysCol);

  // Submitted date
  const timeP = document.createElement('p');
  timeP.className = 'text-body-sm text-on-surface-variant';
  timeP.textContent = `${t('submitBid.submittedAt') || 'Submitted'} ${formatRelativeTime(bid.createdAt)}`;

  // Proposal text
  const proposalBox = document.createElement('div');
  proposalBox.className = 'space-y-xs';
  const propLbl = document.createElement('p');
  propLbl.className = 'text-label-md font-semibold text-on-surface';
  propLbl.textContent = t('bid.field.proposal');
  const propBody = document.createElement('p');
  propBody.className = 'text-body-md text-on-surface whitespace-pre-line';
  propBody.textContent = bid.proposalText || '';
  proposalBox.append(propLbl, propBody);

  detailsBox.append(headerRow, metricsGrid, timeP, proposalBox);

  // Withdraw Area Visibility
  const withdrawArea = $('withdraw-area');
  const withdrawBtn = $('withdraw-btn');
  if (bid.status === 'PENDING') {
    withdrawArea.hidden = false;
    withdrawBtn.hidden = false;
  } else {
    withdrawArea.hidden = true;
  }
}

// ── Dynamic Itemized Breakdown Rows ──────────────────────────────────────────
function renderBreakdownRows() {
  const container = $('breakdown-items');
  container.replaceChildren();

  breakdownItems.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'grid grid-cols-1 sm:grid-cols-12 gap-sm items-center p-sm border border-outline-variant rounded-lg bg-surface';

    // Title input (cols 1-5)
    const titleCol = document.createElement('div');
    titleCol.className = 'sm:col-span-5';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'field text-body-sm py-xs';
    titleInput.placeholder = t('bid.breakdown.titlePlaceholder');
    titleInput.value = item.title || '';
    titleInput.addEventListener('input', () => {
      item.title = titleInput.value.trim();
      updateBreakdownSummary();
    });
    titleCol.append(titleInput);

    // Amount input (cols 6-8)
    const amountCol = document.createElement('div');
    amountCol.className = 'sm:col-span-3';
    const amountInput = document.createElement('input');
    amountInput.type = 'text';
    amountInput.inputMode = 'numeric';
    amountInput.className = 'field text-body-sm py-xs';
    amountInput.placeholder = t('bid.breakdown.amountPlaceholder');
    amountInput.value = item.amount ? String(item.amount) : '';
    amountInput.addEventListener('input', () => {
      const val = parseWholeNumber(amountInput.value);
      item.amount = val;
      updateBreakdownSummary();
    });
    amountCol.append(amountInput);

    // Days input (cols 9-11)
    const daysCol = document.createElement('div');
    daysCol.className = 'sm:col-span-3';
    const daysInput = document.createElement('input');
    daysInput.type = 'text';
    daysInput.inputMode = 'numeric';
    daysInput.className = 'field text-body-sm py-xs';
    daysInput.placeholder = t('bid.breakdown.daysPlaceholder');
    daysInput.value = item.estimatedDays ? String(item.estimatedDays) : '';
    daysInput.addEventListener('input', () => {
      const val = parseWholeNumber(daysInput.value);
      item.estimatedDays = val;
      updateBreakdownSummary();
    });
    daysCol.append(daysInput);

    // Delete button (col 12)
    const delCol = document.createElement('div');
    delCol.className = 'sm:col-span-1 text-right';
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-ghost p-xs text-error';
    delBtn.title = t('bid.breakdown.removeRow');
    const delIcon = document.createElement('span');
    delIcon.className = 'icon text-[20px]';
    delIcon.setAttribute('aria-hidden', 'true');
    delIcon.textContent = 'delete';
    delBtn.append(delIcon);
    delBtn.addEventListener('click', () => {
      breakdownItems.splice(index, 1);
      renderBreakdownRows();
      updateBreakdownSummary();
    });
    delCol.append(delBtn);

    row.append(titleCol, amountCol, daysCol, delCol);
    container.append(row);
  });

  updateBreakdownSummary();
}

function updateBreakdownSummary() {
  const summaryEl = $('breakdown-totals-summary');
  if (breakdownItems.length === 0) {
    summaryEl.textContent = '';
    return;
  }

  const targetAmount = parseWholeNumber($('bid-amount').value) || 0;
  const targetDays = parseWholeNumber($('est-days').value) || 0;

  const sumAmount = breakdownItems.reduce((acc, it) => acc + (it.amount || 0), 0);
  const sumDays = breakdownItems.reduce((acc, it) => acc + (it.estimatedDays || 0), 0);

  const remAmount = targetAmount - sumAmount;
  const remDays = targetDays - sumDays;

  summaryEl.textContent = t('bid.breakdown.sumMatch', {
    sumAmount: formatTaka(sumAmount),
    remAmount: formatTaka(remAmount),
    sumDays,
    remDays
  });

  if (targetAmount > 0 && sumAmount !== targetAmount) {
    summaryEl.className = 'text-body-sm font-medium text-error';
  } else if (targetDays > 0 && sumDays !== targetDays) {
    summaryEl.className = 'text-body-sm font-medium text-error';
  } else {
    summaryEl.className = 'text-body-sm font-medium text-primary';
  }
}

// ── Live Input Listeners ─────────────────────────────────────────────────────
$('bid-amount').addEventListener('input', () => {
  const n = parseWholeNumber($('bid-amount').value);
  const formattedEl = $('bid-amount-formatted');
  if (n === null || n === 0) {
    formattedEl.hidden = true;
    formattedEl.textContent = '';
  } else {
    formattedEl.hidden = false;
    formattedEl.textContent = formatTaka(n);
  }
  updateBreakdownSummary();
});

$('est-days').addEventListener('input', () => {
  updateBreakdownSummary();
});

$('proposal').addEventListener('input', () => {
  const len = ($('proposal').value || '').trim().length;
  $('proposal-count').textContent = `${len} / 2000`;
});

$('add-breakdown-row-btn').addEventListener('click', () => {
  breakdownItems.push({ title: '', amount: null, estimatedDays: null });
  renderBreakdownRows();
});

// ── Withdrawal Handler ───────────────────────────────────────────────────────
$('withdraw-btn').addEventListener('click', async () => {
  if (submitting || !currentBid || currentBid.status !== 'PENDING') return;

  const confirmed = window.confirm(t('bid.withdrawConfirm'));
  if (!confirmed) return;

  submitting = true;
  showAlert(null);
  const btn = $('withdraw-btn');
  busy(btn, true, 'bid.withdrawing');

  try {
    const res = await post(`/bids/${currentBid._id}/withdraw`, {});
    currentBid.status = 'WITHDRAWN';
    renderExistingBidView(currentProject, currentBid);
    showAlert('success', t('bid.withdrawnSuccess'));
  } catch (err) {
    showAlert('error', err instanceof ApiError ? err.message : t('err.generic'));
    busy(btn, false);
  } finally {
    submitting = false;
  }
});

// ── Submit Form Handler ──────────────────────────────────────────────────────
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitting || !currentProject) return;
  submitting = true;
  showAlert(null);
  clearAllFieldErrors();

  const bidAmount = parseWholeNumber($('bid-amount').value);
  const estimatedDays = parseWholeNumber($('est-days').value);
  const proposalText = ($('proposal').value || '').trim();

  let firstErrorEl = null;
  const flag = (id, key, vars) => {
    fieldError(id, t(key, vars));
    if (!firstErrorEl) firstErrorEl = $(id);
  };

  // Amount validation
  if (bidAmount === null) {
    flag('bid-amount', 'bid.err.amountInvalid');
  } else if (bidAmount < bidFloorBdt) {
    flag('bid-amount', 'bid.err.amountMin', { min: bidFloorBdt });
  }

  // Days validation
  if (estimatedDays === null) {
    flag('est-days', 'bid.err.daysInvalid');
  } else if (estimatedDays < 1) {
    flag('est-days', 'bid.err.daysMin');
  }

  // Proposal validation
  if (!proposalText || proposalText.length < 10) {
    flag('proposal', 'bid.err.proposalShort');
  }

  // Breakdown validation (if any rows were added)
  let structuredBreakdown = null;
  if (breakdownItems.length > 0) {
    let incomplete = false;
    let sumAmount = 0;
    let sumDays = 0;

    for (const row of breakdownItems) {
      if (!row.title || !row.amount || !row.estimatedDays || row.amount <= 0 || row.estimatedDays <= 0) {
        incomplete = true;
        break;
      }
      sumAmount += row.amount;
      sumDays += row.estimatedDays;
    }

    if (incomplete) {
      fieldError('breakdown', t('bid.err.breakdownIncomplete'));
      if (!firstErrorEl) firstErrorEl = $('breakdown-details');
    } else if (bidAmount !== null && sumAmount !== bidAmount) {
      fieldError('breakdown', t('bid.err.breakdownAmountMismatch', { sum: formatTaka(sumAmount), total: formatTaka(bidAmount) }));
      if (!firstErrorEl) firstErrorEl = $('breakdown-details');
    } else if (estimatedDays !== null && sumDays !== estimatedDays) {
      fieldError('breakdown', t('bid.err.breakdownDaysMismatch', { sum: sumDays, total: estimatedDays }));
      if (!firstErrorEl) firstErrorEl = $('breakdown-details');
    } else {
      structuredBreakdown = breakdownItems.map((it) => ({
        title: it.title,
        amount: it.amount,
        estimatedDays: it.estimatedDays
      }));
    }
  }

  if (firstErrorEl) {
    firstErrorEl.focus();
    submitting = false;
    return;
  }

  const submitBtn = $('submit-btn');
  busy(submitBtn, true, 'bid.submitting');

  try {
    const payload = {
      bidAmount,
      estimatedDays,
      proposalText
    };
    if (structuredBreakdown) {
      payload.itemizedBreakdown = structuredBreakdown;
    }

    const res = await post(`/bids/${currentProject._id}`, payload);
    const newBid = res && res.bid ? res.bid : {
      _id: res && res.bidId,
      bidAmount,
      estimatedDays,
      proposalText,
      status: 'PENDING',
      createdAt: new Date().toISOString()
    };

    currentBid = newBid;
    renderExistingBidView(currentProject, currentBid);
    showAlert('success', t('bid.success'));
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 409) {
        showAlert('error', t('bid.err.duplicate'));
      } else if (err.status === 403) {
        if (err.message && err.message.includes('Contractor profile required')) {
          const link = document.createElement('a');
          link.href = '/app/contractor-profile.html';
          link.className = 'underline font-medium ml-xs';
          link.textContent = t('bid.err.createProfileCta');
          showAlert('error', t('bid.err.profileRequired'), link);
        } else if (err.message && err.message.includes('own projects')) {
          showAlert('error', t('bid.err.ownProject'));
        } else {
          showAlert('error', t('bid.err.projectClosed'));
        }
      } else {
        showAlert('error', err.message || t('err.generic'));
      }
    } else {
      showAlert('error', t('err.generic'));
    }
    busy(submitBtn, false);
    submitting = false;
  }
});

// ── Language Toggle Re-render ────────────────────────────────────────────────
document.addEventListener('langchange', () => {
  applyLang();
  if (currentProject) {
    if (currentBid) renderExistingBidView(currentProject, currentBid);
    else renderProjectSummary($('project-summary'), currentProject);
  }
  const n = parseWholeNumber($('bid-amount').value);
  const formattedEl = $('bid-amount-formatted');
  if (n !== null && n !== 0) formattedEl.textContent = formatTaka(n);
  updateBreakdownSummary();
});

// ── Boot ─────────────────────────────────────────────────────────────────────
(async () => {
  await initShell();
  const me = await requireAuth({ roles: ['CONTRACTOR'] });
  if (!me) return;

  const urlParams = new URLSearchParams(window.location.search);
  const projectId = urlParams.get('project');

  if (!projectId || !/^[a-fA-F0-9]{24}$/.test(projectId)) {
    $('loading').hidden = true;
    showAlert('error', t('bid.err.missingProject'));
    return;
  }

  try {
    const [envData, projectRes] = await Promise.all([
      get('/environment').catch(() => null),
      get(`/projects/${projectId}`)
    ]);

    if (envData && envData.data && envData.data.limits && envData.data.limits.bidFloorBdt) {
      bidFloorBdt = Number(envData.data.limits.bidFloorBdt) || 100;
    }

    currentProject = projectRes && projectRes.project;
    if (!currentProject) throw new Error('Project not found');

    $('loading').hidden = true;

    // Check if contractor already has a bid on this project
    if (currentProject.myBid) {
      currentBid = currentProject.myBid;
      renderExistingBidView(currentProject, currentBid);
    } else {
      // Check if project is OPEN for bidding
      if (currentProject.status !== 'OPEN') {
        showAlert('error', t('bid.err.projectClosed'));
        return;
      }
      $('new-bid-view').hidden = false;
      renderProjectSummary($('project-summary'), currentProject);
      $('bid-amount').focus();
    }
  } catch (err) {
    $('loading').hidden = true;
    showAlert('error', err instanceof ApiError ? err.message : t('err.generic'));
  }
})();
