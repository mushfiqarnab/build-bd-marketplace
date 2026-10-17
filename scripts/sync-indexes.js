#!/usr/bin/env node
// scripts/sync-indexes.js — build every schema index on the target database.
//
//   node --env-file=.env.beta scripts/sync-indexes.js
//
// Non-destructive (create-only) and idempotent. Exits 1 if any model's
// indexes could not be built, printing the reason (usually duplicate rows
// that violate a unique index — resolve those, then re-run).
'use strict';

const dns = require('dns');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { ensureIndexes } = require('../services/indexService');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set.'); process.exit(1); }
  if (uri.startsWith('mongodb+srv://')) {
    try { dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']); } catch (_) {}
  }

  const modelsDir = path.join(__dirname, '..', 'models');
  for (const file of fs.readdirSync(modelsDir).filter((f) => f.endsWith('.js'))) {
    require(path.join(modelsDir, file));
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, autoIndex: false });
  const result = await ensureIndexes();

  for (const name of mongoose.modelNames().sort()) {
    const coll = mongoose.model(name).collection;
    const ix = await coll.indexes().catch(() => []);
    console.log(`  ${name.padEnd(20)} ${ix.map((i) => i.name).join(', ')}`);
  }
  await mongoose.disconnect();

  if (result.status !== 'ok') {
    console.error('❌ Some indexes could not be built:');
    for (const f of result.failures) console.error(`   ${f.model}: ${f.reason}`);
    process.exit(1);
  }
  console.log('✅ All schema indexes present.');
}

main().catch((err) => { console.error('❌ sync-indexes failed:', err.message); process.exit(1); });
