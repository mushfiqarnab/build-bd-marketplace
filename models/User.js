// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  phoneNumber: { 
    type: String, 
    required: [true, 'Phone number is required'], 
    unique: true, 
    match: [/^01[3-9]\d{8}$/, 'Must be a valid Bangladeshi phone number']
  },
  role: { 
    type: String, 
    enum: ['CLIENT', 'CONTRACTOR', 'ADMIN', 'MODERATOR'], 
    required: true 
  },
  status: { 
    type: String, 
    enum: ['ACTIVE', 'SUSPENDED', 'BANNED', 'PENDING_VERIFICATION'], 
    default: 'PENDING_VERIFICATION' 
  },
  wallet: {
    lockedEscrow: {
      type: Number,
      default: 0
    },
    pendingClearance: {
      type: Number,
      default: 0
    },
    availableToWithdraw: {
      type: Number,
      default: 0
    }
  },
  // Replaced Password with highly secure OTP tracking
  otp: {
    hash: { type: String },
    expiresAt: { type: Date }
  },
  // 🛡️ Phase-1 passkey-register gate: stamped by /verify-otp on success and
  // consumed by /passkey/register/verify (must be within OTP_FRESH_WINDOW_MS).
  // Without this, knowing a victim's phone number is enough to register a
  // passkey and take over the account.
  otpVerifiedAt: { type: Date, default: null },
  preferences: {
    language: { type: String, enum: ['bn', 'en'], default: 'bn' }
  },
  // 🔐 WebAuthn: Transient challenge stored between flow step-1 (options) and step-2 (verify).
  // Cleared immediately after successful registration or authentication.
  webAuthnChallenge: {
    type: String,
    default: null
  }
}, { timestamps: true });


userSchema.index({ role: 1 });

module.exports = mongoose.model('User', userSchema);