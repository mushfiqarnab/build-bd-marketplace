// frontend/js/components/moneyConfirmSheet.js
// 🧱 Phase 3: bKash-Style Money Confirm Sheet
// 2.5-second Tap-and-Hold confirmation modal to prevent accidental fund release.
// 100% pure DOM architecture (zero innerHTML/insertAdjacentHTML).
'use strict';

import { t, formatTaka } from '../i18n.js';

export function showMoneyConfirmSheet({
  title = t('moneySheet.title'),
  description = t('moneySheet.desc'),
  amount = null,
  confirmActionText = t('moneySheet.holdToConfirm'),
  onConfirm = () => {},
  onCancel = () => {}
}) {
  let dialog = document.getElementById('money-confirm-sheet');
  if (dialog) dialog.remove();

  dialog = document.createElement('dialog');
  dialog.id = 'money-confirm-sheet';
  dialog.className = 'modal-dialog rounded-t-2xl sm:rounded-card p-0 w-full max-w-md bg-surface border border-outline-variant shadow-elevation-3 backdrop:bg-slate-950/60 fixed bottom-0 sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 m-0 sm:m-auto';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'money-sheet-title');

  const wrapper = document.createElement('div');
  wrapper.className = 'p-lg space-y-md';

  // Handle bar for mobile sheet
  const handleBar = document.createElement('div');
  handleBar.className = 'w-12 h-1.5 rounded-full bg-outline-variant mx-auto sm:hidden';

  // Header row
  const header = document.createElement('div');
  header.className = 'flex items-start justify-between gap-sm';

  const titleGroup = document.createElement('div');
  const h2 = document.createElement('h2');
  h2.id = 'money-sheet-title';
  h2.className = 'text-title-md font-bold text-on-surface flex items-center gap-xs';

  const shieldIcon = document.createElement('span');
  shieldIcon.className = 'icon text-primary text-[22px]';
  shieldIcon.setAttribute('aria-hidden', 'true');
  shieldIcon.textContent = 'shield';

  const titleSpan = document.createElement('span');
  titleSpan.textContent = title;

  h2.append(shieldIcon, titleSpan);

  const descP = document.createElement('p');
  descP.className = 'text-body-sm text-on-surface-variant mt-xs';
  descP.textContent = description;

  titleGroup.append(h2, descP);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn-ghost min-h-[44px] min-w-[44px] flex items-center justify-center p-xs';
  closeBtn.setAttribute('aria-label', t('common.close'));

  const closeIcon = document.createElement('span');
  closeIcon.className = 'icon';
  closeIcon.setAttribute('aria-hidden', 'true');
  closeIcon.textContent = 'close';
  closeBtn.append(closeIcon);

  header.append(titleGroup, closeBtn);

  // Amount Highlight Box (if amount provided)
  let amountBox = null;
  if (amount !== null && typeof amount === 'number') {
    amountBox = document.createElement('div');
    amountBox.className = 'p-md rounded-card bg-surface-container-low border border-outline-variant text-center';

    const amtLabel = document.createElement('p');
    amtLabel.className = 'text-label-sm text-on-surface-variant uppercase tracking-wider';
    amtLabel.textContent = t('moneySheet.amountToRelease');

    const amtVal = document.createElement('p');
    amtVal.className = 'text-h2 font-bold text-money-fill mt-xs font-mono';
    amtVal.textContent = formatTaka(amount);

    amountBox.append(amtLabel, amtVal);
  }

  // Hold Action Container
  const actionContainer = document.createElement('div');
  actionContainer.className = 'space-y-sm pt-xs';

  const holdButton = document.createElement('button');
  holdButton.type = 'button';
  holdButton.className = 'relative overflow-hidden w-full min-h-[52px] rounded-lg bg-primary text-on-primary font-semibold text-body-md flex items-center justify-center gap-xs select-none touch-none shadow-elevation-1 focus:ring-2 focus:ring-primary focus:outline-none';
  holdButton.setAttribute('aria-describedby', 'hold-instructions');

  // Background progress fill bar
  const progressBar = document.createElement('div');
  progressBar.className = 'absolute inset-0 bg-primary-container opacity-40 transition-none w-0 pointer-events-none';
  progressBar.style.width = '0%';

  const buttonContent = document.createElement('div');
  buttonContent.className = 'relative z-10 flex items-center justify-center gap-xs pointer-events-none';

  const touchIcon = document.createElement('span');
  touchIcon.className = 'icon text-[20px]';
  touchIcon.setAttribute('aria-hidden', 'true');
  touchIcon.textContent = 'touch_app';

  const buttonText = document.createElement('span');
  buttonText.textContent = confirmActionText;

  buttonContent.append(touchIcon, buttonText);
  holdButton.append(progressBar, buttonContent);

  const instructions = document.createElement('p');
  instructions.id = 'hold-instructions';
  instructions.className = 'text-center text-[12px] text-on-surface-variant';
  instructions.textContent = t('moneySheet.holdHint');

  actionContainer.append(holdButton, instructions);

  // Assemble dialog
  wrapper.append(handleBar, header);
  if (amountBox) wrapper.append(amountBox);
  wrapper.append(actionContainer);
  dialog.append(wrapper);

  document.body.append(dialog);
  dialog.showModal();

  // 2.5-second Tap-and-Hold state machine
  const HOLD_DURATION_MS = 2500;
  let holdStartTime = null;
  let animationFrameId = null;
  let completed = false;

  function resetHold() {
    if (completed) return;
    holdStartTime = null;
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    progressBar.style.width = '0%';
    buttonText.textContent = confirmActionText;
  }

  function startHold(e) {
    if (completed) return;
    e.preventDefault();
    holdStartTime = performance.now();
    buttonText.textContent = t('moneySheet.holding');

    function step(now) {
      if (!holdStartTime || completed) return;
      const elapsed = now - holdStartTime;
      const progress = Math.min(100, (elapsed / HOLD_DURATION_MS) * 100);
      progressBar.style.width = `${progress}%`;

      if (progress >= 100) {
        completed = true;
        buttonText.textContent = t('moneySheet.confirmed');
        progressBar.style.width = '100%';
        dialog.close();
        dialog.remove();
        onConfirm();
      } else {
        animationFrameId = requestAnimationFrame(step);
      }
    }

    animationFrameId = requestAnimationFrame(step);
  }

  // Pointer & Touch Events
  holdButton.addEventListener('pointerdown', startHold);
  holdButton.addEventListener('pointerup', resetHold);
  holdButton.addEventListener('pointerleave', resetHold);
  holdButton.addEventListener('pointercancel', resetHold);

  // Keyboard accessibility: space or enter triggers hold timer
  holdButton.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !holdStartTime) {
      startHold(e);
    }
  });
  holdButton.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      resetHold();
    }
  });

  closeBtn.addEventListener('click', () => {
    resetHold();
    dialog.close();
    dialog.remove();
    onCancel();
  });

  dialog.addEventListener('cancel', () => {
    resetHold();
    dialog.remove();
    onCancel();
  });
}
