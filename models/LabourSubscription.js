// models/LabourSubscription.js
// Monthly Recurring Retainer & Weekly Payroll Escrow Subscription (DWPWP-2015 Compliant)
'use strict';

const mongoose = require('mongoose');
const { integerBDT } = require('../utils/money');

const SUBSCRIPTION_STATUSES = [
  'PENDING_ESCROW',
  'TRIAL_ACTIVE',
  'ACTIVE_RETAINER',
  'COMPLETED',
  'DISPUTED',
  'CANCELLED'
];

const SUB_TIERS = [
  'L1_DAILY_WAGE',
  'L2_PART_TIME_MONTHLY',
  'L3_FULL_TIME_MONTHLY'
];

const LabourSubscriptionSchema = new mongoose.Schema({
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  workerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    immutable: true
  },
  escrowLedgerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'EscrowLedger',
    immutable: true,
    default: null
  },
  subTier: {
    type: String,
    enum: SUB_TIERS,
    required: true
  },
  workerCategory: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: SUBSCRIPTION_STATUSES,
    default: 'PENDING_ESCROW'
  },

  // Integer-BDT financial fields (100% whole Taka; utils/money.js invariant)
  agreedMonthlySalaryAmount: {
    type: Number,
    required: true,
    validate: integerBDT('Agreed monthly salary amount')
  },
  trialShiftFeeAmount: {
    type: Number,
    required: true,
    validate: integerBDT('Trial shift fee amount')
  },
  continuityReserveBalance: {
    type: Number,
    default: 0,
    validate: integerBDT('Continuity reserve balance')
  },

  // DWPWP-2015 Policy Protections
  dwpwpTerms: {
    maxDailyHours: { type: Number, default: 12 },
    minPaidWeeklyHolidaysPerMonth: { type: Number, default: 4 },
    noticePeriodDays: { type: Number, default: 7 },
    doubleBlindIvrShieldActive: { type: Boolean, default: true },
    policeGdGateHours: { type: Number, default: 48 }
  },

  // Weekly settlement & trial tracking (Thursday 20:00 payroll loop)
  currentWeekIndex: {
    type: Number,
    default: 1,
    min: 1,
    max: 4
  },
  week1Settled: { type: Boolean, default: false },
  week2Settled: { type: Boolean, default: false },
  week3Settled: { type: Boolean, default: false },
  week4Settled: { type: Boolean, default: false },
  trialApproved: { type: Boolean, default: false },
  trialDate: { type: Date, default: null }
}, {
  timestamps: true
});

LabourSubscriptionSchema.index({ clientId: 1, status: 1 });
LabourSubscriptionSchema.index({ workerId: 1, status: 1 });
LabourSubscriptionSchema.index({ status: 1, currentWeekIndex: 1 });

module.exports = mongoose.model('LabourSubscription', LabourSubscriptionSchema);
