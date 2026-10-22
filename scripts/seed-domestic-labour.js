// scripts/seed-domestic-labour.js
// Seeds verified domestic workers with 3-Ring Trust Architecture into MongoDB.
'use strict';

require('dns').setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
const mongoose = require('mongoose');
const User = require('../models/User');
const DomesticWorkerProfile = require('../models/DomesticWorkerProfile');

const WORKERS_SEED = [
  {
    phone: '01711002233',
    fullName: 'Rahima Begum',
    category: 'HOUSEMAID_CHHUTA',
    subTier: 'L2_PART_TIME_MONTHLY',
    thana: 'Dhanmondi',
    district: 'Dhaka',
    coordinates: [90.3760, 23.7465],
    monthlyRateAmount: 8500,
    dailyRateAmount: 350,
    faceMatch: 94,
    skills: [
      { tag_code: 'APPLIANCE_WASHING_MACHINE', labelEn: 'Washing Machine', labelBn: 'ওয়াশিং মেশিন', is_certified: true, rate_multiplier_pct: 10 },
      { tag_code: 'CHORE_COOKING_BENGALI', labelEn: 'Bengali Cooking', labelBn: 'বাংলা রান্না', is_certified: true, rate_multiplier_pct: 15 },
      { tag_code: 'DEEP_CLEANING_BATHROOM', labelEn: 'Sanitary Deep Clean', labelBn: 'বাথরুম ডিপ ক্লিন', is_certified: true, rate_multiplier_pct: 5 }
    ]
  },
  {
    phone: '01811003344',
    fullName: 'Morium Khatun',
    category: 'HOMEMAKER_FULLTIME',
    subTier: 'L3_FULL_TIME_MONTHLY',
    thana: 'Gulshan',
    district: 'Dhaka',
    coordinates: [90.4170, 23.7925],
    monthlyRateAmount: 18000,
    dailyRateAmount: 700,
    faceMatch: 96,
    skills: [
      { tag_code: 'APPLIANCE_MICROWAVE_OVEN', labelEn: 'Microwave & Oven', labelBn: 'মাইক্রোওয়েভ ওভেন', is_certified: true, rate_multiplier_pct: 10 },
      { tag_code: 'CHORE_CHILD_CARE', labelEn: 'Infant & Child Care', labelBn: 'শিশু যত্ন', is_certified: true, rate_multiplier_pct: 20 },
      { tag_code: 'CHORE_COOKING_BENGALI', labelEn: 'Bengali & Continental', labelBn: 'বাংলা ও কন্টিনেন্টাল রান্না', is_certified: true, rate_multiplier_pct: 15 }
    ]
  },
  {
    phone: '01911004455',
    fullName: 'Shahana Akter',
    category: 'CLEANER_DEEP',
    subTier: 'L1_DAILY_WAGE',
    thana: 'Uttara',
    district: 'Dhaka',
    coordinates: [90.3980, 23.8730],
    monthlyRateAmount: 10000,
    dailyRateAmount: 400,
    faceMatch: 91,
    skills: [
      { tag_code: 'APPLIANCE_VACUUM', labelEn: 'Vacuum Cleaner', labelBn: 'ভ্যাকুয়াম ক্লিনার', is_certified: true, rate_multiplier_pct: 10 },
      { tag_code: 'DEEP_CLEANING_KITCHEN', labelEn: 'Kitchen Degreasing', labelBn: 'রান্নাঘর তেল-কালি মুক্ত', is_certified: true, rate_multiplier_pct: 15 }
    ]
  },
  {
    phone: '01611005566',
    fullName: 'Abdul Jalil',
    category: 'PERSONAL_DRIVER',
    subTier: 'L3_FULL_TIME_MONTHLY',
    thana: 'Banani',
    district: 'Dhaka',
    coordinates: [90.4043, 23.7940],
    monthlyRateAmount: 22000,
    dailyRateAmount: 900,
    faceMatch: 95,
    skills: [
      { tag_code: 'VEHICLE_AUTOMATIC_MANUAL', labelEn: 'Auto & Manual Transmission', labelBn: 'অটো ও ম্যানুয়াল গিয়ার', is_certified: true, rate_multiplier_pct: 15 },
      { tag_code: 'DHAKA_CITY_NAVIGATION', labelEn: 'GPS & Route Navigation', labelBn: 'স্মার্ট নেভিগেশন ও শর্টকাট', is_certified: true, rate_multiplier_pct: 10 }
    ]
  }
];

async function seed() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI environment variable required');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  console.log('Connected to MongoDB replica set...');

  for (const item of WORKERS_SEED) {
    let user = await User.findOne({ phoneNumber: item.phone });
    if (!user) {
      user = await User.create({
        phoneNumber: item.phone,
        role: 'CONTRACTOR',
        status: 'ACTIVE'
      });
      console.log(`✅ Created User: ${item.fullName} (${item.phone})`);
    }

    let profile = await DomesticWorkerProfile.findOne({ userId: user._id });
    if (!profile) {
      profile = await DomesticWorkerProfile.create({
        userId: user._id,
        fullName: item.fullName,
        phoneNumber: item.phone,
        workerCategory: item.category,
        subTier: item.subTier,
        thana: item.thana,
        district: item.district,
        base_coordinates: {
          type: 'Point',
          coordinates: item.coordinates
        },
        monthlyRateAmount: item.monthlyRateAmount,
        dailyRateAmount: item.dailyRateAmount,
        ring1_porichoy: {
          face_match_percentage: item.faceMatch,
          is_adult_18_plus: true,
          sim_nid_matched: true,
          porichoy_verified_at: new Date()
        },
        guarantors: [
          {
            name: 'Md. Hafizur Rahman (Darwan)',
            phone: '01700112233',
            relationship: 'URBAN_CARETAKER_DARWAN',
            status: 'ACTIVE_VOUCHED',
            verified_via: 'SMS_OTP',
            vouched_at: new Date()
          },
          {
            name: 'Kalam Mollah (Village Elder)',
            phone: '01800223344',
            relationship: 'RURAL_KIN_ANCHOR',
            status: 'ACTIVE_VOUCHED',
            verified_via: 'IVR_VOICE_SAMPLE',
            vouched_at: new Date()
          }
        ],
        ring3_dmp_cims: {
          cims_tracking_ref: `DMP-CIMS-${item.thana.toUpperCase()}-2026-${Math.floor(1000 + Math.random() * 9000)}`,
          qr_smart_card_hash: `QR-DWPWP-${Buffer.from(item.phone).toString('hex').slice(0, 12)}`,
          cims_verified: true,
          dossier_issued_at: new Date()
        },
        skill_tags: item.skills,
        availability: 'AVAILABLE'
      });
      console.log(`🛡️ Seeded DomesticWorkerProfile: ${profile.fullName} in ${profile.thana}`);
    } else {
      console.log(`ℹ️ DomesticWorkerProfile already exists: ${profile.fullName}`);
    }
  }

  await mongoose.disconnect();
  console.log('Seeding finished successfully.');
}

if (require.main === module) {
  seed().catch((err) => {
    console.error('Seed error:', err);
    process.exit(1);
  });
}

module.exports = { seed };
