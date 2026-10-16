// models/Message.js
// Phase 26 — Negotiation Chat Schema
//
// Design decisions:
//   - `bidId` scopes every message to a specific bid negotiation thread.
//   - `messageType` drives rendering: TEXT is plain chat; REVISED_OFFER renders
//     an interactive "Accept" bubble in the client; OFFER_ACCEPTED is a terminal,
//     immutable record written only by the accept-offer transaction.
//   - `payload` is a typed subdocument — the fields used depend on messageType:
//       TEXT          → { text }
//       REVISED_OFFER → { text, revisedAmount, revisedDays }
//       OFFER_ACCEPTED→ { text, acceptedAmount, acceptedDays }
//   - Compound index on { bidId, createdAt: -1 } supports keyset (cursor)
//     pagination without an expensive skip scan.

const mongoose = require('mongoose');

const payloadSchema = new mongoose.Schema({
  // Human-readable body, present on all types
  text: {
    type: String,
    trim: true,
    maxlength: [2000, 'Message text exceeds maximum allowed length']
  },

  // REVISED_OFFER fields
  revisedAmount: { type: Number, min: [100, 'Revised amount is too low'] },
  revisedDays:   { type: Number, min: [1,   'Revised timeline must be at least 1 day'] },

  // OFFER_ACCEPTED fields (written once by the transaction controller)
  acceptedAmount: { type: Number },
  acceptedDays:   { type: Number }
}, { _id: false });

const messageSchema = new mongoose.Schema({
  bidId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Bid',
    required: [true, 'Every message must be scoped to a bid negotiation thread'],
    index: true
  },
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Message sender identity is required']
  },
  senderRole: {
    type: String,
    enum: ['CLIENT', 'CONTRACTOR', 'SYSTEM', 'ADMIN', 'MODERATOR'],
    required: true
  },
  recipientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  },
  messageType: {
    type: String,
    enum: ['TEXT', 'REVISED_OFFER', 'OFFER_ACCEPTED', 'SCOPE_CHANGE', 'SYSTEM_ALERT'],
    default: 'TEXT',
    required: true
  },
  payload: {
    type: payloadSchema,
    required: [true, 'Message payload is required']
  },
  // Marks whether this REVISED_OFFER has been superseded or accepted.
  // Only meaningful when messageType === 'REVISED_OFFER'.
  offerStatus: {
    type: String,
    enum: ['PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED'],
    default: 'PENDING'
  }
}, {
  timestamps: true,
  versionKey: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

messageSchema.virtual('offerDetails').get(function () {
  if (!this.payload) return undefined;
  return {
    amount: this.payload.revisedAmount ?? this.payload.acceptedAmount,
    revisedAmountBDT: this.payload.revisedAmount,
    estimatedDays: this.payload.revisedDays ?? this.payload.acceptedDays,
    status: this.offerStatus
  };
});

messageSchema.virtual('content').get(function () {
  return this.payload?.text;
});

// ─────────────────────────────────────────────
// Compound index: primary access pattern for paginated chat history
// keyset pagination query: { bidId, createdAt: { $lt: cursor } }
// ─────────────────────────────────────────────
messageSchema.index({ bidId: 1, createdAt: -1 });

// ─────────────────────────────────────────────
// Validation: REVISED_OFFER messages must carry financial/temporal fields
// ─────────────────────────────────────────────
messageSchema.pre('validate', function () {
  if (this.messageType === 'REVISED_OFFER') {
    if (!this.payload?.revisedAmount || !this.payload?.revisedDays) {
      this.invalidate(
        'payload',
        'REVISED_OFFER messages must include revisedAmount and revisedDays in the payload.'
      );
    }
  }
});

module.exports = mongoose.model('Message', messageSchema);
