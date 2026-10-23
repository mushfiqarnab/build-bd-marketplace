// F4 — Post a project. CLIENT-only, posts to /api/projects, then deep-links
// to the new project's detail page. Mirrors the F1 patterns: no raw fetch,
// i18n via data-i18n, aria-live on alerts, submit-race guard, BD-bbox + both-
// or-neither GPS validation (so the backend 400 is never surfaced to users).
import { initShell, clearFormDraft } from '../shell.js';
import { get, post, ApiError } from '../api.js';
import { t, applyLang, formatTaka, getLang } from '../i18n.js';
import { bengaliToAscii } from '../phone.js';
import { requireAuth } from '../session.js';

const $ = (id) => document.getElementById(id);
let CATEGORIES = [];
let submitting = false;

// Bangladesh bounding box — mirrors routes/project.js server-side check, so the
// user sees the error inline instead of a 400 round-trip. Keep in sync with
// BD_BOUNDS in routes/project.js.
const BD_BOUNDS = { minLat: 20.3, maxLat: 26.8, minLng: 87.9, maxLng: 92.8 };

function showAlert(kind, text) {
  const box = $('alert');
  box.replaceChildren();
  if (!text) { box.hidden = true; return; }
  const div = document.createElement('div');
  div.className = kind === 'error' ? 'alert-error' : kind === 'success' ? 'alert-success' : 'alert-info';
  const icon = document.createElement('span');
  icon.className = 'icon text-[20px]';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = kind === 'error' ? 'error' : kind === 'success' ? 'check_circle' : 'info';
  const msg = document.createElement('span');
  msg.textContent = text;
  div.append(icon, msg);
  box.append(div);
  box.hidden = false;
}

