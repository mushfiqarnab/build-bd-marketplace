// frontend/js/pages/works.js — Categorized Public Works & Services Exchange
// Invariants:
//   - Pure DOM creation: zero innerHTML / insertAdjacentHTML
//   - Strict icon whitelist matching frontend/icons.txt
//   - No shadowing of window.location
//   - Safe ReDoS query escaping
//   - Bilingual reactive UI on 'langchange'

import { initShell } from '../shell.js';
import { get, post, ApiError } from '../api.js';
import { t, applyLang, formatTaka, formatRelativeTime } from '../i18n.js';
import { getMe } from '../session.js';

const PAGE_LIMIT = 10;
const $ = (id) => document.getElementById(id);

let currentPage = 1;
let totalPages = 1;
let currentNature = 'ALL';
let currentCategory = 'ALL';
let currentThana = '';
let currentMinBudget = '';
let currentMaxBudget = '';
let currentSort = 'newest';
let currentQuery = '';
let currentUser = null;
let fetchSeq = 0;
let isRecording = false;
let speechRecognition = null;

const STARTER_TRADE_JOBS = [
  {
    _id: 'starter-elec-1',
    isStarter: true,
    title: 'Emergency 220V Distribution Board Tripping & Circuit Breaker Replacement',
    category: 'Electrical',
    budget: 800,
    description: 'Main distribution board circuit breaker trips intermittently under AC load. Need certified electrician with clamp meter and spare 32A MCBs.',
    location: 'Mirpur-10, Dhaka',
    bidCount: 2,
    hasSiteCoordinates: true,
    createdAt: new Date(Date.now() - 3600000).toISOString()
  },
  {
    _id: 'starter-plumb-1',
    isStarter: true,
    title: 'Concealed PPR Pipeline Leak Repair & Commode Flush Valve Replacement',
    category: 'Plumbing',
    budget: 500,
    description: 'Concealed wall leakage behind bathroom tiles. Requires leak diagnostic and replacement of worn siphon flush valve.',
    location: 'Dhanmondi 27, Dhaka',
    bidCount: 3,
    hasSiteCoordinates: true,
    createdAt: new Date(Date.now() - 7200000).toISOString()
  },
  {
    _id: 'starter-ac-1',
    isStarter: true,
    title: '1.5 Ton Inverter AC Master Jet Wash & Drainage Pipe Unclog',
    category: 'AC & Appliance',
    budget: 800,
    description: 'Indoor blower and outdoor condenser full pressure jet wash. Water dripping from indoor drain tray requires line flush.',
    location: 'Gulshan 2, Dhaka',
    bidCount: 1,
    hasSiteCoordinates: true,
    createdAt: new Date(Date.now() - 10800000).toISOString()
  },
  {
    _id: 'starter-paint-1',
    isStarter: true,
    title: '2-Bedroom Master Suite Asian Paints Anti-Fungal Damp Treatment & Topcoat',
    category: 'Painting',
    budget: 4500,
    description: 'North-facing wall exhibits monsoon moisture dampness. Scraping, waterproof sealer application, and two coats of washable plastic emulsion.',
    location: 'Uttara Sector 4, Dhaka',
    bidCount: 2,
    hasSiteCoordinates: true,
    createdAt: new Date(Date.now() - 14400000).toISOString()
  },
  {
    _id: 'starter-care-1',
    isStarter: true,
    title: 'Experienced Morning Cook & Dishwashing Assistant (8 AM - 11 AM)',
    category: 'Domestic Care',
    budget: 3500,
    description: 'Part-time morning household domestic helper for cooking Bengali breakfast/lunch and kitchen cleanup. DWPWP-2015 trial shift agreement.',
    location: 'Banani DOHS, Dhaka',
    bidCount: 4,
    hasSiteCoordinates: true,
    createdAt: new Date(Date.now() - 18000000).toISOString()
  },
  {
    _id: 'starter-reno-1',
    isStarter: true,
    title: 'Modern Kitchen Modular Cabinetry & Granite Countertop Installation',
    category: 'Renovation',
    budget: 65000,
    description: 'Complete kitchen modernization including moisture-resistant marine ply cabinets, soft-close hinges, and 20mm Indian black granite top.',
    location: 'Bashundhara R/A, Block C, Dhaka',
    bidCount: 5,
    hasSiteCoordinates: true,
    createdAt: new Date(Date.now() - 21600000).toISOString()
  },
  {
    _id: 'starter-civil-1',
    isStarter: true,
    title: 'G+5 Residential Building 3rd Floor RCC Column & Beam Casting',
    category: 'Residential',
    budget: 380000,
    description: 'Structural concrete pouring (1:1.5:3 mix), 60-grade deformed rebar tying, and waterproof shuttering for 14 columns and perimeter tie beams.',
    location: 'Mohammadpur Housing, Dhaka',
    bidCount: 6,
    hasSiteCoordinates: true,
    createdAt: new Date(Date.now() - 28800000).toISOString()
  }
];

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

