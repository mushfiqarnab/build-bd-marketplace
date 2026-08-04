// models/PaymentReceipt.js
// 🛡️ Phase 22 — Zero-Trust Offline Settlement & Reconciliation Schema
//
// Designed for Bangladesh's offline settlement reality (bKash, Nagad, Cash, Bank Transfer).
// Solves Client-side payment fraud ("Double-Spending" of mobile money transaction IDs)
// using a sparse unique compound index on { paymentMethod: 1, trxId: 1 }.

const mongoose = require('mongoose');

const PaymentReceiptSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: [true, 'Payment receipt must be linked to a valid Project ID'],
    index: true
  },
  ledgerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EscrowLedger',
    required: [true, 'Payment receipt must be linked to an Escrow Ledger ID'],
    index: true
  },
  milestoneId: {
    type: mongoose.Schema.Types.ObjectId,
    required: [true, 'Payment receipt must specify the target Milestone ID'],
    index: true
  },
  milestoneIndex: {
    type: Number,
    required: true
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Client ID is mandatory'],
    index: true
  },
  contractorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Contractor ID is mandatory'],
    index: true
  },
  amountBDT: {
    type: Number,
    required: [true, 'Financial amount in BDT is mandatory'],
    min: [1, 'Amount must be greater than zero']
  },
  paymentMethod: {
    type: String,
    enum: {
      values: ['BKASH', 'NAGAD', 'CASH', 'BANK'],
      message: '{VALUE} is not a valid payment method. Allowed: BKASH, NAGAD, CASH, BANK'
    },
    required: [true, 'Payment method is mandatory']
  },
  trxId: {
    type: String,
    trim: true,
    default: null
  },
  s3ReceiptUrl: {
    type: String,
    required: [true, 'S3 Receipt image key or URL is mandatory']
  },
  s3ReceiptHash: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['PENDING_VERIFICATION', 'VERIFIED', 'REJECTED'],
    default: 'VERIFIED'
  },
  rejectionReason: {
    type: String,
    default: null
  }
}, { timestamps: true });

// 🛡️ CRITICAL SECURITY GUARANTEE: Sparse Unique Compound Index
// Prevents a client from re-using or double-spending the same bKash/Nagad/Bank transaction ID
// across different milestones or projects. If trxId is populated and non-empty,
// MongoDB enforces uniqueness at the C++ index layer.
PaymentReceiptSchema.index(
  { paymentMethod: 1, trxId: 1 },
  { unique: true, sparse: true }
);


module.exports = mongoose.model('PaymentReceipt', PaymentReceiptSchema);
