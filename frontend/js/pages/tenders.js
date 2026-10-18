// F5 — Tenders / Open Projects list. CONTRACTOR-only.
//
// Data flow:
//   1. requireAuth({ roles: ['CONTRACTOR'] }) before any paint.
//   2. GET /api/environment → projectCategories to build filter chips.
//   3. GET /api/projects/open?category=&page=&limit= → paginated project cards.
//   4. GET /api/bids/mine → mark cards where contractor already placed a bid.
//
// Patterns inherited from F1 / F4 (Lane 1 audit invariants — DO NOT BREAK):
//   - All network calls via get() from ../api.js — window.fetch is never called directly.
//   - Always gate pages with initShell() and requireAuth({ roles }) before paint.
//   - Guard forms with a submitting flag + busy(btn, ...) on mutating buttons.
//   - Never declare a local 'location' variable — it shadows window.location.
//   - 100% i18n via data-i18n + MESSAGES.en + MESSAGES.bn.
//   - Only icons listed in frontend/icons.txt (build fails otherwise).
//   - Money: formatTaka(); dates: formatRelativeTime() / formatDate() from ../i18n.js.
//   - Bengali digit inputs: bengaliToAscii() from ../phone.js.



import { initShell } from '../shell.js';
import { get, ApiError } from '../api.js';
import { t, applyLang, formatTaka, formatRelativeTime } from '../i18n.js';
import { requireAuth } from '../session.js';

const PAGE_LIMIT = 10;

// ── DOM handles ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ── State ────────────────────────────────────────────────────────────────────
let currentPage = 1;
let currentCategory = ''; // '' = all
let totalPages = 1;
let myBidProjectIds = new Set(); // project IDs where this contractor already bid
let categories = [];

