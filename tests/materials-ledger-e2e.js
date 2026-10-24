// tests/materials-ledger-e2e.js
// End-to-end verification of Phase 1 (WP 1.4):
//   - Project Materials Transparency Ledger (GET /api/materials/orders/project/:projectId/ledger)
//   - Project & Milestone Linking on Purchase Orders (projectId, milestoneIndex, boqLineItem, plannedBrand, plannedQuantity)
//   - Scoped Role Authorization (Client, Awarded Contractor, Admin allowed; Strangers 403)
//   - Integer BDT Spend Aggregations (totalSpendBDT, deliveredSpendBDT)
//   - Neutral Variance Notice Chips:
//       • BRAND_DIFFERENCE (Inform, never accuse)
//       • QUANTITY_EXCEEDING (Over-budget / volume exceedance)
//       • MISSING_PHOTO (Delivered batch without site evidence)
//       • MISSING_BSTI (Rod/Cement without BSTI licence number)
//   - Site Delivery Proof Capture (GPS coordinates, timestamp, challan, BSTI licence)
//   - Query Scoping by Project & Milestone (?projectId, ?milestoneIndex)
//   - Project Client Read Access to Contractor Material Orders
'use strict';

const dotenv = require('dotenv');
dotenv.config();
process.env.PORT = '0';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32chars-minimum-safe';
process.env.TREASURY_PHONE = process.env.TREASURY_PHONE || '01700000000';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

const User = require('../models/User');
const Project = require('../models/Project');
const EscrowLedger = require('../models/EscrowLedger');
const { SupplierProfile } = require('../models/SupplierProfile');
const { MaterialProduct } = require('../models/MaterialProduct');
const MaterialOrder = require('../models/MaterialOrder');
const AuditLog = require('../models/AuditLog');

