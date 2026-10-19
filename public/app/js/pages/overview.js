// Showcase Hub — overview of all screens built for Build-BD.
//
// Invariants (GEMINI-STANDARD):
//   - Pure DOM (replaceChildren, append, createElement, textContent) — no innerHTML.
//   - Network via ../api.js and session via ../session.js.
//   - All copy via t() with complete en and bn key parity.
//   - Touch targets >= 44 px, Bangla text >= 14 px.
//   - WCAG AA contrast tokens (text-money-fill, bg-surface-main, etc.).
//   - No real money amounts shown; no claims of government approval.

import { initShell } from '../shell.js';
import { getMe } from '../session.js';
import { t, applyLang } from '../i18n.js';

const $ = (id) => document.getElementById(id);

let currentUser = null;

const ROLE_KEY = {
  CLIENT: 'role.client',
  CONTRACTOR: 'role.contractor',
  ADMIN: 'role.admin',
  MODERATOR: 'role.moderator'
};

const SECTIONS = [
  {
    key: 'overview.section.start',
    items: [
      {
        id: 'home',
        url: '/app/',
        titleKey: 'overview.card.home.title',
        descKey: 'overview.card.home.desc',
        roles: ['ALL'],
        status: 'READY',
        icon: 'construction'
      },
      {
        id: 'login',
        url: '/app/login.html',
        titleKey: 'overview.card.login.title',
        descKey: 'overview.card.login.desc',
        roles: ['ALL'],
        status: 'READY',
        icon: 'person'
      },
      {
        id: 'dashboard',
        url: '/app/dashboard.html',
        titleKey: 'overview.card.dashboard.title',
        descKey: 'overview.card.dashboard.desc',
        roles: ['CLIENT', 'CONTRACTOR', 'ADMIN', 'MODERATOR'],
        status: 'READY',
        icon: 'person'
      }
    ]
  },
  {
    key: 'overview.section.client',
    items: [
      {
        id: 'post-project',
        url: '/app/post-project.html',
        titleKey: 'overview.card.postProject.title',
        descKey: 'overview.card.postProject.desc',
        roles: ['CLIENT'],
        status: 'READY',
        icon: 'add'
      },
      {
        id: 'project-detail',
        url: '/app/project-detail.html',
        titleKey: 'overview.card.projectDetail.title',
        descKey: 'overview.card.projectDetail.desc',
        roles: ['CLIENT', 'CONTRACTOR'],
        status: 'READY',
        icon: 'visibility'
      },
      {
        id: 'contract',
        url: '/app/contract.html',
        titleKey: 'overview.card.contract.title',
        descKey: 'overview.card.contract.desc',
        roles: ['CLIENT', 'CONTRACTOR'],
        status: 'READY',
        icon: 'assignment_turned_in'
      }
    ]
  },
  {
    key: 'overview.section.contractor',
    items: [
      {
        id: 'tenders',
        url: '/app/tenders.html',
        titleKey: 'overview.card.tenders.title',
        descKey: 'overview.card.tenders.desc',
        roles: ['CONTRACTOR'],
        status: 'READY',
        icon: 'handyman'
      },
      {
        id: 'submit-bid',
        url: '/app/submit-bid.html',
        titleKey: 'overview.card.submitBid.title',
        descKey: 'overview.card.submitBid.desc',
        roles: ['CONTRACTOR'],
        status: 'READY',
        icon: 'edit'
      },
      {
        id: 'contractor-profile',
        url: '/app/contractor-profile.html',
        titleKey: 'overview.card.profile.title',
        descKey: 'overview.card.profile.desc',
        roles: ['CONTRACTOR'],
        status: 'READY',
        icon: 'person'
      },
      {
        id: 'withdraw',
        url: '/app/withdraw.html',
        titleKey: 'overview.card.withdraw.title',
        descKey: 'overview.card.withdraw.desc',
        roles: ['CLIENT', 'CONTRACTOR'],
        status: 'READY',
        icon: 'account_balance_wallet'
      }
    ]
  },
  {
    key: 'overview.section.admin',
    items: [
      {
        id: 'admin-verify',
        url: '/app/admin-verify.html',
        titleKey: 'overview.card.verify.title',
        descKey: 'overview.card.verify.desc',
        roles: ['ADMIN'],
        status: 'READY',
        icon: 'verified_user'
      },
      {
        id: 'admin-refunds',
        url: '/app/admin-refunds.html',
        titleKey: 'overview.card.refunds.title',
        descKey: 'overview.card.refunds.desc',
        roles: ['ADMIN'],
        status: 'READY',
        icon: 'local_atm'
      },
      {
        id: 'moderation',
        url: '/app/moderation.html',
        titleKey: 'overview.card.moderation.title',
        descKey: 'overview.card.moderation.desc',
        roles: ['MODERATOR', 'ADMIN'],
        status: 'READY',
        icon: 'shield'
      }
    ]
  },
  {
    key: 'overview.section.materials',
    items: [
      {
        id: 'materials-hub',
        url: '#',
        titleKey: 'overview.card.materials.title',
        descKey: 'overview.card.materials.desc',
        roles: ['CLIENT', 'CONTRACTOR'],
        status: 'COMING_SOON',
        icon: 'schedule'
      }
    ]
  }
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function userHasRole(itemRoles) {
  if (itemRoles.includes('ALL')) return true;
  if (!currentUser) return false;
  return itemRoles.includes(currentUser.role);
}

function renderCard(item) {
  const card = el('article', 'card p-lg flex flex-col justify-between gap-md');

  // Top row: Icon + Title + Status Pill
  const top = el('div', 'space-y-sm');
  const headRow = el('div', 'flex items-start justify-between gap-sm');

  const titleBox = el('div', 'flex items-center gap-xs');
  const icon = el('span', 'icon text-[24px] text-primary', item.icon);
  icon.setAttribute('aria-hidden', 'true');
  const title = el('h3', 'text-title-md font-semibold text-on-surface', t(item.titleKey));
  titleBox.append(icon, title);

  let statusBadge;
  if (item.status === 'READY') {
    statusBadge = el('span', 'badge-category bg-success/15 text-money-fill font-medium border border-success/40', t('overview.status.ready'));
  } else {
    statusBadge = el('span', 'badge-category bg-surface-variant text-on-surface-variant border border-outline-variant', t('overview.status.comingSoon'));
  }

  headRow.append(titleBox, statusBadge);

  const desc = el('p', 'text-body-sm text-on-surface-variant', t(item.descKey));

  // Role Badges
  const roleRow = el('div', 'flex flex-wrap items-center gap-xs pt-xs');
  for (const r of item.roles) {
    if (r === 'ALL') {
      roleRow.append(el('span', 'badge-category bg-surface-container-low text-on-surface border border-outline-variant', 'Public'));
    } else {
      const roleText = t(ROLE_KEY[r] || r);
      roleRow.append(el('span', 'badge-category bg-surface-container-low text-on-surface border border-outline-variant', roleText));
    }
  }

  top.append(headRow, desc, roleRow);

  // Bottom action button
  const bottom = el('div', 'pt-sm border-t border-border-subtle flex items-center justify-between gap-sm');

  if (item.status === 'COMING_SOON') {
    const disabledBtn = el('button', 'chip min-h-[44px] cursor-not-allowed opacity-60', t('overview.status.comingSoon'));
    disabledBtn.disabled = true;
    bottom.append(disabledBtn);
  } else {
    const hasRole = userHasRole(item.roles);
    const link = el('a', 'btn-primary min-h-[44px] inline-flex items-center gap-xs');
    link.href = item.url;

    if (hasRole || item.roles.includes('ALL')) {
      const label = el('span', '', t('overview.action.open'));
      const arr = el('span', 'icon text-[20px]', 'arrow_forward');
      arr.setAttribute('aria-hidden', 'true');
      link.append(label, arr);
    } else {
      // Viewer lacks the role: still visible, explains role needed
      link.className = 'btn-outline min-h-[44px] inline-flex items-center gap-xs text-body-sm';
      const roleLabel = item.roles.map((r) => t(ROLE_KEY[r] || r)).join(' / ');
      const label = el('span', '', t('overview.action.requiresRole', { role: roleLabel }));
      const arr = el('span', 'icon text-[18px]', 'arrow_forward');
      arr.setAttribute('aria-hidden', 'true');
      link.append(label, arr);
    }
    bottom.append(link);
  }

  card.append(top, bottom);
  return card;
}

function renderSections() {
  const container = $('showcase-sections');
  container.replaceChildren();

  let readyCount = 0;
  for (const sec of SECTIONS) {
    const secWrap = el('section', 'space-y-md');
    const secHeading = el('h2', 'text-h3 font-bold text-on-surface border-b border-border-subtle pb-xs', t(sec.key));
    const grid = el('div', 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-md');

    for (const item of sec.items) {
      if (item.status === 'READY') readyCount += 1;
      grid.append(renderCard(item));
    }

    secWrap.append(secHeading, grid);
    container.append(secWrap);
  }

  $('overview-summary').textContent = t('overview.summary', { total: readyCount, roles: 4 });

  const rolePill = $('viewer-role-pill');
  if (currentUser) {
    const roleName = t(ROLE_KEY[currentUser.role] || currentUser.role);
    rolePill.textContent = `${currentUser.phoneNumber} · ${roleName}`;
  } else {
    rolePill.textContent = 'Guest / Signed out';
  }
}

document.addEventListener('langchange', () => {
  applyLang();
  renderSections();
});

(async () => {
  await initShell();
  try {
    currentUser = await getMe().catch(() => null);
    renderSections();
    $('loading').hidden = true;
    $('content').hidden = false;
  } catch (err) {
    $('loading').hidden = true;
    const bootError = $('boot-error');
    bootError.textContent = t('err.generic');
    bootError.hidden = false;
  }
})();