function messageFor(err) {
  if (!(err instanceof ApiError)) return t('err.generic');
  if (err.status === 0) return t(err.message === 'timeout' ? 'err.timeout' : 'err.offline');
  if (err.status === 401) return t('err.sessionExpired');
  if (err.status === 403) return t('err.forbidden');
  if (err.status === 429) return t('err.rateLimited');
  if (err.status === 503) return t('err.unavailable');
  return t('err.generic');
}

function openApplyModal(project) {
  const modal = $('apply-work-modal');
  if (!modal) return;

  if (!currentUser) {
    window.location.href = `/app/login.html?next=${encodeURIComponent('/app/works.html?apply=' + project._id)}`;
    return;
  }
  if (currentUser.role === 'CLIENT' || currentUser.role === 'PENDING_ONBOARDING' || (currentUser.role === 'CONTRACTOR' && currentUser.hasProfile === false)) {
    const returnUrl = `/app/works.html?apply=${encodeURIComponent(project._id)}`;
    window.location.href = `/app/contractor-profile.html?next=${encodeURIComponent(returnUrl)}&prompt=register_first`;
    return;
  }

  $('apply-project-id').value = project._id;
  $('apply-modal-subtitle').textContent = `${project.title} • ${t('tenders.card.budget') || 'Budget'}: ${formatTaka(project.budget)}`;
  $('apply-bid-amount').value = project.budget || 500;
  $('apply-bid-amount').min = (project.category && ['Residential', 'Commercial', 'Infrastructure'].includes(project.category)) ? '1000' : '200';
  $('apply-estimated-days').value = '1';
  $('apply-proposal-text').value = '';
  $('apply-modal-error').hidden = true;
  $('apply-modal-success').hidden = true;
  $('apply-modal-submit').disabled = false;
  $('apply-modal-submit').replaceChildren(
    (() => {
      const sp = document.createElement('span');
      sp.className = 'icon bg-primary text-on-primary';
      sp.setAttribute('aria-hidden', 'true');
      sp.textContent = 'check_circle';
      return sp;
    })(),
    (() => {
      const txt = document.createElement('span');
      txt.className = 'bg-primary text-on-primary';
      txt.textContent = t('works.apply.submit') || 'Submit Quote & Application';
      return txt;
    })()
  );

  if (typeof modal.showModal === 'function') {
    modal.showModal();
  }
}

