const mongoose = require('mongoose');

// 🛡️ Phase-1 ship-blocker fix: uniqueness is on (key, userId), NOT key alone.
// With the old `unique: true` on `key`, two different users sending the same
// client-generated Idempotency-Key would collide: user 2's insert fails with
// a duplicate-key error even though the (key, userId) pair is unique.
//
// A `key_1` unique index may still exist on the running collection from the
// old schema. Drop it with scripts/migrate-idempotency-index.js once per
// deployment before shipping this change.
const idempotencySchema = new mongoose.Schema({
  key: {
    type: String,
    required: true
  },
  payloadHash: {
    type: String,
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  responseCode: {
    type: Number,
    default: null
  },
  responseBody: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400
  }
});

idempotencySchema.index({ key: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('IdempotencyKey', idempotencySchema);
