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
const { generateEvidenceUploadPolicy, verifyObjectExists, validateUploadedObject } = require('../services/s3Service');
const { enforceIdempotency } = require('../middleware/idempotency');
const { unlockNextMilestone, settledLedgerStatus } = require('../utils/money');
const { onLedgerSettled } = require('../services/ledgerLifecycle');
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
async function resolveLedgerAndMilestone(identifier, userId, expectedRole = 'CLIENT') {
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
        // Default to first milestone matching eligible statuses
        milestoneIndex = ledger.milestones.findIndex(
          (m) =>
            m.status === 'PROOF_SUBMITTED' ||
            m.status === 'IN_PROGRESS' ||
            m.status === 'CLIENT_APPROVED' ||
            m.status === 'PAID_OFFLINE'
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

  if (expectedRole === 'CLIENT') {
    if (ledger.clientId.toString() !== userId) {
      const err = new Error('Authorization Breach: You are not the client of this contract ledger.');
      err.statusCode = 403;
      err.isOperational = true;
      throw err;
    }
  } else if (expectedRole === 'CONTRACTOR') {
    if (ledger.contractorId.toString() !== userId) {
      const err = new Error('Authorization Breach: You are not the assigned contractor for this contract ledger.');
      err.statusCode = 403;
      err.isOperational = true;
      throw err;
    }
  } else {
    if (ledger.clientId.toString() !== userId && ledger.contractorId.toString() !== userId) {
      const err = new Error('Authorization Breach: You are not a party to this contract ledger.');
      err.statusCode = 403;
      err.isOperational = true;
      throw err;
    }
  }

  if (milestoneIndex < 0 || milestoneIndex >= ledger.milestones.length) {
    const err = new Error('Invalid milestone index resolution.');
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }

  return { ledger, milestoneIndex, milestone: ledger.milestones[milestoneIndex] };
}

/**
 * Offline settlement (bKash/Nagad/Bank/Cash paid directly to the contractor)
 * must never run on a ledger funded through SSLCommerz: that milestone's money
 * already sits in escrow, so recording an offline payment would make the client
 * pay twice and strand the escrowed tranche. Online escrow is released only via
 * POST /api/governance/approve/:ledgerId/milestone/:idx.
 */
const CONFIRMABLE_STATUSES = ['PAID_OFFLINE'];

function rejectIfOnlineEscrow(ledger) {
  if (!ledger.paidByValId) return null;
  return Object.assign(
    new Error('This escrow was funded online. Release the milestone with Approve & Release instead of recording an offline payment.'),
    { statusCode: 409, isOperational: true }
  );
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

    const idx = /^\d{1,4}$/.test(String(milestoneIndex)) ? Number(milestoneIndex) : NaN;
    const ledger = await EscrowLedger.findById(ledgerId).lean();
    if (!ledger) return next(Object.assign(new Error('Escrow ledger not found.'), { statusCode: 404, isOperational: true }));

    if (ledger.clientId.toString() !== req.user.userId) {
      return next(Object.assign(new Error('Authorization Breach: You are not the owner of this contract.'), { statusCode: 403, isOperational: true }));
    }

    // The index becomes part of the storage key, so it must name a real milestone.
    if (!Number.isInteger(idx) || idx >= ledger.milestones.length) {
      return next(Object.assign(new Error('milestoneIndex must name a milestone on this contract.'), { statusCode: 400, isOperational: true }));
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
      { expiresIn: '15m', algorithm: 'HS256' }
    );

    res.status(200).json({
      status: 'success',
      message: 'Payment receipt S3 upload policy generated. Backend RAM untouched.',
      data: {
        uploadUrl: policy.url,
        uploadFields: policy.fields,
        uploadMethod: policy.method,
        uploadHeaders: policy.headers,
        maxBytes: policy.maxBytes,
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
  enforceIdempotency, // 🛡️ Phase-3 P1 fix: retry-safe milestone approval.
  catchAsync(async (req, res, next) => {
    const { id } = req.params;
    const { ledger, milestoneIndex, milestone } = await resolveLedgerAndMilestone(id, req.user.userId);

    const onlineEscrowErr = rejectIfOnlineEscrow(ledger);
    if (onlineEscrowErr) return next(onlineEscrowErr);

    if (milestone.status !== 'PROOF_SUBMITTED') {
      return next(Object.assign(
        new Error(`Approve rejected. Milestone status must be PROOF_SUBMITTED. Current: '${milestone.status}'.`),
        { statusCode: 400, isOperational: true }
      ));
    }

    const session = await mongoose.startSession();
    let approvedRecord = null;

    try {
      await session.withTransaction(async () => {
        const freshLedger = await EscrowLedger.findById(ledger._id).session(session);
        if (!freshLedger) {
          throw Object.assign(new Error('Target escrow ledger not found.'), { statusCode: 404, isOperational: true });
        }
        const targetMilestone = freshLedger.milestones[milestoneIndex];
        if (!targetMilestone || targetMilestone.status !== 'PROOF_SUBMITTED') {
          throw Object.assign(
            new Error(`Approve rejected. Milestone status must be PROOF_SUBMITTED. Current: '${targetMilestone ? targetMilestone.status : 'missing'}'.`),
            { statusCode: 409, isOperational: true }
          );
        }

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

        approvedRecord = {
          ledgerId: freshLedger._id,
          milestoneIndex,
          status: 'CLIENT_APPROVED',
          approvedAt: targetMilestone.approvedAt,
          title: targetMilestone.title
        };
      });

      res.setHeader('Deprecation', 'true');
      res.setHeader('Link', '</api/governance/approve>; rel="successor-version"');
      res.setHeader('Warning', '299 - "POST /api/settlement/milestone/:id/approve is deprecated. For online escrow release, use POST /api/governance/approve/:ledgerId/milestone/:idx."');

      res.status(200).json({
        status: 'success',
        message: `Milestone '${approvedRecord.title}' approved by client. Ready for offline payment settlement.`,
        data: {
          ledgerId: approvedRecord.ledgerId,
          milestoneIndex: approvedRecord.milestoneIndex,
          status: approvedRecord.status,
          approvedAt: approvedRecord.approvedAt
        }
      });
    } catch (err) {
      if (err.code === 112 || (err.hasErrorLabel && err.hasErrorLabel('TransientTransactionError'))) {
        return next(Object.assign(new Error('Concurrent milestone update conflict. Please retry.'), { statusCode: 409, isOperational: true, retryable: true }));
      }
      return next(err);
    } finally {
      session.endSession();
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
  enforceIdempotency, // 🛡️ Phase-3 P1 fix: retry-safe milestone rejection.
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
    let rejectRecord = null;

    try {
      await session.withTransaction(async () => {
        const freshLedger = await EscrowLedger.findById(ledger._id).session(session);
        if (!freshLedger) {
          throw Object.assign(new Error('Target escrow ledger not found.'), { statusCode: 404, isOperational: true });
        }
        const targetMilestone = freshLedger.milestones[milestoneIndex];
        if (!targetMilestone || targetMilestone.status !== 'PROOF_SUBMITTED') {
          throw Object.assign(
            new Error(`Rejection invalid. Milestone status must be PROOF_SUBMITTED. Current: '${targetMilestone ? targetMilestone.status : 'missing'}'.`),
            { statusCode: 409, isOperational: true }
          );
        }

        targetMilestone.status = 'DISPUTED';
        targetMilestone.disputeReason = reason.trim();
        freshLedger.ledgerStatus = 'IN_ARBITRATION';

        freshLedger.markModified('milestones');
        await freshLedger.save({ session });

        // 🛡️ Phase-5 blocker fix: create a DisputeTicket in the same session
        // so /moderation/dispute/:ticketId/resolve can act on it. The unique
        // (ledgerId, milestoneIndex) index means a retry is idempotent.
        const { createDisputeTicket } = require('../services/disputeTicketService');
        const { ticket: disputeTicket } = await createDisputeTicket({
          ledger: freshLedger,
          milestoneIndex,
          reason: reason.trim(),
          session
        });

        await emitAudit({
          session,
          entityId: freshLedger._id,
          entityType: 'ESCROW_LEDGER',
          action: 'MILESTONE_REJECTED_CLIENT',
          actorId: req.user.userId,
          actorRole: req.user.role,
          metadata: {
            milestoneIndex,
            reason: reason.trim(),
            disputeTicketId: disputeTicket ? String(disputeTicket._id) : null
          },
          ipAddress: req.ip || 'SYSTEM_INTERNAL'
        });

        rejectRecord = {
          ledgerId: freshLedger._id,
          milestoneIndex,
          milestoneStatus: 'DISPUTED',
          ledgerStatus: 'IN_ARBITRATION',
          disputeReason: reason.trim(),
          disputeTicketId: disputeTicket ? disputeTicket._id : null
        };
      });

      res.setHeader('Deprecation', 'true');
      res.setHeader('Link', '</api/governance/dispute>; rel="successor-version"');
      res.setHeader('Warning', '299 - "POST /api/settlement/milestone/:id/reject is deprecated. For milestone disputes, use POST /api/governance/dispute/:ledgerId/milestone/:idx."');

      res.status(200).json({
        status: 'success',
        message: `Milestone rejected. Escrow ledger frozen and escalated to Platform Arbitration.`,
        data: rejectRecord
      });
    } catch (err) {
      if (err.code === 112 || (err.hasErrorLabel && err.hasErrorLabel('TransientTransactionError'))) {
        return next(Object.assign(new Error('Concurrent milestone update conflict. Please retry.'), { statusCode: 409, isOperational: true, retryable: true }));
      }
      return next(err);
    } finally {
      session.endSession();
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
  enforceIdempotency, // 🛡️ Phase-3 P1 fix: retry-safe offline payment submission.
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

    if (!Number.isInteger(safeAmount) || safeAmount <= 0) {
      return next(Object.assign(new Error('amountBDT must be a positive whole-taka integer.'), { statusCode: 400, isOperational: true }));
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
        const decoded = jwt.verify(s3KeyToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        finalS3ReceiptUrl = decoded.s3Key;
      } catch (jwtErr) {
        return next(Object.assign(new Error('Invalid or expired s3KeyToken for payment receipt upload.'), { statusCode: 401, isOperational: true }));
      }
    }

    if (!finalS3ReceiptUrl || typeof finalS3ReceiptUrl !== 'string') {
      return next(Object.assign(new Error('s3ReceiptUrl or s3KeyToken is required.'), { statusCode: 400, isOperational: true }));
    }

    // ── HeadObject: Physical S3 reconciliation & Checksum Verification ────────
    const uploadCheck = await validateUploadedObject(finalS3ReceiptUrl, {
      expectedHash: s3ReceiptHash !== undefined && s3ReceiptHash !== null
        ? (typeof s3ReceiptHash === 'string' ? s3ReceiptHash.toLowerCase() : s3ReceiptHash)
        : undefined
    });
    if (!uploadCheck.ok) {
      return next(Object.assign(
        new Error(uploadCheck.reason || 'Physical reconciliation failed: Payment receipt image not found in S3. Complete upload before submitting.'),
        { statusCode: uploadCheck.statusCode || 400, isOperational: true }
      ));
    }

    // ── Resolve ledger & milestone ────────────────────────────────────────────
    const { ledger, milestoneIndex, milestone } = await resolveLedgerAndMilestone(id, req.user.userId);

    const onlineEscrowErr = rejectIfOnlineEscrow(ledger);
    if (onlineEscrowErr) return next(onlineEscrowErr);

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

    // ── ACID commit: receipt + milestone transition in ONE transaction ───────
    // 🛡️ Phase-4: the receipt used to be created before (outside) the
    // transaction. If the ledger update then aborted, an orphan receipt kept
    // the trxId burned and the next retry hit a false "double-spend" 409. The
    // milestone status was also never re-read inside the transaction, so a
    // concurrent /reject could be overwritten (DISPUTED → PAID_OFFLINE).
    const session = await mongoose.startSession();
    let paymentReceipt;
    let finalLedgerStatus;
    try {
      await session.withTransaction(async () => {
        const freshLedger = await EscrowLedger.findById(ledger._id).session(session);
        const targetMilestone = freshLedger && freshLedger.milestones[milestoneIndex];

        if (!targetMilestone
            || !['CLIENT_APPROVED', 'PROOF_SUBMITTED'].includes(targetMilestone.status)
            || freshLedger.ledgerStatus === 'IN_ARBITRATION') {
          throw Object.assign(
            new Error(`Payment submission rejected: milestone state changed to '${targetMilestone ? targetMilestone.status : 'missing'}' while this request was in flight.`),
            { statusCode: 409, isOperational: true }
          );
        }
        if (targetMilestone.amount !== safeAmount) {
          throw Object.assign(
            new Error(`Payment amount mismatch: submitted ${safeAmount} BDT does not match milestone amount ${targetMilestone.amount} BDT.`),
            { statusCode: 400, isOperational: true }
          );
        }

        [paymentReceipt] = await PaymentReceipt.create([{
          projectId: freshLedger.projectId,
          ledgerId: freshLedger._id,
          milestoneId: targetMilestone._id,
          milestoneIndex,
          clientId: req.user.userId,
          contractorId: freshLedger.contractorId,
          amountBDT: safeAmount,
          paymentMethod: safeMethod,
          trxId: cleanTrxId,
          s3ReceiptUrl: finalS3ReceiptUrl,
          s3ReceiptHash: s3ReceiptHash || null,
          status: 'VERIFIED'
        }], { session });

        targetMilestone.status = 'PAID_OFFLINE';
        targetMilestone.settlementStatus = 'SETTLED';
        if (!targetMilestone.approvedAt) targetMilestone.approvedAt = new Date();
        unlockNextMilestone(freshLedger.milestones);

        const previousLedgerStatus = freshLedger.ledgerStatus;
        freshLedger.ledgerStatus = settledLedgerStatus(freshLedger.milestones);
        freshLedger.markModified('milestones');
        await freshLedger.save({ session });
        await onLedgerSettled(session, freshLedger, previousLedgerStatus);

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

        finalLedgerStatus = freshLedger.ledgerStatus;
      });
    } catch (err) {
      if (err && err.code === 11000) {
        console.error(`🚨 [DoubleSpendBlocked] Duplicate ${safeMethod} TrxID '${cleanTrxId}' rejected by Mongo unique index`);
        return next(Object.assign(
          new Error(`Duplicate transaction ID: Transaction ID '${cleanTrxId}' has already been recorded for a previous ${safeMethod} payment. Each payment submission requires a unique transaction ID.`),
          { statusCode: 409, isOperational: true }
        ));
      }
      return next(err);
    } finally {
      session.endSession();
    }

    res.status(201).json({
      status: 'success',
      message: `Offline ${safeMethod} payment submitted and mathematically sealed. Milestone updated to PAID_OFFLINE.`,
      data: {
        receiptId: paymentReceipt._id,
        paymentMethod: safeMethod,
        trxId: cleanTrxId,
        amountBDT: safeAmount,
        milestoneStatus: 'PAID_OFFLINE',
        ledgerStatus: finalLedgerStatus
      }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/settlement/milestone/:id/confirm-receipt
// @desc    Contractor confirms receipt of offline payment (bKash/Nagad/Bank/Cash)
//          Milestone advances to COMPLETED.
// @access  Private (Strictly assigned CONTRACTOR only)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/milestone/:id/confirm-receipt',
  verifyToken,
  requireRole(['CONTRACTOR']),
  enforceIdempotency,
  catchAsync(async (req, res, next) => {
    const { id } = req.params;
    const { ledger, milestoneIndex, milestone } = await resolveLedgerAndMilestone(id, req.user.userId, 'CONTRACTOR');

    if (ledger.contractorId.toString() !== req.user.userId) {
      return next(Object.assign(
        new Error('Authorization Breach: You are not the assigned contractor for this contract.'),
        { statusCode: 403, isOperational: true }
      ));
    }

    const onlineEscrowErr = rejectIfOnlineEscrow(ledger);
    if (onlineEscrowErr) return next(onlineEscrowErr);

    // Only a milestone the client has actually recorded a payment for can be
    // confirmed — CLIENT_APPROVED has no receipt behind it yet.
    if (!CONFIRMABLE_STATUSES.includes(milestone.status)) {
      return next(Object.assign(
        new Error(`Cannot confirm receipt for milestone with status '${milestone.status}'. Must be PAID_OFFLINE.`),
        { statusCode: 400, isOperational: true }
      ));
    }

    const session = await mongoose.startSession();
    let finalLedgerStatus;
    try {
      await session.withTransaction(async () => {
        const freshLedger = await EscrowLedger.findById(ledger._id).session(session);
        const targetMilestone = freshLedger && freshLedger.milestones[milestoneIndex];

        if (!targetMilestone || !CONFIRMABLE_STATUSES.includes(targetMilestone.status)) {
          throw Object.assign(
            new Error('Milestone state changed while request was in flight.'),
            { statusCode: 409, isOperational: true }
          );
        }

        targetMilestone.status = 'COMPLETED';
        targetMilestone.settlementStatus = 'SETTLED';
        if (!targetMilestone.releasedAt) targetMilestone.releasedAt = new Date();

        await PaymentReceipt.updateMany(
          { milestoneId: targetMilestone._id, status: { $ne: 'REJECTED' } },
          { $set: { status: 'VERIFIED' } },
          { session }
        );

        unlockNextMilestone(freshLedger.milestones);
        // An open dispute on another milestone keeps the ledger IN_ARBITRATION.
        const previousLedgerStatus = freshLedger.ledgerStatus;
        freshLedger.ledgerStatus = settledLedgerStatus(freshLedger.milestones);
        freshLedger.markModified('milestones');
        await freshLedger.save({ session });
        await onLedgerSettled(session, freshLedger, previousLedgerStatus);

        await emitAudit({
          session,
          entityId: freshLedger._id,
          entityType: 'ESCROW_LEDGER',
          action: 'OFFLINE_PAYMENT_CONFIRMED',
          actorId: req.user.userId,
          actorRole: req.user.role,
          metadata: {
            milestoneIndex,
            milestoneId: String(targetMilestone._id),
            amountBDT: targetMilestone.amount
          },
          ipAddress: req.ip || 'SYSTEM_INTERNAL'
        });

        finalLedgerStatus = freshLedger.ledgerStatus;
      });
    } finally {
      session.endSession();
    }

    res.status(200).json({
      status: 'success',
      message: 'Payment receipt confirmed by contractor. Milestone marked COMPLETED.',
      data: {
        milestoneIndex,
        milestoneStatus: 'COMPLETED',
        ledgerStatus: finalLedgerStatus
      }
    });
  })
);

module.exports = router;
