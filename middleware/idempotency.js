// middleware/idempotency.js
// 🔐 Edge-Ready Redis Idempotency Engine with Circuit Breaker
//
// Architecture:
//   PRIMARY path  → Redis (sub-millisecond, distributed locking via SET NX EX)
//   FALLBACK path → MongoDB (existing logic, activated via circuit-breaker)
//
// The circuit breaker opens when Redis is unavailable.
// ALL security invariants (payload-hash check, cross-user key binding) are
// enforced identically on BOTH paths.
//
// Retry contract (audit G16):
//   - A key is bound to ONE request: the hash covers method + full URL path + body, so the same key
//     on another milestone/endpoint is refused (409), never silently replayed as "success".
//   - Final answers (2xx, and permanent 4xx such as "milestone not in the right state") are stored for
//     24 h and replayed.
//   - Retryable answers (5xx, 429, 408, and 409 conflicts flagged retryable) are NOT stored: the lock is
//     released so a retry with the same key runs the handler again.
//   - The "in flight" lock lives 120 s, not 24 h: a crash or dropped connection frees the key quickly.

const crypto = require('crypto');
const IdempotencyKey = require('../models/IdempotencyKey');
const { redis, isRedisReady } = require('../services/redisClient');

const KEY_RE = /^[A-Za-z0-9_.:\-]{1,128}$/;
const INFLIGHT_TTL_SECONDS = 120;       // a request that has not answered within this is presumed dead
const INFLIGHT_STALE_MS = INFLIGHT_TTL_SECONDS * 1000;
const RESULT_TTL_SECONDS = 86400;       // 24 h — mirrors the Mongo TTL index

