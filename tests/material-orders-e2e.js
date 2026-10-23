// tests/material-orders-e2e.js
// End-to-end verification of Phase 1 (WP 1.3):
//   - Material Purchase Order Schema & Lifecycle (models/MaterialOrder.js)
//   - Verified Supplier KYC & District Delivery Coverage Gate
//   - Automated Bulk-Tier Pricing Resolution & Integer BDT Accounting
//   - Stock Insufficiency & Inactive Listing Guards
//   - Supplier Acceptance & Justified Rejection Handlers
//   - 100% Escrow Pre-Funding & Atomic Stock Decrement
//   - Logistics Waybill & Challan Dispatch Tracking
//   - Site Delivery Confirmation & Escrow Release
//   - Delivery Quality Dispute Filing & Escrow Freeze
//   - Cross-User Ownership Scoping & AuditLog Verification
'use strict';

const dotenv = require('dotenv');
dotenv.config();
process.env.PORT = '0';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32chars-minimum-safe';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

const User = require('../models/User');
const { SupplierProfile } = require('../models/SupplierProfile');
const { MaterialProduct } = require('../models/MaterialProduct');
const MaterialOrder = require('../models/MaterialOrder');
const AuditLog = require('../models/AuditLog');

const PHONE_PREFIX = '0188993';
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
  console.log('🧪 WP 1.3: Materials RFQ, Purchase Orders, Bulk-Tier Pricing & Delivery Escrow E2E');

  const mkUser = (role) => User.create({ role, phoneNumber: phone(), status: 'ACTIVE' });

  const [buyer1, buyer2, unverifiedSupplierUser, verifiedSupplierUser1, verifiedSupplierUser2] = await Promise.all([
    mkUser('CLIENT'),
    mkUser('CONTRACTOR'),
    mkUser('SUPPLIER'),
    mkUser('SUPPLIER'),
    mkUser('SUPPLIER')
  ]);

  const tok = (u) => jwt.sign({ userId: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const buyer1Token = tok(buyer1);
  const buyer2Token = tok(buyer2);
  const unverifiedSupToken = tok(unverifiedSupplierUser);
  const sup1Token = tok(verifiedSupplierUser1);
  const sup2Token = tok(verifiedSupplierUser2);

  // Setup Supplier Profiles
  const pUnverified = await SupplierProfile.create({
    userId: unverifiedSupplierUser._id,
    businessName: 'Unverified Rebar Traders',
    tradeLicenseNumber: `TRAD-${Date.now()}-U`,
    nidNumber: '19911234567890',
    categories: ['ROD'],
    serviceDistricts: ['Dhaka'],
    verification: { status: 'PENDING_VERIFICATION' }
  });

  const pVerified1 = await SupplierProfile.create({
    userId: verifiedSupplierUser1._id,
    businessName: 'BSRM Certified Hub',
    tradeLicenseNumber: `TRAD-${Date.now()}-V1`,
    nidNumber: '19921234567890',
    categories: ['ROD', 'CEMENT'],
    serviceDistricts: ['Dhaka', 'Gazipur', 'Narayanganj'],
    verification: { status: 'VERIFIED', verifiedAt: new Date() }
  });

  const pVerified2 = await SupplierProfile.create({
    userId: verifiedSupplierUser2._id,
    businessName: 'Chattogram Cement Mills',
    tradeLicenseNumber: `TRAD-${Date.now()}-V2`,
    nidNumber: '19931234567890',
    categories: ['CEMENT'],
    serviceDistricts: ['Chattogram'],
    verification: { status: 'VERIFIED', verifiedAt: new Date() }
  });

  // Setup SKUs for pVerified1
  // Rebar with bulk tiers: Base = 95,000; 10+ = 92,000; 50+ = 89,000
  const rodProduct = await MaterialProduct.create({
    supplierId: pVerified1._id,
    supplierUserId: verifiedSupplierUser1._id,
    category: 'ROD',
    brand: 'BSRM',
    title: 'BSRM Xtreme 500D 16mm Rebar',
    unit: 'TON',
    basePriceBDT: 95000,
    bulkTiers: [
      { minQuantity: 10, unitPriceBDT: 92000 },
      { minQuantity: 50, unitPriceBDT: 89000 }
    ],
    stockQuantity: 100,
    minOrderQuantity: 2,
    deliveryTerms: {
      leadTimeDays: 2,
      deliveryChargeBDT: 2500,
      freeDeliveryMinOrderBDT: 500000,
      supportedDistricts: ['Dhaka', 'Gazipur', 'Narayanganj']
    },
    status: 'ACTIVE'
  });

  // Cement SKU: Base = 560; 100+ = 530; 500+ = 500
  const cementProduct = await MaterialProduct.create({
    supplierId: pVerified1._id,
    supplierUserId: verifiedSupplierUser1._id,
    category: 'CEMENT',
    brand: 'Scan Cement',
    title: 'Scan Cement Portland Composite (PCC)',
    unit: 'BAG',
    basePriceBDT: 560,
    bulkTiers: [
      { minQuantity: 100, unitPriceBDT: 530 },
      { minQuantity: 500, unitPriceBDT: 500 }
    ],
    stockQuantity: 50, // Low stock for stock test
    minOrderQuantity: 10,
    deliveryTerms: {
      leadTimeDays: 1,
      deliveryChargeBDT: 1500,
      supportedDistricts: ['Dhaka']
    },
    status: 'ACTIVE'
  });

  // Helper HTTP requests
  const postReq = async (path, body, token, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `idem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data };
  };

  const patchReq = async (path, body, token) => {
    const res = await fetch(`${base}${path}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data };
  };

  const getReq = async (path, token) => {
    const res = await fetch(`${base}${path}`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, body: data };
  };

  const createdOrderIds = [];

  try {
    // ── 1. Security & Validation Guards on POST /api/materials/orders ──

    // No auth
    const noAuth = await postReq('/materials/orders', {});
    check('unauthenticated order creation returns 401', noAuth.status === 401);

    // Supplier role trying to create buyer order
    const supCannotBuy = await postReq('/materials/orders', {}, sup1Token);
    check('supplier role cannot place buyer order (403)', supCannotBuy.status === 403);

    // Target unverified supplier
    const unverifiedTarget = await postReq('/materials/orders', {
      supplierId: pUnverified._id,
      items: [{ productId: rodProduct._id, quantity: 5 }],
      deliveryDetails: {
        deliveryDistrict: 'Dhaka',
        deliveryAddress: 'House 12, Road 5, Banani, Dhaka',
        receiverName: 'Engr. Masud',
        receiverPhone: '01711223344'
      }
    }, buyer1Token);
    check('order targeting unverified supplier returns 403', unverifiedTarget.status === 403);

    // Delivery district unsupported by supplier
    const wrongDistrict = await postReq('/materials/orders', {
      supplierId: pVerified1._id,
      items: [{ productId: rodProduct._id, quantity: 5 }],
      deliveryDetails: {
        deliveryDistrict: 'Sylhet', // pVerified1 only supports Dhaka, Gazipur, Narayanganj
        deliveryAddress: 'Zindabazar, Sylhet',
        receiverName: 'Engr. Masud',
        receiverPhone: '01711223344'
      }
    }, buyer1Token);
    check('order to district outside supplier coverage returns 400', wrongDistrict.status === 400);

    // Stock insufficiency check (requesting 100 bags when cement stock is only 50)
    const outOfStock = await postReq('/materials/orders', {
      supplierId: pVerified1._id,
      items: [{ productId: cementProduct._id, quantity: 100 }],
      deliveryDetails: {
        deliveryDistrict: 'Dhaka',
        deliveryAddress: 'Mirpur DOHS, Dhaka',
        receiverName: 'Engr. Masud',
        receiverPhone: '01711223344'
      }
    }, buyer1Token);
    check('order exceeding available stock returns 400', outOfStock.status === 400);

    // Invalid phone number
    const invalidPhone = await postReq('/materials/orders', {
      supplierId: pVerified1._id,
      items: [{ productId: rodProduct._id, quantity: 5 }],
      deliveryDetails: {
        deliveryDistrict: 'Dhaka',
        deliveryAddress: 'Mirpur DOHS, Dhaka',
        receiverName: 'Engr. Masud',
        receiverPhone: '12345'
      }
    }, buyer1Token);
    check('invalid receiver phone number returns 400', invalidPhone.status === 400);

    // ── 2. Successful Order 1: Bulk Tier Pricing & Fee Calculation ──
    // Order 15 tons of BSRM rod (qualifies for Tier 1: min 10 tons @ 92,000 BDT)
    // Subtotal: 15 * 92,000 = 1,380,000 BDT
    // Subtotal >= freeDeliveryMinOrderBDT (500,000) -> deliveryChargeBDT = 0
    // Platform fee (2%): 1,380,000 * 0.02 = 27,600 BDT
    // Total: 1,380,000 + 0 + 27,600 = 1,407,600 BDT
    const order1Res = await postReq('/materials/orders', {
      supplierId: pVerified1._id,
      items: [{ productId: rodProduct._id, quantity: 15 }],
      deliveryDetails: {
        deliveryDistrict: 'Dhaka',
        deliveryAddress: 'Plot 45, Sector 11, Uttara, Dhaka',
        receiverName: 'Site Supervisor Alam',
        receiverPhone: '01712345678',
        unloadingRequired: true,
        buyerNotes: 'Enter via Uttara bridge gate'
      }
    }, buyer1Token);

    check('buyer successfully creates bulk purchase order (201)', order1Res.status === 201);
    const order1 = order1Res.body?.data?.order;
    if (order1) createdOrderIds.push(order1._id);

    check('order1 bulk tier automatically resolved to 92,000 BDT', order1?.items[0]?.unitPriceBDT === 92000);
    check('order1 bulk discount tier recorded', order1?.items[0]?.tierDiscountPercent > 0);
    check('order1 items subtotal is 1,380,000 BDT', order1?.itemsSubtotalBDT === 1380000);
    check('order1 qualified for free delivery (0 BDT)', order1?.deliveryChargeBDT === 0);
    check('order1 platform fee is 27,600 BDT (2%)', order1?.platformFeeBDT === 27600);
    check('order1 total amount is 1,407,600 BDT', order1?.totalAmountBDT === 1407600);
    check('order1 initial status is PENDING_SUPPLIER_ACCEPTANCE', order1?.status === 'PENDING_SUPPLIER_ACCEPTANCE');
    check('order1 initial escrow status is PENDING', order1?.escrowStatus === 'PENDING');

    // Audit log check for creation
    const createLog = await AuditLog.findOne({
      entityType: 'MATERIAL_ORDER',
      entityId: order1?._id,
      action: 'MATERIAL_ORDER_CREATED'
    });
    check('MATERIAL_ORDER_CREATED audit log stamped', !!createLog);

    // ── 3. Access Scoping (GET /api/materials/orders & GET /:id) ──
    const buyer1List = await getReq('/materials/orders', buyer1Token);
    check('buyer1 can list their own orders', buyer1List.status === 200 && buyer1List.body?.data?.orders?.length >= 1);

    const sup1List = await getReq('/materials/orders', sup1Token);
    check('supplier1 can list orders placed with their profile', sup1List.status === 200 && sup1List.body?.data?.orders?.length >= 1);

    const strangerList = await getReq('/materials/orders', buyer2Token);
    const strangerHasOrder1 = (strangerList.body?.data?.orders || []).some((o) => o._id === order1?._id);
    check('unrelated buyer2 does NOT see order1 in list', !strangerHasOrder1);

    const strangerLookup = await getReq(`/materials/orders/${order1?._id}`, buyer2Token);
    check('unrelated buyer2 blocked from viewing order1 details (403)', strangerLookup.status === 403);

    const buyer1Detail = await getReq(`/materials/orders/${order1?._id}`, buyer1Token);
    check('buyer1 can inspect order1 details', buyer1Detail.status === 200 && buyer1Detail.body?.data?.order?._id === order1?._id);

    // ── 4. Supplier Order 2: Rejection Flow ──
    const order2Res = await postReq('/materials/orders', {
      supplierId: pVerified1._id,
      items: [{ productId: rodProduct._id, quantity: 3 }], // Base price tier (95,000), delivery fee (2,500)
      deliveryDetails: {
        deliveryDistrict: 'Gazipur',
        deliveryAddress: 'Chowrasta, Gazipur',
        receiverName: 'Kader',
        receiverPhone: '01811223344'
      }
    }, buyer1Token);
    const order2 = order2Res.body?.data?.order;
    if (order2) createdOrderIds.push(order2._id);

    // Stranger supplier cannot reject
    const strangerReject = await patchReq(`/materials/orders/${order2?._id}/reject`, {
      rejectionReason: 'Not my shop'
    }, sup2Token);
    check('stranger supplier cannot reject order2 (403)', strangerReject.status === 403);

    // Short rejection reason
    const shortReason = await patchReq(`/materials/orders/${order2?._id}/reject`, {
      rejectionReason: 'no'
    }, sup1Token);
    check('rejection reason < 5 chars returns 400', shortReason.status === 400);

    // Legitimate rejection
    const sup1Reject = await patchReq(`/materials/orders/${order2?._id}/reject`, {
      rejectionReason: 'Mill maintenance scheduled, cannot fulfill this week'
    }, sup1Token);
    check('supplier successfully rejects order2 (200)', sup1Reject.status === 200 && sup1Reject.body?.data?.order?.status === 'REJECTED');

    // ── 5. Lifecycle for Order 1: Accept -> Fund Escrow -> Stock Decrement ──

    // Supplier accepts order 1
    const sup1Accept = await patchReq(`/materials/orders/${order1?._id}/accept`, {}, sup1Token);
    check('supplier successfully accepts order1 (200)', sup1Accept.status === 200 && sup1Accept.body?.data?.order?.status === 'ACCEPTED');

    // Duplicate accept returns 400
    const dupAccept = await patchReq(`/materials/orders/${order1?._id}/accept`, {}, sup1Token);
    check('duplicate acceptance returns 400 (CAS guard)', dupAccept.status === 400);

    // Check stock before escrow funding (should still be 100)
    const rodStockBefore = (await MaterialProduct.findById(rodProduct._id)).stockQuantity;
    check('stock untouched before escrow funding (100 tons)', rodStockBefore === 100);

    // Supplier cannot fund buyer's escrow
    const supCannotFund = await postReq(`/materials/orders/${order1?._id}/fund-escrow`, {}, sup1Token);
    check('supplier cannot fund buyer escrow (403)', supCannotFund.status === 403);

    // Buyer funds 100% escrow
    const fundRes = await postReq(`/materials/orders/${order1?._id}/fund-escrow`, {}, buyer1Token);
    check('buyer funds 100% escrow successfully (200)', fundRes.status === 200);
    check('order1 status transitions to ESCROW_FUNDED', fundRes.body?.data?.order?.status === 'ESCROW_FUNDED');
    check('order1 escrow status is FUNDED', fundRes.body?.data?.order?.escrowStatus === 'FUNDED');

    // Verify atomic stock decrement: 100 - 15 = 85 tons
    const rodStockAfter = (await MaterialProduct.findById(rodProduct._id)).stockQuantity;
    check('product stock atomically decremented by ordered quantity (85 tons)', rodStockAfter === 85);

    // ── 6. Supplier Dispatch & Waybill Tracking ──

    // Buyer cannot dispatch
    const buyerCannotDispatch = await postReq(`/materials/orders/${order1?._id}/dispatch`, {
      carrierName: 'Fast Trucking',
      challanNumber: 'CH-1001'
    }, buyer1Token);
    check('buyer cannot dispatch shipment (403)', buyerCannotDispatch.status === 403);

    // Missing challan number
    const missingChallan = await postReq(`/materials/orders/${order1?._id}/dispatch`, {
      carrierName: 'BSRM Heavy Logistics'
    }, sup1Token);
    check('dispatch without challan number returns 400', missingChallan.status === 400);

    // Legitimate dispatch
    const dispatchRes = await postReq(`/materials/orders/${order1?._id}/dispatch`, {
      carrierName: 'BSRM Heavy Logistics & Transport',
      challanNumber: 'CH-2026-9901',
      truckNumber: 'Dhaka Metro Ta-11-8844',
      driverPhone: '01811223344'
    }, sup1Token);

    check('supplier dispatches shipment with waybill (200)', dispatchRes.status === 200);
    const dispatchedOrder = dispatchRes.body?.data?.order;
    check('order1 status transitions to IN_TRANSIT', dispatchedOrder?.status === 'IN_TRANSIT');
    check('challan number recorded', dispatchedOrder?.logistics?.challanNumber === 'CH-2026-9901');
    check('carrier recorded', dispatchedOrder?.logistics?.carrierName === 'BSRM Heavy Logistics & Transport');
    check('dispatched timestamp recorded', !!dispatchedOrder?.logistics?.dispatchedAt);

    // ── 7. Supplier Marks Arrived at Site ──
    const deliverRes = await postReq(`/materials/orders/${order1?._id}/mark-delivered`, {
      deliveryProofNotes: 'Truck arrived at site gate. Received by Site Supervisor Alam, copy signed.'
    }, sup1Token);

    check('supplier marks arrived at site (200)', deliverRes.status === 200);
    const deliveredOrder = deliverRes.body?.data?.order;
    check('order1 status transitions to DELIVERED', deliveredOrder?.status === 'DELIVERED');
    check('delivery timestamp recorded', !!deliveredOrder?.logistics?.deliveredAt);

    // ── 8. Buyer Site Inspection Approval & Escrow Release ──

    // Supplier cannot release escrow to themselves
    const supCannotRelease = await postReq(`/materials/orders/${order1?._id}/confirm-delivery`, {}, sup1Token);
    check('supplier cannot release escrow to themselves (403)', supCannotRelease.status === 403);

    // Buyer inspects and confirms delivery release
    const confirmRes = await postReq(`/materials/orders/${order1?._id}/confirm-delivery`, {}, buyer1Token);
    check('buyer confirms delivery and releases escrow (200)', confirmRes.status === 200);
    const completedOrder = confirmRes.body?.data?.order;
    check('order1 status transitions to COMPLETED', completedOrder?.status === 'COMPLETED');

    // Supplier statistics updated
    const sup1ProfileAfter = await SupplierProfile.findById(pVerified1._id);
    check('supplier statistics totalOrdersFulfilled incremented', sup1ProfileAfter.statistics?.totalOrdersFulfilled >= 1);

    // ── 9. Dispute Flow on Order 3: Quality Defect & Escrow Freeze ──
    const order3Res = await postReq('/materials/orders', {
      supplierId: pVerified1._id,
      items: [{ productId: rodProduct._id, quantity: 2 }],
      deliveryDetails: {
        deliveryDistrict: 'Dhaka',
        deliveryAddress: 'House 5, Road 2, Gulshan 1, Dhaka',
        receiverName: 'Engr. Tareq',
        receiverPhone: '01799887766'
      }
    }, buyer1Token);
    const order3 = order3Res.body?.data?.order;
    if (order3) createdOrderIds.push(order3._id);

    await patchReq(`/materials/orders/${order3._id}/accept`, {}, sup1Token);
    await postReq(`/materials/orders/${order3._id}/fund-escrow`, {}, buyer1Token);
    await postReq(`/materials/orders/${order3._id}/dispatch`, {
      carrierName: 'SA Paribahan',
      challanNumber: 'CH-DISPUTE-01'
    }, sup1Token);
    await postReq(`/materials/orders/${order3._id}/mark-delivered`, {}, sup1Token);

    // Short dispute reason rejected
    const shortDispute = await postReq(`/materials/orders/${order3._id}/dispute`, {
      reason: 'broken'
    }, buyer1Token);
    check('dispute reason < 10 chars returns 400', shortDispute.status === 400);

    // Legitimate dispute: rebar severely rusted and bent
    const disputeRes = await postReq(`/materials/orders/${order3._id}/dispute`, {
      reason: 'Rebar delivered with severe rust pitting and bent lengths violating BSTI 500D specifications.'
    }, buyer1Token);

    check('buyer files delivery quality dispute successfully (200)', disputeRes.status === 200);
    const disputedOrder = disputeRes.body?.data?.order;
    check('order3 status transitions to DISPUTED', disputedOrder?.status === 'DISPUTED');
    check('order3 dispute details recorded', disputedOrder?.disputeDetails?.reason?.includes('severe rust'));
    check('order3 dispute status is OPEN', disputedOrder?.disputeDetails?.status === 'OPEN');

    // Attempting to release escrow on disputed order fails
    const releaseDisputed = await postReq(`/materials/orders/${order3._id}/confirm-delivery`, {}, buyer1Token);
    check('cannot release escrow while order is DISPUTED (400)', releaseDisputed.status === 400);

    // Dispute audit log verified
    const disputeLog = await AuditLog.findOne({
      entityType: 'MATERIAL_ORDER',
      entityId: order3._id,
      action: 'MATERIAL_ORDER_DISPUTED'
    });
    check('MATERIAL_ORDER_DISPUTED audit log stamped', !!disputeLog);

  } finally {
    if (createdOrderIds.length > 0) {
      await MaterialOrder.deleteMany({ _id: { $in: createdOrderIds } });
    }
    await MaterialProduct.deleteMany({ _id: { $in: [rodProduct._id, cementProduct._id] } });
    await SupplierProfile.deleteMany({ _id: { $in: [pUnverified._id, pVerified1._id, pVerified2._id] } });
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
      console.error('Fatal error in tests/material-orders-e2e.js:', err);
      appServer.close();
      mongoose.disconnect();
      process.exit(1);
    });
}
