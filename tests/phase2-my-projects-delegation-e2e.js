// tests/phase2-my-projects-delegation.test.js
// End-to-end verification of Phase 2: Probashi Mode & Family Delegation
//   - GET /api/projects/my-projects (Aggregated governance overview, financials, bid/milestone queues)
//   - POST /api/projects/:id/shares (Cryptographic 32-byte token generation, SHA-256 hash storage)
//   - GET /api/projects/:id/shares (List delegation shares, audit log verification)
//   - DELETE /api/projects/:id/shares/:shareId (Revocation)
//   - GET /api/projects/shared/:rawToken (Public delegate view with hideFinancials scrubbing)
//   - Scoped Role Boundary Enforcement: SITE_WATCHER / FAMILY_VIEWER cannot release funds
'use strict';

const dotenv = require('dotenv');
dotenv.config();
process.env.PORT = '0';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32chars-minimum-safe';
process.env.TREASURY_PHONE = process.env.TREASURY_PHONE || '01700000000';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { server: appServer } = require('../server');

const User = require('../models/User');
const Project = require('../models/Project');
const EscrowLedger = require('../models/EscrowLedger');
const Bid = require('../models/Bid');
const ProjectShareToken = require('../models/ProjectShareToken');
const MaterialOrder = require('../models/MaterialOrder');
const AuditLog = require('../models/AuditLog');

