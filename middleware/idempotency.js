const crypto = require('crypto');
const IdempotencyKey = require('../models/IdempotencyKey');

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

    const existingKey = await IdempotencyKey.findOne({ key: idempotencyKey, userId: req.user.userId });

    if (existingKey) {
      if (existingKey.payloadHash !== payloadHash) {
        console.error(`🚨 THREAT DETECTED: Payload hijack attempt on Idempotency Key ${idempotencyKey}`);
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
        if (!replayKey) {
          throw createError;
        }
        if (replayKey.userId.toString() !== req.user.userId.toString()) {
          console.error(`🚨 THREAT DETECTED: Idempotency Key ${idempotencyKey} reused by a different user.`);
          return res.status(409).json({
            status: 'error',
            message: 'SECURITY BREACH: Idempotency key already bound to another user.'
          });
        }
        if (replayKey.payloadHash !== payloadHash) {
          console.error(`🚨 THREAT DETECTED: Payload hijack attempt on Idempotency Key ${idempotencyKey}`);
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
    res.json = function (body) {
      IdempotencyKey.updateOne(
        { key: idempotencyKey, userId: req.user.userId },
        { responseCode: res.statusCode, responseBody: body }
      ).catch((err) => console.error('Idempotency cache write failure:', err));
      return originalJson(body);
    };

    next();
  } catch (error) {
    // 🛡️ DEADLOCK RELEASE: If the route crashes before sending a response, 
    // we must destroy the orphaned lock so the user can safely retry.
    try {
      await IdempotencyKey.deleteOne({ key: idempotencyKey, userId: req.user.userId });
    } catch (cleanupError) {
      console.error(`🚨 FATAL: Failed to release idempotency deadlock for key ${idempotencyKey}`, cleanupError);
    }
    next(error);
  }
};
