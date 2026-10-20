// tests/supplier-kyc-e2e.js
// End-to-end verification of Phase 1 (WP 1.1):
//   - Supplier Role & Profile Model
//   - Supplier Onboarding & KYC Submission (POST /api/supplier/profile)
//   - Duplicate Trade License Handling (409 Conflict)
//   - Self-Inspection (GET /api/supplier/me)
//   - Admin Verification Queue (GET /api/supplier/pending)
//   - Admin Verification Decision (PATCH /api/supplier/:userId/verify)
//   - Distributed Transaction & HMAC-sealed AuditLog emission
//   - Public Directory with PII Scrubbing (GET /api/supplier/directory)
//   - Public Single Card Lookup (GET /api/supplier/:id)
'use strict';

const dotenv = require('dotenv');
dotenv.config();
process.env.PORT = '0';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

const User = require('../models/User');
const { SupplierProfile } = require('../models/SupplierProfile');
const AuditLog = require('../models/AuditLog');

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
  if (!appServer.listening) {
    await new Promise((r) => appServer.once('listening', r));
  }
  const base = `http://127.0.0.1:${appServer.address().port}/api`;
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('🧪 WP 1.1: Supplier KYC, Directory & Admin Verification Queue E2E');

  const mk = (role, status = 'ACTIVE') => User.create({ role, phoneNumber: phone(), status });
  const [admin, moderator, client, contractor, supplierA, supplierB] = await Promise.all([
    mk('ADMIN'),
    mk('MODERATOR'),
    mk('CLIENT'),
    mk('CONTRACTOR'),
    mk('SUPPLIER'),
    mk('SUPPLIER')
  ]);

  const tok = (u) => jwt.sign({ userId: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const getReq = async (path, user) => {
    const headers = {};
    if (user) headers.Authorization = `Bearer ${tok(user)}`;
    const r = await fetch(`${base}${path}`, { headers });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const postReq = async (path, body, user) => {
    const headers = { 'Content-Type': 'application/json' };
    if (user) headers.Authorization = `Bearer ${tok(user)}`;
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const patchReq = async (path, body, user) => {
    const headers = { 'Content-Type': 'application/json' };
    if (user) headers.Authorization = `Bearer ${tok(user)}`;
    const r = await fetch(`${base}${path}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body)
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const createdIds = { profiles: [], logs: [] };

  try {
    // ── 1. Role-based Access Gate for Onboarding ─────────────────────────────
    const validPayloadA = {
      businessName: 'Bengal Steel & Cement Mills',
      tradeLicenseNumber: `TRAD-${Date.now()}-A`,
      nidNumber: '19881234567890',
      bstiLicenseNumber: 'BSTI-ROD-2026-99',
      bstiQrDocUrl: 'https://storage.buildbd.internal/docs/bsti-cert-a.pdf',
      categories: ['ROD', 'CEMENT'],
      serviceDistricts: ['Dhaka', 'Gazipur', 'Narayanganj']
    };

    const clientAttempt = await postReq('/supplier/profile', validPayloadA, client);
    check('CLIENT is refused when submitting supplier profile (403)', clientAttempt.status === 403);

    const contractorAttempt = await postReq('/supplier/profile', validPayloadA, contractor);
    check('CONTRACTOR is refused when submitting supplier profile (403)', contractorAttempt.status === 403);

    const supplierCreateA = await postReq('/supplier/profile', validPayloadA, supplierA);
    check('SUPPLIER creates KYC profile successfully (201)', supplierCreateA.status === 201 && supplierCreateA.body?.status === 'success');
    const profileA = supplierCreateA.body?.data?.profile;
    if (profileA) createdIds.profiles.push(profileA._id);

    // ── 2. Validation & Duplicate Checking ───────────────────────────────────
    const duplicateTradeAttempt = await postReq('/supplier/profile', {
      businessName: 'Duplicate Trade Attempt Ltd',
      tradeLicenseNumber: validPayloadA.tradeLicenseNumber,
      nidNumber: '19992345678901',
      categories: ['SAND'],
      serviceDistricts: ['Dhaka']
    }, supplierB);
    check('duplicate trade license number rejected with 409 Conflict', duplicateTradeAttempt.status === 409);

    const invalidCatAttempt = await postReq('/supplier/profile', {
      businessName: 'Invalid Category Supplier',
      tradeLicenseNumber: `TRAD-${Date.now()}-B`,
      nidNumber: '19992345678901',
      categories: ['NON_EXISTENT_CAT'],
      serviceDistricts: ['Dhaka']
    }, supplierB);
    check('invalid material category rejected with 400 Bad Request', invalidCatAttempt.status === 400);

    const emptyDistrictsAttempt = await postReq('/supplier/profile', {
      businessName: 'No Districts Supplier',
      tradeLicenseNumber: `TRAD-${Date.now()}-C`,
      nidNumber: '19992345678901',
      categories: ['SAND'],
      serviceDistricts: []
    }, supplierB);
    check('empty service districts rejected with 400 Bad Request', emptyDistrictsAttempt.status === 400);

    const validPayloadB = {
      businessName: 'Padma Aggregate & Sand Supplies',
      tradeLicenseNumber: `TRAD-${Date.now()}-B`,
      nidNumber: '19992345678901',
      categories: ['SAND', 'STONE'],
      serviceDistricts: ['Dhaka', 'Faridpur']
    };
    const supplierCreateB = await postReq('/supplier/profile', validPayloadB, supplierB);
    check('Supplier B creates valid KYC profile (201)', supplierCreateB.status === 201);
    const profileB = supplierCreateB.body?.data?.profile;
    if (profileB) createdIds.profiles.push(profileB._id);

    // ── 3. Self-Inspection (GET /api/supplier/me) ─────────────────────────────
    const clientMe = await getReq('/supplier/me', client);
    check('CLIENT calling /supplier/me receives 403 Forbidden', clientMe.status === 403);

    const supplierMeA = await getReq('/supplier/me', supplierA);
    check('SUPPLIER calling /supplier/me receives own profile (200)', supplierMeA.status === 200 && supplierMeA.body?.data?.profile?.businessName === validPayloadA.businessName);

    // ── 4. Admin Pending Queue (GET /api/supplier/pending) ────────────────────
    const clientQueue = await getReq('/supplier/pending', client);
    check('CLIENT cannot see pending supplier queue (403)', clientQueue.status === 403);

    const modQueue = await getReq('/supplier/pending', moderator);
    check('MODERATOR cannot see pending supplier queue (403)', modQueue.status === 403);

    const adminQueue = await getReq('/supplier/pending', admin);
    const pendingList = adminQueue.body?.data?.suppliers || [];
    const foundA = pendingList.find((s) => String(s.userId) === String(supplierA._id));
    const foundB = pendingList.find((s) => String(s.userId) === String(supplierB._id));
    check('ADMIN retrieves pending supplier queue with phone and business details', adminQueue.status === 200 && foundA && foundB);
    check('pending queue includes BSTI QR doc URL when provided', foundA && foundA.bstiQrDocUrl === validPayloadA.bstiQrDocUrl);

    // ── 5. Admin Verification & Cryptographic Audit ──────────────────────────
    const nonAdminVerify = await patchReq(`/supplier/${supplierB._id}/verify`, { status: 'REJECTED', rejectionReason: 'Fraud' }, client);
    check('CLIENT cannot execute supplier verification (403)', nonAdminVerify.status === 403);

    const rejectWithoutReason = await patchReq(`/supplier/${supplierB._id}/verify`, { status: 'REJECTED' }, admin);
    check('rejection without reason is rejected with 400 Bad Request', rejectWithoutReason.status === 400);

    const rejectB = await patchReq(`/supplier/${supplierB._id}/verify`, {
      status: 'REJECTED',
      rejectionReason: 'Trade license verification failed at city corporation registry.'
    }, admin);
    check('ADMIN rejects Supplier B with reason (200)', rejectB.status === 200 && rejectB.body?.data?.profile?.verification?.status === 'REJECTED');

    const rejectAudit = await AuditLog.findOne({
      entityId: profileB._id,
      entityType: 'SUPPLIER_PROFILE',
      action: 'SUPPLIER_REJECTED'
    });
    check('audit log records rejection with HMAC signature', Boolean(rejectAudit && rejectAudit.cryptographicSignature && AuditLog.verifyIntegrity(rejectAudit)));

    const approveA = await patchReq(`/supplier/${supplierA._id}/verify`, { status: 'VERIFIED' }, admin);
    check('ADMIN approves Supplier A (200)', approveA.status === 200 && approveA.body?.data?.profile?.verification?.status === 'VERIFIED');

    const approveAudit = await AuditLog.findOne({
      entityId: profileA._id,
      entityType: 'SUPPLIER_PROFILE',
      action: 'SUPPLIER_VERIFIED'
    });
    check('audit log records approval with HMAC signature and actor metadata', Boolean(approveAudit && approveAudit.cryptographicSignature && AuditLog.verifyIntegrity(approveAudit) && String(approveAudit.actorId) === String(admin._id)));

    const refreshedUserA = await User.findById(supplierA._id);
    check('approved supplier User.status is ACTIVE', refreshedUserA.status === 'ACTIVE');

    // ── 6. Public Directory & Privacy Projection ─────────────────────────────
    const directory = await getReq('/supplier/directory');
    const directorySuppliers = directory.body?.data?.suppliers || [];
    const dirA = directorySuppliers.find((s) => String(s._id) === String(profileA._id));
    const dirB = directorySuppliers.find((s) => String(s._id) === String(profileB._id));

    check('public directory returns verified supplier', Boolean(dirA));
    check('public directory excludes rejected or pending supplier', !dirB);
    check('public directory never leaks National ID number (PII)', dirA && dirA.nidNumber === undefined);

    const filteredDir = await getReq('/supplier/directory?category=ROD&district=Dhaka');
    check('directory filtering by category and district returns match', (filteredDir.body?.data?.suppliers || []).some((s) => String(s._id) === String(profileA._id)));

    // ── 7. Public Single Supplier Card ───────────────────────────────────────
    const singleA = await getReq(`/supplier/${profileA._id}`);
    check('public single card returns verified supplier without NID', singleA.status === 200 && singleA.body?.data?.profile?.businessName === validPayloadA.businessName && singleA.body?.data?.profile?.nidNumber === undefined);

    const singleB = await getReq(`/supplier/${profileB._id}`);
    check('public single card for unverified/rejected supplier returns 404', singleB.status === 404);

    const invalidIdLookup = await getReq('/supplier/not-a-valid-id');
    check('invalid ObjectId lookup returns 400 Bad Request', invalidIdLookup.status === 400);

  } finally {
    if (createdIds.profiles.length > 0) {
      await SupplierProfile.deleteMany({ _id: { $in: createdIds.profiles } });
    }
    await User.deleteMany({ phoneNumber: { $regex: new RegExp(`^${PHONE_PREFIX}`) } });
  }

  console.log(failed ? `--- Results: ${failed} failed ---` : '--- Results: all passed ---');
  return failed ? 1 : 0;
}

if (require.main === module) {
  main()
    .then((code) => {
      appServer.close();
      mongoose.disconnect();
      process.exit(code);
    })
    .catch((err) => {
      console.error('Fatal error in tests/supplier-kyc-e2e.js:', err);
      appServer.close();
      mongoose.disconnect();
      process.exit(1);
    });
}
