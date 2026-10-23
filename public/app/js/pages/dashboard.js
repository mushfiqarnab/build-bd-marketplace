import { initShell } from '../shell.js';
import { requireAuth } from '../session.js';
import { get, ApiError } from '../api.js';
import { t, applyLang, formatTaka, formatRelativeTime } from '../i18n.js';

const ROLE_KEY = {
  CLIENT: 'role.client',
  CONTRACTOR: 'role.contractor',
  SUPPLIER: 'role.supplier',
  ADMIN: 'role.admin',
  MODERATOR: 'role.moderator'
};

const $ = (id) => document.getElementById(id);

let currentUser = null;
let dashboardData = null;
let activityData = null;
let labourData = null;

function getThursdayPayrollCountdown() {
  const now = new Date();
  const bdNow = new Date(now.getTime() + (6 * 60 + now.getTimezoneOffset()) * 60000);
  const currentDay = bdNow.getDay();
  let daysUntilThursday = (4 - currentDay + 7) % 7;
  if (daysUntilThursday === 0 && bdNow.getHours() >= 17) {
    daysUntilThursday = 7;
  }
  const nextThursday = new Date(bdNow);
  nextThursday.setDate(bdNow.getDate() + daysUntilThursday);
  nextThursday.setHours(17, 0, 0, 0);

  const diffMs = nextThursday.getTime() - bdNow.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (diffDays > 0) {
    return `${diffDays}d ${diffHours}h`;
  }
  return `${diffHours}h remaining`;
}

