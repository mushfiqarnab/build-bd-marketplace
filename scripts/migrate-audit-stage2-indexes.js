#!/usr/bin/env node
// scripts/migrate-audit-stage2-indexes.js
//
// One-shot migration for the audit stage-2 schema changes. MongoDB cannot change an index in place, so the
// two OLD definitions have to be dropped before the app creates the corrected ones:
//
//   disputetickets   OLD unique {ledgerId, milestoneIndex}            NEW unique {ledgerId, milestoneIndex, round}
//                    (without it a second dispute on a restarted milestone can never get a ticket — audit D6)
//   paymentreceipts  OLD unique sparse {paymentMethod, trxId}         NEW unique partial {paymentMethod, trxId}
//                    where trxId is a string (sparse does not skip null, so the 2nd CASH receipt collided — audit H2)
//
// Run once per database BEFORE (or right after) the new code boots:
//
//   node --env-file=.env.beta scripts/migrate-audit-stage2-indexes.js            # apply
//   node --env-file=.env.beta scripts/migrate-audit-stage2-indexes.js --dry-run  # only report
//
// Idempotent. It only drops an index when its definition is exactly the OLD one, then asks Mongoose to build
// the new ones (createIndexes), so running it twice or on a fresh database is harmless.
'use strict';

const dns = require('dns');
const path = require('path');
const mongoose = require('mongoose');

const DRY = process.argv.includes('--dry-run');

const sameKeys = (a, b) => JSON.stringify(Object.entries(a || {})) === JSON.stringify(Object.entries(b));

const OLD = [
  {
    model: 'DisputeTicket', file: 'DisputeTicket', collection: 'disputetickets',
    isOld: (ix) => ix.unique === true && sameKeys(ix.key, { ledgerId: 1, milestoneIndex: 1 })
  },
  {
    model: 'PaymentReceipt', file: 'PaymentReceipt', collection: 'paymentreceipts',
    isOld: (ix) => ix.unique === true && ix.sparse === true && !ix.partialFilterExpression && sameKeys(ix.key, { paymentMethod: 1, trxId: 1 })
  }
];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is not set.'); process.exit(1); }
  if (uri.startsWith('mongodb+srv://')) {
    try { dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']); } catch (_) { /* resolver override is best-effort */ }
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, autoIndex: false });
  console.log(`[migrate] connected${DRY ? ' (dry run: nothing will be changed)' : ''}.`);

  for (const spec of OLD) {
    const coll = mongoose.connection.collection(spec.collection);
    let indexes = [];
    try { indexes = await coll.indexes(); } catch (err) {
      if (err.codeName === 'NamespaceNotFound' || err.code === 26) { console.log(`[migrate] ${spec.collection}: collection does not exist yet — nothing to drop.`); continue; }
      throw err;
    }
    const stale = indexes.filter(spec.isOld);
    if (!stale.length) { console.log(`[migrate] ${spec.collection}: no old index (already migrated or fresh).`); continue; }
    for (const ix of stale) {
      console.log(`[migrate] ${spec.collection}: ${DRY ? 'would drop' : 'dropping'} old index ${ix.name} ${JSON.stringify(ix.key)}`);
      if (!DRY) await coll.dropIndex(ix.name);
    }
  }

  if (!DRY) {
    for (const spec of OLD) {
      const M = require(path.join('..', 'models', spec.file));
      await M.createIndexes();
      console.log(`[migrate] ${spec.model}: indexes (re)built from the schema.`);
    }
  }

  await mongoose.disconnect();
  console.log(DRY ? '✅ Dry run complete.' : '✅ Migration complete.');
}

main().catch((err) => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
