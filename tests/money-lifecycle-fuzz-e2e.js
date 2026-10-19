// tests/money-lifecycle-fuzz-e2e.js
// Property-based fuzzing of the money paths AROUND the milestone state
// machine (which tests/money-state-machine-fuzz-e2e.js covers): gateway
// funding and contractor payouts, over the real HTTP stack + background jobs.
//
// Phase A — funding. Random checkouts, VALID / FAILED / tampered / replayed
// IPNs and abandonment sweeps at random future times. After every step:
//   * no 5xx;
//   * every ledger invariant (scripts/qa/ledger-invariants.js);
//   * capture conservation: every taka the gateway captured either funded the
//     ledger (exactly once) or sits in orphanPayments as a refund owed —
//     nothing captured is ever silently dropped or double-counted;
//   * a funded ledger is never cancelled; a cancelled one is never funded.
//
// Phase B — payout (funded contracts). Milestones are approved, then random
// settlement sweeps, withdrawals (bursts, fractional and oversized amounts,
// bank outcomes PAID / REJECTED / TIMEOUT-then-paid / TIMEOUT-then-unpaid) and
// bank reconciliation cycles. After every step:
//   * contractor pendingClearance + availableToWithdraw + money reserved in
//     PROCESSING / COMPLETED / MANUAL_REVIEW withdrawals == everything earned;
//   * wallets stay whole non-negative taka;
//   * a withdrawal the bank actually paid is never FAILED-and-refunded
//     (double payout), and a COMPLETED one was really paid.
// At the end the treasury grew by exactly the 5% platform fees.
//
// Replay: MONGODB_URI= QA_FUZZ_SEED=<seed> node scripts/run-tests.js --only lifecycle
// Tunables: QA_FUZZ_SEED, QA_FUZZ_CONTRACTS (8), QA_FUZZ_FUND_STEPS (12), QA_FUZZ_PAY_STEPS (20).
// Refuses to run against a non-local database.
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
const WithdrawalLedger = require('../models/WithdrawalLedger');
const { splitMilestoneAmount } = require('../utils/money');
const { checkLedger } = require('../scripts/qa/ledger-invariants');
const { settlePendingTranches } = require('../services/settlementService');
const { runAbandonmentSweep } = require('../services/abandonmentService');
const { runReconciliationCycle } = require('../services/reconciliationService');
const bank = require('../services/bankPayoutClient');

const SEED = Number(process.env.QA_FUZZ_SEED || (Date.now() % 2147483647));
const CONTRACTS = Number(process.env.QA_FUZZ_CONTRACTS || 8);
const FUND_STEPS = Number(process.env.QA_FUZZ_FUND_STEPS || 12);
const PAY_STEPS = Number(process.env.QA_FUZZ_PAY_STEPS || 20);
const TREASURY_PHONE = process.env.TREASURY_PHONE || '01700000000';
const PHONE_PREFIX = '0199118';
const HOUR = 60 * 60 * 1000;

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
let seq = 0;
const phone = () => `${PHONE_PREFIX}${String(seq++).padStart(4, '0')}`;
const token = (u) => jwt.sign({ userId: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });

function assertLocalDatabase(uri) {
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(String(uri || ''))) {
    console.error('🛑 Refusing to fuzz a non-local database. Run it via `node scripts/run-tests.js --only lifecycle`.');
    process.exit(1);
  }
}

async function http(method, path, { tok, body, form, ip, key } = {}) {
  const headers = {};
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (ip) headers['X-Forwarded-For'] = ip; // each client is its own IP (per-IP financial limiter)
  if (key) headers['x-idempotency-key'] = key;
  let payload;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form); }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON */ }
  return { status: res.status, body: json };
}

