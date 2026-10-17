// routes/settlement.js
// 🛡️ Phase 22 — Zero-Trust Offline Settlement & Reconciliation Router
//
// Solves Client-side fraud in Bangladesh's offline payment landscape.
//
// API Contract:
//   POST /api/settlement/milestone/:id/approve
//        Client approves Evidence Sandbox photo → milestone transitions to CLIENT_APPROVED.
//
//   POST /api/settlement/milestone/:id/reject
//        Client rejects milestone work → milestone transitions to DISPUTED,
//        EscrowLedger transitions to IN_ARBITRATION. Requires 10+ char reason.
//
//   POST /api/settlement/milestone/:id/submit-payment
//        Client submits offline payment proof (bKash, Nagad, Cash, Bank).
//        Uses zero-RAM S3 pre-signed upload architecture for receipt screenshots.
//        Enforces sparse unique index on { paymentMethod, trxId } — mathematically
//        blocking MFS transaction ID reuse across milestones.
//        Updates milestone state to PAID_OFFLINE.
//
//   GET  /api/settlement/receipt/presigned-url
//        Generates zero-RAM S3 pre-signed POST policy for payment receipt screenshots.

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const { emitAudit } = require('../services/auditService');
const { generateEvidenceUploadPolicy, verifyObjectExists } = require('../services/s3Service');
const jwt = require('jsonwebtoken');

const EscrowLedger = require('../models/EscrowLedger');
const PaymentReceipt = require('../models/PaymentReceipt');
const Project = require('../models/Project');

/**
 * Helper: Resolve EscrowLedger document and milestone target by ID or index.
 * Identifier can be:
 *   - Milestone subdocument _id
 *   - EscrowLedger _id (uses query param or default first uncompleted milestone)
 */
async function resolveLedgerAndMilestone(identifier, userId) {
  let ledger = null;
  let milestoneIndex = -1;

  // Try finding ledger where milestone subdocument _id matches identifier
  if (mongoose.Types.ObjectId.isValid(identifier)) {
    ledger = await EscrowLedger.findOne({ 'milestones._id': identifier });
    if (ledger) {
      milestoneIndex = ledger.milestones.findIndex(
        (m) => m._id.toString() === identifier.toString()
      );
    } else {
      // Try finding ledger by ledgerId directly
      ledger = await EscrowLedger.findById(identifier);
      if (ledger && ledger.milestones.length > 0) {
        // Default to first milestone matching PROOF_SUBMITTED or IN_PROGRESS
        milestoneIndex = ledger.milestones.findIndex(
          (m) => m.status === 'PROOF_SUBMITTED' || m.status === 'IN_PROGRESS' || m.status === 'CLIENT_APPROVED'
        );
        if (milestoneIndex === -1) milestoneIndex = 0;
      }
    }
  }

  if (!ledger) {
    const err = new Error('Target escrow ledger or milestone identifier not found.');
    err.statusCode = 404;
    err.isOperational = true;
    throw err;
  }

  if (ledger.clientId.toString() !== userId) {
    const err = new Error('Authorization Breach: You are not the client owner of this contract ledger.');
    err.statusCode = 403;
    err.isOperational = true;
    throw err;
  }

  if (milestoneIndex < 0 || milestoneIndex >= ledger.milestones.length) {
    const err = new Error('Invalid milestone index resolution.');
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }

  return { ledger, milestoneIndex, milestone: ledger.milestones[milestoneIndex] };
}

