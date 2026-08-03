// models/Bid.js
const mongoose = require('mongoose');

const BidSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: [true, 'A bid must be linked to a valid Project ID']
  },
  contractorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'A bid must be linked to a valid Contractor ID']
  },
  bidAmount: {
    type: Number,
    required: [true, 'Financial bid amount is mandatory'],
    min: [100, 'Bid amount is suspiciously low'],
  },
  estimatedDays: {
    type: Number,
    required: [true, 'Project timeline estimation is required'],
    min: [1, 'Timeline must be at least 1 day']
  },
  proposalText: {
    type: String,
    required: [true, 'A written proposal is required'],
    trim: true,
    maxlength: [2000, 'Proposal exceeds maximum character limit']
  },
  status: {
    type: String,
    enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'],
    default: 'PENDING'
  },
  // SHA-256 of immutable bid payload at submission time (anti-tamper audit trail).
  bidFingerprint: {
    type: String,
    required: true
  },
  // 🚀 FUTURISTIC PREPARATION: Array to store secure AWS S3 / Cloudinary URLs for BOQ PDFs
  supportingDocuments: [{
    type: String
  }],
  // Dynamic itemized BOQ milestone breakdown
  itemizedBreakdown: [{
    title: { type: String },
    amount: { type: Number },
    estimatedDays: { type: Number }
  }]
}, { timestamps: true });

// 🛡️ MICROSCOPIC INTEGRITY GUARD: Financial & Temporal Coherence
BidSchema.pre('validate', function() {
  if (this.itemizedBreakdown && this.itemizedBreakdown.length > 0) {
    
    // 1. Financial Verification (Rounding mitigates floating-point injection)
    const sumOfMilestones = this.itemizedBreakdown.reduce((total, item) => total + (item.amount || 0), 0);
    if (Math.round(sumOfMilestones) !== Math.round(this.bidAmount)) {
      this.invalidate('itemizedBreakdown', `Mathematical Anomaly: Sum of itemized milestones (${sumOfMilestones} BDT) diverges from total bidAmount (${this.bidAmount} BDT).`);
    }

    // 2. Temporal Verification (Time-bound accountability)
    const sumOfDays = this.itemizedBreakdown.reduce((total, item) => total + (item.estimatedDays || 0), 0);
    if (sumOfDays !== this.estimatedDays) {
      this.invalidate('itemizedBreakdown', `Temporal Anomaly: Sum of milestone durations (${sumOfDays} days) diverges from total estimated project days (${this.estimatedDays}).`);
    }
  }
});

// 🛡️ MICROSCOPIC DEFENSE: Unique Compound Index
// This physically prevents a contractor from submitting two bids to the same project.
// If they try, MongoDB will reject it at the C++ hardware level, protecting our Node.js memory.
BidSchema.index({ projectId: 1, contractorId: 1 }, { unique: true });

// Performance index for clients querying all bids on their specific project
BidSchema.index({ projectId: 1, bidAmount: 1 });

module.exports = mongoose.model('Bid', BidSchema);