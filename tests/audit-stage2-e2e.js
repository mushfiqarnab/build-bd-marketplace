// tests/audit-stage2-e2e.js — regression tests for the 2026-10-18 audit, stage 2 (functional deadlocks).
// Each scenario was PROVEN broken by tests/audit-probes.js (see D:\agy-briefs\AUDIT-2026-10-18-proofs.md):
//   G3  CANCEL_AND_RESTART froze the contract            -> the milestone is reopened, work continues, money flows
//   D6  a 2nd dispute after a restart had no ticket       -> numbered dispute rounds
//   G4  client refunds could not be withdrawn             -> clients withdraw through the same audited flow
//   G5  contractor capacity never released                -> released on completion; reconciler heals drift
//   K1  projects never completed / could not be cancelled -> COMPLETED on payout; cancel route
//   K2  contractor profile could not be edited            -> PATCH /me (+ re-review of verified profiles)
//   G2/H2 evidence-hash index, cash receipts              -> indexes + partial unique receipt index
//   G14 non-text input crashed with 500                   -> 400
//   migration script replaces the two old indexes
'use strict';

const dotenv = require('dotenv');
dotenv.config();
process.env.PORT = '0';

const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

const User = require('../models/User');
const Project = require('../models/Project');
const Bid = require('../models/Bid');
const EscrowLedger = require('../models/EscrowLedger');
const ContractorProfile = require('../models/ContractorProfile');
const DisputeTicket = require('../models/DisputeTicket');
const PaymentReceipt = require('../models/PaymentReceipt');
const WithdrawalLedger = require('../models/WithdrawalLedger');
const AuditLog = require('../models/AuditLog');
const bank = require('../services/bankPayoutClient');
const { reconcileCapacity } = require('../services/ledgerLifecycle');

