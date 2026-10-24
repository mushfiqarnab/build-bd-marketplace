// frontend/js/components/confirmDialog.js
// Accessible pure-DOM confirmation modal replacing native dialog calls
// that get suppressed inside sandboxed preview iframes.
import { t } from '../i18n.js';

export function showConfirmDialog({
  title = '',
  message = '',
  confirmLabel = '',
  cancelLabel = '',
  danger = false
} = {}) {
  return new Promise((resolve) => {
    const existing = document.getElementById('bb-confirm-dialog');
    if (existing) existing.remove();

    const dialog = document.createElement('dialog');
    dialog.id = 'bb-confirm-dialog';
    dialog.className = 'modal-dialog rounded-card p-0 w-full max-w-md bg-surface border border-outline-variant shadow-elevation-3 backdrop:bg-slate-950/60';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'bb-confirm-title');

    const wrap = document.createElement('div');
    wrap.className = 'p-lg space-y-md';

    const header = document.createElement('div');
    header.className = 'flex items-start gap-sm';

    const icon = document.createElement('span');
    icon.className = danger ? 'icon text-danger text-[22px] mt-0.5' : 'icon text-primary text-[22px] mt-0.5';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = danger ? 'warning' : 'verified_user';

    const textCol = document.createElement('div');
    textCol.className = 'space-y-xs flex-1';

    const h2 = document.createElement('h2');
    h2.id = 'bb-confirm-title';
    h2.className = 'text-title-md font-bold text-on-surface';
    h2.textContent = title || t('dialog.confirmTitle');

    const desc = document.createElement('p');
    desc.className = 'text-body-sm text-on-surface-variant leading-relaxed';
    desc.textContent = message;

    textCol.append(h2, desc);
    header.append(icon, textCol);

    const actions = document.createElement('div');
    actions.className = 'flex items-center justify-end gap-sm pt-sm border-t border-border-subtle';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-outline min-h-[44px] px-md';
    cancelBtn.textContent = cancelLabel || t('dialog.cancel');

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = danger
      ? 'btn-danger min-h-[44px] px-md'
      : 'btn-primary min-h-[44px] px-md';
    confirmBtn.textContent = confirmLabel || t('dialog.confirm');

    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      try { dialog.close(); } catch (_) { /* ignore */ }
      dialog.remove();
      resolve(result);
    }

    cancelBtn.addEventListener('click', () => finish(false));
    confirmBtn.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(false);
    });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) finish(false);
    });

    actions.append(cancelBtn, confirmBtn);
    wrap.append(header, actions);
    dialog.append(wrap);
    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    confirmBtn.focus();
  });
}
