// tests/phase3-hardening-e2e.js
// Regression coverage for the Phase-3 P1 hardening pass:
//   - 6 money endpoints wired through enforceIdempotency
//   - User/Project/Bid/EscrowLedger immutable identity fields
//   - User.toJSON scrub + select:false on secrets
//   - CORS_ORIGIN production assertion in server.js
//   - BIND_ADDRESS loopback default
//   - Socket.io CORS does not fall back to '*' in production
//   - AuditLog HMAC fails at module load in production without a secret
//   - /ipn exempted from financialLimiter in server.js
'use strict';

const path = require('path');
const fs = require('fs');
const dns = require('dns');
const mongoose = require('mongoose');
const { spawnSync } = require('child_process');
require('dotenv').config();

try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (_) {}

const User = require('../models/User');
const Project = require('../models/Project');
const Bid = require('../models/Bid');
const EscrowLedger = require('../models/EscrowLedger');

const ROOT = path.resolve(__dirname, '..');
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function main() {
  console.log('🧪 phase-3 hardening regression suite');

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
    serverSelectionTimeoutMS: 15000
  });
  await User.deleteMany({ phoneNumber: { $regex: /^0199/ } });
  await Project.deleteMany({});
  await Bid.deleteMany({});
  await EscrowLedger.deleteMany({});

  // ── 1. Idempotency middleware applied to the 6 money endpoints ─────────────
  const governanceSrc = fs.readFileSync(path.join(ROOT, 'routes', 'governance.js'), 'utf8');
  const settlementSrc = fs.readFileSync(path.join(ROOT, 'routes', 'settlement.js'), 'utf8');
  const arbitrationSrc = fs.readFileSync(path.join(ROOT, 'routes', 'arbitration.js'), 'utf8');

  // Each check matches the handler signature and asserts enforceIdempotency
  // is in the middleware chain for that specific route.
  function hasIdempotency(src, routePath) {
    const esc = routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`router\\.post\\(\\s*['"]${esc}['"][^]*?enforceIdempotency[^]*?catchAsync\\(|router\\.post\\(\\s*['"]${esc}['"][^]*?enforceIdempotency[^]*?async\\s*\\(`, 'm');
    return re.test(src);
  }
  check('governance /dispute/:ledgerId/milestone/:milestoneIndex uses enforceIdempotency',
    hasIdempotency(governanceSrc, '/dispute/:ledgerId/milestone/:milestoneIndex'));
  check('governance /arbitrate/:ledgerId/milestone/:milestoneIndex uses enforceIdempotency',
    hasIdempotency(governanceSrc, '/arbitrate/:ledgerId/milestone/:milestoneIndex'));
  check('settlement /milestone/:id/approve uses enforceIdempotency',
    hasIdempotency(settlementSrc, '/milestone/:id/approve'));
  check('settlement /milestone/:id/reject uses enforceIdempotency',
    hasIdempotency(settlementSrc, '/milestone/:id/reject'));
  check('settlement /milestone/:id/submit-payment uses enforceIdempotency',
    hasIdempotency(settlementSrc, '/milestone/:id/submit-payment'));
  check('arbitration /dispute/:ticketId/resolve uses enforceIdempotency',
    hasIdempotency(arbitrationSrc, '/dispute/:ticketId/resolve'));

  // ── 2. Immutable identity fields: role, phoneNumber, clientId, etc. ────────
  const u1 = await User.create({ role: 'CLIENT', phoneNumber: '01991130001', status: 'ACTIVE' });
  await User.updateOne({ _id: u1._id }, { $set: { role: 'ADMIN' } });
  const u1Reread = await User.findById(u1._id);
  check('User.role is immutable (role=ADMIN assignment dropped)', u1Reread.role === 'CLIENT',
    `got role=${u1Reread.role}`);

  await User.updateOne({ _id: u1._id }, { $set: { phoneNumber: '01999999999' } });
  const u1Reread2 = await User.findById(u1._id);
  check('User.phoneNumber is immutable', u1Reread2.phoneNumber === '01991130001');

  const u2 = await User.create({ role: 'CONTRACTOR', phoneNumber: '01991130002', status: 'ACTIVE' });
  const u3 = await User.create({ role: 'CONTRACTOR', phoneNumber: '01991130003', status: 'ACTIVE' });
  const proj = await Project.create({
    clientId: u1._id, title: 'Test', category: 'Residential',
    description: 'd', location: 'Dhaka', budget: 100000
  });
  await Project.updateOne({ _id: proj._id }, { $set: { clientId: u2._id } });
  const projReread = await Project.findById(proj._id);
  check('Project.clientId is immutable', projReread.clientId.toString() === u1._id.toString());

  const ledger = await EscrowLedger.create({
    projectId: proj._id, clientId: u1._id, contractorId: u2._id,
    totalContractValue: 50000,
    milestones: [{ title: 'A', releasePercentage: 100, amount: 50000 }]
  });
  await EscrowLedger.updateOne({ _id: ledger._id },
    { $set: { contractorId: u3._id, clientId: u3._id } });
  const ledgerReread = await EscrowLedger.findById(ledger._id);
  check('EscrowLedger.contractorId is immutable',
    ledgerReread.contractorId.toString() === u2._id.toString());
  check('EscrowLedger.clientId is immutable',
    ledgerReread.clientId.toString() === u1._id.toString());

  // Bypass full schema validation (bidFingerprint etc. aren't in scope here);
  // the only invariant under test is that contractorId cannot be reassigned.
  const bidId = new mongoose.Types.ObjectId();
  await Bid.collection.insertOne({
    _id: bidId, projectId: proj._id, contractorId: u2._id,
    bidAmount: 50000, estimatedDays: 30, status: 'PENDING',
    proposalText: 'synthetic', bidFingerprint: 'synthetic-' + Date.now(),
    createdAt: new Date(), updatedAt: new Date()
  });
  await Bid.updateOne({ _id: bidId }, { $set: { contractorId: u3._id } });
  const bidReread = await Bid.findById(bidId);
  check('Bid.contractorId is immutable',
    bidReread.contractorId.toString() === u2._id.toString());

  // ── 3. User PII scrub: select:false + toJSON transform ─────────────────────
  const crypto = require('crypto');
  const sensitivePhone = '01991130099';
  await User.create({
    role: 'CLIENT', phoneNumber: sensitivePhone, status: 'ACTIVE',
    otp: { hash: crypto.randomBytes(8).toString('hex'), expiresAt: new Date(Date.now() + 60000) },
    webAuthnChallenge: 'secret-challenge-value',
    otpVerifiedAt: new Date()
  });
  const defaultProjection = await User.findOne({ phoneNumber: sensitivePhone });
  check('otp.hash absent from default projection',
    !defaultProjection.otp || !defaultProjection.otp.hash);
  check('webAuthnChallenge absent from default projection',
    defaultProjection.webAuthnChallenge === undefined);
  check('otpVerifiedAt absent from default projection',
    defaultProjection.otpVerifiedAt === undefined);

  const withSelect = await User.findOne({ phoneNumber: sensitivePhone })
    .select('+otp.hash +webAuthnChallenge +otpVerifiedAt');
  check('otp.hash reachable via explicit +select',
    withSelect.otp && typeof withSelect.otp.hash === 'string' && withSelect.otp.hash.length > 0);
  check('webAuthnChallenge reachable via explicit +select',
    withSelect.webAuthnChallenge === 'secret-challenge-value');

  const json = JSON.parse(JSON.stringify(withSelect));
  check('toJSON scrubs otp hash from serialised output', !json.otp || !json.otp.hash);
  check('toJSON scrubs webAuthnChallenge from serialised output',
    json.webAuthnChallenge === undefined);
  check('toJSON scrubs otpVerifiedAt from serialised output',
    json.otpVerifiedAt === undefined);
  check('toJSON keeps the phone number and role', json.phoneNumber === sensitivePhone && json.role === 'CLIENT');

  // ── 4. server.js boot-time assertions (source-level) ───────────────────────
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('server.js refuses CORS_ORIGIN="*" in production',
    /NODE_ENV\s*===\s*['"]production['"]/.test(srv) && /CORS_ORIGIN must be set/.test(srv));
  check('server.js defaults BIND_ADDRESS to 127.0.0.1',
    /BIND_ADDRESS\s*=.*127\.0\.0\.1/.test(srv) && /listen\(PORT,\s*BIND_ADDRESS/.test(srv));
  check('server.js shutdown path closes Socket.io before HTTP',
    /io\.close\(/.test(srv) && /server\.close/.test(srv));
  check('server.js exempts /ipn from financialLimiter',
    /financialUnlessIpn/.test(srv) && /req\.path\s*===\s*['"]\/ipn['"]/.test(srv));

  // ── 5. Socket.io CORS does not silently default to '*' in production ──────
  const socketSrc = fs.readFileSync(path.join(ROOT, 'services', 'socketService.js'), 'utf8');
  check('socketService uses CORS_ORIGIN with no silent "*" in production',
    /NODE_ENV\s*===\s*['"]production['"]/.test(socketSrc) && /false/.test(socketSrc));

  // ── 6. AuditLog HMAC fail-closed in production ─────────────────────────────
  // We spawn Node in a sub-process with scrubbed env + NODE_ENV=production
  // and require the AuditLog model. The resolveAuditSalt() throw at module
  // load should surface as a non-zero exit.
  const result = spawnSync(process.execPath, ['-e', 'require("./models/AuditLog")'], {
    cwd: ROOT,
    env: {
      // Keep only PATH-ish essentials so Node still boots, strip every secret.
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      NODE_ENV: 'production',
      MONGODB_URI: '',
      JWT_SECRET: '',
      AUDIT_HMAC_SECRET: ''
    },
    encoding: 'utf8',
    timeout: 10000
  });
  check('AuditLog refuses to load in production without a secret',
    result.status !== 0 && /AUDIT_HMAC_SECRET/.test(result.stderr || ''),
    `status=${result.status} stderr="${(result.stderr || '').slice(0, 200)}"`);

  await mongoose.disconnect();
  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('💥 phase3-hardening crashed:', err);
  process.exit(1);
});
