// tests/admin-refunds-e2e.js
// Admin refund queue for orphan gateway payments (routes/admin.js):
//   - only ADMIN can list or complete refunds
//   - the pending list carries amount, ids, reason and the client's phone
//   - completing needs a real SSLCommerz refund reference, writes an audit
//     entry in the same transaction, and a second completion is a 409
'use strict';

const dotenv = require('dotenv');
dotenv.config();
process.env.PORT = '0';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

const User = require('../models/User');
const Project = require('../models/Project');
const EscrowLedger = require('../models/EscrowLedger');
const AuditLog = require('../models/AuditLog');

const PHONE_PREFIX = '0199117';
let seq = 0;
const phone = () => `${PHONE_PREFIX}${String(seq++).padStart(4, '0')}`;
let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failed += 1; console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function main() {
  if (!appServer.listening) await new Promise((r) => appServer.once('listening', r));
  const base = `http://127.0.0.1:${appServer.address().port}/api`;
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('🧪 admin refund queue');

  const [admin, client, contractor] = await Promise.all([
    User.create({ role: 'ADMIN', phoneNumber: phone(), status: 'ACTIVE' }),
    User.create({ role: 'CLIENT', phoneNumber: phone(), status: 'ACTIVE' }),
    User.create({ role: 'CONTRACTOR', phoneNumber: phone(), status: 'ACTIVE' })
  ]);
  const tok = (u) => jwt.sign({ userId: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  let key = 0;
  const req = async (method, path, user, body) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok(user)}`, 'x-idempotency-key': `refund-e2e-${Date.now()}-${key++}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    let json = null;
    try { json = await r.json(); } catch (_) { /* empty */ }
    return { status: r.status, body: json };
  };

  const project = await Project.create({
    title: 'Refund queue project', category: 'Residential', description: 'Orphan payment refunds.',
    location: 'Dhaka', budget: 250000, clientId: client._id, status: 'OPEN'
  });
  const ledger = await EscrowLedger.create({
    projectId: project._id, clientId: client._id, contractorId: contractor._id,
    totalContractValue: 250000, ledgerStatus: 'CANCELLED',
    milestones: [{ title: 'Stage 1', releasePercentage: 100, amount: 250000 }],
    orphanPayments: [
      { tranId: 'BUILDBD-T1', valId: 'VAL-REFUND-1', amount: 250000, reason: 'LEDGER_CANCELLED', receivedAt: new Date(Date.now() - 60000) },
      { tranId: 'BUILDBD-T2', valId: 'VAL-REFUND-2', amount: 250000, reason: 'LEDGER_CANCELLED' }
    ]
  });

  try {
    check('client cannot list refunds (403)', (await req('GET', '/admin/refunds', client)).status === 403);
    check('contractor cannot complete a refund (403)',
      (await req('POST', `/admin/refunds/${ledger._id}/VAL-REFUND-1/complete`, contractor, { refundReference: 'SSLREF-001' })).status === 403);

    const list = await req('GET', '/admin/refunds', admin);
    const mine = (list.body?.data?.refunds || []).filter((r) => String(r.ledgerId) === String(ledger._id));
    check('admin sees both pending refunds, newest first', list.status === 200 && mine.length === 2 && mine[0].valId === 'VAL-REFUND-2', JSON.stringify(list.body));
    check('pending row carries amount, reason and client phone',
      mine[0] && mine[0].amount === 250000 && mine[0].reason === 'LEDGER_CANCELLED' && mine[0].clientPhone === client.phoneNumber);

    check('missing refund reference is refused (400)',
      (await req('POST', `/admin/refunds/${ledger._id}/VAL-REFUND-1/complete`, admin, { refundReference: 'x' })).status === 400);
    check('malformed ledger id is refused (400)',
      (await req('POST', '/admin/refunds/not-an-id/VAL-REFUND-1/complete', admin, { refundReference: 'SSLREF-001' })).status === 400);

    const done = await req('POST', `/admin/refunds/${ledger._id}/VAL-REFUND-1/complete`, admin, { refundReference: 'SSLREF-001', note: 'Refunded via merchant panel' });
    check('admin records the refund (200)', done.status === 200 && done.body?.data?.refundReference === 'SSLREF-001', JSON.stringify(done.body));
    const again = await req('POST', `/admin/refunds/${ledger._id}/VAL-REFUND-1/complete`, admin, { refundReference: 'SSLREF-002' });
    check('second completion of the same payment is a 409', again.status === 409, String(again.status));

    const stored = await EscrowLedger.findById(ledger._id).lean();
    const p1 = stored.orphanPayments.find((p) => p.valId === 'VAL-REFUND-1');
    check('refund trail stored (reference, admin, time); untouched sibling stays pending',
      p1.refundReference === 'SSLREF-001' && String(p1.refundedBy) === String(admin._id) && p1.refundedAt
      && !stored.orphanPayments.find((p) => p.valId === 'VAL-REFUND-2').refundedAt);
    check('one ORPHAN_PAYMENT_REFUNDED audit entry',
      (await AuditLog.countDocuments({ entityId: ledger._id, action: 'ORPHAN_PAYMENT_REFUNDED' })) === 1);

    const pending = await req('GET', '/admin/refunds?status=pending', admin);
    const refunded = await req('GET', '/admin/refunds?status=refunded', admin);
    const pendingMine = pending.body.data.refunds.filter((r) => String(r.ledgerId) === String(ledger._id));
    const refundedMine = refunded.body.data.refunds.filter((r) => String(r.ledgerId) === String(ledger._id));
    check('filters split pending vs refunded', pendingMine.length === 1 && refundedMine.length === 1 && refundedMine[0].refundReference === 'SSLREF-001');
  } finally {
    await EscrowLedger.deleteOne({ _id: ledger._id });
    await Project.deleteOne({ _id: project._id });
    await AuditLog.deleteMany({ entityId: ledger._id }).catch(() => {});
    await User.deleteMany({ phoneNumber: { $regex: new RegExp(`^${PHONE_PREFIX}`) } });
  }

  console.log(failed ? `--- Results: ${failed} failed ---` : '--- Results: all passed ---');
  return failed ? 1 : 0;
}

main()
  .then(async (code) => { await mongoose.connection.close().catch(() => {}); appServer.close(); process.exit(code); })
  .catch(async (err) => { console.error('💥 admin refunds e2e crashed:', err); await mongoose.connection.close().catch(() => {}); process.exit(1); });
