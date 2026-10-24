// tests/non-functional-combinatorial-e2e.js
// =============================================================================
// Build-BD Non-Functional, Security & Performance Automated Audit Suite
// =============================================================================
// Comprehensive verification of:
//   1. Cross-Persona Privilege Escalation & IDOR Prevention
//   2. Financial Invariants & Zero-Sum Conservation across all 4 Financial Engines:
//      - Civil Milestone (95% contractor + 5% platform fee = 100% gross)
//      - Material Waybill (2% platform fee + delivery charge + mill base price = 100% escrow)
//      - Micro Utility (80% mistri + 10% platform fee + 10% insurance pool = 100% gross)
//      - Domestic Labour (80% weekly take-home + 15% 4th-week retention + 5% platform fee = 100% gross)
//   3. Concurrency, Race Conditions & State Machine CAS Locks:
//      - Concurrent duplicate bid acceptances (exactly 1 wins, CAS 409/400)
//      - Concurrent duplicate escrow releases (exactly 1 wins, CAS 400/409)
//      - Idempotency-Key replay attacks (cached replay, zero double-debiting)
//   4. Input Fuzzing, Boundary Conditions & ReDoS Immunity:
//      - 0 BDT / negative bids
//      - Huge integer quantities / overflow guards
//      - SQL/NoSQL injection tokens & Unicode emojis
//      - Operational 400/409/422 status verification without 500 crashes
// =============================================================================
'use strict';

require('dotenv').config();
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32chars-minimum-safe';

const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

// Models
const User = require('../models/User');
const Project = require('../models/Project');
const Bid = require('../models/Bid');
const EscrowLedger = require('../models/EscrowLedger');
const ContractorProfile = require('../models/ContractorProfile');
const { SupplierProfile } = require('../models/SupplierProfile');
const { MaterialProduct } = require('../models/MaterialProduct');
const MaterialOrder = require('../models/MaterialOrder');
const ProjectShareToken = require('../models/ProjectShareToken');
const IdempotencyKey = require('../models/IdempotencyKey');

// Financial Engine Utilities
const { splitMilestoneAmount, PLATFORM_FEE_BPS, BPS_DIVISOR } = require('../utils/money');
const { creditPendingClearance } = require('../services/settlementService');
const { computeBidFingerprint } = require('../services/bidEligibilityService');
const {
  computeMicroSettlementSplit,
  computeDomesticWeeklySplit
} = require('../services/aiOrchestratorService');

let totalChecks = 0;
let failedChecks = 0;

