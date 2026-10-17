// tests/f2-session-auth-e2e.js
// Real middleware, real OTP flow, real cookies — no auth stubs.
//   - verify-otp issues an httpOnly SameSite=Lax session cookie
//   - /api/auth/me works from the cookie; 401 without it
//   - CSRF: cookie-authenticated mutations need X-Requested-With; Bearer doesn't
//   - logout revokes every outstanding token (sessionVersion), not just the cookie
//   - POST /api/projects persists validated site coordinates (BD bounds, swap guard)
//   - GET /api/projects/mine, /api/projects/:id privacy rules, GET /api/bids/mine
'use strict';

const dns = require('dns');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();
try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (_) {}

const User = require('../models/User');
const Project = require('../models/Project');
const Bid = require('../models/Bid');

let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failed += 1; console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`); }
}

function call(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers }
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(d || '{}'); } catch (_) { json = { raw: d }; }
        resolve({ status: res.statusCode, body: json, setCookie: res.headers['set-cookie'] || [] });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const jwt = require('jsonwebtoken');
const mint = (user, sv) => jwt.sign({ userId: String(user._id), role: user.role, sv }, process.env.JWT_SECRET, { expiresIn: 600 });

const cookieFrom = (setCookie) => {
  const c = setCookie.find((s) => s.startsWith('bb_session='));
  return c ? c.split(';')[0] : null;
};

async function login(port, phoneNumber, role) {
  const sent = await call(port, 'POST', '/api/auth/send-otp', { body: { phoneNumber, role } });
  const verified = await call(port, 'POST', '/api/auth/verify-otp', { body: { phoneNumber, otp: sent.body.debugOtp } });
  return { cookie: cookieFrom(verified.setCookie), token: verified.body.token, setCookie: verified.setCookie, status: verified.status };
}

async function main() {
  console.log('🧪 F2 session auth + read endpoints');
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', { serverSelectionTimeoutMS: 15000 });
  await User.deleteMany({ phoneNumber: { $regex: /^0198/ } });

  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/projects', require('../routes/project'));
  app.use('/api/bids', require('../routes/bid'));
  app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ message: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const port = server.address().port;

  // ── Session cookie ─────────────────────────────────────────────────────────
  const owner = await login(port, '01981000001', 'CLIENT');
  const raw = owner.setCookie.find((s) => s.startsWith('bb_session=')) || '';
  check('verify-otp sets the bb_session cookie', owner.status === 200 && !!owner.cookie, raw);
  check('session cookie is HttpOnly and SameSite=Lax', /HttpOnly/i.test(raw) && /SameSite=Lax/i.test(raw), raw);

  const me = await call(port, 'GET', '/api/auth/me', { headers: { Cookie: owner.cookie } });
  check('GET /me works from the cookie alone', me.status === 200 && me.body.user.role === 'CLIENT' && me.body.user.phoneNumber === '01981000001', JSON.stringify(me.body));
  check('GET /me never returns OTP or challenge fields', !('otp' in me.body.user) && !('webAuthnChallenge' in me.body.user));
  const anon = await call(port, 'GET', '/api/auth/me');
  check('GET /me without a session → 401', anon.status === 401);

  // ── CSRF guard ─────────────────────────────────────────────────────────────
  const project = { title: 'Rooftop waterproofing', category: 'Renovation', description: 'Waterproof a 1,200 sqft rooftop in Dhanmondi with membrane.', location: 'Dhaka', budget: 85000.4 };
  const noHeader = await call(port, 'POST', '/api/projects', { body: project, headers: { Cookie: owner.cookie } });
  check('cookie-auth POST without X-Requested-With → 403 (CSRF)', noHeader.status === 403, `${noHeader.status} ${JSON.stringify(noHeader.body)}`);
  const withHeader = await call(port, 'POST', '/api/projects', {
    body: { ...project, siteCoordinates: { latitude: 23.7465, longitude: 90.3760 } },
    headers: { Cookie: owner.cookie, 'X-Requested-With': 'fetch' }
  });
  check('cookie-auth POST with X-Requested-With → 201', withHeader.status === 201, `${withHeader.status} ${JSON.stringify(withHeader.body)}`);
  const created = withHeader.body.project || {};
  check('project persists site coordinates (previously dropped)',
    created.siteCoordinates && created.siteCoordinates.latitude === 23.7465 && created.siteCoordinates.longitude === 90.376, JSON.stringify(created.siteCoordinates));
  check('project budget stored as integer BDT', created.budget === 85000, String(created.budget));
  const bearer = await call(port, 'POST', '/api/projects', { body: { ...project, title: 'Bearer project' }, headers: { Authorization: `Bearer ${owner.token}` } });
  check('Bearer-auth POST needs no CSRF header', bearer.status === 201, String(bearer.status));

  const swapped = await call(port, 'POST', '/api/projects', { body: { ...project, siteCoordinates: { latitude: 90.376, longitude: 23.7465 } }, headers: { Authorization: `Bearer ${owner.token}` } });
  check('swapped lat/lng rejected with a helpful 400', swapped.status === 400 && /swapped/i.test(swapped.body.message || ''), JSON.stringify(swapped.body));
  const half = await call(port, 'POST', '/api/projects', { body: { ...project, siteCoordinates: { latitude: 23.7 } }, headers: { Authorization: `Bearer ${owner.token}` } });
  check('latitude without longitude rejected', half.status === 400);

  // ── GET /mine ──────────────────────────────────────────────────────────────
  const contractor = await login(port, '01981000002', 'CONTRACTOR');
  await Bid.collection.insertOne({
    projectId: new mongoose.Types.ObjectId(created._id), contractorId: new mongoose.Types.ObjectId((await User.findOne({ phoneNumber: '01981000002' }))._id),
    bidAmount: 80000, estimatedDays: 20, status: 'PENDING', proposalText: 'p', bidFingerprint: `f2-${Date.now()}`, createdAt: new Date(), updatedAt: new Date()
  });
  const mine = await call(port, 'GET', '/api/projects/mine', { headers: { Cookie: owner.cookie } });
  const listed = (mine.body.projects || []).find((p) => String(p._id) === String(created._id));
  check('GET /projects/mine lists the owner\'s projects with bidCount', mine.status === 200 && mine.body.metrics.total === 2 && listed && listed.bidCount === 1, JSON.stringify(mine.body.metrics));
  const mineAsContractor = await call(port, 'GET', '/api/projects/mine', { headers: { Cookie: contractor.cookie } });
  check('GET /projects/mine refuses contractors', mineAsContractor.status === 403);

  // ── GET /:id privacy rules ─────────────────────────────────────────────────
  const asOwner = await call(port, 'GET', `/api/projects/${created._id}`, { headers: { Cookie: owner.cookie } });
  check('owner sees exact site coordinates + bidCount', asOwner.status === 200 && asOwner.body.access === 'full' && asOwner.body.project.siteCoordinates.latitude === 23.7465 && asOwner.body.project.bidCount === 1);
  const asBidder = await call(port, 'GET', `/api/projects/${created._id}`, { headers: { Cookie: contractor.cookie } });
  check('bidding contractor sees the OPEN project WITHOUT exact coordinates, with myBid',
    asBidder.status === 200 && asBidder.body.access === 'public' && !('siteCoordinates' in asBidder.body.project) && asBidder.body.project.hasSiteCoordinates === true && asBidder.body.project.myBid.bidAmount === 80000,
    JSON.stringify(asBidder.body.project));
  const otherClient = await login(port, '01981000003', 'CLIENT');
  const asStranger = await call(port, 'GET', `/api/projects/${created._id}`, { headers: { Cookie: otherClient.cookie } });
  check('another client gets 404 (existence not revealed)', asStranger.status === 404);
  await Project.updateOne({ _id: created._id }, { $set: { status: 'ASSIGNED' } });
  // OTP sends are limited to 3 per 15 min per IP (and this suite already used
  // 3), so further sessions are minted directly with the same claims shape.
  const outsiderUser = await User.create({ phoneNumber: '01981000004', role: 'CONTRACTOR', status: 'ACTIVE' });
  const outsiderToken = mint(outsiderUser, 0);
  const asOutsider = await call(port, 'GET', `/api/projects/${created._id}`, { headers: { Authorization: `Bearer ${outsiderToken}` } });
  check('non-bidding contractor gets 404 once the project is no longer OPEN', asOutsider.status === 404);
  const badId = await call(port, 'GET', '/api/projects/not-an-id', { headers: { Cookie: owner.cookie } });
  check('malformed id → 404, not 500', badId.status === 404);

  // ── GET /bids/mine ─────────────────────────────────────────────────────────
  const myBids = await call(port, 'GET', '/api/bids/mine', { headers: { Cookie: contractor.cookie } });
  check('GET /bids/mine returns the contractor\'s bid with its project',
    myBids.status === 200 && myBids.body.bids.length === 1 && myBids.body.bids[0].project.title === 'Rooftop waterproofing' && !('bidFingerprint' in myBids.body.bids[0]),
    JSON.stringify(myBids.body));

  // ── Logout revokes every token ─────────────────────────────────────────────
  const out = await call(port, 'POST', '/api/auth/logout', { headers: { Cookie: owner.cookie, 'X-Requested-With': 'fetch' } });
  const cleared = (out.setCookie.find((s) => s.startsWith('bb_session=')) || '');
  check('logout clears the cookie', out.status === 200 && /bb_session=;/.test(cleared) && /Expires=Thu, 01 Jan 1970/i.test(cleared), cleared);
  const stale = await call(port, 'GET', '/api/auth/me', { headers: { Authorization: `Bearer ${owner.token}` } });
  check('a token issued before logout is rejected (sessionVersion revocation)', stale.status === 401, `${stale.status} ${JSON.stringify(stale.body)}`);
  const ownerUser = await User.findOne({ phoneNumber: '01981000001' }).select('role sessionVersion');
  check('logout bumped the user\'s sessionVersion', ownerUser.sessionVersion === 1, String(ownerUser.sessionVersion));
  const fresh = await call(port, 'GET', '/api/auth/me', { headers: { Authorization: `Bearer ${mint(ownerUser, 1)}` } });
  check('a session carrying the new sessionVersion works after logout', fresh.status === 200, String(fresh.status));

  server.close();
  await mongoose.disconnect();
  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error('💥 f2-session-auth crashed:', err); process.exit(1); });
