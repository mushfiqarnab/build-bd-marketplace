// scripts/qa/query-plans.js — asks MongoDB HOW it would run every hot query
// and fails on a full collection scan (COLLSCAN) or an in-memory sort (SORT).
// Load tests on small seed data cannot see a missing index; query plans can.
// Uses a throwaway in-memory replica set with the real schemas + indexes.
'use strict';

const fs = require('fs');
const path = require('path');
const { createReport, runCli } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');

function stages(plan, out = []) {
  if (!plan || typeof plan !== 'object') return out;
  if (plan.stage) out.push(plan.stage);
  for (const k of ['inputStage', 'queryPlan']) if (plan[k]) stages(plan[k], out);
  for (const k of ['inputStages']) if (Array.isArray(plan[k])) plan[k].forEach((p) => stages(p, out));
  return out;
}

async function run() {
  const report = createReport('Query plans (index coverage of hot queries)');
  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  const mongoose = require('mongoose');
  const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  try {
    await mongoose.connect(rs.getUri('buildbd_plans'));
    for (const f of fs.readdirSync(path.join(ROOT, 'models')).filter((x) => x.endsWith('.js'))) require(path.join(ROOT, 'models', f));
    await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes()));
    const M = (n) => mongoose.model(n);
    const id = () => new mongoose.Types.ObjectId();
    const now = new Date();

    // Each hot query mirrors a real route/worker. `allowSortInMemory` only for
    // queries whose result set is bounded per user (documented inline).
    const QUERIES = [
      ['open feed (GET /api/projects/open)', () => M('Project').find({ status: 'OPEN' }).sort({ createdAt: -1 }).limit(20)],
      ['open feed by category', () => M('Project').find({ status: 'OPEN', category: 'Residential' }).sort({ createdAt: -1 }).limit(20)],
      ['open feed count', () => M('Project').find({ status: 'OPEN' }).countDocuments ? M('Project').find({ status: 'OPEN' }) : null],
      ['my projects (GET /api/projects/mine)', () => M('Project').find({ clientId: id() }).sort({ createdAt: -1 }).limit(20)],
      ['my bids (GET /api/bids/mine)', () => M('Bid').find({ contractorId: id() }).sort({ createdAt: -1 }).limit(20)],
      ['bids on a project', () => M('Bid').find({ projectId: id() })],
      ['one bid per contractor/project', () => M('Bid').findOne({ projectId: id(), contractorId: id() })],
      ['login by phone', () => M('User').findOne({ phoneNumber: '01700000000' })],
      ['treasury lookup', () => M('User').findOne({ role: 'ADMIN', phoneNumber: '01700000000' })],
      ['ledger by project', () => M('EscrowLedger').findOne({ projectId: id() })],
      ['IPN lookup by tran_id', () => M('EscrowLedger').findOne({ pendingTransactionId: 'BUILDBD-x' })],
      ['settlement sweep', () => M('EscrowLedger').find({ milestones: { $elemMatch: { settlementStatus: 'PENDING_CLEARANCE', clearsAt: { $lte: now } } } })],
      ['abandonment sweep', () => M('EscrowLedger').find({ ledgerStatus: 'PENDING_FUNDING', createdAt: { $lt: now }, $or: [{ paymentInitiatedAt: null }, { paymentInitiatedAt: { $lt: now } }] })],
      ['moderator dispute queue', () => M('DisputeTicket').find({ status: { $in: ['OPEN_FOR_REVIEW', 'MEDIATION_IN_PROGRESS'] } }).sort({ createdAt: 1 })],
      ['contractor verification queue', () => M('ContractorProfile').find({ 'verification.status': { $in: ['UNVERIFIED', 'PENDING'] } }).sort({ createdAt: 1 })],
      ['withdrawal history', () => M('WithdrawalLedger').find({ userId: id() }).sort({ createdAt: -1 })],
      ['admin refund queue', () => M('EscrowLedger').find({ 'orphanPayments.valId': { $exists: true } })],
      ['receipt double-spend check', () => M('PaymentReceipt').findOne({ paymentMethod: 'BKASH', trxId: { $eq: 'X', $type: 'string' } })],
      ['idempotency lookup', () => M('IdempotencyKey').findOne({ key: 'k', userId: id() })],
      ['withdrawal reconciliation sweep', () => M('WithdrawalLedger').find({ status: 'PROCESSING', updatedAt: { $lt: now }, reconciliationAttempts: { $lt: 5 } })],
      ['contractor reviews', () => M('Review').find({ contractorId: id() }).sort({ createdAt: -1 }).limit(20)],
      ['chat thread', () => M('Message').find({ bidId: id() }).sort({ createdAt: -1 }).limit(50)],
      ['dispute queue', () => M('DisputeTicket').find({ status: 'OPEN_FOR_REVIEW' }).sort({ createdAt: 1 }).limit(20)],
      ['passkey lookup', () => M('PasskeyCredential').findOne({ userId: id(), credentialID: 'c' })],
      ['contractor profile by user', () => M('ContractorProfile').findOne({ userId: id() })],
      ['evidence photo reuse check (cross-ledger imageHash)', () => M('EscrowLedger').findOne({ 'milestones.evidenceLog.imageHash': 'a'.repeat(64) })],
      ['admin counter: ledgers with a clearing tranche', () => M('EscrowLedger').find({ 'milestones.settlementStatus': 'PENDING_CLEARANCE' })],
      ['dispute rounds for one milestone', () => M('DisputeTicket').findOne({ ledgerId: id(), milestoneIndex: 0 }).sort({ round: -1 })],
      ['contractor directory (base)', () => M('ContractorProfile').find({ 'verification.status': 'VERIFIED' }).sort({ trustScore: -1, _id: -1 }).skip(20).limit(21)],
      ['contractor directory (genre)', () => M('ContractorProfile').find({ 'verification.status': 'VERIFIED', workGenres: 'BUILDING_CONSTRUCTION' }).sort({ trustScore: -1, _id: -1 }).limit(21)],
      ['contractor directory (district)', () => M('ContractorProfile').find({ 'verification.status': 'VERIFIED', 'serviceAreas.district': 'Dhaka' }).sort({ trustScore: -1, _id: -1 }).limit(21)],
      ['materials ledger by project', () => M('MaterialOrder').find({ projectId: id() }).sort({ milestoneIndex: 1, createdAt: -1 })]
    ];

    for (const [name, build] of QUERIES) {
      const q = build();
      if (!q) continue;
      let explain;
      try { explain = await q.explain('queryPlanner'); } catch (err) { report.fail(`plan:${name}`, `explain failed: ${err.message}`); continue; }
      const winning = (Array.isArray(explain) ? explain[0] : explain).queryPlanner.winningPlan;
      const s = stages(winning);
      const detail = s.join(' ← ');
      if (s.includes('COLLSCAN')) report.fail(`plan:${name}`, 'Full collection scan — needs an index', detail);
      else if (s.includes('SORT')) report.fail(`plan:${name}`, 'In-memory sort — index does not cover the sort', detail);
      else report.pass(`plan:${name}`, detail);
    }
    return report;
  } finally {
    await mongoose.disconnect().catch(() => {});
    await rs.stop().catch(() => {});
  }
}

module.exports = { run };
if (require.main === module) runCli(run);
