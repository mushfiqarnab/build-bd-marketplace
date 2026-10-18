// tests/transaction-retry-e2e.js
// Fault-injection proof test for PR #30:
// Proves that transactions converted to session.withTransaction / runTransaction
// survive a transient WriteConflict error, automatically retry, and apply money
// and state changes EXACTLY ONCE.
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
const DisputeTicket = require('../models/DisputeTicket');
const WithdrawalLedger = require('../models/WithdrawalLedger');
const AuditLog = require('../models/AuditLog');
const bankPayoutClient = require('../services/bankPayoutClient');

const PHONE_PREFIX = '0199120';
const TREASURY_PHONE = process.env.TREASURY_PHONE || '01700000000';

let seq = 0;
let keySeq = 0;
const phone = () => `${PHONE_PREFIX}${String(seq++).padStart(4, '0')}`;
const token = (user) => jwt.sign({ userId: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function assertLocalDatabase(uri) {
  const local = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(String(uri || ''));
  if (!local) {
    console.error('🛑 Refusing to test against a non-local database. Run it via `MONGODB_URI= node scripts/run-tests.js --only transaction-retry`.');
    process.exit(1);
  }
}

function failOnceInTx(obj, method) {
  const original = obj[method];
  const state = { fired: 0 };
  obj[method] = function (...args) {
    const opts = args.find((a) => a && typeof a === 'object' && a.session) || {};
    if (!state.fired && opts.session && opts.session.inTransaction()) {
      state.fired = 1;
      throw new mongoose.mongo.MongoServerError({
        message: 'injected WriteConflict',
        code: 112,
        codeName: 'WriteConflict',
        errorLabels: ['TransientTransactionError']
      });
    }
    return original.apply(this, args);
  };
  return { state, restore: () => { obj[method] = original; } };
}

let baseUrl = null;

async function call(method, path, tok, body) {
  const headers = {
    'Content-Type': 'application/json',
    'x-idempotency-key': `tx-proof-${Date.now()}-${keySeq++}`
  };
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON */ }
  return { status: res.status, body: json };
}

async function main() {
  assertLocalDatabase(process.env.MONGODB_URI);
  if (!appServer.listening) await new Promise((r) => appServer.once('listening', r));
  baseUrl = `http://127.0.0.1:${appServer.address().port}/api`;
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

  console.log('🧪 transaction retry fault-injection proof');

  await User.deleteMany({ phoneNumber: { $regex: new RegExp(`^${PHONE_PREFIX}`) } });
  const treasury = await User.findOneAndUpdate(
    { phoneNumber: TREASURY_PHONE },
    { $setOnInsert: { role: 'ADMIN', phoneNumber: TREASURY_PHONE, status: 'ACTIVE' } },
    { upsert: true, returnDocument: 'after' }
  );
  const treasuryStart = treasury.wallet?.pendingClearance || 0;

  const admin = await User.create({ role: 'ADMIN', phoneNumber: phone(), status: 'ACTIVE' });
  const adminTok = token(admin);

  const createdLedgerIds = [];
  const createdProjectIds = [];
  const createdBidIds = [];

  let case2Ledger = null;
  let case1Ledger = null;
  let client1Tok = null;

  try {
    // ── CASE 1: Governance approve milestone with injected WriteConflict on AuditLog.create ──
    {
      const client = await User.create({ role: 'CLIENT', phoneNumber: phone(), status: 'ACTIVE' });
      const contractor = await User.create({ role: 'CONTRACTOR', phoneNumber: phone(), status: 'ACTIVE' });
      client1Tok = token(client);

      const project = await Project.create({
        title: 'Tx Proof Project 1', category: 'Residential', description: 'Approve retry test.',
        location: 'Dhaka', budget: 200000, clientId: client._id, awardedContractorId: contractor._id, status: 'ASSIGNED'
      });
      createdProjectIds.push(project._id);

      const ledger = await EscrowLedger.create({
        projectId: project._id, clientId: client._id, contractorId: contractor._id,
        totalContractValue: 200000, ledgerStatus: 'FUNDED', paidAt: new Date(), paidByValId: 'VAL-TX-1',
        milestones: [
          { title: 'Milestone 1', amount: 100000, releasePercentage: 50, status: 'PROOF_SUBMITTED', proofSubmittedAt: new Date() },
          { title: 'Milestone 2', amount: 100000, releasePercentage: 50, status: 'PENDING' }
        ]
      });
      createdLedgerIds.push(ledger._id);
      case1Ledger = ledger;

      const inj = failOnceInTx(AuditLog, 'create');
      let res;
      try {
        res = await call('POST', `/governance/approve/${ledger._id}/milestone/0`, token(client));
      } finally {
        inj.restore();
      }

      const [updatedContractor, updatedTreasury, updatedLedger, auditLogs] = await Promise.all([
        User.findById(contractor._id).lean(),
        User.findOne({ phoneNumber: TREASURY_PHONE }).lean(),
        EscrowLedger.findById(ledger._id).lean(),
        AuditLog.find({ entityId: ledger._id, action: 'MILESTONE_APPROVED' }).lean()
      ]);

      check('Case 1: approve succeeds (HTTP 200)', res.status === 200, JSON.stringify(res.body));
      check('Case 1: contractor pendingClearance credited ONCE (95,000 BDT)',
        updatedContractor.wallet?.pendingClearance === 95000,
        `got ${updatedContractor.wallet?.pendingClearance}`);
      check('Case 1: treasury pendingClearance grew by exactly 5,000 BDT',
        (updatedTreasury.wallet?.pendingClearance || 0) - treasuryStart === 5000,
        `diff ${(updatedTreasury.wallet?.pendingClearance || 0) - treasuryStart}`);
      check('Case 1: milestone 0 COMPLETED', updatedLedger.milestones[0].status === 'COMPLETED');
      check('Case 1: milestone 1 IN_PROGRESS', updatedLedger.milestones[1].status === 'IN_PROGRESS');
      check('Case 1: exactly 1 AuditLog MILESTONE_APPROVED emitted', auditLogs.length === 1, `count ${auditLogs.length}`);
      check('Case 1: WriteConflict injected exactly once', inj.state.fired === 1, `fired ${inj.state.fired}`);
    }

    // ── CASE 2: Governance dispute milestone with injected WriteConflict on AuditLog.create ──
    {
      const client = await User.create({ role: 'CLIENT', phoneNumber: phone(), status: 'ACTIVE' });
      const contractor = await User.create({ role: 'CONTRACTOR', phoneNumber: phone(), status: 'ACTIVE' });

      const project = await Project.create({
        title: 'Tx Proof Project 2', category: 'Residential', description: 'Dispute retry test.',
        location: 'Dhaka', budget: 200000, clientId: client._id, awardedContractorId: contractor._id, status: 'ASSIGNED'
      });
      createdProjectIds.push(project._id);

      const ledger = await EscrowLedger.create({
        projectId: project._id, clientId: client._id, contractorId: contractor._id,
        totalContractValue: 200000, ledgerStatus: 'FUNDED', paidAt: new Date(), paidByValId: 'VAL-TX-2',
        milestones: [
          { title: 'Milestone 1', amount: 100000, releasePercentage: 50, status: 'PROOF_SUBMITTED', proofSubmittedAt: new Date() },
          { title: 'Milestone 2', amount: 100000, releasePercentage: 50, status: 'PENDING' }
        ]
      });
      createdLedgerIds.push(ledger._id);
      case2Ledger = ledger;

      const inj = failOnceInTx(AuditLog, 'create');
      let res;
      try {
        res = await call('POST', `/governance/dispute/${ledger._id}/milestone/0`, token(client), {
          reason: 'Structural column alignment does not meet engineering requirements.'
        });
      } finally {
        inj.restore();
      }

      const [updatedLedger, tickets, auditLogs] = await Promise.all([
        EscrowLedger.findById(ledger._id).lean(),
        DisputeTicket.find({ ledgerId: ledger._id, milestoneIndex: 0 }).lean(),
        AuditLog.find({ entityId: ledger._id, action: 'MILESTONE_DISPUTED' }).lean()
      ]);

      check('Case 2: dispute succeeds (HTTP 200)', res.status === 200, JSON.stringify(res.body));
      check('Case 2: ledger status is IN_ARBITRATION', updatedLedger.ledgerStatus === 'IN_ARBITRATION');
      check('Case 2: milestone 0 status is DISPUTED', updatedLedger.milestones[0].status === 'DISPUTED');
      check('Case 2: exactly 1 DisputeTicket created', tickets.length === 1, `count ${tickets.length}`);
      check('Case 2: exactly 1 AuditLog MILESTONE_DISPUTED emitted', auditLogs.length === 1, `count ${auditLogs.length}`);
      check('Case 2: WriteConflict injected exactly once', inj.state.fired === 1, `fired ${inj.state.fired}`);
    }

    // ── CASE 3: Admin arbitrate on the disputed ledger from Case 2 with injected WriteConflict ──
    {
      const clientBefore = await User.findById(case2Ledger.clientId).lean();
      const clientAvailBefore = clientBefore.wallet?.availableToWithdraw || 0;

      const inj = failOnceInTx(AuditLog, 'create');
      let res;
      try {
        res = await call('POST', `/governance/arbitrate/${case2Ledger._id}/milestone/0`, adminTok, {
          decision: 'FAVOR_CLIENT',
          arbitrationNotes: 'Independent site engineering audit confirmed defect. Full refund to client.'
        });
      } finally {
        inj.restore();
      }

      const [clientAfter, updatedLedger, ticket] = await Promise.all([
        User.findById(case2Ledger.clientId).lean(),
        EscrowLedger.findById(case2Ledger._id).lean(),
        DisputeTicket.findOne({ ledgerId: case2Ledger._id, milestoneIndex: 0 }).lean()
      ]);

      check('Case 3: arbitrate succeeds (HTTP 200)', res.status === 200, JSON.stringify(res.body));
      check('Case 3: client availableToWithdraw increased by exactly 100,000 BDT (once)',
        (clientAfter.wallet?.availableToWithdraw || 0) - clientAvailBefore === 100000,
        `diff ${(clientAfter.wallet?.availableToWithdraw || 0) - clientAvailBefore}`);
      check('Case 3: milestone 0 status is REFUNDED', updatedLedger.milestones[0].status === 'REFUNDED');
      check('Case 3: ticket status is RESOLVED_CANCELLED', ticket?.status === 'RESOLVED_CANCELLED');
      check('Case 3: WriteConflict injected exactly once', inj.state.fired === 1, `fired ${inj.state.fired}`);
    }

    // ── CASE 4: Moderation dispute resolve with injected WriteConflict on AuditLog.create ──
    {
      const client = await User.create({ role: 'CLIENT', phoneNumber: phone(), status: 'ACTIVE' });
      const contractor = await User.create({ role: 'CONTRACTOR', phoneNumber: phone(), status: 'ACTIVE' });

      const project = await Project.create({
        title: 'Tx Proof Project 4', category: 'Residential', description: 'Moderator resolve retry test.',
        location: 'Dhaka', budget: 200000, clientId: client._id, awardedContractorId: contractor._id, status: 'ASSIGNED'
      });
      createdProjectIds.push(project._id);

      const ledger = await EscrowLedger.create({
        projectId: project._id, clientId: client._id, contractorId: contractor._id,
        totalContractValue: 200000, ledgerStatus: 'FUNDED', paidAt: new Date(), paidByValId: 'VAL-TX-4',
        milestones: [
          { title: 'Milestone 1', amount: 100000, releasePercentage: 50, status: 'PROOF_SUBMITTED', proofSubmittedAt: new Date() },
          { title: 'Milestone 2', amount: 100000, releasePercentage: 50, status: 'PENDING' }
        ]
      });
      createdLedgerIds.push(ledger._id);

      // Dispute it first via normal dispute route without injection
      const dispRes = await call('POST', `/governance/dispute/${ledger._id}/milestone/0`, token(client), {
        reason: 'Client disputed initial concrete testing results.'
      });
      if (dispRes.status !== 200) throw new Error(`Setup failed: dispute returned ${dispRes.status}`);

      const ticket = await DisputeTicket.findOne({ ledgerId: ledger._id, milestoneIndex: 0 }).lean();
      if (!ticket) throw new Error('Setup failed: DisputeTicket not found');

      const inj = failOnceInTx(AuditLog, 'create');
      let res;
      try {
        res = await call('POST', `/moderation/dispute/${ticket._id}/resolve`, adminTok, {
          verdict: 'FORCE_APPROVE',
          justification: 'Concrete cylinder laboratory compression tests verified standard compliance.'
        });
      } finally {
        inj.restore();
      }

      const [updatedContractor, updatedLedger, updatedTicket] = await Promise.all([
        User.findById(contractor._id).lean(),
        EscrowLedger.findById(ledger._id).lean(),
        DisputeTicket.findById(ticket._id).lean()
      ]);

      check('Case 4: moderation resolve succeeds (HTTP 200)', res.status === 200, JSON.stringify(res.body));
      check('Case 4: contractor pendingClearance credited ONCE (95% = 95,000 BDT)',
        updatedContractor.wallet?.pendingClearance === 95000,
        `got ${updatedContractor.wallet?.pendingClearance}`);
      check('Case 4: milestone 0 COMPLETED', updatedLedger.milestones[0].status === 'COMPLETED');
      check('Case 4: ticket status is RESOLVED_FORCE_APPROVED', updatedTicket.status === 'RESOLVED_FORCE_APPROVED');
      check('Case 4: WriteConflict injected exactly once', inj.state.fired === 1, `fired ${inj.state.fired}`);
    }

    // ── CASE 5: Finance withdraw with injected WriteConflict on WithdrawalLedger.create ──
    {
      const contractor = await User.create({
        role: 'CONTRACTOR',
        phoneNumber: phone(),
        status: 'ACTIVE',
        wallet: { availableToWithdraw: 5000, pendingClearance: 0, lockedInEscrow: 0 }
      });

      const bankDetails = {
        accountName: 'Tx Test Contractor',
        accountNumber: '1234567890123',
        routingNumber: '020261234',
        bankName: 'BRAC Bank'
      };

      bankPayoutClient.setTestOverrides({
        initiatePayout: async () => ({ bankTransactionId: 'BANK-TX-5-OK' })
      });

      const inj = failOnceInTx(WithdrawalLedger, 'create');
      let res;
      try {
        res = await call('POST', '/finance/withdraw', token(contractor), { amount: 1000, bankDetails });
      } finally {
        inj.restore();
        bankPayoutClient.clearTestOverrides();
      }

      const [updatedContractor, withdrawals] = await Promise.all([
        User.findById(contractor._id).lean(),
        WithdrawalLedger.find({ userId: contractor._id }).lean()
      ]);

      check('Case 5: withdraw succeeds (HTTP 200)', res.status === 200, JSON.stringify(res.body));
      check('Case 5: wallet availableToWithdraw debited ONCE (5000 - 1000 = 4000 BDT)',
        updatedContractor.wallet?.availableToWithdraw === 4000,
        `got ${updatedContractor.wallet?.availableToWithdraw}`);
      check('Case 5: exactly 1 WithdrawalLedger created', withdrawals.length === 1, `count ${withdrawals.length}`);
      check('Case 5: WriteConflict injected exactly once', inj.state.fired === 1, `fired ${inj.state.fired}`);
    }

    // ── CASE 6: Contract create-from-bid with injected WriteConflict on AuditLog.create ──
    {
      const client = await User.create({ role: 'CLIENT', phoneNumber: phone(), status: 'ACTIVE' });
      const contractor = await User.create({ role: 'CONTRACTOR', phoneNumber: phone(), status: 'ACTIVE' });

      const project = await Project.create({
        title: 'Tx Proof Project 6', category: 'Residential', description: 'Contract formation retry test.',
        location: 'Dhaka', budget: 300000, clientId: client._id, status: 'OPEN'
      });
      createdProjectIds.push(project._id);

      const bid = await Bid.create({
        projectId: project._id, contractorId: contractor._id, bidAmount: 300000, estimatedDays: 30,
        proposalText: 'Full construction contract formation proposal with complete technical scope.',
        bidFingerprint: `fp-${contractor._id}`, status: 'ACCEPTED'
      });
      createdBidIds.push(bid._id);

      const inj = failOnceInTx(AuditLog, 'create');
      let res;
      try {
        res = await call('POST', `/contracts/create-from-bid/${bid._id}`, token(client));
      } finally {
        inj.restore();
      }

      const [ledgers, auditLogs] = await Promise.all([
        EscrowLedger.find({ projectId: project._id, ledgerStatus: { $ne: 'CANCELLED' } }).lean(),
        AuditLog.find({ action: 'FUNDS_LOCKED' }).lean()
      ]);
      const createdLedger = ledgers[0];
      if (createdLedger) createdLedgerIds.push(createdLedger._id);

      const ledgerAudit = auditLogs.filter((l) => createdLedger && String(l.entityId) === String(createdLedger._id));

      check('Case 6: create-from-bid succeeds (HTTP 201)', res.status === 201, JSON.stringify(res.body));
      check('Case 6: exactly 1 non-CANCELLED ledger for project', ledgers.length === 1, `count ${ledgers.length}`);
      check('Case 6: exactly 1 AuditLog FUNDS_LOCKED for ledger', ledgerAudit.length === 1, `count ${ledgerAudit.length}`);
      check('Case 6: WriteConflict injected exactly once', inj.state.fired === 1, `fired ${inj.state.fired}`);
    }

    // ── CASE 7: Sanity refusal on malformed milestone index (no injection) ──
    {
      const res = await call('POST', `/governance/approve/${case1Ledger._id}/milestone/abc`, client1Tok);
      check('Case 7: malformed index refuses with HTTP 400', res.status === 400, `status ${res.status}`);
    }

  } finally {
    bankPayoutClient.clearTestOverrides();
    await Promise.all([
      EscrowLedger.deleteMany({ _id: { $in: createdLedgerIds } }),
      Project.deleteMany({ _id: { $in: createdProjectIds } }),
      Bid.deleteMany({ _id: { $in: createdBidIds } }),
      DisputeTicket.deleteMany({ ledgerId: { $in: createdLedgerIds } }),
      WithdrawalLedger.deleteMany({ userId: { $in: (await User.find({ phoneNumber: { $regex: new RegExp(`^${PHONE_PREFIX}`) } }).select('_id')).map((u) => u._id) } }),
      User.deleteMany({ phoneNumber: { $regex: new RegExp(`^${PHONE_PREFIX}`) } }),
      User.updateOne({ phoneNumber: TREASURY_PHONE }, { $set: { 'wallet.pendingClearance': treasuryStart } })
    ]);
    await mongoose.disconnect();
  }

  if (failed === 0) {
    console.log('--- Results: all passed ---');
    process.exit(0);
  } else {
    console.log(`--- Results: ${failed} failed ---`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal crash in transaction-retry-e2e:', err);
  process.exit(1);
});