const PHONE_PREFIX = '0188994';
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
  console.log('🧪 WP 1.4: Owner Materials Ledger & Transparency Screen E2E');

  const mkUser = (role) => User.create({ role, phoneNumber: phone(), status: 'ACTIVE' });

  const [clientUser, contractorUser, strangerUser, adminUser, supplierUser] = await Promise.all([
    mkUser('CLIENT'),
    mkUser('CONTRACTOR'),
    mkUser('CLIENT'),
    mkUser('ADMIN'),
    mkUser('SUPPLIER')
  ]);

  const authHeader = (user) => {
    const token = jwt.sign(
      { userId: user._id.toString(), role: user.role, status: user.status },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
  };

  const clientHeaders = authHeader(clientUser);
  const contractorHeaders = authHeader(contractorUser);
  const strangerHeaders = authHeader(strangerUser);
  const adminHeaders = authHeader(adminUser);
  const supplierHeaders = authHeader(supplierUser);

  // 1. Setup Verified Supplier Profile
  const supplierProfile = await SupplierProfile.create({
    userId: supplierUser._id,
    companyName: 'Meghna Steel & Materials Ltd',
    businessName: 'Meghna Steel Mirpur Hub',
    businessType: 'MANUFACTURER',
    tradeLicenseNumber: `TRAD-${Date.now()}-9921`,
    nidNumber: '19921234567890',
    categories: ['ROD', 'CEMENT'],
    tinNumber: 'TIN-98765432101',
    phone: phone(),
    email: 'contact@meghnasteel.com.bd',
    serviceDistricts: ['Dhaka', 'Gazipur', 'Narayanganj'],
    verification: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      verifiedBy: adminUser._id
    },
    paymentMethods: {
      acceptsEscrowHold: true
    }
  });

  // 2. Setup Products: Rod (BSRM), Alternate Rod (AKS), Cement
  const [rodBsrm, rodAks, cementProduct] = await Promise.all([
    MaterialProduct.create({
      supplierId: supplierProfile._id,
      supplierUserId: supplierUser._id,
      category: 'ROD',
      title: 'BSRM 500W TMT Bar 16mm',
      brand: 'BSRM',
      grade: '500W',
      unit: 'TON',
      basePriceBDT: 95000,
      stockQuantity: 100,
      minOrderQuantity: 1,
      bulkTiers: [
        { minQuantity: 5, unitPriceBDT: 92000 }
      ],
      deliveryTerms: {
        supportedDistricts: ['Dhaka', 'Gazipur'],
        leadTimeDays: 2,
        deliveryChargePerUnitBDT: 1000
      },
      status: 'ACTIVE'
    }),
    MaterialProduct.create({
      supplierId: supplierProfile._id,
      supplierUserId: supplierUser._id,
      category: 'ROD',
      title: 'AKS 500W TMT Bar 16mm',
      brand: 'AKS',
      grade: '500W',
      unit: 'TON',
      basePriceBDT: 91000,
      stockQuantity: 80,
      minOrderQuantity: 1,
      bulkTiers: [],
      deliveryTerms: {
        supportedDistricts: ['Dhaka'],
        leadTimeDays: 2,
        deliveryChargePerUnitBDT: 1000
      },
      status: 'ACTIVE'
    }),
    MaterialProduct.create({
      supplierId: supplierProfile._id,
      supplierUserId: supplierUser._id,
      category: 'CEMENT',
      title: 'Shah Cement Special PCC',
      brand: 'Shah Cement',
      grade: 'PCC',
      unit: 'BAG',
      basePriceBDT: 520,
      stockQuantity: 500,
      minOrderQuantity: 50,
      bulkTiers: [
        { minQuantity: 100, unitPriceBDT: 490 }
      ],
      deliveryTerms: {
        supportedDistricts: ['Dhaka'],
        leadTimeDays: 1,
        deliveryChargePerUnitBDT: 10
      },
      status: 'ACTIVE'
    })
  ]);

  // 3. Setup Construction Project and EscrowLedger
  const project = await Project.create({
    clientId: clientUser._id,
    awardedContractorId: contractorUser._id,
    title: 'Mirpur-10 6-Storey Residential Complex',
    category: 'Residential',
    location: 'Mirpur-10, Dhaka',
    description: 'Structural RCC construction and materials management',
    budget: 850000,
    status: 'ASSIGNED',
    siteCoordinates: { latitude: 23.8041, longitude: 90.3667 }
  });

  const ledger = await EscrowLedger.create({
    projectId: project._id,
    clientId: clientUser._id,
    contractorId: contractorUser._id,
    totalContractValue: 850000,
    ledgerStatus: 'FUNDED',
    milestones: [
      {
        title: 'ধাপ ১ — ফাউন্ডেশন ও পাইলিং',
        releasePercentage: 40,
        amount: 340000,
        status: 'IN_PROGRESS'
      },
      {
        title: 'ধাপ ২ — কলাম ঢালাই ও ছাদ',
        releasePercentage: 40,
        amount: 340000,
        status: 'PENDING'
      },
      {
        title: 'ধাপ ৩ — প্লাস্টার ও ফিনিশিং',
        releasePercentage: 20,
        amount: 170000,
        status: 'PENDING'
      }
    ]
  });

  const createdOrderIds = [];

  try {
    // ── TEST 1: Stranger Authorization Guard on Project Linking ──────────────
    const strangerAttempt = await fetch(`${base}/materials/orders`, {
      method: 'POST',
      headers: strangerHeaders,
      body: JSON.stringify({
        supplierId: supplierProfile._id,
        projectId: project._id,
        items: [{ productId: rodBsrm._id, quantity: 2 }],
        deliveryDetails: {
          deliveryDistrict: 'Dhaka',
          deliveryAddress: 'Mirpur-10, Sector 2, Road 4',
          receiverName: 'Mr. Stranger',
          receiverPhone: '01711000000'
        }
      })
    });
    const strangerRes = await strangerAttempt.json();
    check('Non-party client rejected from linking to someone else project (403)', strangerAttempt.status === 403);

    // ── TEST 2: Out of Bounds Milestone Index Guard ─────────────────────────
    const oobMilestoneAttempt = await fetch(`${base}/materials/orders`, {
      method: 'POST',
      headers: contractorHeaders,
      body: JSON.stringify({
        supplierId: supplierProfile._id,
        projectId: project._id,
        milestoneIndex: 10, // Only milestones 0, 1, 2 exist
        items: [{ productId: rodBsrm._id, quantity: 2 }],
        deliveryDetails: {
          deliveryDistrict: 'Dhaka',
          deliveryAddress: 'Mirpur-10, Sector 2, Road 4',
          receiverName: 'Site Supervisor',
          receiverPhone: '01711223344'
        }
      })
    });
    const oobRes = await oobMilestoneAttempt.json();
    check('Out-of-bounds milestoneIndex rejected (400)', oobMilestoneAttempt.status === 400);

    // ── TEST 3: Contractor creates Order 1 (BSRM Rod matching planned spec) ──
    const order1ResRaw = await fetch(`${base}/materials/orders`, {
      method: 'POST',
      headers: contractorHeaders,
      body: JSON.stringify({
        supplierId: supplierProfile._id,
        projectId: project._id,
        milestoneIndex: 0,
        boqLineItem: 'ফাউন্ডেশন রড (Rebar 500W)',
        plannedBrand: 'BSRM',
        plannedQuantity: 5,
        items: [{ productId: rodBsrm._id, quantity: 3 }],
        deliveryDetails: {
          deliveryDistrict: 'Dhaka',
          deliveryAddress: 'Mirpur-10, Sector 2, Plot 14, Site Office',
          receiverName: 'Engr. Masud Alam',
          receiverPhone: '01711998877',
          siteNotes: 'Enter via Mirpur-10 roundabout east gate'
        }
      })
    });
    check('Contractor successfully creates order linked to project (201)', order1ResRaw.status === 201);
    const order1Data = await order1ResRaw.json();
    const order1 = order1Data.data.order;
    createdOrderIds.push(order1._id);

    check('Order 1 has linked projectId and milestoneIndex', String(order1.projectId) === String(project._id) && order1.milestoneIndex === 0);
    check('Order 1 retains planned spec fields', order1.plannedBrand === 'BSRM' && order1.plannedQuantity === 5);

    // Transition Order 1 to DELIVERED with full delivery evidence (GPS, timestamp, BSTI)
    await fetch(`${base}/materials/orders/${order1._id}/accept`, { method: 'PATCH', headers: supplierHeaders });
    await fetch(`${base}/materials/orders/${order1._id}/fund-escrow`, {
      method: 'POST',
      headers: { ...contractorHeaders, 'x-idempotency-key': `fund-order1-${Date.now()}` }
    });
    await fetch(`${base}/materials/orders/${order1._id}/dispatch`, {
      method: 'POST',
      headers: supplierHeaders,
      body: JSON.stringify({
        carrierName: 'Meghna Logistics Fleet',
        challanNumber: 'CH-4417',
        vehicleNumber: 'Dhaka Metro-Ta 11-4521',
        driverPhone: '01715556677'
      })
    });

    const markDelivered1 = await fetch(`${base}/materials/orders/${order1._id}/mark-delivered`, {
      method: 'POST',
      headers: supplierHeaders,
      body: JSON.stringify({
        weightSlipUrl: 'https://storage.buildbd.com/slips/slip-4417.pdf',
        challanDocumentUrl: 'https://storage.buildbd.com/challans/ch-4417.pdf',
        siteDeliveryPhotoUrl: 'https://storage.buildbd.com/proofs/delivery-photo-bsrm.jpg',
        siteDeliveryPhotoTimestamp: new Date().toISOString(),
        siteDeliveryPhotoGps: { latitude: 23.8041, longitude: 90.3667 },
        bstiLicenseNumber: 'BSTI/CM/LIC-88219-ROD'
      })
    });
    check('Order 1 marked delivered with GPS & BSTI metadata (200)', markDelivered1.status === 200);

    // ── TEST 4: Contractor creates Order 2 with brand mismatch & quantity excess ─
    // Planned: BSRM (5 Tons). Ordered so far: 3 Tons.
    // Order 2 orders 3 Tons of AKS rod -> triggers BRAND_DIFFERENCE (AKS != BSRM)
    // and total ordered becomes 3 + 3 = 6 Tons > 5 Tons -> triggers QUANTITY_EXCEEDING!
    // Supplier will mark delivered WITHOUT photo -> triggers MISSING_PHOTO and MISSING_BSTI!
    const order2ResRaw = await fetch(`${base}/materials/orders`, {
      method: 'POST',
      headers: contractorHeaders,
      body: JSON.stringify({
        supplierId: supplierProfile._id,
        projectId: project._id,
        milestoneIndex: 0,
        boqLineItem: 'ফাউন্ডেশন রড (Rebar 500W)',
        plannedBrand: 'BSRM',
        plannedQuantity: 5,
        items: [{ productId: rodAks._id, quantity: 3 }],
        deliveryDetails: {
          deliveryDistrict: 'Dhaka',
          deliveryAddress: 'Mirpur-10, Sector 2, Plot 14, Site Office',
          receiverName: 'Engr. Masud Alam',
          receiverPhone: '01711998877'
        }
      })
    });
    const order2Data = await order2ResRaw.json();
    const order2 = order2Data.data.order;
    createdOrderIds.push(order2._id);

    await fetch(`${base}/materials/orders/${order2._id}/accept`, { method: 'PATCH', headers: supplierHeaders });
    await fetch(`${base}/materials/orders/${order2._id}/fund-escrow`, {
      method: 'POST',
      headers: { ...contractorHeaders, 'x-idempotency-key': `fund-order2-${Date.now()}` }
    });
    await fetch(`${base}/materials/orders/${order2._id}/dispatch`, {
      method: 'POST',
      headers: supplierHeaders,
      body: JSON.stringify({ challanNumber: 'CH-4420' })
    });
    // Mark delivered WITHOUT site photo or BSTI licence
    await fetch(`${base}/materials/orders/${order2._id}/mark-delivered`, {
      method: 'POST',
      headers: supplierHeaders,
      body: JSON.stringify({ challanDocumentUrl: 'https://storage.buildbd.com/challans/ch-4420.pdf' })
    });

    // ── TEST 5: GET /api/materials/orders/project/:projectId/ledger Security ──
    const unauthedLedger = await fetch(`${base}/materials/orders/project/${project._id}/ledger`);
    check('Unauthenticated request to materials ledger returns 401', unauthedLedger.status === 401);

    const strangerLedger = await fetch(`${base}/materials/orders/project/${project._id}/ledger`, {
      headers: strangerHeaders
    });
    check('Stranger request to materials ledger returns 403 Access Denied', strangerLedger.status === 403);

    const clientLedgerRes = await fetch(`${base}/materials/orders/project/${project._id}/ledger`, {
      headers: clientHeaders
    });
    check('Project Owner (Client) accesses materials ledger successfully (200)', clientLedgerRes.status === 200);

    const contractorLedgerRes = await fetch(`${base}/materials/orders/project/${project._id}/ledger`, {
      headers: contractorHeaders
    });
    check('Awarded Contractor accesses materials ledger successfully (200)', contractorLedgerRes.status === 200);

    const adminLedgerRes = await fetch(`${base}/materials/orders/project/${project._id}/ledger`, {
      headers: adminHeaders
    });
    check('Admin accesses materials ledger successfully (200)', adminLedgerRes.status === 200);

    // ── TEST 6: Verify Ledger Aggregations & Neutral Variances ───────────────
    const ledgerPayload = await clientLedgerRes.json();
    const { summary, items, bstiVerificationPortal } = ledgerPayload.data;

    check('Ledger returns summary object', !!summary);
    check('Summary ordersCount equals 2', summary.ordersCount === 2);
    check('Summary deliveredOrdersCount equals 2', summary.deliveredOrdersCount === 2);
    check('Summary totalSpendBDT is positive integer', Number.isInteger(summary.totalSpendBDT) && summary.totalSpendBDT > 0);
    check('Summary deliveredSpendBDT equals totalSpendBDT when all delivered', summary.deliveredSpendBDT === summary.totalSpendBDT);

    check('Ledger returns line items array', Array.isArray(items) && items.length > 0);
    const rebarGroup = items.find((i) => i.boqLineItem === 'ফাউন্ডেশন রড (Rebar 500W)');
    check('Found rebar group in ledger items', !!rebarGroup);

    check('Rebar group milestoneIndex is 0', rebarGroup.milestoneIndex === 0);
    check('Rebar group milestoneTitle populated from ledger', rebarGroup.milestoneTitle.includes('ফাউন্ডেশন'));
    check('Rebar group deliveredQuantity is 6 TON', rebarGroup.deliveredQuantity === 6 && rebarGroup.unit === 'TON');
    check('Rebar group actualBrands includes both BSRM and AKS', rebarGroup.actualBrands.includes('BSRM') && rebarGroup.actualBrands.includes('AKS'));

    // Verify Variances
    const variances = rebarGroup.variances || [];
    const brandVar = variances.find((v) => v.type === 'BRAND_DIFFERENCE');
    check('BRAND_DIFFERENCE neutral variance detected', !!brandVar);
    check('BRAND_DIFFERENCE has neutral message', brandVar && brandVar.messageEn.includes('Brand differs from agreed plan') && brandVar.severity === 'NEUTRAL_NOTICE');

    const qtyVar = variances.find((v) => v.type === 'QUANTITY_EXCEEDING');
    check('QUANTITY_EXCEEDING neutral variance detected (+1 TON)', !!qtyVar && qtyVar.actual === 6 && qtyVar.planned === 5);

    const photoVar = variances.find((v) => v.type === 'MISSING_PHOTO');
    check('MISSING_PHOTO neutral variance detected for batch without photo', !!photoVar);

    const bstiVar = variances.find((v) => v.type === 'MISSING_BSTI');
    check('MISSING_BSTI neutral variance detected for rod batch without license', !!bstiVar);

    check('Summary variancesCount reflects detected items', summary.variancesCount >= 4);
    check('BSTI verification portal URL provided for outbound verification', bstiVerificationPortal === 'http://bsti.portal.gov.bd/');

    // Verify Orders in group
    const groupOrders = rebarGroup.orders || [];
    const deliveredOrder1 = groupOrders.find((o) => o.orderNumber === order1.orderNumber);
    check('Order 1 has GPS coordinates in ledger', !!deliveredOrder1.siteDeliveryPhotoGps && deliveredOrder1.siteDeliveryPhotoGps.latitude === 23.8041);
    check('Order 1 has BSTI license number in ledger', deliveredOrder1.bstiLicenseNumber === 'BSTI/CM/LIC-88219-ROD');

    // ── TEST 7: Query Filter (?projectId, ?milestoneIndex) ──────────────────
    const filterRes = await fetch(`${base}/materials/orders?projectId=${project._id}`, {
      headers: clientHeaders
    });
    const filterData = await filterRes.json();
    check('Client query ?projectId returns both project material orders', filterData.data.orders.length === 2);

    const filterMsRes = await fetch(`${base}/materials/orders?projectId=${project._id}&milestoneIndex=0`, {
      headers: clientHeaders
    });
    const filterMsData = await filterMsRes.json();
    check('Client query ?projectId&milestoneIndex=0 returns matching orders', filterMsData.data.orders.length === 2);

    // ── TEST 8: Homeowner Read Access to Contractor Order ────────────────────
    const clientOrderView = await fetch(`${base}/materials/orders/${order1._id}`, {
      headers: clientHeaders
    });
    check('Project Client can view contractor-placed material order (200)', clientOrderView.status === 200);

    const strangerOrderView = await fetch(`${base}/materials/orders/${order1._id}`, {
      headers: strangerHeaders
    });
    check('Stranger is forbidden from viewing order (403)', strangerOrderView.status === 403);

  } finally {
    if (createdOrderIds.length > 0) {
      await MaterialOrder.deleteMany({ _id: { $in: createdOrderIds } });
    }
    await EscrowLedger.deleteOne({ _id: ledger._id });
    await Project.deleteOne({ _id: project._id });
    await MaterialProduct.deleteMany({ _id: { $in: [rodBsrm._id, rodAks._id, cementProduct._id] } });
    await SupplierProfile.deleteOne({ _id: supplierProfile._id });
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
      console.error('Fatal error in tests/materials-ledger-e2e.js:', err);
      appServer.close();
      mongoose.disconnect();
      process.exit(1);
    });
}
