// frontend/js/components/familyRolePicker.js
// Pure DOM component: Probashi delegation role selector card & option picker
'use strict';

import { t } from '../i18n.js';

/**
 * Renders an accessible role selector radio card for Probashi delegation shares.
 * Pure DOM, zero innerHTML.
 *
 * @param {Object} [options={}]
 * @param {'FAMILY_VIEWER'|'SITE_WATCHER'} [options.selected='FAMILY_VIEWER']
 * @param {(role: 'FAMILY_VIEWER'|'SITE_WATCHER') => void} [options.onChange]
 * @returns {HTMLElement}
 */
export function renderFamilyRolePicker(options = {}) {
  const { selected = 'FAMILY_VIEWER', onChange } = options;

  const group = document.createElement('div');
  group.className = 'role-picker-group grid grid-cols-1 sm:grid-cols-2 gap-sm';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', t('delegation.role.groupLabel') || 'Delegation Role');

  const roles = [
    {
      id: 'FAMILY_VIEWER',
      titleKey: 'delegation.role.familyViewer.title',
      defaultTitle: 'Family Viewer',
      descKey: 'delegation.role.familyViewer.desc',
      defaultDesc: 'Read-only timeline view. Financials hidden by default.',
      icon: 'visibility',
      badgeKey: 'delegation.role.familyViewer.badge',
      defaultBadge: 'Privacy Protected'
    },
    {
      id: 'SITE_WATCHER',
      titleKey: 'delegation.role.siteWatcher.title',
      defaultTitle: 'Site Watcher',
      descKey: 'delegation.role.siteWatcher.desc',
      defaultDesc: 'Can upload site photos and verify deliveries. Zero fund release power.',
      icon: 'photo_camera',
      badgeKey: 'delegation.role.siteWatcher.badge',
      defaultBadge: 'Evidence Only'
    }
  ];

  roles.forEach((r) => {
    const isChecked = selected === r.id;

    const card = document.createElement('label');
    card.className = `role-card flex flex-col justify-between p-md rounded-card border-2 cursor-pointer transition-colors min-h-[44px] ${
      isChecked
        ? 'border-primary bg-primary-container/10'
        : 'border-outline-variant bg-surface-card hover:bg-surface-container-low'
    }`;

    // Hidden accessible radio input
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'scopedRole';
    radio.value = r.id;
    radio.checked = isChecked;
    radio.className = 'sr-only';

    radio.addEventListener('change', () => {
      group.querySelectorAll('.role-card').forEach((c) => {
        c.classList.remove('border-primary', 'bg-primary-container/10');
        c.classList.add('border-outline-variant', 'bg-surface-card');
      });
      card.classList.remove('border-outline-variant', 'bg-surface-card');
      card.classList.add('border-primary', 'bg-primary-container/10');
      if (typeof onChange === 'function') {
        onChange(r.id);
      }
    });

    const top = document.createElement('div');
    top.className = 'flex items-start justify-between gap-xs';

    const header = document.createElement('div');
    header.className = 'flex items-center gap-xs';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'icon text-primary text-[20px]';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.textContent = r.icon;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'text-title-sm font-semibold text-on-surface';
    titleSpan.textContent = t(r.titleKey) || r.defaultTitle;

    header.append(iconSpan, titleSpan);

    const badge = document.createElement('span');
    badge.className = 'text-[10px] font-bold uppercase tracking-wider px-xs py-[2px] rounded bg-secondary/15 text-secondary border border-secondary/30';
    badge.textContent = t(r.badgeKey) || r.defaultBadge;

    top.append(header, badge);

    const desc = document.createElement('p');
    desc.className = 'text-body-sm text-on-surface-variant mt-xs';
    desc.textContent = t(r.descKey) || r.defaultDesc;

    card.append(radio, top, desc);
    group.appendChild(card);
  });

  return group;
}