function renderDomesticStaff(subs) {
  const section = $('domestic-staff-section');
  const list = $('domestic-staff-list');
  const empty = $('domestic-staff-empty');
  if (!section || !list || !empty) return;

  if (currentUser?.role !== 'CLIENT') {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  list.replaceChildren();

  const items = Array.isArray(subs) ? subs : [];
  if (items.length === 0) {
    empty.hidden = false;
    return;
  }

  empty.hidden = true;
  const countdownText = getThursdayPayrollCountdown();

  for (const sub of items) {
    const card = document.createElement('article');
    card.className = 'card p-md border border-border-subtle bg-surface-card rounded-lg flex flex-col gap-sm';

    // Header
    const topRow = document.createElement('div');
    topRow.className = 'flex flex-col sm:flex-row sm:items-center justify-between gap-xs';

    const infoBox = document.createElement('div');
    infoBox.className = 'flex flex-wrap items-center gap-xs';

    const nameEl = document.createElement('h3');
    nameEl.className = 'text-title-sm font-semibold text-on-surface';
    nameEl.textContent = sub.workerProfile?.fullName || 'Verified Domestic Worker';

    const catBadge = document.createElement('span');
    catBadge.className = 'badge-category';
    catBadge.textContent = sub.workerCategory || 'Household Staff';

    const subTierBadge = document.createElement('span');
    subTierBadge.className = 'inline-flex items-center rounded px-xs py-xxs text-caption font-medium bg-surface-container-low text-on-surface border border-border-subtle';
    subTierBadge.textContent = sub.subTier ? sub.subTier.replace(/_/g, ' ') : 'Retainer';

    const statusBadge = document.createElement('span');
    statusBadge.className = 'badge-bid-placed';
    statusBadge.textContent = sub.status === 'TRIAL_ACTIVE' ? (t('dash.domestic.trialActive') || '1-Day Trial Active') : (t('dash.domestic.retainerActive') || 'Active Retainer');

    infoBox.append(nameEl, catBadge, subTierBadge, statusBadge);
    topRow.append(infoBox);

    // Trust Badges Row
    const trustRow = document.createElement('div');
    trustRow.className = 'flex flex-wrap items-center gap-xs text-caption';

    const ring1 = document.createElement('span');
    ring1.className = 'inline-flex items-center gap-xxs text-money-fill font-medium';
    const r1Icon = document.createElement('span');
    r1Icon.className = 'icon text-[16px] text-money-fill';
    r1Icon.setAttribute('aria-hidden', 'true');
    r1Icon.textContent = 'verified_user';
    const r1Text = document.createElement('span');
    r1Text.textContent = 'Porichoy 18+ NID Match';
    ring1.append(r1Icon, r1Text);

    const ring2 = document.createElement('span');
    ring2.className = 'inline-flex items-center gap-xxs text-primary font-medium';
    const r2Icon = document.createElement('span');
    r2Icon.className = 'icon text-[16px] text-primary';
    r2Icon.setAttribute('aria-hidden', 'true');
    r2Icon.textContent = 'shield';
    const r2Text = document.createElement('span');
    r2Text.textContent = '2 Darwan Guarantors';
    ring2.append(r2Icon, r2Text);

    const ring3 = document.createElement('span');
    ring3.className = 'inline-flex items-center gap-xxs text-primary font-medium';
    const r3Icon = document.createElement('span');
    r3Icon.className = 'icon text-[16px] text-primary';
    r3Icon.setAttribute('aria-hidden', 'true');
    r3Icon.textContent = 'approval';
    const r3Text = document.createElement('span');
    r3Text.textContent = 'DMP CIMS Police Registered';
    ring3.append(r3Icon, r3Text);

    trustRow.append(ring1, ring2, ring3);

    // Payroll Telemetry Grid
    const salary = sub.agreedMonthlySalaryAmount || 6000;
    const weeklyBkash = Math.round((salary * 0.80) / 4);
    const weeklyReserve = Math.round((salary * 0.15) / 4);

    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-2 sm:grid-cols-4 gap-xs p-xs rounded bg-surface-container-low border border-border-subtle text-caption text-on-surface';

    const c1 = document.createElement('div');
    const c1Label = document.createElement('span');
    c1Label.className = 'text-on-surface-variant block';
    c1Label.textContent = 'Agreed Monthly Salary:';
    const c1Val = document.createElement('strong');
    c1Val.className = 'text-on-surface font-semibold';
    c1Val.textContent = formatTaka(salary);
    c1.append(c1Label, c1Val);

    const c2 = document.createElement('div');
    const c2Label = document.createElement('span');
    c2Label.className = 'text-on-surface-variant block';
    c2Label.textContent = t('dash.domestic.immediateBkash') || '80% Immediate bKash:';
    const c2Val = document.createElement('strong');
    c2Val.className = 'text-money-fill font-semibold';
    c2Val.textContent = `${formatTaka(weeklyBkash)} / wk`;
    c2.append(c2Label, c2Val);

    const c3 = document.createElement('div');
    const c3Label = document.createElement('span');
    c3Label.className = 'text-on-surface-variant block';
    c3Label.textContent = t('dash.domestic.continuityReserve') || '15% Continuity Reserve:';
    const c3Val = document.createElement('strong');
    c3Val.className = 'text-primary font-semibold';
    c3Val.textContent = `${formatTaka(weeklyReserve)} / wk`;
    c3.append(c3Label, c3Val);

    const c4 = document.createElement('div');
    const c4Label = document.createElement('span');
    c4Label.className = 'text-on-surface-variant block';
    c4Label.textContent = t('dash.domestic.thursdayPayroll') || 'Thursday Payroll:';
    const c4Val = document.createElement('strong');
    c4Val.className = 'text-on-surface font-bold';
    c4Val.textContent = countdownText;
    c4.append(c4Label, c4Val);

    grid.append(c1, c2, c3, c4);

    // Actions Row
    const actionRow = document.createElement('div');
    actionRow.className = 'flex flex-wrap items-center justify-end gap-xs pt-xs border-t border-border-subtle';

    const dossierLink = document.createElement('a');
    dossierLink.href = `/app/domestic-labour.html?workerId=${encodeURIComponent(sub.workerId)}`;
    dossierLink.className = 'btn-outline min-h-[44px] px-sm py-xs text-caption inline-flex items-center gap-xs';
    const dIcon = document.createElement('span');
    dIcon.className = 'icon text-[18px] text-primary';
    dIcon.setAttribute('aria-hidden', 'true');
    dIcon.textContent = 'verified_user';
    const dText = document.createElement('span');
    dText.textContent = t('dash.domestic.viewCims') || 'View DMP CIMS Dossier';
    dossierLink.append(dIcon, dText);

    const disputeLink = document.createElement('a');
    disputeLink.href = `/app/domestic-labour.html?dispute=1&subscriptionId=${encodeURIComponent(sub._id)}`;
    disputeLink.className = 'btn-outline min-h-[44px] px-sm py-xs text-caption inline-flex items-center gap-xs';
    const gIcon = document.createElement('span');
    gIcon.className = 'icon text-[18px] text-error';
    gIcon.setAttribute('aria-hidden', 'true');
    gIcon.textContent = 'warning';
    const gText = document.createElement('span');
    gText.textContent = t('dash.domestic.fileGd') || 'File 48h Police GD Dispute';
    disputeLink.append(gIcon, gText);

    actionRow.append(dossierLink, disputeLink);

    card.append(topRow, trustRow, grid, actionRow);
    list.append(card);
  }
}

function renderMicroDispatches(projects) {
  const section = $('micro-dispatch-section');
  const list = $('micro-dispatch-list');
  const empty = $('micro-dispatch-empty');
  if (!section || !list || !empty) return;

  if (currentUser?.role !== 'CLIENT') {
    section.hidden = true;
    return;
  }

  const microProjects = (projects || []).filter(
    (p) => (p.title && p.title.startsWith('Micro Utility')) || (p.description && p.description.includes('Micro Utility'))
  );

  if (microProjects.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  list.replaceChildren();

  for (const proj of microProjects) {
    const card = document.createElement('article');
    card.className = 'card p-md border border-border-subtle bg-surface-card rounded-lg flex flex-col gap-sm';

    const topRow = document.createElement('div');
    topRow.className = 'flex flex-col sm:flex-row sm:items-center justify-between gap-xs';

    const titleBox = document.createElement('div');
    titleBox.className = 'flex flex-wrap items-center gap-xs';

    const titleEl = document.createElement('h3');
    titleEl.className = 'text-title-sm font-semibold text-on-surface';
    titleEl.textContent = proj.title;

    const statusBadge = document.createElement('span');
    statusBadge.className = 'badge-bid-placed';
    statusBadge.textContent = proj.status === 'OPEN' ? (t('dash.micro.enRoute') || 'Technician En Route') : (t('dash.micro.arrived') || 'Doorstep Check-in');

    const advanceBadge = document.createElement('span');
    advanceBadge.className = 'inline-flex items-center gap-xxs px-xs py-xxs rounded text-label-sm bg-surface-container-low text-money-fill font-bold';
    advanceBadge.textContent = '৳0 Advance';

    titleBox.append(titleEl, statusBadge, advanceBadge);
    topRow.append(titleBox);

    const detailsGrid = document.createElement('div');
    detailsGrid.className = 'grid grid-cols-1 sm:grid-cols-3 gap-xs p-xs rounded bg-surface-container-low border border-border-subtle text-caption text-on-surface';

    const col1 = document.createElement('div');
    const col1L = document.createElement('span');
    col1L.className = 'text-on-surface-variant block';
    col1L.textContent = 'Service Area:';
    const col1V = document.createElement('strong');
    col1V.className = 'text-on-surface';
    col1V.textContent = proj.location || 'Dhaka';
    col1.append(col1L, col1V);

    const col2 = document.createElement('div');
    const col2L = document.createElement('span');
    col2L.className = 'text-on-surface-variant block';
    col2L.textContent = 'Due on Completion:';
    const col2V = document.createElement('strong');
    col2V.className = 'text-money-fill font-semibold';
    col2V.textContent = formatTaka(proj.budget || 800);
    col2.append(col2L, col2V);

    const col3 = document.createElement('div');
    const col3L = document.createElement('span');
    col3L.className = 'text-on-surface-variant block';
    col3L.textContent = 'Trust Guarantees:';
    const col3V = document.createElement('strong');
    col3V.className = 'text-primary';
    col3V.textContent = '৳200 Visiting Cap · 7-Day Hold';
    col3.append(col3L, col3V);

    detailsGrid.append(col1, col2, col3);

    const actionRow = document.createElement('div');
    actionRow.className = 'flex items-center justify-end gap-xs pt-xs border-t border-border-subtle';

    const detailBtn = document.createElement('a');
    detailBtn.href = `/app/project-detail.html?id=${encodeURIComponent(proj._id)}`;
    detailBtn.className = 'btn-outline min-h-[44px] px-sm py-xs text-caption inline-flex items-center gap-xs';
    detailBtn.textContent = 'View Details';

    const otpBtn = document.createElement('a');
    otpBtn.href = `/app/contract.html?id=${encodeURIComponent(proj._id)}`;
    otpBtn.className = 'btn-primary min-h-[44px] px-sm py-xs text-caption inline-flex items-center gap-xs bg-primary text-on-primary';
    const otpIcon = document.createElement('span');
    otpIcon.className = 'icon text-[18px] bg-primary text-on-primary';
    otpIcon.setAttribute('aria-hidden', 'true');
    otpIcon.textContent = 'check_circle';
    const otpText = document.createElement('span');
    otpText.className = 'bg-primary text-on-primary';
    otpText.textContent = t('dash.micro.otpPrompt') || 'Release via 4-Digit OTP';
    otpBtn.append(otpIcon, otpText);

    actionRow.append(detailBtn, otpBtn);

    card.append(topRow, detailsGrid, actionRow);
    list.append(card);
  }
}

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

  const projectParam = urlParams.get('project');
  if (!paymentStatus && projectParam) {
    banner.hidden = false;
    bannerBox.className = 'card p-md flex items-start gap-md border border-primary/40 bg-primary/10 text-on-surface';
    icon.className = 'icon text-label-lg text-primary';
    icon.textContent = 'check_circle';
    title.textContent = t('post.success');
    desc.textContent = `#${projectParam}`;
    desc.hidden = false;
    dismissBtn.addEventListener('click', () => {
      banner.hidden = true;
    });
    return;
  }

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
  } else if (role === 'SUPPLIER') {
    kpis.push(
      { key: 'totalProducts', label: t('dash.kpi.totalProducts'), count: counters.totalProducts || 0, icon: 'inventory_2' },
      { key: 'activeOrders', label: t('dash.kpi.activeOrders'), count: counters.activeOrders || 0, icon: 'receipt_long' },
      { key: 'pendingDelivery', label: t('dash.kpi.pendingDelivery'), count: counters.pendingDelivery || 0, icon: 'local_shipping' },
      { key: 'completedOrders', label: t('dash.kpi.completedOrders'), count: counters.completedOrders || 0, icon: 'check_circle' },
      { key: 'disputedOrders', label: t('dash.kpi.disputedOrders'), count: counters.disputedOrders || 0, icon: 'warning' }
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

      const isCompleted = bid.project?.status === 'COMPLETED';
      const statusBadge = document.createElement('span');
      statusBadge.className = isCompleted
        ? 'inline-flex items-center rounded-md px-sm py-xs text-body-sm font-semibold bg-success/15 text-on-surface border border-success/40'
        : 'badge-category';
      statusBadge.textContent = isCompleted
        ? (t('detail.status.COMPLETED') || 'Completed')
        : (t(`bid.status.${(bid.status || '').toLowerCase()}`) || bid.status);

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
  } else if (currentUser.role === 'SUPPLIER') {
    heading.textContent = t('dash.supplierOrders.title');
    emptyText.textContent = t('dash.supplierOrders.empty');
    empty.hidden = false;
    countBadge.hidden = true;
  }
}

async function init() {
  try {
    await initShell();
    currentUser = await requireAuth();

    $('who').textContent = `${currentUser.phoneNumber} · ${t(ROLE_KEY[currentUser.role] || currentUser.role)}`;

    if (currentUser.role === 'CLIENT') {
      const ctaMyProjects = $('cta-my-projects');
      if (ctaMyProjects) ctaMyProjects.hidden = false;
      const ctaDomestic = $('cta-domestic-labour');
      if (ctaDomestic) ctaDomestic.hidden = false;
      const cta = $('cta-post-project');
      if (cta) cta.hidden = false;
      const ctaContractors = $('cta-contractors');
      if (ctaContractors) ctaContractors.hidden = false;
    } else if (currentUser.role === 'CONTRACTOR') {
      const cta = $('cta-find-projects');
      if (cta) cta.hidden = false;
      const ctaProfile = $('cta-contractor-profile');
      if (ctaProfile) ctaProfile.hidden = false;
      const ctaWithdraw = $('cta-contractor-withdraw');
      if (ctaWithdraw) ctaWithdraw.hidden = false;
    } else if (currentUser.role === 'SUPPLIER') {
      const ctaOrders = $('cta-supplier-orders');
      if (ctaOrders) ctaOrders.hidden = false;
      const ctaWithdraw = $('cta-supplier-withdraw');
      if (ctaWithdraw) ctaWithdraw.hidden = false;
      const ctaCatalog = $('cta-supplier-catalog');
      if (ctaCatalog) ctaCatalog.hidden = false;
    } else if (currentUser.role === 'ADMIN') {
      const cta = $('cta-admin-refunds');
      if (cta) cta.hidden = false;
      const ctaVerify = $('cta-admin-verify');
      if (ctaVerify) ctaVerify.hidden = false;
      const ctaMod = $('cta-moderation');
      if (ctaMod) ctaMod.hidden = false;
    } else if (currentUser.role === 'MODERATOR') {
      const ctaMod = $('cta-moderation');
      if (ctaMod) ctaMod.hidden = false;
    }

    handlePaymentBanner();

    // Fetch counters, role activity & domestic staff retainers in parallel
    const activityPromise = currentUser.role === 'CLIENT'
      ? get('/projects/mine')
      : currentUser.role === 'CONTRACTOR'
        ? get('/bids/mine')
        : Promise.resolve(null);

    const labourPromise = currentUser.role === 'CLIENT'
      ? get('/v2/labour/subscriptions/mine').catch(() => ({ data: [] }))
      : Promise.resolve({ data: [] });

    const [countersRes, actRes, labourRes] = await Promise.all([
      get('/dashboard/counters'),
      activityPromise,
      labourPromise
    ]);

    dashboardData = countersRes;
    activityData = actRes;
    labourData = labourRes?.data || [];

    if (currentUser.role === 'CLIENT') {
      const ctaWithdraw = $('cta-client-withdraw');
      if (ctaWithdraw) {
        ctaWithdraw.hidden = !(dashboardData?.wallet?.availableToWithdraw > 0);
      }
    }

    renderWallet(dashboardData.wallet);
    renderCounters(currentUser.role, dashboardData.counters);
    if (currentUser.role === 'CLIENT') {
      renderDomesticStaff(labourData);
      renderMicroDispatches(activityData?.projects || []);
    }
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
      if (currentUser.role === 'CLIENT') {
        const ctaWithdraw = $('cta-client-withdraw');
        if (ctaWithdraw) {
          ctaWithdraw.hidden = !(dashboardData?.wallet?.availableToWithdraw > 0);
        }
      }
    }
    handlePaymentBanner();
    if (dashboardData) {
      renderWallet(dashboardData.wallet);
      renderCounters(currentUser.role, dashboardData.counters);
    }
    if (currentUser?.role === 'CLIENT') {
      renderDomesticStaff(labourData);
      renderMicroDispatches(activityData?.projects || []);
    }
    if (activityData) {
      renderActivity();
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
