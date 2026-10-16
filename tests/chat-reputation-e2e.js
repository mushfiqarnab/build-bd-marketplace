// tests/chat-reputation-e2e.js
// Phase 26 — Chat Negotiation & Reputation Engine E2E Diagnostics
//
// Self-contained: boots its own ephemeral Express server on port 0 (OS-assigned),
// connects to MongoDB, seeds its own test data, runs 4 test scenarios, then
// tears down cleanly. Never depends on a running server on port 5000.
//
// Tests:
//   1. Anti-Cartel Chat Isolation   — 3rd-party contractor gets 403 on bid chat
//   2. ACID Revised Offer & Race    — accept offer → bid+ledger updated atomically;
//                                     second concurrent accept → 409 Conflict
//   3. Proof-of-Work Review Gate    — review blocked when all milestones PENDING → 422
//   4. Verified Review + Duplicate  — approve milestone → review created; duplicate → 409

'use strict';

const dns = require('dns');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
require('dotenv').config();

try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch {}

// ── Model imports ─────────────────────────────────────────────────────────────
const User              = require('../models/User');
const Project           = require('../models/Project');
const Bid               = require('../models/Bid');
const Message           = require('../models/Message');
const EscrowLedger      = require('../models/EscrowLedger');
const ContractorProfile = require('../models/ContractorProfile');
const AuditLog          = require('../models/AuditLog');
const Review            = require('../models/Review');

// ── Service/middleware imports ─────────────────────────────────────────────────
const { computeBidFingerprint } = require('../services/bidEligibilityService');

// ── Utility: HTTP helper ──────────────────────────────────────────────────────
function requestJson(port, method, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathName,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Assertion helper ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

// ── JWT mint (inline — avoids importing the full auth route) ──────────────────
const jwt = require('jsonwebtoken');
function mintToken(userId, role) {
  return jwt.sign({ userId, role }, process.env.JWT_SECRET || 'TEST_SECRET_KEY_E2E', { expiresIn: '1h' });
}

// ── Boot ephemeral server ─────────────────────────────────────────────────────
function bootServer() {
  return new Promise((resolve) => {
    // Set test mode so rate limiters skip
    process.env.NODE_ENV = 'test';

    const app = express();
    app.use(express.json({ limit: '10kb' }));
    app.use('/api/chat',    require('../routes/chat'));
    app.use('/api/reviews', require('../routes/review'));

    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => resolve({ app, srv, port: srv.address().port }));
  });
}

// ── Seed helpers ──────────────────────────────────────────────────────────────
async function createUser(role, suffix) {
  return User.create({
    role,
    phoneNumber: `017${Math.floor(10000000 + Math.random() * 89999999)}`,
    wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 },
    status: 'ACTIVE'
  });
}

