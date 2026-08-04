// routes/governance.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Middleware & Utilities
const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const { emitAudit } = require('../services/auditService');
const { generateUploadSignature } = require('../services/s3Service');
const { enforceIdempotency } = require('../middleware/idempotency');

// Database Models
const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');

// ==========================================
// @route   POST /api/governance/approve/:ledgerId/milestone/:milestoneIndex
// @desc    Atomically approve milestone and disburse fractional escrow funds
// @access  Private (Strictly assigned CLIENT only)
// ==========================================
router.post(
  '/approve/:ledgerId/milestone/:milestoneIndex',
  verifyToken,
  requireRole(['CLIENT']),
  enforceIdempotency,
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;
    const idx = parseInt(milestoneIndex, 10);

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const ledger = await EscrowLedger.findById(ledgerId).session(session);
      if (!ledger) {
        const err = new Error('Target escrow ledger not found.');
        err.statusCode = 404;
        err.isOperational = true;
        throw err;
      }

      if (ledger.clientId.toString() !== req.user.userId) {
        const err = new Error('Authorization Breach: You do not own the client rights to liquidate this escrow.');
        err.statusCode = 403;
        err.isOperational = true;
        throw err;
      }

      if (ledger.ledgerStatus !== 'FUNDED' && ledger.ledgerStatus !== 'PARTIALLY_DISBURSED') {
        const err = new Error(`Transaction Rejected: Escrow ledger is currently '${ledger.ledgerStatus}'. Funds cannot be released.`);
        err.statusCode = 400;
        err.isOperational = true;
        throw err;
      }

      if (idx < 0 || idx >= ledger.milestones.length) {
        const err = new Error('Index Out of Bounds: The specified milestone identifier does not exist.');
        err.statusCode = 400;
        err.isOperational = true;
        throw err;
      }

      const targetMilestone = ledger.milestones[idx];
      if (targetMilestone.status !== 'PROOF_SUBMITTED') {
        const err = new Error(`Governance Exception: Milestone state must be 'PROOF_SUBMITTED'. Active state is '${targetMilestone.status}'.`);
        err.statusCode = 400;
        err.isOperational = true;
        throw err;
      }

      const milestoneValue = targetMilestone.amount;
      const PLATFORM_FEE_RATE = 0.05;

      const totalMilestoneCents = Math.round(milestoneValue * 100);
      const platformFeeCents = Math.round(totalMilestoneCents * PLATFORM_FEE_RATE);
      const contractorPayoutCents = totalMilestoneCents - platformFeeCents;

      const platformFeeFinal = platformFeeCents / 100;
      const contractorPayoutFinal = contractorPayoutCents / 100;
      const clearsAtDate = new Date();
      clearsAtDate.setDate(clearsAtDate.getDate() + 2);

      ledger.milestones[idx].status = 'COMPLETED';
      ledger.milestones[idx].approvedAt = new Date();
      ledger.milestones[idx].settlementStatus = 'PENDING_CLEARANCE';
      ledger.milestones[idx].clearsAt = clearsAtDate;

      const hasUnpaidMilestones = ledger.milestones.some((m) => m.status !== 'COMPLETED');
      ledger.ledgerStatus = hasUnpaidMilestones ? 'PARTIALLY_DISBURSED' : 'FULLY_DISBURSED';

      await ledger.save({ session });

      const contractorUpdate = await User.findByIdAndUpdate(
        ledger.contractorId,
        { $inc: { 'wallet.pendingClearance': contractorPayoutFinal } },
        { session, new: true }
      );
      if (!contractorUpdate) {
        const err = new Error('Critical Integrity Failure: Target contractor account could not be located.');
        err.statusCode = 400;
        err.isOperational = true;
        throw err;
      }

      const treasuryUpdate = await User.findOneAndUpdate(
        { role: 'ADMIN', phoneNumber: process.env.TREASURY_PHONE }, // 🛡️ Dynamic mapping
        { $inc: { 'wallet.pendingClearance': platformFeeFinal } },
        { session, new: true }
      );

      if (!treasuryUpdate) {
        throw new Error('Critical Integrity Failure: Platform treasury account not found. Cannot route platform commission. Transaction aborted.');
      }

      await emitAudit({
        session,
        entityId: ledger._id,
        entityType: 'ESCROW_LEDGER',
        action: 'MILESTONE_APPROVED',
        actorId: req.user.userId,
        actorRole: req.user.role,
        metadata: {
          milestoneIndex: idx,
          grossAmount: milestoneValue,
          contractorNet: contractorPayoutFinal,
          platformFee: platformFeeFinal
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      await session.commitTransaction();
      session.endSession();

      res.status(200).json({
        status: 'success',
        message: `Milestone ${idx} successfully approved. Funds atomically disbursed.`,
        disbursedAmounts: {
          totalGross: milestoneValue,
          contractorNet: contractorPayoutFinal,
          platformCommission: platformFeeFinal
        },
        currentLedgerStatus: ledger.ledgerStatus
      });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();

      error.statusCode = error.statusCode || 400;
      error.isOperational = true;
      return next(error);
    }
  })
);