// ── Bank simulator: every payout has a ground truth the oracle can check ────
const bankTruth = new Map(); // clientReference -> 'PAID' | 'UNPAID'
function installBank() {
  bank.setTestOverrides({
    initiatePayout: async ({ clientReference }) => {
      const outcome = pick(['PAID', 'PAID', 'PAID', 'REJECTED', 'TIMEOUT_PAID', 'TIMEOUT_UNPAID']);
      bankTruth.set(clientReference, outcome === 'PAID' || outcome === 'TIMEOUT_PAID' ? 'PAID' : 'UNPAID');
      if (outcome === 'PAID') return { bankTransactionId: `BANK-${clientReference}` };
      if (outcome === 'REJECTED') throw Object.assign(new Error('Account closed'), { isDefiniteFailure: true });
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    },
    queryPayoutStatus: async ({ clientReference }) => {
      const truth = bankTruth.get(clientReference);
      if (rand() < 0.25) return { status: pick(['PENDING', 'UNKNOWN']) };
      return truth === 'PAID'
        ? { status: 'SUCCESS', bankTransactionId: `BANK-${clientReference}` }
        : { status: 'FAILED' };
    }
  });
}

// ── Contract setup: exactly what bid accept leaves behind ───────────────────
async function makeContract(i) {
  const client = await User.create({ role: 'CLIENT', phoneNumber: phone(), status: 'ACTIVE' });
  const contractor = await User.create({ role: 'CONTRACTOR', phoneNumber: phone(), status: 'ACTIVE' });
  const count = int(1, 4);
  const amounts = Array.from({ length: count }, () => int(1000, 400000));
  const total = amounts.reduce((a, b) => a + b, 0);
  let pctLeft = 100;
  const milestones = amounts.map((amount, k) => {
    const releasePercentage = k === count - 1 ? Number(pctLeft.toFixed(4)) : Number(((amount / total) * 100).toFixed(4));
    pctLeft -= releasePercentage;
    return { title: `Stage ${k + 1}`, amount, releasePercentage };
  });
  const project = await Project.create({
    title: 'Lifecycle fuzz project', category: 'Residential', description: 'Lifecycle fuzz target.',
    location: 'Dhaka', budget: total, clientId: client._id, awardedContractorId: contractor._id, status: 'ASSIGNED'
  });
  const ledger = await EscrowLedger.create({
    projectId: project._id, clientId: client._id, contractorId: contractor._id,
    totalContractValue: total, ledgerStatus: 'PENDING_FUNDING', milestones
  });
  // Pretend the bid was accepted 2 h ago so the abandonment sweeper is live.
  await EscrowLedger.collection.updateOne({ _id: ledger._id }, { $set: { createdAt: new Date(Date.now() - 2 * HOUR) } });
  return {
    i, client, contractor, total, ledgerId: ledger._id.toString(), projectId: project._id,
    clientTok: token(client), contractorTok: token(contractor), ip: `10.77.${(i >> 8) & 255}.${i & 255}`,
    tranIds: [], captured: new Map(), // valId -> amount the gateway captured
    initiations: 0, valSeq: 0, earned: 0, fees: 0
  };
}

// ── Phase A: funding ─────────────────────────────────────────────────────────
const FUND_ACTIONS = {
  initiate: async (c) => {
    if (c.initiations >= 4) return []; // stay under the per-IP financial limiter (10 / 10 min)
    c.initiations += 1;
    const r = await http('POST', `/payment/initiate/${c.ledgerId}`, { tok: c.clientTok, ip: c.ip });
    if (r.status === 200 && r.body?.tranId) c.tranIds.push(r.body.tranId);
    return [r];
  },
  ipnValid: async (c) => {
    if (!c.tranIds.length) return [];
    const tranId = pick(c.tranIds);
    const valId = `VAL-${SEED}-${c.i}-${c.valSeq++}`;
    const r = await http('POST', '/payment/ipn', { form: { tran_id: tranId, val_id: valId, status: 'VALIDATED', amount: String(c.total), currency: 'BDT' } });
    if (r.status === 200) c.captured.set(valId, c.total); // the gateway captured this payment
    c.lastValid = { tranId, valId };
    return [r];
  },
  ipnReplay: async (c) => {
    if (!c.lastValid) return [];
    // Gateway retry of the exact same notification: must change nothing.
    return [await http('POST', '/payment/ipn', { form: { tran_id: c.lastValid.tranId, val_id: c.lastValid.valId, status: 'VALIDATED', amount: String(c.total), currency: 'BDT' } })];
  },
  ipnFailed: async (c) => {
    if (!c.tranIds.length) return [];
    return [await http('POST', '/payment/ipn', { form: { tran_id: pick(c.tranIds), val_id: `FAIL-${SEED}-${c.i}-${c.valSeq++}`, status: 'FAILED', amount: String(c.total), currency: 'BDT' } })];
  },
  ipnTampered: async (c) => {
    if (!c.tranIds.length) return [];
    return [await http('POST', '/payment/ipn', { form: { tran_id: pick(c.tranIds), val_id: `TAMP-${SEED}-${c.i}-${c.valSeq++}`, status: 'VALIDATED', amount: String(c.total - 1), currency: 'BDT' } })];
  },
  abandonSweep: async () => {
    await runAbandonmentSweep({ now: new Date(Date.now() + int(0, 5) * HOUR) });
    return [];
  }
};
const FUND_WEIGHTED = ['initiate', 'initiate', 'ipnValid', 'ipnValid', 'ipnReplay', 'ipnFailed', 'ipnTampered', 'abandonSweep'];

