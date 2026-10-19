import { t } from '../i18n.js';

/**
 * Renders verified badges for a contractor or user.
 * Never outputs a bare "Verified" label — each pill explicitly states what was verified.
 *
 * @param {Object} props
 * @param {boolean} [props.phoneVerified=false]
 * @param {boolean} [props.nidVerified=false]
 * @param {boolean} [props.tradeLicenceVerified=false]
 * @param {boolean} [props.pastWorkVerified=false]
 * @param {'compact'|'detailed'} [props.mode='compact']
 * @returns {HTMLElement}
 */
export function renderVerifiedBadge({
  phoneVerified = false,
  nidVerified = false,
  tradeLicenceVerified = false,
  pastWorkVerified = false,
  mode = 'compact'
} = {}) {
  const container = document.createElement('div');
  container.className = 'verified-badge-group flex flex-col gap-xs';

  const pillsContainer = document.createElement('div');
  pillsContainer.className = 'flex flex-wrap items-center gap-xs';

  const badges = [
    { key: 'phone', verified: Boolean(phoneVerified), labelKey: 'badge.phone', icon: 'phone_iphone' },
    { key: 'nid', verified: Boolean(nidVerified), labelKey: 'badge.nid', icon: 'verified_user' },
    { key: 'tradeLicense', verified: Boolean(tradeLicenceVerified), labelKey: 'badge.tradeLicense', icon: 'approval' },
    { key: 'pastWork', verified: Boolean(pastWorkVerified), labelKey: 'badge.pastWork', icon: 'assignment_turned_in' }
  ];

  for (const b of badges) {
    if (!b.verified) continue;
    const pill = document.createElement('span');
    pill.className = 'badge-verified inline-flex items-center gap-xs px-sm py-[2px] rounded-full text-label-sm font-medium bg-surface-container border border-outline-variant text-on-surface';
    pill.dataset.badgeType = b.key;

    const icon = document.createElement('span');
    icon.className = 'icon text-[14px] text-primary';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = b.icon;

    const text = document.createElement('span');
    text.textContent = t(b.labelKey);

    pill.append(icon, text);
    pillsContainer.append(pill);
  }

  if (pillsContainer.childNodes.length > 0) {
    container.append(pillsContainer);
  }

  if (mode === 'detailed' && pillsContainer.childNodes.length > 0) {
    const disclaimer = document.createElement('p');
    disclaimer.className = 'badge-disclaimer text-caption text-on-surface-variant mt-xs';
    disclaimer.textContent = t('badge.non_govt_disclaimer');
    container.append(disclaimer);
  }

  return container;
}