// ==========================================
// @route   GET /api/governance/escrow/:projectId
// @desc    Retrieve escrow ledger details for an authorized client or contractor
// @access  Private (Strictly assigned CLIENT or CONTRACTOR)
// ==========================================
router.get(
  '/escrow/:projectId',
  verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR']),
  catchAsync(async (req, res, next) => {
    const { projectId } = req.params;

    const ledger = await EscrowLedger.findOne({
      projectId,
      $or: [
        { clientId: req.user.userId },
        { contractorId: req.user.userId }
      ]
    }).lean();

    if (!ledger) {
      const err = new Error('Escrow ledger not found or access denied.');
      err.statusCode = 404;
      err.isOperational = true;
      return next(err);
    }

    res.status(200).json({
      status: 'success',
      data: ledger
    });
  })
);

// ==========================================
// @route   GET /api/governance/audit-trail/:ledgerId
// @desc    Return immutable chronological history for an authorized ledger
// @access  Private (Strictly assigned CLIENT or CONTRACTOR)
// ==========================================
router.get(
  '/audit-trail/:ledgerId',
  verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR']),
  catchAsync(async (req, res, next) => {
    const { ledgerId } = req.params;

    const ledger = await EscrowLedger.findById(ledgerId).lean();
    if (!ledger) {
      const err = new Error('Escrow ledger not found.');
      err.statusCode = 404;
      err.isOperational = true;
      return next(err);
    }

    if (ledger.clientId.toString() !== req.user.userId && ledger.contractorId.toString() !== req.user.userId) {
      const err = new Error('Access denied: you are not a participant in this escrow.');
      err.statusCode = 403;
      err.isOperational = true;
      return next(err);
    }

    const auditTrail = await require('../models/AuditLog')
      .find({ entityId: ledgerId })
      .sort({ createdAt: 1 })
      .lean();

    res.status(200).json({
      status: 'success',
      data: auditTrail
    });
  })
);

