// tests/contractor-directory-e2e.js
// GET /api/contractor-profile/directory (+ /:userId): verified-only, privacy-safe, filter-validated.
'use strict';

const dotenv = require('dotenv');
dotenv.config();
process.env.PORT = '0';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

const User = require('../models/User');
const ContractorProfile = require('../models/ContractorProfile');

const PHONE_PREFIX = '0199133';
let seq = 0;
const phone = () => `${PHONE_PREFIX}${String(seq++).padStart(4, '0')}`;
let failed = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failed += 1; console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function main() {
  if (!appServer.listening) await new Promise((r) => appServer.once('listening', r));
  const base = `http://127.0.0.1:${appServer.address().port}/api`;
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('🧪 contractor directory');

  const mk = (role) => User.create({ role, phoneNumber: phone(), status: 'ACTIVE' });
  const [client, v1, v2, unver] = await Promise.all([mk('CLIENT'), mk('CONTRACTOR'), mk('CONTRACTOR'), mk('CONTRACTOR')]);
  const tok = (u) => jwt.sign({ userId: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const get = async (path, user) => {
    const r = await fetch(`${base}${path}`, { headers: user ? { Authorization: `Bearer ${tok(user)}` } : {} });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const ids = [];
  try {
    const mkp = (u, extra) => ContractorProfile.create({ userId: u._id, businessType: 'COMPANY', ...extra });
    const p1 = await mkp(v1, { fullName: 'Rahman Engineering', tradeLicense: 'TL-SECRET-1', contractorTier: 'ENGINEERING_FIRM', workGenres: ['BUILDING_CONSTRUCTION', 'CIVIL_INFRASTRUCTURE'], supportedModalities: ['WITH_MATERIALS'], serviceAreas: [{ district: 'Dhaka', areas: ['Keraniganj'] }], verification: { status: 'VERIFIED', verificationLevel: 'STANDARD' }, statistics: { totalProjectsCompleted: 18, averageRating: 4.9 }, trustScore: 90 });
    const p2 = await mkp(v2, { fullName: 'Karim Mistri Team', contractorTier: 'MISTRI_SARDAR', workGenres: ['RENOVATION_INTERIOR'], supportedModalities: ['LABOUR_ONLY'], serviceAreas: [{ district: 'Cumilla', areas: [] }], verification: { status: 'VERIFIED' }, trustScore: 40 });
    const p3 = await mkp(unver, { fullName: 'Not Yet Verified', workGenres: ['BUILDING_CONSTRUCTION'], serviceAreas: [{ district: 'Dhaka', areas: [] }], verification: { status: 'PENDING' }, trustScore: 99 });
    ids.push(p1._id, p2._id, p3._id);

    check('anonymous request is rejected (401)', (await get('/contractor-profile/directory')).status === 401);

    const all = await get('/contractor-profile/directory', client);
    const names = (all.body?.data?.contractors || []).map((c) => c.fullName);
    check('client sees verified contractors only', all.status === 200 && names.includes('Rahman Engineering') && names.includes('Karim Mistri Team') && !names.includes('Not Yet Verified'), JSON.stringify(names));
    const mine = (all.body?.data?.contractors || []).filter((c) => ['Rahman Engineering', 'Karim Mistri Team'].includes(c.fullName));
    check('best trustScore first', mine[0]?.fullName === 'Rahman Engineering');

    const card = mine.find((c) => c.fullName === 'Rahman Engineering') || {};
    const raw = JSON.stringify(all.body);
    check('no phone number or licence number leaks', !raw.includes(v1.phoneNumber) && !raw.includes('TL-SECRET-1') && card.hasTradeLicense === true);
    check('rating is an integer in milli-stars', card.avgRatingMilli === 4900 && card.completedProjects === 18);
    check('response advertises enabled genres', Array.isArray(all.body?.data?.enabledGenres) && all.body.data.enabledGenres.length >= 1);

    const g = await get('/contractor-profile/directory?workGenre=RENOVATION_INTERIOR', client);
    const gNames = (g.body?.data?.contractors || []).map((c) => c.fullName);
    check('genre filter works', gNames.includes('Karim Mistri Team') && !gNames.includes('Rahman Engineering'));
    const d = await get('/contractor-profile/directory?district=Dhaka&modality=WITH_MATERIALS&tier=ENGINEERING_FIRM', client);
    const dNames = (d.body?.data?.contractors || []).map((c) => c.fullName);
    check('district + modality + tier combine', dNames.includes('Rahman Engineering') && !dNames.includes('Karim Mistri Team') && !dNames.includes('Not Yet Verified'));

    check('unknown genre -> 400', (await get('/contractor-profile/directory?workGenre=NOPE', client)).status === 400);
    check('operator injection in district is not honoured', (await get('/contractor-profile/directory?district[$ne]=x', client)).status === 200
      && !((await get('/contractor-profile/directory?district[$ne]=x', client)).body?.data?.contractors || []).some((c) => c.fullName === 'Not Yet Verified'));
    check('over-long district -> 400', (await get(`/contractor-profile/directory?district=${'x'.repeat(61)}`, client)).status === 400);
    const lim = await get('/contractor-profile/directory?limit=1', client);
    check('limit respected, hasMore set', (lim.body?.data?.contractors || []).length === 1 && lim.body.data.hasMore === true);

    const one = await get(`/contractor-profile/directory/${v1._id}`, client);
    check('single card works for verified', one.status === 200 && one.body?.data?.contractor?.fullName === 'Rahman Engineering');
    check('unverified contractor card is hidden (404)', (await get(`/contractor-profile/directory/${unver._id}`, client)).status === 404);
    check('bad id -> 400', (await get('/contractor-profile/directory/not-an-id', client)).status === 400);

    // Creating a profile validates the new fields and keeps old behaviour.
    const post = (user, body) => fetch(`${base}/contractor-profile`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok(user)}` }, body: JSON.stringify(body) });
    const fresh = await mk('CONTRACTOR');
    const badTier = await post(fresh, { businessType: 'INDIVIDUAL', fullName: 'Fresh Mistri', contractorTier: 'KING' });
    check('invalid tier on create -> 400', badTier.status === 400);
    const ok = await post(fresh, { businessType: 'INDIVIDUAL', fullName: 'Fresh Mistri', contractorTier: 'MISTRI_SARDAR', workGenres: ['BUILDING_CONSTRUCTION', 'JUNK'], supportedModalities: ['LABOUR_ONLY'] });
    const okBody = await ok.json();
    check('create stores valid genres and drops junk', ok.status === 201 && JSON.stringify(okBody.profile.workGenres) === '["BUILDING_CONSTRUCTION"]');
    ids.push(okBody.profile?._id);
    check('new profile is NOT in the directory until verified', !((await get('/contractor-profile/directory?limit=20', client)).body?.data?.contractors || []).some((c) => c.fullName === 'Fresh Mistri'));
  } finally {
    await ContractorProfile.deleteMany({ _id: { $in: ids.filter(Boolean) } });
    await User.deleteMany({ phoneNumber: new RegExp(`^${PHONE_PREFIX}`) });
    await mongoose.disconnect();
    appServer.close();
  }
  if (failed) { console.log(`\n💥 ${failed} check(s) failed`); process.exit(1); }
  console.log('\n✅ contractor directory OK');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
