// frontend/js/phone.js — normalise Bangladeshi mobile numbers to the backend
// form 01XXXXXXXXX (regex ^01[3-9]\d{8}$). Pure; unit-tested.
const BN = '০১২৩৪৫৬৭৮৯';

export function normalizeBdPhone(input) {
  if (typeof input !== 'string') return null;
  let s = input.replace(/[০-৯]/g, (d) => String(BN.indexOf(d))); // Bengali → ASCII digits
  s = s.replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('00880')) s = s.slice(5);
  else if (s.startsWith('880')) s = s.slice(3);
  if (/^1[3-9]\d{8}$/.test(s)) s = `0${s}`; // typed after a +880 prefix
  return /^01[3-9]\d{8}$/.test(s) ? s : null;
}
