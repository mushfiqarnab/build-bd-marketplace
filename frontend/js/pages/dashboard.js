import { initShell } from '../shell.js';
import { requireAuth } from '../session.js';
import { get, ApiError } from '../api.js';
import { t, applyLang, formatTaka, formatRelativeTime } from '../i18n.js';

const ROLE_KEY = {
  CLIENT: 'role.client',
  CONTRACTOR: 'role.contractor',
  ADMIN: 'role.admin',
  MODERATOR: 'role.moderator'
};

const $ = (id) => document.getElementById(id);

let currentUser = null;
let dashboardData = null;
let activityData = null;

function errorKeyFor(err) {
  if (err instanceof ApiError) {
    if (err.status === 0) return err.message === 'timeout' ? 'err.timeout' : 'err.offline';
    if (err.status === 429) return 'err.rateLimited';
    if (err.status === 503) return 'err.unavailable';
  }
  return 'err.generic';
}

function handlePaymentBanner() {
  const urlParams = new URLSearchParams(window.location.search);
  const paymentStatus = urlParams.get('payment');
  const tranId = urlParams.get('tranId');

  const banner = $('payment-banner');
  const bannerBox = $('payment-banner-box');
  const icon = $('payment-banner-icon');
  const title = $('payment-banner-title');
  const desc = $('payment-banner-desc');
  const dismissBtn = $('payment-banner-dismiss');

  if (!paymentStatus) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  dismissBtn.addEventListener('click', () => {
    banner.hidden = true;
  });

  if (paymentStatus === 'success') {
    bannerBox.className = 'card p-md flex items-start gap-md border border-success/40 bg-success/10 text-on-surface';
    icon.className = 'icon text-label-lg text-success';
    icon.textContent = 'check_circle';
    title.textContent = t('dash.payment.success');
  } else if (paymentStatus === 'fail') {
    bannerBox.className = 'card p-md flex items-start gap-md border border-error/40 bg-error/10 text-on-surface';
    icon.className = 'icon text-label-lg text-error';
    icon.textContent = 'error';
    title.textContent = t('dash.payment.fail');
  } else if (paymentStatus === 'cancel') {
    bannerBox.className = 'card p-md flex items-start gap-md border border-amber-500/40 bg-amber-500/10 text-on-surface';
    icon.className = 'icon text-label-lg text-amber-500';
    icon.textContent = 'warning';
    title.textContent = t('dash.payment.cancel');
  } else {
    banner.hidden = true;
    return;
  }

  desc.textContent = tranId ? t('dash.payment.tranId', { tranId }) : '';
  desc.hidden = !tranId;
}

function renderWallet(wallet) {
  const walletSection = $('wallet-section');
  if (!wallet) {
    walletSection.hidden = true;
    return;
  }
  walletSection.hidden = false;
  $('wallet-locked').textContent = formatTaka(wallet.lockedEscrow || 0);
  $('wallet-pending').textContent = formatTaka(wallet.pendingClearance || 0);
  $('wallet-available').textContent = formatTaka(wallet.availableToWithdraw || 0);
}

function renderCounters(role, counters) {
  const grid = $('kpi-grid');
  grid.replaceChildren();

  if (!counters) return;

  const kpis = [];
  if (role === 'CLIENT') {
    kpis.push(
      { key: 'projectsOpen', label: t('dash.kpi.projectsOpen'), count: counters.projectsOpen || 0, icon: 'construction' },
      { key: 'projectsAssigned', label: t('dash.kpi.projectsAssigned'), count: counters.projectsAssigned || 0, icon: 'assignment_turned_in' },
      { key: 'bidsPending', label: t('dash.kpi.bidsPending'), count: counters.bidsPending || 0, icon: 'pending' },
      { key: 'awaitingFunding', label: t('dash.kpi.awaitingFunding'), count: counters.awaitingFunding || 0, icon: 'local_atm' },
      { key: 'inProgress', label: t('dash.kpi.inProgress'), count: counters.inProgress || 0, icon: 'engineering' },
      { key: 'disputed', label: t('dash.kpi.disputed'), count: counters.disputed || 0, icon: 'warning' },
      { key: 'settled', label: t('dash.kpi.settled'), count: counters.settled || 0, icon: 'verified_user' }
    );
  } else if (role === 'CONTRACTOR') {
    kpis.push(
      { key: 'myBidsPending', label: t('dash.kpi.myBidsPending'), count: counters.myBidsPending || 0, icon: 'pending' },
      { key: 'myBidsAccepted', label: t('dash.kpi.myBidsAccepted'), count: counters.myBidsAccepted || 0, icon: 'check_circle' },
      { key: 'myBidsRejected', label: t('dash.kpi.myBidsRejected'), count: counters.myBidsRejected || 0, icon: 'close' },
      { key: 'inProgress', label: t('dash.kpi.inProgress'), count: counters.inProgress || 0, icon: 'engineering' },
      { key: 'disputed', label: t('dash.kpi.disputed'), count: counters.disputed || 0, icon: 'warning' },
      { key: 'settled', label: t('dash.kpi.settled'), count: counters.settled || 0, icon: 'verified_user' }
    );
  }

  for (const kpi of kpis) {
    const card = document.createElement('div');
    card.className = 'card p-md border border-outline-variant hover:border-primary/50 transition-colors flex flex-col justify-between';

    const top = document.createElement('div');
    top.className = 'flex items-center justify-between mb-sm';

    const labelEl = document.createElement('span');
    labelEl.className = 'text-label-sm text-on-surface-variant font-medium';
    labelEl.textContent = kpi.label;

    const iconEl = document.createElement('span');
    iconEl.className = 'icon text-primary/70';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.textContent = kpi.icon;

    top.append(labelEl, iconEl);

    const numEl = document.createElement('p');
    numEl.className = 'text-h3 font-bold text-on-surface';
    numEl.textContent = String(kpi.count);

    card.append(top, numEl);
    grid.append(card);
  }
}

