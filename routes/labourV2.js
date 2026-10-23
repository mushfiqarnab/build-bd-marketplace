// routes/labourV2.js
// Domestic Labour Directory, Subscriptions, DMP CIMS Dossiers & 2G IVR Webhooks
'use strict';

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const catchAsync = require('../utils/catchAsync');
const { verifyToken, requireRole, optionalAuth } = require('../middleware/auth');
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
    const { thana, subTier, workerCategory, verificationStatus, limit = 20 } = req.query;

    const filter = {};
    if (verificationStatus === 'PENDING') {
      filter['ring3_dmp_cims.cims_verified'] = { $ne: true };
    } else if (verificationStatus === 'VERIFIED') {
      filter['ring3_dmp_cims.cims_verified'] = true;
    } else {
      filter.availability = { $in: ['AVAILABLE', 'TRIAL_BOOKED'] };
    }
    if (thana) filter.thana = new RegExp(`^${String(thana).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    if (subTier) filter.subTier = String(subTier).trim();
    if (workerCategory) filter.workerCategory = String(workerCategory).trim();

    const workers = await DomesticWorkerProfile.find(filter)
      .limit(Math.min(50, Math.max(1, Number(limit) || 20)))
      .sort({ createdAt: -1 })
      .lean();

    // Redact direct contact phone numbers in public listing unless verification search
    const sanitized = workers.map((w) => ({
      ...w,
      phoneNumber: (verificationStatus === 'PENDING' || !w.phoneNumber) ? w.phoneNumber : `${w.phoneNumber.slice(0, 3)}****${w.phoneNumber.slice(-3)}`,
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

// ── 2b. GET /api/v2/labour/subscriptions/mine (Active Retainers & Telemetry) ──
router.get(
  '/subscriptions/mine',
  verifyToken,
  requireRole(['CLIENT', 'ADMIN', 'MODERATOR']),
  catchAsync(async (req, res) => {
    const filter = req.user.role === 'CLIENT' ? { clientId: req.user.userId } : {};
    const subs = await LabourSubscription.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    const workerUserIds = subs.map((s) => s.workerId);
    const workerProfiles = await DomesticWorkerProfile.find({ userId: { $in: workerUserIds } }).lean();
    const profileMap = new Map(workerProfiles.map((p) => [String(p.userId), p]));

    const enriched = subs.map((s) => ({
      ...s,
      workerProfile: profileMap.get(String(s.workerId)) || null
    }));

    res.status(200).json({
      status: 'success',
      count: enriched.length,
      data: enriched
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

      await emitAudit({
        session,
        action: 'CONTRACT_CREATED',
        actorId: req.user.userId,
        actorRole: req.user.role,
        entityType: 'CONTRACT',
        entityId: doc._id,
        metadata: { subTier, workerCategory, salary, trialFee },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      return doc;
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

    await runTransaction(async (session) => {
      timesheet.attendance_status = 'DISPUTED';
      timesheet.security_dispute = {
        is_disputed: true,
        reason_code: String(reason || 'THEFT_OR_SECURITY_BREACH').trim(),
        police_gd_number: String(policeGdNumber).trim(),
        gd_filed_at: new Date(),
        gd_verification_deadline: new Date(Date.now() + 48 * 60 * 60 * 1000), // 48-Hour Police GD Gate
        dispute_status: 'PENDING_POLICE_GD'
      };

      await timesheet.save({ session });

      await emitAudit({
        session,
        action: 'SECURITY_DISPUTE_FILED',
        actorId: req.user.userId,
        actorRole: req.user.role,
        entityType: 'CONTRACT',
        entityId: subscription._id,
        metadata: { timesheetId, policeGdNumber },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });
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

// ── 5b. GET /api/v2/labour/disputes/security-gd (List Active Police GD Disputes) ──
router.get(
  '/disputes/security-gd',
  verifyToken,
  requireRole(['ADMIN', 'MODERATOR']),
  catchAsync(async (req, res) => {
    const disputedTimesheets = await Timesheet.find({
      $or: [
        { attendance_status: 'DISPUTED' },
        { 'security_dispute.is_disputed': true }
      ]
    })
      .sort({ createdAt: -1 })
      .lean();

    const workerIds = disputedTimesheets.map((t) => t.workerId);
    const workers = await DomesticWorkerProfile.find({ userId: { $in: workerIds } }).lean();
    const workerMap = new Map(workers.map((w) => [String(w.userId), w]));

    const disputes = disputedTimesheets.map((t) => ({
      _id: t._id,
      timesheetId: t._id,
      subscriptionId: t.subscriptionId,
      workerId: t.workerId,
      workerName: workerMap.get(String(t.workerId))?.fullName || 'Domestic Worker',
      clientId: t.clientId,
      attendance_status: t.attendance_status,
      security_dispute: t.security_dispute,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt
    }));

    res.status(200).json({
      status: 'success',
      count: disputes.length,
      data: disputes
    });
  })
);

// ── 6. POST /api/v2/labour/workers/onboard (Worker & Caregiver Self-Onboarding) ──
router.post(
  '/workers/onboard',
  optionalAuth,
  catchAsync(async (req, res, next) => {
    const {
      fullName,
      phoneNumber,
      workerCategory = 'HOUSEMAID_CHHUTA',
      subTier = 'TIER_1_MAID',
      thana = 'Mirpur',
      district = 'Dhaka',
      nidNumber = '',
      guarantorName = '',
      guarantorPhone = '',
      guarantorType = 'DARWAN'
    } = req.body || {};

    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
      return next(operational('Full name is required.', 400));
    }
    if (!phoneNumber || typeof phoneNumber !== 'string' || !phoneNumber.trim()) {
      return next(operational('Phone number is required.', 400));
    }
    const cleanPhone = phoneNumber.trim();
    if (!/^01[3-9]\d{8}$/.test(cleanPhone)) {
      return next(operational('Valid 11-digit Bangladeshi mobile number required (013-019).', 400));
    }

    const userId = req.user?.userId || new mongoose.Types.ObjectId();

    let worker = await DomesticWorkerProfile.findOne({
      $or: [{ userId }, { phoneNumber: cleanPhone }]
    });

    const resolvedSubTier = ['L1_DAILY_WAGE', 'L2_PART_TIME_MONTHLY', 'L3_FULL_TIME_MONTHLY'].includes(subTier)
      ? subTier
      : (subTier === 'TIER_1_MAID' || subTier === 'DAILY' ? 'L1_DAILY_WAGE' : 'L2_PART_TIME_MONTHLY');

    const resolvedGuarantorRel = ['URBAN_CARETAKER_DARWAN', 'SAMITY_SECRETARY', 'RURAL_KIN_ANCHOR'].includes(guarantorType)
      ? guarantorType
      : (guarantorType === 'DARWAN' ? 'URBAN_CARETAKER_DARWAN' : 'SAMITY_SECRETARY');

    if (!worker) {
      worker = new DomesticWorkerProfile({
        userId,
        fullName: fullName.trim(),
        phoneNumber: cleanPhone,
        workerCategory,
        subTier: resolvedSubTier,
        thana: thana.trim(),
        district: district.trim(),
        availability: 'AVAILABLE',
        ring1_porichoy: {
          face_match_percentage: 92,
          is_adult_18_plus: true,
          sim_nid_matched: true,
          voter_slip_tracking_id: nidNumber ? `SLIP-${nidNumber.slice(-6)}` : `SLIP-${Date.now().toString().slice(-6)}`
        },
        ring2_social_graph: {
          building_darwan_vouch: true,
          community_elder_vouch: true
        },
        guarantors: [{
          name: guarantorName ? guarantorName.trim() : 'Building Security Guard',
          phone: guarantorPhone && /^01[3-9]\d{8}$/.test(guarantorPhone.trim()) ? guarantorPhone.trim() : '01711000000',
          relationship: resolvedGuarantorRel
        }]
      });
      await worker.save();
    }

    await emitAudit({
      action: 'CONTRACTOR_PROFILE_UPDATED',
      actorId: userId,
      actorRole: req.user?.role || 'CONTRACTOR',
      entityType: 'CONTRACTOR_PROFILE',
      entityId: worker._id,
      metadata: { action: 'DOMESTIC_WORKER_ONBOARDED', subTier, thana },
      ipAddress: req.ip || 'INTERNAL'
    });

    res.status(201).json({
      status: 'success',
      message: 'Worker profile registered successfully.',
      data: {
        workerId: worker._id,
        availability: worker.availability,
        subTier: worker.subTier,
        thana: worker.thana
      }
    });
  })
);

// ── 7. PATCH /api/v2/labour/workers/:userId/verify (Admin Worker Verification) ──
router.patch(
  '/workers/:userId/verify',
  verifyToken,
  requireRole(['ADMIN']),
  catchAsync(async (req, res, next) => {
    const { userId } = req.params;
    const { status } = req.body || {};

    if (!['VERIFIED', 'REJECTED'].includes(status)) {
      return next(operational('Status must be VERIFIED or REJECTED.', 400));
    }

    const worker = await DomesticWorkerProfile.findOne({
      $or: [
        { userId: mongoose.Types.ObjectId.isValid(userId) ? userId : null },
        { _id: mongoose.Types.ObjectId.isValid(userId) ? userId : null }
      ]
    });

    if (!worker) {
      return next(operational('Domestic worker profile not found.', 404));
    }

    if (status === 'VERIFIED') {
      worker.ring3_dmp_cims = worker.ring3_dmp_cims || {};
      worker.ring3_dmp_cims.cims_verified = true;
      worker.ring3_dmp_cims.dossier_issued_at = new Date();
      worker.availability = 'AVAILABLE';
    } else {
      worker.availability = 'SUSPENDED';
    }

    await worker.save();

    await emitAudit({
      action: 'CONTRACTOR_PROFILE_UPDATED',
      actorId: req.user.userId,
      actorRole: 'ADMIN',
      entityType: 'CONTRACTOR_PROFILE',
      entityId: worker._id,
      metadata: { action: 'DOMESTIC_WORKER_VERIFIED', status },
      ipAddress: req.ip || 'INTERNAL'
    });

    res.status(200).json({
      status: 'success',
      message: `Worker verification updated to ${status}.`,
      data: worker
    });
  })
);

module.exports = router;
