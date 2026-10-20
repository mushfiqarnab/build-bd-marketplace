// middleware/rateLimiter.js
// Phase 29+ — Distributed multi-pod rate limiters with CGNAT user-identity awareness, IPv6 /56 subnet masking, and Redis sync
'use strict';

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator, MemoryStore } = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { extractToken } = require('../services/sessionService');
const { redis, isRedisReady } = require('../services/redisClient');

/**
 * DistributedRedisStore
 * Distributed atomic rate limiter store backed by Redis with zero-latency local MemoryStore fallback.
 * Employs a single atomic EVAL Lua script to increment hit counters and set millisecond TTL (PEXPIRE).
 * When Redis is disconnected or degraded, seamlessly fails open to local in-memory tracking.
 */
class DistributedRedisStore {
  constructor(prefix) {
    this.prefix = `rl:${prefix}:`;
    this.localFallback = new MemoryStore();
  }

  init(options) {
    this.windowMs = options.windowMs || 60000;
    this.localFallback.init(options);
  }

  async increment(key) {
    if (isRedisReady()) {
      try {
        const fullKey = `${this.prefix}${key}`;
        const lua = `
          local current = redis.call('INCR', KEYS[1])
          if current == 1 then
            redis.call('PEXPIRE', KEYS[1], ARGV[1])
          end
          local ttl = redis.call('PTTL', KEYS[1])
          if ttl < 0 then
            redis.call('PEXPIRE', KEYS[1], ARGV[1])
            ttl = tonumber(ARGV[1])
          end
          return { current, ttl }
        `;
        const res = await redis.call('EVAL', lua, 1, fullKey, this.windowMs);
        const [totalHits, ttl] = res;
        const resetTime = new Date(Date.now() + Math.max(0, Number(ttl) || this.windowMs));
        return { totalHits: Number(totalHits), resetTime };
      } catch (err) {
        // Fall back to memory on Redis command error
      }
    }
    return this.localFallback.increment(key);
  }

  async decrement(key) {
    if (isRedisReady()) {
      try {
        await redis.decr(`${this.prefix}${key}`);
        return;
      } catch (_) {}
    }
    return this.localFallback.decrement(key);
  }

  async resetKey(key) {
    if (isRedisReady()) {
      try {
        await redis.del(`${this.prefix}${key}`);
        return;
      } catch (_) {}
    }
    return this.localFallback.resetKey(key);
  }
}

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
  store: new DistributedRedisStore('api'),
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
  store: new DistributedRedisStore('auth'),
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
  store: new DistributedRedisStore('fin'),
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
  skipFn,
  DistributedRedisStore
};