const PHONE_PREFIX = '0188776';
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
  if (!appServer.listening) {
    await new Promise((resolve) => appServer.on('listening', resolve));
  }
  const port = appServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI);
  }

  console.log('\n🇧🇩 PHASE 2: PROBASHI MODE & FAMILY DELEGATION E2E TEST');

  // Seed Users: Probashi Client, Domestic Stranger Client, Contractor
  const probashiPhone = phone();
  const strangerPhone = phone();
  const contractorPhone = phone();

  const [probashi, stranger, contractor] = await Promise.all([
    User.create({ phoneNumber: probashiPhone, role: 'CLIENT', status: 'ACTIVE' }),
    User.create({ phoneNumber: strangerPhone, role: 'CLIENT', status: 'ACTIVE' }),
    User.create({ phoneNumber: contractorPhone, role: 'CONTRACTOR', status: 'ACTIVE' })
  ]);

  const probashiToken = jwt.sign({ userId: String(probashi._id), role: 'CLIENT' }, process.env.JWT_SECRET);
  const strangerToken = jwt.sign({ userId: String(stranger._id), role: 'CLIENT' }, process.env.JWT_SECRET);
  const contractorToken = jwt.sign({ userId: String(contractor._id), role: 'CONTRACTOR' }, process.env.JWT_SECRET);

  // Seed 2 Projects for Probashi Client:
  // Project 1: Active Villa under construction with EscrowLedger
  const villa = await Project.create({
    clientId: probashi._id,
    title: 'Modern Villa in Sylhet (Probashi Home)',
    category: 'Residential',
    description: 'Two-story luxury duplex with RCC roof casting in Osmani Nagar.',
    location: 'Sylhet',
    budget: 3500000,
    status: 'ASSIGNED',
    awardedContractorId: contractor._id,
    siteCoordinates: { latitude: 24.8949, longitude: 91.8687 }
  });

  // Seed EscrowLedger for Villa (Total 35 Lakh: M0 14L @ 40%, M1 21L @ 60%)
  const villaLedger = await EscrowLedger.create({
    projectId: villa._id,
    clientId: probashi._id,
    contractorId: contractor._id,
    totalContractValue: 3500000,
    ledgerStatus: 'PARTIALLY_DISBURSED',
    milestones: [
      {
        index: 0,
        title: 'Foundation & Piling RCC',
        amount: 1400000,
        releasePercentage: 40,
        payoutBDT: 1330000,
        platformFeeBDT: 70000,
        status: 'COMPLETED',
        evidenceLog: [
          {
            s3Key: 'evidence/villa-foundation.jpg',
            imageHash: 'a'.repeat(64),
            verificationTier: 'CRYPTOGRAPHIC_PROOF',
            submittedAt: new Date(Date.now() - 5 * 86400000),
            capturedAt: new Date(Date.now() - 5 * 86400000),
            exifVerified: true,
            gpsVerified: true
          }
        ]
      },
      {
        index: 1,
        title: 'First Floor Slab & Column Casting',
        amount: 2100000,
        releasePercentage: 60,
        payoutBDT: 1995000,
        platformFeeBDT: 105000,
        status: 'PROOF_SUBMITTED',
        evidenceLog: [
          {
            s3Key: 'evidence/villa-slab.jpg',
            imageHash: 'b'.repeat(64),
            verificationTier: 'CRYPTOGRAPHIC_PROOF',
            submittedAt: new Date(),
            capturedAt: new Date(),
            exifVerified: true,
            gpsVerified: true
          }
        ]
      }
    ]
  });

  // Seed Material Order for Villa with variance report
  const villaOrder = await MaterialOrder.create({
    orderNumber: 'ORD-SYL-VILLA-001',
    buyerUserId: probashi._id,
    buyerRole: 'CLIENT',
    supplierId: new mongoose.Types.ObjectId(),
    supplierUserId: new mongoose.Types.ObjectId(),
    projectId: villa._id,
    milestoneIndex: 1,
    plannedBrand: 'BSRM',
    plannedQuantity: 4,
    items: [{
      productId: new mongoose.Types.ObjectId(),
      category: 'ROD',
      title: 'AKS 500W Rebar 12mm',
      brand: 'AKS',
      unit: 'TON',
      quantity: 5,
      unitPriceBDT: 95000,
      totalPriceBDT: 475000,
      boqLineItem: 'Column & Beam Reinforcement',
      plannedBrand: 'BSRM',
      plannedQuantity: 4
    }],
    itemsSubtotalBDT: 475000,
    deliveryFeeBDT: 8000,
    platformFeeBDT: 9500,
    totalAmountBDT: 492500,
    status: 'DELIVERED',
    deliveryDetails: {
      deliveryDistrict: 'Sylhet',
      deliveryAddress: 'Osmani Nagar, Sylhet',
      receiverName: 'Kashem Sardar',
      receiverPhone: '01711223344'
    },
    varianceReport: {
      hasVariance: true,
      varianceTypes: ['BRAND_DIFFERENCE'],
      varianceDetails: 'Ordered BSRM 500W, delivered AKS 500W',
      acknowledgedByClient: false
    }
  });

  // Project 2: Commercial Office in Dhaka (Open for bidding)
  const office = await Project.create({
    clientId: probashi._id,
    title: 'Banani Commercial Office Renovation',
    category: 'Commercial',
    description: 'Interior renovation and electrical wiring for commercial space.',
    location: 'Dhaka',
    budget: 800000,
    status: 'OPEN'
  });

  // Seed a pending bid on Project 2
  await Bid.create({
    projectId: office._id,
    contractorId: contractor._id,
    bidAmount: 780000,
    estimatedDays: 45,
    status: 'PENDING',
    proposalText: 'Full turnkey execution by licensed civil engineers.',
    bidFingerprint: 'fp-banani-123',
    cryptographicProof: { signature: 'sig-123', timestamp: new Date() }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 1: GET /api/projects/my-projects overview & aggregations
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 1. Probashi Multi-Project Dashboard (GET /api/projects/my-projects) ---');
  const res1 = await fetch(`${baseUrl}/api/projects/my-projects`, {
    headers: { authorization: `Bearer ${probashiToken}` }
  });
  check('my-projects returns 200 OK', res1.status === 200);
  const data1 = await res1.json();
  check('my-projects has status=success', data1.status === 'success');
  check('my-projects summary has totalProjectsCount=2', data1.summary?.totalProjectsCount === 2);
  check('my-projects summary has activeContractsCount=1', data1.summary?.activeContractsCount === 1);
  check('my-projects summary has totalCommittedBDT=3500000', data1.summary?.totalCommittedBDT === 3500000);
  check('my-projects summary has totalReleasedBDT=1400000', data1.summary?.totalReleasedBDT === 1400000);
  // Pending actions: 1 unreviewed bid (office) + 1 pending proof (villa M1) + 1 unacknowledged variance (villa rod) = 3
  check('my-projects summary pendingActionsCount=3', data1.summary?.pendingActionsCount === 3, `got ${data1.summary?.pendingActionsCount}`);

  const villaCard = data1.projects.find((p) => String(p._id) === String(villa._id));
  check('villa project has financials.committedBDT=3500000', villaCard?.financials?.committedBDT === 3500000);
  check('villa project has financials.releasedBDT=1400000', villaCard?.financials?.releasedBDT === 1400000);
  check('villa project has financials.remainingBDT=2100000', villaCard?.financials?.remainingBDT === 2100000);
  check('villa project has queue.pendingProofsCount=1', villaCard?.queue?.pendingProofsCount === 1);
  check('villa project has queue.variancesCount=1', villaCard?.queue?.variancesCount === 1);

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 2: Create FAMILY_VIEWER Delegation Share Token (hideFinancials: true)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 2. Create Family Delegation Token (POST /api/projects/:id/shares) ---');
  const res2 = await fetch(`${baseUrl}/api/projects/${villa._id}/shares`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${probashiToken}`,
      'x-requested-with': 'fetch'
    },
    body: JSON.stringify({
      scopedRole: 'FAMILY_VIEWER',
      delegateName: 'Mizanur Rahman (Brother)',
      expiresInDays: 60,
      hideFinancials: true
    })
  });
  check('create family share returns 201 Created', res2.status === 201);
  const data2 = await res2.json();
  const familyRawToken = data2.data?.rawToken;
  const familyShareId = data2.data?.shareId;
  check('returns rawToken string (64 hex characters)', typeof familyRawToken === 'string' && familyRawToken.length === 64);
  check('returns shareUrl containing rawToken', data2.data?.shareUrl?.includes(familyRawToken));
  check('returns scopedRole=FAMILY_VIEWER', data2.data?.scopedRole === 'FAMILY_VIEWER');
  check('returns hideFinancials=true', data2.data?.hideFinancials === true);

  // Verify DB does not store the raw token, only the SHA-256 hash
  const familyRecord = await ProjectShareToken.findById(familyShareId);
  const expectedHash = crypto.createHash('sha256').update(familyRawToken).digest('hex');
  check('DB stores SHA-256 hash, not rawToken', familyRecord.tokenHash === expectedHash && familyRecord.tokenHash !== familyRawToken);

  // Verify AuditLog record emitted
  const familyAudit = await AuditLog.findOne({ entityId: familyShareId, action: 'PROJECT_SHARE_CREATED' });
  check('emits AuditLog PROJECT_SHARE_CREATED', Boolean(familyAudit));

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 3: Public Delegate View via Raw Token (Financial Scrubbing Enforced)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 3. Public Delegate View (GET /api/projects/shared/:rawToken) ---');
  const res3 = await fetch(`${baseUrl}/api/projects/shared/${familyRawToken}`);
  check('shared project view returns 200 OK', res3.status === 200);
  const data3 = await res3.json();
  check('shared project view status=success', data3.status === 'success');
  check('shared project view returns project title', data3.data?.project?.title === villa.title);
  check('shared project view returns milestone status', data3.data?.ledger?.milestones[0]?.status === 'COMPLETED');
  check('shared project view returns evidenceCount', data3.data?.ledger?.milestones[0]?.evidenceCount === 1);
  // Financial scrubbing assertion:
  check('hideFinancials scrubbed project.budget === null', data3.data?.project?.budget === null);
  check('hideFinancials scrubbed ledger.totalContractValue === null', data3.data?.ledger?.totalContractValue === null);
  check('hideFinancials scrubbed milestone[0].amount === null', data3.data?.ledger?.milestones[0]?.amount === null);
  check('hideFinancials scrubbed materialOrders[0].totalAmountBDT === null', data3.data?.materialOrders[0]?.totalAmountBDT === null);

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 4: Create SITE_WATCHER Delegation Share Token (Photo & Challan Proofs)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 4. Create Site-Watcher Delegation Token ---');
  const res4 = await fetch(`${baseUrl}/api/projects/${villa._id}/shares`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${probashiToken}`,
      'x-requested-with': 'fetch'
    },
    body: JSON.stringify({
      scopedRole: 'SITE_WATCHER',
      delegateName: 'Kashem Sardar (Site Supervisor)',
      delegatePhone: '01711223344',
      expiresInDays: 30,
      hideFinancials: false
    })
  });
  check('create site-watcher share returns 201 Created', res4.status === 201);
  const data4 = await res4.json();
  const watcherRawToken = data4.data?.rawToken;
  const watcherShareId = data4.data?.shareId;
  check('returns scopedRole=SITE_WATCHER', data4.data?.scopedRole === 'SITE_WATCHER');
  check('requires delegatePhone for site watcher', data4.data?.delegatePhone === '01711223344');

  // Attempt to create SITE_WATCHER without phone should fail with 400
  const res4Fail = await fetch(`${baseUrl}/api/projects/${villa._id}/shares`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${probashiToken}`,
      'x-requested-with': 'fetch'
    },
    body: JSON.stringify({
      scopedRole: 'SITE_WATCHER',
      delegateName: 'No Phone Supervisor'
    })
  });
  check('SITE_WATCHER without phone fails with 400', res4Fail.status === 400);

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 5: Scoped Role Boundary Enforcement (Zero Fund Release Authority)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 5. Security Invariant: Scoped Tokens Forbidden from Financial Mutations ---');
  // Attempt to approve milestone with share token
  const res5a = await fetch(`${baseUrl}/api/settlement/milestone/${villaLedger._id}/approve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer share:${watcherRawToken}`,
      'x-requested-with': 'fetch'
    },
    body: JSON.stringify({ milestoneIndex: 1 })
  });
  check('scoped token on milestone approve returns 403 Forbidden', res5a.status === 403);

  // Attempt to fund escrow with share token
  const res5b = await fetch(`${baseUrl}/api/materials/orders/${villaOrder._id}/fund-escrow`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer share:${watcherRawToken}`,
      'x-requested-with': 'fetch'
    }
  });
  check('scoped token on fund-escrow returns 403 Forbidden', res5b.status === 403);

  // Attempt to accept bid with share token
  const res5c = await fetch(`${baseUrl}/api/bids/6ad000000000000000000001/accept`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer share:${watcherRawToken}`,
      'x-requested-with': 'fetch'
    }
  });
  check('scoped token on accept bid returns 403 Forbidden', res5c.status === 403);

  // Attempt to file dispute with share token
  const res5d = await fetch(`${baseUrl}/api/governance/dispute/${villaLedger._id}/milestone/0`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer share:${watcherRawToken}`,
      'x-requested-with': 'fetch'
    },
    body: JSON.stringify({ reason: 'Unauthorized dispute attempt by watcher' })
  });
  check('scoped token on file dispute returns 403 Forbidden', res5d.status === 403);

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 6: List Shares on Project
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 6. List Shares (GET /api/projects/:id/shares) ---');
  const res6 = await fetch(`${baseUrl}/api/projects/${villa._id}/shares`, {
    headers: { authorization: `Bearer ${probashiToken}` }
  });
  check('list shares returns 200 OK', res6.status === 200);
  const data6 = await res6.json();
  check('list shares returns 2 active shares', data6.shares?.length === 2);
  check('list shares does NOT leak tokenHash', !data6.shares?.some((s) => s.tokenHash));

  // Stranger cannot list shares on Probashi project
  const res6Stranger = await fetch(`${baseUrl}/api/projects/${villa._id}/shares`, {
    headers: { authorization: `Bearer ${strangerToken}` }
  });
  check('stranger cannot list shares on another client project (404)', res6Stranger.status === 404);

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 7: Instant Share Revocation
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 7. Instant Share Revocation (DELETE /api/projects/:id/shares/:shareId) ---');
  const res7 = await fetch(`${baseUrl}/api/projects/${villa._id}/shares/${familyShareId}`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${probashiToken}`,
      'x-requested-with': 'fetch'
    }
  });
  check('revoke share returns 200 OK', res7.status === 200);

  // Subsequent view with revoked token must return 404
  const res7View = await fetch(`${baseUrl}/api/projects/shared/${familyRawToken}`);
  check('access via revoked share token returns 404', res7View.status === 404);

  // AuditLog emitted for revocation
  const revokeAudit = await AuditLog.findOne({ entityId: familyShareId, action: 'PROJECT_SHARE_REVOKED' });
  check('emits AuditLog PROJECT_SHARE_REVOKED', Boolean(revokeAudit));

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 8: Malformed & Non-existent Share Tokens
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 8. Edge Case & Token Bounds Verification ---');
  const res8Short = await fetch(`${baseUrl}/api/projects/shared/short-token-123`);
  check('short token returns 400 Bad Request', res8Short.status === 400);

  const res8Random = await fetch(`${baseUrl}/api/projects/shared/${'f'.repeat(64)}`);
  check('non-existent 64-char token returns 404 Not Found', res8Random.status === 404);

  console.log(`\n======================================================`);
  if (failed === 0) {
    console.log(`🏆 ALL PHASE 2 PROBASHI DELEGATION TESTS PASSED (0 FAILURES)`);
  } else {
    console.log(`💥 ${failed} TEST(S) FAILED`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Test execution crash:', err);
  process.exit(1);
});