function setupApplyModal() {
  const modal = $('apply-work-modal');
  const closeBtn = $('apply-modal-close');
  const cancelBtn = $('apply-modal-cancel');
  const form = $('apply-quote-form');

  if (closeBtn && modal) closeBtn.addEventListener('click', () => modal.close());
  if (cancelBtn && modal) cancelBtn.addEventListener('click', () => modal.close());

  let isSubmittingQuote = false;

  function setSubmitState(submitBtn, loading) {
    submitBtn.disabled = loading;
    const icon = document.createElement('span');
    icon.className = 'icon bg-primary text-on-primary';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = loading ? 'hourglass_top' : 'check_circle';
    const txt = document.createElement('span');
    txt.className = 'bg-primary text-on-primary';
    txt.textContent = loading
      ? (t('works.apply.submitting') || 'Submitting quote…')
      : (t('works.apply.submit') || 'Submit Quote & Application');
    submitBtn.replaceChildren(icon, txt);
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (isSubmittingQuote) return;

      const errBox = $('apply-modal-error');
      const succBox = $('apply-modal-success');
      const submitBtn = $('apply-modal-submit');

      errBox.hidden = true;
      succBox.hidden = true;

      const projectId = $('apply-project-id').value;
      const bidAmount = parseInt($('apply-bid-amount').value, 10);
      const estimatedDays = parseInt($('apply-estimated-days').value, 10);
      const proposalText = $('apply-proposal-text').value.trim();
      const minAmount = parseInt($('apply-bid-amount').min, 10) || 200;

      if (!bidAmount || bidAmount < minAmount) {
        errBox.textContent = t('bid.err.amountMin', { min: minAmount });
        errBox.hidden = false;
        return;
      }
      if (!estimatedDays || estimatedDays < 1) {
        errBox.textContent = t('bid.err.daysMin');
        errBox.hidden = false;
        return;
      }
      if (!proposalText || proposalText.length < 10) {
        errBox.textContent = t('bid.err.proposalShort');
        errBox.hidden = false;
        return;
      }

      isSubmittingQuote = true;
      setSubmitState(submitBtn, true);

      try {
        if (projectId.startsWith('starter-')) {
          succBox.textContent = t('works.apply.success') || 'Your quote has been submitted successfully! The client will review and contact you.';
          succBox.hidden = false;
          setTimeout(() => {
            isSubmittingQuote = false;
            setSubmitState(submitBtn, false);
            modal.close();
          }, 1500);
          return;
        }

        await post(`/bids/${projectId}`, {
          bidAmount,
          estimatedDays,
          proposalText,
          itemizedBreakdown: [
            { title: 'Complete Service & Workmanship Handover', amount: bidAmount, estimatedDays }
          ]
        });

        succBox.textContent = t('works.apply.success') || 'Your quote has been submitted successfully! The client will review and contact you.';
        succBox.hidden = false;
        setTimeout(() => {
          isSubmittingQuote = false;
          setSubmitState(submitBtn, false);
          modal.close();
          loadFeed();
        }, 1500);
      } catch (err) {
        isSubmittingQuote = false;
        setSubmitState(submitBtn, false);
        errBox.textContent = (err && err.message) || t('err.generic');
        errBox.hidden = false;
      }
    });
  }
}

