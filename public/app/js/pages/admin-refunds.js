// Admin — refunds owed for orphan gateway payments. ADMIN-only.
//
// Data flow:
//   1. requireAuth({ roles: ['ADMIN'] }) before any paint.
//   2. GET /api/admin/refunds?status=pending|refunded|all → refund rows.
//   3. "Record refund" opens an inline form; POST
//      /api/admin/refunds/:ledgerId/:valId/complete with { refundReference, note }.
//      The idempotency key is created once per form and REUSED on retry, so a
//      network blip can never record the same refund twice.
//
// Patterns (Lane 1 audit invariants — DO NOT BREAK): pure DOM (no innerHTML),
// all network via ../api.js, data-i18n + MESSAGES.en/bn, only icons in
// frontend/icons.txt, money via formatTaka(), dates via formatDate().

import { initShell } from '../shell.js';
import { get, post, ApiError, newIdempotencyKey } from '../api.js';
import { t, applyLang, formatTaka, formatDate } from '../i18n.js';
import { requireAuth } from '../session.js';

const $ = (id) => document.getElementById(id);
const REFERENCE_RE = /^[\w.\-/]{4,64}$/;

let currentFilter = 'pending';
let rows = [];
let truncated = false;
let fetchSeq = 0;

function showAlert(kind, text) {
  const box = $('alert');
  box.replaceChildren();
  if (!text) { box.hidden = true; return; }
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

function messageFor(err) {
  if (!(err instanceof ApiError)) return t('err.generic');
  if (err.status === 0) return t(err.message === 'timeout' ? 'err.timeout' : 'err.offline');
  if (err.status === 401) return t('err.sessionExpired');
  if (err.status === 403) return t('err.forbidden');
  if (err.status === 409) return t('refunds.err.alreadyDone');
  if (err.status === 400) return t('refunds.err.reference');
  if (err.status === 429) return t('err.rateLimited');
  return t('err.generic');
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

function iconLabelButton(className, icon, labelKey) {
  const btn = el('button', className);
  btn.type = 'button';
  const i = el('span', 'icon', icon);
  i.setAttribute('aria-hidden', 'true');
  const label = el('span', '', t(labelKey));
  label.dataset.i18n = labelKey;
  btn.append(i, label);
  return btn;
}

/** One "label: value" line inside a card. */
function field(labelKey, value, mono = false) {
  const wrap = el('div', 'flex flex-col');
  wrap.append(
    el('dt', 'text-label-sm text-on-surface-variant', t(labelKey)),
    el('dd', `text-body-md text-on-surface break-all ${mono ? 'font-mono' : ''}`.trim(), value || '—')
  );
  return wrap;
}

function buildForm(row, card, actionBtn) {
  const form = el('form', 'mt-md flex flex-col gap-sm border-t border-border-subtle pt-md');
  form.noValidate = true;
  const idempotencyKey = newIdempotencyKey();

  const refId = `ref-${row.valId}`;
  const refLabel = el('label', 'field-label', t('refunds.form.reference'));
  refLabel.htmlFor = refId;
  const refInput = el('input', 'field');
  refInput.id = refId;
  refInput.autocomplete = 'off';
  refInput.maxLength = 64;
  refInput.setAttribute('aria-describedby', `${refId}-hint`);
  const hint = el('p', 'text-body-sm text-on-surface-variant', t('refunds.form.referenceHint'));
  hint.id = `${refId}-hint`;

  const noteId = `note-${row.valId}`;
  const noteLabel = el('label', 'field-label', t('refunds.form.note'));
  noteLabel.htmlFor = noteId;
  const noteInput = el('textarea', 'field');
  noteInput.id = noteId;
  noteInput.rows = 2;
  noteInput.maxLength = 500;

  const formError = el('p', 'alert-error', '');
  formError.setAttribute('role', 'alert');
  formError.hidden = true;

  const confirmBtn = iconLabelButton('btn-primary min-h-[44px]', 'done_all', 'refunds.action.confirm');
  confirmBtn.type = 'submit';
  const cancelBtn = iconLabelButton('btn-outline min-h-[44px]', 'close', 'refunds.action.cancel');
  const buttons = el('div', 'flex flex-wrap gap-sm');
  buttons.append(confirmBtn, cancelBtn);

  form.append(refLabel, refInput, hint, noteLabel, noteInput, formError, buttons);

  cancelBtn.addEventListener('click', () => {
    form.remove();
    actionBtn.hidden = false;
    actionBtn.focus();
  });

  let submitting = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;
    const refundReference = refInput.value.trim();
    if (!REFERENCE_RE.test(refundReference)) {
      formError.textContent = t('refunds.err.reference');
      formError.hidden = false;
      refInput.setAttribute('aria-invalid', 'true');
      refInput.focus();
      return;
    }
    refInput.removeAttribute('aria-invalid');
    formError.hidden = true;
    submitting = true;
    busy(confirmBtn, true, 'refunds.action.saving');
    try {
      await post(
        `/admin/refunds/${encodeURIComponent(row.ledgerId)}/${encodeURIComponent(row.valId)}/complete`,
        { refundReference, note: noteInput.value.trim() || undefined },
        { idempotencyKey }
      );
      showAlert('success', t('refunds.done'));
      await loadRefunds();
    } catch (err) {
      formError.textContent = messageFor(err);
      formError.hidden = false;
      if (err instanceof ApiError && err.status === 409) await loadRefunds();
    } finally {
      submitting = false;
      if (form.isConnected) busy(confirmBtn, false);
    }
  });

  card.append(form);
  refInput.focus();
}

