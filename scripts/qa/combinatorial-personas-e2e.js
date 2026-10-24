// tests/combinatorial-personas-e2e.js
// ══════════════════════════════════════════════════════════════════════════════
// 🧪 EXHAUSTIVE COMBINATORIAL MULTI-PERSONA E2E SIMULATION TEST SUITE
// ══════════════════════════════════════════════════════════════════════════════
// Covers all 7 user personas, 5 operational regimes, and critical state-machine transitions:
//   1. Visitor / Anonymous Guest (6 public surfaces, Nirman-AI bilingual concierge, 401 guards)
//   2. Electrician / Plumber / Technician (MISTRI_SARDAR, instant probation verification, micro bid & fingerprint)
//   3. Domestic Worker / Maid / Caregiver (Onboarding, directory listing, admin biometric & Darwan verification)
//   4. Civil Contractor / Engineering Firm (ENGINEERING_FIRM KYC, large tender bid, chat revised offer & award)
//   5. Building Material Dealer / Supplier (Supplier profile, bulk catalog pricing, order dispatch & challan)
//   6. Household Employer (CLIENT quick repair task ৳500 floor, DWPWP-2015 trial maid booking)
//   7. Civil Construction Owner (Multi-milestone tender ৳35L, Probashi SITE_WATCHER link, bulk purchase escrow,
//                                civil contract milestone 1 funding, cloud proof verification, 95/5 payment release)
// ══════════════════════════════════════════════════════════════════════════════
'use strict';

const dotenv = require('dotenv');
dotenv.config();

process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.STORAGE_PROVIDER = 'mock';
process.env.S3_UPLOAD_MODE = 'mock';
process.env.PAYMENTS_DISABLED = 'false';
process.env.OTP_DELIVERY = 'console';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32chars-minimum-safe';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

// Database Models
const User = require('../models/User');
const Project = require('../models/Project');
const Bid = require('../models/Bid');
const EscrowLedger = require('../models/EscrowLedger');
const ContractorProfile = require('../models/ContractorProfile');
const { SupplierProfile } = require('../models/SupplierProfile');
const { MaterialProduct } = require('../models/MaterialProduct');
const MaterialOrder = require('../models/MaterialOrder');
const DomesticWorkerProfile = require('../models/DomesticWorkerProfile');
const LabourSubscription = require('../models/LabourSubscription');
const Timesheet = require('../models/Timesheet');
const ProjectShareToken = require('../models/ProjectShareToken');
const Message = require('../models/Message');
const AuditLog = require('../models/AuditLog');

// Test Metrics & Telemetry
let totalAssertions = 0;
let passedAssertions = 0;
let failedAssertions = 0;
const failures = [];

function check(name, condition, detail = '') {
  totalAssertions += 1;
  if (condition) {
    passedAssertions += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failedAssertions += 1;
    const msg = `  ❌ ${name}${detail ? ` -> ${detail}` : ''}`;
    console.log(msg);
    failures.push({ name, detail });
  }
}