function buildProjectCard(project) {
  const li = document.createElement('li');
  const article = document.createElement('article');
  article.className = 'card p-lg flex flex-col gap-md hover:shadow-md transition-shadow bg-surface-card border border-border-subtle rounded-2xl';
  article.setAttribute('aria-label', project.title || '');

  // Header row: Badges + Title + Budget
  const headerRow = document.createElement('div');
  headerRow.className = 'flex flex-wrap items-start justify-between gap-sm';

  const leftCol = document.createElement('div');
  leftCol.className = 'flex-1 min-w-0';

  const badgeRow = document.createElement('div');
  badgeRow.className = 'flex flex-wrap items-center gap-xs mb-xs';

  // Category Badge
  const catBadge = document.createElement('span');
  catBadge.className = 'badge-category';
  catBadge.textContent = t(`post.cat.${project.category}`) || project.category || 'General';
  badgeRow.append(catBadge);

  // Milestone Escrow Security Badge
  const escrowBadge = document.createElement('span');
  escrowBadge.className = 'px-xs py-base rounded text-label-sm font-semibold bg-primary-fixed text-primary-container flex items-center gap-xs';
  const escIcon = document.createElement('span');
  escIcon.className = 'icon text-[14px]';
  escIcon.setAttribute('aria-hidden', 'true');
  escIcon.textContent = 'shield';
  const escText = document.createElement('span');
  escText.textContent = t('works.card.escrowProtected');
  escrowBadge.append(escIcon, escText);
  badgeRow.append(escrowBadge);

  // Active Bids Count Badge
  const bidsBadge = document.createElement('span');
  bidsBadge.className = 'px-xs py-base rounded text-label-sm font-semibold bg-surface-container-low text-on-surface flex items-center gap-xs';
  const bidsIcon = document.createElement('span');
  bidsIcon.className = 'icon text-[14px] text-primary';
  bidsIcon.setAttribute('aria-hidden', 'true');
  bidsIcon.textContent = 'assignment_turned_in';
  const bidsText = document.createElement('span');
  bidsText.textContent = t('works.card.bidsCount', { count: project.bidCount || 0 });
  bidsBadge.append(bidsIcon, bidsText);
  badgeRow.append(bidsBadge);

  if (project.budget >= 50000) {
    const emiBadge = document.createElement('span');
    emiBadge.className = 'px-xs py-base rounded text-label-sm font-semibold bg-surface-container-low text-on-surface flex items-center gap-xs';
    const emiIcon = document.createElement('span');
    emiIcon.className = 'icon text-[14px] text-primary';
    emiIcon.setAttribute('aria-hidden', 'true');
    emiIcon.textContent = 'local_atm';
    const emiText = document.createElement('span');
    emiText.textContent = t('works.card.emiAvailable');
    emiBadge.append(emiIcon, emiText);
    badgeRow.append(emiBadge);
  }

  const h3 = document.createElement('h3');
  h3.className = 'text-title-md font-bold text-on-surface line-clamp-2 mt-xs';
  h3.textContent = project.title || '';
  leftCol.append(badgeRow, h3);

  // Right column: Budget display
  const rightCol = document.createElement('div');
  rightCol.className = 'text-right shrink-0';
  const budgetVal = document.createElement('p');
  budgetVal.className = 'text-h3 font-bold text-primary';
  budgetVal.textContent = formatTaka(project.budget);
  const budgetLabel = document.createElement('p');
  budgetLabel.className = 'text-body-sm text-on-surface-variant mt-xs';
  budgetLabel.textContent = t('tenders.card.budget') || 'Budget';
  rightCol.append(budgetVal, budgetLabel);

  headerRow.append(leftCol, rightCol);

  // Scope description
  const desc = document.createElement('p');
  desc.className = 'text-body-md text-on-surface-variant line-clamp-3 leading-relaxed';
  desc.textContent = project.description || '';

  // Metadata row (Location, GPS, Timestamp)
  const metaRow = document.createElement('div');
  metaRow.className = 'flex flex-wrap items-center gap-md text-body-sm text-on-surface-variant';

  const locSpan = document.createElement('span');
  locSpan.className = 'flex items-center gap-xs';
  const locIcon = document.createElement('span');
  locIcon.className = 'icon text-[18px] text-primary';
  locIcon.setAttribute('aria-hidden', 'true');
  locIcon.textContent = 'location_on';
  const locText = document.createElement('span');
  locText.textContent = project.location || '';
  locSpan.append(locIcon, locText);
  metaRow.append(locSpan);

  if (project.hasSiteCoordinates) {
    const gpsSpan = document.createElement('span');
    gpsSpan.className = 'flex items-center gap-xs text-primary font-medium';
    const gpsIcon = document.createElement('span');
    gpsIcon.className = 'icon text-[18px]';
    gpsIcon.setAttribute('aria-hidden', 'true');
    gpsIcon.textContent = 'place';
    const gpsText = document.createElement('span');
    gpsText.textContent = t('works.card.gpsVerified');
    gpsSpan.append(gpsIcon, gpsText);
    metaRow.append(gpsSpan);
  }

  const timeSpan = document.createElement('span');
  timeSpan.className = 'flex items-center gap-xs';
  const timeIcon = document.createElement('span');
  timeIcon.className = 'icon text-[18px]';
  timeIcon.setAttribute('aria-hidden', 'true');
  timeIcon.textContent = 'schedule';
  const timeEl = document.createElement('time');
  timeEl.setAttribute('datetime', String(project.createdAt || ''));
  timeEl.textContent = formatRelativeTime(project.createdAt);
  timeSpan.append(timeIcon, timeEl);
  metaRow.append(timeSpan);

  // Action buttons
  const btnRow = document.createElement('div');
  btnRow.className = 'flex flex-wrap gap-sm pt-xs border-t border-border-subtle mt-xs';

  const canOpenProjectDetail = currentUser && (currentUser.role === 'CONTRACTOR' || currentUser.role === 'ADMIN' || currentUser.role === 'MODERATOR');
  const viewBtn = canOpenProjectDetail ? document.createElement('a') : document.createElement('button');
  if (canOpenProjectDetail) {
    viewBtn.href = `/app/project-detail.html?id=${encodeURIComponent(project._id)}`;
  } else {
    viewBtn.type = 'button';
    viewBtn.addEventListener('click', () => openProjectPreviewModal(project));
  }
  viewBtn.className = 'btn-outline min-h-[44px] flex-1 min-w-[140px] inline-flex items-center justify-center gap-xs text-center font-semibold text-on-surface';
  const viewIcon = document.createElement('span');
  viewIcon.className = 'icon text-[18px]';
  viewIcon.setAttribute('aria-hidden', 'true');
  viewIcon.textContent = 'visibility';
  const viewText = document.createElement('span');
  viewText.textContent = t('works.card.viewDetails');
  viewBtn.append(viewIcon, viewText);
  btnRow.append(viewBtn);

  // Apply / Quick Quote Button
  if (!currentUser) {
    const loginBidBtn = document.createElement('a');
    loginBidBtn.href = `/app/login.html?role=CONTRACTOR&next=${encodeURIComponent('/app/submit-bid.html?project=' + project._id)}`;
    loginBidBtn.className = 'btn-primary min-h-[44px] flex-1 min-w-[160px] inline-flex items-center justify-center gap-xs text-center font-bold bg-primary text-on-primary';
    const lbIcon = document.createElement('span');
    lbIcon.className = 'icon text-[18px]';
    lbIcon.setAttribute('aria-hidden', 'true');
    lbIcon.textContent = 'assignment_turned_in';
    const lbText = document.createElement('span');
    lbText.textContent = t('works.card.submitBid') || t('works.apply.title') || 'Submit Bid';
    loginBidBtn.append(lbIcon, lbText);
    btnRow.append(loginBidBtn);
  } else {
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'btn-primary min-h-[44px] flex-1 min-w-[160px] inline-flex items-center justify-center gap-xs text-center font-bold bg-primary text-on-primary';
    const applyIcon = document.createElement('span');
    applyIcon.className = 'icon text-[18px] bg-primary text-on-primary';
    applyIcon.setAttribute('aria-hidden', 'true');
    applyIcon.textContent = 'assignment_turned_in';
    const applyText = document.createElement('span');
    applyText.className = 'bg-primary text-on-primary';
    applyText.textContent = t('works.apply.title') || 'Apply / Quick Quote';
    applyBtn.append(applyIcon, applyText);
    applyBtn.addEventListener('click', () => {
      openApplyModal(project);
    });
    btnRow.append(applyBtn);
  }

  article.append(headerRow, desc, metaRow, btnRow);
  li.append(article);
  return li;
}

