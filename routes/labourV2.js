// routes/labourV2.js
// Domestic Labour Directory, Subscriptions, DMP CIMS Dossiers & 2G IVR Webhooks
'use strict';

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const { verifyToken, requireRole } = require('../middleware/auth');
const { enforceIdempotency } = require('../middleware/idempotency');
const { runTransaction } = require('../utils/transaction');
const { emitAudit } = require('../services/auditService');
const { parseFeaturePhoneWebhook } = require('../services/aiOrchestratorService');
const DomesticWorkerProfile = require('../models/DomesticWorkerProfile');
const LabourSubscription = require('../models/LabourSubscription');
const Timesheet = require('../models/Timesheet');

function operational(message, statusCode) {
  return Object.assign(new Error(message), { statusCode, isOperational: true });
}

// ── 1. POST /api/v2/labour/webhooks/sms-ivr-inbound (Public Telecom Webhook) ──
router.post(
  '/webhooks/sms-ivr-inbound',
  catchAsync(async (req, res, next) => {
    const { fromPhone, digitsOrText, callType } = req.body || {};

    if (!fromPhone || typeof fromPhone !== 'string') {
      return next(operational('fromPhone is required for telecom webhook.', 400));
    }

    const parsedEvent = parseFeaturePhoneWebhook({
      fromPhone: String(fromPhone).trim(),
      digitsOrText: String(digitsOrText || '').trim(),
      callType: callType || 'SMS_OR_IVR'
    });

    res.status(200).json({
      status: 'success',
      data: parsedEvent
    });
  })
);

