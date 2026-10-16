// middleware/sanitize.js
// NoSQL-injection guard that works with Express 5.
//
// Express 5 defines req.query as a getter that re-parses the URL on every read,
// so changing req.query in place has no effect: the next read returns the
// original, unsanitized values. This middleware sanitizes a copy and pins it on
// the request as an own, writable property, which every later middleware and
// route then reads.
//
// Keys that start with "$" or contain "." are DELETED (replaceWith: ''), the same
// behaviour as before. Values are never changed, so emails and decimals pass.
'use strict';

const mongoSanitize = require('express-mongo-sanitize');
const logger = require('../utils/logger');

const OPTIONS = { replaceWith: '' };

function sanitizeRequest(req, _res, next) {
  const hits = [];

  if (req.body && typeof req.body === 'object') {
    if (mongoSanitize.has(req.body)) hits.push('body');
    mongoSanitize.sanitize(req.body, OPTIONS);
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

module.exports = sanitizeRequest;
