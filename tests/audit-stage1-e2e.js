// tests/audit-stage1-e2e.js — regression tests for the 2026-10-18 audit, stage 1 (security).
// Every scenario below was PROVEN broken by tests/audit-probes.js before the fix.
//   E1  banned user cannot sign in with an OTP
//   H3  negotiation offers: only the OTHER participant may accept; strangers and the offer's author cannot
//   H4  a review can only target the contractor hired on that project
//   G16 idempotency: key bound to one request; retryable failures are not frozen; bad keys refused
//   E7  production never runs the mock payment gateway
//   D2/D3 payouts never go to an unconfigured/mock bank; a 409 from the bank is ambiguous
//   G8/G9 responses no longer leak gateway ids, wallets or bidder phone numbers
//   JWT algorithm is pinned
'use strict';

const dotenv = require('dotenv');
dotenv.config();
process.env.PORT = '0';

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

const User = require('../models/User');
const Project = require('../models/Project');
const Bid = require('../models/Bid');
const EscrowLedger = require('../models/EscrowLedger');
const ContractorProfile = require('../models/ContractorProfile');
const DisputeTicket = require('../models/DisputeTicket');
const IdempotencyKey = require('../models/IdempotencyKey');
const { enforceIdempotency } = require('../middleware/idempotency');
const { isMockGateway } = require('../routes/payment');
const bank = require('../services/bankPayoutClient');
const { maskPhone } = require('../utils/dto');

