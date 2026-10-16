// scripts/run-tests.js
// Autonomous, zero-configuration test runner for local, Docker, and CI environments.
// Detects if a live MongoDB replica set is reachable; if not, spins up an ephemeral
// in-memory WiredTiger replica set, runs all 15 test suites sequentially, and terminates cleanly.

'use strict';

require('dotenv').config();
const path = require('path');
const { spawnSync } = require('child_process');
const mongoose = require('mongoose');

const TEST_SUITES = [
  'tests/evidence-service-unit.js',
  'tests/auditlog-e2e.js',
  'tests/bidding-guards-e2e.js',
  'tests/dispute-e2e.js',
  'tests/escrow-e2e.js',
  'tests/finance-e2e.js',
  'tests/governance-e2e.js',
  'tests/idempotency-e2e.js',
  'tests/marketplace-e2e.js',
  'tests/proof-upload-e2e.js',
  'tests/query-engine-e2e.js',
  'tests/reconciliation-e2e.js',
  'tests/settlement-offline-e2e.js',
  'tests/arbitration-e2e.js',
  'tests/chat-reputation-e2e.js'
];

async function main() {
  console.log('\n============================================================');
  console.log('🚀 BUILD-BD AUTONOMOUS TEST ORCHESTRATOR');
  console.log('============================================================\n');

  let replSet = null;
  let activeUri = process.env.MONGODB_URI;
  let isReachable = false;

  if (activeUri) {
    try {
      console.log(`🔍 Probing connection to MONGODB_URI (${activeUri.replace(/\/\/.*@/, '//***:***@')})...`);
      await mongoose.connect(activeUri, { serverSelectionTimeoutMS: 2500 });
      isReachable = true;
      console.log('✅ Existing MongoDB connection reachable. Reusing external replica set.\n');
    } catch (probeErr) {
      console.log(`⚠️ Existing MONGODB_URI unreachable (${probeErr.message}).`);
    } finally {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    }
  }

  if (!isReachable) {
    console.log('⚡ Booting autonomous 1-node WiredTiger MongoMemoryReplSet (rs0)...');
    const { MongoMemoryReplSet } = require('mongodb-memory-server');
    replSet = await MongoMemoryReplSet.create({
      replSet: {
        count: 1,
        storageEngine: 'wiredTiger',
        name: 'rs0'
      }
    });
    activeUri = replSet.getUri();
    console.log(`✅ Ephemeral MongoDB Replica Set online at: ${activeUri}\n`);
  }

  const cleanup = async () => {
    if (replSet) {
      console.log('\n🛑 Shutting down ephemeral MongoDB Replica Set...');
      try {
        await replSet.stop();
        console.log('✅ Ephemeral Replica Set stopped cleanly.');
      } catch (stopErr) {
        console.warn('⚠️ Error stopping Replica Set:', stopErr.message);
      }
      replSet = null;
    }
  };

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(143);
  });

  const totalSuites = TEST_SUITES.length;
  let passedSuites = 0;

  try {
    for (let i = 0; i < totalSuites; i++) {
      const suiteRelPath = TEST_SUITES[i];
      const suiteAbsPath = path.resolve(__dirname, '..', suiteRelPath);
      console.log(`\n────────────────────────────────────────────────────────────`);
      console.log(`▶ [${i + 1}/${totalSuites}] RUNNING: ${suiteRelPath}`);
      console.log(`────────────────────────────────────────────────────────────`);

      const result = spawnSync(process.execPath, [suiteAbsPath], {
        stdio: 'inherit',
        env: {
          ...process.env,
          MONGODB_URI: activeUri,
          NODE_ENV: 'test'
        }
      });

      if (result.status !== 0) {
        throw new Error(`Test suite failed (${suiteRelPath}) with exit code ${result.status}`);
      }
      passedSuites++;
    }

    console.log('\n============================================================');
    console.log(`🏁 ALL ${passedSuites}/${totalSuites} TEST SUITES PASSED AUTONOMOUSLY (EXIT CODE 0)`);
    console.log('============================================================\n');
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error('\n💥 TEST RUNNER FATAL EXCEPTION:', err.message);
  process.exit(1);
});