function fundingViolations(c, ledger) {
  const out = checkLedger(ledger).map((v) => `${v.rule} ${v.message}`);
  const orphans = ledger.orphanPayments || [];
  const capturedTotal = [...c.captured.values()].reduce((a, b) => a + b, 0);
  const accounted = (ledger.paidByValId ? ledger.totalContractValue : 0) + orphans.reduce((a, p) => a + p.amount, 0);
  if (capturedTotal !== accounted) out.push(`captured ${capturedTotal} BDT but ledger accounts for ${accounted} (funded=${Boolean(ledger.paidByValId)}, orphans=${orphans.length})`);
  if (ledger.paidByValId && !c.captured.has(ledger.paidByValId)) out.push(`funded by unknown val_id ${ledger.paidByValId}`);
  const orphanIds = orphans.map((p) => p.valId);
  if (new Set(orphanIds).size !== orphanIds.length) out.push('the same payment is recorded twice as orphan');
  if (orphanIds.includes(ledger.paidByValId)) out.push('funding payment also recorded as orphan');
  if (ledger.ledgerStatus === 'CANCELLED' && ledger.paidByValId) out.push('cancelled ledger carries a funding payment');
  return out;
}

// ── Phase B: payout ──────────────────────────────────────────────────────────
async function releaseAllMilestones(c) {
  let ledger = await EscrowLedger.findById(c.ledgerId).lean();
  for (let k = 0; k < ledger.milestones.length; k++) {
    await EscrowLedger.updateOne(
      { _id: c.ledgerId, [`milestones.${k}.status`]: 'IN_PROGRESS' },
      { $set: { [`milestones.${k}.status`]: 'PROOF_SUBMITTED' } }
    );
    const burst = rand() < 0.3 ? 2 : 1; // sometimes a double-click
    const results = await Promise.all(Array.from({ length: burst }, () =>
      http('POST', `/governance/approve/${c.ledgerId}/milestone/${k}`, { tok: c.clientTok, key: `appr-${SEED}-${c.i}-${k}-${seq++}` })));
    const bad = results.find((r) => r.status >= 500);
    if (bad) return [`HTTP ${bad.status} approving milestone ${k}: ${JSON.stringify(bad.body)}`];
  }
  ledger = await EscrowLedger.findById(c.ledgerId).lean();
  for (const m of ledger.milestones) {
    if (m.status === 'COMPLETED') {
      const { contractor, platform } = splitMilestoneAmount(m.amount);
      c.earned += contractor;
      c.fees += platform;
    }
  }
  return checkLedger(ledger).map((v) => `${v.rule} ${v.message}`);
}

