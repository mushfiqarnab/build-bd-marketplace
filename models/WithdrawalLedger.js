const mongoose = require('mongoose');

const withdrawalLedgerSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
    // 🛡️ Phase-2 P0-13 fix: integer BDT only (no fractional taka).
    validate: {
      validator: (v) => typeof v === 'number' && Number.isInteger(v) && v <= Number.MAX_SAFE_INTEGER,
      message: 'withdrawal amount must be an integer BDT value.'
    }
  },
  currency: {
    type: String,
    default: 'BDT'
  },
  destinationBankDetails: {
    accountName: { type: String, required: true },
    accountNumber: { type: String, required: true },
    routingNumber: { type: String, required: true },
    bankName: { type: String, required: true }
  },
  status: {
    type: String,
    enum: ['PROCESSING', 'COMPLETED', 'FAILED', 'MANUAL_REVIEW'],
    default: 'PROCESSING',
    index: true
  },
  bankTransactionId: {
    type: String,
    default: null
  },
  failureReason: {
    type: String,
    default: null
  },
  idempotencyKey: {
    type: String,
    required: true,
    unique: true
  },
  reconciliationAttempts: {
    type: Number,
    default: 0,
    min: 0
  },
  lastReconciledAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Sweeper query: stale PROCESSING rows eligible for anti-entropy.
withdrawalLedgerSchema.index({ status: 1, updatedAt: 1, reconciliationAttempts: 1 });
// Contractor withdrawal history (GET /api/finance/withdrawals), newest first.
withdrawalLedgerSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('WithdrawalLedger', withdrawalLedgerSchema);
