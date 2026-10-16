// models/Review.js
// Phase 26.B — Cryptographic Reputation & Review Engine
//
// One review per project per client (unique compound index prevents duplicates).
// Proof-of-Work gate enforced at the route layer: at least one milestone must be
// CLIENT_APPROVED, RELEASED, or ledger must be FULLY_DISBURSED before submission.

'use strict';

const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: [true, 'Review must be linked to a project'],
    immutable: true
  },
  bidId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bid',
    required: [true, 'Review must be linked to the accepted bid'],
    immutable: true
  },
  ledgerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EscrowLedger',
    required: [true, 'Review must reference the escrow ledger as proof-of-work anchor'],
    immutable: true
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Reviewing client identity is required'],
    immutable: true
  },
  contractorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Reviewed contractor identity is required'],
    index: true,
    immutable: true
  },
  rating: {
    type: Number,
    required: [true, 'Overall rating is required'],
    min: [1, 'Minimum rating is 1'],
    max: [5, 'Maximum rating is 5']
  },
  metrics: {
    quality: {
      type: Number,
      required: [true, 'Quality metric is required'],
      min: [1, 'Minimum quality score is 1'],
      max: [5, 'Maximum quality score is 5']
    },
    timeline: {
      type: Number,
      required: [true, 'Timeline metric is required'],
      min: [1, 'Minimum timeline score is 1'],
      max: [5, 'Maximum timeline score is 5']
    },
    communication: {
      type: Number,
      required: [true, 'Communication metric is required'],
      min: [1, 'Minimum communication score is 1'],
      max: [5, 'Maximum communication score is 5']
    }
  },
  comment: {
    type: String,
    required: [true, 'A written comment is required'],
    trim: true,
    minlength: [10, 'Comment must be at least 10 characters'],
    maxlength: [1000, 'Comment cannot exceed 1000 characters']
  }
}, {
  timestamps: true,
  versionKey: false
});

// Kernel-level duplicate review prevention: one review per client per project
reviewSchema.index({ projectId: 1, clientId: 1 }, { unique: true });

// Performance index for contractor profile aggregation queries
reviewSchema.index({ contractorId: 1, createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);
