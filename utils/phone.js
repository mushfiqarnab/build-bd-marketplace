// utils/phone.js — Bangladeshi phone number validation and normalization
'use strict';

/**
 * Normalizes and validates Bangladeshi mobile numbers.
 * Accepts: "01XXXXXXXXX", "+8801XXXXXXXXX", "8801XXXXXXXXX", with spaces or dashes.
 * Rejects numbers outside valid operator prefixes (013-019).
 * Returns canonical 11-digit string "01XXXXXXXXX" or null if invalid.
 */
function normalizeBdPhone(phone) {
  if (typeof phone !== 'string') return null;
  const cleaned = phone.trim().replace(/[\s-]/g, '').replace(/^(\+?88)/, '');
  if (/^01[3-9]\d{8}$/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

module.exports = {
  normalizeBdPhone
};