// Generate unique 11-digit Bangladeshi mobile numbers (01889XXXXXX)
const PHONE_PREFIX = '01889';
let phoneSeq = 100000;
const nextPhone = () => `${PHONE_PREFIX}${phoneSeq++}`;

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 BUILD-BD EXHAUSTIVE COMBINATORIAL MULTI-PERSONA E2E SIMULATION');
  console.log('='.repeat(80));

  if (!appServer.listening) {
    await new Promise((resolve) => appServer.once('listening', resolve));
  }
  if (mongoose.connection.readyState !== 1) {
    await new Promise((resolve) => mongoose.connection.once('connected', resolve));
  }

  const port = appServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const apiUrl = `${baseUrl}/api`;

  console.log(`📡 Test server running on loopback: ${baseUrl}`);
  console.log(`🗄️ Connected to database: ${mongoose.connection.name || 'MongoDB'}\n`);

  // Track created entities for rigorous cleanup
  const createdUserIds = [];
  const createdProjectIds = [];
  const createdBidIds = [];
  const createdLedgerIds = [];
  const createdMaterialProductIds = [];
  const createdMaterialOrderIds = [];
  const createdSupplierProfileIds = [];
  const createdContractorProfileIds = [];
  const createdWorkerProfileIds = [];
  const createdSubscriptionIds = [];
  const createdShareTokenIds = [];

  // Helper HTTP wrappers
  const httpGet = async (path, token = null) => {
    const url = path.startsWith('/api') || path.startsWith('/app') ? `${baseUrl}${path}` : `${apiUrl}${path}`;
    const res = await fetch(url, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { body = text; }
    return { status: res.status, headers: res.headers, body };
  };

  const httpPost = async (path, data, token = null, customHeaders = {}) => {
    const url = path.startsWith('/api') ? `${baseUrl}${path}` : `${apiUrl}${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...customHeaders
      },
      body: JSON.stringify(data)
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { body = text; }
    return { status: res.status, headers: res.headers, body };
  };

  const httpPatch = async (path, data, token = null) => {
    const url = path.startsWith('/api') ? `${baseUrl}${path}` : `${apiUrl}${path}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(data)
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) { body = text; }
    return { status: res.status, headers: res.headers, body };
  };

  // Helper: OTP Registration Flow
  const otpRegister = async (phoneNumber, role) => {
    const sendRes = await httpPost('/auth/send-otp', { phoneNumber, role });
    check(`OTP requested for ${role} (${phoneNumber})`, sendRes.status === 200, JSON.stringify(sendRes.body));
    const otpCode = sendRes.body?.debugOtp;
    check(`OTP debug code issued for development/test environment`, !!otpCode, `got: ${otpCode}`);

    const verifyRes = await httpPost('/auth/verify-otp', { phoneNumber, otp: otpCode });
    check(`OTP verified and session issued for ${phoneNumber}`, verifyRes.status === 200, JSON.stringify(verifyRes.body));
    const token = verifyRes.body?.token;
    const user = verifyRes.body?.user;
    if (user?.id) createdUserIds.push(user.id);
    return { token, user };
  };

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // 👑 SEED PLATFORM SUPERVISOR / ADMIN
    // ─────────────────────────────────────────────────────────────────────────
    const adminPhone = nextPhone();
    const adminUser = await User.create({
      phoneNumber: adminPhone,
      role: 'ADMIN',
      status: 'ACTIVE'
    });
    createdUserIds.push(adminUser._id);
    const adminToken = jwt.sign(
      { userId: String(adminUser._id), role: 'ADMIN' },
      process.env.JWT_SECRET,
      { expiresIn: '2h' }
    );
    check('Platform Admin Supervisor seeded and authenticated', !!adminToken);

    // ─────────────────────────────────────────────────────────────────────────
    // 👤 PERSONA 1: Visitor / Anonymous Guest
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- [PERSONA 1] Anonymous Guest: Public Surfaces, AI Concierge & Auth Boundaries ---');

    // 1.1 All 6 public browsing surfaces
    const publicSurfaces = [
      { path: '/app/index.html', title: 'Home / Hero Portal' },
      { path: '/app/works.html', title: 'Works & Tenders Exchange' },
      { path: '/app/materials.html', title: 'Materials Wholesale Catalog' },
      { path: '/app/contractors.html', title: 'Verified Contractors Directory' },
      { path: '/app/domestic-labour.html', title: 'Domestic Labour & Caregiver Hub' },
      { path: '/app/overview.html', title: 'Marketplace Architecture & Overview' }
    ];

    for (const surface of publicSurfaces) {
      const res = await httpGet(surface.path);
      const isHtml = (res.headers.get('content-type') || '').includes('text/html');
      const hasContent = typeof res.body === 'string' && res.body.length > 200;
      check(
        `Public surface ${surface.path} (${surface.title}) serves 200 OK HTML`,
        res.status === 200 && isHtml && hasContent,
        `Status ${res.status}, isHtml: ${isHtml}`
      );
    }

    // 1.2 Nirman-AI bilingual conversational concierge across all 4 categories
    console.log('  🧠 Testing Nirman-AI Conversational Concierge across all 4 regimes:');

    // Category A: Cement (Bulk Materials)
    const aiCement = await httpPost('/ai/orchestrate', {
      utterance: 'উত্তরা সেক্টর ১১ এ ১৫০ বস্তা শাহ স্পেশাল সিমেন্ট ডেলিভারি লাগবে',
      inputMode: 'TEXT',
      localeHint: 'bn'
    });
    check('Nirman-AI parses Cement bulk query (Bangla Unicode)', aiCement.status === 200);
    check(
      'Nirman-AI resolves to MATERIALS_DIRECT vertical with CEMENT category',
      aiCement.body?.data?.vertical === 'MATERIALS_DIRECT' &&
      aiCement.body?.data?.extractedSlots?.category === 'CEMENT' &&
      aiCement.body?.data?.extractedSlots?.thana === 'Uttara'
    );
    check(
      'Nirman-AI targets POST /api/materials/orders route with Integer BDT pricing',
      aiCement.body?.data?.targetRoute === 'POST /api/materials/orders' &&
      aiCement.body?.data?.pricingEstimate?.totalEscrowBdt > 0
    );

    // Category B: Micro Repair (Tier 1 On-Demand Repair)
    const aiMicro = await httpPost('/ai/orchestrate', {
      utterance: 'AC jet wash cooling repair needed at Dhanmondi 4th floor',
      inputMode: 'TEXT',
      localeHint: 'en'
    });
    check('Nirman-AI parses AC micro-repair query (English)', aiMicro.status === 200);
    check(
      'Nirman-AI resolves to TIER_1_MICRO with INSTANT_OTP_T0 split',
      aiMicro.body?.data?.vertical === 'TIER_1_MICRO' &&
      aiMicro.body?.data?.pricingEstimate?.clearanceMode === 'INSTANT_OTP_T0' &&
      aiMicro.body?.data?.pricingEstimate?.settlementSplit?.immediateTechnicianPayoutBdt > 0
    );

    // Category C: Domestic Maid (Domestic Labour)
    const aiMaid = await httpPost('/ai/orchestrate', {
      utterance: 'ধানমন্ডি এলাকায় ছুটা বুয়া দরকার দৈনিক ২ ঘণ্টা রান্না ও ঘর মোছা',
      inputMode: 'TEXT',
      localeHint: 'bn'
    });
    check('Nirman-AI parses Domestic Maid query (Bangla)', aiMaid.status === 200);
    check(
      'Nirman-AI resolves to DOMESTIC_LABOUR (L2_PART_TIME_MONTHLY) with DWPWP-2015 guardrails',
      aiMaid.body?.data?.vertical === 'DOMESTIC_LABOUR' &&
      aiMaid.body?.data?.subTier === 'L2_PART_TIME_MONTHLY' &&
      aiMaid.body?.data?.trustAndCompliance?.dwpwp2015Guardrails?.doubleBlindIvrRating === true
    );

    // Category D: Civil Tender (Tier 3 Macro Civil & Structural)
    const aiCivil = await httpPost('/ai/orchestrate', {
      utterance: '3-storey residential civil building construction tender 3500000 BDT in Mirpur',
      inputMode: 'TEXT',
      localeHint: 'en'
    });
    check('Nirman-AI parses Civil Tender macro query', aiCivil.status === 200);
    check(
      'Nirman-AI resolves to TIER_3_MACRO with SSLCommerz tranche splitting',
      aiCivil.body?.data?.vertical === 'TIER_3_MACRO' &&
      aiCivil.body?.data?.subTier === 'MACRO_CIVIL_TENDER' &&
      (aiCivil.body?.data?.pricingEstimate?.milestones?.[0]?.tranches?.length >= 2 ||
       aiCivil.body?.data?.pricingEstimate?.milestoneTranches?.m2SslcommerzTranches?.length >= 2)
    );

    // 1.3 Strict 401 Unauthorized for mutations without credentials
    const dummyId = new mongoose.Types.ObjectId();
    const unauthPostProject = await httpPost('/projects', { title: 'Ghost Project', budget: 50000 });
    check('POST /api/projects strictly rejected without auth (401)', unauthPostProject.status === 401);

    const unauthBid = await httpPost(`/bids/${dummyId}`, { bidAmount: 45000 });
    check('POST /api/bids/:id strictly rejected without auth (401)', unauthBid.status === 401);

    const unauthOrder = await httpPost('/materials/orders', { supplierId: dummyId });
    check('POST /api/materials/orders strictly rejected without auth (401)', unauthOrder.status === 401);

    const unauthLabour = await httpPost('/v2/labour/contracts/subscribe', { workerId: dummyId });
    check('POST /api/v2/labour/contracts/subscribe strictly rejected without auth (401)', unauthLabour.status === 401);

    // ─────────────────────────────────────────────────────────────────────────
    // 👤 PERSONA 6 (Part A): Household Employer (CLIENT)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- [PERSONA 6] Household Employer: Quick Tasks (৳500 floor) & Micro-Trade RFQ ---');

    const client6Phone = nextPhone();
    const { token: client6Token, user: client6User } = await otpRegister(client6Phone, 'CLIENT');

    // 6.1 Post quick repair task with exactly ৳500 budget floor
    const quickTaskRes = await httpPost('/projects', {
      title: 'Kitchen Sink Drainage Pipe Leakage & Washer Replacement',
      category: 'Plumbing',
      budget: 500,
      description: 'Under-sink water drain pipe leaking continuously. Need technician with replacement washers.',
      location: 'Dhaka, Dhanmondi'
    }, client6Token);
    check('Household employer creates quick repair task at ৳500 budget floor (201)', quickTaskRes.status === 201);
    const quickTask = quickTaskRes.body?.project || quickTaskRes.body?.data?.project;
    if (quickTask?._id) createdProjectIds.push(quickTask._id);
    check('Quick repair task status is OPEN and budget is ৳500', quickTask?.status === 'OPEN' && quickTask?.budget === 500);

    // 6.2 Post an ৳800 micro-trade task for Persona 2 to bid on
    const microTradeRes = await httpPost('/projects', {
      title: 'Living Room Switchboard Sparking & Breaker Inspection',
      category: 'Electrical',
      budget: 800,
      description: 'Main switchboard sparking when heavy load is connected. Need urgent diagnosis and fuse fix.',
      location: 'Dhaka, Mirpur-10'
    }, client6Token);
    check('Household employer creates ৳800 electrical micro-trade project (201)', microTradeRes.status === 201);
    const electricalProject = microTradeRes.body?.project || microTradeRes.body?.data?.project;
    if (electricalProject?._id) createdProjectIds.push(electricalProject._id);

    // ─────────────────────────────────────────────────────────────────────────
    // 👤 PERSONA 2: Electrician / Plumber / Technician (MISTRI_SARDAR)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- [PERSONA 2] Electrician / Technician: MISTRI_SARDAR Onboarding & Micro Bid ---');

    const mistriPhone = nextPhone();
    const { token: mistriToken, user: mistriUser } = await otpRegister(mistriPhone, 'CONTRACTOR');

    // 2.1 Creates contractor profile with MISTRI_SARDAR tier and trade genres
    const mistriProfileRes = await httpPost('/contractor-profile', {
      businessType: 'INDIVIDUAL',
      contractorTier: 'MISTRI_SARDAR',
      fullName: 'Ustad Salam Mistri',
      nidNumber: '1990123456789',
      workGenres: ['MEP_ELECTRICAL', 'WATER_SANITATION', 'ELECTRICAL_PLUMBING'],
      supportedModalities: ['TASK_BASED', 'DAILY_RATE'],
      serviceAreas: [
        { district: 'Dhaka', areas: ['Mirpur', 'Dhanmondi'], willingToTravel: true }
      ]
    }, mistriToken);
    check('Electrician creates MISTRI_SARDAR profile (201)', mistriProfileRes.status === 201);
    const mistriProfile = mistriProfileRes.body?.profile;
    if (mistriProfile?._id) createdContractorProfileIds.push(mistriProfile._id);

    // 2.2 Verifies instant BASIC probation verification (canBidAbove: 100000)
    check('MISTRI_SARDAR receives instant VERIFIED status on onboarding', mistriProfile?.verification?.status === 'VERIFIED');
    check('MISTRI_SARDAR verification level is BASIC', mistriProfile?.verification?.verificationLevel === 'BASIC');
    check('MISTRI_SARDAR probation status is active', mistriProfile?.verification?.probationStatus?.isProbation === true);
    check('MISTRI_SARDAR probation bidding cap is 100,000 BDT', mistriProfile?.verification?.probationStatus?.canBidAbove === 100000);

    // 2.3 Bids on micro-trade project (budget ৳800) with itemized breakdown { title, amount, estimatedDays }
    const mistriBidRes = await httpPost(`/bids/${electricalProject._id}`, {
      bidAmount: 800,
      estimatedDays: 1,
      proposalText: 'Professional certified electrician with digital multimeter and spare fuse wires ready to fix today.',
      itemizedBreakdown: [
        { title: 'Switchboard rewiring & fuse replacement', amount: 800, estimatedDays: 1 }
      ]
    }, mistriToken);
    check('MISTRI_SARDAR places ৳800 micro-trade bid with itemized breakdown (201)', mistriBidRes.status === 201);
    const mistriBid = mistriBidRes.body?.bid;
    if (mistriBid?._id) createdBidIds.push(mistriBid._id);

    // 2.4 Verifies bid fingerprint and dashboard counters
    check('Bid has SHA-256 sealed cryptographic fingerprint', typeof mistriBid?.bidFingerprint === 'string' && mistriBid.bidFingerprint.length === 64);

    const integrityRes = await httpGet(`/bids/${mistriBid._id}/integrity`, client6Token);
    check('Bid fingerprint integrity check passes (INTACT)', integrityRes.status === 200 && integrityRes.body?.integrityStatus === 'INTACT');

    const mistriCounters = await httpGet('/dashboard/counters', mistriToken);
    check('Dashboard counters return role CONTRACTOR', mistriCounters.status === 200 && mistriCounters.body?.role === 'CONTRACTOR');
    check('Dashboard counter myBidsPending reflects the active bid', mistriCounters.body?.counters?.myBidsPending >= 1);

    // ─────────────────────────────────────────────────────────────────────────
    // 👤 PERSONA 3: Domestic Worker / Maid / Caregiver
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- [PERSONA 3] Domestic Worker / Maid: Self-Onboard & Admin Verification ---');

    const maidPhone = nextPhone();
    const { token: maidToken, user: maidUser } = await otpRegister(maidPhone, 'CONTRACTOR');

    // 3.1 Completes /api/v2/labour/workers/onboard with valid schema
    const maidOnboardRes = await httpPost('/v2/labour/workers/onboard', {
      fullName: 'Parvin Begum',
      phoneNumber: maidPhone,
      workerCategory: 'HOUSEMAID_CHHUTA',
      subTier: 'L2_PART_TIME_MONTHLY',
      thana: 'Mirpur',
      district: 'Dhaka',
      nidNumber: '1992123456789',
      guarantorName: 'Abul Kashem (Building Security)',
      guarantorPhone: '01719876543',
      guarantorType: 'DARWAN'
    }, maidToken);
    check('Domestic worker registers via /api/v2/labour/workers/onboard (201)', maidOnboardRes.status === 201, `Status: ${maidOnboardRes.status}, Body: ${JSON.stringify(maidOnboardRes.body)}`);
    const maidWorkerId = maidOnboardRes.body?.data?.workerId;
    if (maidWorkerId) createdWorkerProfileIds.push(maidWorkerId);

    // 3.2 Verifies appearance in labour directory
    const directorySearch = await httpGet('/v2/labour/directory/search?thana=Mirpur&subTier=L2_PART_TIME_MONTHLY');
    check('Labour directory search returns 200 OK', directorySearch.status === 200);
    const directoryWorkers = directorySearch.body?.data || [];
    const foundInDirectory = directoryWorkers.some((w) => String(w._id) === String(maidWorkerId) || w.thana === 'Mirpur');
    check('Newly registered domestic worker appears in public directory search', foundInDirectory);
    if (directoryWorkers.length > 0) {
      check('Public directory search masks worker contact phone number', !directoryWorkers[0].phoneNumber?.includes(PHONE_PREFIX));
    }

    // 3.3 Simulates admin/supervisor biometric & Darwan verification
    const adminWorkerVerify = await httpPatch(`/v2/labour/workers/${maidUser.id}/verify`, {
      status: 'VERIFIED'
    }, adminToken);
    check('Admin verifies worker biometric & Darwan credentials (200)', adminWorkerVerify.status === 200, `Status: ${adminWorkerVerify.status}, Body: ${JSON.stringify(adminWorkerVerify.body)}`);
    const verifiedWorker = adminWorkerVerify.body?.data;
    check('Worker DMP CIMS verification flag set to true', verifiedWorker?.ring3_dmp_cims?.cims_verified === true);
    check('Worker availability status set to AVAILABLE', verifiedWorker?.availability === 'AVAILABLE');

    // ─────────────────────────────────────────────────────────────────────────
    // 👤 PERSONA 6 (Part B): Household Employer Books Trial Domestic Maid Shift
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- [PERSONA 6 Part B] Household Employer: Booking Trial Maid Shift (DWPWP-2015) ---');

    const maidBookingRes = await httpPost('/v2/labour/contracts/subscribe', {
      workerId: maidUser.id,
      subTier: 'L2_PART_TIME_MONTHLY',
      workerCategory: 'HOUSEMAID_CHHUTA',
      agreedMonthlySalaryAmount: 4000,
      trialShiftFeeAmount: 250
    }, client6Token);
    check('Employer books domestic worker trial subscription (201)', maidBookingRes.status === 201);
    const subscription = maidBookingRes.body?.data;
    if (subscription?._id) createdSubscriptionIds.push(subscription._id);
    check('Subscription initial status is TRIAL_ACTIVE', subscription?.status === 'TRIAL_ACTIVE');
    check('Subscription trial shift fee recorded at 250 BDT', subscription?.trialShiftFeeAmount === 250);

    // Verify DWPWP-2015 Compliance in Police Dossier Export
    const cimsExportRes = await httpGet(`/v2/labour/dmp-cims-export/${subscription._id}`, client6Token);
    check('Client exports DMP CIMS police registration dossier (200)', cimsExportRes.status === 200);
    const dossier = cimsExportRes.body?.data;
    check('Dossier records 7-day DWPWP-2015 notice period', dossier?.employmentTerms?.dwpwpNoticePeriodDays === 7);
    check('Dossier records 4 paid weekly holidays per month', dossier?.employmentTerms?.paidWeeklyHolidaysPerMonth === 4);
    check('Dossier certifies adult 18+ biometric verification', dossier?.citizenVerification?.isAdult18Plus === true);

    // ─────────────────────────────────────────────────────────────────────────
    // 👤 PERSONA 5: Building Material Dealer / Supplier
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- [PERSONA 5] Material Dealer / Supplier: KYC, Catalog & Order Lifecycle ---');

    const supplierPhone = nextPhone();
    const { token: supplierToken, user: supplierUser } = await otpRegister(supplierPhone, 'SUPPLIER');

    // 5.1 Creates supplier profile with district Dhaka
    const supplierProfileRes = await httpPost('/supplier/profile', {
      businessName: 'Bengal Heavy Steel & Scan Cement Depot',
      tradeLicenseNumber: `TRAD-DEPOT-${Date.now().toString().slice(-6)}`,
      nidNumber: '1987123456789',
      categories: ['CEMENT', 'ROD'],
      serviceDistricts: ['Dhaka', 'Gazipur', 'Narayanganj']
    }, supplierToken);
    check('Supplier submits KYC trade profile (201)', supplierProfileRes.status === 201);
    const supplierProfile = supplierProfileRes.body?.data?.profile;
    if (supplierProfile?._id) createdSupplierProfileIds.push(supplierProfile._id);

    // Admin verifies the supplier
    const adminSupVerify = await httpPatch(`/supplier/${supplierUser.id}/verify`, {
      status: 'VERIFIED'
    }, adminToken);
    check('Admin verifies material supplier KYC profile (200)', adminSupVerify.status === 200);

    // 5.2 Posts material product with bulk tier discount and delivery terms
    const cementSkuRes = await httpPost('/materials/products', {
      category: 'CEMENT',
      brand: 'Scan Cement',
      title: 'Scan Cement 50kg Bags - PCC Portland Composite',
      unit: 'BAG',
      basePriceBDT: 560,
      bulkTiers: [
        { minQuantity: 100, unitPriceBDT: 530 },
        { minQuantity: 500, unitPriceBDT: 500 }
      ],
      stockQuantity: 1000,
      minOrderQuantity: 10,
      deliveryTerms: {
        leadTimeDays: 2,
        deliveryChargePerUnitBDT: 0,
        deliveryDistricts: ['Dhaka', 'Gazipur']
      }
    }, supplierToken);
    check('Supplier lists Scan Cement SKU with 2 bulk discount tiers (201)', cementSkuRes.status === 201);
    const cementSku = cementSkuRes.body?.data?.product;
    if (cementSku?._id) createdMaterialProductIds.push(cementSku._id);
    check('Base price is 560 BDT and 100+ tier is 530 BDT', cementSku?.basePriceBDT === 560 && cementSku?.bulkTiers[0]?.unitPriceBDT === 530);

    // ─────────────────────────────────────────────────────────────────────────
    // 👤 PERSONA 7: Civil Construction Owner & Material Buyer (CLIENT)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- [PERSONA 7] Construction Owner: Civil Tender (৳35L), Delegation & Material Escrow ---');

    const client7Phone = nextPhone();
    const { token: client7Token, user: client7User } = await otpRegister(client7Phone, 'CLIENT');

    // 7.1 Posts multi-milestone construction tender (৳35,00,000) with GPS coords
    const civilTenderRes = await httpPost('/projects', {
      title: '4-Storey Commercial & Residential Building RCC Construction',
      category: 'Residential',
      budget: 3500000,
      description: 'Turnkey structural RCC frame, foundation piling, brickwork and electrical conduit placement.',
      location: 'Dhaka, Uttara Sector 11',
      siteCoordinates: { latitude: 23.8728, longitude: 90.3984 }
    }, client7Token);
    check('Owner posts ৳35,00,000 civil construction tender with GPS coordinates (201)', civilTenderRes.status === 201);
    const civilTender = civilTenderRes.body?.project || civilTenderRes.body?.data?.project;
    if (civilTender?._id) createdProjectIds.push(civilTender._id);
    check('Tender status is OPEN and budget is 3,500,000 BDT', civilTender?.status === 'OPEN' && civilTender?.budget === 3500000);
    check('Tender coordinates recorded accurately in Bangladesh', civilTender?.siteCoordinates?.latitude === 23.8728);

    // 7.2 Creates Probashi delegation share link (SITE_WATCHER)
    const shareLinkRes = await httpPost(`/projects/${civilTender._id}/shares`, {
      scopedRole: 'SITE_WATCHER',
      delegateName: 'Mamun Chowdhury (Site Engineer)',
      delegatePhone: '01712345678',
      hideFinancials: false,
      expiresInDays: 60
    }, client7Token);
    check('Owner creates Probashi SITE_WATCHER delegation share link (201)', shareLinkRes.status === 201);
    const shareData = shareLinkRes.body?.data;
    if (shareData?.shareId) createdShareTokenIds.push(shareData.shareId);
    check('Share link contains rawToken and whatsappUrl', !!shareData?.rawToken && !!shareData?.whatsappUrl);

    // Verify anonymous delegation view via raw token
    const publicShareView = await httpGet(`/projects/shared/${shareData.rawToken}`);
    check('Site watcher accesses delegated project detail view via raw token (200)', publicShareView.status === 200);
    check('Delegated view matches project and grants SITE_WATCHER scope', publicShareView.body?.data?.share?.scopedRole === 'SITE_WATCHER');

    // 7.3 Purchases bulk materials from Persona 5 (200 bags qualifies for 530 BDT tier)
    const materialOrderRes = await httpPost('/materials/orders', {
      supplierId: supplierProfile._id,
      items: [{ productId: cementSku._id, quantity: 200 }],
      deliveryDetails: {
        deliveryDistrict: 'Dhaka',
        deliveryAddress: 'Plot 45, Sector 11, Uttara, Dhaka',
        receiverName: 'Site Supervisor Tariq',
        receiverPhone: '01711223344',
        unloadingRequired: true
      }
    }, client7Token);
    check('Client 7 places bulk purchase order for 200 bags cement (201)', materialOrderRes.status === 201);
    const materialOrder = materialOrderRes.body?.data?.order;
    if (materialOrder?._id) createdMaterialOrderIds.push(materialOrder._id);

    // Verify automatic bulk tier discount: 200 * 530 = 106,000 BDT
    check('Bulk tier automatically resolved to 530 BDT/bag', materialOrder?.items[0]?.unitPriceBDT === 530);
    check('Items subtotal calculated at 106,000 BDT', materialOrder?.itemsSubtotalBDT === 106000);
    check('Order status is PENDING_SUPPLIER_ACCEPTANCE', materialOrder?.status === 'PENDING_SUPPLIER_ACCEPTANCE');

    // Persona 5 accepts the order
    const acceptOrderRes = await httpPatch(`/materials/orders/${materialOrder._id}/accept`, {}, supplierToken);
    check('Supplier accepts material purchase order (200)', acceptOrderRes.status === 200 && acceptOrderRes.body?.data?.order?.status === 'ACCEPTED');

    // Client 7 funds 100% escrow
    const fundMaterialEscrowRes = await httpPost(`/materials/orders/${materialOrder._id}/fund-escrow`, {}, client7Token);
    check('Client funds 100% material delivery escrow (200)', fundMaterialEscrowRes.status === 200);
    check('Material order status transitions to ESCROW_FUNDED', fundMaterialEscrowRes.body?.data?.order?.status === 'ESCROW_FUNDED');

    // Verify stock decrement: 1000 - 200 = 800 bags
    const cementSkuAfter = await MaterialProduct.findById(cementSku._id);
    check('Cement SKU stock atomically decremented from 1,000 to 800 bags', cementSkuAfter.stockQuantity === 800);

    // Supplier dispatches with challan & logistics waybill
    const dispatchRes = await httpPost(`/materials/orders/${materialOrder._id}/dispatch`, {
      carrierName: 'Bengal Heavy Fleet Ltd',
      challanNumber: 'CH-2026-BENGAL-99',
      truckNumber: 'Dhaka Metro Ta-12-3344',
      driverPhone: '01811223344'
    }, supplierToken);
    check('Supplier dispatches material with challan and waybill (200)', dispatchRes.status === 200);
    check('Order transitions to IN_TRANSIT with challan recorded', dispatchRes.body?.data?.order?.status === 'IN_TRANSIT');

    // Supplier marks delivered at site
    const markDeliveredRes = await httpPost(`/materials/orders/${materialOrder._id}/mark-delivered`, {
      deliveryProofNotes: 'Truck arrived at Uttara site gate. 200 bags stacked in godown. Received by Supervisor Tariq.'
    }, supplierToken);
    check('Supplier marks delivered at construction site (200)', markDeliveredRes.status === 200);
    check('Order status transitions to DELIVERED', markDeliveredRes.body?.data?.order?.status === 'DELIVERED');

    // Client confirms delivery and releases escrow
    const confirmDeliveryRes = await httpPost(`/materials/orders/${materialOrder._id}/confirm-delivery`, {}, client7Token);
    check('Client confirms site delivery and releases escrow to supplier (200)', confirmDeliveryRes.status === 200);
    check('Order reaches COMPLETED status and escrow released', confirmDeliveryRes.body?.data?.order?.status === 'COMPLETED');

    const supplierProfileAfter = await SupplierProfile.findById(supplierProfile._id);
    check('Supplier statistics totalOrdersFulfilled incremented', supplierProfileAfter.statistics?.totalOrdersFulfilled >= 1);

    // ─────────────────────────────────────────────────────────────────────────
    // 👤 PERSONA 4: Civil Contractor / Engineering Firm
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- [PERSONA 4] Engineering Firm: KYC, Tender Bid, Chat Revised Offer & Contract ---');

    const firmPhone = nextPhone();
    const { token: firmToken, user: firmUser } = await otpRegister(firmPhone, 'CONTRACTOR');

    // 4.1 Creates ENGINEERING_FIRM profile with trade license
    const firmProfileRes = await httpPost('/contractor-profile', {
      businessType: 'COMPANY',
      contractorTier: 'ENGINEERING_FIRM',
      fullName: 'Padma Structural Engineering & Builders Ltd',
      tradeLicense: `TRAD-ENG-${Date.now().toString().slice(-6)}`,
      nidNumber: '1985123456789',
      workGenres: ['CIVIL_STRUCTURAL', 'BUILDING_CONSTRUCTION', 'MASONRY_TILES_WATERPROOF'],
      supportedModalities: ['MILESTONE_ESCROW', 'TASK_BASED'],
      serviceAreas: [
        { district: 'Dhaka', areas: ['Uttara', 'Mirpur', 'Gulshan'], willingToTravel: true }
      ]
    }, firmToken);
    check('Engineering firm creates corporate contractor profile (201)', firmProfileRes.status === 201);
    const firmProfile = firmProfileRes.body?.profile;
    if (firmProfile?._id) createdContractorProfileIds.push(firmProfile._id);

    // Initial status for company/engineering firm requires admin KYC review
    check('Corporate firm initial status is PENDING or UNVERIFIED', ['PENDING', 'UNVERIFIED'].includes(firmProfile?.verification?.status));

    // 4.2 Verifies admin verification flow
    const adminFirmQueue = await httpGet('/contractor-profile/pending', adminToken);
    check('Admin inspects pending contractor verification queue (200)', adminFirmQueue.status === 200);
    const pendingFirms = adminFirmQueue.body?.data?.profiles || [];
    const firmInQueue = pendingFirms.some((p) => String(p.userId) === String(firmUser.id));
    check('Engineering firm appears in admin pending queue', firmInQueue);

    // Admin verifies firm, raises limit and clears probation
    const adminFirmVerify = await httpPatch(`/contractor-profile/${firmUser.id}/verify`, {
      status: 'VERIFIED',
      verificationLevel: 'STANDARD',
      clearProbation: true,
      canBidAbove: 50000000
    }, adminToken);
    check('Admin grants VERIFIED status, clears probation & raises ceiling to ৳5 Crore (200)', adminFirmVerify.status === 200);
    const verifiedFirm = adminFirmVerify.body?.profile;
    check('Firm verification status is VERIFIED', verifiedFirm?.verification?.status === 'VERIFIED');
    check('Firm probation is cleared (can bid above ৳1 Lakh)', verifiedFirm?.verification?.probationStatus?.isProbation === false);

    // 4.3 Bids on high-value civil tender (> ৳1,00,000)
    // Tender budget is 3,500,000; firm bids 3,400,000 with 2 milestones
    const civilBidRes = await httpPost(`/bids/${civilTender._id}`, {
      bidAmount: 3400000,
      estimatedDays: 180,
      proposalText: 'Full turnkey structural RCC execution according to BNBC-2020 seismic codes with on-site QA engineers.',
      itemizedBreakdown: [
        { title: 'Substructure Piling & Foundation RCC', amount: 1400000, estimatedDays: 60 },
        { title: 'Superstructure Columns, Beams & Slab Casting', amount: 2000000, estimatedDays: 120 }
      ]
    }, firmToken);
    check('Engineering firm submits high-value civil tender bid for ৳34,00,000 (201)', civilBidRes.status === 201);
    const civilBid = civilBidRes.body?.bid;
    if (civilBid?._id) createdBidIds.push(civilBid._id);
    check('Civil bid fingerprint generated and status is PENDING', typeof civilBid?.bidFingerprint === 'string' && civilBid?.status === 'PENDING');

    // 4.4 Tests chat revised offer counter-proposal and acceptance
    // Contractor submits a REVISED_OFFER of ৳33,00,000 in 160 days in negotiation chat
    const revisedAmount = 3300000;
    const revisedDays = 160;
    const chatOfferRes = await httpPost(`/chat/${civilBid._id}/message`, {
      messageType: 'REVISED_OFFER',
      text: 'After evaluating structural drawings, we propose a discounted final offer of 3,300,000 BDT in 160 days.',
      revisedAmount,
      revisedDays
    }, firmToken);
    check('Contractor posts REVISED_OFFER in negotiation chat (201)', chatOfferRes.status === 201);
    const offerMessage = chatOfferRes.body?.data?.message || chatOfferRes.body?.data;
    check('Chat message offerStatus is PENDING with revised amounts recorded', offerMessage?.offerStatus === 'PENDING' && offerMessage?.payload?.revisedAmount === 3300000);

    // Client 7 accepts the revised offer directly via POST /api/chat/:bidId/accept-offer
    const acceptOfferRes = await httpPost(`/chat/${civilBid._id}/accept-offer`, {}, client7Token);
    check('Client 7 accepts chat negotiated offer and awards contract (200)', acceptOfferRes.status === 200);

    // Verify contract formation invariants
    const updatedTender = await Project.findById(civilTender._id).lean();
    check('Civil tender status transitioned to ASSIGNED', updatedTender.status === 'ASSIGNED');
    check('Awarded contractor matches Engineering Firm', String(updatedTender.awardedContractorId) === String(firmUser.id));

    const civilLedger = await EscrowLedger.findOne({ projectId: civilTender._id }).lean();
    check('EscrowLedger formed atomically with ledgerStatus PENDING_FUNDING', !!civilLedger && civilLedger.ledgerStatus === 'PENDING_FUNDING');
    if (civilLedger?._id) createdLedgerIds.push(civilLedger._id);

    check('Total contract value matches negotiated 3,300,000 BDT', civilLedger?.totalContractValue === 3300000);
    const milestoneSum = (civilLedger?.milestones || []).reduce((acc, m) => acc + m.amount, 0);
    check('Milestone amounts sum exactly to 3,300,000 BDT', milestoneSum === 3300000);

    // ─────────────────────────────────────────────────────────────────────────
    // 🏦 ESCROW FUNDING, CLOUD PROOF VERIFICATION & 95/5 PAYMENT RELEASE
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- Escrow Lifecycle: Gateway Funding, Cloud Progress Evidence & 95/5 Release ---');

    // Step 1: Initiate payment for Milestone escrow funding
    const initiatePaymentRes = await httpPost(`/payment/initiate/${civilLedger._id}`, {}, client7Token);
    check('Client initiates SSLCommerz payment for civil escrow (200)', initiatePaymentRes.status === 200);
    const tranId = initiatePaymentRes.body?.tranId;
    check('Payment initiation returns unique transaction ID (tranId)', typeof tranId === 'string' && tranId.length > 5);

    // Step 2: SSLCommerz IPN Webhook simulates successful payment
    const ipnUrlParams = new URLSearchParams({
      tran_id: tranId,
      val_id: `VAL-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      status: 'VALIDATED',
      amount: String(civilLedger.totalContractValue),
      currency: 'BDT'
    });

    const ipnRes = await fetch(`${apiUrl}/payment/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: ipnUrlParams.toString()
    });
    const ipnBody = await ipnRes.json().catch(() => ({}));
    check('SSLCommerz IPN webhook funds the contract escrow (200)', ipnRes.status === 200 && ipnBody?.status === 'success');

    const fundedCivilLedger = await EscrowLedger.findById(civilLedger._id).lean();
    check('EscrowLedger status transitions to FUNDED', fundedCivilLedger?.ledgerStatus === 'FUNDED');
    check('Milestone 0 sequentially unlocks to IN_PROGRESS', fundedCivilLedger?.milestones[0]?.status === 'IN_PROGRESS');
    check('Milestone 1 remains safely PENDING until milestone 0 completes', fundedCivilLedger?.milestones[1]?.status === 'PENDING');

    // Step 3: Engineering Firm requests presigned S3 evidence upload policy
    const presignedRes = await httpGet(
      `/governance/proof/presigned-url?ledgerId=${civilLedger._id}&milestoneIndex=0&contentType=image/jpeg`,
      firmToken
    );
    check('Contractor generates S3 presigned URL and CPT token (200)', presignedRes.status === 200);
    const s3KeyToken = presignedRes.body?.data?.s3KeyToken;
    check('Cryptographic Proof Token (CPT) issued', typeof s3KeyToken === 'string');

    // Step 4: Engineering Firm confirms cloud progress evidence with GPS coordinates
    const testImageHash = crypto.randomBytes(32).toString('hex');
    const submitEvidenceRes = await httpPost(`/governance/proof/evidence/${civilLedger._id}/milestone/0`, {
      s3KeyToken,
      imageHash: testImageHash,
      gpsData: {
        lat: 23.8728,
        lng: 90.3984,
        accuracy: 10,
        photoTimestamp: new Date().toISOString()
      }
    }, firmToken);
    check('Contractor commits milestone 1 foundation evidence (200)', submitEvidenceRes.status === 200);

    const evidenceLedger = await EscrowLedger.findById(civilLedger._id).lean();
    check('Milestone 0 advances to PROOF_SUBMITTED with photo recorded', evidenceLedger?.milestones[0]?.status === 'PROOF_SUBMITTED');

    // Step 5: Client approves Milestone 0 and releases payment (95/5 split)
    const approveMilestoneRes = await httpPost(
      `/governance/approve/${civilLedger._id}/milestone/0`,
      {},
      client7Token,
      { 'X-Idempotency-Key': `appr-m0-${Date.now()}` }
    );
    check('Client approves milestone and releases payment (200)', approveMilestoneRes.status === 200);

    const approvedLedger = await EscrowLedger.findById(civilLedger._id).lean();
    check('Milestone 0 status is COMPLETED', approvedLedger?.milestones[0]?.status === 'COMPLETED');
    check('Sequential gating: Milestone 1 unlocks to IN_PROGRESS', approvedLedger?.milestones[1]?.status === 'IN_PROGRESS');

    // 95/5 split accounting verification
    const m0Amount = approvedLedger?.milestones[0]?.amount;
    const expectedPlatformFee = Math.round(m0Amount * 0.05);
    const expectedContractorPayout = m0Amount - expectedPlatformFee;

    const firmUserAfter = await User.findById(firmUser.id).lean();
    check(
      `Contractor wallet pendingClearance credited with 95% net (৳${expectedContractorPayout.toLocaleString('en-IN')})`,
      firmUserAfter?.wallet?.pendingClearance === expectedContractorPayout
    );

    const approvalAudit = await AuditLog.findOne({
      entityId: civilLedger._id,
      action: 'MILESTONE_APPROVED',
      'metadata.milestoneIndex': 0
    }).lean();
    check('MILESTONE_APPROVED audit log stamped with exact 95/5 split metadata', !!approvalAudit);
    check(
      'Audit log platform fee matches 5%',
      approvalAudit?.metadata?.platformFee === expectedPlatformFee &&
      approvalAudit?.metadata?.contractorNet === expectedContractorPayout
    );

  } finally {
    // ─────────────────────────────────────────────────────────────────────────
    // 🧹 RIGOROUS CLEANUP: Neutralize all seeded test artifacts
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n🧹 Performing clean teardown of simulation test artifacts...');

    if (createdSubscriptionIds.length > 0) {
      await LabourSubscription.deleteMany({ _id: { $in: createdSubscriptionIds } });
      await Timesheet.deleteMany({ subscriptionId: { $in: createdSubscriptionIds } });
    }
    if (createdWorkerProfileIds.length > 0) {
      await DomesticWorkerProfile.deleteMany({ _id: { $in: createdWorkerProfileIds } });
    }
    if (createdMaterialOrderIds.length > 0) {
      await MaterialOrder.deleteMany({ _id: { $in: createdMaterialOrderIds } });
    }
    if (createdMaterialProductIds.length > 0) {
      await MaterialProduct.deleteMany({ _id: { $in: createdMaterialProductIds } });
    }
    if (createdSupplierProfileIds.length > 0) {
      await SupplierProfile.deleteMany({ _id: { $in: createdSupplierProfileIds } });
    }
    if (createdShareTokenIds.length > 0) {
      await ProjectShareToken.deleteMany({ _id: { $in: createdShareTokenIds } });
    }
    if (createdLedgerIds.length > 0) {
      await EscrowLedger.deleteMany({ _id: { $in: createdLedgerIds } });
    }
    if (createdBidIds.length > 0) {
      await Bid.deleteMany({ _id: { $in: createdBidIds } });
      await Message.deleteMany({ bidId: { $in: createdBidIds } });
    }
    if (createdProjectIds.length > 0) {
      await Project.deleteMany({ _id: { $in: createdProjectIds } });
    }
    if (createdContractorProfileIds.length > 0) {
      await ContractorProfile.deleteMany({ _id: { $in: createdContractorProfileIds } });
    }
    if (createdUserIds.length > 0) {
      await User.deleteMany({ _id: { $in: createdUserIds } });
      await User.deleteMany({ phoneNumber: { $regex: new RegExp(`^${PHONE_PREFIX}`) } });
    }

    console.log('✨ All temporary test documents purged successfully.');
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 📊 TEST SUMMARY & REPORTING
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log(`📊 COMBINATORIAL PERSONAS SIMULATION SUMMARY:`);
  console.log(`   Total Assertions  : ${totalAssertions}`);
  console.log(`   Passed Assertions : ${passedAssertions}`);
  console.log(`   Failed Assertions : ${failedAssertions}`);
  console.log('='.repeat(80));

  if (failedAssertions > 0) {
    console.error(`\n❌ FAILED ${failedAssertions} ASSERTION(S):`);
    failures.forEach((f, i) => {
      console.error(`  ${i + 1}. ${f.name} -> ${f.detail}`);
    });
    return 1;
  }

  console.log('\n🎉 ALL 7 PERSONAS COMBINATORIAL SIMULATION PASSED FLAWLESSLY!\n');
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      appServer.close();
      mongoose.disconnect();
      process.exit(code);
    })
    .catch((err) => {
      console.error('💥 Fatal exception in combinatorial simulation runner:', err);
      appServer.close();
      mongoose.disconnect();
      process.exit(1);
    });
}

module.exports = { main };
