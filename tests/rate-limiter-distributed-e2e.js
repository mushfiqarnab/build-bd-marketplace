// tests/rate-limiter-distributed-e2e.js
// Regression test for §1.1: Distributed Rate Limiting across multiple pods
// Proves that two distinct rate-limit instances simulating independent pods
// share state via Redis, enforcing the rate limit globally.
'use strict';

const rateLimit = require('express-rate-limit');
const { DistributedRedisStore } = require('../middleware/rateLimiter');
const { redis, isRedisReady } = require('../services/redisClient');
require('dotenv').config();

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log('🧪 distributed rate-limiter multi-pod e2e verification');

  // Wait for Redis connection
  let attempts = 0;
  while (!isRedisReady() && attempts < 20) {
    await sleep(200);
    attempts++;
  }

  if (!isRedisReady()) {
    console.warn('⚠️  Redis unavailable — skipping distributed test (requires Redis).');
    process.exit(0);
  }

  const testKey = `dist-test-user-${Date.now()}`;
  const prefix = `testpod:${Date.now()}`;

  // Simulate Pod A and Pod B: two independent rate-limiter instances
  // configured with limit: 3 over 10 seconds, sharing the Redis store prefix
  const podA = rateLimit({
    windowMs: 10000,
    limit: 3,
    store: new DistributedRedisStore(prefix),
    keyGenerator: () => testKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { status: 'error', message: 'Rate limit exceeded' }
  });

  const podB = rateLimit({
    windowMs: 10000,
    limit: 3,
    store: new DistributedRedisStore(prefix),
    keyGenerator: () => testKey,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { status: 'error', message: 'Rate limit exceeded' }
  });

  const makeReq = () => ({ ip: '10.0.0.1', headers: {} });
  const invoke = (limiter) => new Promise((resolve, reject) => {
    const req = makeReq();
    const res = {
      statusCode: 200,
      headers: {},
      writableEnded: false,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      append(k, v) { this.headers[k.toLowerCase()] = v; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.writableEnded = true; resolve({ status: this.statusCode, headers: this.headers, body }); },
      send(body) { this.writableEnded = true; resolve({ status: this.statusCode, headers: this.headers, body }); }
    };
    limiter(req, res, (err) => {
      if (err) return reject(err);
      resolve({ status: 200, headers: res.headers, body: null });
    });
  });

  // Hit Pod A twice
  const r1 = await invoke(podA);
  check('Pod A request 1 passes (status 200)', r1.status === 200);

  const r2 = await invoke(podA);
  check('Pod A request 2 passes (status 200)', r2.status === 200);

  // Hit Pod B once (3rd request across cluster)
  const r3 = await invoke(podB);
  check('Pod B request 3 passes (status 200)', r3.status === 200);

  // 4th request from Pod B MUST be blocked with 429 because cluster limit of 3 was reached
  const r4 = await invoke(podB);
  check('Pod B request 4 is throttled with 429 (cluster limit enforced across pods)', r4.status === 429);
  check('Pod B 429 response body contains rate limit error message', r4.body && r4.body.message === 'Rate limit exceeded');

  // Also verify Pod A now also sees 429
  const r5 = await invoke(podA);
  check('Pod A request 5 is also throttled with 429', r5.status === 429);

  // Clean up Redis test key
  await redis.del(`rl:${prefix}:${testKey}`);
  await redis.quit();

  if (failed > 0) {
    console.error(`💥 ${failed} checks failed.`);
    process.exit(1);
  } else {
    console.log('--- Results: all passed ---');
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('💥 Test crashed:', err);
  process.exit(1);
});