// ─────────────────────────────────────────────
// 🔧 STABLE JSON SERIALISER (deterministic key ordering)
// ─────────────────────────────────────────────
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** Hash of WHAT was asked: method + path (with ids, no query) + body. */
function computeRequestHash(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const normalized = stableStringify({ m: req.method, p: path, b: req.body || {} });
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/** Retryable outcomes must never be frozen into the key (see header). */
function isRetryable(res) {
  const s = res.statusCode;
  return s >= 500 || s === 429 || s === 408 || Boolean(res.locals && res.locals.idemRetryable);
}

function redisLockKey(userId, idempotencyKey) { return `idem:lock:${userId}:${idempotencyKey}`; }
function redisResultKey(userId, idempotencyKey) { return `idem:result:${userId}:${idempotencyKey}`; }

const MISMATCH = {
  status: 'error',
  message: 'Idempotency key was already used for a different request. Use a new X-Idempotency-Key for each new action.'
};
const IN_PROGRESS = { status: 'error', message: 'Concurrent transaction in progress. Please wait.' };

// ─────────────────────────────────────────────
// 🔴 PRIMARY PATH: Redis implementation
// ─────────────────────────────────────────────
async function handleViaRedis(req, res, next, idempotencyKey, payloadHash) {
  const uid = req.user.userId;
  const lockKey = redisLockKey(uid, idempotencyKey);
  const resultKey = redisResultKey(uid, idempotencyKey);

  // 1️⃣ Stored final result (replay path)
  const existingResult = await redis.get(resultKey);
  if (existingResult) {
    const parsed = JSON.parse(existingResult);
    if (parsed.payloadHash !== payloadHash) {
      console.error(`🚨 [Redis] Idempotency key ${idempotencyKey} reused for a different request — blocked.`);
      return res.status(409).json(MISMATCH);
    }
    if (parsed.responseCode) return res.status(parsed.responseCode).json(parsed.responseBody);
    return res.status(429).json(IN_PROGRESS);
  }

  // 1️⃣b Redis miss → consult Mongo. Survives Redis restart, failover, TTL eviction, and a prior request
  // handled on the Mongo path.
  let mongoFallback = await IdempotencyKey.findOne({ key: idempotencyKey, userId: uid });
  if (mongoFallback && !mongoFallback.responseCode && Date.now() - new Date(mongoFallback.createdAt).getTime() > INFLIGHT_STALE_MS) {
    // The request that created this row never answered (crash / disconnect): free the key.
    await IdempotencyKey.deleteOne({ _id: mongoFallback._id, responseCode: null });
    mongoFallback = null;
  }
  if (mongoFallback) {
    if (mongoFallback.payloadHash !== payloadHash) {
      console.error(`🚨 [Hybrid] Idempotency key ${idempotencyKey} reused for a different request — blocked.`);
      return res.status(409).json(MISMATCH);
    }
    if (mongoFallback.responseCode) {
      try {
        await redis.set(resultKey, JSON.stringify({
          payloadHash,
          responseCode: mongoFallback.responseCode,
          responseBody: mongoFallback.responseBody
        }), 'EX', RESULT_TTL_SECONDS);
      } catch (backfillErr) {
        console.warn('⚠️  [Hybrid] Redis backfill from Mongo failed:', backfillErr.message);
      }
      return res.status(mongoFallback.responseCode).json(mongoFallback.responseBody);
    }
    return res.status(429).json(IN_PROGRESS);
  }

  // 2️⃣ Acquire the in-flight lock (SET NX EX) — atomic, avoids TOCTOU races.
  const lockValue = `INFLIGHT:${payloadHash}`;
  const acquired = await redis.set(lockKey, lockValue, 'NX', 'EX', INFLIGHT_TTL_SECONDS);

  if (!acquired) {
    const existingLock = await redis.get(lockKey);
    if (existingLock && !existingLock.endsWith(payloadHash)) {
      console.error(`🚨 [Redis] Idempotency key ${idempotencyKey} reused for a different request (lock held) — blocked.`);
      return res.status(409).json(MISMATCH);
    }
    return res.status(429).json(IN_PROGRESS);
  }

  // 3️⃣ Lock acquired — intercept the response to store (or release) it.
  const originalJson = res.json.bind(res);
  res.json = async function (body) {
    if (isRetryable(res)) {
      await redis.del(lockKey).catch(() => {});          // let the retry run again
      return originalJson(body);
    }
    try {
      const resultPayload = JSON.stringify({ payloadHash, responseCode: res.statusCode, responseBody: body });
      const pipeline = redis.pipeline();
      pipeline.set(resultKey, resultPayload, 'EX', RESULT_TTL_SECONDS);
      pipeline.del(lockKey);
      await pipeline.exec();
    } catch (cacheErr) {
      console.error('⚠️  [Redis] Idempotency result cache write failed:', cacheErr.message);
    }
    // Durable mirror → Mongo, so a Redis flap does not re-run the handler on replay.
    try {
      await IdempotencyKey.updateOne(
        { key: idempotencyKey, userId: uid },
        {
          $set: { payloadHash, responseCode: res.statusCode, responseBody: body },
          $setOnInsert: { key: idempotencyKey, userId: uid }
        },
        { upsert: true }
      );
    } catch (mirrorErr) {
      console.error('⚠️  [Hybrid] Mongo mirror write from Redis path failed:', mirrorErr.message);
    }
    return originalJson(body);
  };

  // 4️⃣ Cleanup hook if the middleware itself throws after the lock was taken.
  req._redisIdempotencyCleanup = async () => { await redis.del(lockKey).catch(() => {}); };

  next();
}

// ─────────────────────────────────────────────
// 🍃 FALLBACK PATH: MongoDB implementation
// ─────────────────────────────────────────────
async function handleViaMongoDB(req, res, next, idempotencyKey, payloadHash) {
  const uid = req.user.userId;
  let existingKey = await IdempotencyKey.findOne({ key: idempotencyKey, userId: uid });

  if (existingKey && !existingKey.responseCode && Date.now() - new Date(existingKey.createdAt).getTime() > INFLIGHT_STALE_MS) {
    await IdempotencyKey.deleteOne({ _id: existingKey._id, responseCode: null });
    existingKey = null;
  }

  if (existingKey) {
    if (existingKey.payloadHash !== payloadHash) {
      console.error(`🚨 [MongoDB] Idempotency key ${idempotencyKey} reused for a different request — blocked.`);
      return res.status(409).json(MISMATCH);
    }
    if (existingKey.responseCode) return res.status(existingKey.responseCode).json(existingKey.responseBody);
    return res.status(429).json(IN_PROGRESS);
  }

  try {
    await IdempotencyKey.create({ key: idempotencyKey, payloadHash, userId: uid });
  } catch (createError) {
    if (createError.code === 11000) {
      const replayKey = await IdempotencyKey.findOne({ key: idempotencyKey, userId: uid });
      if (!replayKey) throw createError;
      if (replayKey.payloadHash !== payloadHash) {
        console.error(`🚨 [MongoDB] Idempotency key ${idempotencyKey} reused for a different request — blocked.`);
        return res.status(409).json(MISMATCH);
      }
      if (replayKey.responseCode) return res.status(replayKey.responseCode).json(replayKey.responseBody);
      return res.status(429).json(IN_PROGRESS);
    }
    throw createError;
  }

  const originalJson = res.json.bind(res);
  res.json = async function (body) {
    if (isRetryable(res)) {
      await IdempotencyKey.deleteOne({ key: idempotencyKey, userId: uid, responseCode: null }).catch(() => {});
      return originalJson(body);
    }
    try {
      await IdempotencyKey.updateOne(
        { key: idempotencyKey, userId: uid },
        { responseCode: res.statusCode, responseBody: body }
      );
    } catch (err) {
      console.error('⚠️  [MongoDB] Idempotency cache write failure:', err);
    }
    // Hot mirror → Redis if the circuit has recovered since we entered this path.
    if (isRedisReady()) {
      try {
        await redis.set(redisResultKey(uid, idempotencyKey), JSON.stringify({
          payloadHash,
          responseCode: res.statusCode,
          responseBody: body
        }), 'EX', RESULT_TTL_SECONDS);
      } catch (mirrorErr) {
        console.warn('⚠️  [Hybrid] Redis mirror write from Mongo path failed:', mirrorErr.message);
      }
    }
    return originalJson(body);
  };

  next();
}

// ─────────────────────────────────────────────
// 🏛️ EXPORTED MIDDLEWARE — Circuit Breaker Orchestrator
// ─────────────────────────────────────────────
let lastDegradedLogAt = 0;

exports.enforceIdempotency = async (req, res, next) => {
  const idempotencyKey = req.headers['x-idempotency-key'];

  if (!idempotencyKey) {
    return res.status(400).json({
      status: 'error',
      message: 'Tier-1 financial operations require an X-Idempotency-Key header.'
    });
  }
  if (typeof idempotencyKey !== 'string' || !KEY_RE.test(idempotencyKey)) {
    return res.status(400).json({
      status: 'error',
      message: 'X-Idempotency-Key must be 1–128 characters: letters, digits, "_", "-", ".", ":".'
    });
  }

  if (!req.user || !req.user.userId) {
    return res.status(401).json({
      status: 'error',
      message: 'Authentication required for idempotent financial operations.'
    });
  }

  try {
    const payloadHash = computeRequestHash(req);

    // ⚡ CIRCUIT BREAKER: Redis if healthy, else degrade to MongoDB
    if (isRedisReady()) {
      return await handleViaRedis(req, res, next, idempotencyKey, payloadHash);
    }
    if (Date.now() - lastDegradedLogAt > 60000) {
      lastDegradedLogAt = Date.now();
      console.warn('⚠️  [Idempotency] Redis unavailable — circuit open. Using MongoDB (logged at most once a minute).');
    }
    return await handleViaMongoDB(req, res, next, idempotencyKey, payloadHash);
  } catch (error) {
    // 🛡️ DEADLOCK RELEASE: free any lock taken before the failure.
    try {
      if (req._redisIdempotencyCleanup) {
        await req._redisIdempotencyCleanup();
      } else {
        await IdempotencyKey.deleteOne({ key: idempotencyKey, userId: req.user.userId, responseCode: null });
      }
    } catch (cleanupError) {
      console.error(`🚨 FATAL: Failed to release idempotency deadlock for key ${idempotencyKey}`, cleanupError);
    }
    next(error);
  }
};

exports.computeRequestHash = computeRequestHash; // exported for tests
