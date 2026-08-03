// models/EscrowLedger.js
const mongoose = require('mongoose');

const milestoneSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  releasePercentage: {
    type: Number,
    required: true,
    min: 0,
    max: 100
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  status: {
    type: String,
    enum: ['PENDING', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'COMPLETED', 'DISPUTED', 'REFUNDED'],
    default: 'PENDING'
  },
  disputeReason: {
    type: String,
    trim: true,
    default: null
  },
  arbitrationNotes: {
    type: String,
    trim: true,
    default: null
  },
  proofOfWorkUrl: {
    type: String,
    default: null
  },
  proofOfWorkHash: {
    type: String,
    default: null
  },
  proofOfWorkMimeType: {
    type: String,
    default: null
  },
  proofOfWorkSize: {
    type: Number,
    default: null
  },
  releasedAt: {
    type: Date,
    default: null
  },
  approvedAt: {
    type: Date,
    default: null
  },
  settlementStatus: {
    type: String,
    enum: ['NOT_APPLICABLE', 'PENDING_CLEARANCE', 'SETTLED', 'REFUNDED'],
    default: 'NOT_APPLICABLE'
  },
  clearsAt: {
    type: Date,
    default: null,
    index: true
  }
});

const escrowLedgerSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  contractorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  totalContractValue: {
    type: Number,
    required: true,
    min: 1
  },
  ledgerStatus: {
    type: String,
    enum: ['PENDING_FUNDING', 'FUNDED', 'PARTIALLY_DISBURSED', 'FULLY_DISBURSED', 'DISPUTED', 'IN_ARBITRATION', 'PAYMENT_FAILED'],
    default: 'PENDING_FUNDING',
    index: true
  },
  pendingTransactionId: {
    type: String,
    default: null,
    index: true
  },
  gatewaySessionKey: {
    type: String,
    default: null
  },
  paidAt: {
    type: Date,
    default: null
  },
  milestones: [milestoneSchema]
}, {
  timestamps: true,
  autoIndex: true
});

// 🚀 MODERN VALIDATION: IEEE 754 Floating-Point Safe Escrow Integrity Guard
escrowLedgerSchema.path('milestones').validate(function (milestones) {
  if (!milestones || milestones.length === 0) return false;
  
  const totalPercentage = milestones.reduce((sum, m) => sum + m.releasePercentage, 0);
  
  // 🛡️ EPSILON CHECK: Safely absorbs microscopic V8 binary rounding drift
  // Validates that the sum is between 99.99 and 100.01
  return Math.abs(totalPercentage - 100) < 0.015; 
}, 'Smart Contract Validation Error: Milestone release percentages must equal exactly 100.00%.');

module.exports = mongoose.model('EscrowLedger', escrowLedgerSchema);