const BANK = { accountName: 'Fuzz Contractor', accountNumber: '0011223344', routingNumber: '090261234', bankName: 'Fuzz Bank' };
const PAY_ACTIONS = {
  settle: async () => { await settlePendingTranches({ now: new Date(Date.now() + 3 * 24 * HOUR) }); return []; },
  withdraw: async (c) => {
    const w = await User.findById(c.contractor._id).select('wallet').lean();
    const avail = w.wallet?.availableToWithdraw || 0;
    const amount = pick([500, int(500, Math.max(500, avail)), avail, avail + 1000, 500.5, 499]);
    return [await http('POST', '/finance/withdraw', { tok: c.contractorTok, key: `wd-${SEED}-${c.i}-${seq++}`, body: { amount, bankDetails: BANK } })];
  },
  withdrawBurst: async (c) => {
    const w = await User.findById(c.contractor._id).select('wallet').lean();
    const amount = Math.max(500, Math.floor((w.wallet?.availableToWithdraw || 0) * 0.7));
    return Promise.all([0, 1, 2].map(() => http('POST', '/finance/withdraw', { tok: c.contractorTok, key: `wdb-${SEED}-${c.i}-${seq++}`, body: { amount, bankDetails: BANK } })));
  },
  reconcile: async () => { await runReconciliationCycle({ now: new Date(Date.now() + HOUR), gracePeriodMs: 0 }); return []; }
};
const PAY_WEIGHTED = ['settle', 'withdraw', 'withdraw', 'withdrawBurst', 'reconcile', 'reconcile'];

async function payoutViolations(c) {
  const out = [];
  const u = await User.findById(c.contractor._id).select('wallet').lean();
  const pending = u.wallet?.pendingClearance || 0;
  const avail = u.wallet?.availableToWithdraw || 0;
  for (const [k, v] of [['pendingClearance', pending], ['availableToWithdraw', avail]]) {
    if (!Number.isInteger(v) || v < 0) out.push(`contractor ${k} is ${v} (must be whole taka >= 0)`);
  }
  const wds = await WithdrawalLedger.find({ userId: c.contractor._id }).lean();
  const reserved = wds.filter((w) => ['PROCESSING', 'COMPLETED', 'MANUAL_REVIEW'].includes(w.status)).reduce((a, w) => a + w.amount, 0);
  if (pending + avail + reserved !== c.earned) {
    out.push(`contractor money leak: pending ${pending} + available ${avail} + reserved ${reserved} != earned ${c.earned}`);
  }
  for (const w of wds) {
    const truth = bankTruth.get(w.idempotencyKey);
    if (w.status === 'FAILED' && truth === 'PAID') out.push(`withdrawal ${w._id} refunded although the bank PAID it (double payout)`);
    if (w.status === 'COMPLETED' && truth === 'UNPAID') out.push(`withdrawal ${w._id} COMPLETED although the bank never paid`);
  }
  return out;
}

function fiveXX(results, allow502) {
  // A definite bank rejection is answered 502/503 on purpose ("funds restored").
  return results.find((r) => r.status >= 500 && !(allow502 && (r.status === 502 || r.status === 503)));
}

