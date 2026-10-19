import { t, toBengaliDigits, getLang } from '../i18n.js';

/**
 * Pure DOM factory for neutral discrepancy flag chip.
 * Policy: Inform, never accuse.
 * Neutral amber palette only: bg-amber-50, border-amber-300, text-amber-950.
 *
 * @param {Object} props
 * @param {'QUANTITY_DIFF'|'BRAND_DIFF'|'GRADE_DIFF'|'PRICE_DIFF'} props.flagType
 * @param {string|number} props.plannedValue
 * @param {string|number} props.actualValue
 * @param {string} [props.unit='']
 * @returns {HTMLElement}
 */
export function renderFlagChip({
  flagType,
  plannedValue,
  actualValue,
  unit = ''
} = {}) {
  const chip = document.createElement('div');
  chip.className = 'flag-chip inline-flex items-center gap-xs px-sm py-[2px] rounded-md text-label-sm font-medium bg-amber-50 border border-amber-300 text-amber-950';
  chip.setAttribute('role', 'status');

  const icon = document.createElement('span');
  icon.className = 'icon text-[14px] text-amber-800 leading-none';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = 'info';

  const lang = getLang();
  const formatVal = (v) => {
    if (v === undefined || v === null) return '';
    const str = String(v);
    if (lang === 'bn' && /^\d+(?:\.\d+)?$/.test(str)) {
      return toBengaliDigits(str);
    }
    return str;
  };

  const plannedStr = formatVal(plannedValue);
  const actualStr = formatVal(actualValue);

  let messageKey = 'flag.gentle_quantity';
  if (flagType === 'BRAND_DIFF') messageKey = 'flag.gentle_brand';
  else if (flagType === 'GRADE_DIFF') messageKey = 'flag.gentle_grade';
  else if (flagType === 'PRICE_DIFF') messageKey = 'flag.gentle_price';

  const textSpan = document.createElement('span');
  textSpan.textContent = t(messageKey, {
    planned: plannedStr,
    actual: actualStr,
    unit: unit ? ` ${unit}` : ''
  });

  chip.append(icon, textSpan);
  return chip;
}
