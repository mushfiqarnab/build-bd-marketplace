// tests/phase4-money-integrity-e2e.js
// Regression coverage for Phase-4 money integrity:
//   - utils/money split is integer-BDT and conserves the total
//   - settlePendingTranches isolates ledgers (one bad ledger can't halt others)
//   - a missing treasury fails loudly instead of silently dropping the fee
//   - concurrent settlement sweeps credit each tranche exactly once
//   - FORCE_APPROVE on an online-funded ledger releases funds; on a non-
//     disputed milestone it is refused (no double credit)
//   - ensureIndexes rebuilds a dropped unique index and surfaces failures
//   - /submit-payment creates its receipt inside the transaction
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const dns = require('dns');
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (_) {}

const auth = require('../middleware/auth');
const User = require('../models/User');
const Project = require('../models/Project');
const EscrowLedger = require('../models/EscrowLedger');
const DisputeTicket = require('../models/DisputeTicket');
const PaymentReceipt = require('../models/PaymentReceipt');
const { splitMilestoneAmount, allMilestonesTerminal, unlockNextMilestone, settledLedgerStatus } = require('../utils/money');
const { settlePendingTranches } = require('../services/settlementService');
const { ensureIndexes } = require('../services/indexService');

const ROOT = path.resolve(__dirname, '..');
const TREASURY_PHONE = process.env.TREASURY_PHONE || '01700000000';
let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failed += 1; console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`); }
}

function post(port, pathName, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const r = http.request({
      hostname: '127.0.0.1', port, path: pathName, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data || '{}') }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

let phoneSeq = 0;
const phone = () => `0199114${String(phoneSeq++).padStart(4, '0')}`;

async function main() {
  console.log('🧪 phase-4 money integrity');
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', { serverSelectionTimeoutMS: 15000 });
  await User.deleteMany({ phoneNumber: { $regex: /^0199114/ } });

  const treasury = await User.findOneAndUpdate(
    { phoneNumber: TREASURY_PHONE },
    { $setOnInsert: { role: 'ADMIN', phoneNumber: TREASURY_PHONE, status: 'ACTIVE' } },
    { upsert: true, returnDocument: 'after' }
  );

  // ── 1. Pure money math ─────────────────────────────────────────────────────
  const s = splitMilestoneAmount(1001);
  check('split(1001) is integer and conserves the total', Number.isInteger(s.contractor) && Number.isInteger(s.platform) && s.contractor + s.platform === 1001, JSON.stringify(s));
  check('split(15000) = 14250 / 750', s && splitMilestoneAmount(15000).contractor === 14250 && splitMilestoneAmount(15000).platform === 750);
  let threw = false;
  try { splitMilestoneAmount(100.5); } catch (_) { threw = true; }
  check('split refuses fractional taka', threw);
  check('REFUNDED + COMPLETED + PAID_OFFLINE count as terminal',
    allMilestonesTerminal([{ status: 'COMPLETED' }, { status: 'REFUNDED' }, { status: 'PAID_OFFLINE' }])
    && !allMilestonesTerminal([{ status: 'COMPLETED' }, { status: 'DISPUTED' }]));

  // Sequential milestone gating: only the first non-terminal milestone may be active.
  const seq = [{ status: 'COMPLETED' }, { status: 'PENDING' }, { status: 'PENDING' }];
  check('unlock opens only the next milestone',
    unlockNextMilestone(seq) === 1 && seq[1].status === 'IN_PROGRESS' && seq[2].status === 'PENDING');
  check('unlock is a no-op while a milestone is still active',
    unlockNextMilestone(seq) === -1 && seq[2].status === 'PENDING');
  for (const blocking of ['PROOF_SUBMITTED', 'CLIENT_APPROVED', 'DISPUTED', 'LOCKED']) {
    const ms = [{ status: blocking }, { status: 'PENDING' }];
    check(`${blocking} blocks the next milestone`, unlockNextMilestone(ms) === -1 && ms[1].status === 'PENDING');
  }
  // scripts/qa/ledger-invariants.js must flag each class of money bug it guards.
  const { checkLedger } = require('../scripts/qa/ledger-invariants');
  const base = { ledgerStatus: 'FUNDED', totalContractValue: 300, paidByValId: 'VAL-1' };
  const ms = (...statuses) => statuses.map((status) => ({ status, amount: 100, releasePercentage: 100 / 3 }));
  const rulesOf = (l) => checkLedger(l).map((v) => v.rule);
  check('invariants: a healthy funded ledger has no violations',
    rulesOf({ ...base, milestones: ms('IN_PROGRESS', 'PENDING', 'PENDING') }).length === 0);
  check('invariants: two open milestones -> LI-05',
    rulesOf({ ...base, milestones: ms('IN_PROGRESS', 'IN_PROGRESS', 'PENDING') }).includes('LI-05'));
  check('invariants: offline state on online escrow -> LI-06',
    rulesOf({ ...base, ledgerStatus: 'PARTIALLY_DISBURSED', milestones: ms('PAID_OFFLINE', 'IN_PROGRESS', 'PENDING') }).includes('LI-06'));
  check('invariants: dispute without freeze -> LI-07',
    rulesOf({ ...base, milestones: ms('DISPUTED', 'PENDING', 'PENDING') }).includes('LI-07'));
  check('invariants: amounts not summing to the contract -> LI-01',
    rulesOf({ ...base, totalContractValue: 301, milestones: ms('IN_PROGRESS', 'PENDING', 'PENDING') }).includes('LI-01'));
  check('settledLedgerStatus keeps an open dispute frozen',
    settledLedgerStatus([{ status: 'COMPLETED' }, { status: 'DISPUTED' }]) === 'IN_ARBITRATION');
  check('settledLedgerStatus: all terminal -> FULLY_DISBURSED, else PARTIALLY_DISBURSED',
    settledLedgerStatus([{ status: 'COMPLETED' }, { status: 'REFUNDED' }]) === 'FULLY_DISBURSED'
    && settledLedgerStatus([{ status: 'COMPLETED' }, { status: 'IN_PROGRESS' }]) === 'PARTIALLY_DISBURSED');

  // ── 2. Settlement sweep isolation + exactly-once ──────────────────────────
  const client = await User.create({ role: 'CLIENT', phoneNumber: phone(), status: 'ACTIVE' });
  const contractor = await User.create({ role: 'CONTRACTOR', phoneNumber: phone(), status: 'ACTIVE',
    wallet: { lockedEscrow: 0, pendingClearance: 9500, availableToWithdraw: 0 } });
  const project = await Project.create({ clientId: client._id, title: 'P4', category: 'Residential', description: 'd', location: 'Dhaka', budget: 10000 });
  const past = new Date(Date.now() - 60 * 1000);

  const good = await EscrowLedger.create({
    projectId: project._id, clientId: client._id, contractorId: contractor._id, totalContractValue: 10000,
    ledgerStatus: 'FULLY_DISBURSED',
    milestones: [{ title: 'M', releasePercentage: 100, amount: 10000, status: 'COMPLETED', settlementStatus: 'PENDING_CLEARANCE', clearsAt: past }]
  });
  const orphan = await EscrowLedger.create({
    projectId: project._id, clientId: client._id, contractorId: new mongoose.Types.ObjectId(), totalContractValue: 5000,
    ledgerStatus: 'FULLY_DISBURSED',
    milestones: [{ title: 'M', releasePercentage: 100, amount: 5000, status: 'COMPLETED', settlementStatus: 'PENDING_CLEARANCE', clearsAt: past }]
  });
  await User.updateOne({ _id: treasury._id }, { $inc: { 'wallet.pendingClearance': 500 + 250 } });

  const [r1, r2] = await Promise.all([settlePendingTranches(), settlePendingTranches()]);
  const contractorAfter = await User.findById(contractor._id);
  const goodAfter = await EscrowLedger.findById(good._id);
  const orphanAfter = await EscrowLedger.findById(orphan._id);
  check('good ledger settled despite a broken sibling ledger', goodAfter.milestones[0].settlementStatus === 'SETTLED');
  check('broken ledger reported in failures, left PENDING_CLEARANCE',
    orphanAfter.milestones[0].settlementStatus === 'PENDING_CLEARANCE'
    && [...r1.failures, ...r2.failures].some((f) => f.ledgerId === String(orphan._id)));
  check('two concurrent sweeps credited the tranche exactly once (9500)',
    contractorAfter.wallet.availableToWithdraw === 9500 && contractorAfter.wallet.pendingClearance === 0,
    JSON.stringify(contractorAfter.wallet));
  check('settled tranche count across both sweeps is 1', r1.settledTranches + r2.settledTranches === 1, `${r1.settledTranches}+${r2.settledTranches}`);
  await EscrowLedger.deleteOne({ _id: orphan._id });

  // Missing treasury must fail loudly, not drop the 5% fee.
  const contractor2 = await User.create({ role: 'CONTRACTOR', phoneNumber: phone(), status: 'ACTIVE',
    wallet: { lockedEscrow: 0, pendingClearance: 950, availableToWithdraw: 0 } });
  const l2 = await EscrowLedger.create({
    projectId: project._id, clientId: client._id, contractorId: contractor2._id, totalContractValue: 1000,
    ledgerStatus: 'FULLY_DISBURSED',
    milestones: [{ title: 'M', releasePercentage: 100, amount: 1000, status: 'COMPLETED', settlementStatus: 'PENDING_CLEARANCE', clearsAt: past }]
  });
  const realPhone = process.env.TREASURY_PHONE;
  process.env.TREASURY_PHONE = '01999999998';
  const r3 = await settlePendingTranches();
  if (realPhone === undefined) delete process.env.TREASURY_PHONE; else process.env.TREASURY_PHONE = realPhone;
  const c2After = await User.findById(contractor2._id);
  check('missing treasury aborts the ledger (contractor not credited, failure reported)',
    c2After.wallet.availableToWithdraw === 0 && r3.failures.some((f) => /treasury/i.test(f.reason)),
    JSON.stringify(r3));
  await EscrowLedger.deleteOne({ _id: l2._id });

  // ── 3. FORCE_APPROVE on online-funded ledger releases funds ───────────────
  const moderator = await User.create({ role: 'MODERATOR', phoneNumber: phone(), status: 'ACTIVE' });
  const contractor3 = await User.create({ role: 'CONTRACTOR', phoneNumber: phone(), status: 'ACTIVE' });
  const online = await EscrowLedger.create({
    projectId: project._id, clientId: client._id, contractorId: contractor3._id, totalContractValue: 20000,
    ledgerStatus: 'IN_ARBITRATION', paidByValId: `VAL-P4-${Date.now()}`, paidAt: new Date(),
    milestones: [
      { title: 'A', releasePercentage: 50, amount: 10000, status: 'DISPUTED' },
      { title: 'B', releasePercentage: 50, amount: 10000, status: 'COMPLETED' }
    ]
  });
  const ticketBase = {
    projectId: project._id, ledgerId: online._id, clientId: client._id, contractorId: contractor3._id,
    clientRejectionReason: 'Phase-4 regression: disputed workmanship on milestone A.',
    contractorEvidenceSnapshot: { s3Url: 'k', imageHash: 'h'.repeat(64), gpsData: { lat: 23.8, lng: 90.4, accuracy: 10 }, submittedAt: new Date() },
    status: 'OPEN_FOR_REVIEW'
  };
  const ticketA = await DisputeTicket.create({ ...ticketBase, milestoneIndex: 0 });
  const ticketB = await DisputeTicket.create({ ...ticketBase, milestoneIndex: 1 });

  auth.verifyToken = (req, _res, next) => { req.user = { userId: req.headers['x-user-id'], role: req.headers['x-role'] }; next(); };
  auth.requireRole = (roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : res.status(403).json({ message: 'Forbidden' }));
  delete require.cache[require.resolve('../routes/arbitration')];
  const app = express();
  app.use(express.json());
  app.use('/api/moderation', require('../routes/arbitration'));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ message: err.message }));
  const server = app.listen(0);
  const port = server.address().port;
  const headers = (k) => ({ 'x-role': 'MODERATOR', 'x-user-id': moderator._id.toString(), 'x-idempotency-key': `${k}-${Date.now()}` });
  const justification = 'GPS-locked photographic evidence confirms the work matches the contract specification.';

  const resA = await post(port, `/api/moderation/dispute/${ticketA._id}/resolve`, { verdict: 'FORCE_APPROVE', justification }, headers('fa'));
  const onlineAfter = await EscrowLedger.findById(online._id);
  const c3After = await User.findById(contractor3._id);
  check('FORCE_APPROVE (online-funded) → milestone COMPLETED + PENDING_CLEARANCE',
    resA.status === 200 && onlineAfter.milestones[0].status === 'COMPLETED' && onlineAfter.milestones[0].settlementStatus === 'PENDING_CLEARANCE',
    `${resA.status} ${JSON.stringify(resA.body)}`);
  check('FORCE_APPROVE credits contractor pendingClearance (9500)', c3After.wallet.pendingClearance === 9500, JSON.stringify(c3After.wallet));
  check('ledger with all terminal milestones becomes FULLY_DISBURSED', onlineAfter.ledgerStatus === 'FULLY_DISBURSED', onlineAfter.ledgerStatus);

  const resB = await post(port, `/api/moderation/dispute/${ticketB._id}/resolve`, { verdict: 'FORCE_APPROVE', justification }, headers('fb'));
  const c3After2 = await User.findById(contractor3._id);
  check('verdict on a non-disputed (COMPLETED) milestone is refused with 409', resB.status === 409, `${resB.status} ${JSON.stringify(resB.body)}`);
  check('refused verdict did not double-credit the contractor', c3After2.wallet.pendingClearance === 9500);
  server.close();

  // ── 4. ensureIndexes rebuilds dropped indexes and surfaces failures ───────
  await PaymentReceipt.syncIndexes();
  const receiptIx = (await PaymentReceipt.collection.indexes()).find((i) => i.key.paymentMethod === 1 && i.key.trxId === 1);
  await PaymentReceipt.collection.dropIndex(receiptIx.name);
  const rebuilt = await ensureIndexes();
  const afterIx = (await PaymentReceipt.collection.indexes()).find((i) => i.key.paymentMethod === 1 && i.key.trxId === 1 && i.unique);
  check('ensureIndexes recreates the dropped double-spend unique index', !!afterIx && rebuilt.status === 'ok', JSON.stringify(rebuilt.failures));

  const userIx = (await User.collection.indexes()).find((i) => i.key.phoneNumber === 1);
  await User.collection.dropIndex(userIx.name);
  const dupPhone = phone();
  await User.collection.insertMany([
    { phoneNumber: dupPhone, role: 'CLIENT', status: 'ACTIVE' },
    { phoneNumber: dupPhone, role: 'CLIENT', status: 'ACTIVE' }
  ]);
  const blocked = await ensureIndexes();
  check('duplicate rows blocking a unique index are reported (status=failed, model=User)',
    blocked.status === 'failed' && blocked.failures.some((f) => f.model === 'User'), JSON.stringify(blocked));
  await User.collection.deleteMany({ phoneNumber: dupPhone });
  const healed = await ensureIndexes();
  check('after removing duplicates, ensureIndexes heals to ok', healed.status === 'ok', JSON.stringify(healed.failures));

  // ── 5. Source-level guarantees ─────────────────────────────────────────────
  const settlementSrc = fs.readFileSync(path.join(ROOT, 'routes', 'settlement.js'), 'utf8');
  check('/submit-payment creates the receipt inside the transaction session',
    /PaymentReceipt\.create\(\[\{[\s\S]*?\}\],\s*\{\s*session\s*\}\)/.test(settlementSrc));
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('server.js builds indexes at production boot and gates readiness on them',
    /ensureIndexes\(\)/.test(serverSrc) && /indexState\.status !== 'ok'/.test(serverSrc));

  await mongoose.disconnect();
  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('💥 phase4-money-integrity crashed:', err); process.exit(1); });