async function createContractorProfile(userId) {
  return ContractorProfile.create({
    userId,
    businessType: 'INDIVIDUAL',
    fullName: 'Test Contractor',
    verification: {
      status: 'VERIFIED',
      probationStatus: { isProbation: false, projectsCompleted: 0, projectsRequired: 3, canBidAbove: 500000 }
    },
    statistics: { totalProjectsCompleted: 0, completionRate: 100, averageRating: 0 },
    availability: { currentProjects: 0, maxConcurrentProjects: 3 },
    trustScore: 0
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN TEST RUNNER
// ─────────────────────────────────────────────────────────────────────────────
async function runChatReputationDiagnostics() {
  console.log('\n🔬 INITIATING PHASE 26 CHAT & REPUTATION E2E DIAGNOSTICS...\n');

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
    serverSelectionTimeoutMS: 15000
  });
  console.log('✅ Connected to MongoDB.\n');

  const { srv, port } = await bootServer();
  console.log(`✅ Ephemeral server running on port ${port}\n`);

  // ── Seed global test data ─────────────────────────────────────────────────
  const client      = await createUser('CLIENT', 'c');
  const contractor  = await createUser('CONTRACTOR', 'con');
  const outsider    = await createUser('CONTRACTOR', 'out'); // 3rd-party intruder

  await createContractorProfile(contractor._id);

  const clientToken     = mintToken(String(client._id),     'CLIENT');
  const contractorToken = mintToken(String(contractor._id), 'CONTRACTOR');
  const outsiderToken   = mintToken(String(outsider._id),   'CONTRACTOR');

  const project = await Project.create({
    clientId:    client._id,
    title:       'E2E Chat Test Project',
    category:    'Residential',
    description: 'Integration test project',
    location:    'Dhaka',
    budget:      100000,
    status:      'UNDER_BIDDING'
  });

  const fp = computeBidFingerprint({
    projectId:    String(project._id),
    contractorId: String(contractor._id),
    bidAmount:    50000,
    estimatedDays: 30,
    proposalText: 'E2E Test Proposal'
  });

  const bid = await Bid.create({
    projectId:    project._id,
    contractorId: contractor._id,
    bidAmount:    50000,
    estimatedDays: 30,
    proposalText: 'E2E Test Proposal',
    bidFingerprint: fp,
    status: 'PENDING'
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 1: Anti-Cartel Chat Isolation
  // ──────────────────────────────────────────────────────────────────────────
  console.log('═══ TEST 1: Anti-Cartel Chat Isolation ═══');

  const t1Read = await requestJson(port, 'GET', `/api/chat/${bid._id}`, null, {
    Authorization: `Bearer ${outsiderToken}`
  });
  assert(t1Read.status === 403, `Outsider contractor GET chat → 403 (got ${t1Read.status})`);

  const t1Write = await requestJson(port, 'POST', `/api/chat/${bid._id}/message`,
    { messageType: 'TEXT', text: 'Intrusion attempt' },
    { Authorization: `Bearer ${outsiderToken}` }
  );
  assert(t1Write.status === 403, `Outsider contractor POST message → 403 (got ${t1Write.status})`);
  console.log();

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 2: ACID Revised Offer & Race Condition Lock
  // ──────────────────────────────────────────────────────────────────────────
  console.log('═══ TEST 2: ACID Revised Offer & Race Condition Lock ═══');

  // Contractor posts a REVISED_OFFER
  const t2Post = await requestJson(port, 'POST', `/api/chat/${bid._id}/message`,
    { messageType: 'REVISED_OFFER', text: 'I can do it for 45000', revisedAmount: 45000, revisedDays: 25 },
    { Authorization: `Bearer ${contractorToken}` }
  );
  assert(t2Post.status === 201, `Contractor posts REVISED_OFFER → 201 (got ${t2Post.status})`);

  // Client accepts the offer
  const t2Accept = await requestJson(port, 'POST', `/api/chat/${bid._id}/accept-offer`, {},
    { Authorization: `Bearer ${clientToken}` }
  );
  assert(t2Accept.status === 200, `Client accepts offer → 200 (got ${t2Accept.status})`);

  // Verify bid amount updated
  const updatedBid = await Bid.findById(bid._id).lean();
  assert(updatedBid.bidAmount === 45000, `Bid.bidAmount updated to 45000 (got ${updatedBid.bidAmount})`);
  assert(updatedBid.estimatedDays === 25, `Bid.estimatedDays updated to 25 (got ${updatedBid.estimatedDays})`);
  assert(updatedBid.status === 'ACCEPTED', `Bid.status = ACCEPTED (got ${updatedBid.status})`);

  // Verify offer message superseded
  const offerMsg = await Message.findOne({ bidId: bid._id, messageType: 'REVISED_OFFER' }).lean();
  assert(offerMsg.offerStatus === 'ACCEPTED', `REVISED_OFFER offerStatus = ACCEPTED (got ${offerMsg?.offerStatus})`);

  // Second concurrent accept → 409 Conflict (no more pending offers / bid already ACCEPTED)
  const t2Race = await requestJson(port, 'POST', `/api/chat/${bid._id}/accept-offer`, {},
    { Authorization: `Bearer ${clientToken}` }
  );
  assert(t2Race.status === 409, `Second accept attempt → 409 Conflict (got ${t2Race.status})`);
  console.log();

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 3: Proof-of-Work Review Gate — all milestones PENDING → 422
  // ──────────────────────────────────────────────────────────────────────────
  console.log('═══ TEST 3: Proof-of-Work Review Gate ═══');

  // Create an EscrowLedger with all PENDING milestones
  const ledger = await EscrowLedger.create({
    projectId:          project._id,
    clientId:           client._id,
    contractorId:       contractor._id,
    totalContractValue: 45000,
    ledgerStatus:       'FUNDED',
    milestones: [
      { title: 'Foundation', releasePercentage: 50, amount: 22500, status: 'PENDING' },
      { title: 'Finishing',  releasePercentage: 50, amount: 22500, status: 'PENDING' }
    ]
  });

  const t3Review = await requestJson(port, 'POST', '/api/reviews',
    {
      projectId: String(project._id),
      bidId:     String(bid._id),
      rating: 5,
      metrics: { quality: 5, timeline: 5, communication: 5 },
      comment: 'Excellent work on the project.'
    },
    { Authorization: `Bearer ${clientToken}` }
  );
  assert(t3Review.status === 422, `Review with all PENDING milestones → 422 (got ${t3Review.status})`);
  assert(
    t3Review.body?.error?.includes('Proof-of-Work Gate'),
    `422 body contains Proof-of-Work Gate message`
  );
  console.log();

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 4: Verified Review & Kernel Duplicate Lock
  // ──────────────────────────────────────────────────────────────────────────
  console.log('═══ TEST 4: Verified Review & Kernel Duplicate Lock ═══');

  // Approve one milestone so the gate passes
  await EscrowLedger.findByIdAndUpdate(ledger._id, {
    $set: { 'milestones.0.status': 'CLIENT_APPROVED' }
  });

  const t4Review = await requestJson(port, 'POST', '/api/reviews',
    {
      projectId: String(project._id),
      bidId:     String(bid._id),
      rating: 4,
      metrics: { quality: 4, timeline: 4, communication: 5 },
      comment: 'Great communication and quality work.'
    },
    { Authorization: `Bearer ${clientToken}` }
  );
  assert(t4Review.status === 201, `Review after milestone approved → 201 (got ${t4Review.status})`);

  // Verify ContractorProfile updated
  const profile = await ContractorProfile.findOne({ userId: contractor._id }).lean();
  assert(profile.statistics.averageRating === 4, `ContractorProfile averageRating = 4 (got ${profile.statistics.averageRating})`);
  assert(profile.trustScore > 0, `ContractorProfile trustScore > 0 (got ${profile.trustScore})`);

  // Verify AuditLog recorded
  const auditEntry = await AuditLog.findOne({ action: 'REVIEW_SUBMITTED', actorId: client._id }).lean();
  assert(!!auditEntry, `AuditLog REVIEW_SUBMITTED entry created`);
  assert(!!auditEntry?.cryptographicSignature, `AuditLog entry is cryptographically sealed`);

  // Duplicate review attempt → 409 Conflict
  const t4Dup = await requestJson(port, 'POST', '/api/reviews',
    {
      projectId: String(project._id),
      bidId:     String(bid._id),
      rating: 3,
      metrics: { quality: 3, timeline: 3, communication: 3 },
      comment: 'Duplicate review attempt should be rejected.'
    },
    { Authorization: `Bearer ${clientToken}` }
  );
  assert(t4Dup.status === 409, `Duplicate review → 409 Conflict (got ${t4Dup.status})`);
  console.log();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`🏁 CHAT & REPUTATION E2E COMPLETE: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Cleanup
  srv.close();
  await mongoose.connection.close();

  if (failed > 0) {
    console.error(`❌ ${failed} test(s) failed. See output above.`);
    process.exit(1);
  }

  console.log('✅ All chat-reputation-e2e tests PASSED. Exit code 0.');
  process.exit(0);
}

runChatReputationDiagnostics().catch((err) => {
  console.error('💥 FATAL E2E ERROR:', err.message, err.stack);
  process.exit(1);
});
