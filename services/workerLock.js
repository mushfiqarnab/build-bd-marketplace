// services/workerLock.js
// Phase 30 / Roadmap §2.2: Distributed leader election lease for background workers.
// Prevents duplicate background work across multi-replica deployments (k8s replicas: 3)
// while gracefully failing open if Redis is unavailable.
'use strict';

const os = require('os');
const crypto = require('crypto');
const { redis, isRedisReady } = require('./redisClient');

const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

/**
 * Returns true if THIS process acquires the distributed lease for `jobName`.
 * Fails open (returns true) if Redis is down, ensuring background settlement/sweeps
 * never stop running during a Redis hiccup.
 *
 * @param {string} jobName Name of the worker (e.g. 'settlement', 'reconciliation')
 * @param {number} leaseSeconds Duration in seconds for which the lease is held
 * @returns {Promise<boolean>}
 */
async function acquireWorkerLease(jobName, leaseSeconds) {
  if (!isRedisReady()) return true; // fail open: concurrent runs beat stalled settlement
  try {
    const key = `worker:lease:${jobName}`;
    const acquired = await redis.set(key, INSTANCE_ID, 'NX', 'EX', Math.max(1, Math.floor(leaseSeconds)));
    return Boolean(acquired);
  } catch (_) {
    return true; // Redis command error -> fail open
  }
}

module.exports = { acquireWorkerLease, INSTANCE_ID };
