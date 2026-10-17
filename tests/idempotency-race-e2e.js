// tests/idempotency-race-e2e.js
// Regression test for the idempotency Redis-flap race.
//
// Simulates three states a long-lived idempotency key will see in production:
//   1. Redis up:              first request runs; response caches in Redis + Mongo.
//   2. Redis down:            replay must serve the Mongo-cached response (no re-run).
//   3. Redis up, empty cache: replay must fall back to Mongo (no re-run) and
//                             backfill the Redis result key.
//
// The invariant is money: the governance milestone-approve handler moves funds,
// so a double-execution would double contractor.wallet.pendingClearance.

'use strict';

const dns = require('dns');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (_) { /* best effort */ }

// ─── Inject a fake Redis client BEFORE any module that requires it loads ───
const redisStore = new Map();
let fakeReady = true;

const fakeRedis = {
  async get(key) {
    return redisStore.has(key) ? redisStore.get(key) : null;
  },
  async set(key, value, ...rest) {
    // Support ioredis variadic form: set(key, val, 'NX', 'EX', ttl)
    if (rest.includes('NX') && redisStore.has(key)) return null;
    redisStore.set(key, value);
    return 'OK';
  },
  async del(key) {
    const existed = redisStore.has(key);
    redisStore.delete(key);
    return existed ? 1 : 0;
  },
  pipeline() {
    const ops = [];
    const p = {
      set(key, value, ...rest) { ops.push(['set', key, value, ...rest]); return p; },
      del(key) { ops.push(['del', key]); return p; },
      async exec() {
        const out = [];
        for (const [op, ...args] of ops) {
          if (op === 'set') out.push([null, await fakeRedis.set(...args)]);
          else if (op === 'del') out.push([null, await fakeRedis.del(...args)]);
        }
        return out;
      }
    };
    return p;
  }
};

const redisModulePath = require.resolve('../services/redisClient');
require.cache[redisModulePath] = {
  id: redisModulePath,
  filename: redisModulePath,
  loaded: true,
  exports: {
    redis: fakeRedis,
    isRedisReady: () => fakeReady,
    closeRedis: async () => {},
    getRedisTelemetry: () => ({ ready: fakeReady, status: fakeReady ? 'ready' : 'end', uptimeMs: 0 })
  }
};

// ─── Now safe to load the rest ──────────────────────────────────────────────
const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');
const IdempotencyKey = require('../models/IdempotencyKey');
const auth = require('../middleware/auth');

function postJson(port, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathName, method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000
  });
  await IdempotencyKey.deleteMany({});

  const admin = await User.findOneAndUpdate(
    { role: 'ADMIN', phoneNumber: process.env.TREASURY_PHONE || '01700000000' },
    {
      $set: { wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 }, status: 'ACTIVE' },
      $setOnInsert: { role: 'ADMIN', phoneNumber: process.env.TREASURY_PHONE || '01700000000' }
    },
    { upsert: true, returnDocument: 'after' }
  );

  const client = await User.create({
    role: 'CLIENT',
    phoneNumber: `016${Math.floor(10000000 + Math.random() * 90000000)}`,
    wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 },
    status: 'ACTIVE'
  });

  const contractor = await User.create({
    role: 'CONTRACTOR',
    phoneNumber: `018${Math.floor(10000000 + Math.random() * 90000000)}`,
    wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 },
    status: 'ACTIVE'
  });

  const ledger = await EscrowLedger.create({
    clientId: client._id,
    contractorId: contractor._id,
    projectId: contractor._id,
    totalContractValue: 1000,
    ledgerStatus: 'FUNDED',
    milestones: [{ title: 'Foundation', amount: 1000, releasePercentage: 100, status: 'PROOF_SUBMITTED' }]
  });

  auth.verifyToken = (req, res, next) => {
    req.user = { userId: req.headers['x-user-id'] || client._id.toString(), role: req.headers['x-role'] || 'CLIENT' };
    next();
  };
  auth.requireRole = (roles) => (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ message: 'Forbidden' });
    next();
  };

  const governanceRouter = require('../routes/governance');
  const app = express();
  app.use(express.json());
  app.use('/api/governance', governanceRouter);
  const server = app.listen(0);
  const port = server.address().port;

  const headers = {
    'x-idempotency-key': `race-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    'x-role': 'CLIENT',
    'x-user-id': client._id.toString()
  };
  const url = `/api/governance/approve/${ledger._id}/milestone/0`;

  try {
    // ── Phase 1: Redis up. Fresh request runs. Response should mirror to Mongo. ──
    fakeReady = true;
    redisStore.clear();

    const first = await postJson(port, url, { amount: 1000 }, headers);
    if (first.status !== 200) throw new Error(`Phase 1 (Redis up, fresh): expected 200, got ${first.status} — ${JSON.stringify(first.body)}`);

    const afterFirst = await User.findById(contractor._id);
    if (afterFirst.wallet.pendingClearance !== 950) {
      throw new Error(`Phase 1 side-effect wrong: pendingClearance=${afterFirst.wallet.pendingClearance} (expected 950)`);
    }

    const mirrored = await IdempotencyKey.findOne({ key: headers['x-idempotency-key'] });
    if (!mirrored) throw new Error('Dual-write broken: Redis path did not mirror to Mongo (findOne returned null)');
    if (!mirrored.responseCode) throw new Error(`Dual-write incomplete: Mongo mirror has no responseCode (got ${mirrored.responseCode})`);

    // ── Phase 2: Redis crashes mid-session. Replay must serve from Mongo. ──
    redisStore.clear();
    fakeReady = false;

    const second = await postJson(port, url, { amount: 1000 }, headers);
    if (second.status !== 200) throw new Error(`Phase 2 (Redis down, replay): expected 200, got ${second.status} — ${JSON.stringify(second.body)}`);

    const afterSecond = await User.findById(contractor._id);
    if (afterSecond.wallet.pendingClearance !== 950) {
      throw new Error(`Phase 2 re-ran handler: pendingClearance=${afterSecond.wallet.pendingClearance} (expected 950, double would be 1900)`);
    }

    // ── Phase 3: Redis recovers but has no cache. Replay must fall back to Mongo. ──
    fakeReady = true;
    // redisStore stays empty: Redis-up with no result key is the hybrid-path case.

    const third = await postJson(port, url, { amount: 1000 }, headers);
    if (third.status !== 200) throw new Error(`Phase 3 (Redis up, empty): expected 200, got ${third.status} — ${JSON.stringify(third.body)}`);

    const afterThird = await User.findById(contractor._id);
    if (afterThird.wallet.pendingClearance !== 950) {
      throw new Error(`Phase 3 re-ran handler: pendingClearance=${afterThird.wallet.pendingClearance} (expected 950) — Redis-miss path did NOT consult Mongo`);
    }

    const backfilled = await fakeRedis.get(`idem:result:${client._id.toString()}:${headers['x-idempotency-key']}`);
    if (!backfilled) throw new Error('Phase 3 did not backfill Redis after serving from Mongo');

    console.log('✅ Idempotency race fix verified: dual-write + Mongo fallback + Redis backfill all work.');
    process.exit(0);
  } finally {
    await new Promise((r) => server.close(r));
    await EscrowLedger.findByIdAndDelete(ledger._id);
    await User.findByIdAndDelete(client._id);
    await User.findByIdAndDelete(contractor._id);
    await User.findByIdAndDelete(admin._id);
    await IdempotencyKey.deleteMany({ key: headers['x-idempotency-key'] });
  }
}

run().catch((err) => {
  console.error('💥 IDEMPOTENCY RACE TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
