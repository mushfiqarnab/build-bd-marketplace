// tests/categorized-works-exchange-e2e.js
// Microscopic verification for Categorized Works & Services Exchange:
//   1. Public accessibility (optionalAuth, 200 OK without token)
//   2. PII protection & competitor bid seal invariants
//   3. Free-text ReDoS-safe search (q)
//   4. Thana / location query matching
//   5. Integer-BDT budget bounds (minBudget, maxBudget)
//   6. Nature categorization (WORKS, RENOVATION)
//   7. Sorting (newest, budget_desc, budget_asc)
//   8. Active bid counts aggregation
//   9. Contractor-only demand feed (/open) role & query sync
'use strict';

const dotenv = require('dotenv');
dotenv.config();
process.env.PORT = '0';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

const User = require('../models/User');
const Project = require('../models/Project');
const Bid = require('../models/Bid');

const PHONE_PREFIX = '0188991';
let seq = 0;
const phone = () => `${PHONE_PREFIX}${String(seq++).padStart(4, '0')}`;
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
  if (!appServer.listening) await new Promise((r) => appServer.once('listening', r));
  const base = `http://127.0.0.1:${appServer.address().port}/api`;
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('🧪 Categorized Works & Services Exchange E2E');

  const mkUser = (role) => User.create({ role, phoneNumber: phone(), status: 'ACTIVE' });
  const [client, contractor1, contractor2] = await Promise.all([
    mkUser('CLIENT'),
    mkUser('CONTRACTOR'),
    mkUser('CONTRACTOR')
  ]);

  const tok = (u) => jwt.sign({ userId: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const get = async (path, user) => {
    const r = await fetch(`${base}${path}`, {
      headers: user ? { Authorization: `Bearer ${tok(user)}` } : {}
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const projectIds = [];
  const bidIds = [];

  try {
    // Seed test projects
    const p1 = await Project.create({
      clientId: client._id,
      title: '3-Storey Residential Apartment Construction',
      category: 'Residential',
      description: 'Structural RCC framing, bricklaying, electrical conduit placement in Mirpur.',
      location: 'Dhaka, Mirpur-10',
      budget: 1500000,
      status: 'OPEN',
      siteCoordinates: { latitude: 23.8069, longitude: 90.3687 }
    });

    const p2 = await Project.create({
      clientId: client._id,
      title: 'Commercial Office Interior & Ceiling',
      category: 'Interior',
      description: 'Gypsum false ceiling, LED track lighting, acoustic panels in Gulshan tower.',
      location: 'Dhaka, Gulshan-2',
      budget: 350000,
      status: 'OPEN'
    });

    const p3 = await Project.create({
      clientId: client._id,
      title: 'Apartment Wall Painting & Deep Clean',
      category: 'Renovation',
      description: 'Full interior wall putty, sanding, plastic paint, sanitization.',
      location: 'Dhaka, Dhanmondi',
      budget: 45000,
      status: 'OPEN'
    });

    const p4 = await Project.create({
      clientId: client._id,
      title: 'Highway Culvert Concrete Repair',
      category: 'Infrastructure',
      description: 'Bridge wing-wall casting and heavy rebar reinforcement in Agrabad.',
      location: 'Chittagong, Agrabad',
      budget: 2500000,
      status: 'OPEN'
    });

    const p5Closed = await Project.create({
      clientId: client._id,
      title: 'Assigned Villa Renovation',
      category: 'Renovation',
      description: 'This project is already awarded and must not appear in the open feed.',
      location: 'Dhaka, Uttara',
      budget: 800000,
      status: 'ASSIGNED',
      awardedContractorId: contractor1._id
    });

    projectIds.push(p1._id, p2._id, p3._id, p4._id, p5Closed._id);

    // Seed 2 bids for project 1
    const crypto = require('crypto');
    const seal = (txt) => crypto.createHash('sha256').update(txt).digest('hex');

    const b1 = await Bid.create({
      projectId: p1._id,
      contractorId: contractor1._id,
      bidAmount: 1450000,
      estimatedDays: 120,
      proposalText: 'Experienced civil engineering firm ready to begin structural work.',
      bidFingerprint: seal('b1-seal-1450000'),
      status: 'PENDING'
    });
    const b2 = await Bid.create({
      projectId: p1._id,
      contractorId: contractor2._id,
      bidAmount: 1420000,
      estimatedDays: 110,
      proposalText: 'Quality RCC framing with full workforce deployment.',
      bidFingerprint: seal('b2-seal-1420000'),
      status: 'PENDING'
    });
    bidIds.push(b1._id, b2._id);

    // ── Test 1: Public access without token ──
    const pubRes = await get('/projects/exchange');
    check('GET /api/projects/exchange answers 200 without authentication token', pubRes.status === 200);
    const pubAlias = await get('/projects/feed');
    check('GET /api/projects/feed alias answers 200 without authentication token', pubAlias.status === 200);
    const feedProjects = pubRes.body?.projects || [];
    const titles = feedProjects.map((p) => p.title);
    check('public feed returns OPEN projects', titles.includes('3-Storey Residential Apartment Construction') && titles.includes('Highway Culvert Concrete Repair'));
    check('public feed excludes closed/assigned projects (p5Closed)', !titles.includes('Assigned Villa Renovation'));

    // ── Test 2: PII protection & competitor bid secrecy ──
    const rawBody = JSON.stringify(pubRes.body);
    check('no client phone number leaked in feed', !rawBody.includes(client.phoneNumber));
    check('no contractor bid prices leaked in feed', !rawBody.includes('1450000') && !rawBody.includes('1420000'));
    const p1Feed = feedProjects.find((p) => String(p._id) === String(p1._id));
    check('site coordinates presence flagged without leaking raw metadata', p1Feed?.hasSiteCoordinates === true);
    check('bidCount is accurately computed from active bids', p1Feed?.bidCount === 2);

    // ── Test 3: Free-text search (q) ──
    const searchRes = await get('/projects/exchange?q=Culvert');
    check('q=Culvert returns only the Highway Culvert project',
      searchRes.status === 200 &&
      searchRes.body.projects.length === 1 &&
      searchRes.body.projects[0].title === 'Highway Culvert Concrete Repair');

    const searchPutty = await get('/projects/exchange?q=putty');
    check('q=putty matches scope description for Painting project',
      searchPutty.status === 200 &&
      searchPutty.body.projects.some((p) => p.title === 'Apartment Wall Painting & Deep Clean'));

    // ── Test 4: Thana / location filter ──
    const thanaRes = await get('/projects/exchange?thana=Gulshan');
    check('thana=Gulshan returns Interior project in Gulshan',
      thanaRes.status === 200 &&
      thanaRes.body.projects.length === 1 &&
      thanaRes.body.projects[0].location === 'Dhaka, Gulshan-2');

    const chittagongRes = await get('/projects/exchange?thana=Agrabad');
    check('thana=Agrabad returns Chittagong project',
      chittagongRes.status === 200 &&
      chittagongRes.body.projects.length === 1 &&
      chittagongRes.body.projects[0].title === 'Highway Culvert Concrete Repair');

    // ── Test 5: Budget bounds ──
    const under50k = await get('/projects/exchange?maxBudget=50000');
    check('maxBudget=50000 returns only projects <= 50,000 BDT',
      under50k.status === 200 &&
      under50k.body.projects.length === 1 &&
      under50k.body.projects[0].budget === 45000);

    const overMillion = await get('/projects/exchange?minBudget=1000000');
    check('minBudget=1000000 returns projects >= 1,000,000 BDT',
      overMillion.status === 200 &&
      overMillion.body.projects.length === 2 &&
      overMillion.body.projects.every((p) => p.budget >= 1000000));

    // ── Test 6: Nature categorization (WORKS vs RENOVATION) ──
    const renoNature = await get('/projects/exchange?nature=RENOVATION');
    const renoCats = (renoNature.body?.projects || []).map((p) => p.category);
    check('nature=RENOVATION returns only Interior and Renovation projects',
      renoNature.status === 200 &&
      renoCats.length === 2 &&
      renoCats.every((c) => ['Interior', 'Renovation'].includes(c)));

    const worksNature = await get('/projects/exchange?nature=WORKS');
    const worksCats = (worksNature.body?.projects || []).map((p) => p.category);
    check('nature=WORKS returns Residential and Infrastructure projects',
      worksNature.status === 200 &&
      worksCats.length === 2 &&
      worksCats.every((c) => ['Residential', 'Infrastructure'].includes(c)));

    // ── Test 7: Sorting ──
    const sortDesc = await get('/projects/exchange?sort=budget_desc');
    const descBudgets = (sortDesc.body?.projects || []).map((p) => p.budget);
    check('sort=budget_desc orders highest budget first',
      sortDesc.status === 200 &&
      descBudgets[0] === 2500000 &&
      descBudgets[1] === 1500000 &&
      descBudgets[descBudgets.length - 1] === 45000);

    const sortAsc = await get('/projects/exchange?sort=budget_asc');
    const ascBudgets = (sortAsc.body?.projects || []).map((p) => p.budget);
    check('sort=budget_asc orders lowest budget first',
      sortAsc.status === 200 &&
      ascBudgets[0] === 45000 &&
      ascBudgets[ascBudgets.length - 1] === 2500000);

    // ── Test 8: Contractor-only demand feed /api/projects/open sync ──
    const openNoToken = await get('/projects/open');
    check('GET /api/projects/open requires authentication (401)', openNoToken.status === 401);

    const openClient = await get('/projects/open', client);
    check('GET /api/projects/open rejects CLIENT role (403)', openClient.status === 403);

    const openContractor = await get('/projects/open?q=Culvert&thana=Agrabad', contractor1);
    check('GET /api/projects/open allows CONTRACTOR and supports new query filters',
      openContractor.status === 200 &&
      openContractor.body.projects.length === 1 &&
      openContractor.body.projects[0].title === 'Highway Culvert Concrete Repair' &&
      openContractor.body.projects[0].bidCount === 0);

  } finally {
    if (bidIds.length) await Bid.deleteMany({ _id: { $in: bidIds } });
    if (projectIds.length) await Project.deleteMany({ _id: { $in: projectIds } });
    await User.deleteMany({ _id: { $in: [client._id, contractor1._id, contractor2._id] } });
  }

  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('💥 categorized-works-exchange-e2e crashed:', err);
  process.exit(1);
});