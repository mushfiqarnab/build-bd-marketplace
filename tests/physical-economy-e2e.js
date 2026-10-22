// tests/physical-economy-e2e.js
// 🇧🇩 Comprehensive End-to-End Field Validation for Build-BD Physical Economy
// Validates:
//   1. Nirman-AI Bilingual Voice/Text Intent Orchestrator (Bangla/Banglish/English)
//   2. Domestic Labour 3-Ring Trust Architecture (Porichoy Biometrics, Digital Darwan, DMP CIMS)
//   3. DWPWP-2015 1-Day Trial Booking (৳250), Timesheet Creation, & Weekly Payroll Telemetry
//   4. 2G Telecom Feature Phone Webhook (SMS & Missed-Call IVR Check-in)
//   5. DMP CIMS Police Dossier Export & Role-Gated PII Protection
//   6. 48-Hour Police GD Gate Security Dispute Lodging
//   7. Tier 1 Micro Utility Rapid Dispatch (0 BDT Advance, Floor Hanging Surcharge, 7-Day Warranty Hold)
//   8. Anti-Collusion Spare Parts Cap Safeguard (3x labor / ৳5,000 threshold)
//   9. Tier 2 Mid Parametric Split-BOQ Renovation & Shifting Engine with 16-Bank EMI
'use strict';

const dotenv = require('dotenv');
dotenv.config({ quiet: true });
process.env.PORT = '0';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32chars-minimum-safe';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

const User = require('../models/User');
const Project = require('../models/Project');
const DomesticWorkerProfile = require('../models/DomesticWorkerProfile');
const LabourSubscription = require('../models/LabourSubscription');
const Timesheet = require('../models/Timesheet');
const AuditLog = require('../models/AuditLog');

