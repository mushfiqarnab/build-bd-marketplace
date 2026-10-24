// services/redisClient.js
// 🔴 Singleton Redis client — ioredis with auto-reconnect.
// This module exports the client and a readiness flag used by the
// idempotency circuit-breaker and the /health/readiness probe.
const Redis = require('ioredis');

// Sanitize REDIS_URL to remove any accidental whitespace, newlines, or tabs from pasting
const rawRedisUrl = (process.env.REDIS_URL || '').replace(/\s+/g, '');
const REDIS_URL = rawRedisUrl || 'redis://localhost:6379';

// ─────────────────────────────────────────────
// 📊 READINESS TRACKING & CLIENT CONSTRUCTION
// ─────────────────────────────────────────────
let _isReady = false;
let redis;

try {
  redis = new Redis(REDIS_URL, {
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
    enableAutoPipelining: true,
  });

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
} catch (initErr) {
  console.warn(`⚠️  [Redis] Client initialization skipped (${initErr.message}). Falling back to MongoDB.`);
  _isReady = false;
  redis = {
    status: 'end',
    quit: async () => {},
    disconnect: () => {},
    on: () => {},
  };
}

// ─────────────────────────────────────────────
// 🛠️ EXPORTED HELPERS
// ─────────────────────────────────────────────

/**
 * Returns true when the Redis client is connected and ready.
 * Used by the circuit breaker and /health/readiness probe.
 */
function isRedisReady() {
  return _isReady && redis && redis.status === 'ready';
}

/**
 * Gracefully close the Redis connection during shutdown.
 * Waits for in-flight commands to drain, then disconnects.
 */
async function closeRedis() {
  if (redis && redis.status !== 'end') {
    if (typeof redis.quit === 'function') {
      await redis.quit().catch(() => typeof redis.disconnect === 'function' && redis.disconnect());
    }
    console.log('🔴 [Redis] Connection pool drained cleanly.');
  }
}


/**
 * getRedisTelemetry
 * Returns lightweight memory/persistence telemetry from Redis INFO.
 * Never uses blocking KEYS commands. Safe to call from readiness probes.
 * Returns { connected: false } when Redis is in degraded/circuit-breaker mode.
 */
async function getRedisTelemetry() {
  if (!isRedisReady()) return { connected: false };
  try {
    const [memInfo, persInfo] = await Promise.all([
      redis.info('memory'),
      redis.info('persistence')
    ]);
    const parse = (info, key) => {
      const match = info.match(new RegExp(`^${key}:(.+)$`, 'm'));
      return match ? match[1].trim() : null;
    };
    return {
      connected: true,
      used_memory_peak_perc: parse(memInfo, 'used_memory_peak_perc'),
      used_memory_rss_human: parse(memInfo, 'used_memory_rss_human'),
      used_memory_vm_eval:   parse(memInfo, 'used_memory_vm_eval'),
      current_cow_peak:      parse(persInfo, 'current_cow_peak'),
      current_fork_perc:     parse(persInfo, 'current_fork_perc')
    };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}

module.exports = { redis, isRedisReady, closeRedis, getRedisTelemetry };