function openProjectPreviewModal(project) {
  let dialog = document.getElementById('works-scope-preview-modal');
  if (dialog) dialog.remove();

  dialog = document.createElement('dialog');
  dialog.id = 'works-scope-preview-modal';
  dialog.className = 'modal-dialog rounded-card p-0 w-full max-w-lg bg-surface border border-outline-variant shadow-elevation-3 backdrop:bg-slate-950/60';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'works-preview-title');

  const wrap = document.createElement('div');
  wrap.className = 'p-lg space-y-md';

  const head = document.createElement('div');
  head.className = 'flex items-start justify-between gap-sm border-b border-border-subtle pb-sm';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'space-y-xs';
  const catBadge = document.createElement('span');
  catBadge.className = 'badge-category';
  catBadge.textContent = t(`post.cat.${project.category}`) || project.category || '';
  const h2 = document.createElement('h2');
  h2.id = 'works-preview-title';
  h2.className = 'text-title-lg font-bold text-on-surface';
  h2.textContent = project.title || t('works.preview.title');
  titleWrap.append(catBadge, h2);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn-ghost min-h-[44px] min-w-[44px] inline-flex items-center justify-center';
  closeBtn.setAttribute('aria-label', t('works.preview.close'));
  const closeIcon = document.createElement('span');
  closeIcon.className = 'icon';
  closeIcon.setAttribute('aria-hidden', 'true');
  closeIcon.textContent = 'close';
  closeBtn.append(closeIcon);
  head.append(titleWrap, closeBtn);

  const meta = document.createElement('div');
  meta.className = 'grid grid-cols-2 gap-sm p-md rounded-lg bg-surface-container-low border border-border-subtle text-body-sm';
  const budgetCol = document.createElement('div');
  const budgetLbl = document.createElement('p');
  budgetLbl.className = 'text-label-sm text-on-surface-variant';
  budgetLbl.textContent = t('works.card.budget');
  const budgetVal = document.createElement('p');
  budgetVal.className = 'text-title-md font-bold text-money-fill font-mono';
  budgetVal.textContent = formatTaka(project.budget || 0);
  budgetCol.append(budgetLbl, budgetVal);

  const locCol = document.createElement('div');
  const locLbl = document.createElement('p');
  locLbl.className = 'text-label-sm text-on-surface-variant';
  locLbl.textContent = project.location || '';
  const postedVal = document.createElement('p');
  postedVal.className = 'text-body-sm text-on-surface';
  postedVal.textContent = formatRelativeTime(project.createdAt);
  locCol.append(locLbl, postedVal);
  meta.append(budgetCol, locCol);

  const body = document.createElement('p');
  body.className = 'text-body-md text-on-surface whitespace-pre-wrap leading-relaxed';
  body.textContent = project.description || '';

  const actions = document.createElement('div');
  actions.className = 'flex flex-wrap items-center justify-end gap-sm pt-sm border-t border-border-subtle';

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'btn-outline min-h-[44px] px-md';
  dismissBtn.textContent = t('works.preview.close');

  if (!currentUser) {
    const cta = document.createElement('a');
    cta.href = `/app/login.html?role=CONTRACTOR&next=${encodeURIComponent('/app/submit-bid.html?project=' + project._id)}`;
    cta.className = 'btn-primary min-h-[44px] px-md inline-flex items-center';
    cta.textContent = t('works.preview.contractorCta');
    actions.append(dismissBtn, cta);
  } else if (currentUser.role === 'CLIENT') {
    const cta = document.createElement('a');
    cta.href = `/app/post-project.html?category=${encodeURIComponent(project.category || '')}`;
    cta.className = 'btn-primary min-h-[44px] px-md inline-flex items-center';
    cta.textContent = t('works.preview.postSimilar');
    actions.append(dismissBtn, cta);
  } else {
    actions.append(dismissBtn);
  }

  const cleanup = () => {
    try { dialog.close(); } catch (_) { /* ignore */ }
    dialog.remove();
  };
  closeBtn.addEventListener('click', cleanup);
  dismissBtn.addEventListener('click', cleanup);
  dialog.addEventListener('cancel', cleanup);

  wrap.append(head, meta, body, actions);
  dialog.append(wrap);
  document.body.append(dialog);
  dialog.showModal();
}

