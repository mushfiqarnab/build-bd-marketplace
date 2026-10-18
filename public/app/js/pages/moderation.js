// Moderator & Admin Dispute Queue — review and resolve disputed contract milestones.
//
// Invariants (Lane 1 audit rules):
//   - Pure DOM (replaceChildren, append, createElement, textContent) — no innerHTML.
//   - Network via ../api.js (get, post, newIdempotencyKey).
//   - requireAuth({ roles: ['MODERATOR', 'ADMIN'] }) before content reveal.
//   - All copy via t() with en and bn keys.
//   - Dates via formatDate(), money via formatTaka().
//   - Accessible modal via openDialog / closeDialog from ../dialog.js.
//   - ONE idempotency key created per dispute resolve form and REUSED on retry.
//   - Live character counter on justification (minimum 20 characters enforced).

import { initShell } from '../shell.js';
import { get, post, ApiError, newIdempotencyKey } from '../api.js';
import { t, applyLang, formatTaka, formatDate } from '../i18n.js';
import { openDialog, closeDialog } from '../dialog.js';
import { requireAuth } from '../session.js';

const $ = (id) => document.getElementById(id);

let currentFilter = 'open';
let disputes = [];
let fetchSeq = 0;
let activeTicket = null;
let activeTicketId = null;
let resolveIdempotencyKey = newIdempotencyKey();
let resolving = false;

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

