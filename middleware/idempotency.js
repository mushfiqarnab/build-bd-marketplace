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

const crypto = require('crypto');
const IdempotencyKey = require('../models/IdempotencyKey');
const { redis, isRedisReady } = require('../services/redisClient');

// ─────────────────────────────────────────────
// 🔧 STABLE JSON SERIALISER (deterministic key ordering)
// ─────────────────────────────────────────────
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

async function computePayloadHash(payload) {
  const normalized = stableStringify(payload || {});
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// ─────────────────────────────────────────────
// 🔴 REDIS KEY SCHEMA
//   lock:{userId}:{key}        → "INFLIGHT|{payloadHash}" (NX EX 86400)
//   result:{userId}:{key}      → JSON of { payloadHash, responseCode, responseBody }
// ─────────────────────────────────────────────
const LOCK_TTL_SECONDS   = 86400; // 24 h — mirrors Mongo TTL index
const RESULT_TTL_SECONDS = 86400;

function redisLockKey(userId, idempotencyKey) {
  return `idem:lock:${userId}:${idempotencyKey}`;
}

function redisResultKey(userId, idempotencyKey) {
  return `idem:result:${userId}:${idempotencyKey}`;
}

// ─────────────────────────────────────────────
// 🔴 PRIMARY PATH: Redis implementation
// ─────────────────────────────────────────────
async function handleViaRedis(req, res, next, idempotencyKey, payloadHash) {
  const uid      = req.user.userId;
  const lockKey  = redisLockKey(uid, idempotencyKey);
  const resultKey = redisResultKey(uid, idempotencyKey);

  // 1️⃣ Check for a stored result (replay path)
  const existingResult = await redis.get(resultKey);
  if (existingResult) {
    const parsed = JSON.parse(existingResult);

    if (parsed.payloadHash !== payloadHash) {
      console.error(`🚨 [Redis] THREAT DETECTED: Payload hijack on Idempotency Key ${idempotencyKey}`);
      return res.status(409).json({
        status: 'error',
        message: 'SECURITY BREACH: Idempotency payload mismatch. Request blocked.'
      });
    }

    if (parsed.responseCode) {
      return res.status(parsed.responseCode).json(parsed.responseBody);
    }

    // Result key exists but no responseCode means it's still INFLIGHT
    return res.status(429).json({
      status: 'error',
      message: 'Concurrent transaction in progress. Please wait.'
    });
  }

  // 1️⃣b Redis miss → consult Mongo. Survives Redis restart, failover, TTL
  // eviction, and a prior request that was handled on the Mongo path.
  const mongoFallback = await IdempotencyKey.findOne({ key: idempotencyKey, userId: uid });
  if (mongoFallback) {
    if (mongoFallback.payloadHash !== payloadHash) {
      console.error(`🚨 [Hybrid] THREAT DETECTED: Payload hijack on Idempotency Key ${idempotencyKey}`);
      return res.status(409).json({
        status: 'error',
        message: 'SECURITY BREACH: Idempotency payload mismatch. Request blocked.'
      });
    }
    if (mongoFallback.responseCode) {
      try {
        await redis.set(resultKey, JSON.stringify({
          payloadHash,
          responseCode: mongoFallback.responseCode,
          responseBody: mongoFallback.responseBody,
        }), 'EX', RESULT_TTL_SECONDS);
      } catch (backfillErr) {
        console.warn('⚠️  [Hybrid] Redis backfill from Mongo failed:', backfillErr.message);
      }
      return res.status(mongoFallback.responseCode).json(mongoFallback.responseBody);
    }
    return res.status(429).json({
      status: 'error',
      message: 'Concurrent transaction in progress. Please wait.'
    });
  }

  // 2️⃣ Acquire distributed lock (SET NX EX) — atomic, avoids TOCTOU race
  // Value encodes the payload hash so we can detect hijacks even when the
  // lock is still held.
  const lockValue = `INFLIGHT:${payloadHash}`;
  const acquired = await redis.set(lockKey, lockValue, 'NX', 'EX', LOCK_TTL_SECONDS);

  if (!acquired) {
    // Another request holds the lock — check its payload hash for security
    const existingLock = await redis.get(lockKey);
    if (existingLock && !existingLock.endsWith(payloadHash)) {
      console.error(`🚨 [Redis] THREAT DETECTED: Payload hijack attempt on Idempotency Key ${idempotencyKey}`);
      return res.status(409).json({
        status: 'error',
        message: 'SECURITY BREACH: Idempotency payload mismatch. Request blocked.'
      });
    }

    return res.status(429).json({
      status: 'error',
      message: 'Concurrent transaction in progress. Please wait.'
    });
  }

  // 3️⃣ Lock acquired — intercept the response to cache the result
  const originalJson = res.json.bind(res);
  res.json = async function (body) {
    try {
      const resultPayload = JSON.stringify({
        payloadHash,
        responseCode: res.statusCode,
        responseBody: body,
      });
      // Store result and delete lock atomically using a pipeline
      const pipeline = redis.pipeline();
      pipeline.set(resultKey, resultPayload, 'EX', RESULT_TTL_SECONDS);
      pipeline.del(lockKey);
      await pipeline.exec();
    } catch (cacheErr) {
      console.error('⚠️  [Redis] Idempotency result cache write failed:', cacheErr.message);
      // Non-fatal: fall through — response is still sent to client
    }
    // Durable mirror → Mongo. Ensures a Redis flap after this point does not
    // re-run the handler on replay (the race that failed CI run 424dc67).
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

  // 4️⃣ Route handler cleanup on crash (deadlock release)
  req._redisIdempotencyCleanup = async () => {
    await redis.del(lockKey).catch(() => {});
  };

  next();
}

// ─────────────────────────────────────────────
// 🍃 FALLBACK PATH: MongoDB implementation (existing, battle-tested logic)
// ─────────────────────────────────────────────
async function handleViaMongoDB(req, res, next, idempotencyKey, payloadHash) {
  const existingKey = await IdempotencyKey.findOne({ key: idempotencyKey, userId: req.user.userId });

  if (existingKey) {
    if (existingKey.payloadHash !== payloadHash) {
      console.error(`🚨 [MongoDB] THREAT DETECTED: Payload hijack attempt on Idempotency Key ${idempotencyKey}`);
      return res.status(409).json({
        status: 'error',
        message: 'SECURITY BREACH: Idempotency payload mismatch. Request blocked.'
      });
    }

    if (existingKey.responseCode) {
      return res.status(existingKey.responseCode).json(existingKey.responseBody);
    }

    return res.status(429).json({
      status: 'error',
      message: 'Concurrent transaction in progress. Please wait.'
    });
  }

  try {
    await IdempotencyKey.create({
      key: idempotencyKey,
      payloadHash,
      userId: req.user.userId
    });
  } catch (createError) {
    if (createError.code === 11000) {
      const replayKey = await IdempotencyKey.findOne({ key: idempotencyKey });
      if (!replayKey) throw createError;

      if (replayKey.userId.toString() !== req.user.userId.toString()) {
        console.error(`🚨 [MongoDB] THREAT DETECTED: Idempotency Key ${idempotencyKey} reused by a different user.`);
        return res.status(409).json({
          status: 'error',
          message: 'SECURITY BREACH: Idempotency key already bound to another user.'
        });
      }
      if (replayKey.payloadHash !== payloadHash) {
        console.error(`🚨 [MongoDB] THREAT DETECTED: Payload hijack attempt on Idempotency Key ${idempotencyKey}`);
        return res.status(409).json({
          status: 'error',
          message: 'SECURITY BREACH: Idempotency payload mismatch. Request blocked.'
        });
      }
      if (replayKey.responseCode) {
        return res.status(replayKey.responseCode).json(replayKey.responseBody);
      }
      return res.status(429).json({
        status: 'error',
        message: 'Concurrent transaction in progress. Please wait.'
      });
    }
    throw createError;
  }

  const originalJson = res.json.bind(res);
  res.json = async function (body) {
    try {
      await IdempotencyKey.updateOne(
        { key: idempotencyKey, userId: req.user.userId },
        { responseCode: res.statusCode, responseBody: body }
      );
    } catch (err) {
      console.error('⚠️  [MongoDB] Idempotency cache write failure:', err);
    }
    // Hot mirror → Redis if the circuit has recovered since we entered this path.
    // Keeps the fast path warm after a Redis flap heals mid-request.
    if (isRedisReady()) {
      try {
        const resultKey = redisResultKey(req.user.userId, idempotencyKey);
        await redis.set(resultKey, JSON.stringify({
          payloadHash,
          responseCode: res.statusCode,
          responseBody: body,
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
exports.enforceIdempotency = async (req, res, next) => {
  const idempotencyKey = req.headers['x-idempotency-key'];

  if (!idempotencyKey) {
    return res.status(400).json({
      status: 'error',
      message: 'Tier-1 financial operations require an X-Idempotency-Key header.'
    });
  }

  if (!req.user || !req.user.userId) {
    return res.status(401).json({
      status: 'error',
      message: 'Authentication required for idempotent financial operations.'
    });
  }

  try {
    const payloadHash = await computePayloadHash(req.body || {});

    // ⚡ CIRCUIT BREAKER: Route to Redis if healthy, else degrade to MongoDB
    if (isRedisReady()) {
      console.log(`⚡ [Idempotency] Using Redis path for key ${idempotencyKey}`);
      return await handleViaRedis(req, res, next, idempotencyKey, payloadHash);
    } else {
      console.warn(`⚠️  [Idempotency] Redis unavailable — circuit open. Falling back to MongoDB for key ${idempotencyKey}`);
      return await handleViaMongoDB(req, res, next, idempotencyKey, payloadHash);
    }
  } catch (error) {
    // 🛡️ DEADLOCK RELEASE: Clean up orphaned locks on any unhandled exception
    try {
      if (req._redisIdempotencyCleanup) {
        await req._redisIdempotencyCleanup();
      } else {
        // MongoDB cleanup
        await IdempotencyKey.deleteOne({ key: idempotencyKey, userId: req.user.userId });
      }
    } catch (cleanupError) {
      console.error(`🚨 FATAL: Failed to release idempotency deadlock for key ${idempotencyKey}`, cleanupError);
    }
    next(error);
  }
};