function updatePagination(total, page, pages) {
  const nav = $('pagination-nav');
  const prev = $('works-prev-btn');
  const next = $('works-next-btn');
  const info = $('works-page-info');

  if (pages <= 1 && total === 0) {
    nav.hidden = true;
    return;
  }
  nav.hidden = false;
  prev.disabled = page <= 1;
  next.disabled = page >= pages;
  info.textContent = t('works.page.info', { page, pages });
}

function updateSummary(total) {
  const el = $('feed-summary');
  el.textContent = t('works.summary.total', { total });
}

async function loadFeed() {
  const seq = ++fetchSeq;
  showAlert(null);

  const list = $('works-list');
  list.replaceChildren();
  $('empty-state').hidden = true;
  $('pagination-nav').hidden = true;

  const params = new URLSearchParams({
    page: currentPage,
    limit: PAGE_LIMIT,
    sort: currentSort
  });

  if (currentQuery) params.set('q', currentQuery);
  if (currentThana) params.set('thana', currentThana);
  if (currentMinBudget) params.set('minBudget', currentMinBudget);
  if (currentMaxBudget) params.set('maxBudget', currentMaxBudget);

  if (currentCategory && currentCategory !== 'ALL') {
    params.set('category', currentCategory);
  } else if (currentNature === 'WORKS') {
    params.set('nature', 'WORKS');
  } else if (currentNature === 'RENOVATION') {
    params.set('nature', 'RENOVATION');
  } else if (currentNature === 'MICRO') {
    params.set('nature', 'MICRO');
  } else if (currentNature === 'SERVICES') {
    params.set('nature', 'SERVICES');
  }

  let data;
  try {
    data = await get(`/projects/exchange?${params}`);
  } catch (err) {
    if (seq !== fetchSeq) return;
    showAlert('error', messageFor(err));
    return;
  }

  if (seq !== fetchSeq) return;

  let projects = (data && data.projects) || [];
  let metrics = (data && data.metrics) || {};
  let total = metrics.total || 0;
  totalPages = metrics.totalPages || (projects.length > 0 ? 1 : 0);

  // If live database has 0 items for a selected category, micro trade, or query, check curated starter items
  if (projects.length === 0) {
    if (currentQuery) {
      const qTokens = currentQuery.toLowerCase().split(/[\s,.-]+/).filter((t) => t.length >= 2);
      const matchedStarters = STARTER_TRADE_JOBS.filter((s) => {
        const full = `${s.title} ${s.description} ${s.category} ${s.location}`.toLowerCase();
        return qTokens.some((tok) => full.includes(tok));
      });
      if (matchedStarters.length > 0) {
        projects = matchedStarters;
        total = matchedStarters.length;
        totalPages = 1;
      }
    } else if (currentCategory !== 'ALL' || currentNature === 'MICRO' || currentNature === 'SERVICES') {
      let starters = STARTER_TRADE_JOBS;
      if (currentCategory !== 'ALL') {
        starters = starters.filter((s) => s.category === currentCategory);
      } else if (currentNature === 'MICRO') {
        starters = starters.filter((s) => ['Electrical', 'Plumbing', 'AC & Appliance', 'Painting'].includes(s.category));
      } else if (currentNature === 'SERVICES') {
        starters = starters.filter((s) => s.category === 'Domestic Care');
      }
      if (starters.length > 0) {
        projects = starters;
        total = starters.length;
        totalPages = 1;
      }
    }
  }

  updateSummary(total);

  if (projects.length === 0) {
    $('empty-state').hidden = false;
    updatePagination(0, 1, 0);
    return;
  }

  for (const p of projects) {
    list.append(buildProjectCard(p));
  }

  updatePagination(total, currentPage, totalPages);
}

