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
    min: 0,
    // 🛡️ Phase-2 P0-10 fix: money fields are integer BDT. Fractional values
    // cause IEEE-754 drift under aggregation across many milestones. Any
    // sub-BDT precision must be rounded by the caller before persist.
    validate: {
      validator: (v) => typeof v === 'number' && Number.isInteger(v) && v <= Number.MAX_SAFE_INTEGER,
      message: 'milestone.amount must be an integer BDT value (no fractional taka).'
    }
  },
  status: {
    type: String,
    enum: ['PENDING', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'CLIENT_APPROVED', 'PAID_OFFLINE', 'PAID_OFFLINE_PENDING_CONFIRMATION', 'COMPLETED', 'DISPUTED', 'REFUNDED', 'LOCKED'],
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
  // ── Phase 21: Proof-of-Work Evidence Ledger ──────────────────────────────
  // An ordered array of submitted evidence items for this milestone.
  // Each entry is immutable once written — new submissions append to the log.
  evidenceLog: [{
    // SHA-256 of the raw image buffer.
    // Sparse unique index enforced at route layer (pre-S3 findOne check).
    // Prevents a contractor from uploading the same photo for multiple milestones
    // ("double-spend" photo fraud).
    imageHash: {
      type: String,
      required: true
    },
    // Five-tier trust classification assigned by evidenceService.js
    // CRYPTOGRAPHIC_PROOF → GPS + timestamp both verified
    // GPS_ONLY            → GPS only
    // TIME_ONLY           → Timestamp only
    // REQUIRES_CLIENT_AUDIT → No EXIF (client must manually approve)
    // REJECTED is never persisted — those requests throw before reaching the DB
    verificationTier: {
      type: String,
      enum: ['CRYPTOGRAPHIC_PROOF', 'GPS_ONLY', 'TIME_ONLY', 'REQUIRES_CLIENT_AUDIT'],
      required: true
    },
    // Whether the live-ping path (frontend navigator.geolocation) was used.
    // True = EXIF spoofing surface is completely bypassed for this submission.
    livePingVerified: {
      type: Boolean,
      default: false
    },
    // Distance from project site in metres (null if GPS unavailable)
    distanceMeters: {
      type: Number,
      default: null
    },
    // S3 object key for the stored (EXIF-stripped) image
    s3Key: {
      type: String,
      required: true
    },
    // Human-readable verification notes from evidenceService.js
    notes: [{
      type: String
    }],
    submittedAt: {
      type: Date,
      default: Date.now
    }
  }],
  // Timestamp when the first evidence item was submitted for this milestone
  proofSubmittedAt: {
    type: Date,
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
  // 🛡️ Phase-3 P1 fix: the three identity references on a ledger are set at
  // creation and never change. immutable:true blocks mass-assignment via
  // findOneAndUpdate ($set reassigns a funded contract to a new party).
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true,
    immutable: true
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  contractorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  totalContractValue: {
    type: Number,
    required: true,
    min: 1,
    // 🛡️ Phase-2 P0-10 fix: integer BDT only. See milestoneSchema.amount note.
    validate: {
      validator: (v) => typeof v === 'number' && Number.isInteger(v) && v <= Number.MAX_SAFE_INTEGER,
      message: 'totalContractValue must be an integer BDT value (no fractional taka).'
    }
  },
  ledgerStatus: {
    type: String,
    enum: ['PENDING_FUNDING', 'FUNDED', 'PARTIALLY_DISBURSED', 'FULLY_DISBURSED', 'DISPUTED', 'IN_ARBITRATION', 'PAYMENT_FAILED', 'CANCELLED'],
    default: 'PENDING_FUNDING',
    index: true
  },
  pendingTransactionId: {
    type: String,
    default: null,
    index: true
  },
  pendingTransactionIds: {
    type: [String],
    default: [],
    index: true
  },
  gatewaySessionKey: {
    type: String,
    default: null
  },
  // When the client last opened a gateway checkout. The abandonment sweeper
  // leaves the ledger alone while a recently started checkout may still pay.
  paymentInitiatedAt: {
    type: Date,
    default: null
  },
  // Gateway-confirmed payments that could NOT fund this ledger — it was
  // already funded by another transaction, or cancelled as abandoned. Each
  // entry is money SSLCommerz captured that an operator must refund.
  orphanPayments: [{
    _id: false,
    tranId: { type: String, required: true },
    valId: { type: String, required: true },
    amount: {
      type: Number,
      required: true,
      validate: {
        validator: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER,
        message: 'orphanPayments.amount must be an integer BDT value (no fractional taka).'
      }
    },
    reason: { type: String, enum: ['ALREADY_FUNDED', 'LEDGER_CANCELLED', 'LEDGER_NOT_PAYABLE'], required: true },
    receivedAt: { type: Date, default: Date.now },
    // Set by an ADMIN once the refund is issued in the SSLCommerz merchant panel.
    refundedAt: { type: Date, default: null },
    refundReference: { type: String, default: null, trim: true, maxlength: 64 },
    refundNote: { type: String, default: null, trim: true, maxlength: 500 },
    refundedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
  }],
  paidAt: {
    type: Date,
    default: null
  },
  // 🛡️ Stores the SSLCommerz val_id at the moment of IPN funding.
  // Provides a permanent, auditable link from this ledger to the gateway's
  // own transaction record. See the partial unique index below.
  paidByValId: {
    type: String,
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

// Phase 28: Compound index for the abandonment sweeper query pattern:
// { ledgerStatus: 'PENDING_FUNDING', createdAt: { $lt: expiryThreshold } }
// Allows MongoDB to resolve the scan using the index without touching documents.
escrowLedgerSchema.index({ ledgerStatus: 1, createdAt: 1 });

// 🛡️ Phase-2 P0-4: unique on paidByValId when it has a real value. A plain
// {sparse:true} would still conflict across the many docs that store the
// schema default (null) — sparse skips undefined, not null. The partial
// filter below only indexes documents whose paidByValId is a non-empty
// string, so pre-IPN ledgers (null) coexist freely while funded ledgers
// enforce one-val_id-per-ledger.
escrowLedgerSchema.index(
  { paidByValId: 1 },
  { unique: true, partialFilterExpression: { paidByValId: { $type: 'string' } } }
);

// Admin refund queue: only the rare ledgers with an orphan gateway payment are
// indexed (sparse), so listing refunds owed never scans every ledger.
escrowLedgerSchema.index({ 'orphanPayments.valId': 1 }, { sparse: true });

module.exports = mongoose.model('EscrowLedger', escrowLedgerSchema);