const PREFIX = '0199177';
let seq = 0;
const phone = () => `${PREFIX}${String(seq++).padStart(4, '0')}`;
let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failed += 1; console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function main() {
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.MONGODB_URI || '')) {
    console.log('⏭️  audit-stage2: MONGODB_URI is not a local throwaway database — skipped.');
    process.exit(0);
  }
  if (!appServer.listening) await new Promise((r) => appServer.once('listening', r));
  const base = `http://127.0.0.1:${appServer.address().port}/api`;
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('🧪 audit stage 2 — functional deadlock regressions');

  const mk = (role, extra = {}) => User.create({ role, phoneNumber: phone(), status: 'ACTIVE', ...extra });
  const tok = (u) => jwt.sign({ userId: u._id, role: u.role, sv: u.sessionVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  let n = 0;
  const call = async (method, p, user, body, hdr = {}) => {
    const r = await fetch(`${base}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${tok(user)}` } : {}), ...hdr },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const idem = () => ({ 'X-Idempotency-Key': `s2-${Date.now()}-${n++}` });

  const [admin, mod, client, contractor, stranger] = await Promise.all([mk('ADMIN'), mk('MODERATOR'), mk('CLIENT'), mk('CONTRACTOR'), mk('CLIENT')]);
  await User.create({ role: 'ADMIN', phoneNumber: process.env.TREASURY_PHONE, status: 'ACTIVE' }).catch(() => {}); // treasury
  const profile = await ContractorProfile.create({ userId: contractor._id, businessType: 'COMPANY', fullName: 'Stage Two Builders', tradeLicense: 'TL-1', verification: { status: 'VERIFIED', probationStatus: { isProbation: false } }, workGenres: ['BUILDING_CONSTRUCTION'], serviceAreas: [{ district: 'Dhaka', areas: [] }], trustScore: 50 });

  const mkProject = (extra = {}) => Project.create({
    clientId: client._id, title: 'Stage2 project', category: 'Residential', description: 'A stage two project description long enough.',
    location: 'Dhaka', budget: 100000, status: 'ASSIGNED', awardedContractorId: contractor._id,
    siteCoordinates: { latitude: 23.78, longitude: 90.4 }, ...extra
  });
  const mkLedger = (project, over = {}) => EscrowLedger.create({
    projectId: project._id, clientId: client._id, contractorId: contractor._id, totalContractValue: 20000,
    ledgerStatus: 'FUNDED', paidByValId: `val-${crypto.randomBytes(4).toString('hex')}`,
    milestones: [
      { title: 'M0', releasePercentage: 50, amount: 10000, status: 'PROOF_SUBMITTED' },
      { title: 'M1', releasePercentage: 50, amount: 10000, status: 'PENDING' }
    ], ...over
  });
  const submitEvidence = async (ledger, idx) => {
    const pre = await call('GET', `/governance/proof/presigned-url?ledgerId=${ledger._id}&milestoneIndex=${idx}&contentType=image/jpeg`, contractor);
    const ev = await call('POST', `/governance/proof/evidence/live/${ledger._id}/milestone/${idx}`, contractor,
      { s3KeyToken: pre.body && pre.body.data && pre.body.data.s3KeyToken, imageHash: crypto.randomBytes(32).toString('hex'), lat: 23.78, lng: 90.4, accuracy: 5 });
    return { pre, ev };
  };

  try {
    // ── G3 + D6: dispute -> restart -> new proof -> approve -> next milestone; and a second dispute round ─────
    {
      const p = await mkProject();
      const led = await mkLedger(p);
      const d1 = await call('POST', `/governance/dispute/${led._id}/milestone/0`, client, { reason: 'The wall is not built to the drawing.' }, idem());
      const t1 = await DisputeTicket.findOne({ ledgerId: led._id, milestoneIndex: 0 }).lean();
      check('dispute 1 opens ticket round 1', d1.status === 200 && t1 && t1.round === 1 && t1.status === 'OPEN_FOR_REVIEW', `http ${d1.status}`);
      const res = await call('POST', `/moderation/dispute/${t1._id}/resolve`, mod, { verdict: 'CANCEL_AND_RESTART', justification: 'Redo the wall to the drawing and submit new photos.' }, idem());
      let cur = await EscrowLedger.findById(led._id).lean();
      check('G3 CANCEL_AND_RESTART reopens the SAME milestone as IN_PROGRESS (not LOCKED)', res.status === 200 && cur.milestones[0].status === 'IN_PROGRESS' && cur.milestones[1].status === 'PENDING' && cur.ledgerStatus === 'FUNDED', `resolve ${res.status}; M0 ${cur.milestones[0].status}; ledger ${cur.ledgerStatus}`);
      check('G3 the old evidence stays as history, proof pointer cleared', cur.milestones[0].proofOfWorkUrl === null);

      const { pre, ev } = await submitEvidence(led, 0);
      cur = await EscrowLedger.findById(led._id).lean();
      check('G3 the contractor can upload fresh proof after the restart', pre.status === 200 && ev.status === 200 && cur.milestones[0].status === 'PROOF_SUBMITTED', `presign ${pre.status}, evidence ${ev.status}`);

      const d2 = await call('POST', `/governance/dispute/${led._id}/milestone/0`, client, { reason: 'Still not built to the drawing, second try.' }, idem());
      const tickets = await DisputeTicket.find({ ledgerId: led._id, milestoneIndex: 0 }).sort({ round: 1 }).lean();
      check('D6 a second dispute creates round 2 with its own OPEN ticket', d2.status === 200 && tickets.length === 2 && tickets[1].round === 2 && tickets[1].status === 'OPEN_FOR_REVIEW' && tickets[0].status === 'RESOLVED_CANCELLED', `http ${d2.status}, tickets ${tickets.length}`);
      const queue = await call('GET', '/moderation/disputes?status=open', mod);
      check('D6 the moderator queue shows the new round', queue.body.data.disputes.some((x) => String(x.ticketId) === String(tickets[1] && tickets[1]._id)));
      const again = await call('POST', `/governance/dispute/${led._id}/milestone/0`, client, { reason: 'Same dispute retried by the client app.' }, idem());
      check('D6 retrying the same dispute does not create a third round', (await DisputeTicket.countDocuments({ ledgerId: led._id, milestoneIndex: 0 })) === 2 && again.status !== 500, `http ${again.status}`);
    }
    {
      // full happy path after a restart: approve -> next milestone opens -> ledger completes
      const p = await mkProject();
      const led = await mkLedger(p, { ledgerStatus: 'IN_ARBITRATION', milestones: [
        { title: 'M0', releasePercentage: 50, amount: 10000, status: 'DISPUTED', disputeReason: 'not to the drawing' },
        { title: 'M1', releasePercentage: 50, amount: 10000, status: 'PENDING' }] });
      const t = await DisputeTicket.create({ projectId: p._id, ledgerId: led._id, milestoneIndex: 0, clientId: client._id, contractorId: contractor._id, clientRejectionReason: 'not to the drawing' });
      await call('POST', `/moderation/dispute/${t._id}/resolve`, mod, { verdict: 'CANCEL_AND_RESTART', justification: 'Restart with clearer scope for both parties.' }, idem());
      await submitEvidence(led, 0);
      const ap0 = await call('POST', `/governance/approve/${led._id}/milestone/0`, client, {}, idem());
      let cur = await EscrowLedger.findById(led._id).lean();
      check('G3 after the restart the client approves and the NEXT milestone unlocks', ap0.status === 200 && cur.milestones[0].status === 'COMPLETED' && cur.milestones[1].status === 'IN_PROGRESS', `approve ${ap0.status}; M1 ${cur.milestones[1].status}`);
    }

    // ── G5 + K1: completion releases the slot and completes the project; reconciler heals drift ───────────
    {
      const p = await mkProject({ status: 'OPEN', awardedContractorId: null });
      const bid = await Bid.create({ projectId: p._id, contractorId: contractor._id, bidAmount: 20000, estimatedDays: 5, proposalText: 'stage two capacity bid', bidFingerprint: 'k' });
      const before = (await ContractorProfile.findOne({ userId: contractor._id }).lean()).availability.currentProjects;
      const acc = await call('PUT', `/bids/${bid._id}/accept`, client, {});
      const led = await EscrowLedger.findOne({ projectId: p._id });
      const mid = (await ContractorProfile.findOne({ userId: contractor._id }).lean()).availability.currentProjects;
      await EscrowLedger.updateOne({ _id: led._id }, { $set: { ledgerStatus: 'FUNDED', paidByValId: `v-${Date.now()}` } });
      for (let i = 0; i < led.milestones.length; i++) {
        await EscrowLedger.updateOne({ _id: led._id }, { $set: { [`milestones.${i}.status`]: 'PROOF_SUBMITTED' } });
        await call('POST', `/governance/approve/${led._id}/milestone/${i}`, client, {}, idem());
      }
      const fin = await EscrowLedger.findById(led._id).lean();
      const after = (await ContractorProfile.findOne({ userId: contractor._id }).lean()).availability.currentProjects;
      const proj = await Project.findById(p._id).lean();
      check('G5 the slot is taken on award and RELEASED when the contract is fully paid', acc.status === 200 && mid === before + 1 && fin.ledgerStatus === 'FULLY_DISBURSED' && after === before, `before ${before}, awarded ${mid}, done ${after}`);
      check('K1 the project becomes COMPLETED when the contract is fully paid', proj.status === 'COMPLETED', proj.status);
    }
    {
      await ContractorProfile.updateOne({ userId: contractor._id }, { $set: { 'availability.currentProjects': 3 } }); // drift from the old bug
      const live = await EscrowLedger.countDocuments({ contractorId: contractor._id, ledgerStatus: { $nin: ['FULLY_DISBURSED', 'CANCELLED'] } });
      const r = await reconcileCapacity();
      const now = (await ContractorProfile.findOne({ userId: contractor._id }).lean()).availability.currentProjects;
      check('G5 reconcileCapacity heals drifted counters to the real number of open contracts', r.corrected >= 1 && now === live, `corrected ${r.corrected}, now ${now}, live ${live}`);
    }

    // ── G4 + D15: client withdrawal of a refund, audited, no bank number echoed ───────────────────────────
    {
      bank.setTestOverrides({ initiatePayout: async () => ({ bankTransactionId: 'BANK-TX-1' }), queryPayoutStatus: async () => ({ status: 'SUCCESS' }) });
      const p = await mkProject();
      const led = await mkLedger(p, { ledgerStatus: 'IN_ARBITRATION', milestones: [
        { title: 'M0', releasePercentage: 100, amount: 20000, status: 'DISPUTED', disputeReason: 'work not done as agreed' }] });
      const v = await call('POST', `/governance/arbitrate/${led._id}/milestone/0`, admin, { decision: 'FAVOR_CLIENT', arbitrationNotes: 'Work did not meet the agreed scope; refunding the client.' }, idem());
      const w = await call('POST', '/finance/withdraw', client, { amount: 5000, bankDetails: { accountName: 'Client A', accountNumber: '1234567890123', routingNumber: '020261234', bankName: 'Test Bank' } }, idem());
      const cu = await User.findById(client._id).lean();
      const rec = await WithdrawalLedger.findOne({ userId: client._id }).lean();
      check('G4 the CLIENT can withdraw refunded money (200, COMPLETED)', v.status === 200 && w.status === 200 && w.body.data.status === 'COMPLETED' && cu.wallet.availableToWithdraw === 15000, `verdict ${v.status}, withdraw ${w.status}, wallet ${cu.wallet.availableToWithdraw}`);
      check('G4 the response never contains the full account number', !JSON.stringify(w.body).includes('1234567890123') && w.body.data.accountLast4 === '0123');
      const logs = await AuditLog.find({ entityType: 'WITHDRAWAL_LEDGER', entityId: rec._id }).lean();
      const actions = logs.map((l) => l.action).sort();
      check('D15 withdrawals are audited (REQUESTED + COMPLETED) with no account number', actions.join() === 'WITHDRAWAL_COMPLETED,WITHDRAWAL_REQUESTED' && !JSON.stringify(logs).includes('1234567890123'), actions.join());
      const hist = await call('GET', '/finance/withdrawals', client);
      check('G4 the client sees their own withdrawal history (masked)', hist.status === 200 && hist.body.data.withdrawals.length === 1 && hist.body.data.withdrawals[0].accountLast4 === '0123');
      const forbidden = await call('POST', '/finance/withdraw', admin, { amount: 500, bankDetails: { accountName: 'A', accountNumber: '1', routingNumber: '2', bankName: 'B' } }, idem());
      check('G4 other roles (ADMIN) still cannot withdraw (403)', forbidden.status === 403);
      bank.clearTestOverrides();
    }

    // ── H2 / G2: indexes ──────────────────────────────────────────────────────────────────────────────────
    {
      await PaymentReceipt.init(); await EscrowLedger.init();
      const mkR = (m, t, i) => PaymentReceipt.create({ projectId: new mongoose.Types.ObjectId(), ledgerId: new mongoose.Types.ObjectId(), milestoneId: new mongoose.Types.ObjectId(), milestoneIndex: i, clientId: client._id, contractorId: contractor._id, amountBDT: 1000, paymentMethod: m, trxId: t, s3ReceiptUrl: `k${m}${i}` });
      let cashOk = true; let dupBlocked = false;
      try { await mkR('CASH', null, 0); await mkR('CASH', null, 1); await mkR('CASH', null, 2); } catch (e) { cashOk = false; }
      await mkR('BKASH', 'TX123', 3);
      try { await mkR('BKASH', 'TX123', 4); } catch (e) { dupBlocked = e.code === 11000; }
      check('H2 any number of CASH receipts (no transaction id) can be recorded', cashOk);
      check('H2 re-using a bKash transaction id is still blocked', dupBlocked);
      const idx = await EscrowLedger.collection.indexes();
      check('G2 EscrowLedger has an index on the evidence imageHash', idx.some((i) => i.key && i.key['milestones.evidenceLog.imageHash'] === 1));
      const ex = await EscrowLedger.find({ 'milestones.evidenceLog.imageHash': 'a'.repeat(64) }).explain('queryPlanner');
      check('G2 the imageHash lookup is no longer a collection scan', !/COLLSCAN/.test(JSON.stringify(ex.queryPlanner.winningPlan)));
    }

    // ── K1 cancel ─────────────────────────────────────────────────────────────────────────────────────────
    {
      const p = await mkProject({ status: 'OPEN', awardedContractorId: null });
      const b = await Bid.create({ projectId: p._id, contractorId: contractor._id, bidAmount: 5000, estimatedDays: 3, proposalText: 'cancel me bid', bidFingerprint: 'c' });
      const bad = await call('POST', `/projects/${p._id}/cancel`, stranger, {});
      const ok = await call('POST', `/projects/${p._id}/cancel`, client, {});
      const again = await call('POST', `/projects/${p._id}/cancel`, client, {});
      const bidAfter = await Bid.findById(b._id).lean();
      const projAfter = await Project.findById(p._id).lean();
      check('K1 a stranger cannot cancel someone else\'s project (404)', bad.status === 404);
      check('K1 the owner cancels an OPEN project; pending bids are rejected', ok.status === 200 && projAfter.status === 'CANCELLED' && bidAfter.status === 'REJECTED');
      check('K1 cancelling twice is harmless (200 already cancelled)', again.status === 200 && again.body.data.already === true);
      const assigned = await mkProject();
      const no = await call('POST', `/projects/${assigned._id}/cancel`, client, {});
      check('K1 a hired (ASSIGNED) project cannot be cancelled this way (409)', no.status === 409);
      const audit = await AuditLog.countDocuments({ entityType: 'PROJECT', entityId: p._id, action: 'PROJECT_CANCELLED' });
      check('K1 the cancellation is audited exactly once', audit === 1, String(audit));
    }

    // ── K2 profile edit ───────────────────────────────────────────────────────────────────────────────────
    {
      const edit = await call('PATCH', '/contractor-profile/me', contractor, { serviceAreas: [{ district: 'Cumilla', areas: ['Sadar'], willingToTravel: true }], workGenres: ['BUILDING_CONSTRUCTION', 'JUNK'], availability: { maxConcurrentProjects: 5 } });
      const p1 = await ContractorProfile.findOne({ userId: contractor._id }).lean();
      check('K2 the contractor edits areas / genres / capacity; junk genres dropped; stays VERIFIED', edit.status === 200 && p1.serviceAreas[0].district === 'Cumilla' && p1.workGenres.join() === 'BUILDING_CONSTRUCTION' && p1.availability.maxConcurrentProjects === 5 && p1.verification.status === 'VERIFIED');
      const lic = await call('PATCH', '/contractor-profile/me', contractor, { tradeLicense: 'TL-NEW-2' });
      const p2 = await ContractorProfile.findOne({ userId: contractor._id }).lean();
      const dir = await call('GET', '/contractor-profile/directory', client);
      check('K2 changing the licence sends a VERIFIED profile back to PENDING (leaves the public directory)', lic.status === 200 && p2.verification.status === 'PENDING' && !dir.body.data.contractors.some((c) => c.fullName === 'Stage Two Builders'));
      const bads = await Promise.all([
        call('PATCH', '/contractor-profile/me', contractor, {}),
        call('PATCH', '/contractor-profile/me', contractor, { fullName: 'x' }),
        call('PATCH', '/contractor-profile/me', contractor, { availability: { maxConcurrentProjects: 0 } }),
        call('PATCH', '/contractor-profile/me', contractor, { serviceAreas: 'Dhaka' }),
        call('PATCH', '/contractor-profile/me', client, { fullName: 'Not A Contractor' })
      ]);
      check('K2 empty / invalid edits are refused (400) and non-contractors are forbidden (403)', bads.slice(0, 4).every((r) => r.status === 400) && bads[4].status === 403, bads.map((r) => r.status).join());
    }

    // ── G14 input types ───────────────────────────────────────────────────────────────────────────────────
    {
      const p = await mkProject();
      const led = await mkLedger(p);
      const num = await call('POST', `/governance/dispute/${led._id}/milestone/0`, client, { reason: 12345678901234 }, idem());
      const obj = await call('POST', '/projects/wizard-submit', client, { category: { a: 1 }, location: 'Dhaka', scopeDescription: 'x'.repeat(30), priority: 'LOW' });
      const pri = await call('POST', '/projects/wizard-submit', client, { category: 'Residential', location: 'Dhaka', scopeDescription: 'x'.repeat(30), priority: 'URGENT' });
      check('G14 a non-text dispute reason / wizard field is a 400, not a 500', num.status === 400 && obj.status === 400 && pri.status === 400, `${num.status}/${obj.status}/${pri.status}`);
    }

    // ── migration script ─────────────────────────────────────────────────────────────────────────────────
    {
      const dt = DisputeTicket.collection; const pr = PaymentReceipt.collection;
      // Simulate a database from before this release: the old strict indexes cannot hold the multi-round /
      // multi-cash data created above, so start those two collections empty first.
      await dt.deleteMany({}); await pr.deleteMany({});
      for (const [c, name] of [[dt, 'ledgerId_1_milestoneIndex_1_round_1'], [pr, 'paymentMethod_1_trxId_1']]) { await c.dropIndex(name).catch(() => {}); }
      await dt.createIndex({ ledgerId: 1, milestoneIndex: 1 }, { unique: true, name: 'ledgerId_1_milestoneIndex_1' });
      await pr.createIndex({ paymentMethod: 1, trxId: 1 }, { unique: true, sparse: true, name: 'paymentMethod_1_trxId_1' });
      const run = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'migrate-audit-stage2-indexes.js')], { env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 30000 });
      const dix = await dt.indexes(); const pix = await pr.indexes();
      check('migration: the old dispute-ticket index is dropped and the round index exists', run.status === 0 && !dix.some((i) => i.name === 'ledgerId_1_milestoneIndex_1') && dix.some((i) => i.key.round === 1 && i.unique), `exit ${run.status} ${run.stderr}`);
      check('migration: the receipt index becomes a partial index', pix.some((i) => i.name === 'paymentMethod_1_trxId_1' && i.partialFilterExpression && i.unique), JSON.stringify(pix.map((i) => i.name)));
      const second = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'scripts', 'migrate-audit-stage2-indexes.js')], { env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8', timeout: 30000 });
      check('migration: running it a second time is harmless', second.status === 0);
    }
  } finally {
    bank.clearTestOverrides();
    await Promise.all([User, Project, Bid, EscrowLedger, ContractorProfile, DisputeTicket, PaymentReceipt, WithdrawalLedger, require('../models/IdempotencyKey'), require('../models/Message'), require('../models/Review'), AuditLog.collection].map((M) => M.deleteMany({}).catch(() => {})));
    await mongoose.disconnect();
    appServer.close();
  }

  if (failed) { console.log(`\n💥 ${failed} check(s) failed`); process.exit(1); }
  console.log('\n✅ audit stage 2 regressions OK');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
