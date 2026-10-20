// tests/materials-catalog-e2e.js
// End-to-end verification of Phase 1 (WP 1.2):
//   - Material Product SKU Model (models/MaterialProduct.js)
//   - Unverified Supplier Listing Guard (403 Forbidden)
//   - Price & Bulk Tier Validation (integer BDT, non-increasing unit prices)
//   - Rod/Rebar & Cement SKU Creation (POST /api/materials/products)
//   - Cross-Supplier Ownership Gates (PATCH /api/materials/products/:id)
//   - Supplier Self-Inventory (GET /api/materials/products/my)
//   - Public Catalog Search & Filtering (GET /api/materials/catalog)
//   - Public Single Product Card & Tiers (GET /api/materials/products/:id)
'use strict';

const dotenv = require('dotenv');
dotenv.config();
process.env.PORT = '0';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

const User = require('../models/User');
const { SupplierProfile } = require('../models/SupplierProfile');
const { MaterialProduct } = require('../models/MaterialProduct');

const PHONE_PREFIX = '0188992';
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
  console.log('🧪 WP 1.2: Materials Catalog & SKU Pricing Tiers E2E');

  const mkUser = (role) => User.create({ role, phoneNumber: phone(), status: 'ACTIVE' });
  const [client, unverifiedSupUser, verifiedSupUser1, verifiedSupUser2] = await Promise.all([
    mkUser('CLIENT'),
    mkUser('SUPPLIER'),
    mkUser('SUPPLIER'),
    mkUser('SUPPLIER')
  ]);

  const tok = (u) => jwt.sign({ userId: u._id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '1h' });

  // Profiles
  const pUnverified = await SupplierProfile.create({
    userId: unverifiedSupUser._id,
    businessName: 'Unverified Materials Depot',
    tradeLicenseNumber: `TRAD-${Date.now()}-U`,
    nidNumber: '19901234567890',
    categories: ['ROD', 'CEMENT'],
    serviceDistricts: ['Dhaka'],
    verification: { status: 'PENDING_VERIFICATION' }
  });

  const pVerified1 = await SupplierProfile.create({
    userId: verifiedSupUser1._id,
    businessName: 'Bengal Steel Syndicate',
    tradeLicenseNumber: `TRAD-${Date.now()}-V1`,
    nidNumber: '19851234567890',
    categories: ['ROD', 'CEMENT'],
    serviceDistricts: ['Dhaka', 'Gazipur', 'Narayanganj'],
    verification: { status: 'VERIFIED' },
    statistics: { trustScore: 85 }
  });

  const pVerified2 = await SupplierProfile.create({
    userId: verifiedSupUser2._id,
    businessName: 'Padma River Aggregates',
    tradeLicenseNumber: `TRAD-${Date.now()}-V2`,
    nidNumber: '19871234567890',
    categories: ['SAND', 'STONE'],
    serviceDistricts: ['Dhaka', 'Faridpur'],
    verification: { status: 'VERIFIED' },
    statistics: { trustScore: 78 }
  });

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

  const createdProductIds = [];

  try {
    // ── 1. Unverified Supplier Gating ────────────────────────────────────────
    const validRodPayload = {
      category: 'ROD',
      brand: 'BSRM',
      title: 'BSRM Xtreme 500D 16mm TMT Bar',
      description: 'High strength deformed steel bar conforming to BDS ISO 6935-2.',
      unit: 'TON',
      basePriceBDT: 98000,
      bulkTiers: [
        { minQuantity: 5, unitPriceBDT: 96500 },
        { minQuantity: 20, unitPriceBDT: 95000 }
      ],
      specifications: {
        diameterMm: 16,
        grade: '500W',
        standard: 'BDS ISO 6935-2',
        bstiCertified: true,
        bstiLicenseNumber: 'BSTI/CM/ROD-9901'
      },
      stockQuantity: 150,
      minOrderQuantity: 1,
      deliveryTerms: {
        leadTimeDays: 2,
        deliveryDistricts: ['Dhaka', 'Gazipur'],
        deliveryChargePerUnitBDT: 500
      }
    };

    const clientCreate = await postReq('/materials/products', validRodPayload, client);
    check('CLIENT is refused when attempting to create material SKU (403)', clientCreate.status === 403);

    const unverifiedCreate = await postReq('/materials/products', validRodPayload, unverifiedSupUser);
    check('UNVERIFIED supplier is refused when creating material SKU (403)', unverifiedCreate.status === 403);

    // ── 2. Pricing & Bulk Tier Validation ────────────────────────────────────
    const fractionalPriceAttempt = await postReq('/materials/products', {
      ...validRodPayload,
      basePriceBDT: 98000.50
    }, verifiedSupUser1);
    check('fractional BDT price is rejected with 400 Bad Request', fractionalPriceAttempt.status === 400);

    const invertedTierAttempt = await postReq('/materials/products', {
      ...validRodPayload,
      bulkTiers: [
        { minQuantity: 5, unitPriceBDT: 99000 } // Exceeds basePriceBDT: 98000
      ]
    }, verifiedSupUser1);
    check('bulk tier price higher than base price is rejected with 400 Bad Request', invertedTierAttempt.status === 400);

    const nonIncreasingTierAttempt = await postReq('/materials/products', {
      ...validRodPayload,
      bulkTiers: [
        { minQuantity: 10, unitPriceBDT: 96000 },
        { minQuantity: 5, unitPriceBDT: 97000 } // Out of order minQuantity
      ]
    }, verifiedSupUser1);
    check('out-of-order bulk tier quantities are rejected with 400 Bad Request', nonIncreasingTierAttempt.status === 400);

    // ── 3. Valid SKU Creation ────────────────────────────────────────────────
    const rodCreated = await postReq('/materials/products', validRodPayload, verifiedSupUser1);
    check('VERIFIED supplier creates valid Rod SKU (201)', rodCreated.status === 201 && rodCreated.body?.data?.product?.category === 'ROD');
    const rodProduct = rodCreated.body?.data?.product;
    if (rodProduct) createdProductIds.push(rodProduct._id);

    const validCementPayload = {
      category: 'CEMENT',
      brand: 'Shah Cement',
      title: 'Shah Cement Special Composite (PCC) 50kg',
      description: 'Portland Composite Cement for heavy industrial and foundation work.',
      unit: 'BAG',
      basePriceBDT: 560,
      bulkTiers: [
        { minQuantity: 50, unitPriceBDT: 545 },
        { minQuantity: 200, unitPriceBDT: 530 }
      ],
      specifications: {
        cementType: 'PCC',
        bagWeightKg: 50,
        bstiCertified: true,
        bstiLicenseNumber: 'BSTI/CM/CEM-4412'
      },
      stockQuantity: 800,
      minOrderQuantity: 10,
      deliveryTerms: {
        leadTimeDays: 1,
        deliveryDistricts: ['Dhaka', 'Narayanganj'],
        deliveryChargePerUnitBDT: 15
      }
    };

    const cementCreated = await postReq('/materials/products', validCementPayload, verifiedSupUser1);
    check('VERIFIED supplier creates valid Cement SKU (201)', cementCreated.status === 201 && cementCreated.body?.data?.product?.category === 'CEMENT');
    const cementProduct = cementCreated.body?.data?.product;
    if (cementProduct) createdProductIds.push(cementProduct._id);

    const validSandPayload = {
      category: 'SAND',
      brand: 'Sylhet Coarse',
      title: 'Sylhet Coarse Red Sand (FM 2.5)',
      unit: 'CFT',
      basePriceBDT: 48,
      stockQuantity: 5000,
      minOrderQuantity: 100,
      deliveryTerms: {
        leadTimeDays: 2,
        deliveryDistricts: ['Dhaka', 'Faridpur']
      }
    };
    const sandCreated = await postReq('/materials/products', validSandPayload, verifiedSupUser2);
    check('Supplier 2 creates valid Sand SKU (201)', sandCreated.status === 201);
    const sandProduct = sandCreated.body?.data?.product;
    if (sandProduct) createdProductIds.push(sandProduct._id);

    // ── 4. Ownership Gates on Mutation (PATCH) ───────────────────────────────
    const tamperAttempt = await patchReq(`/materials/products/${rodProduct._id}`, { basePriceBDT: 90000 }, verifiedSupUser2);
    check('cross-supplier price tampering is rejected with 403 Forbidden', tamperAttempt.status === 403);

    const validUpdate = await patchReq(`/materials/products/${rodProduct._id}`, {
      basePriceBDT: 97500,
      stockQuantity: 120
    }, verifiedSupUser1);
    check('supplier updates own product price and stock (200)', validUpdate.status === 200 && validUpdate.body?.data?.product?.basePriceBDT === 97500);

    // ── 5. Supplier Self-Inventory (GET /api/materials/products/my) ───────────
    const clientInventory = await getReq('/materials/products/my', client);
    check('CLIENT cannot access supplier inventory (403)', clientInventory.status === 403);

    const sup1Inventory = await getReq('/materials/products/my', verifiedSupUser1);
    check('supplier retrieves own inventory containing created SKUs', sup1Inventory.status === 200 && sup1Inventory.body?.data?.count === 2);

    // ── 6. Public Catalog Search & Filtering (GET /api/materials/catalog) ────
    const catalogAll = await getReq('/materials/catalog');
    const allList = catalogAll.body?.data?.products || [];
    check('public catalog returns active products with supplier business details', catalogAll.status === 200 && allList.length >= 3 && allList.some((p) => p.supplierId?.businessName === 'Bengal Steel Syndicate'));

    const catalogRod = await getReq('/materials/catalog?category=ROD');
    const rodList = catalogRod.body?.data?.products || [];
    check('catalog category=ROD filter returns Rod SKUs only', rodList.length >= 1 && rodList.every((p) => p.category === 'ROD'));

    const catalogDistrict = await getReq('/materials/catalog?district=Gazipur');
    const gazipurList = catalogDistrict.body?.data?.products || [];
    check('catalog district filter returns products serving that district', gazipurList.length >= 1 && gazipurList.every((p) => p.deliveryTerms?.deliveryDistricts?.includes('Gazipur')));

    const catalogSortedDesc = await getReq('/materials/catalog?sort=price_desc');
    const descList = catalogSortedDesc.body?.data?.products || [];
    check('catalog sort=price_desc sorts highest price first', descList.length >= 2 && descList[0].basePriceBDT >= descList[1].basePriceBDT);

    // ── 7. Public Single Product Card (GET /api/materials/products/:id) ───────
    const singleLookup = await getReq(`/materials/products/${rodProduct._id}`);
    check('public single product card returns full specs, bulk tiers, and supplier trust score', singleLookup.status === 200 && singleLookup.body?.data?.product?.bulkTiers?.length === 2 && singleLookup.body?.data?.product?.supplierId?.statistics?.trustScore === 85);

    const invalidIdLookup = await getReq('/materials/products/invalid-object-id');
    check('invalid product ObjectId returns 400 Bad Request', invalidIdLookup.status === 400);

    const nonExistentLookup = await getReq(`/materials/products/${new mongoose.Types.ObjectId()}`);
    check('non-existent product lookup returns 404 Not Found', nonExistentLookup.status === 404);

  } finally {
    if (createdProductIds.length > 0) {
      await MaterialProduct.deleteMany({ _id: { $in: createdProductIds } });
    }
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
      console.error('Fatal error in tests/materials-catalog-e2e.js:', err);
      appServer.close();
      mongoose.disconnect();
      process.exit(1);
    });
}
