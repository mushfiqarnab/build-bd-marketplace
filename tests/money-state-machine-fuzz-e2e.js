// tests/money-state-machine-fuzz-e2e.js
// Property-based fuzzing of the escrow money state machine over the REAL HTTP
// API (full server.js stack: auth, idempotency, transactions).
//
// For many randomly shaped online-funded ledgers it fires random, out-of-order,
// duplicated, concurrent and malformed money actions — approve, dispute,
// arbitrate, moderator resolve, offline settlement, wrong-actor calls, bad
// indexes — and after EVERY action asserts:
//   1. no response is a 5xx;
//   2. the ledger satisfies every rule in scripts/qa/ledger-invariants.js;
//   3. wallets match the ledger exactly: contractor pendingClearance = 95% of
//      released milestones, client refund = refunded milestones, treasury
//      pendingClearance grew by exactly the 5% platform fees (no double credit,
//      no lost fee).
//
// Proof submission is applied as a direct IN_PROGRESS → PROOF_SUBMITTED write
// (what the evidence routes do after the upload checks) so the fuzzer stays
// on the money transitions. Every run prints its seed; reproduce a failure with
//   MONGODB_URI= QA_FUZZ_SEED=<seed> node scripts/run-tests.js --only fuzz
// It refuses to run against any non-local database.
// Tunables: QA_FUZZ_SEED, QA_FUZZ_LEDGERS (default 12), QA_FUZZ_STEPS (default 40).
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
const DisputeTicket = require('../models/DisputeTicket');
const { splitMilestoneAmount } = require('../utils/money');
const { checkLedger } = require('../scripts/qa/ledger-invariants');

const SEED = Number(process.env.QA_FUZZ_SEED || (Date.now() % 2147483647));
const LEDGERS = Number(process.env.QA_FUZZ_LEDGERS || 12);
const STEPS = Number(process.env.QA_FUZZ_STEPS || 40);
const TREASURY_PHONE = process.env.TREASURY_PHONE || '01700000000';
const PHONE_PREFIX = '0199116';

// mulberry32 — small, fast, deterministic PRNG so a seed replays a run exactly.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

