import { renderVerifiedBadge } from './verifiedBadge.js';
import { renderRatingDisplay } from './ratingDisplay.js';
import { t, toBengaliDigits, getLang } from '../i18n.js';

/**
 * Pure DOM factory for contractor directory card.
 * Read-only display of public-safe contractor projection.
 * Zero network calls, pure DOM creation.
 *
 * @param {Object} [contractor={}]
 * @param {string} [contractor.userId='']
 * @param {string} [contractor.fullName='']
 * @param {string} [contractor.businessType='']
 * @param {string} [contractor.contractorTier='MISTRI_SARDAR']
 * @param {string[]} [contractor.workGenres=[]]
 * @param {Array<{district: string, areas: string[]}>} [contractor.serviceAreas=[]]
 * @param {string} [contractor.verificationLevel='BASIC']
 * @param {boolean} [contractor.hasTradeLicense=false]
 * @param {number} [contractor.completedProjects=0]
 * @param {number} [contractor.avgRatingMilli=0]
 * @param {number} [contractor.trustScore=0]
 * @returns {HTMLElement}
 */
export function renderContractorCard(contractor = {}) {
  const {
    userId = '',
    fullName = '',
    contractorTier = 'MISTRI_SARDAR',
    workGenres = [],
    serviceAreas = [],
    verificationLevel = 'BASIC',
    hasTradeLicense = false,
    completedProjects = 0,
    avgRatingMilli = 0,
    trustScore = 0
  } = contractor;

  const card = document.createElement('article');
  card.className = 'contractor-card flex flex-col justify-between p-md rounded-card bg-surface border border-outline-variant shadow-elevation-1 hover:border-primary transition-colors gap-md';
  if (userId) card.dataset.contractorId = String(userId);

  // Top Section: Header & Badges
  const topSection = document.createElement('div');
  topSection.className = 'flex flex-col gap-sm';

  const headerRow = document.createElement('div');
  headerRow.className = 'flex items-start justify-between gap-sm';

  const titleGroup = document.createElement('div');
  titleGroup.className = 'flex flex-col gap-[2px]';

  const nameEl = document.createElement('h3');
  nameEl.className = 'text-title-md font-semibold text-on-surface line-clamp-1';
  nameEl.textContent = fullName || t('role.contractor');

  const tierPill = document.createElement('span');
  tierPill.className = 'inline-flex items-center text-label-sm font-medium text-secondary';
  const tierKey = `contractor.tier.${contractorTier}`;
  tierPill.textContent = t(tierKey) !== tierKey ? t(tierKey) : contractorTier;

  titleGroup.append(nameEl, tierPill);

  const trustGroup = document.createElement('div');
  trustGroup.className = 'flex flex-col items-end text-right';

  const scoreNum = Number(trustScore) || 0;
  const lang = getLang();
  const scoreStr = lang === 'bn' ? toBengaliDigits(scoreNum) : String(scoreNum);

  const trustScoreEl = document.createElement('span');
  trustScoreEl.className = 'text-label-sm font-semibold text-primary';
  trustScoreEl.textContent = t('contractor.trustScore', { score: scoreStr });

  trustGroup.append(trustScoreEl);
  headerRow.append(titleGroup, trustGroup);

  // Verified Badges (phone, trade license, NID, past work)
  const isStandardOrHigher = verificationLevel === 'STANDARD' || verificationLevel === 'PREMIUM';
  const badgeGroup = renderVerifiedBadge({
    phoneVerified: true,
    tradeLicenceVerified: Boolean(hasTradeLicense),
    nidVerified: isStandardOrHigher,
    pastWorkVerified: Number(completedProjects) > 0,
    mode: 'compact'
  });

  // Rating Display
  const ratingSection = renderRatingDisplay({
    avgRatingMilli: Number(avgRatingMilli) || 0,
    completedMilestonesCount: Number(completedProjects) || 0
  });

  topSection.append(headerRow, badgeGroup, ratingSection);

  // Middle Section: Genres and Districts
  const metaSection = document.createElement('div');
  metaSection.className = 'flex flex-col gap-xs text-body-sm text-on-surface-variant';

  // Work Genres Chips
  if (Array.isArray(workGenres) && workGenres.length > 0) {
    const genresContainer = document.createElement('div');
    genresContainer.className = 'flex flex-wrap items-center gap-xs';
    for (const g of workGenres.slice(0, 3)) {
      const gChip = document.createElement('span');
      gChip.className = 'genre-chip inline-flex items-center px-xs py-[2px] rounded text-label-sm bg-surface-container text-on-surface-variant';
      const gKey = `genre.${g}`;
      gChip.textContent = t(gKey) !== gKey ? t(gKey) : g;
      genresContainer.append(gChip);
    }
    if (workGenres.length > 3) {
      const extra = workGenres.length - 3;
      const extraChip = document.createElement('span');
      extraChip.className = 'text-caption text-secondary';
      extraChip.textContent = `+${lang === 'bn' ? toBengaliDigits(extra) : extra}`;
      genresContainer.append(extraChip);
    }
    metaSection.append(genresContainer);
  }

  // Service Areas
  if (Array.isArray(serviceAreas) && serviceAreas.length > 0) {
    const districts = serviceAreas.map((a) => a && a.district).filter(Boolean);
    if (districts.length > 0) {
      const areaRow = document.createElement('div');
      areaRow.className = 'flex items-center gap-xs text-caption text-secondary';

      const pinIcon = document.createElement('span');
      pinIcon.className = 'icon text-[14px] leading-none';
      pinIcon.setAttribute('aria-hidden', 'true');
      pinIcon.textContent = 'place';

      const districtText = document.createElement('span');
      districtText.textContent = districts.slice(0, 3).join(', ') + (districts.length > 3 ? ` (+${districts.length - 3})` : '');

      areaRow.append(pinIcon, districtText);
      metaSection.append(areaRow);
    }
  }

  // Bottom Section: Actions
  const bottomSection = document.createElement('div');
  bottomSection.className = 'pt-sm border-t border-outline-variant flex items-center justify-between gap-sm';

  const projectsCount = Number(completedProjects) || 0;
  const projectsText = document.createElement('span');
  projectsText.className = 'text-label-sm text-on-surface-variant';
  projectsText.textContent = t('contractor.completedProjects', {
    count: lang === 'bn' ? toBengaliDigits(projectsCount) : String(projectsCount)
  });

  const profileLink = document.createElement('a');
  profileLink.href = `/app/contractor-profile.html?id=${encodeURIComponent(userId || '')}`;
  profileLink.className = 'btn-profile inline-flex items-center justify-center min-h-[44px] min-w-[44px] px-md py-xs rounded-btn bg-primary text-on-primary font-medium text-label-md hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary transition-colors';
  profileLink.textContent = t('contractor.viewProfile');

  bottomSection.append(projectsText, profileLink);

  card.append(topSection, metaSection, bottomSection);
  return card;
}
