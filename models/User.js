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
  preferences: {
    language: { type: String, enum: ['bn', 'en'], default: 'bn' }
  }
}, { timestamps: true });


userSchema.index({ role: 1 });

module.exports = mongoose.model('User', userSchema);