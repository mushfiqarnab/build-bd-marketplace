// tests/marketplace-e2e.js
const dns = require('dns');

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (err) {
  console.warn('⚠️ DNS override failed in test suite:', err.message);
}

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

// Boot the real application server on a free port (0) so the suite never
// collides with a running beta on :5000; the URL is resolved once listening.
process.env.PORT = '0';
const { server: appServer } = require('../server');


const User = require('../models/User');
const Project = require('../models/Project');
const Bid = require('../models/Bid');
const EscrowLedger = require('../models/EscrowLedger');
const ContractorProfile = require('../models/ContractorProfile');

let SERVER_URL = null;
async function resolveServerUrl() {
  if (!appServer.listening) await new Promise((r) => appServer.once('listening', r));
  SERVER_URL = `http://127.0.0.1:${appServer.address().port}/api`;
}
const JWT_SECRET = process.env.JWT_SECRET;

const genTestPhone = () => `019${Math.floor(10000000 + Math.random() * 90000000)}`;

async function seedVerifiedProfile(userId, { isProbation = false, canBidAbove = 100000 } = {}) {
  return ContractorProfile.create({
    userId,
    businessType: 'INDIVIDUAL',
    fullName: `Contractor ${String(userId).slice(-4)}`,
    verification: {
      status: 'VERIFIED',
      verificationLevel: 'STANDARD',
      probationStatus: {
        isProbation,
        projectsCompleted: isProbation ? 0 : 3,
        projectsRequired: 3,
        canBidAbove
      }
    },
    availability: { currentProjects: 0, maxConcurrentProjects: 3 }
  });
}

