// models/DisputeTicket.js
// 🛡️ Phase 23 — Decentralized Dispute Arbitration & Moderator Engine Schema
//
// Bundles complete evidence dossiers for moderators to resolve milestone disputes:
//   - Cryptographic snapshot of contractor's evidence submission (s3Url, imageHash, gpsData)
//   - Client rejection reason (minlength 10)
//   - Moderator resolution verdict, justification (minlength 20 — Build-BD binding arbitration policy), and audit trail
//   - Unique compound index on { ledgerId: 1, milestoneIndex: 1 } prevents duplicate tickets per milestone.

const mongoose = require('mongoose');

const contractorEvidenceSnapshotSchema = new mongoose.Schema({
  s3Url: {
    type: String,
    default: null
  },
  imageHash: {
    type: String,
    default: null
  },
  gpsData: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    accuracy: { type: Number, default: null }
  },
  submittedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const resolutionSchema = new mongoose.Schema({
  moderatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  verdict: {
    type: String,
    enum: ['FORCE_APPROVE', 'CANCEL_AND_RESTART'],
    default: null
  },
  justification: {
    type: String,
    minlength: [20, 'Moderator justification must be at least 20 characters for non-repudiation auditability.'],
    trim: true,
    default: null
  },
  resolvedAt: {
    type: Date,
    default: null
  }
}, { _id: false });

const disputeTicketSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: [true, 'Dispute ticket must be linked to a valid Project ID'],
    index: true
  },
  ledgerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EscrowLedger',
    required: [true, 'Dispute ticket must be linked to an Escrow Ledger ID'],
    index: true
  },
  milestoneIndex: {
    type: Number,
    required: [true, 'Milestone index is mandatory']
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Client ID is mandatory']
  },
  contractorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Contractor ID is mandatory']
  },
  clientRejectionReason: {
    type: String,
    required: [true, 'Client rejection reason is mandatory'],
    minlength: [10, 'Client rejection reason must be at least 10 characters'],
    trim: true
  },
  contractorEvidenceSnapshot: {
    type: contractorEvidenceSnapshotSchema,
    default: () => ({})
  },
  status: {
    type: String,
    enum: ['OPEN_FOR_REVIEW', 'MEDIATION_IN_PROGRESS', 'RESOLVED', 'RESOLVED_FORCE_APPROVED', 'RESOLVED_CANCELLED'],
    default: 'OPEN_FOR_REVIEW',
    index: true
  },
  resolution: {
    type: resolutionSchema,
    default: () => ({})
  }
}, {
  timestamps: true
});

// 🛡️ MICROSCOPIC INTEGRITY GUARD: Unique Compound Index
// Prevents duplicate dispute tickets from being created for the same milestone in a contract.
disputeTicketSchema.index({ ledgerId: 1, milestoneIndex: 1 }, { unique: true });
// Moderator queue: tickets by status, oldest first.
disputeTicketSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('DisputeTicket', disputeTicketSchema);