function fieldError(id, text) {
  const el = $(`${id}-error`);
  const input = $(id);
  el.textContent = text || '';
  el.hidden = !text;
  if (input) {
    if (text) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
}

function clearAllFieldErrors() {
  for (const id of ['title', 'category', 'location', 'budget', 'description', 'coords']) fieldError(id, '');
}

function busy(btn, on, labelKey) {
  btn.disabled = on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
  const label = btn.querySelector('[data-i18n]');
  if (label) label.textContent = t(on ? labelKey : label.dataset.i18n);
}

/** Parses a budget input accepting Bengali + ASCII digits, stripping commas
 *  and spaces. Returns an integer BDT or null on invalid input. */
function parseBudget(raw, min = 200) {
  const s = bengaliToAscii(String(raw || '')).replace(/[,\s]/g, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= min && n <= Number.MAX_SAFE_INTEGER ? n : null;
}

function parseCoord(raw) {
  const s = bengaliToAscii(String(raw || '')).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function populateCategories(list) {
  const sel = $('category');
  // Keep placeholder (first option), add the rest fresh.
  while (sel.options.length > 1) sel.remove(1);
  for (const cat of list) {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = t(`post.cat.${cat}`) || cat;
    sel.append(opt);
  }
}

/** Maps backend / transport errors to one clear, translated sentence. */
function messageFor(err) {
  if (!(err instanceof ApiError)) return t('err.generic');
  if (err.status === 0) return t(err.message === 'timeout' ? 'err.timeout' : 'err.offline');
  if (err.status === 401) return t('err.sessionExpired');
  if (err.status === 403) return t('err.forbidden');
  if (err.status === 429) return t('err.rateLimited');
  if (err.status === 503) return t('err.unavailable');
  // 400s: trust the backend's own message — short, action-oriented, authoritative.
  if (err.status === 400 && typeof err.message === 'string') return err.message;
  return t('err.generic');
}

// Live budget echo (e.g. "৳5,00,000") — reassurance that the number is read right.
$('budget').addEventListener('input', () => {
  const n = parseBudget($('budget').value);
  const el = $('budget-formatted');
  if (n === null || n === 0) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.textContent = formatTaka(n);
});

// Live character counter + min-length nudge for the description.
$('description').addEventListener('input', () => {
  const v = $('description').value || '';
  const count = v.trim().length;
  $('description-count').textContent = `${count} / 4000`;
});

// Geolocation fill — only populates if the browser's reported point is inside BD.
$('geo-btn').addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    fieldError('coords', t('post.err.geoUnsupported'));
    return;
  }
  const btn = $('geo-btn');
  busy(btn, true, 'post.locating');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      if (lat < BD_BOUNDS.minLat || lat > BD_BOUNDS.maxLat || lng < BD_BOUNDS.minLng || lng > BD_BOUNDS.maxLng) {
        fieldError('coords', t('post.err.coordsOutOfBd'));
      } else {
        $('lat').value = lat.toFixed(6);
        $('lng').value = lng.toFixed(6);
        fieldError('coords', '');
      }
      busy(btn, false);
    },
    (err) => {
      fieldError('coords', `${t('post.err.geoFailed')} ${err && err.message ? err.message : ''}`.trim());
      busy(btn, false);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitting) return;
  submitting = true;
  showAlert(null);
  clearAllFieldErrors();

  const title = $('title').value.trim();
  const category = $('category').value;
  const description = $('description').value.trim();
  const locationValue = $('location').value.trim();
  const isTrade = ['Electrical', 'Plumbing', 'AC & Appliance', 'Painting', 'Domestic Care'].includes(category);
  const minFloor = isTrade ? 200 : 1000;
  const budget = parseBudget($('budget').value, minFloor);
  const latRaw = $('lat').value.trim();
  const lngRaw = $('lng').value.trim();

  let firstError = null;
  const flag = (id, key) => { fieldError(id, t(key)); if (!firstError) firstError = $(id); };

  if (!title) flag('title', 'post.err.titleMissing');
  if (!category) flag('category', 'post.err.categoryMissing');
  if (!locationValue) flag('location', 'post.err.locationMissing');
  if (budget === null) flag('budget', 'post.err.budgetInvalid');
  if (!description) flag('description', 'post.err.descriptionMissing');
  else if (description.length < 20) flag('description', 'post.err.descriptionShort');

  // Coords: both-or-neither, both inside BD.
  const hasLat = latRaw !== '';
  const hasLng = lngRaw !== '';
  let coords = null;
  if (hasLat || hasLng) {
    if (hasLat !== hasLng) {
      fieldError('coords', t('post.err.coordsPair'));
      if (!firstError) firstError = $(hasLat ? 'lng' : 'lat');
    } else {
      const lat = parseCoord(latRaw);
      const lng = parseCoord(lngRaw);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        fieldError('coords', t('post.err.coordsInvalid'));
        if (!firstError) firstError = $('lat');
      } else if (lat < BD_BOUNDS.minLat || lat > BD_BOUNDS.maxLat || lng < BD_BOUNDS.minLng || lng > BD_BOUNDS.maxLng) {
        fieldError('coords', t('post.err.coordsOutOfBd'));
        if (!firstError) firstError = $('lat');
      } else {
        coords = { latitude: lat, longitude: lng };
      }
    }
  }

  if (firstError) {
    firstError.focus();
    submitting = false;
    return;
  }

  const btn = $('submit-btn');
  busy(btn, true, 'post.submitting');
  try {
    const body = { title, category, description, location: locationValue, budget };
    if (coords) body.siteCoordinates = coords;
    const res = await post('/projects', body);
    const projectId = res && res.project && res.project._id;
    showAlert('success', t('post.success'));
    clearFormDraft($('form'));
    // Short delay so the aria-live announcement is heard, then deep-link.
    setTimeout(() => {
      location.replace(projectId ? `/app/dashboard.html?project=${encodeURIComponent(projectId)}` : '/app/dashboard.html');
    }, 450);
  } catch (err) {
    showAlert('error', messageFor(err));
    busy(btn, false);
    submitting = false;
  }
});

let currentBoqEstimate = null;

function checkBoqVisibility() {
  const cat = $('category')?.value;
  const section = $('boq-estimator-section');
  if (!section) return;
  if (cat === 'Renovation' || cat === 'Interior') {
    section.classList.remove('hidden');
  } else {
    section.classList.add('hidden');
  }
}

