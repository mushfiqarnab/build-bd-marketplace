// scripts/seed-materials-marketplace.js
// Seeds realistic, verified suppliers and products into the database.
'use strict';

require('dns').setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
const mongoose = require('mongoose');
const User = require('../models/User');
const { SupplierProfile } = require('../models/SupplierProfile');
const { MaterialProduct } = require('../models/MaterialProduct');

async function seed() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI environment variable required');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log('Connected to MongoDB Atlas...');

  const supplierPhone = '01799887766';
  let supplierUser = await User.findOne({ phoneNumber: supplierPhone });
  if (!supplierUser) {
    supplierUser = await User.create({
      phoneNumber: supplierPhone,
      role: 'SUPPLIER',
      status: 'ACTIVE'
    });
    console.log('Created supplier user:', supplierUser.phoneNumber);
  }

  let supplierProfile = await SupplierProfile.findOne({ userId: supplierUser._id });
  if (!supplierProfile) {
    supplierProfile = await SupplierProfile.create({
      userId: supplierUser._id,
      companyName: 'মেসার্স মেঘনা স্টিল অ্যান্ড সিমেন্ট ট্রেডার্স',
      businessName: 'মেঘনা স্টিল মিরপুর ডিলার হাব',
      businessType: 'DISTRIBUTOR',
      tradeLicenseNumber: 'TRAD/DNCC/08219/2026',
      nidNumber: '19842691234567890',
      tinNumber: 'TIN-98765432101',
      phone: supplierPhone,
      email: 'contact@meghnasteel.com.bd',
      categories: ['ROD', 'CEMENT', 'TILES', 'BRICK', 'SAND'],
      serviceDistricts: ['Dhaka', 'Gazipur', 'Narayanganj', 'Munshiganj'],
      verification: {
        status: 'VERIFIED',
        verifiedAt: new Date()
      },
      paymentMethods: {
        acceptsEscrowHold: true
      },
      statistics: {
        totalOrdersFulfilled: 142,
        rating: 4.8,
        reviewCount: 38
      }
    });
    console.log('Created supplier profile:', supplierProfile.businessName);
  }

  const existingProducts = await MaterialProduct.countDocuments({ supplierId: supplierProfile._id });
  if (existingProducts === 0) {
    const products = [
      {
        supplierId: supplierProfile._id,
        supplierUserId: supplierUser._id,
        category: 'ROD',
        title: 'BSRM Xtreme 500D 16mm TMT Bar',
        brand: 'BSRM',
        grade: '500W',
        unit: 'TON',
        basePriceBDT: 95500,
        bulkTiers: [
          { minQuantity: 5, unitPriceBDT: 93500 },
          { minQuantity: 15, unitPriceBDT: 91000 }
        ],
        stockQuantity: 250,
        minOrderQuantity: 1,
        deliveryTerms: {
          supportedDistricts: ['Dhaka', 'Gazipur', 'Narayanganj'],
          leadTimeDays: 2,
          deliveryChargePerUnitBDT: 800
        },
        specifications: {
          bstiCertified: true,
          standardSpecification: 'BDS ISO 6935-2:2016'
        },
        status: 'ACTIVE'
      },
      {
        supplierId: supplierProfile._id,
        supplierUserId: supplierUser._id,
        category: 'ROD',
        title: 'AKS 500W TMT High-Yield Rebar 12mm',
        brand: 'AKS',
        grade: '500W',
        unit: 'TON',
        basePriceBDT: 92000,
        bulkTiers: [
          { minQuantity: 5, unitPriceBDT: 90000 },
          { minQuantity: 20, unitPriceBDT: 88500 }
        ],
        stockQuantity: 180,
        minOrderQuantity: 1,
        deliveryTerms: {
          supportedDistricts: ['Dhaka', 'Gazipur'],
          leadTimeDays: 2,
          deliveryChargePerUnitBDT: 800
        },
        specifications: {
          bstiCertified: true,
          standardSpecification: 'BDS ISO 6935-2:2016'
        },
        status: 'ACTIVE'
      },
      {
        supplierId: supplierProfile._id,
        supplierUserId: supplierUser._id,
        category: 'CEMENT',
        title: 'Shah Cement Special PCC (Portland Composite)',
        brand: 'Shah Cement',
        grade: 'PCC',
        unit: 'BAG',
        basePriceBDT: 530,
        bulkTiers: [
          { minQuantity: 100, unitPriceBDT: 505 },
          { minQuantity: 300, unitPriceBDT: 485 }
        ],
        stockQuantity: 1200,
        minOrderQuantity: 50,
        deliveryTerms: {
          supportedDistricts: ['Dhaka', 'Gazipur', 'Narayanganj'],
          leadTimeDays: 1,
          deliveryChargePerUnitBDT: 12
        },
        specifications: {
          bstiCertified: true,
          standardSpecification: 'BDS EN 197-1:2003 CEM II/A-M'
        },
        status: 'ACTIVE'
      },
      {
        supplierId: supplierProfile._id,
        supplierUserId: supplierUser._id,
        category: 'CEMENT',
        title: 'Seven Rings Special Portland Cement',
        brand: 'Seven Rings',
        grade: 'PCC',
        unit: 'BAG',
        basePriceBDT: 520,
        bulkTiers: [
          { minQuantity: 100, unitPriceBDT: 495 }
        ],
        stockQuantity: 800,
        minOrderQuantity: 50,
        deliveryTerms: {
          supportedDistricts: ['Dhaka', 'Narayanganj'],
          leadTimeDays: 1,
          deliveryChargePerUnitBDT: 12
        },
        specifications: {
          bstiCertified: true,
          standardSpecification: 'BDS EN 197-1:2003 CEM II/B-M'
        },
        status: 'ACTIVE'
      },
      {
        supplierId: supplierProfile._id,
        supplierUserId: supplierUser._id,
        category: 'TILES',
        title: 'Mir Ceramic Floor Tiles 60x60cm (Polished Glazed)',
        brand: 'Mir',
        grade: 'Grade A',
        unit: 'SQFT',
        basePriceBDT: 145,
        bulkTiers: [
          { minQuantity: 500, unitPriceBDT: 135 },
          { minQuantity: 1500, unitPriceBDT: 125 }
        ],
        stockQuantity: 5000,
        minOrderQuantity: 100,
        deliveryTerms: {
          supportedDistricts: ['Dhaka', 'Gazipur'],
          leadTimeDays: 3,
          deliveryChargePerUnitBDT: 3
        },
        specifications: {
          bstiCertified: true,
          standardSpecification: 'ISO 13006:2018 Group BIa'
        },
        status: 'ACTIVE'
      }
    ];

    await MaterialProduct.insertMany(products);
    console.log(`Successfully seeded ${products.length} material SKUs into the marketplace!`);
  } else {
    console.log(`Marketplace already has ${existingProducts} products.`);
  }

  await mongoose.disconnect();
  console.log('Seeding finished successfully.');
}

seed().catch((err) => {
  console.error('Failed to seed marketplace:', err);
  process.exit(1);
});
