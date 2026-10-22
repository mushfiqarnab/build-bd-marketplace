// models/Timesheet.js
// Daily Attendance & Verification Timesheet (2G IVR/SMS & Smartphone Verification)
'use strict';

const mongoose = require('mongoose');

const ATTENDANCE_STATUSES = [
  'SCHEDULED',
  'PRESENT_AUTO_GATE_PING',
  'PRESENT_VERIFIED',
  'ABSENT',
  'SICK_LEAVE_PAID',
  'DISPUTED'
];

const CHECKIN_MODES = [
  'MISSED_CALL_CLI',
  'SMS_OTP',
  'QR_CODE_SCAN',
  'IVR_DTMF',
  'MANUAL_OVERRIDE'
];

const DISPUTE_STATUSES = [
  'NONE',
  'PENDING_POLICE_GD',
  'GD_CONFIRMED_FROZEN',
  'AUTO_RELEASED_TIMEOUT'
];

const TimesheetSchema = new mongoose.Schema({
  subscriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LabourSubscription',
    required: true,
    immutable: true
  },
  workerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  workDate: {
    type: Date,
    required: true
  },
  attendance_status: {
    type: String,
    enum: ATTENDANCE_STATUSES,
    default: 'SCHEDULED'
  },
  checkin_mode: {
    type: String,
    enum: CHECKIN_MODES,
    default: 'SMS_OTP'
  },
  checkin_at: {
    type: Date,
    default: null
  },
  checkout_at: {
    type: Date,
    default: null
  },

  // Sensitive cryptographic proof: excluded from default query projections
  daily_otp_hash: {
    type: String,
    select: false,
    default: null
  },

  // DWPWP-2015 48-Hour Police GD Gate for Security Disputes
  security_dispute: {
    is_disputed: { type: Boolean, default: false },
    reason_code: { type: String, default: null },
    police_gd_number: { type: String, default: null, trim: true },
    gd_filed_at: { type: Date, default: null },
    gd_verification_deadline: { type: Date, default: null },
    dispute_status: {
      type: String,
      enum: DISPUTE_STATUSES,
      default: 'NONE'
    }
  }
}, {
  timestamps: true
});

TimesheetSchema.index({ subscriptionId: 1, workDate: 1 }, { unique: true });
TimesheetSchema.index({ workerId: 1, workDate: -1 });
TimesheetSchema.index({ clientId: 1, workDate: -1 });

module.exports = mongoose.model('Timesheet', TimesheetSchema);