function initBoqEstimator() {
  const catSel = $('category');
  const btnCalc = $('btn-calculate-boq');
  const btnApply = $('btn-apply-boq');

  if (catSel) {
    catSel.addEventListener('change', checkBoqVisibility);
  }

  if (btnCalc) {
    btnCalc.addEventListener('click', async () => {
      const categoryCode = $('boq-service-type')?.value || 'MID_PAINTING';
      const areaSqft = Number($('boq-area-sqft')?.value) || 1200;
      const thana = $('location')?.value?.trim() || 'Dhaka';

      try {
        btnCalc.disabled = true;
        btnCalc.textContent = t('post.locating') || 'Calculating...';

        const res = await post('/api/v2/projects/mid/estimate-boq', {
          categoryCode,
          areaSqft,
          thana
        });

        currentBoqEstimate = res?.data;
        const est = currentBoqEstimate?.pricingEstimate;
        const reply = currentBoqEstimate?.assistantReply;

        const matEl = $('boq-materials-val');
        const labEl = $('boq-labor-val');
        const totEl = $('boq-total-val');
        const textEl = $('boq-assistant-text');
        const panel = $('boq-result-panel');

        if (matEl) matEl.textContent = formatTaka(est?.materialsBdt || 0);
        if (labEl) labEl.textContent = formatTaka(est?.laborBdt || 0);
        if (totEl) totEl.textContent = formatTaka(est?.totalEstimatedBdt || 0);
        if (textEl && reply) {
          textEl.textContent = reply[getLang()] || reply.en || '';
        }

        if (panel) panel.classList.remove('hidden');
      } catch (err) {
        showAlert('error', messageFor(err));
      } finally {
        btnCalc.disabled = false;
        const iconSpan = document.createElement('span');
        iconSpan.className = 'icon text-[18px] text-primary';
        iconSpan.setAttribute('aria-hidden', 'true');
        iconSpan.textContent = 'engineering';
        btnCalc.replaceChildren(iconSpan, document.createTextNode(t('post.boq.estimateBtn') || 'Calculate BOQ Split'));
      }
    });
  }

  if (btnApply) {
    btnApply.addEventListener('click', () => {
      if (!currentBoqEstimate?.pricingEstimate) return;
      const est = currentBoqEstimate.pricingEstimate;
      const categoryCode = $('boq-service-type')?.value || 'MID_PAINTING';
      const areaSqft = Number($('boq-area-sqft')?.value) || 1200;
      const thana = $('location')?.value?.trim() || 'Dhaka';

      if (est.totalEstimatedBdt) {
        $('budget').value = est.totalEstimatedBdt;
        const bFormatted = $('budget-formatted');
        if (bFormatted) {
          bFormatted.hidden = false;
          bFormatted.textContent = formatTaka(est.totalEstimatedBdt);
        }
      }

      const serviceName = categoryCode === 'MID_PAINTING'
        ? 'Wall Painting & Putty'
        : (categoryCode === 'MID_SHIFTING' ? 'Home Shifting & Transport' : 'Deep Cleaning & Sanitization');

      const descText = `${serviceName} in ${thana} (${areaSqft} sq ft built-up area).\n` +
        `- Materials Budget: ${formatTaka(est.materialsBdt || 0)}\n` +
        `- Skilled Labor: ${formatTaka(est.laborBdt || 0)}\n` +
        `- Milestone Payout Mode: ${est.clearanceMode || 'MILESTONE_INSPECTION_ESCROW'}\n` +
        `- Workmanship & Safety: DWPWP-2015 & BNBC standards compliant.`;

      $('description').value = descText;
      const countEl = $('description-count');
      if (countEl) countEl.textContent = `${descText.length} / 4000`;

      if (!$('title').value.trim()) {
        $('title').value = `${serviceName} (${areaSqft} sq ft), ${thana}`;
      }

      showAlert('success', 'Estimated BOQ and budget applied to your project scope.');
      $('budget').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
}

// Re-render dynamic text on language toggle.
document.addEventListener('langchange', () => {
  applyLang();
  if (CATEGORIES.length) populateCategories(CATEGORIES);
  // Budget echo rerenders with the active digit set.
  const n = parseBudget($('budget').value);
  const el = $('budget-formatted');
  if (n !== null && n !== 0) el.textContent = formatTaka(n);
});

(async () => {
  await initShell();
  const me = await requireAuth({ roles: ['CLIENT'] });
  if (!me) return; // requireAuth already navigated

  // Load server-authoritative category list and limits.
  try {
    const env = await get('/environment');
    const pCats = env && env.data && Array.isArray(env.data.projectCategories) ? env.data.projectCategories : [];
    const tCats = env && env.data && Array.isArray(env.data.tradeCategories) ? env.data.tradeCategories : [];
    CATEGORIES = [...new Set([...pCats, ...tCats])];
  } catch (_) {
    // Fallback mirrors routes/project.js enum so the form is still usable offline.
    CATEGORIES = [
      'Residential', 'Commercial', 'Infrastructure', 'Interior', 'Renovation',
      'Electrical', 'Plumbing', 'AC & Appliance', 'Painting', 'Domestic Care'
    ];
  }
  populateCategories(CATEGORIES);

  // Wire Dual-Speed Mode Switcher
  const modeQuickBtn = $('mode-quick-btn');
  const modeCivilBtn = $('mode-civil-btn');
  const tmplBar = $('quick-templates-bar');

  function setMode(mode) {
    if (mode === 'quick') {
      if (modeQuickBtn) {
        modeQuickBtn.className = 'flex-1 min-h-[44px] px-md py-xs text-body-sm font-bold rounded-xl border border-primary-container bg-primary-fixed text-primary-container flex items-center justify-center gap-xs';
        modeQuickBtn.setAttribute('aria-selected', 'true');
      }
      if (modeCivilBtn) {
        modeCivilBtn.className = 'flex-1 min-h-[44px] px-md py-xs text-body-sm font-semibold rounded-xl border border-outline-variant bg-surface text-on-surface-variant flex items-center justify-center gap-xs';
        modeCivilBtn.setAttribute('aria-selected', 'false');
      }
      if (tmplBar) tmplBar.hidden = false;
    } else {
      if (modeCivilBtn) {
        modeCivilBtn.className = 'flex-1 min-h-[44px] px-md py-xs text-body-sm font-bold rounded-xl border border-primary-container bg-primary-fixed text-primary-container flex items-center justify-center gap-xs';
        modeCivilBtn.setAttribute('aria-selected', 'true');
      }
      if (modeQuickBtn) {
        modeQuickBtn.className = 'flex-1 min-h-[44px] px-md py-xs text-body-sm font-semibold rounded-xl border border-outline-variant bg-surface text-on-surface-variant flex items-center justify-center gap-xs';
        modeQuickBtn.setAttribute('aria-selected', 'false');
      }
      if (tmplBar) tmplBar.hidden = true;
    }
  }

  if (modeQuickBtn) modeQuickBtn.addEventListener('click', () => setMode('quick'));
  if (modeCivilBtn) modeCivilBtn.addEventListener('click', () => setMode('civil'));

  // Wire 1-Tap Quick Templates
  document.querySelectorAll('.quick-tmpl-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const { title, cat, budget, desc } = btn.dataset;
      if (title) $('title').value = title;
      if (cat && CATEGORIES.includes(cat)) $('category').value = cat;
      if (budget) {
        $('budget').value = budget;
        const n = parseBudget(budget, 200);
        const el = $('budget-formatted');
        if (n !== null && n !== 0) { el.hidden = false; el.textContent = formatTaka(n); }
      }
      if (desc) $('description').value = desc;
      $('location').focus();
      checkBoqVisibility();
    });
  });

  // Pre-fill from URL query params (e.g. from Landing Page Estimator or Probashi Hub)
  try {
    const params = new URLSearchParams(window.location.search);
    const qTitle = params.get('title');
    const qFloors = params.get('floors');
    const qSqft = params.get('sqft');
    const qCat = params.get('category');
    const qBudget = params.get('budget');
    if (!$('title').value) {
      if (qTitle) {
        $('title').value = qTitle;
      } else if (qFloors && qSqft) {
        $('title').value = `${qFloors}-Story Building Construction (${Number(qSqft).toLocaleString('en-US')} sq ft)`;
      }
    }
    if (qCat && CATEGORIES.includes(qCat) && !$('category').value) $('category').value = qCat;
    if (qBudget && !$('budget').value) {
      $('budget').value = qBudget;
      const n = parseBudget(qBudget);
      const el = $('budget-formatted');
      if (n !== null && n !== 0) { el.hidden = false; el.textContent = formatTaka(n); }
    }
  } catch (_) {}

  initBoqEstimator();
  checkBoqVisibility();

  // Reveal the form now that categories are in.
  $('loading').hidden = true;
  $('content').hidden = false;
  $('title').focus();
})();
