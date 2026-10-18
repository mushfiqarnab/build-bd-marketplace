// frontend/js/dialog.js — accessible modal dialog helper.
// Implements WAI-ARIA modal dialog pattern:
// - sets role="dialog" and aria-modal="true"
// - moves focus inside on open (first interactive element or close button)
// - traps Tab and Shift+Tab navigation within the dialog
// - closes on Escape key
// - restores focus to the opener element on close
// Pure DOM with zero external dependencies.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

const dialogStates = new WeakMap();

export function openDialog(dialog, opener) {
  if (!dialog) return;

  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.hidden = false;

  const previousFocus = opener || (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  // If native <dialog>, showModal ensures top-layer rendering and native backdrop
  if (typeof dialog.showModal === 'function' && !dialog.open) {
    try {
      dialog.showModal();
    } catch (_) {
      // already open or detached
    }
  }

  function handleKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeDialog(dialog);
      return;
    }

    if (event.key === 'Tab') {
      const focusables = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el.getClientRects().length > 0
      );
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (event.shiftKey) {
        if (document.activeElement === first || !dialog.contains(document.activeElement)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last || !dialog.contains(document.activeElement)) {
          event.preventDefault();
          first.focus();
        }
      }
    }
  }

  dialog.addEventListener('keydown', handleKeyDown);

  function handleCancel(event) {
    event.preventDefault();
    closeDialog(dialog);
  }
  dialog.addEventListener('cancel', handleCancel);

  dialogStates.set(dialog, {
    previousFocus,
    handleKeyDown,
    handleCancel
  });

  // Shift focus to the first focusable element
  requestAnimationFrame(() => {
    const focusables = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      (el) => el.offsetParent !== null || el.getClientRects().length > 0
    );
    if (focusables.length > 0) {
      focusables[0].focus();
    } else {
      dialog.tabIndex = -1;
      dialog.focus();
    }
  });
}

export function closeDialog(dialog) {
  if (!dialog) return;

  const state = dialogStates.get(dialog);
  if (state) {
    dialog.removeEventListener('keydown', state.handleKeyDown);
    dialog.removeEventListener('cancel', state.handleCancel);
    if (state.previousFocus && typeof state.previousFocus.focus === 'function') {
      state.previousFocus.focus();
    }
    dialogStates.delete(dialog);
  }

  if (typeof dialog.close === 'function' && dialog.open) {
    try {
      dialog.close();
    } catch (_) {}
  }
  dialog.hidden = true;
}
