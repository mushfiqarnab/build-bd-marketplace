// models/SupplierProfile.js
'use strict';

const mongoose = require('mongoose');

const MATERIAL_CATEGORIES = [
  'ROD',
  'CEMENT',
  'SAND',
  'BRICK',
  'STONE',
  'TILES',
  'SANITARY',
  'ELECTRICAL'
];

const supplierProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true
    },
    businessName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120
    },
    tradeLicenseNumber: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 64
    },
    nidNumber: {
      type: String,
      required: true,
      trim: true,
      minlength: 10,
      maxlength: 20
    },
    bstiLicenseNumber: {
      type: String,
      trim: true,
      default: '',
      maxlength: 64
    },
    bstiQrDocUrl: {
      type: String,
      trim: true,
      default: '',
      maxlength: 512
    },
    categories: {
      type: [{ type: String, enum: MATERIAL_CATEGORIES }],
      default: [],
      validate: [(v) => Array.isArray(v) && v.length > 0, 'At least one material category is required']
    },
    serviceDistricts: {
      type: [{ type: String, trim: true }],
      default: [],
      validate: [(v) => Array.isArray(v) && v.length > 0, 'At least one service district is required']
    },
    verification: {
      status: {
        type: String,
        enum: ['PENDING_VERIFICATION', 'VERIFIED', 'REJECTED'],
        default: 'PENDING_VERIFICATION'
      },
      verifiedAt: { type: Date },
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      rejectionReason: { type: String, trim: true, default: '' }
    },
    statistics: {
      totalOrdersFulfilled: { type: Number, default: 0 },
      trustScore: { type: Number, default: 50 },
      averageRating: { type: Number, default: 0 }
    }
  },
  { timestamps: true }
);

supplierProfileSchema.index({ tradeLicenseNumber: 1 }, { unique: true });
supplierProfileSchema.index({ 'verification.status': 1 });
supplierProfileSchema.index({ categories: 1 });
supplierProfileSchema.index({ serviceDistricts: 1 });

module.exports = {
  SupplierProfile: mongoose.model('SupplierProfile', supplierProfileSchema),
  MATERIAL_CATEGORIES
};