const PREFIX = '0199166';
let seq = 0;
const phone = () => `${PREFIX}${String(seq++).padStart(4, '0')}`;
let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failed += 1; console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function main() {
  // This suite clears collections when it finishes: only ever run it on a throwaway local database.
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(process.env.MONGODB_URI || '')) {
    console.log('⏭️  audit-stage1: MONGODB_URI is not a local throwaway database — skipped.');
    process.exit(0);
  }
  if (!appServer.listening) await new Promise((r) => appServer.once('listening', r));
  const base = `http://127.0.0.1:${appServer.address().port}/api`;
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('🧪 audit stage 1 — security regressions');

  const mk = (role, extra = {}) => User.create({ role, phoneNumber: phone(), status: 'ACTIVE', ...extra });
  const tok = (u, opts = {}) => jwt.sign({ userId: u._id, role: u.role, sv: u.sessionVersion || 0 }, process.env.JWT_SECRET, { expiresIn: '1h', ...opts });
  let n = 0;
  const call = async (method, path, user, body, hdr = {}) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`${base}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${tok(user)}` } : {}), ...hdr },
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: r.status, body: await r.json().catch(() => null) };
      } catch (err) {
        if (attempt < 2 && (err?.cause?.code === 'ECONNRESET' || err?.code === 'ECONNRESET')) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        throw err;
      }
    }
  };
  const idem = () => ({ 'X-Idempotency-Key': `s1-${Date.now()}-${n++}` });

  const [client, client2, contractor, contractor2, stranger, mod, admin] = await Promise.all([
    mk('CLIENT'), mk('CLIENT'), mk('CONTRACTOR'), mk('CONTRACTOR'), mk('CLIENT'), mk('MODERATOR'), mk('ADMIN')
  ]);
  const verified = { verification: { status: 'VERIFIED', probationStatus: { isProbation: false } } };
  await ContractorProfile.create({ userId: contractor._id, businessType: 'COMPANY', fullName: 'Alpha Builders', ...verified });
  await ContractorProfile.create({ userId: contractor2._id, businessType: 'COMPANY', fullName: 'Beta Builders', ...verified });

  const mkProject = (owner, extra = {}) => Project.create({
    clientId: owner._id, title: 'Stage1 project', category: 'Residential', description: 'A stage one project description long enough.',
    location: 'Dhaka', budget: 100000, status: 'ASSIGNED', awardedContractorId: contractor._id,
    siteCoordinates: { latitude: 23.78, longitude: 90.4 }, ...extra
  });
  const mkLedger = (owner, ctr, project, over = {}) => EscrowLedger.create({
    projectId: project._id, clientId: owner._id, contractorId: ctr._id, totalContractValue: 20000,
    ledgerStatus: 'FUNDED', paidByValId: `val-${crypto.randomBytes(4).toString('hex')}`,
    gatewaySessionKey: 'SECRET-SESSION', pendingTransactionId: 'TRAN-A', pendingTransactionIds: ['TRAN-A'],
    milestones: [
      { title: 'M0', releasePercentage: 50, amount: 10000, status: 'PROOF_SUBMITTED' },
      { title: 'M1', releasePercentage: 50, amount: 10000, status: 'PENDING' }
    ], ...over
  });

  try {
    // ── E1 ──────────────────────────────────────────────────────────────────
    for (const bad of ['BANNED', 'SUSPENDED']) {
      const u = await mk('CLIENT', { status: bad });
      const h = crypto.createHmac('sha256', process.env.JWT_SECRET).update('123456').digest('hex');
      await User.updateOne({ _id: u._id }, { $set: { 'otp.hash': h, 'otp.expiresAt': new Date(Date.now() + 60000), 'otp.attempts': 0 } });
      const r = await call('POST', '/auth/verify-otp', null, { phoneNumber: u.phoneNumber, otp: '123456' });
      const after = await User.findById(u._id).lean();
      check(`E1 ${bad} user is refused (403) and stays ${bad}`, r.status === 403 && after.status === bad, `http ${r.status}, status ${after.status}`);
    }
    {
      const u = await mk('CLIENT', { status: 'PENDING_VERIFICATION' });
      const h = crypto.createHmac('sha256', process.env.JWT_SECRET).update('654321').digest('hex');
      await User.updateOne({ _id: u._id }, { $set: { 'otp.hash': h, 'otp.expiresAt': new Date(Date.now() + 60000), 'otp.attempts': 0 } });
      const r = await call('POST', '/auth/verify-otp', null, { phoneNumber: u.phoneNumber, otp: '654321' });
      check('E1 a new (PENDING_VERIFICATION) user still activates normally', r.status === 200 && r.body && r.body.user && r.body.user.status === 'ACTIVE', `http ${r.status}`);
    }

    // ── H3 ──────────────────────────────────────────────────────────────────
    const thread = async () => {
      const p = await mkProject(client, { status: 'OPEN', awardedContractorId: null });
      const b = await Bid.create({ projectId: p._id, contractorId: contractor._id, bidAmount: 50000, estimatedDays: 10, proposalText: 'stage one bid', bidFingerprint: 'x' });
      return b;
    };
    {
      const b = await thread();
      const o = await call('POST', `/chat/${b._id}/message`, client, { messageType: 'REVISED_OFFER', text: 'lower', revisedAmount: 100, revisedDays: 5 });
      const id = o.body.data.message._id;
      const self = await call('POST', `/chat/offer/${id}/accept`, client, {});
      const after = await Bid.findById(b._id).lean();
      check('H3 the client cannot accept their own revised offer (403)', self.status === 403 && after.bidAmount === 50000 && after.status === 'PENDING', `http ${self.status}, amount ${after.bidAmount}`);
      const other = await call('POST', `/chat/offer/${id}/accept`, contractor, {});
      const done = await Bid.findById(b._id).lean();
      check('H3 the OTHER party (contractor) can accept it', other.status === 200 && done.bidAmount === 100 && done.status === 'ACCEPTED', `http ${other.status}`);
    }
    {
      const b = await thread();
      const o = await call('POST', `/chat/${b._id}/message`, contractor, { messageType: 'REVISED_OFFER', text: 'offer', revisedAmount: 777, revisedDays: 3 });
      const id = o.body.data.message._id;
      const bad = await call('POST', `/chat/offer/${id}/accept`, stranger, {});
      const same = await call('POST', `/chat/offer/${id}/accept`, contractor, {});
      const mid = await Bid.findById(b._id).lean();
      check('H3 a stranger cannot accept (403) and the contractor cannot accept their own offer (403)',
        bad.status === 403 && same.status === 403 && mid.status === 'PENDING' && mid.bidAmount === 50000, `stranger ${bad.status}, author ${same.status}`);
      const ok = await call('POST', `/chat/offer/${id}/accept`, client, {});
      check('H3 the client (other party) accepts the contractor\'s offer', ok.status === 200, `http ${ok.status}`);
    }

    // ── H4 ──────────────────────────────────────────────────────────────────
    {
      const p = await mkProject(client);
      await mkLedger(client, contractor, p, { ledgerStatus: 'FULLY_DISBURSED', milestones: [{ title: 'M', releasePercentage: 100, amount: 20000, status: 'COMPLETED' }] });
      const otherP = await mkProject(client2, { status: 'OPEN', awardedContractorId: null });
      const foreign = await Bid.create({ projectId: otherP._id, contractorId: contractor2._id, bidAmount: 9000, estimatedDays: 4, proposalText: 'foreign bid', bidFingerprint: 'y' });
      const review = { rating: 1, metrics: { quality: 1, timeline: 1, communication: 1 }, comment: 'terrible, never worked here at all' };
      const bad = await call('POST', '/reviews', client, { projectId: String(p._id), bidId: String(foreign._id), ...review });
      check('H4 reviewing a contractor via a foreign bidId is refused (403)', bad.status === 403, `http ${bad.status}`);
      const own = await Bid.create({ projectId: p._id, contractorId: contractor._id, bidAmount: 20000, estimatedDays: 4, proposalText: 'own bid', bidFingerprint: 'z', status: 'ACCEPTED' });
      const good = await call('POST', '/reviews', client, { projectId: String(p._id), bidId: String(own._id), rating: 5, metrics: { quality: 5, timeline: 5, communication: 5 }, comment: 'great work, on time and tidy' });
      check('H4 reviewing the hired contractor works (201) and rates THAT contractor', good.status === 201 && String(good.body.data.review.contractorId) === String(contractor._id), `http ${good.status}`);
    }

    // ── G16 (middleware on a tiny app: deterministic 503 then 200) ──────────
    {
      const app = express();
      app.use(express.json());
      const fixed = String(new mongoose.Types.ObjectId()); // one user, so keys are comparable across calls
      app.use((req, _res, next) => { req.user = { userId: fixed }; next(); });
      let hits = 0;
      app.post('/a/:id', enforceIdempotency, (req, res) => { hits += 1; if (hits === 1) return res.status(503).json({ status: 'error', message: 'down' }); return res.status(200).json({ ok: true, id: req.params.id }); });
      app.post('/b', enforceIdempotency, (_req, res) => res.status(200).json({ ok: 'b' }));
      app.post('/conflict', enforceIdempotency, (req, res) => { res.locals.idemRetryable = true; return res.status(409).json({ status: 'error', message: 'try again' }); });
      const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      const u = `http://127.0.0.1:${srv.address().port}`;
      const post = (path, key, body = {}) => fetch(`${u}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': key }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

      const k1 = `g16-${Date.now()}`;
      const first = await post('/a/1', k1);
      const retry = await post('/a/1', k1);
      check('G16 a 503 is not frozen: the retry with the SAME key runs again and succeeds', first.status === 503 && retry.status === 200 && hits === 2, `first ${first.status}, retry ${retry.status}, handler hits ${hits}`);
      const replay = await post('/a/1', k1);
      check('G16 a successful answer is replayed without running the handler again', replay.status === 200 && hits === 2, `replay ${replay.status}, hits ${hits}`);
      const cross = await post('/a/2', k1);
      check('G16 the same key on a DIFFERENT url is refused (409), not replayed', cross.status === 409, `http ${cross.status}`);
      const crossBody = await post('/b', k1);
      check('G16 the same key on a different endpoint is refused (409)', crossBody.status === 409, `http ${crossBody.status}`);
      const k2 = `g16c-${Date.now()}`;
      const c1 = await post('/conflict', k2);
      const row = await IdempotencyKey.findOne({ key: k2 }).lean();
      check('G16 a retryable 409 releases the key (no frozen row)', c1.status === 409 && !row, `row ${row ? 'exists' : 'none'}`);
      const bad1 = await post('/b', 'bad key with spaces!');
      const bad2 = await post('/b', 'x'.repeat(129));
      check('G16 malformed / over-long keys are refused (400)', bad1.status === 400 && bad2.status === 400, `${bad1.status}/${bad2.status}`);
      await new Promise((r) => srv.close(r));
    }

    // ── E7: a server reachable from the network must not start with NODE_ENV unset ────────────────
    {
      const { spawnSync } = require('child_process');
      const env = { ...process.env, NODE_ENV: '', BIND_ADDRESS: '0.0.0.0', PORT: '0', MONGODB_URI: process.env.MONGODB_URI };
      const r = spawnSync(process.execPath, ['-e', "require('./server')"], { cwd: require('path').resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 20000 });
      check('E7 NODE_ENV unset + network bind => server refuses to start (exit 1)', r.status === 1 && /NODE_ENV is not set but BIND_ADDRESS/.test(`${r.stdout}${r.stderr}`), `exit ${r.status}`);
      const okEnv = { ...env, NODE_ENV: 'test', PORT: '0' };
      const hold = spawnSync(process.execPath, ['-e', "const s=require('./server');setTimeout(()=>{s.server.close();process.exit(0)},1500)"], { cwd: require('path').resolve(__dirname, '..'), env: okEnv, encoding: 'utf8', timeout: 20000 });
      check('E7 NODE_ENV set + network bind => server starts normally', hold.status === 0, `exit ${hold.status}`);
      // The explicit mock is still honoured (operator choice) and the environment endpoint tells the UI.
      const keep = { NODE_ENV: process.env.NODE_ENV, MODE: process.env.PAYMENT_GATEWAY_MODE };
      process.env.PAYMENT_GATEWAY_MODE = 'mock';
      const explicit = isMockGateway();
      if (keep.MODE === undefined) delete process.env.PAYMENT_GATEWAY_MODE; else process.env.PAYMENT_GATEWAY_MODE = keep.MODE;
      check('E7 explicit PAYMENT_GATEWAY_MODE=mock is still an operator option', explicit === true);
      const envRes = await call('GET', '/environment', null);
      check('E7 /api/environment reports the payment gateway mode for the UI', envRes.status === 200 && ['mock', 'live'].includes(envRes.body.data.payments.gateway), JSON.stringify(envRes.body && envRes.body.data && envRes.body.data.payments));
    }

    // ── D2 / D3 ─────────────────────────────────────────────────────────────
    {
      const keep = { NODE_ENV: process.env.NODE_ENV, BASE: process.env.BANK_PAYOUT_API_BASE };
      process.env.NODE_ENV = 'production';
      delete process.env.BANK_PAYOUT_API_BASE;
      const unset = bank.isPayoutConfigured();
      process.env.BANK_PAYOUT_API_BASE = 'https://api.mock-bank.com/v1';
      const mock = bank.isPayoutConfigured();
      process.env.BANK_PAYOUT_API_BASE = 'http://bank.example.com/v1';
      const plain = bank.isPayoutConfigured();
      process.env.BANK_PAYOUT_API_BASE = 'https://payouts.realbank.example/v1';
      const real = bank.isPayoutConfigured();
      process.env.NODE_ENV = 'development'; delete process.env.BANK_PAYOUT_API_BASE;
      const dev = bank.isPayoutConfigured();
      if (keep.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = keep.NODE_ENV;
      if (keep.BASE === undefined) delete process.env.BANK_PAYOUT_API_BASE; else process.env.BANK_PAYOUT_API_BASE = keep.BASE;
      check('D2 production: unset / mock / plain-http bank URL = not configured; real https = configured', !unset && !mock && !plain && real, `${unset}/${mock}/${plain}/${real}`);
      check('D2 non-production keeps the dev default', dev === true);
      check('D3 a 409 from the bank is AMBIGUOUS (never auto-refunded)', bank.classifyPayoutError({ response: { status: 409 } }).kind === 'AMBIGUOUS');
      check('D3 a 400/422 from the bank is still a definite failure', bank.classifyPayoutError({ response: { status: 422 } }).kind === 'DEFINITE_FAILURE');
    }

    // ── G8 / G9 ─────────────────────────────────────────────────────────────
    {
      const p = await mkProject(client);
      const led = await mkLedger(client, contractor, p);
      const asClient = await call('GET', `/contracts/by-project/${p._id}`, client);
      const asContractor = await call('GET', `/governance/escrow/${p._id}`, contractor);
      const raw = JSON.stringify([asClient.body, asContractor.body]);
      check('G8 ledger responses carry no gateway session key / transaction ids / val_id / orphan records',
        asClient.status === 200 && asContractor.status === 200 && !/SECRET-SESSION|TRAN-A|val-|orphanPayments|paidByValId/.test(raw), raw.slice(0, 120));
      check('G8 ledger responses expose fundedOnline instead', asClient.body.data.ledger.fundedOnline === true && asContractor.body.data.fundedOnline === true);
      void led;
    }
    {
      const p = await mkProject(client, { status: 'OPEN', awardedContractorId: null });
      await Bid.create({ projectId: p._id, contractorId: contractor._id, bidAmount: 40000, estimatedDays: 7, proposalText: 'bid one', bidFingerprint: 'a1' });
      const r = await call('GET', `/bids/project/${p._id}`, client);
      const b = r.body.bids[0];
      check('G9 before an award the client sees the profile name and a MASKED phone', b.contractorName === 'Alpha Builders' && b.contractorId.phoneNumber === maskPhone(contractor.phoneNumber) && !JSON.stringify(r.body).includes(contractor.phoneNumber), JSON.stringify(b.contractorId));
      await Bid.updateOne({ _id: b._id }, { $set: { status: 'ACCEPTED' } });
      const after = await call('GET', `/bids/project/${p._id}`, client);
      check('G9 after acceptance the real number is shown', after.body.bids[0].contractorId.phoneNumber === contractor.phoneNumber);
    }
    {
      const p = await mkProject(client);
      const led = await mkLedger(client, contractor, p, { ledgerStatus: 'IN_ARBITRATION', milestones: [{ title: 'M', releasePercentage: 100, amount: 20000, status: 'DISPUTED', disputeReason: 'work not done as agreed' }] });
      const t = await DisputeTicket.create({ projectId: p._id, ledgerId: led._id, milestoneIndex: 0, clientId: client._id, contractorId: contractor._id, clientRejectionReason: 'work not done as agreed' });
      const r = await call('GET', `/moderation/dispute/${t._id}`, mod);
      const d = r.body && r.body.dossier;
      check('G8 the moderator dossier shows parties without wallet balances', r.status === 200 && d && !('wallet' in d.clientId) && !('wallet' in d.contractorId));
    }

    // ── JWT algorithm pinning ───────────────────────────────────────────────
    {
      const hs512 = jwt.sign({ userId: String(client._id), role: 'CLIENT', sv: 0 }, process.env.JWT_SECRET, { algorithm: 'HS512', expiresIn: '1h' });
      const r1 = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${hs512}` } });
      const r2 = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${tok(client)}` } });
      check('JWT a token signed with another algorithm (HS512) is refused (401)', r1.status === 401, `http ${r1.status}`);
      check('JWT a normal HS256 session token still works', r2.status === 200);
    }
  } finally {
    // Throwaway local database only (guarded above): clear everything this suite created.
    await Promise.all([User, Project, Bid, EscrowLedger, ContractorProfile, DisputeTicket, IdempotencyKey, require('../models/Message'), require('../models/Review'), require('../models/AuditLog').collection].map((M) => (M.deleteMany ? M.deleteMany({}) : M.deleteMany({})).catch(() => {})));
    await mongoose.disconnect();
    appServer.close();
  }

  if (failed) { console.log(`\n💥 ${failed} check(s) failed`); process.exit(1); }
  console.log('\n✅ audit stage 1 regressions OK');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