// ─────────────────────────────────────────────────────────────────────────────
// @route   GET /api/settlement/receipt/presigned-url
// @desc    Generate zero-RAM S3 pre-signed POST policy for receipt screenshots
// @access  Private (CLIENT)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/receipt/presigned-url',
  verifyToken,
  requireRole(['CLIENT']),
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex, contentType } = req.query;

    if (!ledgerId || milestoneIndex === undefined || !contentType) {
      return next(Object.assign(
        new Error('Query params required: ledgerId, milestoneIndex, contentType (e.g. image/jpeg).'),
        { statusCode: 400, isOperational: true }
      ));
    }

    const idx = parseInt(milestoneIndex, 10);
    const ledger = await EscrowLedger.findById(ledgerId).lean();
    if (!ledger) return next(Object.assign(new Error('Escrow ledger not found.'), { statusCode: 404, isOperational: true }));

    if (ledger.clientId.toString() !== req.user.userId) {
      return next(Object.assign(new Error('Authorization Breach: You are not the owner of this contract.'), { statusCode: 403, isOperational: true }));
    }

    const policy = await generateEvidenceUploadPolicy(ledgerId, idx, contentType);

    const s3KeyToken = jwt.sign(
      {
        s3Key: policy.s3Key,
        ledgerId: String(ledger._id),
        milestoneIndex: idx,
        clientId: req.user.userId,
        type: 'PAYMENT_RECEIPT'
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    res.status(200).json({
      status: 'success',
      message: 'Payment receipt S3 upload policy generated. Backend RAM untouched.',
      data: {
        uploadUrl: policy.url,
        uploadFields: policy.fields,
        s3Key: policy.s3Key,
        s3KeyToken,
        expiresInSeconds: policy.expiresInSeconds
      }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/settlement/milestone/:id/approve
// @desc    Client accepts Evidence Sandbox proof photo → milestone -> CLIENT_APPROVED
// @access  Private (Strictly assigned CLIENT only)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/milestone/:id/approve',
  verifyToken,
  requireRole(['CLIENT']),
  catchAsync(async (req, res, next) => {
    const { id } = req.params;
    const { ledger, milestoneIndex, milestone } = await resolveLedgerAndMilestone(id, req.user.userId);

    if (milestone.status !== 'PROOF_SUBMITTED') {
      return next(Object.assign(
        new Error(`Approve rejected. Milestone status must be PROOF_SUBMITTED. Current: '${milestone.status}'.`),
        { statusCode: 400, isOperational: true }
      ));
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const freshLedger = await EscrowLedger.findById(ledger._id).session(session);
      const targetMilestone = freshLedger.milestones[milestoneIndex];

      targetMilestone.status = 'CLIENT_APPROVED';
      targetMilestone.approvedAt = new Date();

      freshLedger.markModified('milestones');
      await freshLedger.save({ session });

      await emitAudit({
        session,
        entityId: freshLedger._id,
        entityType: 'ESCROW_LEDGER',
        action: 'MILESTONE_APPROVED_CLIENT',
        actorId: req.user.userId,
        actorRole: req.user.role,
        metadata: {
          milestoneIndex,
          milestoneTitle: targetMilestone.title,
          amount: targetMilestone.amount
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      await session.commitTransaction();
      session.endSession();

      res.status(200).json({
        status: 'success',
        message: `Milestone '${targetMilestone.title}' approved by client. Ready for offline payment settlement.`,
        data: {
          ledgerId: freshLedger._id,
          milestoneIndex,
          status: 'CLIENT_APPROVED',
          approvedAt: targetMilestone.approvedAt
        }
      });
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      return next(err);
    }
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/settlement/milestone/:id/reject
// @desc    Client rejects milestone proof → milestone -> DISPUTED, ledger -> IN_ARBITRATION
// @access  Private (Strictly assigned CLIENT only)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/milestone/:id/reject',
  verifyToken,
  requireRole(['CLIENT']),
  catchAsync(async (req, res, next) => {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
      return next(Object.assign(
        new Error('A detailed rejection reason (minimum 10 characters) is required.'),
        { statusCode: 400, isOperational: true }
      ));
    }

    const { ledger, milestoneIndex, milestone } = await resolveLedgerAndMilestone(id, req.user.userId);

    if (milestone.status !== 'PROOF_SUBMITTED') {
      return next(Object.assign(
        new Error(`Rejection invalid. Milestone status must be PROOF_SUBMITTED. Current: '${milestone.status}'.`),
        { statusCode: 400, isOperational: true }
      ));
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const freshLedger = await EscrowLedger.findById(ledger._id).session(session);
      const targetMilestone = freshLedger.milestones[milestoneIndex];

      targetMilestone.status = 'DISPUTED';
      targetMilestone.disputeReason = reason.trim();
      freshLedger.ledgerStatus = 'IN_ARBITRATION';

      freshLedger.markModified('milestones');
      await freshLedger.save({ session });

      await emitAudit({
        session,
        entityId: freshLedger._id,
        entityType: 'ESCROW_LEDGER',
        action: 'MILESTONE_REJECTED_CLIENT',
        actorId: req.user.userId,
        actorRole: req.user.role,
        metadata: {
          milestoneIndex,
          reason: reason.trim()
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      await session.commitTransaction();
      session.endSession();

      res.status(200).json({
        status: 'success',
        message: `Milestone rejected. Escrow ledger frozen and escalated to Platform Arbitration.`,
        data: {
          ledgerId: freshLedger._id,
          milestoneIndex,
          milestoneStatus: 'DISPUTED',
          ledgerStatus: 'IN_ARBITRATION',
          disputeReason: reason.trim()
        }
      });
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      return next(err);
    }
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/settlement/milestone/:id/submit-payment
// @desc    Client submits offline payment proof (bKash/Nagad/Cash/Bank)
//          Uses zero-RAM S3 architecture for receipt screenshots.
//          Sparse unique compound index on { paymentMethod, trxId } blocks
//          MFS transaction ID double-spending at database layer.
//          Milestone transitions to PAID_OFFLINE.
// @access  Private (Strictly assigned CLIENT only)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/milestone/:id/submit-payment',
  verifyToken,
  requireRole(['CLIENT']),
  catchAsync(async (req, res, next) => {
    const { id } = req.params;
    const {
      paymentMethod,
      trxId,
      amountBDT,
      s3ReceiptUrl,
      s3KeyToken,
      s3ReceiptHash
    } = req.body;

    // ── Input assertions ──────────────────────────────────────────────────────
    const ALLOWED_METHODS = new Set(['BKASH', 'NAGAD', 'CASH', 'BANK']);
    if (!paymentMethod || !ALLOWED_METHODS.has(String(paymentMethod).toUpperCase())) {
      return next(Object.assign(
        new Error(`paymentMethod is mandatory. Allowed: ${[...ALLOWED_METHODS].join(', ')}.`),
        { statusCode: 400, isOperational: true }
      ));
    }

    const safeMethod = String(paymentMethod).toUpperCase();
    const safeAmount = Number(amountBDT);

    if (!Number.isFinite(safeAmount) || safeAmount <= 0) {
      return next(Object.assign(new Error('amountBDT must be a positive number.'), { statusCode: 400, isOperational: true }));
    }

    // Mobile financial services (bKash, Nagad, Bank) require a non-empty transaction ID
    const cleanTrxId = trxId && typeof trxId === 'string' ? trxId.trim() : null;
    if (['BKASH', 'NAGAD', 'BANK'].includes(safeMethod) && !cleanTrxId) {
      return next(Object.assign(
        new Error(`trxId (Transaction ID) is mandatory for ${safeMethod} payments to prevent fraud.`),
        { statusCode: 400, isOperational: true }
      ));
    }

    // ── Pre-signed upload key resolution ──────────────────────────────────────
    let finalS3ReceiptUrl = s3ReceiptUrl;
    if (s3KeyToken) {
      try {
        const decoded = jwt.verify(s3KeyToken, process.env.JWT_SECRET);
        finalS3ReceiptUrl = decoded.s3Key;
      } catch (jwtErr) {
        return next(Object.assign(new Error('Invalid or expired s3KeyToken for payment receipt upload.'), { statusCode: 401, isOperational: true }));
      }
    }

    if (!finalS3ReceiptUrl || typeof finalS3ReceiptUrl !== 'string') {
      return next(Object.assign(new Error('s3ReceiptUrl or s3KeyToken is required.'), { statusCode: 400, isOperational: true }));
    }

    // ── HeadObject: Physical S3 reconciliation ────────────────────────────────
    const fileExists = await verifyObjectExists(finalS3ReceiptUrl);
    if (!fileExists) {
      return next(Object.assign(
        new Error('Physical reconciliation failed: Payment receipt image not found in S3. Complete upload before submitting.'),
        { statusCode: 400, isOperational: true }
      ));
    }

    // ── Resolve ledger & milestone ────────────────────────────────────────────
    const { ledger, milestoneIndex, milestone } = await resolveLedgerAndMilestone(id, req.user.userId);

    // Milestone must be CLIENT_APPROVED or PROOF_SUBMITTED before payment can be logged
    if (!['CLIENT_APPROVED', 'PROOF_SUBMITTED'].includes(milestone.status)) {
      return next(Object.assign(
        new Error(`Payment submission rejected. Milestone status must be CLIENT_APPROVED or PROOF_SUBMITTED. Current: '${milestone.status}'.`),
        { statusCode: 400, isOperational: true }
      ));
    }

    // 🛡️ Phase-2 P0-2 fix: the submitted amount MUST equal the milestone amount.
    // Without this guard, a client could mark a 10,000 BDT milestone PAID_OFFLINE
    // with a 10 BDT receipt and drain the contractor's claim on escrow.
    if (safeAmount !== milestone.amount) {
      return next(Object.assign(
        new Error(`Payment amount mismatch: submitted ${safeAmount} BDT does not match milestone amount ${milestone.amount} BDT. Full milestone amount is required.`),
        { statusCode: 400, isOperational: true }
      ));
    }

    // ── Create PaymentReceipt (Sparse Unique Index prevents MFS Double-Spend) ─
    let paymentReceipt;
    try {
      paymentReceipt = await PaymentReceipt.create({
        projectId: ledger.projectId,
        ledgerId: ledger._id,
        milestoneId: milestone._id,
        milestoneIndex,
        clientId: req.user.userId,
        contractorId: ledger.contractorId,
        amountBDT: safeAmount,
        paymentMethod: safeMethod,
        trxId: cleanTrxId,
        s3ReceiptUrl: finalS3ReceiptUrl,
        s3ReceiptHash: s3ReceiptHash || null,
        status: 'VERIFIED'
      });
    } catch (dbErr) {
      if (dbErr.code === 11000) {
        console.error(`🚨 [DoubleSpendBlocked] Duplicate ${safeMethod} TrxID '${cleanTrxId}' rejected by Mongo sparse index`);
        return next(Object.assign(
          new Error(`Fraud Alert: Transaction ID '${cleanTrxId}' has already been submitted for a previous ${safeMethod} payment. Re-using transaction IDs is prohibited.`),
          { statusCode: 409, isOperational: true }
        ));
      }
      return next(dbErr);
    }

    // ── ACID commit: Update milestone state to PAID_OFFLINE ───────────────────
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const freshLedger = await EscrowLedger.findById(ledger._id).session(session);
      const targetMilestone = freshLedger.milestones[milestoneIndex];

      targetMilestone.status = 'PAID_OFFLINE';
      targetMilestone.settlementStatus = 'SETTLED';
      if (!targetMilestone.approvedAt) targetMilestone.approvedAt = new Date();

      // Check if all milestones on this ledger are now PAID_OFFLINE or COMPLETED
      const allDone = freshLedger.milestones.every(
        (m) => m.status === 'PAID_OFFLINE' || m.status === 'COMPLETED' || m.status === 'REFUNDED'
      );
      if (allDone) {
        freshLedger.ledgerStatus = 'FULLY_DISBURSED';
      } else {
        freshLedger.ledgerStatus = 'PARTIALLY_DISBURSED';
      }

      freshLedger.markModified('milestones');
      await freshLedger.save({ session });

      await emitAudit({
        session,
        entityId: freshLedger._id,
        entityType: 'PAYMENT_RECEIPT',
        action: 'OFFLINE_PAYMENT_SUBMITTED',
        actorId: req.user.userId,
        actorRole: req.user.role,
        metadata: {
          receiptId: paymentReceipt._id,
          milestoneIndex,
          paymentMethod: safeMethod,
          trxId: cleanTrxId,
          amountBDT: safeAmount
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      await session.commitTransaction();
      session.endSession();

      res.status(201).json({
        status: 'success',
        message: `Offline ${safeMethod} payment submitted and mathematically sealed. Milestone updated to PAID_OFFLINE.`,
        data: {
          receiptId: paymentReceipt._id,
          paymentMethod: safeMethod,
          trxId: cleanTrxId,
          amountBDT: safeAmount,
          milestoneStatus: 'PAID_OFFLINE',
          ledgerStatus: freshLedger.ledgerStatus
        }
      });
    } catch (err) {
      await session.abortTransaction();
      session.endSession();
      return next(err);
    }
  })
);

module.exports = router;
