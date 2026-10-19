import { t, toBengaliDigits, getLang } from '../i18n.js';

/**
 * Pure DOM factory for contractor rating display.
 * Formats milli-ratings (e.g. 4900 -> 4.9).
 * If completedMilestonesCount === 0, renders a newly listed badge and NEVER 0.0 or empty stars.
 *
 * @param {Object} props
 * @param {number} [props.avgRatingMilli=0]
 * @param {number} [props.completedMilestonesCount=0]
 * @returns {HTMLElement}
 */
export function renderRatingDisplay({
  avgRatingMilli = 0,
  completedMilestonesCount = 0
} = {}) {
  const container = document.createElement('div');
  container.className = 'rating-display inline-flex items-center gap-xs text-body-sm';
  container.setAttribute('role', 'status');

  const count = Number(completedMilestonesCount) || 0;

  if (count <= 0) {
    const newlyListed = document.createElement('span');
    newlyListed.className = 'badge-newly-listed inline-flex items-center px-sm py-[2px] rounded-full text-label-sm font-medium bg-surface-container border border-outline-variant text-on-surface-variant';
    newlyListed.textContent = t('rating.newlyListed');
    container.append(newlyListed);
    return container;
  }

  const rawNum = Math.max(0, Math.min(5000, Number(avgRatingMilli) || 0));
  const rounded = (Math.round(rawNum / 100) / 10).toFixed(1);
  const lang = getLang();
  const scoreText = lang === 'bn' ? toBengaliDigits(rounded) : rounded;
  const countText = lang === 'bn' ? toBengaliDigits(count) : String(count);

  const starScore = document.createElement('span');
  starScore.className = 'font-semibold text-on-surface inline-flex items-center gap-[2px]';
  starScore.setAttribute('aria-label', t('rating.stars', { rating: scoreText }));

  const starGlyph = document.createElement('span');
  starGlyph.className = 'text-amber-500 font-bold text-[14px] leading-none';
  starGlyph.setAttribute('aria-hidden', 'true');
  starGlyph.textContent = '★';

  const scoreSpan = document.createElement('span');
  scoreSpan.textContent = scoreText;

  starScore.append(starGlyph, scoreSpan);

  const separator = document.createElement('span');
  separator.className = 'text-outline-variant select-none';
  separator.setAttribute('aria-hidden', 'true');
  separator.textContent = '·';

  const milestonesText = document.createElement('span');
  milestonesText.className = 'text-on-surface-variant text-label-sm';
  milestonesText.textContent = t('rating.verifiedMilestones', { count: countText });

  container.append(starScore, separator, milestonesText);
  return container;
}