function showDossierAlert(text) {
  const box = $('dossier-alert');
  box.replaceChildren();
  if (!text) {
    box.hidden = true;
    return;
  }
  const div = document.createElement('div');
  div.className = 'flex items-center gap-xs';
  const icon = document.createElement('span');
  icon.className = 'icon text-[20px]';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'error';
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

function field(labelKey, value, mono = false) {
  const wrap = el('div', 'flex flex-col');
  wrap.append(
    el('dt', 'text-label-sm text-on-surface-variant', t(labelKey)),
    el('dd', `text-body-md text-on-surface ${mono ? 'font-mono' : ''} break-all`.trim(), value || '—')
  );
  return wrap;
}

function statusBadge(status) {
  let badgeClass = 'badge-category bg-surface-variant text-on-surface border border-outline-variant';
  if (status === 'OPEN_FOR_REVIEW' || status === 'MEDIATION_IN_PROGRESS') {
    badgeClass = 'badge-category bg-cta-amber/20 text-on-surface border border-cta-amber';
  } else if (status === 'RESOLVED_FORCE_APPROVED' || status === 'RESOLVED') {
    badgeClass = 'badge-category bg-success/15 text-on-surface border border-success/40';
  } else if (status === 'RESOLVED_CANCELLED') {
    badgeClass = 'badge-category bg-error/15 text-on-surface border border-error/40';
  }
  return el('span', badgeClass, status);
}

function updateCharCount(len) {
  const countEl = $('justification-count');
  countEl.textContent = `${len} / 20`;
  if (len < 20) {
    countEl.className = 'text-label-sm text-error font-mono';
  } else {
    countEl.className = 'text-label-sm text-money-fill font-mono font-medium';
  }
}

async function openDossier(ticketId, openerBtn) {
  activeTicketId = ticketId;
  resolveIdempotencyKey = newIdempotencyKey();
  showDossierAlert(null);
  $('justification-error').hidden = true;
  $('justification-input').value = '';
  updateCharCount(0);

  const modal = $('dossier-modal');
  openDialog(modal, openerBtn);

  try {
    const res = await get(`/moderation/dispute/${encodeURIComponent(ticketId)}`);
    const dossier = res && res.dossier;
    if (!dossier) throw new Error('Dossier not found');
    activeTicket = dossier;
    renderDossier(dossier);
  } catch (err) {
    showDossierAlert(err instanceof ApiError ? err.message : t('err.generic'));
  }
}

function renderDossier(ticket) {
  $('dossier-project').textContent = (ticket.projectId && ticket.projectId.title) || '—';

  const facts = $('dossier-facts');
  facts.replaceChildren();

  const clientPhone = ticket.clientId ? ticket.clientId.phoneNumber : '—';
  const contractorPhone = ticket.contractorId ? ticket.contractorId.phoneNumber : '—';
  const mIndex = ticket.milestoneIndex !== undefined ? `#${ticket.milestoneIndex + 1}` : '—';

  facts.append(
    field('moderation.dossier.client', clientPhone),
    field('moderation.dossier.contractor', contractorPhone),
    field('moderation.card.milestone', mIndex),
    field('moderation.card.opened', formatDate(ticket.createdAt))
  );

  $('dossier-reason').textContent = ticket.clientRejectionReason || '—';

  const evidenceBox = $('dossier-evidence-list');
  evidenceBox.replaceChildren();

  const evidenceItems = Array.isArray(ticket.evidenceLog) ? ticket.evidenceLog : [];
  if (evidenceItems.length === 0) {
    evidenceBox.append(el('p', 'text-body-sm text-on-surface-variant', t('moderation.dossier.noEvidence')));
  } else {
    for (const ev of evidenceItems) {
      const row = el('div', 'p-sm rounded-lg bg-surface border border-outline-variant flex flex-col gap-xs text-body-sm');
      const time = el('span', 'text-on-surface-variant font-mono', formatDate(ev.timestamp || ev.submittedAt));
      const tier = el('span', 'font-medium text-on-surface', ev.verificationTier || 'EVIDENCE');
      row.append(time, tier);
      if (ev.s3Key) {
        row.append(el('span', 'font-mono text-body-sm text-on-surface-variant break-all', ev.s3Key));
      }
      evidenceBox.append(row);
    }
  }

  const isOpen = ticket.status === 'OPEN_FOR_REVIEW' || ticket.status === 'MEDIATION_IN_PROGRESS';
  const resolveBox = $('dossier-resolve-box');
  const resolvedView = $('dossier-resolved-view');

  if (isOpen) {
    resolveBox.hidden = false;
    resolvedView.hidden = true;
  } else {
    resolveBox.hidden = true;
    resolvedView.hidden = false;
    const res = ticket.resolution || {};
    $('resolved-verdict').textContent = res.verdict || ticket.status;
    $('resolved-justification').textContent = res.justification || '—';
    $('resolved-date').textContent = res.resolvedAt ? formatDate(res.resolvedAt) : '';
  }
}

function buildCard(ticket) {
  const li = el('li');
  const card = el('article', 'card p-lg flex flex-col gap-md');

  const head = el('div', 'flex flex-wrap items-start justify-between gap-sm');
  const left = el('div');
  const title = ticket.projectTitle || t('moderation.card.project');
  const mIndex = ticket.milestoneIndex !== undefined ? ticket.milestoneIndex + 1 : 1;
  left.append(
    el('h2', 'text-h3 font-bold text-on-surface', title),
    el('p', 'text-body-sm text-on-surface-variant mt-xs', t('moderation.card.milestone', { index: mIndex }))
  );
  head.append(left, statusBadge(ticket.status));

  const facts = el('dl', 'grid grid-cols-1 sm:grid-cols-2 gap-sm');
  facts.append(
    field('moderation.card.opened', formatDate(ticket.openedAt)),
    field('moderation.card.reason', ticket.reason)
  );

  if (ticket.verdict) {
    facts.append(
      field('moderation.card.verdict', ticket.verdict),
      field('adminVerify.field.submitted', formatDate(ticket.resolvedAt))
    );
  }

  card.append(head, facts);

  const actionBtn = el('button', 'btn-primary min-h-[44px] self-start flex items-center gap-xs');
  actionBtn.type = 'button';
  const icon = el('span', 'icon', 'visibility');
  icon.setAttribute('aria-hidden', 'true');
  const label = el('span', '', t('moderation.action.openDossier'));
  actionBtn.append(icon, label);

  actionBtn.addEventListener('click', () => {
    openDossier(ticket.ticketId, actionBtn);
  });

  card.append(actionBtn);
  li.append(card);
  return li;
}

function render() {
  const list = $('dispute-list');
  list.replaceChildren(...disputes.map(buildCard));
  $('empty').hidden = disputes.length > 0;
  $('summary').textContent = t('moderation.summary', { count: disputes.length });
}

function refreshChips() {
  for (const btn of $('filter-bar').querySelectorAll('button')) {
    const active = btn.dataset.filter === currentFilter;
    btn.className = `${active ? 'chip-active' : 'chip'} min-h-[44px]`;
    btn.setAttribute('aria-selected', String(active));
    btn.setAttribute('aria-pressed', String(active));
  }
}

async function loadDisputes() {
  const seq = ++fetchSeq;
  refreshChips();
  let data;
  try {
    data = await get(`/moderation/disputes?status=${encodeURIComponent(currentFilter)}`);
  } catch (err) {
    if (seq === fetchSeq) showAlert('error', err instanceof ApiError ? err.message : t('err.generic'));
    return;
  }
  if (seq !== fetchSeq) return;
  disputes = (data && data.data && data.data.disputes) || [];
  render();
}

function wireDossierDialog() {
  const modal = $('dossier-modal');
  const closeBtn = $('dossier-close-btn');
  const form = $('resolve-form');
  const justInput = $('justification-input');
  const justErr = $('justification-error');
  const submitBtn = $('resolve-submit-btn');

  closeBtn.addEventListener('click', () => {
    closeDialog(modal);
  });

  justInput.addEventListener('input', () => {
    const len = justInput.value.trim().length;
    updateCharCount(len);
    if (len >= 20) {
      justErr.hidden = true;
      justInput.removeAttribute('aria-invalid');
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (resolving || !activeTicketId) return;

    const justification = justInput.value.trim();
    if (justification.length < 20) {
      justErr.textContent = t('moderation.err.justificationShort');
      justErr.hidden = false;
      justInput.setAttribute('aria-invalid', 'true');
      justInput.focus();
      return;
    }
    justErr.hidden = true;
    justInput.removeAttribute('aria-invalid');

    const verdict = form.elements.verdict.value || 'FORCE_APPROVE';

    resolving = true;
    showDossierAlert(null);
    busy(submitBtn, true, 'moderation.action.submittingVerdict');

    try {
      await post(
        `/moderation/dispute/${encodeURIComponent(activeTicketId)}/resolve`,
        { verdict, justification },
        { idempotencyKey: resolveIdempotencyKey }
      );

      resolveIdempotencyKey = newIdempotencyKey();
      closeDialog(modal);
      showAlert('success', t('moderation.success'));
      await loadDisputes();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        showDossierAlert(t('moderation.err.ticketAlreadyResolved'));
        await loadDisputes();
      } else {
        showDossierAlert(err instanceof ApiError ? err.message : t('err.generic'));
      }
    } finally {
      resolving = false;
      busy(submitBtn, false);
    }
  });
}

document.addEventListener('langchange', () => {
  applyLang();
  render();
  if (activeTicket && $('dossier-modal').open) {
    renderDossier(activeTicket);
  }
});

(async () => {
  await initShell();
  const me = await requireAuth({ roles: ['MODERATOR', 'ADMIN'] });
  if (!me) return;

  wireDossierDialog();

  for (const btn of $('filter-bar').querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.filter === currentFilter) return;
      currentFilter = btn.dataset.filter;
      showAlert(null);
      loadDisputes();
    });
  }

  try {
    await loadDisputes();
    $('loading').hidden = true;
    $('content').hidden = false;
  } catch (err) {
    $('loading').hidden = true;
    const bootError = $('boot-error');
    bootError.textContent = t('err.generic');
    bootError.hidden = false;
  }
})();
