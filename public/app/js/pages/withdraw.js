// Contractor Withdraw Portal — payout requests with bank details and history.
//
// Invariants (Lane 1 audit rules):
//   - Pure DOM (replaceChildren, append, createElement, textContent) — no innerHTML.
//   - Network via ../api.js (get, post, newIdempotencyKey).
//   - requireAuth({ roles: ['CONTRACTOR'] }) before content reveal.
//   - All copy via t() with en and bn keys.
//   - Money via formatTaka(), dates via formatDate().
//   - One idempotency key created per form submission and REUSED on retry.
//   - 202 and 502 HTTP responses surfaced as distinct alerts.

import { initShell } from '../shell.js';
import { get, post, ApiError, newIdempotencyKey } from '../api.js';
import { t, applyLang, formatTaka, formatDate } from '../i18n.js';
import { bengaliToAscii } from '../phone.js';
import { requireAuth } from '../session.js';

const $ = (id) => document.getElementById(id);

let availableBalance = 0;
let withdrawals = [];
let submitting = false;
let idempotencyKey = newIdempotencyKey();

function showAlert(kind, text) {
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

function parseWholeNumber(raw) {
  const s = bengaliToAscii(String(raw || '')).replace(/[,\s]/g, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}

function field(labelKey, value, mono = false) {
  const wrap = el('div', 'flex flex-col');
  wrap.append(
    el('dt', 'text-label-sm text-on-surface-variant', t(labelKey)),
    el('dd', `text-body-md text-on-surface ${mono ? 'font-mono' : ''}`.trim(), value || '—')
  );
  return wrap;
}

function renderWithdrawals() {
  const list = $('history-list');
  list.replaceChildren();

  if (withdrawals.length === 0) {
    $('history-empty').hidden = false;
    return;
  }
  $('history-empty').hidden = true;

  for (const w of withdrawals) {
    const li = el('li');
    const card = el('article', 'card p-md flex flex-col sm:flex-row sm:items-center justify-between gap-md');

    const left = el('div', 'space-y-xs');
    const amt = el('p', 'text-h3 font-bold text-on-surface', formatTaka(w.amount));
    const bankDesc = `${w.bankName || 'Bank'} · •••• ${w.accountLast4 || '----'}`;
    const dest = el('p', 'text-body-sm text-on-surface-variant', bankDesc);
    const date = el('p', 'text-body-sm text-on-surface-variant', formatDate(w.requestedAt));
    left.append(amt, dest, date);

    if (w.status === 'FAILED' && w.failureReason) {
      const errNote = el('p', 'text-body-sm text-error mt-xs', w.failureReason);
      left.append(errNote);
    }
    if (w.bankTransactionId) {
      const tx = el('p', 'text-body-sm font-mono text-on-surface-variant', `${t('withdraw.history.tranId')}: ${w.bankTransactionId}`);
      left.append(tx);
    }

    const right = el('div', 'shrink-0');
    let badgeClass = 'badge-category bg-surface-variant text-on-surface border border-outline-variant';
    let labelKey = 'withdraw.status.processing';
    if (w.status === 'COMPLETED') {
      badgeClass = 'badge-category bg-success/15 text-on-surface border border-success/40';
      labelKey = 'withdraw.status.completed';
    } else if (w.status === 'FAILED') {
      badgeClass = 'badge-category bg-error/15 text-on-surface border border-error/40';
      labelKey = 'withdraw.status.failed';
    }
    const badge = el('span', badgeClass, t(labelKey));
    right.append(badge);

    card.append(left, right);
    li.append(card);
    list.append(li);
  }
}

function wireForm() {
  const form = $('withdraw-form');
  const amountInput = $('withdraw-amount');
  const amountFormatted = $('amount-formatted');
  const amountErr = $('amount-error');
  const bankNameInput = $('bank-name');
  const bankNameErr = $('bank-name-error');
  const acctNameInput = $('account-name');
  const acctNameErr = $('account-name-error');
  const acctNumInput = $('account-number');
  const acctNumErr = $('account-number-error');
  const routingInput = $('routing-number');
  const routingErr = $('routing-number-error');
  const submitBtn = $('withdraw-btn');

  amountInput.addEventListener('input', () => {
    const val = parseWholeNumber(amountInput.value);
    if (val !== null && val > 0) {
      amountFormatted.hidden = false;
      amountFormatted.textContent = formatTaka(val);
    } else {
      amountFormatted.hidden = true;
      amountFormatted.textContent = '';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;

    // Reset errors
    amountErr.hidden = true;
    bankNameErr.hidden = true;
    acctNameErr.hidden = true;
    acctNumErr.hidden = true;
    routingErr.hidden = true;
    showAlert(null);

    const amount = parseWholeNumber(amountInput.value);
    const bankName = bankNameInput.value.trim();
    const accountName = acctNameInput.value.trim();
    const accountNumber = acctNumInput.value.trim();
    const routingNumber = routingInput.value.trim();

    let firstErr = null;

    if (amount === null || amount <= 0) {
      amountErr.textContent = t('withdraw.err.wholeAmount');
      amountErr.hidden = false;
      if (!firstErr) firstErr = amountInput;
    } else if (amount < 500) {
      amountErr.textContent = t('withdraw.err.minAmount');
      amountErr.hidden = false;
      if (!firstErr) firstErr = amountInput;
    } else if (amount > availableBalance) {
      amountErr.textContent = t('withdraw.err.insufficient');
      amountErr.hidden = false;
      if (!firstErr) firstErr = amountInput;
    }

    if (!bankName) {
      bankNameErr.textContent = t('withdraw.err.bankRequired');
      bankNameErr.hidden = false;
      if (!firstErr) firstErr = bankNameInput;
    }

    if (!accountName) {
      acctNameErr.textContent = t('withdraw.err.bankRequired');
      acctNameErr.hidden = false;
      if (!firstErr) firstErr = acctNameInput;
    }

    if (!accountNumber) {
      acctNumErr.textContent = t('withdraw.err.bankRequired');
      acctNumErr.hidden = false;
      if (!firstErr) firstErr = acctNumInput;
    }

    if (!routingNumber) {
      routingErr.textContent = t('withdraw.err.bankRequired');
      routingErr.hidden = false;
      if (!firstErr) firstErr = routingInput;
    }

    if (firstErr) {
      firstErr.focus();
      return;
    }

    submitting = true;
    busy(submitBtn, true, 'withdraw.form.submitting');

    try {
      const res = await post(
        '/finance/withdraw',
        {
          amount,
          bankDetails: {
            bankName,
            accountName,
            accountNumber,
            routingNumber
          }
        },
        { idempotencyKey }
      );

      // On definitive success: rotate key, clear amount, and show success
      idempotencyKey = newIdempotencyKey();
      amountInput.value = '';
      amountFormatted.hidden = true;
      showAlert('success', t('withdraw.success'));
      await loadData();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 202) {
          // Accepted locally, pending bank confirmation
          idempotencyKey = newIdempotencyKey();
          amountInput.value = '';
          amountFormatted.hidden = true;
          showAlert('info', t('withdraw.pendingBank'));
          await loadData();
        } else if (err.status === 502) {
          // Bank rejected payout, funds restored
          idempotencyKey = newIdempotencyKey();
          showAlert('error', t('withdraw.bankRejectedRestored'));
          await loadData();
        } else if (err.status === 400) {
          showAlert('error', err.message || t('withdraw.err.bankRequired'));
        } else {
          showAlert('error', err.message || t('err.generic'));
        }
      } else {
        showAlert('error', t('err.generic'));
      }
    } finally {
      submitting = false;
      busy(submitBtn, false);
    }
  });
}

async function loadData() {
  const [countersRes, withdrawalsRes] = await Promise.all([
    get('/dashboard/counters'),
    get('/finance/withdrawals')
  ]);

  const wallet = countersRes?.wallet || { availableToWithdraw: 0, pendingClearance: 0, lockedEscrow: 0 };
  availableBalance = wallet.availableToWithdraw || 0;

  $('balance-available').textContent = formatTaka(wallet.availableToWithdraw || 0);
  $('balance-pending').textContent = formatTaka(wallet.pendingClearance || 0);
  $('balance-locked').textContent = formatTaka(wallet.lockedEscrow || 0);

  withdrawals = (withdrawalsRes && withdrawalsRes.data && withdrawalsRes.data.withdrawals) || [];
  renderWithdrawals();
}

document.addEventListener('langchange', () => {
  applyLang();
  renderWithdrawals();
});

(async () => {
  await initShell();
  const me = await requireAuth({ roles: ['CONTRACTOR'] });
  if (!me) return;

  wireForm();

  try {
    await loadData();
    $('loading').hidden = true;
    $('content').hidden = false;
  } catch (err) {
    $('loading').hidden = true;
    const bootError = $('boot-error');
    bootError.textContent = t('err.generic');
    bootError.hidden = false;
  }
})();
