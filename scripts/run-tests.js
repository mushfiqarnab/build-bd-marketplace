#!/usr/bin/env node
// scripts/run-tests.js — autonomous test orchestrator for `npm test`.
//
// Order of decisions:
//   1. DOCKER_BUILD_SKIP_DB_TESTS=true  -> syntax-check every first-party .js file and run the
//      DB-free unit suite only (used inside `docker build`, where no MongoDB exists).
//   2. Otherwise probe process.env.MONGODB_URI. It is used only if it answers within 2.5 s
//      AND is a replica set (transactions need one; a standalone mongod is NOT enough).
//   3. Otherwise boot a 1-node in-memory replica set (mongodb-memory-server), in memory only.
//      .env on disk is never read for writing and never changed.
// Every suite runs in its own process with a hard timeout, so a hung suite fails loudly
// instead of blocking forever. The in-memory replica set is always stopped at the end.
//
// Suites run with ASYNC spawn on purpose: mongodb-memory-server reads mongod's log output
// through a pipe in THIS process. A blocking spawnSync stops that pipe from being read,
// mongod blocks on the full pipe and every query hangs (diagnosed in step 31.8).
'use strict';

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const SUITES = [
  'tests/frontend-unit.js',
  'tests/evidence-service-unit.js',
  'tests/sanitize-unit.js',
  'tests/route-policy-unit.js',
  'tests/deps-declared-unit.js',
  'tests/storage-adapter-unit.js',
  'tests/rate-limiter-unit.js',
  'tests/auditlog-e2e.js',
  'tests/bidding-guards-e2e.js',
  'tests/dispute-e2e.js',
  'tests/escrow-e2e.js',
  'tests/finance-e2e.js',
  'tests/governance-e2e.js',
  'tests/idempotency-e2e.js',
  'tests/idempotency-race-e2e.js',
  'tests/phase1-ship-blockers-e2e.js',
  'tests/phase2-ssl-money-e2e.js',
  'tests/phase3-hardening-e2e.js',
  'tests/phase-b-reconciliation-e2e.js',
  'tests/phase4-money-integrity-e2e.js',
  'tests/f2-session-auth-e2e.js',
  'tests/otp-delivery-e2e.js',
  'tests/payment-e2e.js',
  'tests/settlement-e2e.js',
  'tests/marketplace-e2e.js',
  'tests/proof-upload-e2e.js',
  'tests/query-engine-e2e.js',
  'tests/reconciliation-e2e.js',
  'tests/settlement-offline-e2e.js',
  'tests/arbitration-e2e.js',
  'tests/money-state-machine-fuzz-e2e.js',
  'tests/money-lifecycle-fuzz-e2e.js',
  'tests/admin-refunds-e2e.js',
  'tests/contract-formation-e2e.js',
  'tests/admin-queues-e2e.js',
  'tests/contractor-directory-e2e.js',
  'tests/supplier-kyc-e2e.js',
  'tests/materials-catalog-e2e.js',
  'tests/material-orders-e2e.js',
  'tests/materials-ledger-e2e.js',
  'tests/phase2-my-projects-delegation-e2e.js',
  'tests/phase3-material-transparency-exif-e2e.js',
  'tests/audit-stage1-e2e.js',
  'tests/audit-stage2-e2e.js',
  'tests/transaction-retry-e2e.js',
  'tests/chat-reputation-e2e.js',
  'tests/chat-accept-offer-award-e2e.js',
  'tests/server-smoke-e2e.js',
  'tests/rate-limiter-distributed-e2e.js',
  'tests/share-token-financial-boundary-e2e.js',
  'tests/worker-lock-unit.js',
  'tests/bid-anomaly-unit.js',
  'tests/notification-service-unit.js',
  'tests/sybil-audit-unit.js',
  'tests/logger-observability-unit.js',
  'tests/frontend-money-interaction-unit.js',
  'tests/link-to-sink-matrix-e2e.js',
  'tests/launch-innovations-e2e.js' // optional: skipped (and reported) if the file does not exist
];
const OPTIONAL_SUITES = new Set(['tests/launch-innovations-e2e.js']);
const DB_FREE_SUITES = ['tests/frontend-unit.js', 'tests/evidence-service-unit.js', 'tests/sanitize-unit.js', 'tests/route-policy-unit.js', 'tests/deps-declared-unit.js', 'tests/storage-adapter-unit.js', 'tests/bid-anomaly-unit.js', 'tests/notification-service-unit.js', 'tests/sybil-audit-unit.js', 'tests/logger-observability-unit.js', 'tests/frontend-money-interaction-unit.js'];

const SUITE_TIMEOUT_MS = Number(process.env.SUITE_TIMEOUT_MS || 300000);
// Suites always use the storage MOCK, even when .env holds real R2/S3 settings: the e2e suites
// confirm uploads that never happened, and must never write to a real bucket. To run them
// against real storage on purpose, set TEST_STORAGE_PROVIDER (e.g. r2).
const SUITE_STORAGE_PROVIDER = process.env.TEST_STORAGE_PROVIDER || 'mock';
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 2500);
const SYNTAX_DIRS = ['middleware', 'models', 'routes', 'services', 'utils', 'scripts', 'tests'];

const line = () => console.log('─'.repeat(64));