async function main() {
  assertLocalDatabase(process.env.MONGODB_URI);
  if (!appServer.listening) await new Promise((r) => appServer.once('listening', r));
  baseUrl = `http://127.0.0.1:${appServer.address().port}/api`;
  console.log(`🎲 money lifecycle fuzz — seed ${SEED}, ${CONTRACTS} contracts, ${FUND_STEPS} funding + ${PAY_STEPS} payout steps`);

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await User.deleteMany({ phoneNumber: { $regex: new RegExp(`^${PHONE_PREFIX}`) } });
  const treasury = await User.findOneAndUpdate(
    { phoneNumber: TREASURY_PHONE },
    { $setOnInsert: { role: 'ADMIN', phoneNumber: TREASURY_PHONE, status: 'ACTIVE' } },
    { upsert: true, returnDocument: 'after' }
  );
  const tStart = { pending: treasury.wallet?.pendingClearance || 0, avail: treasury.wallet?.availableToWithdraw || 0 };
  installBank();

  const failures = [];
  const tally = { fundingActions: 0, payoutActions: 0, funded: 0, cancelled: 0, orphanPayments: 0, withdrawals: 0 };
  const contracts = [];

  try {
    for (let i = 0; i < CONTRACTS && !failures.length; i++) {
      const c = await makeContract(i);
      contracts.push(c);
      const trail = [];

      for (let s = 0; s < FUND_STEPS && !failures.length; s++) {
        const name = pick(FUND_WEIGHTED);
        const results = await FUND_ACTIONS[name](c);
        tally.fundingActions += 1;
        trail.push(`${name} → ${results.map((r) => r.status).join(',') || 'job'}`);
        const ledger = await EscrowLedger.findById(c.ledgerId).lean();
        const broken = fundingViolations(c, ledger);
        const bad = fiveXX(results, false);
        if (bad) broken.unshift(`HTTP ${bad.status} on ${name}: ${JSON.stringify(bad.body)}`);
        if (broken.length) failures.push({ contract: i, phase: 'funding', step: s, broken, trail: trail.slice(-10), state: ledger.ledgerStatus });
      }
      if (failures.length) break;

      const funded = await EscrowLedger.findById(c.ledgerId).lean();
      tally.orphanPayments += (funded.orphanPayments || []).length;
      if (funded.ledgerStatus === 'CANCELLED') tally.cancelled += 1;
      if (!funded.paidByValId) continue;
      tally.funded += 1;

      const releaseBroken = await releaseAllMilestones(c);
      if (releaseBroken.length) { failures.push({ contract: i, phase: 'release', broken: releaseBroken }); break; }

      for (let s = 0; s < PAY_STEPS && !failures.length; s++) {
        const name = pick(PAY_WEIGHTED);
        const results = await PAY_ACTIONS[name](c);
        tally.payoutActions += 1;
        if (name.startsWith('withdraw')) tally.withdrawals += results.length;
        trail.push(`${name} → ${results.map((r) => r.status).join(',') || 'job'}`);
        const broken = await payoutViolations(c);
        const bad = fiveXX(results, true);
        if (bad) broken.unshift(`HTTP ${bad.status} on ${name}: ${JSON.stringify(bad.body)}`);
        if (broken.length) failures.push({ contract: i, phase: 'payout', step: s, broken, trail: trail.slice(-10) });
      }
    }

    if (!failures.length) {
      const t = await User.findOne({ phoneNumber: TREASURY_PHONE }).select('wallet').lean();
      const grew = (t.wallet?.pendingClearance || 0) + (t.wallet?.availableToWithdraw || 0) - tStart.pending - tStart.avail;
      const fees = contracts.reduce((a, c) => a + c.fees, 0);
      if (grew !== fees) failures.push({ phase: 'treasury', broken: [`treasury grew by ${grew}, platform fees earned ${fees}`] });
    }
  } finally {
    bank.clearTestOverrides();
    const ledgerIds = contracts.map((c) => c.ledgerId);
    const userIds = contracts.flatMap((c) => [c.client._id, c.contractor._id]);
    await EscrowLedger.deleteMany({ _id: { $in: ledgerIds } });
    await Project.deleteMany({ title: 'Lifecycle fuzz project' });
    await WithdrawalLedger.deleteMany({ userId: { $in: userIds } });
    await User.deleteMany({ phoneNumber: { $regex: new RegExp(`^${PHONE_PREFIX}`) } });
    await User.updateOne({ phoneNumber: TREASURY_PHONE }, { $set: { 'wallet.pendingClearance': tStart.pending, 'wallet.availableToWithdraw': tStart.avail } });
  }

  console.log(`  coverage: ${JSON.stringify(tally)}`);
  if (failures.length) {
    for (const f of failures) {
      console.log(`  ❌ ${f.phase} invariant broken${f.contract !== undefined ? ` on contract ${f.contract}` : ''}${f.step !== undefined ? ` at step ${f.step}` : ''}:`);
      for (const b of f.broken) console.log(`       - ${b}`);
      if (f.trail) console.log(`       last actions: ${f.trail.join(' | ')}`);
    }
    console.log(`  reproduce: MONGODB_URI= QA_FUZZ_SEED=${SEED} node scripts/run-tests.js --only lifecycle`);
    console.log('--- Results: FAILED ---');
    return 1;
  }
  console.log(`  ✅ funding + payout lifecycle: no 5xx, every captured taka accounted for, wallets reconcile, no double payout`);
  console.log('--- Results: all passed ---');
  return 0;
}

main()
  .then(async (code) => { await mongoose.connection.close().catch(() => {}); appServer.close(); process.exit(code); })
  .catch(async (err) => { console.error('💥 lifecycle fuzz harness crashed:', err); bank.clearTestOverrides(); await mongoose.connection.close().catch(() => {}); process.exit(1); });