// ==========================================
// 🛡️ TIER-1 CLOUD: STEP 1 - Generate Pre-Signed URL & Cryptographic Proof Token (CPT)
// @route   POST /api/governance/proof/signature/:ledgerId/milestone/:milestoneIndex
// @desc    Generate time-limited S3 pre-signed upload URL & cryptographic binding token
// @access  Private (Strictly assigned CONTRACTOR only)
// ==========================================
router.post(
  '/proof/signature/:ledgerId/milestone/:milestoneIndex',
  verifyToken,
  requireRole(['CONTRACTOR']),
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;
    const { contentType } = req.body;
    const idx = parseInt(milestoneIndex, 10);

    if (!contentType) {
      return next(Object.assign(new Error('contentType is required (e.g., application/pdf, image/jpeg).'), { statusCode: 400, isOperational: true }));
    }

    const ledger = await EscrowLedger.findById(ledgerId).lean();
    if (!ledger) {
      return next(Object.assign(new Error('Target escrow ledger not found.'), { statusCode: 404, isOperational: true }));
    }

    if (ledger.contractorId.toString() !== req.user.userId) {
      return next(Object.assign(new Error('Authorization Breach: You are not the assigned contractor for this escrow.'), { statusCode: 403, isOperational: true }));
    }

    if (idx < 0 || idx >= ledger.milestones.length) {
      return next(Object.assign(new Error('Milestone index out of bounds.'), { statusCode: 400, isOperational: true }));
    }

    const targetMilestone = ledger.milestones[idx];
    if (targetMilestone.status !== 'IN_PROGRESS') {
      return next(Object.assign(new Error(`Proof signature request rejected. Milestone status must be IN_PROGRESS. Current status: ${targetMilestone.status}`), { statusCode: 400, isOperational: true }));
    }

    if (ledger.ledgerStatus !== 'FUNDED' && ledger.ledgerStatus !== 'PARTIALLY_DISBURSED') {
      return next(Object.assign(new Error('Transaction Rejected: Escrow ledger must be funded by the client before construction proof of work can be submitted.'), { statusCode: 403, isOperational: true }));
    }

    const signature = await generateUploadSignature(ledgerId, idx, contentType);

    // 🛡️ CRYPTOGRAPHIC BINDING: Issue a short-lived token (CPT) signed with JWT_SECRET
    // Prevents Phantom Proof spoofing by binding the exact fileKey to this ledger and milestone
    const jwt = require('jsonwebtoken');
    const proofToken = jwt.sign(
      {
        fileKey: signature.fileKey,
        ledgerId: String(ledger._id),
        milestoneIndex: idx
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    res.status(200).json({
      status: 'success',
      message: 'Cloud upload signature and CPT generated successfully.',
      data: {
        ...signature,
        proofToken
      }
    });
  })
);

// ==========================================
// 🛡️ TIER-1 CLOUD: STEP 2 - Verify CPT & Execute ACID Confirmation
// @route   POST /api/governance/proof/confirm/:ledgerId/milestone/:milestoneIndex
// @desc    Cryptographically verify CPT, confirm cloud upload, and mutate state
// @access  Private (Strictly assigned CONTRACTOR only)
// ==========================================
router.post(
  '/proof/confirm/:ledgerId/milestone/:milestoneIndex',
  verifyToken,
  requireRole(['CONTRACTOR']),
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;
    const { proofToken } = req.body;
    const idx = parseInt(milestoneIndex, 10);

    if (!proofToken || typeof proofToken !== 'string') {
      return next(Object.assign(new Error('Cryptographic proofToken is required to confirm cloud upload.'), { statusCode: 400, isOperational: true }));
    }

    const jwt = require('jsonwebtoken');
    let decodedToken;
    try {
      decodedToken = jwt.verify(proofToken, process.env.JWT_SECRET);
    } catch (jwtError) {
      return next(Object.assign(new Error('Invalid or expired proofToken. Please request a new upload signature.'), { statusCode: 401, isOperational: true }));
    }

    // 🛡️ TAMPER DEFENSE: Assert boundary match between token payload and route parameters
    if (decodedToken.ledgerId !== ledgerId || Number(decodedToken.milestoneIndex) !== idx) {
      return next(Object.assign(new Error('Token boundary violation: proofToken does not match target ledger or milestone.'), { statusCode: 403, isOperational: true }));
    }

    const verifiedFileKey = decodedToken.fileKey;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const ledger = await EscrowLedger.findById(ledgerId).session(session);
      if (!ledger) {
        throw Object.assign(new Error('Target escrow ledger not found.'), { statusCode: 404, isOperational: true });
      }

      if (ledger.contractorId.toString() !== req.user.userId) {
        throw Object.assign(new Error('Authorization Breach: You are not the assigned contractor for this escrow.'), { statusCode: 403, isOperational: true });
      }

      if (idx < 0 || idx >= ledger.milestones.length) {
        throw Object.assign(new Error('Milestone index out of bounds.'), { statusCode: 400, isOperational: true });
      }

      const targetMilestone = ledger.milestones[idx];
      if (targetMilestone.status !== 'IN_PROGRESS') {
        throw Object.assign(new Error(`Proof confirmation rejected. Milestone status must be IN_PROGRESS. Current status: ${targetMilestone.status}`), { statusCode: 400, isOperational: true });
      }

      if (ledger.ledgerStatus !== 'FUNDED' && ledger.ledgerStatus !== 'PARTIALLY_DISBURSED') {
        throw Object.assign(new Error('Transaction Rejected: Escrow ledger must be funded by the client before construction proof of work can be submitted.'), { statusCode: 403, isOperational: true });
      }

      ledger.milestones[idx].status = 'PROOF_SUBMITTED';
      ledger.milestones[idx].proofOfWorkUrl = verifiedFileKey;
      ledger.markModified('milestones');

      await ledger.save({ session });

      await emitAudit({
        session,
        entityId: ledger._id,
        entityType: 'ESCROW_LEDGER',
        action: 'PROOF_SUBMITTED',
        actorId: req.user.userId,
        actorRole: req.user.role,
        metadata: {
          milestoneIndex: idx,
          fileKey: verifiedFileKey
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      await session.commitTransaction();
      session.endSession();

      res.status(200).json({
        status: 'success',
        message: 'Milestone proof successfully committed to the governance engine.',
        data: {
          fileKey: verifiedFileKey,
          status: 'PROOF_SUBMITTED'
        }
      });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      error.statusCode = error.statusCode || 400;
      error.isOperational = true;
      return next(error);
    }
  })
);