function renderActivity() {
  const list = $('activity-list');
  const empty = $('activity-empty');
  const countBadge = $('activity-count');
  const heading = $('activity-heading');
  const emptyText = $('activity-empty-text');

  list.replaceChildren();

  if (currentUser.role === 'CLIENT') {
    heading.textContent = t('dash.myProjects.title');
    const projects = activityData?.projects || [];

    if (projects.length === 0) {
      emptyText.textContent = t('dash.myProjects.empty');
      empty.hidden = false;
      countBadge.hidden = true;
      return;
    }

    empty.hidden = true;
    countBadge.textContent = String(projects.length);
    countBadge.hidden = false;

    for (const project of projects) {
      const card = document.createElement('article');
      card.className = 'card p-lg border border-border-subtle flex flex-col md:flex-row md:items-center justify-between gap-md';

      const info = document.createElement('div');
      info.className = 'space-y-xs';

      const header = document.createElement('div');
      header.className = 'flex flex-wrap items-center gap-xs';

      const titleEl = document.createElement('h3');
      titleEl.className = 'text-title-md font-semibold text-on-surface';
      titleEl.textContent = project.title;

      const statusBadge = document.createElement('span');
      statusBadge.className = 'badge-category';
      statusBadge.textContent = t(`project.status.${project.status}`) || project.status;

      header.append(titleEl, statusBadge);

      if (project.bidCount > 0) {
        const bidBadge = document.createElement('span');
        bidBadge.className = 'badge-bid-placed';
        bidBadge.textContent = t('dash.myProjects.bidsCount', { count: project.bidCount });
        header.append(bidBadge);
      }

      const meta = document.createElement('p');
      meta.className = 'text-body-sm text-on-surface-variant flex flex-wrap gap-md';
      const metaParts = [];
      if (project.category) metaParts.push(t(`cat.${project.category}`) || project.category);
      if (project.location) metaParts.push(project.location);
      metaParts.push(formatTaka(project.budget || 0));
      if (project.createdAt) metaParts.push(formatRelativeTime(project.createdAt));
      meta.textContent = metaParts.join(' · ');

      info.append(header, meta);

      const actions = document.createElement('div');
      actions.className = 'flex flex-wrap items-center gap-sm';

      const viewBtn = document.createElement('a');
      viewBtn.href = `/app/project-detail.html?id=${encodeURIComponent(project._id)}`;
      viewBtn.className = 'btn-outline min-h-[44px]';
      viewBtn.textContent = t('dash.myProjects.view');
      actions.append(viewBtn);

      if (project.status === 'ASSIGNED' || project.status === 'IN_PROGRESS' || project.status === 'COMPLETED') {
        const workspaceBtn = document.createElement('a');
        workspaceBtn.href = `/app/contract.html?id=${encodeURIComponent(project._id)}`;
        workspaceBtn.className = 'btn-primary min-h-[44px]';
        workspaceBtn.textContent = t('dash.myProjects.workspace');
        actions.append(workspaceBtn);
      }

      card.append(info, actions);
      list.append(card);
    }
  } else if (currentUser.role === 'CONTRACTOR') {
    heading.textContent = t('dash.myBids.title');
    const bids = activityData?.bids || [];

    if (bids.length === 0) {
      emptyText.textContent = t('dash.myBids.empty');
      empty.hidden = false;
      countBadge.hidden = true;
      return;
    }

    empty.hidden = true;
    countBadge.textContent = String(bids.length);
    countBadge.hidden = false;

    for (const bid of bids) {
      const card = document.createElement('article');
      card.className = 'card p-lg border border-border-subtle flex flex-col md:flex-row md:items-center justify-between gap-md';

      const info = document.createElement('div');
      info.className = 'space-y-xs';

      const header = document.createElement('div');
      header.className = 'flex flex-wrap items-center gap-xs';

      const titleEl = document.createElement('h3');
      titleEl.className = 'text-title-md font-semibold text-on-surface';
      titleEl.textContent = bid.project?.title || t('bid.title');

      const statusBadge = document.createElement('span');
      statusBadge.className = 'badge-category';
      statusBadge.textContent = t(`bid.status.${(bid.status || '').toLowerCase()}`) || bid.status;

      header.append(titleEl, statusBadge);

      const meta = document.createElement('p');
      meta.className = 'text-body-sm text-on-surface-variant flex flex-wrap gap-md';
      const metaParts = [];
      if (bid.project?.category) metaParts.push(t(`cat.${bid.project.category}`) || bid.project.category);
      if (bid.project?.location) metaParts.push(bid.project.location);
      metaParts.push(formatTaka(bid.bidAmount || 0));
      if (bid.estimatedDays) metaParts.push(t('dash.myBids.estDays', { days: bid.estimatedDays }));
      if (bid.createdAt) metaParts.push(formatRelativeTime(bid.createdAt));
      meta.textContent = metaParts.join(' · ');

      info.append(header, meta);

      const actions = document.createElement('div');
      actions.className = 'flex flex-wrap items-center gap-sm';

      const viewBtn = document.createElement('a');
      viewBtn.href = `/app/project-detail.html?id=${encodeURIComponent(bid.projectId)}`;
      viewBtn.className = 'btn-outline min-h-[44px]';
      viewBtn.textContent = t('dash.myBids.view');
      actions.append(viewBtn);

      if (bid.status === 'ACCEPTED' || bid.project?.status === 'ASSIGNED') {
        const workspaceBtn = document.createElement('a');
        workspaceBtn.href = `/app/contract.html?id=${encodeURIComponent(bid.projectId)}`;
        workspaceBtn.className = 'btn-primary min-h-[44px]';
        workspaceBtn.textContent = t('dash.myBids.workspace');
        actions.append(workspaceBtn);
      }

      card.append(info, actions);
      list.append(card);
    }
  }
}

