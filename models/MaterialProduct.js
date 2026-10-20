// models/MaterialProduct.js — Materials Marketplace Catalog & Product SKU Schema
'use strict';

const mongoose = require('mongoose');
const { MATERIAL_CATEGORIES } = require('./SupplierProfile');
const { integerBDT } = require('../utils/money');

const MATERIAL_UNITS = ['TON', 'BAG', 'CFT', 'PIECE', 'SQFT'];
const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'OUT_OF_STOCK', 'ARCHIVED'];

const bulkTierSchema = new mongoose.Schema(
  {
    minQuantity: {
      type: Number,
      required: true,
      min: [1, 'Minimum quantity for a bulk tier must be at least 1'],
      validate: {
        validator: Number.isInteger,
        message: 'Minimum tier quantity must be an integer'
      }
    },
    unitPriceBDT: {
      type: Number,
      required: true,
      validate: integerBDT('bulkTiers.unitPriceBDT')
    }
  },
  { _id: false }
);

const materialProductSchema = new mongoose.Schema(
  {
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupplierProfile',
      required: true,
      index: true
    },
    supplierUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    category: {
      type: String,
      enum: MATERIAL_CATEGORIES,
      required: true,
      index: true
    },
    brand: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 60,
      index: true
    },
    title: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 120
    },
    description: {
      type: String,
      trim: true,
      default: '',
      maxlength: 1000
    },
    unit: {
      type: String,
      enum: MATERIAL_UNITS,
      required: true
    },
    basePriceBDT: {
      type: Number,
      required: true,
      validate: integerBDT('basePriceBDT')
    },
    bulkTiers: {
      type: [bulkTierSchema],
      default: [],
      validate: [
        function (tiers) {
          if (!tiers || tiers.length === 0) return true;
          // Verify tiers are ordered by minQuantity ascending
          for (let i = 1; i < tiers.length; i++) {
            if (tiers[i].minQuantity <= tiers[i - 1].minQuantity) {
              return false;
            }
          }
          return true;
        },
        'Bulk tiers must have strictly ascending minimum quantities'
      ]
    },
    specifications: {
      diameterMm: { type: Number },
      grade: { type: String, trim: true },
      standard: { type: String, trim: true },
      cementType: { type: String, trim: true },
      bagWeightKg: { type: Number, default: 50 },
      bstiCertified: { type: Boolean, default: true },
      bstiLicenseNumber: { type: String, trim: true, default: '' }
    },
    stockQuantity: {
      type: Number,
      default: 0,
      min: [0, 'Stock quantity cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: 'Stock quantity must be an integer'
      }
    },
    minOrderQuantity: {
      type: Number,
      default: 1,
      min: [1, 'Minimum order quantity must be at least 1'],
      validate: {
        validator: Number.isInteger,
        message: 'Minimum order quantity must be an integer'
      }
    },
    deliveryTerms: {
      leadTimeDays: {
        type: Number,
        default: 2,
        min: 1,
        max: 30,
        validate: {
          validator: Number.isInteger,
          message: 'Lead time must be integer calendar days'
        }
      },
      deliveryDistricts: {
        type: [{ type: String, trim: true }],
        default: []
      },
      deliveryChargePerUnitBDT: {
        type: Number,
        default: 0,
        min: 0,
        validate: integerBDT('deliveryTerms.deliveryChargePerUnitBDT')
      },
      freeDeliveryMinQuantity: {
        type: Number,
        default: null
      }
    },
    status: {
      type: String,
      enum: PRODUCT_STATUSES,
      default: 'ACTIVE',
      index: true
    }
  },
  { timestamps: true }
);

materialProductSchema.index({ category: 1, status: 1, 'deliveryTerms.deliveryDistricts': 1 });
materialProductSchema.index({ supplierUserId: 1, status: 1 });
materialProductSchema.index({ brand: 1, category: 1 });
materialProductSchema.index({ basePriceBDT: 1 });
materialProductSchema.index({ status: 1, createdAt: -1 });

module.exports = {
  MaterialProduct: mongoose.model('MaterialProduct', materialProductSchema),
  MATERIAL_UNITS,
  PRODUCT_STATUSES
};