const phone = () => '017' + Math.floor(10000000 + Math.random() * 89999999);
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function req(baseUrl, method, path, body, token) {
  const headers = { 'Content-Type': 'application/json', 'x-idempotency-key': `pe-${Date.now()}-${Math.random()}` };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, rawText: text };
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

  console.log('🧪 Build-BD Physical Economy & Domestic Escrow End-to-End Suite');

  // ── Seed Test Users ────────────────────────────────────────────────────────
  const clientPhone = phone();
  const workerPhone = phone();
  const strangerPhone = phone();

  const [clientUser, workerUser, strangerUser] = await Promise.all([
    User.create({ phoneNumber: clientPhone, role: 'CLIENT', status: 'ACTIVE' }),
    User.create({ phoneNumber: workerPhone, role: 'CONTRACTOR', status: 'ACTIVE' }),
    User.create({ phoneNumber: strangerPhone, role: 'CLIENT', status: 'ACTIVE' })
  ]);

  const clientToken = jwt.sign({ userId: String(clientUser._id), role: 'CLIENT' }, process.env.JWT_SECRET);
  const strangerToken = jwt.sign({ userId: String(strangerUser._id), role: 'CLIENT' }, process.env.JWT_SECRET);

  // ── Seed Verified Domestic Worker Profile (3-Ring Trust) ───────────────────
  const workerProfile = await DomesticWorkerProfile.create({
    userId: workerUser._id,
    fullName: 'Fatema Begum',
    phoneNumber: workerPhone,
    thana: 'Dhanmondi',
    district: 'Dhaka',
    base_coordinates: {
      type: 'Point',
      coordinates: [90.3760, 23.7465]
    },
    workerCategory: 'COOK_CHEF',
    subTier: 'L3_FULL_TIME_MONTHLY',
    monthlyRateAmount: 8000,
    dailyRateAmount: 400,
    skill_tags: [
      { tag_code: 'BANGLA_COOKING', labelEn: 'Traditional Bengali Cuisine', labelBn: 'ঐতিহ্যবাহী বাংলা রান্না', is_certified: true },
      { tag_code: 'APPLIANCE_WASHING_MACHINE', labelEn: 'Washing Machine Operation', labelBn: 'ওয়াশিং মেশিন চালনা', is_certified: true }
    ],
    ring1_porichoy: {
      face_match_percentage: 88,
      is_adult_18_plus: true,
      sim_nid_matched: true,
      porichoy_verified_at: new Date()
    },
    ring2_digital_darwan: {
      status: 'ACTIVE_VOUCHED',
      guarantor_count: 2
    },
    guarantors: [
      {
        name: 'Abdul Motin',
        phone: '01811223344',
        relationship: 'URBAN_CARETAKER_DARWAN',
        status: 'ACTIVE_VOUCHED',
        verified_via: 'IVR_VOICE_SAMPLE',
        vouched_at: new Date()
      },
      {
        name: 'Rokeya Khatun',
        phone: '01855667788',
        relationship: 'RURAL_KIN_ANCHOR',
        status: 'ACTIVE_VOUCHED',
        verified_via: 'SMS_OTP',
        vouched_at: new Date()
      }
    ],
    ring3_dmp_cims: {
      cims_tracking_ref: 'CIMS-DMP-DHAN-9021',
      qr_smart_card_hash: 'QR-HASH-FATEMA-DHANMONDI',
      cims_verified: true,
      dossier_issued_at: new Date()
    },
    availability: 'AVAILABLE'
  });

  check('DomesticWorkerProfile seeded with Ring 1 biometric match 88%', workerProfile.ring1_porichoy.face_match_percentage === 88);
  check('DomesticWorkerProfile seeded with Ring 2 guarantors', workerProfile.guarantors.length === 2);
  check('DomesticWorkerProfile seeded with Ring 3 DMP CIMS tracking ref', workerProfile.ring3_dmp_cims.cims_tracking_ref === 'CIMS-DMP-DHAN-9021');

  try {
    // ── 1. Nirman-AI Conversational Concierge API Test ───────────────────────
    const aiRes = await req(baseUrl, 'POST', '/api/ai/orchestrate', {
      utterance: 'মিরপুর ১০ এ ২ বেডরুমের বাসা রং করার আনুমানিক খরচ কত?',
      userRole: 'CLIENT'
    }, clientToken);

    check('POST /api/ai/orchestrate returns HTTP 200', aiRes.status === 200);
    check('Nirman-AI classifies TIER_2_MID renovation', aiRes.body?.data?.vertical === 'TIER_2_MID');
    check('Nirman-AI detects Mirpur thana', aiRes.body?.data?.extractedSlots?.thana === 'Mirpur');
    check('Nirman-AI flags 16-bank EMI eligibility', aiRes.body?.data?.extractedSlots?.emiEligible16Banks === true);

    // ── 2. Domestic 1-Day Trial Booking & DWPWP-2015 Digital Agreement ───────
    const subRes = await req(baseUrl, 'POST', '/api/v2/labour/contracts/subscribe', {
      workerId: String(workerUser._id),
      subTier: 'L3_FULL_TIME_MONTHLY',
      workerCategory: 'COOK_CHEF',
      agreedMonthlySalaryAmount: 8000,
      trialShiftFeeAmount: 250
    }, clientToken);

    check('POST /api/v2/labour/contracts/subscribe returns HTTP 201', subRes.status === 201);
    const subscription = subRes.body?.data;
    check('Subscription status initialized to TRIAL_ACTIVE', subscription?.status === 'TRIAL_ACTIVE');
    check('Agreed monthly salary is 8,000 BDT', subscription?.agreedMonthlySalaryAmount === 8000);
    check('Trial shift fee is 250 BDT', subscription?.trialShiftFeeAmount === 250);

    const timesheet = await Timesheet.findOne({ subscriptionId: subscription._id });
    check('Trial timesheet auto-generated', Boolean(timesheet));
    check('Timesheet attendance_status is SCHEDULED', timesheet?.attendance_status === 'SCHEDULED');

    // ── 3. Active Subscriptions Query (GET /api/v2/labour/subscriptions/mine) ─
    const mySubsRes = await req(baseUrl, 'GET', '/api/v2/labour/subscriptions/mine', undefined, clientToken);
    check('GET /api/v2/labour/subscriptions/mine returns HTTP 200', mySubsRes.status === 200);
    check('my-subscriptions count >= 1', mySubsRes.body?.count >= 1);
    check('my-subscriptions populates workerProfile', mySubsRes.body?.data?.[0]?.workerProfile?.fullName === 'Fatema Begum');

    // ── 4. 2G Feature Phone Webhook Attendance Simulation ────────────────────
    const ivrRes = await req(baseUrl, 'POST', '/api/v2/labour/webhooks/sms-ivr-inbound', {
      fromPhone: workerPhone,
      digitsOrText: '1',
      callType: 'IVR_DTMF'
    });

    check('POST /api/v2/labour/webhooks/sms-ivr-inbound returns HTTP 200', ivrRes.status === 200);
    check('IVR DTMF 1 parsed as ACCEPT_SHIFT_OR_CONFIRM_ATTENDANCE', ivrRes.body?.data?.action === 'ACCEPT_SHIFT_OR_CONFIRM_ATTENDANCE');
    check('Feature phone parsed payload includes workerPhone', ivrRes.body?.data?.workerPhone === workerPhone);

    // ── 5. DMP CIMS Police Dossier Export & Role Protection ───────────────────
    const cimsRes = await req(baseUrl, 'GET', `/api/v2/labour/dmp-cims-export/${subscription._id}`, undefined, clientToken);
    check('GET /api/v2/labour/dmp-cims-export returns HTTP 200 for owning client', cimsRes.status === 200);
    check('DMP CIMS dossier contains tracking reference', cimsRes.body?.data?.trackingReference === 'CIMS-DMP-DHAN-9021');
    check('DMP CIMS dossier confirms Porichoy biometric status', cimsRes.body?.data?.citizenVerification?.porichoyStatus === 'BIOMETRIC_VERIFIED');
    check('DMP CIMS dossier confirms 18+ adult compliance', cimsRes.body?.data?.citizenVerification?.isAdult18Plus === true);

    const strangerCimsRes = await req(baseUrl, 'GET', `/api/v2/labour/dmp-cims-export/${subscription._id}`, undefined, strangerToken);
    check('GET /api/v2/labour/dmp-cims-export returns HTTP 403 Forbidden for stranger client', strangerCimsRes.status === 403);

    // ── 6. 48-Hour Police GD Gate Security Dispute Lodging ───────────────────
    const gdRes = await req(baseUrl, 'POST', '/api/v2/labour/disputes/security-gd', {
      subscriptionId: String(subscription._id),
      timesheetId: String(timesheet._id),
      policeGdNumber: 'GD-2026-DMP-DHAN-8891',
      reason: 'Unexplained absence with duplicate house key missing'
    }, clientToken);

    check('POST /api/v2/labour/disputes/security-gd returns HTTP 200', gdRes.status === 200);
    check('Timesheet marked DISPUTED', gdRes.body?.data?.security_dispute?.is_disputed === true);
    check('Police GD number recorded', gdRes.body?.data?.security_dispute?.police_gd_number === 'GD-2026-DMP-DHAN-8891');
    check('GD verification deadline stamped', Boolean(gdRes.body?.data?.security_dispute?.gd_verification_deadline));

    const auditDispute = await AuditLog.findOne({ action: 'SECURITY_DISPUTE_FILED', entityId: subscription._id });
    check('Immutable AuditLog stamped for SECURITY_DISPUTE_FILED', Boolean(auditDispute));

    // ── 7. Tier 1 Micro Utility Rapid Dispatch (0 BDT Advance + Floor 3) ─────
    const microRes = await req(baseUrl, 'POST', '/api/v2/projects/micro/dispatch', {
      categoryCode: 'AC_MASTER_JET_WASH',
      thana: 'Dhanmondi',
      district: 'Dhaka',
      floorLevel: 3,
      baseLaborBdt: 800,
      sparePartsBdt: 0,
      description: 'AC outdoor unit deep cleaning on 3rd floor balcony'
    }, clientToken);

    check('POST /api/v2/projects/micro/dispatch returns HTTP 201', microRes.status === 201);
    check('Floor 3 appends 400 BDT outdoor unit hanging surcharge', microRes.body?.data?.outdoorHangingSurchargeBdt === 400);
    const split = microRes.body?.data?.settlementSplit;
    check('Micro gross total is 1,200 BDT (800 labor + 400 surcharge)', split?.grossTotalBdt === 1200);
    check('Immediate technician payout is 960 BDT (80%)', split?.immediateTechnicianPayoutBdt === 960);
    check('7-Day warranty hold is 120 BDT (10%)', split?.warrantyHold7DayBdt === 120);
    check('Platform fee is 120 BDT (10%)', split?.platformAndGatewayFeeBdt === 120);

    const microProject = await Project.findById(microRes.body?.data?.project?._id);
    check('Micro Project created in database with status OPEN', microProject?.status === 'OPEN');
    check('Micro Project title contains AC_MASTER_JET_WASH', microProject?.title?.includes('AC_MASTER_JET_WASH'));

    // ── 8. Anti-Collusion Spare Parts Cap Safeguard ──────────────────────────
    // Base labor 400 BDT. Max allowed parts = min(400 * 3, 5000) = 1,200 BDT.
    // If client/technician attempts 1,800 BDT parts, requiresCashMemoAudit must trigger.
    const partsCapRes = await req(baseUrl, 'POST', '/api/v2/projects/micro/dispatch', {
      categoryCode: 'PLUMBING_LEAK',
      thana: 'Mirpur',
      floorLevel: 1,
      baseLaborBdt: 400,
      sparePartsBdt: 1800,
      description: 'Kitchen pipe replacement with unverified parts'
    }, clientToken);

    check('Over-cap spare parts trigger requiresCashMemoAudit=true', partsCapRes.body?.data?.requiresCashMemoAudit === true);

    // ── 9. Tier 2 Parametric Split-BOQ Renovation & Shifting Engine ─────────
    const boqPaintingRes = await req(baseUrl, 'POST', '/api/v2/projects/mid/estimate-boq', {
      categoryCode: 'MID_PAINTING',
      thana: 'Gulshan',
      areaSqft: 1800
    }, clientToken);

    check('POST /api/v2/projects/mid/estimate-boq (Painting) returns HTTP 200', boqPaintingRes.status === 200);
    const paintEst = boqPaintingRes.body?.data?.pricingEstimate;
    check('1,800 sq ft @ 56 BDT/sq ft = 100,800 BDT total', paintEst?.totalEstimatedBdt === 100800);
    check('20% Advance Escrow is 20,160 BDT', paintEst?.advance20PctEscrowBdt === 20160);
    check('80% Completion Escrow is 80,640 BDT', paintEst?.completion80PctEscrowBdt === 80640);
    check('Split-BOQ labor is 43,445 BDT (43.1%)', paintEst?.boqSplitBreakdown?.laborBdt === 43445);
    check('Split-BOQ paint/primer is 45,259 BDT (44.9%)', paintEst?.boqSplitBreakdown?.materialKitBdt === 45259);
    check('16-Bank EMI installment enabled for orders >= 5,000 BDT', boqPaintingRes.body?.data?.extractedSlots?.emiEligible16Banks === true);

    const boqShiftingRes = await req(baseUrl, 'POST', '/api/v2/projects/mid/estimate-boq', {
      categoryCode: 'MID_SHIFTING',
      thana: 'Uttara'
    }, clientToken);

    check('POST /api/v2/projects/mid/estimate-boq (Shifting) returns HTTP 200', boqShiftingRes.status === 200);
    const shiftEst = boqShiftingRes.body?.data?.pricingEstimate;
    check('Dhaka standard home shifting is 15,000 BDT', shiftEst?.totalEstimatedBdt === 15000);
    check('Shifting labor component is 9,000 BDT', shiftEst?.boqSplitBreakdown?.laborBdt === 9000);
    check('Shifting packing materials is 3,000 BDT', shiftEst?.boqSplitBreakdown?.materialKitBdt === 3000);
  } finally {
    // ── Clean Teardown ───────────────────────────────────────────────────────
    await Promise.all([
      User.deleteMany({ _id: { $in: [clientUser._id, workerUser._id, strangerUser._id] } }),
      DomesticWorkerProfile.deleteMany({ userId: workerUser._id }),
      LabourSubscription.deleteMany({ clientId: clientUser._id }),
      Timesheet.deleteMany({ clientId: clientUser._id }),
      Project.deleteMany({ clientId: clientUser._id })
    ]);
    console.log('🧹 Cleaned up physical economy test fixtures.');
  }

  console.log(`\n🏁 Physical Economy E2E Suite Complete: ${failed === 0 ? 'ALL PASSED' : `${failed} FAILED`}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal in physical-economy-e2e:', err);
  process.exit(1);
});
