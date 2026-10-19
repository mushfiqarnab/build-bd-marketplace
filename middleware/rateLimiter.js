// middleware/rateLimiter.js
// Phase 29+ — IETF draft-8 hardened rate limiters with CGNAT user-identity awareness and IPv6 /56 subnet masking
'use strict';

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { extractToken } = require('../services/sessionService');

// Skip rate limiting for test environments and loopback addresses
function skipFn(req) {
  if (process.env.NODE_ENV === 'test') return true;
  const ip = req.ip || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// User-aware key generator:
// 1. If user is authenticated on req (req.user), keys on user ID ('usr:<id>').
// 2. If Authorization header or session cookie contains a valid JWT, keys on verified user ID.
// 3. Otherwise falls back to IPv6 /56 subnet or IPv4 address to defeat mobile ISP prefix rotation without penalizing concurrent cellular users behind CGNAT.
function keyGenerator(req) {
  const user = req.user;
  const userId = user && (user.id || user.userId);
  if (userId) return `usr:${userId}`;

  if (process.env.JWT_SECRET && req && req.headers) {
    try {
      const { token } = extractToken(req.headers);
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        if (decoded && (decoded.userId || decoded.id)) {
          return `usr:${decoded.userId || decoded.id}`;
        }
      }
    } catch (_) {
      // Signature invalid or expired — fall through to IP/subnet key
    }
  }

  const ip = (req && req.ip) || '127.0.0.1';
  if (typeof ipKeyGenerator === 'function') {
    try { return ipKeyGenerator(ip, 56); } catch (_) { /* fallback */ }
  }
  return ip;
}

/**
 * apiLimiter — General API gateway
 * 120 requests per 60 seconds per user / /56 subnet
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator,
  skip: skipFn,
  message: { status: 'error', message: 'API rate limit exceeded. Maximum 120 requests per minute.' }
});

/**
 * strictAuthAndBidLimiter — Tight limiter for auth and bid mutation endpoints
 * 30 requests per 15 minutes per user / /56 subnet
 */
const strictAuthAndBidLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator,
  skip: skipFn,
  message: { status: 'error', message: 'Auth/Bid rate limit exceeded. Maximum 30 requests per 15 minutes.' }
});

/**
 * financialLimiter — Strict throttle for money-touching endpoints (/api/contracts, /api/payment)
 * 10 requests per 10 minutes per user / /56 subnet
 */
const financialLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator,
  skip: skipFn,
  message: { status: 'error', message: 'Financial rate limit exceeded. Maximum 10 contract/payment operations per 10 minutes.' }
});

module.exports = {
  apiLimiter,
  strictAuthAndBidLimiter,
  financialLimiter,
  keyGenerator,
  skipFn
};
