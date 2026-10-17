// frontend/js/phone.js — normalise Bangladeshi mobile numbers to the backend
// form 01XXXXXXXXX (regex ^01[3-9]\d{8}$). Pure; unit-tested.
export const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Replace Bengali digits with their ASCII counterparts. Exported because
 *  numeric inputs across the app (OTP, amount, days) all need this. */
export function bengaliToAscii(input) {
  if (typeof input !== 'string') return input;
  return input.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

export function normalizeBdPhone(input) {
  if (typeof input !== 'string') return null;
  let s = bengaliToAscii(input);
  s = s.replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00880')) s = s.slice(5);
  else if (s.startsWith('880')) s = s.slice(3);
  if (/^1[3-9]\d{8}$/.test(s)) s = `0${s}`; // typed after a +880 prefix
  return /^01[3-9]\d{8}$/.test(s) ? s : null;
}
