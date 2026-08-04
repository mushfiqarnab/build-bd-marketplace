// models/Project.js
const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema({
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Project must be linked to a valid client ID']
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
      values: ['Residential', 'Commercial', 'Infrastructure', 'Interior', 'Renovation'],
      message: '{VALUE} is not a recognized construction category'
    }
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
    min: [1000, 'Minimum budget allocation is 1,000 BDT']
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

module.exports = mongoose.model('Project', ProjectSchema);