let baseUrl = null;
let phoneSeq = 0;
let keySeq = 0;
const phone = () => `${PHONE_PREFIX}${String(phoneSeq++).padStart(4, '0')}`;
const token = (user) => jwt.sign({ userId: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function call(path, tok, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tok}`,
      'x-idempotency-key': `fuzz-${SEED}-${keySeq++}`
    },
    body: JSON.stringify(body || {})
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON body */ }
  return { status: res.status, body: json };
}

const NOTES = 'Verdict based on site photos and the signed bill of quantities.';

// Each action returns one or more HTTP calls (concurrent when several).
const ACTIONS = {
  proof: async (ctx, idx) => {
    if (!Number.isInteger(idx)) return [];
    await EscrowLedger.updateOne(
      { _id: ctx.ledgerId, [`milestones.${idx}.status`]: 'IN_PROGRESS' },
      { $set: { [`milestones.${idx}.status`]: 'PROOF_SUBMITTED', [`milestones.${idx}.proofSubmittedAt`]: new Date() } }
    );
    return [];
  },
  approve: (ctx, idx) => [call(`/governance/approve/${ctx.ledgerId}/milestone/${idx}`, ctx.clientTok)],
  approveBurst: (ctx, idx) => [0, 1, 2].map(() => call(`/governance/approve/${ctx.ledgerId}/milestone/${idx}`, ctx.clientTok)),
  wrongActorApprove: (ctx, idx) => [call(`/governance/approve/${ctx.ledgerId}/milestone/${idx}`, ctx.contractorTok)],
  dispute: (ctx, idx) => [call(`/governance/dispute/${ctx.ledgerId}/milestone/${idx}`, ctx.clientTok,
    { reason: 'Work does not match the agreed drawings.' })],
  arbitrate: (ctx, idx) => [call(`/governance/arbitrate/${ctx.ledgerId}/milestone/${idx}`, ctx.adminTok,
    { decision: pick(['FAVOR_CLIENT', 'FAVOR_CONTRACTOR']), arbitrationNotes: rand() < 0.85 ? NOTES : 'too short' })],
  arbitrateBurst: (ctx, idx) => [0, 1].map(() => call(`/governance/arbitrate/${ctx.ledgerId}/milestone/${idx}`, ctx.adminTok,
    { decision: 'FAVOR_CONTRACTOR', arbitrationNotes: NOTES })),
  moderatorResolve: async (ctx, idx) => {
    if (!Number.isInteger(idx)) return [];
    const ticket = await DisputeTicket.findOne({ ledgerId: ctx.ledgerId, milestoneIndex: idx }).select('_id').lean();
    if (!ticket) return [];
    return [call(`/moderation/dispute/${ticket._id}/resolve`, ctx.adminTok,
      { verdict: pick(['FORCE_APPROVE', 'CANCEL_AND_RESTART']), justification: NOTES })];
  },
  settlementApprove: (ctx, idx) => [call(`/settlement/milestone/${ctx.milestoneId(idx)}/approve`, ctx.clientTok)],
  settlementReject: (ctx, idx) => [call(`/settlement/milestone/${ctx.milestoneId(idx)}/reject`, ctx.clientTok,
    { reason: 'Proof photos are from a different site.' })],
  confirmReceipt: (ctx, idx) => [call(`/settlement/milestone/${ctx.milestoneId(idx)}/confirm-receipt`, ctx.contractorTok)],
  submitPayment: (ctx, idx) => [call(`/settlement/milestone/${ctx.milestoneId(idx)}/submit-payment`, ctx.clientTok,
    { paymentMethod: 'BKASH', trxId: `TRX${SEED}${keySeq}`, amountBDT: 1000, s3ReceiptUrl: 'receipts/none.jpg' })]
};
// Weighted so the happy path actually progresses and disputes get resolved.
const WEIGHTED = [
  ...Array(6).fill('proof'), ...Array(5).fill('approve'), 'approveBurst', 'wrongActorApprove',
  ...Array(2).fill('dispute'), ...Array(2).fill('arbitrate'), 'arbitrateBurst', ...Array(2).fill('moderatorResolve'),
  'settlementApprove', 'settlementReject', 'confirmReceipt', 'submitPayment'
];

async function makeLedger(admin) {
  const client = await User.create({ role: 'CLIENT', phoneNumber: phone(), status: 'ACTIVE' });
  const contractor = await User.create({ role: 'CONTRACTOR', phoneNumber: phone(), status: 'ACTIVE' });
  const count = int(1, 5);
  const amounts = Array.from({ length: count }, () => int(1, 500000));
  const total = amounts.reduce((a, b) => a + b, 0);
  let pctLeft = 100;
  const milestones = amounts.map((amount, i) => {
    const releasePercentage = i === count - 1 ? Number(pctLeft.toFixed(4)) : Number(((amount / total) * 100).toFixed(4));
    pctLeft -= releasePercentage;
    return { title: `Stage ${i + 1}`, amount, releasePercentage, status: i === 0 ? 'IN_PROGRESS' : 'PENDING' };
  });
  const project = await Project.create({
    title: 'Fuzz project', category: 'Residential', description: 'State-machine fuzz target.',
    location: 'Dhaka', budget: total, clientId: client._id, awardedContractorId: contractor._id, status: 'ASSIGNED'
  });
  // Exactly the state the IPN leaves behind: FUNDED, milestone 0 open.
  const ledger = await EscrowLedger.create({
    projectId: project._id, clientId: client._id, contractorId: contractor._id,
    totalContractValue: total, ledgerStatus: 'FUNDED', paidAt: new Date(),
    paidByValId: `FUZZ-${SEED}-${phoneSeq}`, milestones
  });
  return {
    ledgerId: ledger._id.toString(),
    count,
    client, contractor,
    clientTok: token(client), contractorTok: token(contractor), adminTok: token(admin),
    milestoneIds: ledger.milestones.map((m) => m._id.toString()),
    milestoneId(idx) { return Number.isInteger(idx) && this.milestoneIds[idx] ? this.milestoneIds[idx] : new mongoose.Types.ObjectId().toString(); }
  };
}

/** Wallets must equal exactly what the ledger says was released / refunded. */
async function moneyViolations(ctx, ledger) {
  const out = [];
  let contractorDue = 0;
  let refundDue = 0;
  let feeDue = 0;
  for (const m of ledger.milestones) {
    if (m.status === 'COMPLETED') {
      const { contractor, platform } = splitMilestoneAmount(m.amount);
      contractorDue += contractor;
      feeDue += platform;
    }
    if (m.status === 'REFUNDED') refundDue += m.amount;
  }
  const [c, k] = await Promise.all([
    User.findById(ctx.client._id).select('wallet').lean(),
    User.findById(ctx.contractor._id).select('wallet').lean()
  ]);
  if ((k.wallet?.pendingClearance || 0) !== contractorDue) out.push(`contractor pendingClearance ${k.wallet?.pendingClearance} != ${contractorDue}`);
  if ((k.wallet?.availableToWithdraw || 0) !== 0) out.push(`contractor availableToWithdraw ${k.wallet?.availableToWithdraw} != 0 (no sweep ran)`);
  if ((c.wallet?.availableToWithdraw || 0) !== refundDue) out.push(`client refund ${c.wallet?.availableToWithdraw} != ${refundDue}`);
  return { out, feeDue };
}

// The fuzzer creates and deletes users and rewrites the treasury wallet, so it
// must never touch a real database. Only a local / in-memory MongoDB is allowed.
function assertLocalDatabase(uri) {
  const local = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(String(uri || ''));
  if (!local) {
    console.error('🛑 Refusing to fuzz a non-local database. Run it via `node scripts/run-tests.js --only fuzz` (in-memory replica set).');
    process.exit(1);
  }
}

async function main() {
  assertLocalDatabase(process.env.MONGODB_URI);
  if (!appServer.listening) await new Promise((r) => appServer.once('listening', r));
  baseUrl = `http://127.0.0.1:${appServer.address().port}/api`;
  console.log(`🎲 money state-machine fuzz — seed ${SEED}, ${LEDGERS} ledgers × ${STEPS} steps`);

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await User.deleteMany({ phoneNumber: { $regex: new RegExp(`^${PHONE_PREFIX}`) } });
  const treasury = await User.findOneAndUpdate(
    { phoneNumber: TREASURY_PHONE },
    { $setOnInsert: { role: 'ADMIN', phoneNumber: TREASURY_PHONE, status: 'ACTIVE' } },
    { upsert: true, returnDocument: 'after' }
  );
  const treasuryStart = treasury.wallet?.pendingClearance || 0;
  const admin = await User.create({ role: 'ADMIN', phoneNumber: phone(), status: 'ACTIVE' });

  const failures = [];
  const statusTally = {};
  let actionsRun = 0;
  let feesDue = 0;
  const ledgerIds = [];

  try {
    for (let l = 0; l < LEDGERS && failures.length === 0; l++) {
      const ctx = await makeLedger(admin);
      ledgerIds.push(ctx.ledgerId);
      const trail = [];
      let current = await EscrowLedger.findById(ctx.ledgerId).lean();
      for (let s = 0; s < STEPS; s++) {
        const name = pick(WEIGHTED);
        const r = rand();
        // Usually the open milestone (so ledgers progress deep into their
        // lifecycle), sometimes any milestone, sometimes garbage.
        const open = current.milestones.findIndex((m) => !['COMPLETED', 'PAID_OFFLINE', 'REFUNDED'].includes(m.status));
        const idx = r < 0.6 && open !== -1 ? open
          : r < 0.88 ? int(0, ctx.count - 1)
          : pick([-1, ctx.count, 'abc', '1e3', '0x1', ' 1']);
        const calls = await ACTIONS[name](ctx, idx);
        const results = await Promise.all(calls);
        actionsRun += 1;
        trail.push(`${name}(${idx}) → ${results.map((x) => x.status).join(',') || 'db'}`);
        for (const res of results) statusTally[res.status] = (statusTally[res.status] || 0) + 1;

        const fiveXX = results.find((x) => x.status >= 500);
        const ledger = await EscrowLedger.findById(ctx.ledgerId).lean();
        current = ledger;
        const broken = checkLedger(ledger).map((v) => `${v.rule} ${v.message}`);
        const money = await moneyViolations(ctx, ledger);
        broken.push(...money.out);
        if (fiveXX) broken.unshift(`HTTP ${fiveXX.status} on ${name}(${idx}): ${JSON.stringify(fiveXX.body)}`);
        if (broken.length) {
          failures.push({ ledger: ctx.ledgerId, step: s, broken, trail: trail.slice(-12),
            milestones: ledger.milestones.map((m) => m.status), ledgerStatus: ledger.ledgerStatus });
          break;
        }
        if (s === STEPS - 1) feesDue += money.feeDue;
      }
    }

    if (!failures.length) {
      const t = await User.findOne({ phoneNumber: TREASURY_PHONE }).select('wallet').lean();
      const grew = (t.wallet?.pendingClearance || 0) - treasuryStart;
      if (grew !== feesDue) failures.push({ broken: [`treasury pendingClearance grew by ${grew}, platform fees due ${feesDue}`] });
    }
  } finally {
    await EscrowLedger.deleteMany({ _id: { $in: ledgerIds } });
    await Project.deleteMany({ title: 'Fuzz project' });
    await DisputeTicket.deleteMany({ ledgerId: { $in: ledgerIds } });
    await User.deleteMany({ phoneNumber: { $regex: new RegExp(`^${PHONE_PREFIX}`) } });
    if (treasuryStart !== undefined) {
      await User.updateOne({ phoneNumber: TREASURY_PHONE }, { $set: { 'wallet.pendingClearance': treasuryStart } });
    }
  }

  console.log(`  actions run: ${actionsRun}; HTTP status mix: ${JSON.stringify(statusTally)}`);
  if (failures.length) {
    for (const f of failures) {
      console.log(`  ❌ invariant broken${f.ledger ? ` on ledger ${f.ledger} at step ${f.step}` : ''}:`);
      for (const b of f.broken) console.log(`       - ${b}`);
      if (f.trail) console.log(`       last actions: ${f.trail.join(' | ')}`);
      if (f.milestones) console.log(`       state: ${f.ledgerStatus} [${f.milestones.join(', ')}]`);
    }
    console.log(`  reproduce: MONGODB_URI= QA_FUZZ_SEED=${SEED} node scripts/run-tests.js --only fuzz`);
    console.log('--- Results: FAILED ---');
    return 1;
  }
  console.log(`  ✅ ${actionsRun} random money actions: no 5xx, every ledger invariant held, wallets matched to the taka`);
  console.log('--- Results: all passed ---');
  return 0;
}

main()
  .then(async (code) => {
    await mongoose.connection.close().catch(() => {});
    appServer.close();
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('💥 fuzz harness crashed:', err);
    await mongoose.connection.close().catch(() => {});
    process.exit(1);
  });
