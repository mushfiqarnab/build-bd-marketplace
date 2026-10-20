// models/MaterialDeliveryLog.js
// 🧱 Phase 3: Project Material Transparency Ledger
// Reconciles planned material orders against delivered chalan and site evidence.
// Enforces strict integer Taka math on financial spec fields.
'use strict';

const mongoose = require('mongoose');
const { integerBDT } = require('../utils/money');

const InformationalFlagSchema = new mongoose.Schema({
  flagType: {
    type: String,
    enum: ['QUANTITY_DIFF', 'BRAND_DIFF', 'GRADE_DIFF', 'PRICE_DIFF'],
    required: true
  },
  plannedValue: {
    type: String,
    default: ''
  },
  actualValue: {
    type: String,
    default: ''
  },
  acknowledgedByClientAt: {
    type: Date,
    default: null
  }
}, { _id: false });

const MaterialDeliveryLogSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: [true, 'Material delivery log must be bound to a project'],
    index: true
  },
  milestoneId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  plannedItemIndex: {
    type: Number,
    default: null
  },
  loggedByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  loggedByShareTokenId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProjectShareToken',
    default: null
  },
  category: {
    type: String,
    required: [true, 'Material category is required'],
    trim: true
  },
  itemName: {
    type: String,
    required: [true, 'Material item name is required'],
    trim: true,
    maxlength: [120, 'Item name cannot exceed 120 characters']
  },
  plannedSpec: {
    brand: { type: String, default: '', trim: true },
    gradeSpec: { type: String, default: '', trim: true },
    unit: { type: String, default: 'unit', trim: true },
    plannedQty: { type: Number, default: 0, min: 0 },
    estimatedUnitPrice: {
      type: Number,
      default: 0,
      min: 0,
      validate: integerBDT('Estimated unit price')
    }
  },
  actualSpec: {
    brand: { type: String, default: '', trim: true },
    gradeSpec: { type: String, default: '', trim: true },
    unit: { type: String, default: 'unit', trim: true },
    actualQty: { type: Number, default: 0, min: 0 },
    actualUnitPrice: {
      type: Number,
      default: 0,
      min: 0,
      validate: integerBDT('Actual unit price')
    },
    totalActualCost: {
      type: Number,
      default: 0,
      min: 0,
      validate: integerBDT('Total actual cost')
    }
  },
  truckDimensions: {
    lengthFt: { type: Number, default: 0, min: 0 },
    widthFt: { type: Number, default: 0, min: 0 },
    heightFt: { type: Number, default: 0, min: 0 },
    calculatedCft: { type: Number, default: 0, min: 0 }
  },
  supplierInfo: {
    dealerName: { type: String, default: '', trim: true, maxlength: 120 },
    dealerPhone: { type: String, default: '', trim: true, maxlength: 30 },
    chalanNo: { type: String, default: '', trim: true, maxlength: 60 },
    bstiLicenseNo: { type: String, default: '', trim: true, maxlength: 60 }
  },
  evidence: {
    chalanEvidenceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    siteMaterialEvidenceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    chalanPhotoUrl: { type: String, default: '' },
    siteDeliveryPhotoUrl: { type: String, default: '' },
    exifVerified: { type: Boolean, default: false },
    gpsLat: { type: Number, default: null },
    gpsLng: { type: Number, default: null },
    capturedAt: { type: Date, default: null }
  },
  informationalFlags: {
    type: [InformationalFlagSchema],
    default: []
  }
}, {
  timestamps: true
});

// Indexes required by Phase 3 specification and query-plans.js:
// 1. { projectId: 1, milestoneId: 1, createdAt: -1 } — serves ledger view in project-materials.html and contract.html
MaterialDeliveryLogSchema.index({ projectId: 1, milestoneId: 1, createdAt: -1 });

// 2. { projectId: 1, 'informationalFlags.flagType': 1, createdAt: -1 } — serves filtering by gentle flags
MaterialDeliveryLogSchema.index({ projectId: 1, 'informationalFlags.flagType': 1, createdAt: -1 });

module.exports = mongoose.model('MaterialDeliveryLog', MaterialDeliveryLogSchema);
