#!/usr/bin/env node
// scripts/migrate-idempotency-index.js
//
// One-shot migration for the Phase-1 IdempotencyKey schema change:
//   OLD: unique index on `key` alone
//   NEW: unique compound index on (`key`, `userId`)
//
// With the old index, two different users sending the same client-generated
// Idempotency-Key would collide — user 2's insert fails with a duplicate-key
// error. Run this script once per deployment BEFORE the new app code boots:
//
//   node --env-file=.env.beta scripts/migrate-idempotency-index.js
//
// Idempotent: safe to run many times. Prints what it changed.
'use strict';

const dns = require('dns');
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set.');
    process.exit(1);
  }

  // Mirror server.js: some Bangladeshi ISP resolvers fail on Atlas SRV lookups.
  if (uri.startsWith('mongodb+srv://')) {
    try { dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']); } catch (_) {}
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const coll = mongoose.connection.collection('idempotencykeys');
  const indexes = await coll.indexes();
  console.log(`[migrate] IdempotencyKey collection has ${indexes.length} index(es) before migration.`);

  // Drop the single-field unique index on `key` if it still exists.
  const stale = indexes.find((ix) => ix.key && ix.key.key === 1 && Object.keys(ix.key).length === 1 && ix.unique === true);
  if (stale) {
    console.log(`[migrate] Dropping stale unique index ${stale.name} on {key:1}…`);
    await coll.dropIndex(stale.name);
    console.log('[migrate] Dropped.');
  } else {
    console.log('[migrate] No stale single-field unique index on {key:1}. Skipping drop.');
  }

  // Create the compound unique index if it isn't there yet.
  const compound = indexes.find((ix) =>
    ix.key && ix.key.key === 1 && ix.key.userId === 1 && Object.keys(ix.key).length === 2 && ix.unique === true
  );
  if (!compound) {
    console.log('[migrate] Creating compound unique index on {key:1, userId:1}…');
    await coll.createIndex({ key: 1, userId: 1 }, { unique: true, name: 'key_1_userId_1' });
    console.log('[migrate] Created.');
  } else {
    console.log('[migrate] Compound unique index already present. Skipping create.');
  }

  const after = await coll.indexes();
  console.log(`[migrate] IdempotencyKey collection has ${after.length} index(es) after migration.`);
  await mongoose.disconnect();
  console.log('✅ Migration complete.');
}

main().catch((err) => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