// ==========================================
// @route   POST /api/governance/dispute/:ledgerId/milestone/:milestoneIndex
// @desc    Client triggers a dispute, freezing the ledger into IN_ARBITRATION state
// @access  Private (Strictly assigned CLIENT only)
// ==========================================
router.post(
  '/dispute/:ledgerId/milestone/:milestoneIndex',
  verifyToken,
  requireRole(['CLIENT']),
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;
    const { reason } = req.body;
    const idx = parseInt(milestoneIndex, 10);

    if (!reason || reason.trim().length < 10) {
      const err = new Error('A detailed dispute reason (minimum 10 characters) is required.');
      err.statusCode = 400;
      err.isOperational = true;
      return next(err);
    }

    const query = {
      _id: ledgerId,
      clientId: req.user.userId,
      ledgerStatus: { $in: ['FUNDED', 'PARTIALLY_DISBURSED'] },
      [`milestones.${idx}.status`]: 'PROOF_SUBMITTED'
    };

    const updatePayload = {
      $set: {
        [`milestones.${idx}.status`]: 'DISPUTED',
        [`milestones.${idx}.disputeReason`]: reason.trim(),
        ledgerStatus: 'IN_ARBITRATION'
      }
    };

    const frozenLedger = await EscrowLedger.findOneAndUpdate(query, updatePayload, { new: true });

    if (!frozenLedger) {
      const err = new Error('Dispute Lockout: Milestone state is invalid, or you do not have authorization to freeze this ledger.');
      err.statusCode = 409;
      err.isOperational = true;
      return next(err);
    }

    res.status(200).json({
      status: 'success',
      message: `Milestone ${idx} locked. Escrow frozen and escalated to Platform Arbitration.`,
      currentLedgerStatus: frozenLedger.ledgerStatus
    });
  })
);

