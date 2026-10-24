// models/Project.js
const mongoose = require('mongoose');
const { integerBDT } = require('../utils/money');
const {
  PROJECT_CATEGORIES,
  TRADE_MICRO_CATEGORIES,
  CONTRACT_MODALITIES
} = require('../config/bdWorkTaxonomy');

const ProjectSchema = new mongoose.Schema({
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Project must be linked to a valid client ID'],
    // 🛡️ Phase-3 P1 fix: a project's owner is set at creation. $set via
    // findOneAndUpdate must not be able to reassign it to a different user.
    immutable: true
  },
  title: {
    type: String,
    required: [true, 'Project title is mandatory'],
    trim: true,
    maxlength: [100, 'Title cannot exceed 100 characters']
  },
  category: {
    type: String, 
    required: true,
    enum: {
      values: PROJECT_CATEGORIES,
      message: '{VALUE} is not a recognized construction or service category'
    }
  },
  contractModality: {
    type: String,
    enum: CONTRACT_MODALITIES,
    default: 'WITH_MATERIAL_TURNKEY'
  },
  description: {
    type: String,
    required: [true, 'Project scope description is required']
  },
  location: {
    type: String,
    required: [true, 'Geographic location is required'] 
  },
  budget: {
    type: Number,
    required: [true, 'Estimated budget allocation is required'],
    min: [200, 'Minimum budget allocation is 200 BDT'],
    validate: integerBDT('Budget')
  },
  status: {
    type: String,
    enum: ['OPEN', 'UNDER_BIDDING', 'ASSIGNED', 'COMPLETED', 'CANCELLED'],
    default: 'OPEN'
  },
  // Set atomically by the contract formation route when a bid is accepted
  // and an EscrowLedger is created. Null until a contract exists.
  awardedContractorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // 🗺️ Phase 21: Site GPS coordinates for evidence geofence verification.
  // Optional — absence degrades evidence to REQUIRES_CLIENT_AUDIT tier gracefully.
  // Decimal degrees (WGS-84). Populated by client at project creation.
  siteCoordinates: {
    latitude:  { type: Number, default: null, min: -90,  max: 90  },
    longitude: { type: Number, default: null, min: -180, max: 180 }
  }
}, { timestamps: true });

// ⚡ HIGH-SCALE OPTIMIZATION: Compound Indexes for lightning-fast contractor searches
ProjectSchema.index({ location: 1, status: 1 });
ProjectSchema.index({ category: 1, status: 1 });
ProjectSchema.index({ clientId: 1, createdAt: -1 });
ProjectSchema.index({ clientId: 1, updatedAt: -1 });
// Contractor feed: { status: 'OPEN' } newest-first, optionally by category.
// Without these the feed is a full collection scan + in-memory sort
// (caught by scripts/qa/query-plans.js).
ProjectSchema.index({ status: 1, createdAt: -1 });
ProjectSchema.index({ status: 1, category: 1, createdAt: -1 });
ProjectSchema.index({ status: 1, budget: -1, createdAt: -1 });
ProjectSchema.index({ status: 1, budget: 1, createdAt: -1 });

module.exports = mongoose.model('Project', ProjectSchema);
module.exports.TRADE_MICRO_CATEGORIES = TRADE_MICRO_CATEGORIES;
module.exports.PROJECT_CATEGORIES = PROJECT_CATEGORIES;
module.exports.CONTRACT_MODALITIES = CONTRACT_MODALITIES;