// ── 2. GET /api/v2/labour/directory/search (Public Worker Directory) ──────────
router.get(
  '/directory/search',
  catchAsync(async (req, res, next) => {
    const { thana, subTier, workerCategory, limit = 20 } = req.query;

    const filter = { availability: { $in: ['AVAILABLE', 'TRIAL_BOOKED'] } };
    if (thana) filter.thana = new RegExp(`^${String(thana).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    if (subTier) filter.subTier = String(subTier).trim();
    if (workerCategory) filter.workerCategory = String(workerCategory).trim();

    const workers = await DomesticWorkerProfile.find(filter)
      .limit(Math.min(50, Math.max(1, Number(limit) || 20)))
      .sort({ createdAt: -1 })
      .lean();

    // Redact direct contact phone numbers in public listing
    const sanitized = workers.map((w) => ({
      ...w,
      phoneNumber: w.phoneNumber ? `${w.phoneNumber.slice(0, 3)}****${w.phoneNumber.slice(-3)}` : null,
      guarantors: (w.guarantors || []).map((g) => ({
        relationship: g.relationship,
        status: g.status,
        verified_via: g.verified_via,
        vouched_at: g.vouched_at
      }))
    }));

    res.status(200).json({
      status: 'success',
      count: sanitized.length,
      data: sanitized
    });
  })
);

// ── 3. POST /api/v2/labour/contracts/subscribe (Money Escrow Subscription) ────
router.post(
  '/contracts/subscribe',
  verifyToken,
  requireRole(['CLIENT']),
  enforceIdempotency,
  catchAsync(async (req, res, next) => {
    const {
      workerId,
      subTier,
      workerCategory,
      agreedMonthlySalaryAmount,
      trialShiftFeeAmount = 250
    } = req.body || {};

    if (!workerId || !mongoose.Types.ObjectId.isValid(workerId)) {
      return next(operational('Valid workerId is required.', 400));
    }
    if (!subTier || !['L1_DAILY_WAGE', 'L2_PART_TIME_MONTHLY', 'L3_FULL_TIME_MONTHLY'].includes(subTier)) {
      return next(operational('Valid subTier is required.', 400));
    }
    if (!workerCategory || typeof workerCategory !== 'string') {
      return next(operational('Valid workerCategory is required.', 400));
    }

    const salary = Number(agreedMonthlySalaryAmount);
    const trialFee = Number(trialShiftFeeAmount);

    if (!Number.isInteger(salary) || salary < 1000) {
      return next(operational('agreedMonthlySalaryAmount must be an integer of at least 1,000 BDT.', 400));
    }
    if (!Number.isInteger(trialFee) || trialFee < 0) {
      return next(operational('trialShiftFeeAmount must be a non-negative integer BDT value.', 400));
    }

    const subscription = await runTransaction(async (session) => {
      const doc = new LabourSubscription({
        clientId: req.user.userId,
        workerId,
        subTier,
        workerCategory: workerCategory.trim(),
        agreedMonthlySalaryAmount: salary,
        trialShiftFeeAmount: trialFee,
        continuityReserveBalance: 0,
        status: 'TRIAL_ACTIVE',
        trialDate: new Date()
      });

      await doc.save({ session });

      // Create initial trial timesheet
      const timesheet = new Timesheet({
        subscriptionId: doc._id,
        workerId,
        clientId: req.user.userId,
        workDate: new Date(),
        attendance_status: 'SCHEDULED',
        checkin_mode: 'SMS_OTP'
      });

      await timesheet.save({ session });

      return doc;
    });

    emitAudit({
      action: 'CONTRACT_CREATED',
      actorId: req.user.userId,
      actorRole: req.user.role,
      targetType: 'PROJECT',
      targetId: subscription._id,
      metadata: { subTier, workerCategory, salary, trialFee }
    });

    res.status(201).json({
      status: 'success',
      data: subscription
    });
  })
);

// ── 4. GET /api/v2/labour/dmp-cims-export/:subscriptionId (DMP CIMS Police Dossier)
router.get(
  '/dmp-cims-export/:subscriptionId',
  verifyToken,
  requireRole(['CLIENT', 'ADMIN', 'MODERATOR']),
  catchAsync(async (req, res, next) => {
    const { subscriptionId } = req.params;

    if (!subscriptionId || !mongoose.Types.ObjectId.isValid(subscriptionId)) {
      return next(operational('Valid subscriptionId parameter is required.', 400));
    }

    const subscription = await LabourSubscription.findById(subscriptionId).lean();
    if (!subscription) {
      return next(operational('Labour subscription not found.', 404));
    }

    // Role check: Only the owning client or administrative staff may access the dossier
    if (req.user.role === 'CLIENT' && String(subscription.clientId) !== String(req.user.userId)) {
      return next(operational('Forbidden: You can only view dossiers for your own contracted staff.', 403));
    }

    const worker = await DomesticWorkerProfile.findOne({ userId: subscription.workerId }).lean();

    const dmpCimsDossier = {
      trackingReference: worker?.ring3_dmp_cims?.cims_tracking_ref || `CIMS-DMP-${subscription._id.toString().slice(-8).toUpperCase()}`,
      jurisdictionThana: worker ? `${worker.thana} Thana, ${worker.district}` : 'Dhaka Metropolitan Police',
      citizenVerification: {
        porichoyStatus: worker?.ring1_porichoy?.face_match_percentage >= 80 ? 'BIOMETRIC_VERIFIED' : 'PENDING',
        isAdult18Plus: worker?.ring1_porichoy?.is_adult_18_plus ?? true,
        simNidMatched: worker?.ring1_porichoy?.sim_nid_matched ?? true
      },
      guarantorGraph: worker?.guarantors || [],
      employmentTerms: {
        workerCategory: subscription.workerCategory,
        subTier: subscription.subTier,
        agreedMonthlySalaryBDT: subscription.agreedMonthlySalaryAmount,
        dwpwpNoticePeriodDays: subscription.dwpwpTerms?.noticePeriodDays || 7,
        paidWeeklyHolidaysPerMonth: subscription.dwpwpTerms?.minPaidWeeklyHolidaysPerMonth || 4
      },
      qrSmartCardPayload: {
        qrHash: worker?.ring3_dmp_cims?.qr_smart_card_hash || `QR-${subscription._id}`,
        verificationPortal: 'https://buildbd.com/verify/worker'
      },
      exportedAt: new Date()
    };

    res.status(200).json({
      status: 'success',
      data: dmpCimsDossier
    });
  })
);

// ── 5. POST /api/v2/labour/disputes/security-gd (48-Hour Police GD Gate) ──────
router.post(
  '/disputes/security-gd',
  verifyToken,
  requireRole(['CLIENT', 'ADMIN', 'MODERATOR']),
  enforceIdempotency,
  catchAsync(async (req, res, next) => {
    const { subscriptionId, timesheetId, policeGdNumber, reason } = req.body || {};

    if (!subscriptionId || !mongoose.Types.ObjectId.isValid(subscriptionId)) {
      return next(operational('Valid subscriptionId is required.', 400));
    }
    if (!timesheetId || !mongoose.Types.ObjectId.isValid(timesheetId)) {
      return next(operational('Valid timesheetId is required.', 400));
    }
    if (!policeGdNumber || typeof policeGdNumber !== 'string' || !policeGdNumber.trim()) {
      return next(operational('A valid Police General Diary (GD) number is mandatory to lodge a domestic security dispute under DWPWP-2015.', 400));
    }

    const subscription = await LabourSubscription.findById(subscriptionId);
    if (!subscription) {
      return next(operational('Labour subscription not found.', 404));
    }

    if (req.user.role === 'CLIENT' && String(subscription.clientId) !== String(req.user.userId)) {
      return next(operational('Forbidden: You can only lodge disputes on your own subscriptions.', 403));
    }

    const timesheet = await Timesheet.findById(timesheetId);
    if (!timesheet) {
      return next(operational('Timesheet record not found.', 404));
    }

    timesheet.attendance_status = 'DISPUTED';
    timesheet.security_dispute = {
      is_disputed: true,
      reason_code: String(reason || 'THEFT_OR_SECURITY_BREACH').trim(),
      police_gd_number: String(policeGdNumber).trim(),
      gd_filed_at: new Date(),
      gd_verification_deadline: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48-Hour Police GD Gate
      dispute_status: 'PENDING_POLICE_GD'
    };

    await timesheet.save();

    emitAudit({
      action: 'SECURITY_DISPUTE_FILED',
      actorId: req.user.userId,
      actorRole: req.user.role,
      targetType: 'PROJECT',
      targetId: subscription._id,
      metadata: { timesheetId, policeGdNumber }
    });

    res.status(200).json({
      status: 'success',
      message: 'Police GD logged. Continuity reserve frozen for 48 hours pending station verification.',
      data: {
        timesheetId: timesheet._id,
        security_dispute: timesheet.security_dispute
      }
    });
  })
);

module.exports = router;