async function init() {
  try {
    await initShell();
    currentUser = await requireAuth();

    $('who').textContent = `${currentUser.phoneNumber} · ${t(ROLE_KEY[currentUser.role] || currentUser.role)}`;

    if (currentUser.role === 'CLIENT') {
      const cta = $('cta-post-project');
      if (cta) cta.hidden = false;
    } else if (currentUser.role === 'CONTRACTOR') {
      const cta = $('cta-find-projects');
      if (cta) cta.hidden = false;
    } else if (currentUser.role === 'ADMIN') {
      const cta = $('cta-admin-refunds');
      if (cta) cta.hidden = false;
    }

    handlePaymentBanner();

    // Fetch counters & role activity in parallel
    const activityPromise = currentUser.role === 'CLIENT'
      ? get('/projects/mine')
      : currentUser.role === 'CONTRACTOR'
        ? get('/bids/mine')
        : Promise.resolve(null);

    const [countersRes, actRes] = await Promise.all([
      get('/dashboard/counters'),
      activityPromise
    ]);

    dashboardData = countersRes;
    activityData = actRes;

    renderWallet(dashboardData.wallet);
    renderCounters(currentUser.role, dashboardData.counters);
    renderActivity();

    $('loading').hidden = true;
    $('content').hidden = false;
  } catch (err) {
    console.error('Dashboard init failed:', err);
    $('loading').hidden = true;
    const el = $('error');
    el.textContent = t(errorKeyFor(err));
    el.hidden = false;
  }

  window.addEventListener('langchange', () => {
    applyLang();
    if (currentUser) {
      $('who').textContent = `${currentUser.phoneNumber} · ${t(ROLE_KEY[currentUser.role] || currentUser.role)}`;
    }
    handlePaymentBanner();
    if (dashboardData) {
      renderWallet(dashboardData.wallet);
      renderCounters(currentUser.role, dashboardData.counters);
    }
    if (activityData) {
      renderActivity();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
