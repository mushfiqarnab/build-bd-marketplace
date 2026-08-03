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
  }]
}, { timestamps: true });

// 🛡️ MICROSCOPIC DEFENSE: Unique Compound Index
// This physically prevents a contractor from submitting two bids to the same project.
// If they try, MongoDB will reject it at the C++ hardware level, protecting our Node.js memory.
BidSchema.index({ projectId: 1, contractorId: 1 }, { unique: true });

// Performance index for clients querying all bids on their specific project
BidSchema.index({ projectId: 1, bidAmount: 1 });

module.exports = mongoose.model('Bid', BidSchema);