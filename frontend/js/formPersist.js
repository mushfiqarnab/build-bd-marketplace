// frontend/js/formPersist.js
// Auto-saves and restores form inputs across page refreshes (Google Forms-style persistence).
// Pure DOM, zero innerHTML, zero external dependencies, strict CSP compliant.
'use strict';

const STORAGE_PREFIX = 'bbd_draft_v1:';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEBOUNCE_MS = 200;

// Safe localStorage wrapper
export const draftStorage = {
  get(key) {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  },
  set(key, value) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      // Storage quota or disabled in private mode
    }
  },
  remove(key) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.removeItem(key);
    } catch (_) {}
  },
  keys() {
    try {
      if (typeof localStorage === 'undefined') return [];
      return Object.keys(localStorage);
    } catch (_) {
      return [];
    }
  }
};

/**
 * Checks whether an element should be excluded from persistence.
 * Excludes:
 *  - Passwords, file uploads, hidden inputs, buttons/submits
 *  - Explicit opt-outs: [data-no-persist], [data-persist="false"], .no-persist
 *  - Sensitive security inputs: OTP, verification codes, 2FA, PINs, tokens, captchas
 *  - Read-only or disabled fields
 */
export function isExcludedField(el) {
  if (!el || !el.tagName) return true;
  const tag = el.tagName.toUpperCase();
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return true;

  // Explicit opt-out via attribute or class
  if (typeof el.closest === 'function') {
    if (el.closest('[data-no-persist], [data-persist="false"], .no-persist')) return true;
  }

  const type = (el.type || '').toLowerCase();
  if (['password', 'file', 'hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return true;
  if (el.disabled || el.readOnly) return true;

  // Security exclusions: OTP, verification codes, 2FA, PINs, auth secrets
  const id = (el.id || '').toLowerCase();
  const name = (el.name || '').toLowerCase();
  const autocomplete = (el.autocomplete || '').toLowerCase();

  if (autocomplete === 'one-time-code' || autocomplete === 'current-password' || autocomplete === 'new-password') {
    return true;
  }

  const sensitiveRegex = /(^|[-_])(otp|code|mfa|token|captcha|pin|passcode)([-_]|$)/i;
  if (sensitiveRegex.test(id) || sensitiveRegex.test(name)) {
    return true;
  }

  const form = el.form;
  if (form) {
    const formId = (form.id || '').toLowerCase();
    const formName = (form.name || '').toLowerCase();
    if (sensitiveRegex.test(formId) || sensitiveRegex.test(formName)) {
      return true;
    }
  }

  return false;
}

/**
 * Generates a stable unique identifier for a field inside its form or scope.
 */
export function getFieldIdentifier(el, form) {
  if (el.name) return `name:${el.name}`;
  if (el.id) return `id:${el.id}`;
  const dataField = el.getAttribute && el.getAttribute('data-field');
  if (dataField) return `data:${dataField}`;

  const scope = form || (typeof document !== 'undefined' ? document.body : null);
  if (scope && scope.querySelectorAll) {
    const sameTag = Array.from(scope.querySelectorAll(el.tagName));
    const idx = sameTag.indexOf(el);
    return `idx:${el.tagName}:${el.type || ''}:${idx}`;
  }
  return null;
}

/**
 * Generates the storage key for a form or standalone fields on the current page.
 */
export function getDraftKey(form) {
  let path = '/';
  let search = '';
  if (typeof window !== 'undefined' && window.location) {
    path = window.location.pathname || '/';
    search = window.location.search || '';
  }
  const formKey = form ? (form.id || form.getAttribute?.('name') || 'default_form') : '_page_inputs_';
  return `${STORAGE_PREFIX}${path}${search}::${formKey}`;
}

/**
 * Extracts the persistable value from a single field element.
 */
function serializeFieldValue(el) {
  if (isExcludedField(el)) return null;
  const type = (el.type || '').toLowerCase();

  if (type === 'checkbox') {
    return { type: 'checkbox', checked: el.checked };
  }
  if (type === 'radio') {
    if (el.checked) {
      return { type: 'radio', value: el.value };
    }
    return null;
  }
  if (el.tagName === 'SELECT') {
    if (el.multiple) {
      return {
        type: 'select-multiple',
        values: Array.from(el.selectedOptions).map((o) => o.value)
      };
    }
    return { type: 'select', value: el.value };
  }
  return { type: 'text', value: el.value };
}

/**
 * Serializes all eligible fields within a form.
 */
export function serializeForm(form) {
  if (!form || (form.hasAttribute && form.hasAttribute('data-no-persist'))) return null;
  const elements = form.querySelectorAll ? form.querySelectorAll('input, textarea, select') : [];
  const fields = {};
  let count = 0;

  for (const el of elements) {
    if (isExcludedField(el)) continue;
    const key = getFieldIdentifier(el, form);
    if (!key) continue;

    const val = serializeFieldValue(el);
    if (val !== null) {
      if (val.type === 'radio' && !el.checked) continue;
      fields[key] = val;
      if (val.type === 'checkbox' && val.checked) count += 1;
      else if (val.type === 'radio') count += 1;
      else if (val.type === 'select-multiple' && val.values.length > 0) count += 1;
      else if (typeof val.value === 'string' && val.value.trim().length > 0) count += 1;
    }
  }

  return { fields, hasData: count > 0 };
}

/**
 * Saves a form draft into storage. If the form is completely empty, cleans up existing draft.
 */
export function saveFormDraft(form) {
  if (!form) return;
  const key = getDraftKey(form);
  const data = serializeForm(form);
  if (!data || !data.hasData) {
    draftStorage.remove(key);
  } else {
    draftStorage.set(key, { _ts: Date.now(), fields: data.fields });
  }
}

let isRestoring = false;

/**
 * Restores a stored field value onto an element.
 * Triggers 'input' and 'change' events so formatters and dynamic UI respond.
 */
function applyFieldValue(el, saved) {
  if (!el || !saved || isExcludedField(el)) return false;
  const type = (el.type || '').toLowerCase();
  let changed = false;

  if (type === 'checkbox') {
    const shouldBe = Boolean(saved.checked ?? saved);
    if (el.checked !== shouldBe) {
      el.checked = shouldBe;
      changed = true;
    }
  } else if (type === 'radio') {
    const targetVal = typeof saved === 'object' && saved !== null ? saved.value : saved;
    const shouldBe = el.value === targetVal;
    if (shouldBe && !el.checked) {
      el.checked = true;
      changed = true;
    }
  } else if (el.tagName === 'SELECT') {
    if (el.multiple && Array.isArray(saved.values || saved)) {
      const selected = new Set(saved.values || saved);
      for (const opt of el.options) {
        const shouldBe = selected.has(opt.value);
        if (opt.selected !== shouldBe) {
          opt.selected = shouldBe;
          changed = true;
        }
      }
    } else {
      const targetVal = typeof saved === 'object' && saved !== null ? saved.value : saved;
      if (targetVal !== undefined && targetVal !== null) {
        if (el.value !== targetVal) {
          el.value = targetVal;
          if (el.value === targetVal) {
            changed = true;
          } else {
            // Options might not be loaded yet asynchronously
            if (el.dataset) el.dataset.pendingDraftValue = targetVal;
          }
        }
      }
    }
  } else {
    const targetVal = typeof saved === 'object' && saved !== null ? saved.value : String(saved ?? '');
    if (targetVal !== undefined && targetVal !== null && el.value !== targetVal) {
      el.value = targetVal;
      changed = true;
    }
  }

  if (changed) {
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {}
  }
  return changed;
}

/**
 * Restores a form from its stored draft.
 */
export function restoreFormDraft(form) {
  if (!form || (form.hasAttribute && form.hasAttribute('data-no-persist'))) return false;
  const key = getDraftKey(form);
  const draft = draftStorage.get(key);
  if (!draft || !draft.fields) return false;

  isRestoring = true;
  let restoredAny = false;
  try {
    const elements = form.querySelectorAll ? form.querySelectorAll('input, textarea, select') : [];
    for (const el of elements) {
      if (isExcludedField(el)) continue;
      const idKey = getFieldIdentifier(el, form);
      if (idKey && draft.fields[idKey] !== undefined) {
        const res = applyFieldValue(el, draft.fields[idKey]);
        if (res) restoredAny = true;
      }
    }
  } finally {
    isRestoring = false;
  }
  return restoredAny;
}

/**
 * Explicitly clears the saved draft for a form.
 */
export function clearFormDraft(formOrSelector) {
  let form = null;
  if (typeof formOrSelector === 'string' && typeof document !== 'undefined') {
    form = document.querySelector(formOrSelector);
  } else {
    form = formOrSelector;
  }
  if (!form) return;
  const key = getDraftKey(form);
  draftStorage.remove(key);
}

/**
 * Restores all forms found in the given container (or document).
 */
export function restoreAllDrafts(root) {
  if (typeof document === 'undefined') return;
  const container = root || document;
  const forms = container.querySelectorAll ? container.querySelectorAll('form') : [];
  for (const form of forms) {
    restoreFormDraft(form);
  }

  // Also resolve any pending draft values on dynamic selects
  const pendingSelects = container.querySelectorAll ? container.querySelectorAll('select[data-pending-draft-value]') : [];
  for (const sel of pendingSelects) {
    const targetVal = sel.dataset.pendingDraftValue;
    if (targetVal && sel.options && sel.options.length > 0) {
      sel.value = targetVal;
      if (sel.value === targetVal) {
        delete sel.dataset.pendingDraftValue;
        try {
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_) {}
      }
    }
  }
}

/**
 * Prunes drafts older than MAX_AGE_MS.
 */
export function pruneExpiredDrafts() {
  const now = Date.now();
  const keys = draftStorage.keys();
  for (const k of keys) {
    if (k.startsWith(STORAGE_PREFIX)) {
      const data = draftStorage.get(k);
      if (!data || !data._ts || (now - data._ts > MAX_AGE_MS)) {
        draftStorage.remove(k);
      }
    }
  }
}

// Debounce map per form
const debounceTimers = new WeakMap();

function scheduleFormSave(form) {
  if (!form || isRestoring) return;
  if (debounceTimers.has(form)) {
    clearTimeout(debounceTimers.get(form));
  }
  const timer = setTimeout(() => {
    debounceTimers.delete(form);
    saveFormDraft(form);
  }, DEBOUNCE_MS);
  debounceTimers.set(form, timer);
}

let observerInitialized = false;

function setupMutationObserver() {
  if (observerInitialized || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
  observerInitialized = true;

  const observer = new MutationObserver((mutations) => {
    let needsRestore = false;
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes && m.addedNodes.length > 0) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            const tag = node.tagName;
            if (tag === 'FORM' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
                (node.querySelector && node.querySelector('form, input, textarea, select'))) {
              needsRestore = true;
              break;
            }
          }
        }
      } else if (m.type === 'attributes' && m.attributeName === 'hidden') {
        const target = m.target;
        if (target && !target.hidden) {
          needsRestore = true;
        }
      }
      if (needsRestore) break;
    }
    if (needsRestore) {
      restoreAllDrafts();
    }
  });

  const target = document.body || document.documentElement;
  if (target) {
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden']
    });
  }
}