function buildCard(row) {
  const li = el('li');
  const card = el('article', 'card p-lg flex flex-col gap-md');
  card.setAttribute('aria-label', `${formatTaka(row.amount)} · ${row.tranId}`);

  const head = el('div', 'flex flex-wrap items-start justify-between gap-sm');
  const left = el('div');
  left.append(
    el('p', 'text-h3 font-bold text-on-surface', formatTaka(row.amount)),
    el('p', 'text-body-sm text-on-surface-variant', t(`refunds.reason.${row.reason}`))
  );
  const refunded = Boolean(row.refundedAt);
  const badge = el('span', refunded
    ? 'badge-category bg-success/15 text-on-surface border border-success/40'
    : 'badge-category bg-cta-amber/20 text-on-surface border border-cta-amber',
  t(refunded ? 'refunds.status.refunded' : 'refunds.status.pending'));
  head.append(left, badge);

  const facts = el('dl', 'grid grid-cols-1 sm:grid-cols-2 gap-sm');
  facts.append(
    field('refunds.field.client', row.clientPhone),
    field('refunds.field.received', formatDate(row.receivedAt)),
    field('refunds.field.tranId', row.tranId, true),
    field('refunds.field.valId', row.valId, true)
  );
  if (refunded) {
    facts.append(
      field('refunds.field.reference', row.refundReference, true),
      field('refunds.field.refundedAt', formatDate(row.refundedAt))
    );
    if (row.refundNote) facts.append(field('refunds.field.note', row.refundNote));
  }

  card.append(head, facts);

  if (!refunded) {
    const actionBtn = iconLabelButton('btn-primary min-h-[44px] self-start', 'local_atm', 'refunds.action.record');
    actionBtn.addEventListener('click', () => {
      actionBtn.hidden = true;
      buildForm(row, card, actionBtn);
    });
    card.append(actionBtn);
  }

  li.append(card);
  return li;
}

function render() {
  const list = $('refund-list');
  list.replaceChildren(...rows.map(buildCard));
  $('empty').hidden = rows.length > 0;
  $('truncated').hidden = !truncated;
  const owed = rows.filter((r) => !r.refundedAt).reduce((sum, r) => sum + r.amount, 0);
  $('summary').textContent = t('refunds.summary', { count: rows.length, amount: formatTaka(owed) });
}

function refreshChips() {
  for (const btn of $('filter-bar').querySelectorAll('button')) {
    const active = btn.dataset.filter === currentFilter;
    btn.className = `${active ? 'chip-active' : 'chip'} min-h-[44px]`;
    btn.setAttribute('aria-pressed', String(active));
  }
}

async function loadRefunds() {
  const seq = ++fetchSeq;
  refreshChips();
  let data;
  try {
    data = await get(`/admin/refunds?status=${encodeURIComponent(currentFilter)}`);
  } catch (err) {
    if (seq === fetchSeq) showAlert('error', messageFor(err));
    return;
  }
  if (seq !== fetchSeq) return; // a newer filter click superseded this response
  rows = (data && data.data && data.data.refunds) || [];
  truncated = Boolean(data && data.data && data.data.truncated);
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

  for (const btn of $('filter-bar').querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.filter === currentFilter) return;
      currentFilter = btn.dataset.filter;
      showAlert(null);
      loadRefunds();
    });
  }

  try {
    await loadRefunds();
    $('loading').hidden = true;
    $('content').hidden = false;
  } catch (_) {
    $('loading').hidden = true;
    const bootError = $('boot-error');
    bootError.textContent = t('err.generic');
    bootError.hidden = false;
  }
})();
