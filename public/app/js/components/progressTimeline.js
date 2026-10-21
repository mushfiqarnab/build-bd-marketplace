// frontend/js/components/progressTimeline.js
// Pure DOM component: visual milestone progress timeline with evidence verification states
'use strict';

import { t, toBengaliDigits, getLang, formatTaka } from '../i18n.js';

/**
 * Renders a semantic, accessible milestone progress timeline.
 * Pure DOM, zero innerHTML.
 *
 * @param {Array<Object>} milestones
 * @param {Object} [options={}]
 * @param {boolean} [options.hideFinancials=false]
 * @returns {HTMLElement}
 */
export function renderProgressTimeline(milestones = [], options = {}) {
  const { hideFinancials = false } = options;

  const container = document.createElement('div');
  container.className = 'progress-timeline-wrapper space-y-md';

  if (!milestones || milestones.length === 0) {
    const emptyP = document.createElement('p');
    emptyP.className = 'text-body-sm text-on-surface-variant italic';
    emptyP.textContent = t('timeline.noMilestones') || 'No milestones formed yet.';
    container.appendChild(emptyP);
    return container;
  }

  const list = document.createElement('ol');
  list.className = 'relative border-l-2 border-outline-variant ml-sm space-y-lg';

  milestones.forEach((m, idx) => {
    const item = document.createElement('li');
    item.className = 'mb-md ml-md relative';

    // Step indicator icon
    const indicator = document.createElement('span');
    const isCompleted = m.status === 'COMPLETED';
    const isSubmitted = m.status === 'PROOF_SUBMITTED';
    const isInProgress = m.status === 'IN_PROGRESS';
    const isDisputed = m.status === 'DISPUTED';

    let iconName = 'schedule';
    let indicatorClasses = 'absolute -left-[33px] flex items-center justify-center w-7 h-7 rounded-full text-[16px] border-2 ';

    if (isCompleted) {
      iconName = 'check_circle';
      indicatorClasses += 'bg-success text-on-primary border-success';
    } else if (isDisputed) {
      iconName = 'warning';
      indicatorClasses += 'bg-error text-on-primary border-error';
    } else if (isSubmitted) {
      iconName = 'photo_camera';
      indicatorClasses += 'bg-secondary text-on-secondary border-secondary';
    } else if (isInProgress) {
      iconName = 'construction';
      indicatorClasses += 'bg-primary-container text-on-primary-container border-primary';
    } else {
      iconName = 'schedule';
      indicatorClasses += 'bg-surface-card text-on-surface-variant border-outline-variant';
    }

    indicator.className = indicatorClasses;
    const iconSpan = document.createElement('span');
    iconSpan.className = 'icon text-[16px]';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.textContent = iconName;
    indicator.appendChild(iconSpan);
    item.appendChild(indicator);

    // Card Content
    const card = document.createElement('div');
    card.className = 'p-sm sm:p-md rounded-card bg-surface-card border border-outline-variant shadow-elevation-1 space-y-xs';

    // Header row: Title + Status
    const topRow = document.createElement('div');
    topRow.className = 'flex items-start justify-between gap-sm flex-wrap';

    const titleGroup = document.createElement('div');
    titleGroup.className = 'flex items-center gap-xs flex-wrap';

    const indexBadge = document.createElement('span');
    indexBadge.className = 'text-label-sm font-bold text-on-surface-variant bg-surface-container px-xs py-[2px] rounded';
    const numDisplay = getLang() === 'bn' ? toBengaliDigits(idx + 1) : String(idx + 1);
    indexBadge.textContent = `#${numDisplay}`;

    const title = document.createElement('h4');
    title.className = 'text-title-sm font-semibold text-on-surface';
    title.textContent = m.title || `Milestone ${idx + 1}`;

    titleGroup.append(indexBadge, title);

    const statusBadge = document.createElement('span');
    statusBadge.className = 'badge-category text-[11px] font-bold ';
    if (isCompleted) {
      statusBadge.className += 'bg-success/15 text-on-surface border border-success/40';
      statusBadge.textContent = t('milestone.status.completed') || 'COMPLETED';
    } else if (isSubmitted) {
      statusBadge.className += 'bg-secondary/15 text-secondary border border-secondary/40';
      statusBadge.textContent = t('milestone.status.proofSubmitted') || 'PROOF SUBMITTED';
    } else if (isInProgress) {
      statusBadge.className += 'bg-primary-container/20 text-on-surface border border-primary/30';
      statusBadge.textContent = t('milestone.status.inProgress') || 'IN PROGRESS';
    } else if (isDisputed) {
      statusBadge.className += 'bg-error/15 text-error border border-error/40';
      statusBadge.textContent = t('milestone.status.disputed') || 'DISPUTED';
    } else {
      statusBadge.className += 'bg-surface-container text-on-surface-variant border border-outline-variant';
      statusBadge.textContent = t('milestone.status.pending') || 'PENDING';
    }

    topRow.append(titleGroup, statusBadge);
    card.appendChild(topRow);

    // Amount & Details row
    const metaRow = document.createElement('div');
    metaRow.className = 'flex items-center justify-between text-body-sm text-on-surface-variant pt-xs border-t border-border-subtle';

    if (!hideFinancials && (m.amount !== null && m.amount !== undefined)) {
      const amountSpan = document.createElement('span');
      amountSpan.className = 'font-semibold text-primary';
      amountSpan.textContent = formatTaka(m.amount);
      metaRow.appendChild(amountSpan);
    } else if (hideFinancials) {
      const hiddenSpan = document.createElement('span');
      hiddenSpan.className = 'text-[12px] italic text-on-surface-variant';
      hiddenSpan.textContent = t('timeline.financialsRedacted') || 'Financials Redacted';
      metaRow.appendChild(hiddenSpan);
    }

    // Evidence count badge
    const evidenceCount = m.evidenceCount || (Array.isArray(m.evidenceLog) ? m.evidenceLog.length : 0);
    if (evidenceCount > 0) {
      const proofBadge = document.createElement('span');
      proofBadge.className = 'inline-flex items-center gap-[4px] text-[12px] text-on-surface font-medium';
      const camIcon = document.createElement('span');
      camIcon.className = 'icon text-[14px] text-secondary';
      camIcon.setAttribute('aria-hidden', 'true');
      camIcon.textContent = 'photo_camera';
      const proofCountText = getLang() === 'bn' ? toBengaliDigits(evidenceCount) : String(evidenceCount);
      proofBadge.append(camIcon, document.createTextNode(`${proofCountText} ${t('timeline.photos') || 'photos'}`));
      metaRow.appendChild(proofBadge);
    }

    card.appendChild(metaRow);
    item.appendChild(card);
    list.appendChild(item);
  });

  container.appendChild(list);
  return container;
}