/**
 * Initializes automatic form draft persistence for the whole document.
 */
export function initFormPersist() {
  if (typeof document === 'undefined') return;

  pruneExpiredDrafts();

  // Listen to input and change events via delegation
  document.addEventListener('input', (e) => {
    if (isRestoring) return;
    const target = e.target;
    if (isExcludedField(target)) return;
    const form = target.form || target.closest?.('form');
    if (form) scheduleFormSave(form);
  }, { passive: true });

  document.addEventListener('change', (e) => {
    if (isRestoring) return;
    const target = e.target;
    if (isExcludedField(target)) return;
    const form = target.form || target.closest?.('form');
    if (form) saveFormDraft(form);
  }, { passive: true });

  // Clear draft on explicit form reset
  document.addEventListener('reset', (e) => {
    if (e.target && e.target.tagName === 'FORM') {
      clearFormDraft(e.target);
    }
  }, { passive: true, capture: true });

  // Listen for custom clear event
  document.addEventListener('draft:clear', (e) => {
    const form = e.detail?.form || e.target;
    if (form) clearFormDraft(form);
  }, { passive: true });

  // Restore on initial load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      restoreAllDrafts();
      setupMutationObserver();
    });
  } else {
    restoreAllDrafts();
    setupMutationObserver();
  }
}

// Auto-run when loaded as module in browser
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  initFormPersist();
}
