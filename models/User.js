// models/User.js
const mongoose = require('mongoose');
const { integerBDT } = require('../utils/money');

const userSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: [true, 'Phone number is required'],
    unique: true,
    match: [/^01[3-9]\d{8}$/, 'Must be a valid Bangladeshi phone number'],
    // 🛡️ Phase-3 P1 fix: phoneNumber is the identity key. Changing it is a
    // full re-registration, not an update. immutable:true makes Mongoose
    // silently drop $set attempts via findOneAndUpdate.
    immutable: true
  },
  role: {
    type: String,
    enum: ['CLIENT', 'CONTRACTOR', 'ADMIN', 'MODERATOR', 'SUPPLIER'],
    required: true,
    // 🛡️ Phase-3 P1 fix: role is set at registration time only. A leaked
    // ObjectId must not escalate CLIENT→ADMIN via a crafted update. Role
    // changes legitimately require an admin flow with an audit trail.
    immutable: true
  },
  status: {
    type: String,
    enum: ['ACTIVE', 'SUSPENDED', 'BANNED', 'PENDING_VERIFICATION'],
    default: 'PENDING_VERIFICATION'
  },
  wallet: {
    // Integer BDT. $inc updates skip validators, which is why every money
    // path computes its deltas with utils/money (whole taka only).
    lockedEscrow: {
      type: Number,
      default: 0,
      validate: integerBDT('wallet.lockedEscrow')
    },
    pendingClearance: {
      type: Number,
      default: 0,
      validate: integerBDT('wallet.pendingClearance')
    },
    availableToWithdraw: {
      type: Number,
      default: 0,
      validate: integerBDT('wallet.availableToWithdraw')
    }
  },
  // Replaced Password with highly secure OTP tracking
  otp: {
    // 🛡️ Phase-3 P1 fix: select:false means otp.hash is not loaded by default.
    // Any route that needs it (verify-otp) must opt in with .select('+otp.hash').
    hash: { type: String, select: false },
    expiresAt: { type: Date, select: false },
    // Wrong guesses against the current code; it is voided at the limit.
    attempts: { type: Number, default: 0, select: false }
  },
  // 🛡️ Phase-1 passkey-register gate: stamped by /verify-otp on success and
  // consumed by /passkey/register/verify (must be within OTP_FRESH_WINDOW_MS).
  // Without this, knowing a victim's phone number is enough to register a
  // passkey and take over the account.
  // 🛡️ Phase-3: select:false keeps the stamp out of default projection.
  otpVerifiedAt: { type: Date, default: null, select: false },
  preferences: {
    language: { type: String, enum: ['bn', 'en'], default: 'bn' }
  },
  // Bumped on logout; every session token embeds it, so incrementing it
  // revokes all of the user's outstanding tokens at once.
  sessionVersion: { type: Number, default: 0, min: 0 },
  // 🔐 WebAuthn: Transient challenge stored between flow step-1 (options) and step-2 (verify).
  // Cleared immediately after successful registration or authentication.
  // 🛡️ Phase-3: select:false keeps the transient challenge out of default
  // projection — leaking it enables mid-flow replay / targeting.
  webAuthnChallenge: {
    type: String,
    default: null,
    select: false
  }
}, {
  timestamps: true,
  toJSON: {
    // 🛡️ Phase-3 P1 fix: strip sensitive fields from JSON serialisation.
    // Routes that res.json(user) directly must not leak otp, webAuthnChallenge,
    // or otpVerifiedAt even when they happened to be loaded by a +select query.
    transform(_doc, ret) {
      delete ret.otp;
      delete ret.webAuthnChallenge;
      delete ret.otpVerifiedAt;
      delete ret.__v;
      return ret;
    }
  },
  toObject: {
    transform(_doc, ret) {
      delete ret.otp;
      delete ret.webAuthnChallenge;
      delete ret.otpVerifiedAt;
      delete ret.__v;
      return ret;
    }
  }
});


userSchema.index({ role: 1 });

module.exports = mongoose.model('User', userSchema);
