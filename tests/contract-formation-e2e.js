// tests/contract-formation-e2e.js
// POST /api/contracts/create-from-bid/:bidId (routes/contract.js), which had
// no coverage at all:
//   - forming a contract creates one PENDING_FUNDING ledger; a retry returns it
//   - after the first contract is cancelled as abandoned and the project is
//     re-awarded, the new bid gets a NEW ledger for the NEW contractor (it used
//     to get "success" with the cancelled ledger of the previous contractor)
//   - a live ledger for a different contractor is a 409, never a "success"
//   - the retry body is a summary, not the raw ledger document
'use strict';

const dotenv = require('dotenv');
dotenv.config();
process.env.PORT = '0';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

const User = require('../models/User');
const Project = require('../models/Project');
const Bid = require('../models/Bid');
const EscrowLedger = require('../models/EscrowLedger');

const PHONE_PREFIX = '0199119';
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
  console.log('🧪 contract formation');

  const client = await User.create({ role: 'CLIENT', phoneNumber: phone(), status: 'ACTIVE' });
  const [a, b, c] = await Promise.all([0, 1, 2].map(() => User.create({ role: 'CONTRACTOR', phoneNumber: phone(), status: 'ACTIVE' })));
  const clientTok = jwt.sign({ userId: client._id, role: 'CLIENT' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  let key = 0;
  const form = async (bidId) => {
    const r = await fetch(`${base}/contracts/create-from-bid/${bidId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientTok}`, 'x-idempotency-key': `contract-e2e-${Date.now()}-${key++}` }
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const project = await Project.create({
    title: 'Contract formation project', category: 'Residential', description: 'Re-award after abandonment.',
    location: 'Dhaka', budget: 300000, clientId: client._id, status: 'OPEN'
  });
  const bid = (contractor, status) => Bid.create({
    projectId: project._id, contractorId: contractor._id, bidAmount: 300000, estimatedDays: 30,
    proposalText: 'Contract formation test bid.', bidFingerprint: `fp-${contractor._id}`, status
  });

  try {
    const bidA = await bid(a, 'ACCEPTED');
    const first = await form(bidA._id);
    check('forming a contract creates a ledger (201)', first.status === 201 && first.body?.data?.ledgerId, JSON.stringify(first.body));
    const retry = await form(bidA._id);
    check('retry returns the same ledger (200)',
      retry.status === 200 && String(retry.body?.data?.ledgerId) === String(first.body?.data?.ledgerId));
    check('retry body is a summary, not the raw ledger', retry.body && retry.body.escrowLedger === undefined);

    // The abandonment sweeper cancels A's contract and re-opens the project;
    // the client then accepts B.
    await EscrowLedger.updateOne({ _id: first.body.data.ledgerId }, { $set: { ledgerStatus: 'CANCELLED' } });
    await Bid.updateOne({ _id: bidA._id }, { $set: { status: 'WITHDRAWN' } });
    const bidB = await bid(b, 'ACCEPTED');
    const second = await form(bidB._id);
    check('re-awarded bid gets a NEW ledger (201), not the cancelled one',
      second.status === 201 && String(second.body?.data?.ledgerId) !== String(first.body.data.ledgerId), JSON.stringify(second.body));
    check('the new ledger is for the new contractor', String(second.body?.data?.contractorId) === String(b._id));

    // A different contractor's bid while B's contract is live → conflict.
    const bidC = await bid(c, 'ACCEPTED');
    const third = await form(bidC._id);
    check('live contract for another contractor → 409, never "success"', third.status === 409, `${third.status} ${JSON.stringify(third.body)}`);
    const live = await EscrowLedger.countDocuments({ projectId: project._id, ledgerStatus: { $ne: 'CANCELLED' } });
    check('exactly one live ledger on the project', live === 1, String(live));
  } finally {
    await EscrowLedger.deleteMany({ projectId: project._id });
    await Bid.deleteMany({ projectId: project._id });
    await Project.deleteOne({ _id: project._id });
    await User.deleteMany({ phoneNumber: { $regex: new RegExp(`^${PHONE_PREFIX}`) } });
  }

  console.log(failed ? `--- Results: ${failed} failed ---` : '--- Results: all passed ---');
  return failed ? 1 : 0;
}

main()
  .then(async (code) => { await mongoose.connection.close().catch(() => {}); appServer.close(); process.exit(code); })
  .catch(async (err) => { console.error('💥 contract formation e2e crashed:', err); await mongoose.connection.close().catch(() => {}); process.exit(1); });
