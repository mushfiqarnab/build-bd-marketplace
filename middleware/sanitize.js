// middleware/sanitize.js
// NoSQL-injection guard & Bangla Phonetic/Digit Contact Leak Scrubber (Express 5 compatible).
//
// 1. NoSQL Injection Guard:
//    Express 5 defines req.query as a getter that re-parses the URL on every read,
//    so changing req.query in place has no effect: the next read returns the
//    original, unsanitized values. This middleware sanitizes a copy and pins it on
//    the request as an own, writable property, which every later middleware and
//    route then reads.
//    Keys that start with "$" or contain "." are DELETED (replaceWith: '').
//
// 2. Bangla Phonetic & Digit Contact Scrubber (Roadmap §13.1 / §18 Item 13):
//    Anti-bypass moat protecting platform fee monetization against off-platform
//    disintermediation. Normalizes Bengali digits (০-৯) to ASCII, transforms
//    Bangla/Banglish phonetic digit words ("shunno ek saat", "zero one seven"),
//    and redacts BD phone number patterns from freeform communication fields.
'use strict';

const mongoSanitize = require('express-mongo-sanitize');
const logger = require('../utils/logger');

const OPTIONS = { replaceWith: '' };

const BN_DIGITS = { '০':'0', '১':'1', '২':'2', '৩':'3', '৪':'4', '৫':'5', '৬':'6', '৭':'7', '৮':'8', '৯':'9' };

const PHONETIC_MAP = [
  // 1. Banglish & English Latin words (standard \b ASCII boundary)
  { regex: /\b(shunno|shuno|zero|jero)\b/gi, digit: '0' },
  { regex: /\b(one|ek)\b/gi, digit: '1' },
  { regex: /\b(two|dui)\b/gi, digit: '2' },
  { regex: /\b(three|tin|teen)\b/gi, digit: '3' },
  { regex: /\b(four|char|chaar)\b/gi, digit: '4' },
  { regex: /\b(five|pach|paanch)\b/gi, digit: '5' },
  { regex: /\b(six|choy|chhoy)\b/gi, digit: '6' },
  { regex: /\b(seven|saat|sat)\b/gi, digit: '7' },
  { regex: /\b(eight|aat|aath|ath)\b/gi, digit: '8' },
  { regex: /\b(nine|noy|noi)\b/gi, digit: '9' },

  // 2. Bengali script Unicode words (lookbehind/lookahead boundary for Unicode correctness)
  { regex: /(?<=^|[\s.,/_~-])(শূণ্য|শূন্য|জিরো)(?=$|[\s.,/_~-])/g, digit: '0' },
  { regex: /(?<=^|[\s.,/_~-])(এক)(?=$|[\s.,/_~-])/g, digit: '1' },
  { regex: /(?<=^|[\s.,/_~-])(দুই)(?=$|[\s.,/_~-])/g, digit: '2' },
  { regex: /(?<=^|[\s.,/_~-])(তিন)(?=$|[\s.,/_~-])/g, digit: '3' },
  { regex: /(?<=^|[\s.,/_~-])(চার)(?=$|[\s.,/_~-])/g, digit: '4' },
  { regex: /(?<=^|[\s.,/_~-])(পাঁচ)(?=$|[\s.,/_~-])/g, digit: '5' },
  { regex: /(?<=^|[\s.,/_~-])(ছয়|ছয়)(?=$|[\s.,/_~-])/g, digit: '6' },
  { regex: /(?<=^|[\s.,/_~-])(সাত)(?=$|[\s.,/_~-])/g, digit: '7' },
  { regex: /(?<=^|[\s.,/_~-])(আট)(?=$|[\s.,/_~-])/g, digit: '8' },
  { regex: /(?<=^|[\s.,/_~-])(নয়|নয়)(?=$|[\s.,/_~-])/g, digit: '9' }
];

const BD_PHONE_REPLACE_REGEX = /(?:\+?880|00880|0)[\s.,/_-]*1[\s.,/_-]*[3-9](?:[\s.,/_-]*\d){8}/gi;
const BD_PHONE_TEST_REGEX = /(?:\+?880|00880|0)[\s.,/_-]*1[\s.,/_-]*[3-9](?:[\s.,/_-]*\d){8}/i;

const REDACTION_TOKEN = '[REDACTED CONTACT INFO]';

const ALLOWED_PHONE_FIELDS = new Set([
  'phone',
  'phoneNumber',
  'delegatePhone',
  'dealerPhone',
  'driverPhone',
  'receiverPhone',
  'recipientPhone'
]);

const COMMUNICATION_FIELDS = new Set([
  'message',
  'content',
  'text',
  'proposalText',
  'comment',
  'description',
  'notes',
  'reason',
  'arbitrationNotes'
]);

function normalizeDigitsAndPhonetics(str) {
  let s = String(str || '').replace(/[০-৯]/g, (d) => BN_DIGITS[d]);
  for (const { regex, digit } of PHONETIC_MAP) {
    s = s.replace(regex, digit);
  }
  return s;
}

function hasContactLeak(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const normalized = normalizeDigitsAndPhonetics(text);
  return BD_PHONE_TEST_REGEX.test(normalized);
}

function scrubContactLeaks(text) {
  if (typeof text !== 'string' || !text.trim()) return text;
  const normalized = normalizeDigitsAndPhonetics(text);
  return normalized.replace(BD_PHONE_REPLACE_REGEX, REDACTION_TOKEN);
}

function scrubCommunicationFields(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string') {
      if (COMMUNICATION_FIELDS.has(key) && !ALLOWED_PHONE_FIELDS.has(key)) {
        if (hasContactLeak(val)) {
          obj[key] = scrubContactLeaks(val);
        }
      }
    } else if (Array.isArray(val)) {
      if (COMMUNICATION_FIELDS.has(key)) {
        for (let i = 0; i < val.length; i++) {
          if (typeof val[i] === 'string' && hasContactLeak(val[i])) {
            val[i] = scrubContactLeaks(val[i]);
          } else if (val[i] && typeof val[i] === 'object') {
            scrubCommunicationFields(val[i]);
          }
        }
      } else {
        for (const item of val) {
          if (item && typeof item === 'object') {
            scrubCommunicationFields(item);
          }
        }
      }
    } else if (val && typeof val === 'object') {
      scrubCommunicationFields(val);
    }
  }
}

function sanitizeRequest(req, _res, next) {
  const hits = [];

  if (req.body && typeof req.body === 'object') {
    if (mongoSanitize.has(req.body)) hits.push('body');
    mongoSanitize.sanitize(req.body, OPTIONS);
    scrubCommunicationFields(req.body);
  }

  const rawQuery = { ...req.query };
  if (mongoSanitize.has(rawQuery)) hits.push('query');
  const query = mongoSanitize.sanitize(rawQuery, OPTIONS);
  Object.defineProperty(req, 'query', {
    value: query,
    writable: true,
    configurable: true,
    enumerable: true
  });

  if (hits.length > 0) {
    logger.warn(`[sanitize] operator or dotted keys removed from ${hits.join(' and ')} | ${req.method} ${req.path} | ip=${req.ip}`);
  }
  next();
}

sanitizeRequest.scrubContactLeaks = scrubContactLeaks;
sanitizeRequest.hasContactLeak = hasContactLeak;
sanitizeRequest.REDACTION_TOKEN = REDACTION_TOKEN;

module.exports = sanitizeRequest;
