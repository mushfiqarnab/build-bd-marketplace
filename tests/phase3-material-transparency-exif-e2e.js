// tests/phase3-material-transparency-exif-e2e.js
// 🧱 Phase 3: Project Material Transparency Ledger & Chalan Verification
// Tests reconciliation of planned vs delivered materials, deterministic flag generation,
// financial scrubbing for family delegates, and client acknowledgement.
'use strict';

const dotenv = require('dotenv');
dotenv.config();
process.env.PORT = '0';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32chars-minimum-safe';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const crypto = require('crypto');
const { server: appServer } = require('../server');

const Project = require('../models/Project');
const User = require('../models/User');
const ProjectShareToken = require('../models/ProjectShareToken');
const MaterialDeliveryLog = require('../models/MaterialDeliveryLog');
const AuditLog = require('../models/AuditLog');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

function makeToken(user) {
  return jwt.sign(
    { userId: String(user._id), role: user.role, phoneNumber: user.phoneNumber },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

(async () => {
  console.log('🧪 Phase 3: Material Transparency Ledger & EXIF Reconciliation E2E');

  if (!appServer.listening) {
    await new Promise((resolve) => appServer.on('listening', resolve));
  }
  const port = appServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function api(path, { method = 'GET', token, shareToken, body, headers = {} } = {}) {
    const reqHeaders = {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': crypto.randomUUID(),
      ...headers
    };
    if (token) reqHeaders.Authorization = `Bearer ${token}`;
    if (shareToken) reqHeaders['X-Project-Share-Token'] = shareToken;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: reqHeaders,
      body: body ? JSON.stringify(body) : undefined
    });
    let data;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, ok: res.ok, body: data };
  }

  try {
    const runId = crypto.randomBytes(4).toString('hex');

    // 1. Setup Client, Contractor, and Stranger Users
    const clientUser = await User.create({
      phoneNumber: `0171${Math.floor(1000000 + Math.random() * 9000000)}`,
      role: 'CLIENT',
      status: 'ACTIVE',
      wallet: { availableToWithdraw: 500000, lockedEscrow: 0, pendingClearance: 0 }
    });
    const clientToken = makeToken(clientUser);

    const contractorUser = await User.create({
      phoneNumber: `0181${Math.floor(1000000 + Math.random() * 9000000)}`,
      role: 'CONTRACTOR',
      status: 'ACTIVE',
      wallet: { availableToWithdraw: 0, lockedEscrow: 0, pendingClearance: 0 }
    });
    const contractorToken = makeToken(contractorUser);

    const strangerUser = await User.create({
      phoneNumber: `0191${Math.floor(1000000 + Math.random() * 9000000)}`,
      role: 'CLIENT',
      status: 'ACTIVE',
      wallet: { availableToWithdraw: 0, lockedEscrow: 0, pendingClearance: 0 }
    });
    const strangerToken = makeToken(strangerUser);

    // 2. Create Project
    const project = await Project.create({
      clientId: clientUser._id,
      title: `Phase 3 Test Build ${runId}`,
      category: 'Residential',
      description: 'Testing material delivery transparency ledger and variance flags.',
      location: 'Dhanmondi, Dhaka',
      budget: 850000,
      awardedContractorId: contractorUser._id,
      status: 'ASSIGNED'
    });

    // 3. Create Delegated Share Tokens (Site Watcher & Family Viewer)
    const rawSiteWatcherToken = crypto.randomBytes(32).toString('hex');
    const siteWatcherHash = crypto.createHash('sha256').update(rawSiteWatcherToken).digest('hex');
    const siteWatcherShare = await ProjectShareToken.create({
      projectId: project._id,
      clientUserId: clientUser._id,
      tokenHash: siteWatcherHash,
      scopedRole: 'SITE_WATCHER',
      delegateName: 'Kader Chacha (Site Watcher)',
      delegatePhone: '01711223344',
      hideFinancials: true,
      expiresAt: new Date(Date.now() + 30 * 86400000)
    });

    const rawFamilyViewerToken = crypto.randomBytes(32).toString('hex');
    const familyViewerHash = crypto.createHash('sha256').update(rawFamilyViewerToken).digest('hex');
    const familyViewerShare = await ProjectShareToken.create({
      projectId: project._id,
      clientUserId: clientUser._id,
      tokenHash: familyViewerHash,
      scopedRole: 'FAMILY_VIEWER',
      delegateName: 'Bhaiya (Family Viewer in UK)',
      delegatePhone: null,
      hideFinancials: true,
      expiresAt: new Date(Date.now() + 60 * 86400000)
    });

    // ── Test 1: Family Viewer is rejected from logging delivery (403 Forbidden) ──
    const resViewerLog = await api(`/api/projects/${project._id}/materials/deliveries`, {
      method: 'POST',
      shareToken: rawFamilyViewerToken,
      body: {
        category: 'CEMENT',
        itemName: 'Portland Composite Cement',
        actualSpec: { actualQty: 100, actualUnitPrice: 550 }
      }
    });
    check('FAMILY_VIEWER receives 403 Forbidden on recording deliveries', resViewerLog.status === 403);

    // ── Test 2: Stranger Client is rejected from logging delivery (403 Forbidden) ──
    const resStrangerLog = await api(`/api/projects/${project._id}/materials/deliveries`, {
      method: 'POST',
      token: strangerToken,
      body: {
        category: 'CEMENT',
        itemName: 'Portland Composite Cement'
      }
    });
    check('Stranger receives 403 Forbidden on recording deliveries', resStrangerLog.status === 403);

    // ── Test 3: Site Watcher logs delivery with truck dimensions (201 Created) ──
    const resWatcherLog = await api(`/api/projects/${project._id}/materials/deliveries`, {
      method: 'POST',
      shareToken: rawSiteWatcherToken,
      body: {
        category: 'SAND',
        itemName: 'Sylhet Sand 2.5 FM',
        plannedSpec: {
          brand: 'Local Sand Pit',
          gradeSpec: '2.5 FM',
          unit: 'CFT',
          plannedQty: 300,
          estimatedUnitPrice: 65
        },
        actualSpec: {
          brand: 'Local Sand Pit',
          gradeSpec: '2.5 FM',
          unit: 'CFT',
          actualUnitPrice: 65
        },
        truckDimensions: {
          lengthFt: 12,
          widthFt: 6,
          heightFt: 4
        },
        supplierInfo: {
          dealerName: 'Bismillah Sand & Stone Supplier',
          dealerPhone: '01719988776',
          chalanNo: 'CHALAN-9002'
        },
        evidence: {
          chalanPhotoUrl: 'https://storage.buildbd.internal/chalan/9002.jpg',
          siteDeliveryPhotoUrl: 'https://storage.buildbd.internal/site/9002.jpg',
          exifVerified: true,
          gpsLat: 23.7465,
          gpsLng: 90.3842
        }
      }
    });
    if (resWatcherLog.status !== 201) console.log('WATCHER ERROR:', resWatcherLog.status, resWatcherLog.body);
    check('SITE_WATCHER successfully logs delivery (201 Created)', resWatcherLog.status === 201);
    check('Calculated CFT is 288 (12 x 6 x 4)', resWatcherLog.body?.delivery?.truckDimensions?.calculatedCft === 288);
    check('Actual quantity automatically adopted calculated CFT', resWatcherLog.body?.delivery?.actualSpec?.actualQty === 288);
    check('Total actual cost computed as 288 * 65 = 18720 BDT', resWatcherLog.body?.delivery?.actualSpec?.totalActualCost === 18720);
    check('Generated QUANTITY_DIFF variance flag (288 vs planned 300)', resWatcherLog.body?.delivery?.informationalFlags?.length === 1 && resWatcherLog.body.delivery.informationalFlags[0].flagType === 'QUANTITY_DIFF');

    // ── Test 4: Contractor logs delivery with multiple gentle variances ──
    const resContractorLog = await api(`/api/projects/${project._id}/materials/deliveries`, {
      method: 'POST',
      token: contractorToken,
      body: {
        category: 'CEMENT',
        itemName: '50kg Cement Bags',
        plannedSpec: {
          brand: 'Shah Cement',
          gradeSpec: 'CEM II/B-M',
          unit: 'bag',
          plannedQty: 600,
          estimatedUnitPrice: 520
        },
        actualSpec: {
          brand: 'Seven Rings', // BRAND_DIFF
          gradeSpec: 'CEM I',   // GRADE_DIFF
          unit: 'bag',
          actualQty: 575,       // QUANTITY_DIFF (575 vs 600)
          actualUnitPrice: 550  // PRICE_DIFF (550 vs 520)
        },
        supplierInfo: {
          dealerName: 'Dhaka Cement Agency',
          dealerPhone: '01712345678',
          chalanNo: 'CHALAN-CEM-104',
          bstiLicenseNo: 'BSTI/CM/2026/894'
        }
      }
    });
    check('Contractor successfully logs delivery (201 Created)', resContractorLog.status === 201);
    const flags = resContractorLog.body?.delivery?.informationalFlags || [];
    check('Generated exactly 4 gentle variance flags', flags.length === 4);
    const flagTypes = flags.map((f) => f.flagType);
    check('Includes BRAND_DIFF flag', flagTypes.includes('BRAND_DIFF'));
    check('Includes QUANTITY_DIFF flag', flagTypes.includes('QUANTITY_DIFF'));
    check('Includes GRADE_DIFF flag', flagTypes.includes('GRADE_DIFF'));
    check('Includes PRICE_DIFF flag', flagTypes.includes('PRICE_DIFF'));

    // Check AuditLog emitted
    const auditLog = await AuditLog.findOne({
      entityId: resContractorLog.body.delivery._id,
      action: 'MATERIAL_DELIVERY_LOGGED'
    }).lean();
    check('MATERIAL_DELIVERY_LOGGED audit log recorded in database', !!auditLog);
    check('Audit log records 4 flags', auditLog?.metadata?.flagsCount === 4);

    // ── Test 5: Client Owner Views Ledger with Complete Financials ──
    const resClientGet = await api(`/api/projects/${project._id}/materials`, {
      token: clientToken
    });
    check('Client owner retrieves materials ledger (200 OK)', resClientGet.status === 200);
    check('Client view reports hideFinancials: false', resClientGet.body?.hideFinancials === false);
    check('Client view includes total planned cost figure', typeof resClientGet.body?.summary?.totalPlannedCost === 'number');
    check('Client view includes total actual cost figure', typeof resClientGet.body?.summary?.totalActualCost === 'number');
    check('Client view includes unit price inside deliveries', resClientGet.body?.deliveries[0]?.actualSpec?.actualUnitPrice !== undefined);

    // ── Test 6: Family Viewer Reads Ledger with Strict Financial Scrubbing ──
    const resDelegateGet = await api(`/api/projects/${project._id}/materials`, {
      shareToken: rawFamilyViewerToken
    });
    check('Family viewer retrieves materials ledger (200 OK)', resDelegateGet.status === 200);
    check('Delegate view reports hideFinancials: true', resDelegateGet.body?.hideFinancials === true);
    check('Delegate view scrubs summary totalPlannedCost (null)', resDelegateGet.body?.summary?.totalPlannedCost === null);
    check('Delegate view scrubs summary totalActualCost (null)', resDelegateGet.body?.summary?.totalActualCost === null);
    check('Delegate view scrubs summary costVariance (null)', resDelegateGet.body?.summary?.costVariance === null);
    check('Delegate view completely removes actualUnitPrice from items', resDelegateGet.body?.deliveries[0]?.actualSpec?.actualUnitPrice === undefined);
    check('Delegate view completely removes estimatedUnitPrice from items', resDelegateGet.body?.deliveries[0]?.plannedSpec?.estimatedUnitPrice === undefined);
    check('Delegate view still preserves item names, quantities and flags',
      resDelegateGet.body?.deliveries?.length === 2 &&
      resDelegateGet.body.deliveries[0].actualSpec.actualQty > 0 &&
      resDelegateGet.body.deliveries[0].informationalFlags.length > 0);

    // ── Test 7: Filter by flaggedOnly query parameter ──
    const resFlaggedOnly = await api(`/api/projects/${project._id}/materials?flaggedOnly=true`, {
      token: clientToken
    });
    check('flaggedOnly query returns 2 deliveries with flags', resFlaggedOnly.body?.deliveries?.length === 2);

    // ── Test 8: Contractor cannot acknowledge variance flags (403 Forbidden) ──
    const deliveryIdToAck = resContractorLog.body.delivery._id;
    const resContractorAck = await api(`/api/projects/${project._id}/materials/deliveries/${deliveryIdToAck}/acknowledge`, {
      method: 'PATCH',
      token: contractorToken
    });
    check('Contractor receives 403 Forbidden on acknowledging flags', resContractorAck.status === 403);

    // ── Test 9: Client Owner acknowledges variance flags (200 OK) ──
    const resClientAck = await api(`/api/projects/${project._id}/materials/deliveries/${deliveryIdToAck}/acknowledge`, {
      method: 'PATCH',
      token: clientToken
    });
    check('Client owner successfully acknowledges variance flags (200 OK)', resClientAck.status === 200);
    const ackedFlags = resClientAck.body?.delivery?.informationalFlags || [];
    check('All variance flags now have acknowledgedByClientAt timestamp', ackedFlags.every((f) => !!f.acknowledgedByClientAt));

    const ackAudit = await AuditLog.findOne({
      entityId: deliveryIdToAck,
      action: 'MATERIAL_DELIVERY_ACKNOWLEDGED'
    }).lean();
    check('MATERIAL_DELIVERY_ACKNOWLEDGED audit log recorded in database', !!ackAudit);
    check('Audit log records 4 acknowledged flags', ackAudit?.metadata?.acknowledgedCount === 4);

    // Summary of results
    console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('💥 phase3-material-transparency-exif-e2e crashed:', err);
    process.exit(1);
  }
})();