// ==========================================
// @route   POST /api/governance/arbitrate/:ledgerId/milestone/:milestoneIndex
// @desc    Admin executes a verdict, atomically disbursing or refunding fixed-point funds
// @access  Private (Strictly ADMIN only)
// ==========================================
router.post(
  '/arbitrate/:ledgerId/milestone/:milestoneIndex',
  verifyToken,
  requireRole(['ADMIN']),
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;
    const { decision, arbitrationNotes } = req.body;
    const idx = parseInt(milestoneIndex, 10);

    if (decision !== 'FAVOR_CLIENT' && decision !== 'FAVOR_CONTRACTOR') {
      const err = new Error("Invalid verdict. Decision must be exactly 'FAVOR_CLIENT' or 'FAVOR_CONTRACTOR'.");
      err.statusCode = 400;
      err.isOperational = true;
      return next(err);
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const ledger = await EscrowLedger.findById(ledgerId).session(session);
      if (!ledger) throw Object.assign(new Error('Target escrow ledger not found.'), { statusCode: 404, isOperational: true });
      if (ledger.ledgerStatus !== 'IN_ARBITRATION') throw Object.assign(new Error(`Ledger is not in arbitration. Current state: ${ledger.ledgerStatus}`), { statusCode: 409, isOperational: true });
      if (idx < 0 || idx >= ledger.milestones.length) throw Object.assign(new Error('Milestone Index Out of Bounds.'), { statusCode: 400, isOperational: true });

      const targetMilestone = ledger.milestones[idx];
      if (targetMilestone.status !== 'DISPUTED') throw Object.assign(new Error('Target milestone is not actively disputed.'), { statusCode: 409, isOperational: true });

      const totalMilestoneCents = Math.round(targetMilestone.amount * 100);

      if (decision === 'FAVOR_CONTRACTOR') {
        const platformFeeCents = Math.round(totalMilestoneCents * 0.05);
        const contractorPayoutCents = totalMilestoneCents - platformFeeCents;

        const safeContractorPayout = Number((contractorPayoutCents / 100).toFixed(2));
        const safePlatformFee = Number((platformFeeCents / 100).toFixed(2));

        await User.findByIdAndUpdate(ledger.contractorId, { $inc: { 'wallet.pendingClearance': safeContractorPayout } }, { session, new: true });

        const treasury = await User.findOneAndUpdate(
          { role: 'ADMIN', phoneNumber: process.env.TREASURY_PHONE }, // 🛡️ Dynamic mapping
          { $inc: { 'wallet.pendingClearance': safePlatformFee } },
          { session, new: true }
        );
        if (!treasury) throw Object.assign(new Error('Critical: Platform treasury not found.'), { statusCode: 500, isOperational: true });

        ledger.milestones[idx].status = 'COMPLETED';
        ledger.milestones[idx].approvedAt = new Date();
        ledger.milestones[idx].settlementStatus = 'PENDING_CLEARANCE';
        ledger.milestones[idx].clearsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      } else if (decision === 'FAVOR_CLIENT') {
        const safeClientRefund = Number((totalMilestoneCents / 100).toFixed(2));

        const clientRefund = await User.findByIdAndUpdate(
          ledger.clientId,
          { $inc: { 'wallet.availableToWithdraw': safeClientRefund } },
          { session, new: true }
        );
        if (!clientRefund) throw Object.assign(new Error('Critical: Client wallet account not found for refund routing.'), { statusCode: 500, isOperational: true });

        ledger.milestones[idx].status = 'REFUNDED';
      }

      ledger.milestones[idx].arbitrationNotes = arbitrationNotes || 'Resolved by platform admin.';
      ledger.markModified('milestones');

      await emitAudit({
        session,
        entityId: ledger._id,
        entityType: 'PLATFORM_ARBITRATION',
        action: decision === 'FAVOR_CLIENT' ? 'ARBITRATION_VERDICT_CLIENT' : 'ARBITRATION_VERDICT_CONTRACTOR',
        actorId: req.user.userId,
        actorRole: req.user.role,
        metadata: {
          milestoneIndex: idx,
          decision,
          arbitrationNotes: arbitrationNotes || 'Resolved by platform admin.'
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      const hasUnresolved = ledger.milestones.some((m) => m.status !== 'COMPLETED' && m.status !== 'REFUNDED');
      ledger.ledgerStatus = hasUnresolved ? 'PARTIALLY_DISBURSED' : 'FULLY_DISBURSED';

      await ledger.save({ session });
      await session.commitTransaction();
      session.endSession();

      res.status(200).json({
        status: 'success',
        message: `Arbitration verdict executed: ${decision}. Funds routed with ACID integrity.`,
        currentLedgerStatus: ledger.ledgerStatus
      });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      error.statusCode = error.statusCode || 400;
      error.isOperational = true;
      return next(error);
    }
  })
);

module.exports = router;