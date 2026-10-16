// middleware/rateLimiter.js
// Phase 29+ — IETF draft-8 hardened rate limiters with IPv6 /56 subnet masking
'use strict';

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

// Skip rate limiting for test environments and loopback addresses
function skipFn(req) {
  if (process.env.NODE_ENV === 'test') return true;
  const ip = req.ip || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// IPv6 /56 subnet key generator — collapses mobile ISP prefix rotation
function keyGenerator(req) {
  const ip = req.ip || '127.0.0.1';
  if (typeof ipKeyGenerator === 'function') {
    try { return ipKeyGenerator(ip, 56); } catch { /* fallback */ }
  }
  return ip;
}

/**
 * apiLimiter — General API gateway
 * 120 requests per 60 seconds per /56 subnet
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
 * 30 requests per 15 minutes per /56 subnet
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

module.exports = { apiLimiter, strictAuthAndBidLimiter };
