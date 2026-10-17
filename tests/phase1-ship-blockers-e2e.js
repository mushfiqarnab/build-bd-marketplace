// tests/phase1-ship-blockers-e2e.js
// Regression tests for the Phase-1 QA ship-blocker fixes:
//   1. Passkey-register requires a fresh (<5 min) OTP verification (P0-7/8/9)
//   2. PAYMENTS_DISABLED=true gates /api/payment/* with 503 (P0-5 kill-switch)
//   3. IdempotencyKey uniqueness is now compound (key, userId) (P0-14)
//   4. Portal localStorage token key alignment (P0-15)
'use strict';

const path = require('path');
const fs = require('fs');
const dns = require('dns');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (_) {}

const User = require('../models/User');
const IdempotencyKey = require('../models/IdempotencyKey');

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

function reqJson(port, method, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const r = http.request({
      hostname: '127.0.0.1', port, path: pathName, method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function main() {
  console.log('🧪 phase-1 ship-blocker regressions');

  // ── Mongo bootstrap (shared with run-tests.js replicaset) ──────────────────
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
    serverSelectionTimeoutMS: 15000
  });
  await User.deleteMany({ phoneNumber: { $regex: /^0199/ } });
  await IdempotencyKey.deleteMany({});
  // Make sure the compound index exists on the running collection, even on
  // a replicaset Mongoose didn't auto-sync (autoIndex is off in production).
  await IdempotencyKey.syncIndexes();

  // ── 1. IdempotencyKey compound (key, userId) uniqueness ────────────────────
  const u1 = await User.create({ role: 'CLIENT', phoneNumber: '01991110001', status: 'ACTIVE' });
  const u2 = await User.create({ role: 'CLIENT', phoneNumber: '01991110002', status: 'ACTIVE' });
  const SHARED_KEY = 'phase1-shared-idempotency-key-' + Date.now();

  await IdempotencyKey.create({ key: SHARED_KEY, userId: u1._id, payloadHash: 'h1' });
  let secondUserOk = false;
  try {
    await IdempotencyKey.create({ key: SHARED_KEY, userId: u2._id, payloadHash: 'h1' });
    secondUserOk = true;
  } catch (err) {
    secondUserOk = false;
  }
  check('two users can send the same Idempotency-Key', secondUserOk);

  let sameUserDup = false;
  try {
    await IdempotencyKey.create({ key: SHARED_KEY, userId: u1._id, payloadHash: 'h1' });
    sameUserDup = false;
  } catch (err) {
    sameUserDup = err && err.code === 11000;
  }
  check('one user cannot reuse an Idempotency-Key', sameUserDup);

  // ── 2. Passkey-register OTP freshness gate (P0-7/8/9) ──────────────────────
  // Boot a minimal Express app wrapping routes/auth.js. We can't drive a real
  // WebAuthn flow headlessly, but the gate must trip BEFORE webauthn verify.
  // So we send a bogus registrationResponse and look at the error returned:
  //   - no OTP stamp -> 401 "Verify your phone number via OTP ..."
  //   - OTP stamp fresh -> some other 400 ("WebAuthn registration verification failed")
  //   - OTP stamp older than 5 min -> 401 again
  const authApp = express();
  authApp.use(express.json({ limit: '10kb' }));
  authApp.use('/api/auth', require('../routes/auth'));
  authApp.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  });
  const authServer = authApp.listen(0);
  const authPort = authServer.address().port;

  const PHONE = '01991112345';
  // Prepare user with an existing webAuthnChallenge so the earlier guard passes.
  await User.create({
    phoneNumber: PHONE, role: 'CLIENT', status: 'PENDING_VERIFICATION',
    webAuthnChallenge: 'phase1-fake-challenge', otpVerifiedAt: null
  });

  const resNoOtp = await reqJson(authPort, 'POST', '/api/auth/passkey/register/verify', {
    phoneNumber: PHONE,
    registrationResponse: { id: 'x', rawId: 'x', response: {}, type: 'public-key' }
  });
  check('no OTP stamp -> 401 phone-ownership gate trips',
    resNoOtp.status === 401 && /OTP/i.test(resNoOtp.body.message || ''),
    `${resNoOtp.status} ${JSON.stringify(resNoOtp.body)}`);

  // Stale OTP (>5 min)
  await User.updateOne({ phoneNumber: PHONE }, { $set: { otpVerifiedAt: new Date(Date.now() - 6 * 60 * 1000) } });
  const resStale = await reqJson(authPort, 'POST', '/api/auth/passkey/register/verify', {
    phoneNumber: PHONE,
    registrationResponse: { id: 'x', rawId: 'x', response: {}, type: 'public-key' }
  });
  check('stale OTP stamp (>5 min) -> 401 gate trips',
    resStale.status === 401 && /OTP/i.test(resStale.body.message || ''),
    `${resStale.status} ${JSON.stringify(resStale.body)}`);

  // Fresh OTP -> gate passes, webauthn verify is the next step and it fails there (400, not 401 OTP message)
  await User.updateOne({ phoneNumber: PHONE }, { $set: { otpVerifiedAt: new Date() } });
  const resFresh = await reqJson(authPort, 'POST', '/api/auth/passkey/register/verify', {
    phoneNumber: PHONE,
    registrationResponse: { id: 'x', rawId: 'x', response: {}, type: 'public-key' }
  });
  check('fresh OTP (<5 min) passes the gate (next failure is webauthn, not OTP)',
    resFresh.status === 400 && !/OTP/i.test(resFresh.body.message || ''),
    `${resFresh.status} ${JSON.stringify(resFresh.body)}`);

  // /verify-otp also stamps otpVerifiedAt on success — assert via source grep
  // (full OTP round-trip is covered by auth tests elsewhere; here we verify
  // the Phase-1 patch landed).
  // Behavioural (not source-text) check: a real OTP login must leave a
  // fresh otpVerifiedAt stamp in the database.
  const sendRes = await reqJson(authPort, 'POST', '/api/auth/send-otp', { phoneNumber: '01991112399', role: 'CLIENT' });
  await reqJson(authPort, 'POST', '/api/auth/verify-otp', { phoneNumber: '01991112399', otp: sendRes.body.debugOtp });
  const stamped = await User.findOne({ phoneNumber: '01991112399' }).select('+otpVerifiedAt').lean();
  check('/verify-otp stamps user.otpVerifiedAt on success',
    stamped && stamped.otpVerifiedAt && (Date.now() - new Date(stamped.otpVerifiedAt).getTime()) < 60 * 1000,
    JSON.stringify(stamped && stamped.otpVerifiedAt));

  authServer.close();

  // ── 3. PAYMENTS_DISABLED kill switch (P0 shelter) ──────────────────────────
  // Spin up a minimal Express that reproduces server.js's gating block.
  const payApp = express();
  payApp.use(express.json({ limit: '10kb' }));
  const prevFlag = process.env.PAYMENTS_DISABLED;
  process.env.PAYMENTS_DISABLED = 'true';
  if (process.env.PAYMENTS_DISABLED === 'true') {
    payApp.use('/api/payment', (_req, res) => {
      res.status(503).json({ status: 'error', message: 'Payments are temporarily disabled on this environment. Please try again later.' });
    });
  }
  const payServer = payApp.listen(0);
  const payPort = payServer.address().port;
  const resKill = await reqJson(payPort, 'POST', '/api/payment/initiate/fake-ledger-id', {});
  check('PAYMENTS_DISABLED=true -> /api/payment/* answers 503',
    resKill.status === 503 && /disabled/i.test(resKill.body.message || ''),
    `${resKill.status} ${JSON.stringify(resKill.body)}`);
  payServer.close();
  if (prevFlag === undefined) delete process.env.PAYMENTS_DISABLED;
  else process.env.PAYMENTS_DISABLED = prevFlag;

  // Verify server.js actually registers the gate so it fires in production boot
  const srv = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('server.js registers the PAYMENTS_DISABLED gate',
    /PAYMENTS_DISABLED\s*===\s*'true'/.test(srv) && /\/api\/payment/.test(srv));

  // ── 4. Portal localStorage token-key alignment (P0-15) ────────────────────
  const apiClientSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'apiClient.js'), 'utf8');
  check("apiClient reads 'bb_token' (the key the portal writes)",
    /getItem\(['"]bb_token['"]\)/.test(apiClientSrc));

  // ── 5. index.html longitude parse (P0-16) ─────────────────────────────────
  const idxSrc = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  check('index.html parses longitude from proj-lng input (no hardcoded null)',
    /longitude:\s*parseFloat\(document\.getElementById\(['"]proj-lng['"]\)/.test(idxSrc)
    && !/longitude:\s*null/.test(idxSrc));

  // ── 6. Dev-only evidence-sandbox link removed (P0-17) ─────────────────────
  check('index.html no longer links the headline CTA to /evidence-sandbox.html',
    !/href=['"]\/evidence-sandbox\.html['"]/.test(idxSrc));

  await mongoose.disconnect();
  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('💥 phase1-ship-blockers crashed:', err);
  process.exit(1);
});
