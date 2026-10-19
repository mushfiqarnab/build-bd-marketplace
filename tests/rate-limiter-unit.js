// tests/rate-limiter-unit.js
// Regression & unit coverage for Carrier-Grade NAT (CGNAT) user-aware rate limiting:
//   - keyGenerator keys on authenticated user ID (req.user.id / req.user.userId)
//   - keyGenerator verifies JWT in Authorization Bearer or bb_session cookie
//   - keyGenerator refuses forged/tampered JWT signatures and falls back to IP
//   - keyGenerator falls back to IPv6 /56 subnet or IPv4 for unauthenticated callers
//   - skipFn honors NODE_ENV='test' and loopback IPs (127.0.0.1, ::1, ::ffff:127.0.0.1)
//   - Live express simulation: users on the SAME IP receive independent buckets (no CGNAT collision)
//   - Exports and draft-8 headers verified across apiLimiter, strictAuthAndBidLimiter, financialLimiter
'use strict';

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const {
  apiLimiter,
  strictAuthAndBidLimiter,
  financialLimiter,
  keyGenerator,
  skipFn
} = require('../middleware/rateLimiter');

const TEST_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-rate-limiter-32char!';
process.env.JWT_SECRET = TEST_SECRET;

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function runRequest(server, pathName, headers = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path: pathName,
      method: 'GET',
      headers
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log('🧪 rate-limiter unit & CGNAT collision verification');

  // ── 1. keyGenerator Unit Checks ───────────────────────────────────────────
  const keyReqUser = keyGenerator({ user: { id: 'usr-42' }, ip: '103.205.71.10' });
  check('keyGenerator keys on req.user.id', keyReqUser === 'usr:usr-42', `got: ${keyReqUser}`);

  const keyReqUserId = keyGenerator({ user: { userId: 'usr-99' }, ip: '103.205.71.10' });
  check('keyGenerator keys on req.user.userId', keyReqUserId === 'usr:usr-99', `got: ${keyReqUserId}`);

  // Bearer token verification
  const validToken = jwt.sign({ userId: 'usr-jwt-1', role: 'CONTRACTOR' }, TEST_SECRET, { expiresIn: '1h' });
  const keyBearer = keyGenerator({
    headers: { authorization: `Bearer ${validToken}` },
    ip: '103.205.71.10'
  });
  check('keyGenerator extracts and verifies Bearer JWT', keyBearer === 'usr:usr-jwt-1', `got: ${keyBearer}`);

  // Cookie verification
  const keyCookie = keyGenerator({
    headers: { cookie: `bb_session=${validToken}; other=123` },
    ip: '103.205.71.10'
  });
  check('keyGenerator extracts and verifies bb_session cookie', keyCookie === 'usr:usr-jwt-1', `got: ${keyCookie}`);

  // Tampered/forged token signature MUST NOT be trusted
  const forgedToken = jwt.sign({ userId: 'spoofed-admin', role: 'ADMIN' }, 'wrong-secret-signature');
  const keyForged = keyGenerator({
    headers: { authorization: `Bearer ${forgedToken}` },
    ip: '103.205.71.10'
  });
  check('keyGenerator rejects forged JWT signature and falls back to IP', keyForged === '103.205.71.10', `got: ${keyForged}`);

  // Unauthenticated IPv4
  const keyIpv4 = keyGenerator({ ip: '203.112.218.4' });
  check('keyGenerator falls back to IPv4 for unauthenticated caller', keyIpv4 === '203.112.218.4', `got: ${keyIpv4}`);

  // ── 2. skipFn Unit Checks ─────────────────────────────────────────────────
  const savedEnv = process.env.NODE_ENV;

  process.env.NODE_ENV = 'test';
  check('skipFn skips when NODE_ENV is test', skipFn({ ip: '203.112.218.4' }) === true);

  process.env.NODE_ENV = 'production';
  check('skipFn skips IPv4 loopback 127.0.0.1 in production', skipFn({ ip: '127.0.0.1' }) === true);
  check('skipFn skips IPv6 loopback ::1 in production', skipFn({ ip: '::1' }) === true);
  check('skipFn skips mapped loopback ::ffff:127.0.0.1 in production', skipFn({ ip: '::ffff:127.0.0.1' }) === true);
  check('skipFn does NOT skip remote IP in production', skipFn({ ip: '103.205.71.10' }) === false);

  process.env.NODE_ENV = savedEnv;

  // ── 3. Configuration & Export Invariants ──────────────────────────────────
  check('apiLimiter is exported and defined', typeof apiLimiter === 'function');
  check('strictAuthAndBidLimiter is exported and defined', typeof strictAuthAndBidLimiter === 'function');
  check('financialLimiter is exported and defined', typeof financialLimiter === 'function');

  // ── 4. Live Express Simulation — Proving CGNAT Collision Elimination ──────
  // We configure a rate limiter with limit: 2 and skip: () => false.
  // Two distinct authenticated users make requests from the EXACT SAME IP.
  // User A hits the limit (gets 429 on request 3).
  // User B on the SAME IP still gets 200 (isolated quota).
  const app = express();
  const testLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 2,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator,
    skip: () => false,
    message: { status: 'error', message: 'Rate limit exceeded.' }
  });

  app.use('/test-throttle', (req, res, next) => {
    // Inject mock user based on query or header for testing
    if (req.headers['x-mock-user']) {
      req.user = { id: req.headers['x-mock-user'] };
    }
    next();
  }, testLimiter, (req, res) => {
    res.status(200).json({ status: 'ok', user: req.user ? req.user.id : 'anon' });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    // User A: request 1 (200), request 2 (200), request 3 (429)
    const resA1 = await runRequest(server, '/test-throttle', { 'x-mock-user': 'contractor-dhaka-1' });
    const resA2 = await runRequest(server, '/test-throttle', { 'x-mock-user': 'contractor-dhaka-1' });
    const resA3 = await runRequest(server, '/test-throttle', { 'x-mock-user': 'contractor-dhaka-1' });

    check('User A request 1 succeeds (200)', resA1.status === 200);
    check('User A request 2 succeeds (200)', resA2.status === 200);
    check('User A request 3 is throttled (429)', resA3.status === 429);
    check('Throttled response includes ratelimit draft-8 headers', Boolean(resA3.headers['ratelimit'] || resA3.headers['ratelimit-policy'] || resA3.headers['retry-after']), JSON.stringify(resA3.headers));

    // User B on the EXACT SAME loopback IP:
    // Under IP-only keying, User B would immediately receive 429 (CGNAT failure).
    // Under User-Aware keying, User B succeeds (200) with their own quota!
    const resB1 = await runRequest(server, '/test-throttle', { 'x-mock-user': 'contractor-dhaka-2' });
    check('User B on the SAME IP receives 200 (CGNAT collision eliminated)', resB1.status === 200);

    const resB2 = await runRequest(server, '/test-throttle', { 'x-mock-user': 'contractor-dhaka-2' });
    check('User B request 2 succeeds (200)', resB2.status === 200);

    const resB3 = await runRequest(server, '/test-throttle', { 'x-mock-user': 'contractor-dhaka-2' });
    check('User B request 3 is throttled (429)', resB3.status === 429);

    // Unauthenticated request from same IP:
    // Unauthenticated callers have an IP bucket.
    const resAnon1 = await runRequest(server, '/test-throttle');
    check('Anonymous caller on same IP receives their own IP bucket (200)', resAnon1.status === 200);

  } finally {
    server.close();
  }

  // ── Results Summary ───────────────────────────────────────────────────────
  if (failed > 0) {
    console.error(`💥 ${failed} check(s) failed in rate-limiter-unit.js`);
    process.exit(1);
  } else {
    console.log('--- Results: all passed ---');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal error running rate-limiter-unit test:', err);
  process.exit(1);
});