function listJsFiles(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

function runSuite(suite, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);
    let settled = false;
    let timedOut = false;
    const finish = (row) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(row);
    };
    const child = spawn(process.execPath, [suite], { cwd: ROOT, stdio: 'inherit', env, windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SUITE_TIMEOUT_MS);
    child.on('error', (err) => finish({ suite, ok: false, seconds: elapsed(), detail: `spawn error: ${err.message}` }));
    child.on('exit', (code, signal) => {
      if (timedOut) return finish({ suite, ok: false, seconds: elapsed(), detail: `TIMED OUT after ${SUITE_TIMEOUT_MS / 1000} s (killed)` });
      if (code !== 0) return finish({ suite, ok: false, seconds: elapsed(), detail: `exit ${code}${signal ? ` (signal ${signal})` : ''}` });
      return finish({ suite, ok: true, seconds: elapsed(), detail: 'exit 0' });
    });
  });
}

function printSummary(rows) {
  line();
  console.log('SUITE'.padEnd(40), 'RESULT'.padEnd(8), 'TIME'.padEnd(8), 'DETAIL');
  for (const r of rows) {
    console.log(r.suite.padEnd(40), (r.skipped ? 'SKIP' : r.ok ? 'PASS' : 'FAIL').padEnd(8), (r.seconds === '-' ? '-' : `${r.seconds}s`).padEnd(8), r.detail);
  }
  line();
}

async function probeUri(uri) {
  if (!uri) return { usable: false, reason: 'MONGODB_URI is not set' };
  const mongoose = require('mongoose');
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: PROBE_TIMEOUT_MS });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName) return { usable: false, reason: 'reachable but NOT a replica set (transactions would fail)' };
    return { usable: true, reason: `replica set "${hello.setName}" reachable` };
  } catch (err) {
    return { usable: false, reason: `unreachable (${err.message.split('\n')[0]})` };
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

async function main() {
  const rows = [];

  // 1. Docker build mode: no database available.
  if (process.env.DOCKER_BUILD_SKIP_DB_TESTS === 'true') {
    console.log('🐳 DOCKER_BUILD_SKIP_DB_TESTS=true -> syntax check + DB-free unit suite only.');
    const files = ['server.js', ...SYNTAX_DIRS.flatMap(listJsFiles)];
    const bad = [];
    for (const file of files) {
      const r = spawnSync(process.execPath, ['--check', file], { cwd: ROOT, encoding: 'utf8' });
      if (r.status !== 0) bad.push(`${file}: ${(r.stderr || '').trim().split('\n')[0]}`);
    }
    rows.push({ suite: `syntax check (${files.length} files)`, ok: bad.length === 0, seconds: '-', detail: bad.length ? bad.join(' | ') : 'all parse' });
    for (const suite of DB_FREE_SUITES) rows.push(await runSuite(suite, { ...process.env, STORAGE_PROVIDER: SUITE_STORAGE_PROVIDER }));
    printSummary(rows);
    return rows.every((r) => r.ok) ? 0 : 1;
  }

  // 2./3. Choose the database.
  let replSet = null;
  let activeUri = process.env.MONGODB_URI;
  const probe = await probeUri(activeUri);
  if (probe.usable) {
    console.log(`🗄️  Using MONGODB_URI from the environment: ${probe.reason}.`);
  } else {
    console.log(`🗄️  MONGODB_URI not usable: ${probe.reason}. Booting an in-memory 1-node replica set...`);
    let MongoMemoryReplSet;
    try {
      ({ MongoMemoryReplSet } = require('mongodb-memory-server'));
    } catch (_) {
      console.error('💥 mongodb-memory-server is not installed. Run: npm install --save-dev mongodb-memory-server');
      return 1;
    }
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger', name: 'rs0' },
      instanceOpts: [{ ip: '127.0.0.1' }]
    });
    activeUri = replSet.getUri();
    console.log(`🧪 In-memory replica set ready at ${activeUri} (memory only; .env untouched).`);
  }

  const stopReplSet = async () => {
    if (replSet) {
      const rs = replSet;
      replSet = null;
      await rs.stop({ doCleanup: true, force: true }).catch((e) => console.warn('⚠️ replSet stop:', e.message));
      console.log('🧹 In-memory replica set stopped.');
    }
  };
  const onSignal = async () => { await stopReplSet(); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      ALLOW_MOCK_STORAGE: 'true',
      PAYMENTS_DISABLED: 'false',
      OTP_DELIVERY: 'console',
      BETA_ALLOWED_PHONES: '',
      MONGODB_URI: activeUri,
      STORAGE_PROVIDER: SUITE_STORAGE_PROVIDER
    };
    // `node scripts/run-tests.js --only fuzz` runs just the matching suite(s).
    const onlyAt = process.argv.indexOf('--only');
    const only = onlyAt !== -1 ? process.argv[onlyAt + 1] : null;
    for (let i = 0; i < SUITES.length; i++) {
      const suite = SUITES[i];
      if (only && !suite.includes(only)) continue;
      if (!fs.existsSync(path.join(ROOT, suite))) {
        if (OPTIONAL_SUITES.has(suite)) {
          rows.push({ suite, ok: true, skipped: true, seconds: '-', detail: 'optional suite not present' });
          continue;
        }
        rows.push({ suite, ok: false, seconds: '-', detail: 'FILE MISSING' });
        break;
      }
      line();
      console.log(`▶ [${i + 1}/${SUITES.length}] RUNNING: ${suite}`);
      line();
      const r = await runSuite(suite, env);
      rows.push(r);
      if (!r.ok) break; // fail fast
    }
  } finally {
    await stopReplSet();
  }

  if (!rows.length) rows.push({ suite: '(--only filter)', ok: false, seconds: '-', detail: 'no suite matched' });
  printSummary(rows);
  const failed = rows.find((r) => !r.ok);
  if (failed) {
    console.error(`💥 FAILED at ${failed.suite}: ${failed.detail}`);
    return 1;
  }
  console.log(`✅ ALL ${rows.filter((r) => !r.skipped).length} SUITES PASSED`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('💥 run-tests crashed:', err);
    process.exit(1);
  });