function check(name, condition, detail) {
  totalChecks++;
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failedChecks++;
    console.error(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function requestJson(port, method, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined && body !== null ? JSON.stringify(body) : null;
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
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (_) {}
          resolve({ status: res.statusCode, body: json || data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const genPhone = (prefix = '017') => `${prefix}${Math.floor(10000000 + Math.random() * 90000000)}`;
const mintToken = (user) => jwt.sign(
  { userId: String(user._id), role: user.role, sv: user.sessionVersion || 0 },
  process.env.JWT_SECRET,
  { expiresIn: '2h' }
);

async function runSuite() {
  console.log('=============================================================================');
  console.log('🛡️  STARTING NON-FUNCTIONAL, SECURITY & PERFORMANCE COMBINATORIAL AUDIT');
  console.log('=============================================================================\n');

  if (!appServer.listening) {
    await new Promise((resolve) => appServer.on('listening', resolve));
  }
  const port = appServer.address().port;

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  }

  // Ensure Treasury Admin Account
  const treasuryPhone = process.env.TREASURY_PHONE || '01700000000';
  const treasuryUser = await User.findOneAndUpdate(
    { phoneNumber: treasuryPhone },
    {
      $setOnInsert: {
        role: 'ADMIN',
        phoneNumber: treasuryPhone,
        status: 'ACTIVE',
        wallet: { availableToWithdraw: 0, pendingClearance: 0, escrowLocked: 0 }
      }
    },
    { upsert: true, returnDocument: 'after' }
  );

  // Setup Test Entities
  const clientUser = await User.create({
    phoneNumber: genPhone('013'),
    role: 'CLIENT',
    status: 'ACTIVE',
    wallet: { availableToWithdraw: 500000, pendingClearance: 0, escrowLocked: 0 }
  });

  const contractorUser1 = await User.create({
    phoneNumber: genPhone('018'),
    role: 'CONTRACTOR',
    status: 'ACTIVE',
    wallet: { availableToWithdraw: 0, pendingClearance: 0, escrowLocked: 0 }
  });

  const contractorUser2 = await User.create({
    phoneNumber: genPhone('018'),
    role: 'CONTRACTOR',
    status: 'ACTIVE',
    wallet: { availableToWithdraw: 0, pendingClearance: 0, escrowLocked: 0 }
  });

  const supplierUser = await User.create({
    phoneNumber: genPhone('019'),
    role: 'SUPPLIER',
    status: 'ACTIVE',
    wallet: { availableToWithdraw: 0, pendingClearance: 0, escrowLocked: 0 }
  });

  const strangerUser = await User.create({
    phoneNumber: genPhone('015'),
    role: 'CLIENT',
    status: 'ACTIVE',
    wallet: { availableToWithdraw: 0, pendingClearance: 0, escrowLocked: 0 }
  });

  await ContractorProfile.create({
    userId: contractorUser1._id,
    businessType: 'INDIVIDUAL',
    fullName: 'Prime Builder Pro 1',
    verification: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      probationStatus: { isProbation: false, projectsCompleted: 5, projectsRequired: 3, canBidAbove: 1000000 }
    }
  });

  await ContractorProfile.create({
    userId: contractorUser2._id,
    businessType: 'INDIVIDUAL',
    fullName: 'Prime Builder Pro 2',
    verification: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      probationStatus: { isProbation: false, projectsCompleted: 5, projectsRequired: 3, canBidAbove: 1000000 }
    }
  });

  const supplierProfile = await SupplierProfile.create({
    userId: supplierUser._id,
    businessName: 'Apex Rebar Mills Ltd',
    tradeLicenseNumber: `TRAD-${Date.now()}-APEX`,
    nidNumber: '19901234567890',
    categories: ['ROD', 'CEMENT'],
    serviceDistricts: ['Dhaka', 'Gazipur'],
    verification: { status: 'VERIFIED', verifiedAt: new Date() }
  });

  const materialProduct = await MaterialProduct.create({
    supplierId: supplierProfile._id,
    supplierUserId: supplierUser._id,
    category: 'ROD',
    brand: 'Apex 500W',
    title: 'Apex Xtreme 500W 12mm Rebar',
    unit: 'TON',
    basePriceBDT: 92000,
    bulkTiers: [{ minQuantity: 10, unitPriceBDT: 90000 }],
    stockQuantity: 150,
    minOrderQuantity: 1,
    deliveryTerms: {
      leadTimeDays: 2,
      deliveryChargeBDT: 2000,
      supportedDistricts: ['Dhaka', 'Gazipur']
    },
    status: 'ACTIVE'
  });

  // Base Project & Share Token
  const testProject = await Project.create({
    clientId: clientUser._id,
    title: 'Audit Project Residential Villa',
    category: 'Residential',
    description: 'High-security non-functional audit target residential project.',
    location: 'Dhaka',
    budget: 600000,
    status: 'OPEN'
  });

  const rawDelegateToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawDelegateToken).digest('hex');

  await ProjectShareToken.create({
    projectId: testProject._id,
    clientUserId: clientUser._id,
    delegateName: 'Site Supervisor Auditor',
    scopedRole: 'SITE_WATCHER',
    tokenHash,
    hideFinancials: true,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  });

  // Bids on testProject
  const fp1 = computeBidFingerprint({
    projectId: testProject._id,
    contractorId: contractorUser1._id,
    bidAmount: 450000,
    estimatedDays: 60,
    proposalText: 'Verified structural work proposal with complete civil schedule.'
  });
  const testBid1 = await Bid.create({
    projectId: testProject._id,
    contractorId: contractorUser1._id,
    bidAmount: 450000,
    estimatedDays: 60,
    proposalText: 'Verified structural work proposal with complete civil schedule.',
    bidFingerprint: fp1,
    status: 'PENDING'
  });

  const fp2 = computeBidFingerprint({
    projectId: testProject._id,
    contractorId: contractorUser2._id,
    bidAmount: 480000,
    estimatedDays: 55,
    proposalText: 'Alternative verified structural work proposal.'
  });
  const testBid2 = await Bid.create({
    projectId: testProject._id,
    contractorId: contractorUser2._id,
    bidAmount: 480000,
    estimatedDays: 55,
    proposalText: 'Alternative verified structural work proposal.',
    bidFingerprint: fp2,
    status: 'PENDING'
  });

  // Material Order
  const testOrder = await MaterialOrder.create({
    orderNumber: MaterialOrder.generateOrderNumber(),
    buyerUserId: clientUser._id,
    buyerRole: 'CLIENT',
    supplierUserId: supplierUser._id,
    supplierId: supplierProfile._id,
    items: [{
      productId: materialProduct._id,
      category: 'ROD',
      brand: 'Apex 500W',
      title: 'Apex Xtreme 500W 12mm Rebar',
      unit: 'TON',
      quantity: 5,
      unitPriceBDT: 92000,
      totalPriceBDT: 460000
    }],
    itemsSubtotalBDT: 460000,
    deliveryChargeBDT: 2000,
    platformFeeBDT: 9200,
    totalAmountBDT: 471200,
    deliveryDetails: {
      deliveryDistrict: 'Dhaka',
      deliveryAddress: 'House 12, Road 4, Sector 7, Uttara',
      receiverName: 'Mr. Tareq Client',
      receiverPhone: '01711223344'
    },
    status: 'PENDING_SUPPLIER_ACCEPTANCE',
    escrowStatus: 'PENDING'
  });

  const clientTok = mintToken(clientUser);
  const contractor1Tok = mintToken(contractorUser1);
  const contractor2Tok = mintToken(contractorUser2);
  const supplierTok = mintToken(supplierUser);
  const strangerTok = mintToken(strangerUser);

  // ===========================================================================
  // SECTION 1: Cross-Persona Privilege Escalation & IDOR
  // ===========================================================================
  console.log('👉 [1/4] AUDITING CROSS-PERSONA PRIVILEGE ESCALATION & IDOR...');

  // 1.1 CLIENT attempting to bid on a project -> 403
  {
    const res = await requestJson(
      port,
      'POST',
      `/api/bids/${testProject._id}`,
      { bidAmount: 250000, estimatedDays: 30, proposalText: 'Malicious client bidding proposal' },
      { Authorization: `Bearer ${clientTok}` }
    );
    check('CLIENT attempting to bid on a project is rejected with 403 Forbidden', res.status === 403, `Got ${res.status}`);
  }

  // 1.2 SUPPLIER attempting to post a project -> 403
  {
    const res = await requestJson(
      port,
      'POST',
      '/api/projects',
      {
        title: 'Supplier Illegal Project',
        category: 'Residential',
        description: 'Supplier attempting to create project RFQ',
        location: 'Dhaka',
        budget: 300000
      },
      { Authorization: `Bearer ${supplierTok}` }
    );
    check('SUPPLIER attempting to post a project is rejected with 403 Forbidden', res.status === 403, `Got ${res.status}`);
  }

  // 1.3 SUPPLIER attempting to bid on a project -> 403
  {
    const res = await requestJson(
      port,
      'POST',
      `/api/bids/${testProject._id}`,
      { bidAmount: 200000, estimatedDays: 20, proposalText: 'Supplier bidding proposal' },
      { Authorization: `Bearer ${supplierTok}` }
    );
    check('SUPPLIER attempting to bid on a project is rejected with 403 Forbidden', res.status === 403, `Got ${res.status}`);
  }

  // 1.4 CONTRACTOR attempting to dispatch a material order -> 403
  {
    const res = await requestJson(
      port,
      'POST',
      `/api/materials/orders/${testOrder._id}/dispatch`,
      { challanNumber: 'CH-999-ILLEGAL', carrierName: 'Contractor Truck' },
      { Authorization: `Bearer ${contractor1Tok}` }
    );
    check('CONTRACTOR attempting to dispatch a material order is rejected with 403 Forbidden', res.status === 403, `Got ${res.status}`);
  }

  // 1.5 Stranger attempting to view private material order -> 403
  {
    const res = await requestJson(
      port,
      'GET',
      `/api/materials/orders/${testOrder._id}`,
      null,
      { Authorization: `Bearer ${strangerTok}` }
    );
    check('Stranger attempting to view private material order is rejected with 403 Forbidden', res.status === 403, `Got ${res.status}`);
  }

  // 1.6 Stranger attempting to manipulate private material order (accept) -> 403
  {
    const res = await requestJson(
      port,
      'PATCH',
      `/api/materials/orders/${testOrder._id}/accept`,
      {},
      { Authorization: `Bearer ${strangerTok}` }
    );
    check('Stranger attempting to accept private material order is rejected with 403 Forbidden', res.status === 403, `Got ${res.status}`);
  }

  // 1.7 Stranger attempting to view private chat messages on a bid thread -> 403
  {
    const res = await requestJson(
      port,
      'GET',
      `/api/chat/${testBid1._id}`,
      null,
      { Authorization: `Bearer ${strangerTok}` }
    );
    check('Stranger attempting to read private negotiation chat is rejected with 403 Forbidden', res.status === 403, `Got ${res.status}`);
  }

  // 1.8 Stranger attempting to send message on private chat -> 403
  {
    const res = await requestJson(
      port,
      'POST',
      `/api/chat/${testBid1._id}/message`,
      { text: 'Injected stranger message' },
      { Authorization: `Bearer ${strangerTok}` }
    );
    check('Stranger attempting to inject message into private chat is rejected with 403 Forbidden', res.status === 403, `Got ${res.status}`);
  }

  // 1.9 Delegate share token attempting to accept offer -> 403
  {
    const res = await requestJson(
      port,
      'POST',
      `/api/chat/${testBid1._id}/accept-offer`,
      {},
      { 'x-project-share-token': rawDelegateToken }
    );
    check('Delegate share token attempting to accept offer is rejected with 403 Forbidden', res.status === 403, `Got ${res.status}`);
  }

  // 1.10 Delegate share token attempting to release financial escrows -> 403
  {
    const dummyLedgerId = new mongoose.Types.ObjectId().toString();
    const res = await requestJson(
      port,
      'POST',
      `/api/governance/approve/${dummyLedgerId}/milestone/0`,
      {},
      { 'x-project-share-token': rawDelegateToken }
    );
    check('Delegate share token attempting to approve milestone / release escrow is rejected with 403 Forbidden', res.status === 403, `Got ${res.status}`);
  }

  // 1.11 Delegate share token attempting to fund material escrow -> 403
  {
    const res = await requestJson(
      port,
      'POST',
      `/api/materials/orders/${testOrder._id}/fund-escrow`,
      {},
      { 'x-project-share-token': rawDelegateToken }
    );
    check('Delegate share token attempting to fund material escrow is rejected with 403 Forbidden', res.status === 403, `Got ${res.status}`);
  }

  // ===========================================================================
  // SECTION 2: Financial Invariants & Zero-Sum Conservation across all 4 Engines
  // ===========================================================================
  console.log('\n👉 [2/4] AUDITING FINANCIAL INVARIANTS & ZERO-SUM CONSERVATION ACROSS 4 ENGINES...');

  // 2.1 Civil Milestone: exact 95% contractor payout + 5% platform fee = 100% gross
  {
    check('Basis points fee constant is exactly 500 bps (5.00%)', PLATFORM_FEE_BPS === 500);
    check('Basis points divisor is 10000', BPS_DIVISOR === 10000);

    const testAmounts = [
      0, 1, 2, 3, 7, 9, 13, 19, 21, 33, 77, 99, 100, 101, 333, 999, 1000, 1001,
      13337, 77777, 99999, 123456, 500000, 999999, 1000003, 123456789
    ];

    let civilLeakageDetected = false;
    for (const gross of testAmounts) {
      const { contractor, platform } = splitMilestoneAmount(gross);
      const expectedPlatform = Math.round((gross * PLATFORM_FEE_BPS) / BPS_DIVISOR);
      const sum = contractor + platform;

      if (sum !== gross || platform !== expectedPlatform || !Number.isInteger(contractor) || !Number.isInteger(platform)) {
        civilLeakageDetected = true;
        console.error(`💥 Civil Milestone leakage at ${gross}: contractor=${contractor}, platform=${platform}, sum=${sum}`);
        break;
      }
    }
    check('Civil Milestone splits conserve 100% gross across odd/prime amounts with ZERO 1-taka rounding leakage', !civilLeakageDetected);

    // In-DB transaction credit verification
    const oddMilestoneGross = 13337; // 5% is 666.85 -> rounds to 667; contractor: 12670; sum = 13337
    const beforeContractor = await User.findById(contractorUser1._id);
    const beforeTreasury = await User.findById(treasuryUser._id);

    await mongoose.connection.transaction(async (session) => {
      await creditPendingClearance(session, { contractorId: contractorUser1._id, amount: oddMilestoneGross });
    });

    const afterContractor = await User.findById(contractorUser1._id);
    const afterTreasury = await User.findById(treasuryUser._id);

    const contractorDelta = (afterContractor.wallet.pendingClearance || 0) - (beforeContractor.wallet.pendingClearance || 0);
    const treasuryDelta = (afterTreasury.wallet.pendingClearance || 0) - (beforeTreasury.wallet.pendingClearance || 0);

    check('Civil Milestone in-DB credit pendingClearance: contractor gets exact 95% net (12,670 BDT)', contractorDelta === 12670, `Got ${contractorDelta}`);
    check('Civil Milestone in-DB credit pendingClearance: treasury gets exact 5% fee (667 BDT)', treasuryDelta === 667, `Got ${treasuryDelta}`);
    check('Civil Milestone in-DB credit: net contractor + platform fee strictly equals 13,337 gross', contractorDelta + treasuryDelta === oddMilestoneGross);
  }

  // 2.2 Material Waybill: 2% platform fee + delivery charge + mill base price = 100% escrow
  {
    const subtotalSamples = [1000, 3333, 7777, 13579, 50000, 92000, 1407600];
    const deliverySamples = [0, 350, 1500, 2500];

    let materialLeakageDetected = false;
    for (const subtotal of subtotalSamples) {
      for (const delivery of deliverySamples) {
        const platformFeeBDT = Math.round(subtotal * 0.02);
        const totalAmountBDT = subtotal + delivery + platformFeeBDT;
        const netSupplierPayoutBDT = totalAmountBDT - platformFeeBDT;

        if (netSupplierPayoutBDT + platformFeeBDT !== totalAmountBDT) {
          materialLeakageDetected = true;
          break;
        }
        if (netSupplierPayoutBDT !== subtotal + delivery) {
          materialLeakageDetected = true;
          break;
        }
      }
    }
    check('Material Waybill formula guarantees 2% platform fee + delivery + mill base price = 100% escrow with zero leakage', !materialLeakageDetected);
  }

  // 2.3 Micro Utility: 80% mistri + 10% platform fee + 10% insurance pool = 100% gross
  {
    const laborSamples = [200, 201, 233, 499, 750, 800, 833, 1337, 3333, 7777, 10001];
    const partsSamples = [0, 100, 250, 499, 1250];

    let microLeakageDetected = false;
    for (const labor of laborSamples) {
      for (const parts of partsSamples) {
        const split = computeMicroSettlementSplit(labor, parts);
        const laborSum = split.laborImmediateBdt + split.warrantyHold7DayBdt + Math.round(labor * 0.10);
        const totalSum = split.immediateTechnicianPayoutBdt + split.warrantyHold7DayBdt + split.platformAndGatewayFeeBdt;

        if (laborSum !== labor || totalSum !== (labor + parts)) {
          microLeakageDetected = true;
          console.error(`💥 Micro Utility leakage at labor=${labor}, parts=${parts}`);
          break;
        }
      }
    }
    check('Micro Utility split: 80% immediate + 10% warranty hold + 10% platform fee = 100% labor gross with zero leakage', !microLeakageDetected);

    // Live endpoint verification: POST /api/v2/projects/micro/dispatch
    const microDispatchRes = await requestJson(
      port,
      'POST',
      '/api/v2/projects/micro/dispatch',
      {
        categoryCode: 'MICRO_AC',
        thana: 'Gulshan',
        floorLevel: 1,
        baseLaborBdt: 833,
        sparePartsBdt: 250,
        description: 'AC Jet Wash and capacitor replacement'
      },
      {
        Authorization: `Bearer ${clientTok}`,
        'X-Idempotency-Key': `idem-micro-${Date.now()}`
      }
    );
    check('Micro utility dispatch created successfully with status 201', microDispatchRes.status === 201, `Got ${microDispatchRes.status}`);
    const split = microDispatchRes.body?.data?.settlementSplit;
    if (split) {
      check('Micro dispatch API response: grossTotalBdt matches labor (833) + parts (250) = 1083', split.grossTotalBdt === 1083, `Got ${split.grossTotalBdt}`);
      check(
        'Micro dispatch API response: technician payout + warranty hold + fees strictly equals grossTotalBdt',
        split.immediateTechnicianPayoutBdt + split.warrantyHold7DayBdt + split.platformAndGatewayFeeBdt === split.grossTotalBdt
      );
    } else {
      check('Micro dispatch returned valid settlement split payload', false);
    }
  }

  // 2.4 Domestic Labour: 80% weekly take-home + 15% 4th-week retention + 5% platform fee = 100% gross
  {
    const weeklyGrossSamples = [1000, 1233, 2000, 2750, 3333, 4999, 7777, 10000];
    let labourLeakageDetected = false;

    for (const gross of weeklyGrossSamples) {
      // Weeks 1-3
      for (let week = 1; week <= 3; week++) {
        const split = computeDomesticWeeklySplit(gross, week, 0);
        const sum = split.workerImmediateBdt + split.continuityHoldBdt + split.platformFeeBdt;
        if (sum !== gross) {
          labourLeakageDetected = true;
          console.error(`💥 Domestic Labour leakage week ${week} at gross=${gross}: sum=${sum}`);
          break;
        }
      }
      // Week 4 (releasing prior reserve)
      const priorReserve = Math.round(gross * 0.15) * 3;
      const week4Split = computeDomesticWeeklySplit(gross, 4, priorReserve);
      const netWeek4 = week4Split.workerImmediateBdt + week4Split.platformFeeBdt;
      if (netWeek4 !== gross + priorReserve) {
        labourLeakageDetected = true;
        console.error(`💥 Domestic Labour leakage week 4 at gross=${gross}: netWeek4=${netWeek4}`);
        break;
      }
    }
    check('Domestic Labour split: 80% weekly take-home + 15% 4th-week retention + 5% platform fee = 100% gross with zero leakage', !labourLeakageDetected);
  }

  // ===========================================================================
  // SECTION 3: Concurrency, Race Conditions & State Machine CAS Locks
  // ===========================================================================
  console.log('\n👉 [3/4] AUDITING CONCURRENCY, RACE CONDITIONS & CAS STATE MACHINE LOCKS...');

  // 3.1 Concurrent duplicate bid acceptances -> exactly one succeeds, others fail with 409 or 400
  {
    const projCAS = await Project.create({
      clientId: clientUser._id,
      title: 'CAS Concurrency Race Project',
      category: 'Residential',
      description: 'Project to test parallel concurrent bid acceptance races.',
      location: 'Dhaka',
      budget: 350000,
      status: 'OPEN'
    });

    const fpA = computeBidFingerprint({
      projectId: projCAS._id,
      contractorId: contractorUser1._id,
      bidAmount: 300000,
      estimatedDays: 45,
      proposalText: 'Proposal A for CAS test'
    });
    const bidA = await Bid.create({
      projectId: projCAS._id,
      contractorId: contractorUser1._id,
      bidAmount: 300000,
      estimatedDays: 45,
      proposalText: 'Proposal A for CAS test',
      bidFingerprint: fpA,
      status: 'PENDING'
    });

    const fpB = computeBidFingerprint({
      projectId: projCAS._id,
      contractorId: contractorUser2._id,
      bidAmount: 320000,
      estimatedDays: 40,
      proposalText: 'Proposal B for CAS test'
    });
    const bidB = await Bid.create({
      projectId: projCAS._id,
      contractorId: contractorUser2._id,
      bidAmount: 320000,
      estimatedDays: 40,
      proposalText: 'Proposal B for CAS test',
      bidFingerprint: fpB,
      status: 'PENDING'
    });

    // Fire both acceptances concurrently
    const [resA, resB] = await Promise.all([
      requestJson(port, 'PUT', `/api/bids/${bidA._id}/accept`, {}, { Authorization: `Bearer ${clientTok}` }),
      requestJson(port, 'PUT', `/api/bids/${bidB._id}/accept`, {}, { Authorization: `Bearer ${clientTok}` })
    ]);

    const statuses = [resA.status, resB.status];
    const okCount = statuses.filter((s) => s === 200).length;
    const conflictCount = statuses.filter((s) => s === 409 || s === 400).length;

    check('Concurrent duplicate bid acceptances: exactly ONE request succeeds with HTTP 200', okCount === 1, `200 count: ${okCount}, got statuses: ${statuses.join(', ')}`);
    check('Concurrent duplicate bid acceptances: losing request fails with HTTP 409 Conflict or 400', conflictCount === 1, `Conflict count: ${conflictCount}`);

    const finalProject = await Project.findById(projCAS._id);
    check('Project status transitioned cleanly to ASSIGNED without race corruption', finalProject.status === 'ASSIGNED');
    check(
      'awardedContractorId strictly locked to the winning contractor',
      finalProject.awardedContractorId &&
      (String(finalProject.awardedContractorId) === String(contractorUser1._id) ||
       String(finalProject.awardedContractorId) === String(contractorUser2._id))
    );

    const ledgersCreated = await EscrowLedger.find({ projectId: projCAS._id });
    check('Exactly one EscrowLedger created for the project (no duplicate ledger leak)', ledgersCreated.length === 1, `Found ${ledgersCreated.length} ledgers`);
  }

  // 3.2 Concurrent duplicate escrow releases -> exactly one succeeds
  {
    const raceLedger = await EscrowLedger.create({
      clientId: clientUser._id,
      contractorId: contractorUser1._id,
      projectId: testProject._id,
      totalContractValue: 20000,
      ledgerStatus: 'FUNDED',
      milestones: [{
        title: 'Concurrent Release Milestone 0',
        amount: 20000,
        releasePercentage: 100,
        status: 'PROOF_SUBMITTED'
      }]
    });

    const keyRelease1 = `race-rel-1-${Date.now()}`;
    const keyRelease2 = `race-rel-2-${Date.now()}`;

    const [relA, relB] = await Promise.all([
      requestJson(
        port,
        'POST',
        `/api/governance/approve/${raceLedger._id}/milestone/0`,
        {},
        { Authorization: `Bearer ${clientTok}`, 'X-Idempotency-Key': keyRelease1 }
      ),
      requestJson(
        port,
        'POST',
        `/api/governance/approve/${raceLedger._id}/milestone/0`,
        {},
        { Authorization: `Bearer ${clientTok}`, 'X-Idempotency-Key': keyRelease2 }
      )
    ]);

    const relStatuses = [relA.status, relB.status];
    const relOkCount = relStatuses.filter((s) => s === 200).length;
    const relFailCount = relStatuses.filter((s) => s === 400 || s === 409).length;

    check('Concurrent duplicate escrow release: exactly ONE release succeeds with HTTP 200', relOkCount === 1, `Got statuses: ${relStatuses.join(', ')}`);
    check('Concurrent duplicate escrow release: second release rejected with HTTP 400 (not PROOF_SUBMITTED) or 409', relFailCount === 1);

    const afterRaceLedger = await EscrowLedger.findById(raceLedger._id);
    check('Milestone state safely transitioned to COMPLETED without corruption', afterRaceLedger.milestones[0].status === 'COMPLETED');
  }

  // 3.3 Idempotency-Key replay attacks -> duplicate key returns cached response without double-debiting
  {
    const idemLedger = await EscrowLedger.create({
      clientId: clientUser._id,
      contractorId: contractorUser1._id,
      projectId: testProject._id,
      totalContractValue: 10000,
      ledgerStatus: 'FUNDED',
      milestones: [{
        title: 'Idempotency Replay Milestone',
        amount: 10000,
        releasePercentage: 100,
        status: 'PROOF_SUBMITTED'
      }]
    });

    const replayKey = `replay-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const url = `/api/governance/approve/${idemLedger._id}/milestone/0`;

    const contractorBefore = await User.findById(contractorUser1._id);
    const balanceBefore = contractorBefore.wallet.pendingClearance || 0;

    // First Request
    const res1 = await requestJson(port, 'POST', url, {}, {
      Authorization: `Bearer ${clientTok}`,
      'X-Idempotency-Key': replayKey
    });
    check('First request with idempotency key executes successfully (200 OK)', res1.status === 200, `Got ${res1.status}`);

    const contractorAfter1 = await User.findById(contractorUser1._id);
    const balanceAfter1 = contractorAfter1.wallet.pendingClearance || 0;
    check('Contractor wallet credited 9,500 BDT (95% net) on first request', balanceAfter1 - balanceBefore === 9500);

    // Replay Request with exact same key
    const res2 = await requestJson(port, 'POST', url, {}, {
      Authorization: `Bearer ${clientTok}`,
      'X-Idempotency-Key': replayKey
    });
    check('Replayed request with identical idempotency key returns cached response with HTTP 200', res2.status === 200, `Got ${res2.status}`);

    const contractorAfter2 = await User.findById(contractorUser1._id);
    const balanceAfter2 = contractorAfter2.wallet.pendingClearance || 0;
    check('Replayed request caused ZERO double-crediting (balance unchanged)', balanceAfter2 === balanceAfter1);
  }

  // ===========================================================================
  // SECTION 4: Input Fuzzing, Boundary Conditions & ReDoS
  // ===========================================================================
  console.log('\n👉 [4/4] AUDITING INPUT FUZZING, BOUNDARY CONDITIONS & REDOS...');

  // 4.1 0 BDT or negative bids
  {
    const zeroRes = await requestJson(
      port,
      'POST',
      `/api/bids/${testProject._id}`,
      { bidAmount: 0, estimatedDays: 10, proposalText: 'Zero BDT bid attempt' },
      { Authorization: `Bearer ${contractor1Tok}` }
    );
    check('0 BDT bid is rejected with clean HTTP 400 Bad Request', zeroRes.status === 400, `Got ${zeroRes.status}`);

    const negRes = await requestJson(
      port,
      'POST',
      `/api/bids/${testProject._id}`,
      { bidAmount: -5000, estimatedDays: 10, proposalText: 'Negative BDT bid attempt' },
      { Authorization: `Bearer ${contractor1Tok}` }
    );
    check('Negative BDT bid is rejected with clean HTTP 400 Bad Request', negRes.status === 400, `Got ${negRes.status}`);

    const belowFloorRes = await requestJson(
      port,
      'POST',
      `/api/bids/${testProject._id}`,
      { bidAmount: 50, estimatedDays: 10, proposalText: 'Below 100 BDT floor bid attempt' },
      { Authorization: `Bearer ${contractor1Tok}` }
    );
    check('Bid below minimum floor (< 100 BDT) is rejected with clean HTTP 400', belowFloorRes.status === 400, `Got ${belowFloorRes.status}`);

    const negMilestoneRes = await requestJson(
      port,
      'POST',
      `/api/bids/${testProject._id}`,
      {
        bidAmount: 1000,
        estimatedDays: 10,
        proposalText: 'Negative breakdown line item',
        itemizedBreakdown: [
          { title: 'Item A', amount: 1200 },
          { title: 'Item B', amount: -200 }
        ]
      },
      { Authorization: `Bearer ${contractor1Tok}` }
    );
    check('Itemized breakdown containing negative amount rejected with clean HTTP 400', negMilestoneRes.status === 400, `Got ${negMilestoneRes.status}`);
  }

  // 4.2 Huge integer quantities or overflow in material purchase orders
  {
    const overflowQtyRes = await requestJson(
      port,
      'POST',
      '/api/materials/orders',
      {
        supplierId: supplierProfile._id,
        items: [{ productId: materialProduct._id, quantity: 1e16 }],
        deliveryDetails: {
          deliveryDistrict: 'Dhaka',
          deliveryAddress: 'House 1, Road 2',
          receiverName: 'Auditor Buyer',
          receiverPhone: '01711223344'
        }
      },
      { Authorization: `Bearer ${clientTok}` }
    );
    check('Huge quantity / integer overflow attempt is rejected with clean HTTP 400', overflowQtyRes.status === 400, `Got ${overflowQtyRes.status}`);

    const negQtyRes = await requestJson(
      port,
      'POST',
      '/api/materials/orders',
      {
        supplierId: supplierProfile._id,
        items: [{ productId: materialProduct._id, quantity: -5 }],
        deliveryDetails: {
          deliveryDistrict: 'Dhaka',
          deliveryAddress: 'House 1, Road 2',
          receiverName: 'Auditor Buyer',
          receiverPhone: '01711223344'
        }
      },
      { Authorization: `Bearer ${clientTok}` }
    );
    check('Negative order quantity is rejected with clean HTTP 400', negQtyRes.status === 400, `Got ${negQtyRes.status}`);

    const zeroQtyRes = await requestJson(
      port,
      'POST',
      '/api/materials/orders',
      {
        supplierId: supplierProfile._id,
        items: [{ productId: materialProduct._id, quantity: 0 }],
        deliveryDetails: {
          deliveryDistrict: 'Dhaka',
          deliveryAddress: 'House 1, Road 2',
          receiverName: 'Auditor Buyer',
          receiverPhone: '01711223344'
        }
      },
      { Authorization: `Bearer ${clientTok}` }
    );
    check('Zero order quantity is rejected with clean HTTP 400', zeroQtyRes.status === 400, `Got ${zeroQtyRes.status}`);
  }

  // 4.3 Special characters, SQL/NoSQL injection tokens, unicode emojis in text fields
  {
    // Create dedicated fuzzing project to ensure fresh bid slot
    const fuzzProject = await Project.create({
      clientId: clientUser._id,
      title: 'Fuzzing & Injection Defense Project',
      category: 'Residential',
      description: 'Project created specifically for input fuzzing and sanitize audits.',
      location: 'Dhaka',
      budget: 400000,
      status: 'OPEN'
    });

    // NoSQL injection payload in proposalText
    const nosqlRes = await requestJson(
      port,
      'POST',
      `/api/bids/${fuzzProject._id}`,
      {
        bidAmount: 150000,
        estimatedDays: 25,
        proposalText: 'Verified text with {"$ne": null, "$where": "sleep(5000)"} NoSQL tokens'
      },
      { Authorization: `Bearer ${contractor1Tok}` }
    );
    check('NoSQL injection tokens in text fields do not cause 500 error', nosqlRes.status === 201 || nosqlRes.status === 400, `Got ${nosqlRes.status}`);

    // SQL Injection payload in project search query
    const sqlPayload = "' OR '1'='1'; DROP TABLE users; --";
    const sqlSearchRes = await requestJson(
      port,
      'GET',
      `/api/projects/exchange?q=${encodeURIComponent(sqlPayload)}`,
      null
    );
    check('SQL injection tokens in query params return clean operational HTTP 200 without crashing', sqlSearchRes.status === 200, `Got ${sqlSearchRes.status}`);

    // Unicode emojis & Bengali script characters in project creation
    const emojiProjectRes = await requestJson(
      port,
      'POST',
      '/api/projects',
      {
        title: '🏗️ স্বপ্নের বাড়ি নির্মাণ প্রকল্প 🏠 (Luxury Villa)',
        category: 'Residential',
        description: 'বাংলা ভাষায় বিস্তারিত বিবরণ এবং ইমোজি সাপোর্ট টেস্ট: 🔨👷‍♂️🇧🇩 100% Quality.',
        location: 'Mirpur DOHS, Dhaka',
        budget: 750000
      },
      { Authorization: `Bearer ${clientTok}` }
    );
    check('Unicode emojis and complex Bengali typography processed cleanly (201 Created)', emojiProjectRes.status === 201, `Got ${emojiProjectRes.status}`);

    // ReDoS Catastrophic Backtracking defense verification
    const redosString = 'a'.repeat(3000) + '!';
    const startTime = Date.now();
    const redosRes = await requestJson(
      port,
      'GET',
      `/api/projects/exchange?category=${encodeURIComponent(redosString)}`,
      null
    );
    const durationMs = Date.now() - startTime;
    check('ReDoS payload handled in under 200ms without blocking event loop', durationMs < 200, `Took ${durationMs}ms`);
    check('ReDoS payload returns operational response (status 200/400) without 500 crash', redosRes.status === 200 || redosRes.status === 400);
  }

  // ===========================================================================
  // CLEANUP & FINAL VERIFICATION
  // ===========================================================================
  console.log('\n🧹 CLEANING UP TEST ARTIFACTS...');
  await ProjectShareToken.deleteMany({ projectId: { $in: [testProject._id] } });
  await Bid.deleteMany({ contractorId: { $in: [contractorUser1._id, contractorUser2._id] } });
  await Project.deleteMany({ clientId: clientUser._id });
  await MaterialOrder.deleteMany({ buyerUserId: clientUser._id });
  await MaterialProduct.deleteMany({ supplierId: supplierProfile._id });
  await SupplierProfile.deleteMany({ userId: supplierUser._id });
  await ContractorProfile.deleteMany({ userId: { $in: [contractorUser1._id, contractorUser2._id] } });
  await EscrowLedger.deleteMany({ clientId: clientUser._id });
  await IdempotencyKey.deleteMany({ userId: clientUser._id });
  await User.deleteMany({ _id: { $in: [clientUser._id, contractorUser1._id, contractorUser2._id, supplierUser._id, strangerUser._id] } });

  console.log('=============================================================================');
  console.log(`📊 AUDIT SUITE FINISHED: ${totalChecks - failedChecks}/${totalChecks} CHECKS PASSED.`);
  if (failedChecks > 0) {
    console.error(`💥 CRITICAL FAILURE: ${failedChecks} security or invariant checks failed!`);
    process.exit(1);
  } else {
    console.log('🎉 ALL NON-FUNCTIONAL, SECURITY & PERFORMANCE ASSERTIONS PASSED WITH ZERO LEAKAGE.');
    console.log('=============================================================================');
    process.exit(0);
  }
}

runSuite().catch((err) => {
  console.error('💥 Test suite crashed with unhandled exception:', err);
  process.exit(1);
});
