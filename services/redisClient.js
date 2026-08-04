// services/redisClient.js
// 🔴 Singleton Redis client — ioredis with auto-reconnect.
// This module exports the client and a readiness flag used by the
// idempotency circuit-breaker and the /health/readiness probe.
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// ─────────────────────────────────────────────
// 🔌 CLIENT CONSTRUCTION
// ─────────────────────────────────────────────
const redis = new Redis(REDIS_URL, {
  // Retry strategy: exponential backoff capped at 5 s, max 20 attempts
  retryStrategy(times) {
    if (times > 20) return null; // Stop retrying — enter degraded mode
    return Math.min(times * 150, 5000);
  },
  // Do NOT throw on initial connection failure — allow graceful degradation
  lazyConnect: false,
  enableOfflineQueue: false, // Reject commands immediately if disconnected (no buffering)
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
  commandTimeout: 2000,
});

// ─────────────────────────────────────────────
// 📊 READINESS TRACKING
// ─────────────────────────────────────────────
let _isReady = false;

redis.on('connect', () => {
  _isReady = true;
  console.log('✅ [Redis] Connection established.');
});

redis.on('ready', () => {
  _isReady = true;
  console.log('🔴 [Redis] Client ready — commands accepted.');
});

redis.on('error', (err) => {
  // Only log — do NOT crash. The circuit breaker handles degradation.
  if (_isReady) {
    console.warn(`⚠️  [Redis] Connection error: ${err.message}`);
  }
  _isReady = false;
});

redis.on('close', () => {
  _isReady = false;
  console.warn('⚠️  [Redis] Connection closed.');
});

redis.on('reconnecting', (delay) => {
  console.log(`🔄 [Redis] Reconnecting in ${delay}ms…`);
});

redis.on('end', () => {
  _isReady = false;
  console.warn('⚠️  [Redis] Connection ended — max retries exhausted. Falling back to MongoDB.');
});

// ─────────────────────────────────────────────
// 🛠️ EXPORTED HELPERS
// ─────────────────────────────────────────────

/**
 * Returns true when the Redis client is connected and ready.
 * Used by the circuit breaker and /health/readiness probe.
 */
function isRedisReady() {
  return _isReady && redis.status === 'ready';
}

/**
 * Gracefully close the Redis connection during shutdown.
 * Waits for in-flight commands to drain, then disconnects.
 */
async function closeRedis() {
  if (redis.status !== 'end') {
    await redis.quit().catch(() => redis.disconnect());
    console.log('🔴 [Redis] Connection pool drained cleanly.');
  }
}

module.exports = { redis, isRedisReady, closeRedis };
