// models/DomesticWorkerProfile.js
// High-Trust Domestic Labour Directory Profile (DWPWP-2015 & Three-Ring Trust Architecture)
'use strict';

const mongoose = require('mongoose');
const { integerBDT } = require('../utils/money');

const WORKER_CATEGORIES = [
  'HOUSEMAID_CHHUTA',
  'HOMEMAKER_FULLTIME',
  'CLEANER_DEEP',
  'DAILY_LABOUR_JOGALI',
  'COOK_CHEF',
  'PERSONAL_DRIVER',
  'CARE_GIVER',
  'PATIENT_NURSE_ATTENDANT',
  'SECURITY_GUARD_DARWAN',
  'GARDENER_MALI'
];

const SUB_TIERS = [
  'L1_DAILY_WAGE',
  'L2_PART_TIME_MONTHLY',
  'L3_FULL_TIME_MONTHLY'
];

const GUARANTOR_RELATIONSHIPS = [
  'URBAN_CARETAKER_DARWAN',
  'SAMITY_SECRETARY',
  'RURAL_KIN_ANCHOR'
];

const GUARANTOR_STATUSES = [
  'PENDING',
  'ACTIVE_VOUCHED',
  'REJECTED'
];

const GUARANTOR_VERIFICATION_METHODS = [
  'SMS_OTP',
  'IVR_VOICE_SAMPLE',
  'NID_MATCH'
];

const AVAILABILITY_STATUSES = [
  'AVAILABLE',
  'TRIAL_BOOKED',
  'FULLY_COMMITTED',
  'SUSPENDED'
];

const DomesticWorkerProfileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    immutable: true
  },
  fullName: {
    type: String,
    required: true,
    trim: true
  },
  phoneNumber: {
    type: String,
    required: true,
    trim: true
  },
  workerCategory: {
    type: String,
    enum: WORKER_CATEGORIES,
    default: 'HOUSEMAID_CHHUTA',
    required: true
  },
  subTier: {
    type: String,
    enum: SUB_TIERS,
    default: 'L2_PART_TIME_MONTHLY',
    required: true
  },
  thana: {
    type: String,
    required: true,
    trim: true
  },
  district: {
    type: String,
    default: 'Dhaka',
    trim: true
  },
  base_coordinates: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      required: true,
      default: [90.3760, 23.7465] // [lng, lat]
    }
  },

  // Integer-BDT rate fields (enforced via utils/money.js; no fractional taka)
  monthlyRateAmount: {
    type: Number,
    validate: integerBDT('Monthly rate amount')
  },
  dailyRateAmount: {
    type: Number,
    validate: integerBDT('Daily rate amount')
  },

  // Ring 1: Government Biometric & SIM KYC via Porichoy Gateway
  ring1_porichoy: {
    face_match_percentage: { type: Number, default: 0, min: 0, max: 100 },
    is_adult_18_plus: { type: Boolean, default: false },
    sim_nid_matched: { type: Boolean, default: false },
    porichoy_verified_at: { type: Date, default: null }
  },

  // Ring 2: Digital Darwan / Samity Reference Guarantor Graph (min 2 active vouched)
  guarantors: [{
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    relationship: {
      type: String,
      enum: GUARANTOR_RELATIONSHIPS,
      required: true
    },
    status: {
      type: String,
      enum: GUARANTOR_STATUSES,
      default: 'PENDING'
    },
    verified_via: {
      type: String,
      enum: GUARANTOR_VERIFICATION_METHODS,
      default: 'SMS_OTP'
    },
    vouched_at: { type: Date, default: null }
  }],

  // Ring 3: Automated DMP CIMS Police Dossier & QR Smart ID
  ring3_dmp_cims: {
    cims_tracking_ref: { type: String, trim: true, default: null },
    qr_smart_card_hash: { type: String, trim: true, default: null },
    cims_verified: { type: Boolean, default: false },
    dossier_issued_at: { type: Date, default: null }
  },

  // Certified Appliance and Chore Skill Tags
  skill_tags: [{
    tag_code: { type: String, required: true },
    labelEn: { type: String, required: true },
    labelBn: { type: String, required: true },
    is_certified: { type: Boolean, default: false },
    rate_multiplier_pct: { type: Number, default: 0 }
  }],

  availability: {
    type: String,
    enum: AVAILABILITY_STATUSES,
    default: 'AVAILABLE'
  }
}, {
  timestamps: true
});

DomesticWorkerProfileSchema.index({ base_coordinates: '2dsphere' });
DomesticWorkerProfileSchema.index({ thana: 1, subTier: 1, availability: 1 });
DomesticWorkerProfileSchema.index({ workerCategory: 1, availability: 1 });

module.exports = mongoose.model('DomesticWorkerProfile', DomesticWorkerProfileSchema);
