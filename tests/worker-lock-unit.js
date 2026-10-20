// tests/worker-lock-unit.js
// Unit test for §2.2: Distributed Leader Election for Background Workers
'use strict';

const { acquireWorkerLease } = require('../services/workerLock');
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
  console.log('🧪 worker leader election unit test');

  let attempts = 0;
  while (!isRedisReady() && attempts < 20) {
    await sleep(200);
    attempts++;
  }

  if (!isRedisReady()) {
    console.warn('⚠️ Redis not ready, testing fail-open behavior.');
    const lease = await acquireWorkerLease('test-job', 5);
    check('acquireWorkerLease fails open when Redis is unavailable', lease === true);
    process.exit(0);
  }

  const jobName = `test-job-${Date.now()}`;

  // First acquisition must succeed
  const lease1 = await acquireWorkerLease(jobName, 2);
  check('First lease acquisition succeeds (returns true)', lease1 === true);

  // Immediate second acquisition for the same job must be rejected (returns false)
  const lease2 = await acquireWorkerLease(jobName, 2);
  check('Second concurrent acquisition for the same job is rejected (returns false)', lease2 === false);

  // Different job acquisition succeeds independently
  const leaseOther = await acquireWorkerLease(`other-${jobName}`, 2);
  check('Independent job acquisition succeeds', leaseOther === true);

  // Wait for 2.2 seconds for lease to expire
  await sleep(2200);

  // Re-acquisition after TTL expiry must succeed
  const lease3 = await acquireWorkerLease(jobName, 2);
  check('Re-acquisition after lease expiry succeeds', lease3 === true);

  // Cleanup
  await redis.del(`worker:lease:${jobName}`);
  await redis.del(`worker:lease:other-${jobName}`);
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
