#!/usr/bin/env node
// scripts/migrate-paidbyvalid-index.js
//
// One-shot migration for Phase-2 P0-4 — adds a unique sparse index on
// EscrowLedger.paidByValId so the same SSLCommerz val_id can never fund two
// different ledgers. Idempotent; safe to run many times.
//
//   node --env-file=.env.beta scripts/migrate-paidbyvalid-index.js
//
// If existing data already has duplicate non-null paidByValId values, the
// index creation would fail. The script detects this case and prints the
// duplicates with their ledger IDs so an operator can resolve manually.
'use strict';

const dns = require('dns');
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set.');
    process.exit(1);
  }

  if (uri.startsWith('mongodb+srv://')) {
    try { dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']); } catch (_) {}
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const coll = mongoose.connection.collection('escrowledgers');

  const dups = await coll.aggregate([
    { $match: { paidByValId: { $ne: null, $exists: true } } },
    { $group: { _id: '$paidByValId', ledgers: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } }
  ]).toArray();

  if (dups.length) {
    console.error(`❌ Cannot create unique index: ${dups.length} val_id(s) are already shared across multiple ledgers:`);
    for (const d of dups) {
      console.error(`   val_id=${d._id} on ledgers=${d.ledgers.join(', ')}`);
    }
    console.error('Resolve the duplicates (null out paidByValId on the losing ledgers after audit) and re-run.');
    await mongoose.disconnect();
    process.exit(2);
  }

  const indexes = await coll.indexes();
  // Drop any older sparse index on paidByValId — sparse treats null as a value
  // so it conflicts across the many pre-IPN ledgers that store default null.
  for (const ix of indexes) {
    if (ix.key && ix.key.paidByValId === 1 && Object.keys(ix.key).length === 1
        && ix.unique === true && !ix.partialFilterExpression) {
      console.log(`[migrate] Dropping older unique index ${ix.name} (sparse: ${!!ix.sparse}, no partial filter)…`);
      await coll.dropIndex(ix.name);
    }
  }

  const after1 = await coll.indexes();
  const existing = after1.find((ix) =>
    ix.key && ix.key.paidByValId === 1
    && ix.unique === true
    && ix.partialFilterExpression
    && ix.partialFilterExpression.paidByValId
    && ix.partialFilterExpression.paidByValId.$type === 'string'
  );
  if (existing) {
    console.log(`[migrate] Unique partial index on paidByValId already present (name: ${existing.name}). Nothing to do.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log('[migrate] Creating unique partial index on EscrowLedger.paidByValId (string values only)…');
  await coll.createIndex(
    { paidByValId: 1 },
    { unique: true, partialFilterExpression: { paidByValId: { $type: 'string' } }, name: 'paidByValId_1' }
  );
  console.log('[migrate] Created.');

  const after = await coll.indexes();
  console.log(`[migrate] EscrowLedger has ${after.length} indexes after migration.`);
  await mongoose.disconnect();
  console.log('✅ Migration complete.');
}

main().catch((err) => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