async function runMasterDiagnostics() {
  await resolveServerUrl();
  console.log('🔬 INITIATING V6 MARKETPLACE DIAGNOSTICS (verification + probation + accept)...\n');

  let testClient, testContractorA, testContractorB, testContractorC, testContractorD;
  let projectId, bidIdA, bidIdB;
  let exitCode = 0;

  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('✅ Diagnostic Robot securely connected to MongoDB Atlas.');

    await Project.createCollection();
    await Bid.createCollection();
    await EscrowLedger.createCollection();
    await ContractorProfile.createCollection();

    testClient = await User.create({ phoneNumber: genTestPhone(), role: 'CLIENT', status: 'ACTIVE' });
    testContractorA = await User.create({ phoneNumber: genTestPhone(), role: 'CONTRACTOR', status: 'ACTIVE' });
    testContractorB = await User.create({ phoneNumber: genTestPhone(), role: 'CONTRACTOR', status: 'ACTIVE' });
    testContractorC = await User.create({ phoneNumber: genTestPhone(), role: 'CONTRACTOR', status: 'ACTIVE' });
    testContractorD = await User.create({ phoneNumber: genTestPhone(), role: 'CONTRACTOR', status: 'ACTIVE' });

    // A/B: fully cleared probation (high-value bids allowed)
    await seedVerifiedProfile(testContractorA._id, { isProbation: false });
    await seedVerifiedProfile(testContractorB._id, { isProbation: false });
    // C: no profile → must be rejected
    // D: verified but on probation with 100k cap
    await seedVerifiedProfile(testContractorD._id, { isProbation: true, canBidAbove: 100000 });

    const clientToken = jwt.sign({ userId: testClient._id, role: 'CLIENT' }, JWT_SECRET, { expiresIn: '1h' });
    const contractorAToken = jwt.sign({ userId: testContractorA._id, role: 'CONTRACTOR' }, JWT_SECRET, { expiresIn: '1h' });
    const contractorBToken = jwt.sign({ userId: testContractorB._id, role: 'CONTRACTOR' }, JWT_SECRET, { expiresIn: '1h' });
    const contractorCToken = jwt.sign({ userId: testContractorC._id, role: 'CONTRACTOR' }, JWT_SECRET, { expiresIn: '1h' });
    const contractorDToken = jwt.sign({ userId: testContractorD._id, role: 'CONTRACTOR' }, JWT_SECRET, { expiresIn: '1h' });

    console.log('\n⏳ TEST 1: Client posting project...');
    const projectRes = await fetch(`${SERVER_URL}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clientToken}` },
      body: JSON.stringify({
        title: 'Keraniganj Foundation Pour',
        category: 'Infrastructure',
        description: 'Deep foundation for commercial complex with pile work.',
        location: 'Keraniganj, Dhaka',
        budget: 5000000
      })
    });
    const projectData = await projectRes.json();
    if (projectRes.status !== 201) throw new Error(`Test 1 Failed: ${JSON.stringify(projectData)}`);
    projectId = projectData.project._id;
    console.log('✅ TEST 1 PASSED: Project RFQ created.');

    console.log('\n⏳ TEST 2: Verification + probation + zero-dollar guards...');

    const noProfileRes = await fetch(`${SERVER_URL}/bids/${projectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${contractorCToken}` },
      body: JSON.stringify({ bidAmount: 200000, estimatedDays: 10, proposalText: 'No profile yet.' })
    });
    if (noProfileRes.status !== 403) {
      throw new Error(`Expected 403 for missing profile, got ${noProfileRes.status}`);
    }

    const probationRes = await fetch(`${SERVER_URL}/bids/${projectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${contractorDToken}` },
      body: JSON.stringify({
        bidAmount: 4800000,
        estimatedDays: 30,
        proposalText: 'Probation lowball attempt on high-value job.'
      })
    });
    if (probationRes.status !== 403) {
      throw new Error(`Expected 403 for probation cap breach, got ${probationRes.status}`);
    }

    const probationOkRes = await fetch(`${SERVER_URL}/bids/${projectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${contractorDToken}` },
      body: JSON.stringify({
        bidAmount: 90000,
        estimatedDays: 12,
        proposalText: 'Within probation ceiling for a small scope package.'
      })
    });
    if (probationOkRes.status !== 201) {
      throw new Error(`Probation-allowed bid failed: ${JSON.stringify(await probationOkRes.json())}`);
    }

    const zeroBidRes = await fetch(`${SERVER_URL}/bids/${projectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${contractorAToken}` },
      body: JSON.stringify({ bidAmount: 0, estimatedDays: 10, proposalText: 'I will do it for free!' })
    });
    if (zeroBidRes.status !== 400) {
      throw new Error('System allowed a zero-value bid!');
    }

    // A negative line item can still sum to the bid total; it must be refused
    // at submission, not surface later as a 500 when the client accepts.
    const negativeItemRes = await fetch(`${SERVER_URL}/bids/${projectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${contractorAToken}` },
      body: JSON.stringify({
        bidAmount: 100000, estimatedDays: 20, proposalText: 'Negative line item trick.',
        itemizedBreakdown: [
          { title: 'Foundation', amount: -50000, estimatedDays: 10 },
          { title: 'Structure', amount: 150000, estimatedDays: 10 }
        ]
      })
    });
    if (negativeItemRes.status !== 400) {
      throw new Error(`Negative line item should be 400, got ${negativeItemRes.status}`);
    }

    const bidResA = await fetch(`${SERVER_URL}/bids/${projectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${contractorAToken}` },
      body: JSON.stringify({ bidAmount: 4800000, estimatedDays: 30, proposalText: 'Standard tier verified contractor.' })
    });
    const bidDataA = await bidResA.json();
    if (bidResA.status !== 201 || !bidDataA.bid?.bidFingerprint) {
      throw new Error(`Contractor A bid failed: ${JSON.stringify(bidDataA)}`);
    }
    bidIdA = bidDataA.bid._id;

    const bidResB = await fetch(`${SERVER_URL}/bids/${projectId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${contractorBToken}` },
      body: JSON.stringify({ bidAmount: 4700000, estimatedDays: 25, proposalText: 'Premium tier verified contractor.' })
    });
    const bidDataB = await bidResB.json();
    if (bidResB.status !== 201) throw new Error(`Contractor B bid failed: ${JSON.stringify(bidDataB)}`);
    bidIdB = bidDataB.bid._id;

    console.log('✅ TEST 2 PASSED: Profile/probation/fingerprint/zero-dollar guards hold.');

    console.log('\n⏳ TEST 3: Client bid pagination...');
    const valRes = await fetch(`${SERVER_URL}/bids/project/${projectId}?limit=1&page=1`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${clientToken}` }
    });
    const valData = await valRes.json();
    // 3 bids: D (90k) + A + B
    if (
      valRes.status !== 200 ||
      valData.bids.length !== 1 ||
      valData.metrics.totalBidsReceived !== 3 ||
      valData.metrics.totalPages !== 3
    ) {
      throw new Error(`Pagination anomaly: ${JSON.stringify(valData)}`);
    }
    // Hostile paging params must clamp, never 500 (audit C-9).
    for (const qs of ['page=foo', 'page=-4&limit=1000', 'page=0&limit=abc']) {
      const r = await fetch(`${SERVER_URL}/bids/project/${projectId}?${qs}`, { headers: { Authorization: `Bearer ${clientToken}` } });
      const d = await r.json();
      if (r.status !== 200 || d.metrics.currentPage !== 1) throw new Error(`Paging ${qs} not clamped: ${r.status} ${JSON.stringify(d)}`);
    }
    console.log('✅ TEST 3 PASSED: Pagination metrics correct.');

    console.log('\n⏳ TEST 4: Concurrent accept race...');
    const [res1, res2] = await Promise.all([
      fetch(`${SERVER_URL}/bids/${bidIdA}/accept`, { method: 'PUT', headers: { Authorization: `Bearer ${clientToken}` } }),
      fetch(`${SERVER_URL}/bids/${bidIdB}/accept`, { method: 'PUT', headers: { Authorization: `Bearer ${clientToken}` } })
    ]);
    const body1 = await res1.json();
    const body2 = await res2.json();

    let successCount = 0;
    let lockCount = 0;
    [res1, res2].forEach((res) => {
      if (res.status === 200) successCount++;
      // The race loser must get a clean 409 — never a 500 or a raw Mongo error.
      if (res.status === 409) lockCount++;
    });

    if (successCount !== 1 || lockCount !== 1) {
      throw new Error(`Concurrency breach! Successes: ${successCount}, Locks: ${lockCount}. ${JSON.stringify(body1)} | ${JSON.stringify(body2)}`);
    }
    if (/write conflict|MongoServerError/i.test(JSON.stringify([body1, body2]))) {
      throw new Error('Race loser response leaked a raw database error.');
    }
    console.log('✅ TEST 4 PASSED: CAS + transactional accept held.');

    console.log('\n🏆 ALL V6 MARKETPLACE DIAGNOSTICS PASSED.');
  } catch (error) {
    exitCode = 1;
    console.error(`\n💥 DIAGNOSTIC FAILURE:`, error.message);
  } finally {
    console.log('\n🧹 Initiating automated test data cleanup...');
    const userIds = [testClient, testContractorA, testContractorB, testContractorC, testContractorD]
      .filter(Boolean)
      .map((u) => u._id);
    if (userIds.length) {
      await User.deleteMany({ _id: { $in: userIds } });
      await ContractorProfile.deleteMany({ userId: { $in: userIds } });
    }
    if (projectId) {
      await Project.findByIdAndDelete(projectId);
      await Bid.deleteMany({ projectId });
      await EscrowLedger.deleteMany({ projectId });
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    console.log('✨ Cleanup complete.');
    process.exit(exitCode);
  }
}

runMasterDiagnostics();
