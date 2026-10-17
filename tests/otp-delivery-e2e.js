// tests/otp-delivery-e2e.js
// OTP delivery + verification hardening:
//   - production with no channel → 503 and no user written (was: silent "success")
//   - operator relay: code goes to logs/otp-relay.log, never to the HTTP body
//   - BETA_ALLOWED_PHONES invite-only gate (no ghost user for refused numbers)
//   - per-account wrong-code cap voids the code (IP-rotation brute force)
//   - a correct code is single-use even under parallel requests
//   - codes come from a CSPRNG and are stored as an HMAC
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
// Must be set before services/otpDelivery is first required: tests must never
// write fake codes into the operator's real logs/otp-relay.log.
process.env.OTP_RELAY_LOG = path.join(os.tmpdir(), `buildbd-otp-relay-test-${process.pid}.log`);
const http = require('http');
const dns = require('dns');
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();
try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (_) {}

const User = require('../models/User');
const { resolveOtpDelivery, isPhoneAllowed, RELAY_LOG } = require('../services/otpDelivery');

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failed += 1; console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`); }
}

// Fresh router per scenario: the auth rate limiters are module-level, and the
// suite needs more requests than one 15-minute window allows.
async function freshServer() {
  delete require.cache[require.resolve('../routes/auth')];
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use((err, _q, res, _n) => res.status(err.statusCode || 500).json({ message: err.message }));
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

function post(server, p, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: p,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}'), setCookie: res.headers['set-cookie'] || [] }));
    });
    r.on('error', reject); r.end(payload);
  });
}

const lastRelayCodeFor = (phone) => {
  if (!fs.existsSync(RELAY_LOG)) return null;
  const lines = fs.readFileSync(RELAY_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.phone === phone);
  return lines.length ? lines[lines.length - 1].code : null;
};

async function main() {
  console.log('🧪 OTP delivery + verification hardening');
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', { serverSelectionTimeoutMS: 15000 });
  await User.deleteMany({ phoneNumber: { $regex: /^0197/ } });
  const saved = { NODE_ENV: process.env.NODE_ENV, OTP_DELIVERY: process.env.OTP_DELIVERY, BETA_ALLOWED_PHONES: process.env.BETA_ALLOWED_PHONES };
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

  // ── Mode resolution ────────────────────────────────────────────────────────
  check('production + unset → no channel', resolveOtpDelivery({ NODE_ENV: 'production' }) === null);
  check('production + console → refused (would echo codes)', resolveOtpDelivery({ NODE_ENV: 'production', OTP_DELIVERY: 'console' }) === null);
  check('production + operator → operator', resolveOtpDelivery({ NODE_ENV: 'production', OTP_DELIVERY: 'operator' }) === 'operator');
  check('development + unset → console', resolveOtpDelivery({ NODE_ENV: 'development' }) === 'console');
  check('unknown mode → no channel', resolveOtpDelivery({ OTP_DELIVERY: 'pigeon' }) === null);
  check('allowlist: empty allows all; set restricts', isPhoneAllowed('01711111111', {}) && isPhoneAllowed('01711111111', { BETA_ALLOWED_PHONES: '01711111111, 01822222222' }) && !isPhoneAllowed('01933333333', { BETA_ALLOWED_PHONES: '01711111111' }));

  // ── Production with no channel fails closed ───────────────────────────────
  process.env.NODE_ENV = 'production'; delete process.env.OTP_DELIVERY; delete process.env.BETA_ALLOWED_PHONES;
  let s = await freshServer();
  const closed = await post(s, '/api/auth/send-otp', { phoneNumber: '01971000001', role: 'CLIENT' });
  check('production without OTP_DELIVERY → 503', closed.status === 503, `${closed.status} ${JSON.stringify(closed.body)}`);
  check('…and no user was created', !(await User.exists({ phoneNumber: '01971000001' })));
  s.close();

  // ── Operator relay ─────────────────────────────────────────────────────────
  process.env.OTP_DELIVERY = 'operator';
  s = await freshServer();
  const sent = await post(s, '/api/auth/send-otp', { phoneNumber: '01971000002', role: 'CLIENT' });
  const relayed = lastRelayCodeFor('01971000002');
  check('operator mode → 200, delivery=operator', sent.status === 200 && sent.body.delivery === 'operator', JSON.stringify(sent.body));
  check('operator mode never puts the code in the HTTP response', !('debugOtp' in sent.body) && !JSON.stringify(sent.body).includes(relayed || 'x'));
  check('code written to the relay log', /^\d{6}$/.test(relayed || ''), String(relayed));
  const ok = await post(s, '/api/auth/verify-otp', { phoneNumber: '01971000002', otp: relayed });
  check('relayed code logs the user in (cookie issued)', ok.status === 200 && ok.setCookie.some((c) => c.startsWith('bb_session=')), `${ok.status}`);
  const replay = await post(s, '/api/auth/verify-otp', { phoneNumber: '01971000002', otp: relayed });
  check('the same code cannot be used twice', replay.status === 401);
  s.close();

  // ── Invite-only ────────────────────────────────────────────────────────────
  process.env.BETA_ALLOWED_PHONES = '01971000003';
  s = await freshServer();
  const refused = await post(s, '/api/auth/send-otp', { phoneNumber: '01971000009', role: 'CLIENT' });
  check('number not on the beta list → 403', refused.status === 403, JSON.stringify(refused.body));
  check('…and no ghost user created', !(await User.exists({ phoneNumber: '01971000009' })));
  const invited = await post(s, '/api/auth/send-otp', { phoneNumber: '01971000003', role: 'CONTRACTOR' });
  check('invited number → 200', invited.status === 200);
  s.close();
  delete process.env.BETA_ALLOWED_PHONES;

  // ── Brute-force cap (per account, independent of IP) ─────────────────────
  s = await freshServer();
  await post(s, '/api/auth/send-otp', { phoneNumber: '01971000004', role: 'CLIENT' });
  const good = lastRelayCodeFor('01971000004');
  const wrong = good === '000000' ? '111111' : '000000';
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await post(s, '/api/auth/verify-otp', { phoneNumber: '01971000004', otp: wrong })).status);
  check('wrong codes 1-4 → 401, 5th → 429 (code voided)', statuses.slice(0, 4).every((x) => x === 401) && statuses[4] === 429, statuses.join(','));
  s.close();
  s = await freshServer(); // fresh IP-limiter window: only the per-account cap remains
  const afterVoid = await post(s, '/api/auth/verify-otp', { phoneNumber: '01971000004', otp: good });
  check('the correct code no longer works after the cap (requires a new code)', afterVoid.status === 401, `${afterVoid.status} ${JSON.stringify(afterVoid.body)}`);

  // ── Single use under parallel requests ────────────────────────────────────
  await post(s, '/api/auth/send-otp', { phoneNumber: '01971000005', role: 'CLIENT' });
  const pc = lastRelayCodeFor('01971000005');
  const both = await Promise.all([1, 2, 3].map(() => post(s, '/api/auth/verify-otp', { phoneNumber: '01971000005', otp: pc })));
  check('3 parallel submissions of one correct code → exactly one session', both.filter((r) => r.status === 200).length === 1, both.map((r) => r.status).join(','));
  s.close();

  // ── Stored form + RNG ──────────────────────────────────────────────────────
  const stored = await User.findOne({ phoneNumber: '01971000003' }).select('+otp.hash').lean();
  const crypto = require('crypto');
  check('stored hash is not a bare SHA-256 of any 6-digit code', stored.otp.hash.length === 64
    && stored.otp.hash !== crypto.createHash('sha256').update(String(lastRelayCodeFor('01971000003'))).digest('hex'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  check('OTP generated with crypto.randomInt, not Math.random', /crypto\.randomInt\(/.test(src) && !/Math\.random\(\)/.test(src));

  check('test codes went to a temp file, not the operator relay log',
    RELAY_LOG === process.env.OTP_RELAY_LOG && !RELAY_LOG.includes(path.join('logs', 'otp-relay.log')));
  try { fs.unlinkSync(RELAY_LOG); } catch (_) {}

  restore();
  await mongoose.disconnect();
  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('💥 otp-delivery crashed:', err); process.exit(1); });