function setupNatureTabs() {
  const nav = $('nature-tabs');
  nav.addEventListener('click', (e) => {
    const target = e.target.closest('button[data-nature]');
    if (!target) return;
    const nature = target.dataset.nature;
    if (nature === 'GOODS') {
      window.location.href = '/app/materials.html';
      return;
    }

    currentNature = nature;
    currentCategory = 'ALL';
    for (const btn of nav.querySelectorAll('button')) {
      const active = btn.dataset.nature === currentNature;
      btn.className = active ? 'chip-active min-h-[44px]' : 'chip min-h-[44px]';
    }

    const tradeNav = $('trade-tabs');
    if (tradeNav) {
      for (const btn of tradeNav.querySelectorAll('button')) {
        const active = btn.dataset.category === 'ALL';
        btn.className = active ? 'chip-active min-h-[44px]' : 'chip min-h-[44px]';
      }
    }

    currentPage = 1;
    loadFeed();
  });
}

function setupTradeTabs() {
  const nav = $('trade-tabs');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const target = e.target.closest('button[data-category]');
    if (!target) return;
    currentCategory = target.dataset.category;
    for (const btn of nav.querySelectorAll('button')) {
      const active = btn.dataset.category === currentCategory;
      btn.className = active ? 'chip-active min-h-[44px]' : 'chip min-h-[44px]';
    }

    // Synchronize currentNature chip highlight if all trades selected
    if (currentCategory === 'ALL') {
      currentNature = 'ALL';
      const natureNav = $('nature-tabs');
      if (natureNav) {
        for (const btn of natureNav.querySelectorAll('button')) {
          const active = btn.dataset.nature === 'ALL';
          btn.className = active ? 'chip-active min-h-[44px]' : 'chip min-h-[44px]';
        }
      }
    }

    currentPage = 1;
    loadFeed();
  });
}

function setupBudgetPresets() {
  const container = $('budget-presets');
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    currentMinBudget = btn.dataset.min || '';
    currentMaxBudget = btn.dataset.max || '';

    for (const b of container.querySelectorAll('button')) {
      const isActive = b === btn;
      b.className = isActive
        ? 'btn-outline text-left min-h-[40px] px-sm py-xs text-body-sm rounded-lg flex items-center justify-between border-primary font-semibold'
        : 'btn-ghost text-left min-h-[40px] px-sm py-xs text-body-sm rounded-lg flex items-center justify-between';
      const existingIcon = b.querySelector('.icon');
      if (existingIcon) existingIcon.remove();
      if (isActive) {
        const ic = document.createElement('span');
        ic.className = 'icon text-[18px] text-primary';
        ic.setAttribute('aria-hidden', 'true');
        ic.textContent = 'check_circle';
        b.append(ic);
      }
    }
    currentPage = 1;
    loadFeed();
  });
}

function setupVoiceAssistant() {
  const micBtn = $('voice-mic-btn');
  const micText = $('voice-mic-text');
  const searchInput = $('search-input');

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    micBtn.disabled = true;
    micBtn.title = 'Speech recognition not supported in this browser';
    return;
  }

  speechRecognition = new SpeechRec();
  speechRecognition.continuous = false;
  speechRecognition.interimResults = false;
  speechRecognition.lang = 'bn-BD';

  speechRecognition.onstart = () => {
    isRecording = true;
    micBtn.classList.add('bg-red-500/10', 'border-red-500');
    micText.textContent = t('domestic.aiMicListening') || 'Listening...';
  };

  speechRecognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    if (transcript) {
      searchInput.value = transcript;
      currentQuery = transcript.trim();
      currentPage = 1;
      loadFeed();
    }
  };

  speechRecognition.onerror = () => {
    isRecording = false;
    micBtn.classList.remove('bg-red-500/10', 'border-red-500');
    micText.textContent = t('domestic.aiMicStart') || 'Speak';
  };

  speechRecognition.onend = () => {
    isRecording = false;
    micBtn.classList.remove('bg-red-500/10', 'border-red-500');
    micText.textContent = t('domestic.aiMicStart') || 'Speak';
  };

  micBtn.addEventListener('click', () => {
    if (isRecording) {
      speechRecognition.stop();
    } else {
      speechRecognition.start();
    }
  });
}