// ── Alert helpers ─────────────────────────────────────────────────────────────
function showAlert(kind, text) {
  const box = $('alert');
  box.replaceChildren();
  if (!text) { box.hidden = true; return; }
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

/** Maps ApiError → one clear translated sentence. */
function messageFor(err) {
  if (!(err instanceof ApiError)) return t('err.generic');
  if (err.status === 0) return t(err.message === 'timeout' ? 'err.timeout' : 'err.offline');
  if (err.status === 401) return t('err.sessionExpired');
  if (err.status === 403) return t('err.forbidden');
  if (err.status === 429) return t('err.rateLimited');
  if (err.status === 503) return t('err.unavailable');
  return t('err.generic');
}

// ── Filter chips ──────────────────────────────────────────────────────────────
function buildFilterBar() {
  const bar = $('filter-bar');
  bar.replaceChildren();

  // "All" chip
  const allChip = makeChip('', t('tenders.filter.all'));
  bar.append(allChip);

  for (const cat of categories) {
    bar.append(makeChip(cat, t(`post.cat.${cat}`) || cat));
  }
}

function makeChip(value, label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.category = value;
  btn.textContent = label;
  btn.setAttribute('role', 'tab');
  const active = value === currentCategory;
  btn.className = active ? 'chip-active' : 'chip';
  btn.setAttribute('aria-selected', String(active));
  btn.setAttribute('aria-pressed', String(active));
  btn.addEventListener('click', () => {
    if (currentCategory === value) return;
    currentCategory = value;
    currentPage = 1;
    loadPage();
  });
  return btn;
}

function refreshChipStates() {
  for (const btn of $('filter-bar').querySelectorAll('button')) {
    const active = btn.dataset.category === currentCategory;
    btn.className = active ? 'chip-active' : 'chip';
    btn.setAttribute('aria-selected', String(active));
    btn.setAttribute('aria-pressed', String(active));
  }
}

// ── Project cards ─────────────────────────────────────────────────────────────
/**
 * Builds one <li> card for a project.
 * Shape from GET /api/projects/open:
 *   { _id, title, category, description, location, budget, status, createdAt }
 */
function buildCard(project) {
  const li = document.createElement('li');
  const alreadyBid = myBidProjectIds.has(String(project._id));

  const article = document.createElement('article');
  article.className = 'card p-lg flex flex-col gap-md hover:shadow-md transition-shadow';
  article.setAttribute('aria-label', project.title || '');

  // Header row
  const headerRow = document.createElement('div');
  headerRow.className = 'flex flex-wrap items-start gap-sm justify-between';

  const leftCol = document.createElement('div');
  leftCol.className = 'flex-1 min-w-0';

  const badgeRow = document.createElement('div');
  badgeRow.className = 'flex flex-wrap items-center gap-xs mb-xs';

  const catBadge = document.createElement('span');
  catBadge.className = 'badge-category';
  catBadge.textContent = t(`post.cat.${project.category}`) || project.category;
  badgeRow.append(catBadge);

  if (alreadyBid) {
    const bidBadge = document.createElement('span');
    bidBadge.className = 'badge-bid-placed flex items-center gap-xs';
    const bidIcon = document.createElement('span');
    bidIcon.className = 'icon text-[14px]';
    bidIcon.setAttribute('aria-hidden', 'true');
    bidIcon.textContent = 'assignment_turned_in';
    const bidText = document.createElement('span');
    bidText.setAttribute('data-i18n', 'tenders.card.bidPlaced');
    bidText.textContent = t('tenders.card.bidPlaced');
    bidBadge.append(bidIcon, bidText);
    badgeRow.append(bidBadge);
  }

  const h2 = document.createElement('h2');
  h2.className = 'text-h3 text-on-surface line-clamp-2';
  h2.textContent = project.title || '';
  leftCol.append(badgeRow, h2);

  const rightCol = document.createElement('div');
  rightCol.className = 'text-right shrink-0';
  const budgetVal = document.createElement('p');
  budgetVal.className = 'text-label-lg text-primary font-semibold';
  budgetVal.textContent = formatTaka(project.budget);
  const budgetLabel = document.createElement('p');
  budgetLabel.className = 'text-body-sm text-on-surface-variant mt-xs';
  budgetLabel.textContent = t('tenders.card.budget');
  rightCol.append(budgetVal, budgetLabel);

  headerRow.append(leftCol, rightCol);

  // Description
  const desc = document.createElement('p');
  desc.className = 'text-body-md text-on-surface-variant line-clamp-3';
  desc.textContent = project.description || '';

  // Metadata row
  const metaRow = document.createElement('div');
  metaRow.className = 'flex flex-wrap items-center gap-md text-body-sm text-on-surface-variant';

  const locSpan = document.createElement('span');
  locSpan.className = 'flex items-center gap-xs';
  const locIcon = document.createElement('span');
  locIcon.className = 'icon text-[16px]';
  locIcon.setAttribute('aria-hidden', 'true');
  locIcon.textContent = 'location_on';
  const locText = document.createElement('span');
  locText.textContent = project.location || '';
  locSpan.append(locIcon, locText);

  const timeSpan = document.createElement('span');
  timeSpan.className = 'flex items-center gap-xs';
  const timeIcon = document.createElement('span');
  timeIcon.className = 'icon text-[16px]';
  timeIcon.setAttribute('aria-hidden', 'true');
  timeIcon.textContent = 'schedule';
  const timeEl = document.createElement('time');
  timeEl.setAttribute('datetime', String(project.createdAt || ''));
  timeEl.textContent = formatRelativeTime(project.createdAt);
  timeSpan.append(timeIcon, timeEl);

  metaRow.append(locSpan, timeSpan);

  if (project.hasSiteCoordinates) {
    const gpsSpan = document.createElement('span');
    gpsSpan.className = 'flex items-center gap-xs text-primary';
    gpsSpan.title = t('tenders.card.gpsVerified');
    const gpsIcon = document.createElement('span');
    gpsIcon.className = 'icon text-[16px]';
    gpsIcon.setAttribute('aria-hidden', 'true');
    gpsIcon.textContent = 'place';
    const gpsText = document.createElement('span');
    gpsText.setAttribute('data-i18n', 'tenders.card.gpsVerified');
    gpsText.textContent = t('tenders.card.gpsVerified');
    gpsSpan.append(gpsIcon, gpsText);
    metaRow.append(gpsSpan);
  }

  // Action buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'flex flex-wrap gap-sm mt-xs';

  const viewBtn = document.createElement('a');
  viewBtn.href = `/app/project-detail.html?id=${encodeURIComponent(project._id)}`;
  viewBtn.className = 'btn-outline flex-1 min-w-[140px] text-center';
  viewBtn.setAttribute('aria-label', `${t('tenders.card.view')} — ${project.title || ''}`);
  const viewIcon = document.createElement('span');
  viewIcon.className = 'icon';
  viewIcon.setAttribute('aria-hidden', 'true');
  viewIcon.textContent = 'visibility';
  const viewText = document.createElement('span');
  viewText.setAttribute('data-i18n', 'tenders.card.view');
  viewText.textContent = t('tenders.card.view');
  viewBtn.append(viewIcon, viewText);

  const bidBtn = document.createElement('a');
  bidBtn.href = `/app/submit-bid.html?project=${encodeURIComponent(project._id)}`;
  if (!alreadyBid) {
    bidBtn.className = 'btn-primary flex-1 min-w-[140px] text-center';
    bidBtn.setAttribute('aria-label', `${t('tenders.card.bid')} — ${project.title || ''}`);
    const bidLabel = document.createElement('span');
    bidLabel.setAttribute('data-i18n', 'tenders.card.bid');
    bidLabel.textContent = t('tenders.card.bid');
    const bidArrow = document.createElement('span');
    bidArrow.className = 'icon';
    bidArrow.setAttribute('aria-hidden', 'true');
    bidArrow.textContent = 'chevron_right';
    bidBtn.append(bidLabel, bidArrow);
  } else {
    bidBtn.className = 'btn-outline flex-1 min-w-[140px] text-center text-on-surface-variant';
    bidBtn.setAttribute('aria-label', `${t('tenders.card.viewBid')} — ${project.title || ''}`);
    const editIcon = document.createElement('span');
    editIcon.className = 'icon';
    editIcon.setAttribute('aria-hidden', 'true');
    editIcon.textContent = 'edit';
    const viewBidLabel = document.createElement('span');
    viewBidLabel.setAttribute('data-i18n', 'tenders.card.viewBid');
    viewBidLabel.textContent = t('tenders.card.viewBid');
    bidBtn.append(editIcon, viewBidLabel);
  }

  btnRow.append(viewBtn, bidBtn);

  article.append(headerRow, desc, metaRow, btnRow);
  li.append(article);
  return li;
}


// ── Pagination ────────────────────────────────────────────────────────────────
function updatePagination(total, page, pages) {
  const nav = $('pagination');
  const prev = $('prev-btn');
  const next = $('next-btn');
  const info = $('page-info');

  if (pages <= 1 && total === 0) {
    nav.hidden = true;
    return;
  }
  nav.hidden = false;
  prev.disabled = page <= 1;
  next.disabled = page >= pages;
  // e.g. "Page 2 of 5"
  info.textContent = t('tenders.page.info', { page, pages });
}

function updateSummary(total, category) {
  const el = $('result-summary');
  if (category) {
    el.textContent = t('tenders.summary.filtered', { total, cat: t(`post.cat.${category}`) || category });
  } else {
    el.textContent = t('tenders.summary.all', { total });
  }
}

// ── Main data fetch ───────────────────────────────────────────────────────────
let fetchSeq = 0; // used to discard stale responses when the user clicks quickly

async function loadPage() {
  const seq = ++fetchSeq;
  showAlert(null);
  refreshChipStates();

  // Show inline skeleton rows instead of resetting to full-page skeleton
  // so the filter chips stay visible during pagination flips.
  const list = $('project-list');
  list.replaceChildren();
  $('empty').hidden = true;
  $('pagination').hidden = true;

  // Build the query string
  const params = new URLSearchParams({ page: currentPage, limit: PAGE_LIMIT });
  if (currentCategory) params.set('category', currentCategory);

  let data;
  try {
    data = await get(`/projects/open?${params}`);
  } catch (err) {
    if (seq !== fetchSeq) return; // stale
    showAlert('error', messageFor(err));
    return;
  }

  if (seq !== fetchSeq) return; // stale: a newer request has superseded this one

  const projects = (data && data.projects) || [];
  const metrics = (data && data.metrics) || {};
  const total = metrics.total || 0;
  totalPages = metrics.totalPages || (projects.length > 0 ? 1 : 0);

  updateSummary(total, currentCategory);

  if (projects.length === 0) {
    $('empty').hidden = false;
    const clearBtn = $('clear-filter-btn');
    clearBtn.hidden = !currentCategory;
    updatePagination(0, 1, 0);
    return;
  }

  // Render cards — my bid set was pre-loaded at boot, no extra round-trip here.
  for (const p of projects) {
    list.append(buildCard(p));
  }

  updatePagination(total, currentPage, totalPages);
}

// ── Bid-mine prefetch ─────────────────────────────────────────────────────────
async function loadMyBids() {
  try {
    // GET /api/bids/mine → { bids: [...] } — available from bid.js route.
    const data = await get('/bids/mine');
    if (data && Array.isArray(data.bids)) {
      myBidProjectIds = new Set(
        data.bids
          .filter((b) => b.status !== 'WITHDRAWN')
          .map((b) => String((b.project && b.project._id) || b.projectId || ''))
          .filter(Boolean)
      );
    }
  } catch (_) {
    // Non-fatal: bid badge simply won't show for this session.
  }
}

// ── Language-change re-render ─────────────────────────────────────────────────
document.addEventListener('langchange', () => {
  applyLang();
  buildFilterBar(); // re-label category chips
  loadPage();       // re-render cards (date/money strings change locale)
});

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  await initShell();
  const me = await requireAuth({ roles: ['CONTRACTOR'] });
  if (!me) return;

  // Load categories and my bids in parallel — both are non-blocking for the
  // primary RFQ list but must be ready before we build cards.
  const [envResult] = await Promise.allSettled([
    get('/environment'),
    loadMyBids()
  ]);

  if (envResult.status === 'fulfilled') {
    const env = envResult.value;
    categories = (env && env.data && Array.isArray(env.data.projectCategories))
      ? env.data.projectCategories
      : ['Residential', 'Commercial', 'Infrastructure', 'Interior', 'Renovation'];
  } else {
    categories = ['Residential', 'Commercial', 'Infrastructure', 'Interior', 'Renovation'];
  }

  buildFilterBar();

  // Wire pagination buttons
  $('prev-btn').addEventListener('click', () => {
    if (currentPage > 1) { currentPage -= 1; loadPage(); }
  });
  $('next-btn').addEventListener('click', () => {
    if (currentPage < totalPages) { currentPage += 1; loadPage(); }
  });

  // Wire empty-state "clear filter" button
  $('clear-filter-btn').addEventListener('click', () => {
    currentCategory = '';
    currentPage = 1;
    loadPage();
  });

  // Reveal page and load first batch
  $('loading').hidden = true;
  $('content').hidden = false;
  await loadPage();
})();
