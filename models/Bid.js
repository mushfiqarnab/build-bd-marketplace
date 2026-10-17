// models/Bid.js
// 🛡️ Phase 21: Anti-Cartel sealed bidding schema
//   - bidFingerprint: SHA-256 payload seal (tamper detection at DB level)
//   - cryptographicProof: optional FIDO2 biometric signature block
//     populated when the contractor uses passkey-signing for non-repudiation
//   - TAMPERED_FLAGGED status: assigned by the integrity-check route if
//     the fingerprint no longer matches the persisted payload
//   - Compound unique index enforces one bid per contractor per project
const mongoose = require('mongoose');
const { integerBDT } = require('../utils/money');

const BidSchema = new mongoose.Schema({
  // 🛡️ Phase-3 P1 fix: a bid is bound to one project and one contractor at
  // creation. $set must never reassign either reference on an existing bid.
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: [true, 'A bid must be linked to a valid Project ID'],
    immutable: true
  },
  contractorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'A bid must be linked to a valid Contractor ID'],
    immutable: true
  },
  bidAmount: {
    type: Number,
    required: [true, 'Financial bid amount is mandatory'],
    min: [100, 'Bid amount is suspiciously low'],
    validate: integerBDT('Bid amount')
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
    enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'TAMPERED_FLAGGED'],
    default: 'PENDING'
  },
  // SHA-256 of the immutable bid payload sealed at submission time.
  // Any divergence between the live payload and this hash is a tamper signal.
  bidFingerprint: {
    type: String,
    required: true
  },
  // 🔐 FIDO2 Biometric Bid Signing (Phase 21)
  // When a contractor submits via the passkey-signing flow, these fields capture
  // the cryptographic proof of intent — non-repudiation under Build-BD policy.
  // The contractor's authenticator signs the exact bid payload; the server verifies
  // the signature against the public key stored in PasskeyCredential.
  cryptographicProof: {
    // Base64URL-encoded signature bytes from the authenticator's secure enclave
    signature: { type: String, default: null },
    // Base64URL-encoded authenticatorData from the assertion response
    authenticatorData: { type: String, default: null },
    // Counter value at the moment of signing (monotonic — prevents replay)
    counterAtSigning: { type: Number, default: null },
    // ISO timestamp when the proof was captured
    signedAt: { type: Date, default: null }
  },
  // 🚀 FUTURISTIC PREPARATION: Array to store secure AWS S3 / Cloudinary URLs for BOQ PDFs
  supportingDocuments: [{
    type: String
  }],
  // Dynamic itemized BOQ milestone breakdown
  itemizedBreakdown: [{
    title: { type: String },
    amount: { type: Number, validate: integerBDT('Line item amount') },
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
// If they try, MongoDB will reject it at the C++ hardware level.
BidSchema.index({ projectId: 1, contractorId: 1 }, { unique: true });

// Performance index for clients querying all bids on their specific project
BidSchema.index({ projectId: 1, bidAmount: 1 });
// "My bids" (GET /api/bids/mine) — without this the query scans every bid.
BidSchema.index({ contractorId: 1, createdAt: -1 });

module.exports = mongoose.model('Bid', BidSchema);