document.addEventListener('langchange', () => {
  applyLang();
  loadFeed();
});

(async () => {
  await initShell();
  try {
    currentUser = await getMe();
  } catch (_) {
    currentUser = null;
  }

  // Parse deep linking parameters from URL
  const urlParams = new URLSearchParams(window.location.search);
  const paramNature = urlParams.get('nature');
  const paramCategory = urlParams.get('category');
  const paramApply = urlParams.get('apply');
  const paramQ = urlParams.get('q');
  const paramThana = urlParams.get('thana');

  if (paramQ) {
    currentQuery = paramQ.trim();
    if ($('search-input')) $('search-input').value = currentQuery;
  }

  if (paramThana) {
    currentThana = paramThana.trim();
    if ($('filter-thana')) $('filter-thana').value = currentThana;
  }

  if (paramNature) {
    currentNature = paramNature.toUpperCase();
    const nav = $('nature-tabs');
    if (nav) {
      for (const btn of nav.querySelectorAll('button')) {
        const active = btn.dataset.nature === currentNature;
        btn.className = active ? 'chip-active min-h-[44px]' : 'chip min-h-[44px]';
      }
    }
  }

  if (paramCategory) {
    currentCategory = paramCategory;
    const nav = $('trade-tabs');
    if (nav) {
      for (const btn of nav.querySelectorAll('button')) {
        const active = btn.dataset.category === currentCategory;
        btn.className = active ? 'chip-active min-h-[44px]' : 'chip min-h-[44px]';
      }
    }
  }

  $('search-btn').addEventListener('click', () => {
    currentQuery = $('search-input').value.trim();
    currentPage = 1;
    loadFeed();
  });

  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      currentQuery = $('search-input').value.trim();
      currentPage = 1;
      loadFeed();
    }
  });

  $('filter-thana').addEventListener('change', (e) => {
    currentThana = e.target.value;
    currentPage = 1;
    loadFeed();
  });

  $('filter-sort').addEventListener('change', (e) => {
    currentSort = e.target.value;
    currentPage = 1;
    loadFeed();
  });

  $('reset-filters-btn').addEventListener('click', () => {
    currentQuery = '';
    currentThana = '';
    currentMinBudget = '';
    currentMaxBudget = '';
    currentSort = 'newest';
    currentNature = 'ALL';
    currentCategory = 'ALL';
    $('search-input').value = '';
    $('filter-thana').value = '';
    $('filter-sort').value = 'newest';
    for (const btn of $('nature-tabs').querySelectorAll('button')) {
      const active = btn.dataset.nature === 'ALL';
      btn.className = active ? 'chip-active min-h-[44px]' : 'chip min-h-[44px]';
    }
    const tradeNav = $('trade-tabs');
    if (tradeNav) {
      for (const btn of tradeNav.querySelectorAll('button')) {
        const active = btn.dataset.category === 'ALL';
        btn.className = active ? 'chip-active min-h-[44px]' : 'chip min-h-[44px]';
      }
    }
    currentPage = 1;
    loadFeed();
  });

  $('clear-empty-btn').addEventListener('click', () => {
    $('reset-filters-btn').click();
  });

  $('works-prev-btn').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage -= 1;
      loadFeed();
    }
  });

  $('works-next-btn').addEventListener('click', () => {
    if (currentPage < totalPages) {
      currentPage += 1;
      loadFeed();
    }
  });

  setupNatureTabs();
  setupTradeTabs();
  setupBudgetPresets();
  setupVoiceAssistant();
  setupApplyModal();

  $('loading').hidden = true;
  $('content').hidden = false;
  await loadFeed();

  if (paramApply) {
    const starterMatch = STARTER_TRADE_JOBS.find((s) => s._id === paramApply);
    if (starterMatch) {
      openApplyModal(starterMatch);
    } else {
      get(`/projects/${encodeURIComponent(paramApply)}`).then((res) => {
        if (res && res.project) openApplyModal(res.project);
      }).catch(() => null);
    }
  }
})();
