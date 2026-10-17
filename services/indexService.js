// services/indexService.js
// 🛡️ Phase-4 P0: production runs with mongoose autoIndex=false, so schema
// indexes (every unique constraint, every TTL) were never built on the live
// database — PaymentReceipt double-spend, WithdrawalLedger idempotency and
// User.phoneNumber uniqueness were all unenforced while tests (autoIndex on)
// stayed green.
//
// ensureIndexes() runs Model.createIndexes() for every registered model.
// createIndexes only CREATES (never drops), and is a no-op for indexes that
// already exist, so it is safe on every boot. Failures — typically existing
// duplicate rows that block a unique index — are collected and reported via
// getIndexState() so /health/readiness can fail closed instead of the server
// silently running without its integrity constraints.
'use strict';

const mongoose = require('mongoose');

const state = { status: 'pending', failures: [], checkedAt: null };

async function ensureIndexes() {
  state.status = 'building';
  const failures = [];
  for (const name of mongoose.modelNames()) {
    try {
      await mongoose.model(name).createIndexes();
    } catch (err) {
      failures.push({ model: name, reason: err.message });
    }
  }
  state.status = failures.length ? 'failed' : 'ok';
  state.failures = failures;
  state.checkedAt = new Date();
  return getIndexState();
}

function getIndexState() {
  return { status: state.status, failures: state.failures.slice(), checkedAt: state.checkedAt };
}

module.exports = { ensureIndexes, getIndexState };
