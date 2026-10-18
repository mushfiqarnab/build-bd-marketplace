// routes/governance.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Middleware & Utilities
const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const { emitAudit } = require('../services/auditService');
const { generateUploadSignature, verifyObjectExists, validateUploadedObject } = require('../services/s3Service');
const { enforceIdempotency } = require('../middleware/idempotency');
const { creditPendingClearance, incWallet } = require('../services/settlementService');
const { allMilestonesTerminal, unlockNextMilestone, settledLedgerStatus, clearanceDate } = require('../utils/money');

// Database Models
const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const DisputeTicket = require('../models/DisputeTicket');

function handleGovernanceTxError(error, next) {
  if (error && (error.code === 112 || (error.hasErrorLabel && error.hasErrorLabel('TransientTransactionError')))) {
    const conflictErr = new Error('Concurrent modification conflict on milestone escrow. Please retry.');
    conflictErr.statusCode = 409;
    conflictErr.isOperational = true;
    return next(conflictErr);
  }
  return next(error);
}

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

      // 🛡️ Phase-4: one integer-BDT split shared with every other money path.
      const { contractor: contractorPayoutFinal, platform: platformFeeFinal } =
        await creditPendingClearance(session, { contractorId: ledger.contractorId, amount: targetMilestone.amount });
      const clearsAtDate = clearanceDate();

      ledger.milestones[idx].status = 'COMPLETED';
      ledger.milestones[idx].approvedAt = new Date();
      ledger.milestones[idx].settlementStatus = 'PENDING_CLEARANCE';
      ledger.milestones[idx].clearsAt = clearsAtDate;
      unlockNextMilestone(ledger.milestones);

      // REFUNDED / PAID_OFFLINE are terminal too — the old `!== 'COMPLETED'`
      // check meant a ledger with any refund could never reach FULLY_DISBURSED.
      ledger.ledgerStatus = allMilestonesTerminal(ledger.milestones) ? 'FULLY_DISBURSED' : 'PARTIALLY_DISBURSED';

      await ledger.save({ session });

      await emitAudit({
        session,
        entityId: ledger._id,
        entityType: 'ESCROW_LEDGER',
        action: 'MILESTONE_APPROVED',
        actorId: req.user.userId,
        actorRole: req.user.role,
        metadata: {
          milestoneIndex: idx,
          grossAmount: targetMilestone.amount,
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
          totalGross: targetMilestone.amount,
          contractorNet: contractorPayoutFinal,
          platformCommission: platformFeeFinal
        },
        currentLedgerStatus: ledger.ledgerStatus
      });
    } catch (error) {
      await session.abortTransaction();
      session.endSession();

      // 🛡️ Phase-4 & Phase-5: operational errors keep their status;
      // write conflicts (code 112 / TransientTransactionError) map to 409;
      // unexpected bugs go to global handler as 500.
      return handleGovernanceTxError(error, next);
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

    // 🛡️ PHYSICAL RECONCILIATION GUARD: Assert the file object physically exists in S3 before committing transaction
    const fileExistsInCloud = await verifyObjectExists(verifiedFileKey);
    if (!fileExistsInCloud) {
      console.error(`🚨 PHYSICAL RECONCILIATION EXCEPTION: Phantom upload blocked for key: ${verifiedFileKey}`);
      return next(
        Object.assign(
          new Error('Upload physical verification failed. File object not found in cloud storage. Please complete the cloud upload before confirming.'),
          { statusCode: 400, isOperational: true }
        )
      );
    }

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
      return handleGovernanceTxError(error, next);
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
  enforceIdempotency, // 🛡️ Phase-3 P1 fix: prevent double-fire on retry.
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

    const frozenLedger = await EscrowLedger.findOneAndUpdate(query, updatePayload, { returnDocument: 'after' });

    if (!frozenLedger) {
      const err = new Error('Dispute Lockout: Milestone state is invalid, or you do not have authorization to freeze this ledger.');
      err.statusCode = 409;
      err.isOperational = true;
      return next(err);
    }

    // 🛡️ Phase-5 blocker fix: produce a DisputeTicket so the moderator queue
    // and /moderation/dispute/:ticketId/resolve are reachable in production.
    // The unique (ledgerId, milestoneIndex) index makes retries idempotent.
    const { createDisputeTicket } = require('../services/disputeTicketService');
    const { ticket } = await createDisputeTicket({
      ledger: frozenLedger,
      milestoneIndex: idx,
      reason: reason.trim()
    });

    await AuditLog.create({
      entityId: frozenLedger._id,
      entityType: 'ESCROW_LEDGER',
      action: 'MILESTONE_DISPUTED',
      actorId: req.user.userId,
      actorRole: req.user.role,
      metadata: {
        milestoneIndex: idx,
        reason: reason.trim(),
        disputeTicketId: ticket ? ticket._id.toString() : null
      },
      ipAddress: req.ip || 'SYSTEM_INTERNAL'
    });

    res.status(200).json({
      status: 'success',
      message: `Milestone ${idx} locked. Escrow frozen and escalated to Platform Arbitration.`,
      currentLedgerStatus: frozenLedger.ledgerStatus,
      disputeTicketId: ticket ? ticket._id : null
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
  enforceIdempotency, // 🛡️ Phase-3 P1 fix: admin verdicts move money — retry-safe.
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

    // Binding-arbitration policy (models/DisputeTicket.js): a verdict that
    // moves money needs a written justification of at least 20 characters.
    const justification = typeof arbitrationNotes === 'string' ? arbitrationNotes.trim() : '';
    if (justification.length < 20) {
      const err = new Error('arbitrationNotes must be a written justification of at least 20 characters.');
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

      if (decision === 'FAVOR_CONTRACTOR') {
        // creditPendingClearance throws if either the contractor or the
        // treasury row is missing (the contractor update was unchecked before).
        await creditPendingClearance(session, { contractorId: ledger.contractorId, amount: targetMilestone.amount });

        ledger.milestones[idx].status = 'COMPLETED';
        ledger.milestones[idx].approvedAt = new Date();
        ledger.milestones[idx].settlementStatus = 'PENDING_CLEARANCE';
        ledger.milestones[idx].clearsAt = clearanceDate();
      } else if (decision === 'FAVOR_CLIENT') {
        await incWallet(session, { _id: ledger.clientId },
          { 'wallet.availableToWithdraw': targetMilestone.amount }, 'Client (refund)');

        ledger.milestones[idx].status = 'REFUNDED';
        ledger.milestones[idx].settlementStatus = 'REFUNDED';
      }

      ledger.milestones[idx].arbitrationNotes = justification;
      unlockNextMilestone(ledger.milestones);
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
          arbitrationNotes: justification
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      ledger.ledgerStatus = settledLedgerStatus(ledger.milestones);

      await ledger.save({ session });

      await DisputeTicket.findOneAndUpdate(
        {
          ledgerId: ledger._id,
          milestoneIndex: idx,
          status: { $in: ['OPEN_FOR_REVIEW', 'MEDIATION_IN_PROGRESS'] }
        },
        {
          $set: {
            status: decision === 'FAVOR_CONTRACTOR' ? 'RESOLVED_FORCE_APPROVED' : 'RESOLVED_CANCELLED',
            'resolution.moderatorId': req.user.userId,
            'resolution.verdict': decision === 'FAVOR_CONTRACTOR' ? 'FORCE_APPROVE' : 'CANCEL_AND_RESTART',
            'resolution.justification': justification,
            'resolution.resolvedAt': new Date()
          }
        },
        { session }
      );

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
      return handleGovernanceTxError(error, next);
    }
  })
);

// ═══════════════════════════════════════════════════════════════════════════
// 🛡️ PHASE 21 v2 — PROOF-OF-WORK EVIDENCE LEDGER (Zero-RAM Architecture)
// ═══════════════════════════════════════════════════════════════════════════
//
// multer has been completely eradicated. The Node.js process NEVER touches
// image bytes. The complete upload flow is:
//
//  Step 1  GET  /proof/presigned-url
//          Backend issues an S3 Pre-Signed POST policy.
//          S3 enforces ContentType + content-length-range (max 10 MB) server-side.
//          The backend JWT-signs the s3Key as a binding token (CPT pattern).
//
//  Step 2  Client → S3 direct upload (FormData POST to presigned URL)
//          Image bytes flow:  Device → CDN/S3 edge.  Backend sees zero bytes.
//          Client computes SHA-256 of the image buffer locally (SubtleCrypto).
//          Client extracts EXIF GPS / calls navigator.geolocation for live path.
//
//  Step 3  POST /proof/evidence/:ledgerId/milestone/:idx       (EXIF path)
//          POST /proof/evidence/live/:ledgerId/milestone/:idx  (live-ping path)
//          Backend receives pure JSON: { s3ObjectKey, imageHash, gpsData }
//          Backend:
//            a) Verifies s3Key binding token (prevents phantom proof injection)
//            b) HeadObject — confirms the key physically exists in S3
//            c) Runs location math (Haversine + Dynamic Accuracy Thresholding)
//            d) Double-spend check (imageHash cross-ledger collision query)
//            e) ACID transaction: appends evidenceLog entry, advances state

const { verifyLivePing, VerificationTier, haversineDistanceMeters, GEOFENCE_HARD_CAP_METERS } = require('../services/evidenceService');
const { generateEvidenceUploadPolicy, isS3Mock } = require('../services/s3Service');
const jwt = require('jsonwebtoken');
const Project = require('../models/Project');



// ─────────────────────────────────────────────────────────────────────────────
// @route   GET /api/governance/proof/presigned-url
// @desc    Step 1 of the zero-RAM evidence upload flow.
//          Generates an AWS S3 Pre-Signed POST policy bound to a specific
//          ledger + milestone. The client uses this to upload the image
//          DIRECTLY to S3 — the Node.js process sees zero image bytes.
//
//          S3 POST policy Conditions (enforced at the AWS infrastructure level):
//            - content-length-range: [1, 10485760] — rejects files > 10 MB
//            - Content-Type: must match the declared contentType exactly
//            - x-amz-server-side-encryption: AES256 mandatory
//
//          Returns a JWT-signed s3KeyToken (CPT pattern) that binds the s3Key
//          to this exact ledgerId + milestoneIndex. The confirmation endpoint
//          verifies this token, preventing phantom proof injection attacks.
//
// @access  Private (Assigned CONTRACTOR only)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/proof/presigned-url',
  verifyToken,
  requireRole(['CONTRACTOR']),
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex, contentType } = req.query;

    if (!ledgerId || milestoneIndex === undefined || !contentType) {
      return next(Object.assign(
        new Error('Query params required: ledgerId, milestoneIndex, contentType (e.g. image/jpeg).'),
        { statusCode: 400, isOperational: true }
      ));
    }

    const idx = parseInt(milestoneIndex, 10);
    if (!Number.isInteger(idx) || idx < 0) {
      return next(Object.assign(new Error('milestoneIndex must be a non-negative integer.'), { statusCode: 400, isOperational: true }));
    }

    // ── Ledger ownership + state pre-flight ───────────────────────────────────
    const ledger = await EscrowLedger.findById(ledgerId).lean();
    if (!ledger) {
      return next(Object.assign(new Error('Escrow ledger not found.'), { statusCode: 404, isOperational: true }));
    }
    if (ledger.contractorId.toString() !== req.user.userId) {
      return next(Object.assign(new Error('Authorization Breach: You are not the assigned contractor for this escrow.'), { statusCode: 403, isOperational: true }));
    }
    if (idx >= ledger.milestones.length) {
      return next(Object.assign(new Error('Milestone index out of bounds.'), { statusCode: 400, isOperational: true }));
    }
    if (!['FUNDED', 'PARTIALLY_DISBURSED'].includes(ledger.ledgerStatus)) {
      return next(Object.assign(new Error('Escrow must be funded before evidence can be submitted.'), { statusCode: 403, isOperational: true }));
    }
    const milestone = ledger.milestones[idx];
    if (!['IN_PROGRESS', 'PROOF_SUBMITTED'].includes(milestone.status)) {
      return next(Object.assign(
        new Error(`Evidence uploads require milestone status IN_PROGRESS or PROOF_SUBMITTED. Current: ${milestone.status}`),
        { statusCode: 400, isOperational: true }
      ));
    }

    // ── Generate S3 Pre-Signed POST policy ────────────────────────────────────
    // generateEvidenceUploadPolicy throws 415 on unsupported contentType.
    // In mock mode returns a structurally identical response.
    const policy = await generateEvidenceUploadPolicy(ledgerId, idx, contentType);

    // ── JWT-sign the s3Key as a binding Cryptographic Proof Token ─────────────
    // Prevents a contractor from submitting an s3Key they did not obtain from here,
    // blocking phantom proof injection (fabricating a ledger entry for a key that
    // was never legitimately generated for this ledger/milestone pair).
    const s3KeyToken = jwt.sign(
      {
        s3Key:          policy.s3Key,
        ledgerId:       String(ledger._id),
        milestoneIndex: idx,
        contractorId:   req.user.userId
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    res.status(200).json({
      status: 'success',
      message: 'S3 Pre-Signed POST policy generated. Upload directly from client. Backend RAM untouched.',
      data: {
        uploadUrl:        policy.url,
        uploadFields:     policy.fields,
        uploadMethod:     policy.method,
        uploadHeaders:    policy.headers,
        maxBytes:         policy.maxBytes,
        s3Key:            policy.s3Key,
        s3KeyToken,
        expiresInSeconds: policy.expiresInSeconds
      }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/governance/proof/evidence/:ledgerId/milestone/:milestoneIndex
// @desc    Step 3 of the zero-RAM evidence upload flow — EXIF/GPS path.
//          Called AFTER the client has:
//            1. Obtained the pre-signed policy (Step 1)
//            2. Uploaded the image directly to S3 (Step 2)
//            3. Computed SHA-256 of the image buffer client-side (SubtleCrypto)
//            4. Extracted EXIF GPS coordinates from the image client-side
//
//          Body (application/json):
//            s3KeyToken  {string}  JWT from Step 1 (binds s3Key to this ledger)
//            imageHash   {string}  SHA-256 hex of the raw image bytes
//            gpsData     {object?} { lat, lng, accuracy?, photoTimestamp? }
//                                  Omit or null if EXIF GPS was unavailable —
//                                  triggers REQUIRES_CLIENT_AUDIT tier gracefully.
//
//          Server responsibilities:
//            - Verify JWT binding token (s3Key → ledgerId → milestoneIndex → contractorId)
//            - HeadObject: confirm file physically exists in S3
//            - Haversine: verify gpsData against project site coordinates
//            - Double-spend: cross-ledger imageHash collision query
//            - ACID commit: append evidenceLog, advance milestone state
//
// @access  Private (Assigned CONTRACTOR only)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/proof/evidence/:ledgerId/milestone/:milestoneIndex',
  verifyToken,
  requireRole(['CONTRACTOR']),
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;
    const idx = parseInt(milestoneIndex, 10);
    const { s3KeyToken, imageHash, gpsData } = req.body;

    // ── Input validation ──────────────────────────────────────────────────────
    if (!s3KeyToken || typeof s3KeyToken !== 'string') {
      return next(Object.assign(new Error('s3KeyToken (JWT from presigned-url step) is required.'), { statusCode: 400, isOperational: true }));
    }
    if (!imageHash || typeof imageHash !== 'string' || !/^[a-f0-9]{64}$/i.test(imageHash)) {
      return next(Object.assign(new Error('imageHash must be a 64-character lowercase hex SHA-256 string.'), { statusCode: 400, isOperational: true }));
    }

    // ── Verify JWT binding token ──────────────────────────────────────────────
    // Confirms: this s3Key was legitimately generated for THIS ledger + milestone
    // + contractor. Prevents phantom proof injection.
    let tokenPayload;
    try {
      tokenPayload = jwt.verify(s3KeyToken, process.env.JWT_SECRET);
    } catch (jwtErr) {
      return next(Object.assign(new Error('Invalid or expired s3KeyToken. Obtain a new pre-signed URL.'), { statusCode: 401, isOperational: true }));
    }

    if (
      tokenPayload.ledgerId       !== ledgerId ||
      tokenPayload.milestoneIndex !== idx      ||
      tokenPayload.contractorId   !== req.user.userId
    ) {
      return next(Object.assign(
        new Error('Token boundary violation: s3KeyToken does not match this ledger, milestone, or contractor.'),
        { statusCode: 403, isOperational: true }
      ));
    }

    const s3ObjectKey = tokenPayload.s3Key;

    // ── Ledger ownership + state guards ──────────────────────────────────────
    const ledger = await EscrowLedger.findById(ledgerId);
    if (!ledger) return next(Object.assign(new Error('Escrow ledger not found.'), { statusCode: 404, isOperational: true }));
    if (ledger.contractorId.toString() !== req.user.userId) {
      return next(Object.assign(new Error('Authorization Breach: You are not the assigned contractor.'), { statusCode: 403, isOperational: true }));
    }
    if (idx < 0 || idx >= ledger.milestones.length) {
      return next(Object.assign(new Error('Milestone index out of bounds.'), { statusCode: 400, isOperational: true }));
    }
    if (!['FUNDED', 'PARTIALLY_DISBURSED'].includes(ledger.ledgerStatus)) {
      return next(Object.assign(new Error('Escrow must be funded before evidence can be submitted.'), { statusCode: 403, isOperational: true }));
    }
    const targetMilestone = ledger.milestones[idx];
    if (!['IN_PROGRESS', 'PROOF_SUBMITTED'].includes(targetMilestone.status)) {
      return next(Object.assign(new Error(`Milestone must be IN_PROGRESS or PROOF_SUBMITTED. Current: ${targetMilestone.status}`), { statusCode: 400, isOperational: true }));
    }

    // ── HeadObject: physical S3 reconciliation ────────────────────────────────
    // Confirms the client actually uploaded the file before we commit the ledger.
    const uploadCheck = await validateUploadedObject(s3ObjectKey);
    if (!uploadCheck.ok) {
      return next(Object.assign(
        new Error(uploadCheck.reason || 'Physical reconciliation failed: File not found in S3. Complete the upload before confirming evidence.'),
        { statusCode: uploadCheck.statusCode || 400, isOperational: true }
      ));
    }

    // ── Location verification (Haversine on client-reported GPS) ──────────────
    const project = await Project.findById(ledger.projectId).select('siteCoordinates createdAt').lean();
    const projectLat = project?.siteCoordinates?.latitude  ?? null;
    const projectLng = project?.siteCoordinates?.longitude ?? null;

    let verificationTier = VerificationTier.REQUIRES_CLIENT_AUDIT;
    let distanceMeters   = null;
    const notes          = [];

    if (gpsData && Number.isFinite(gpsData.lat) && Number.isFinite(gpsData.lng)) {
      if (projectLat !== null && projectLng !== null) {
        distanceMeters = haversineDistanceMeters(projectLat, projectLng, gpsData.lat, gpsData.lng);

        if (distanceMeters > GEOFENCE_HARD_CAP_METERS) {
          // 🚨 FRAUD: GPS reports location more than 80m from site
          console.error(`🚨 [Evidence] GPS fraud: contractor ${req.user.userId} is ${Math.round(distanceMeters)}m from site.`);
          return next(Object.assign(
            new Error(`Fraud Alert: Reported GPS location is ${Math.round(distanceMeters)}m from the project site. Maximum: ${GEOFENCE_HARD_CAP_METERS}m. Move to the site and try again.`),
            { statusCode: 422, isOperational: true }
          ));
        }

        // Determine tier based on available GPS metadata
        const hasTimestamp = gpsData.photoTimestamp && !isNaN(new Date(gpsData.photoTimestamp).getTime());
        const photoAfterStart = hasTimestamp && new Date(gpsData.photoTimestamp) >= new Date(project.createdAt || 0);

        if (photoAfterStart) {
          verificationTier = VerificationTier.CRYPTOGRAPHIC_PROOF;
          notes.push(`GPS verified: ${Math.round(distanceMeters)}m from site. Timestamp verified: ${gpsData.photoTimestamp}.`);
        } else if (hasTimestamp && !photoAfterStart) {
          // Photo timestamp predates project start — hard fraud rejection
          return next(Object.assign(
            new Error(`Fraud Alert: Photo timestamp ${gpsData.photoTimestamp} predates project start. Do not submit photos from previous jobs.`),
            { statusCode: 422, isOperational: true }
          ));
        } else {
          verificationTier = VerificationTier.GPS_ONLY;
          notes.push(`GPS verified: ${Math.round(distanceMeters)}m from site. No timestamp provided.`);
        }
      } else {
        notes.push('GPS coordinates supplied but project has no site coordinates — geofence check skipped.');
        verificationTier = VerificationTier.REQUIRES_CLIENT_AUDIT;
      }
    } else {
      notes.push('No GPS data provided or coordinates invalid. Requires client manual review.');
      verificationTier = VerificationTier.REQUIRES_CLIENT_AUDIT;
    }

    // ── Double-spend check ────────────────────────────────────────────────────
    // imageHash is computed client-side (SubtleCrypto) over the raw image buffer.
    // Cross-ledger query: if this hash was used on any previous milestone → reject.
    const hashCollision = await EscrowLedger.findOne({
      'milestones.evidenceLog.imageHash': imageHash.toLowerCase()
    }).lean();

    if (hashCollision) {
      console.error(`🚨 [Evidence] Double-spend by contractor ${req.user.userId} — hash: ${imageHash}`);
      return next(Object.assign(
        new Error('Fraud Alert: This image has already been submitted as evidence on another milestone. Each milestone requires unique photographic proof.'),
        { statusCode: 409, isOperational: true }
      ));
    }

    // ── ACID commit ───────────────────────────────────────────────────────────
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const freshLedger = await EscrowLedger.findById(ledgerId).session(session);
      const milestone   = freshLedger.milestones[idx];

      milestone.evidenceLog = milestone.evidenceLog || [];
      milestone.evidenceLog.push({
        imageHash:        imageHash.toLowerCase(),
        verificationTier,
        livePingVerified: false,
        distanceMeters,
        s3Key:            s3ObjectKey,
        notes,
        submittedAt:      new Date()
      });

      // Advance to PROOF_SUBMITTED so client can audit, approve, or settle
      milestone.status = 'PROOF_SUBMITTED';
      milestone.proofOfWorkUrl = s3ObjectKey;
      if (!milestone.proofSubmittedAt) milestone.proofSubmittedAt = new Date();

      freshLedger.markModified('milestones');
      await freshLedger.save({ session });

      await emitAudit({
        session,
        entityId:  freshLedger._id,
        entityType: 'ESCROW_LEDGER',
        action:    'EVIDENCE_SUBMITTED',
        actorId:   req.user.userId,
        actorRole: req.user.role,
        metadata: {
          milestoneIndex: idx,
          verificationTier,
          imageHash,
          distanceMeters,
          s3Key: s3ObjectKey
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      await session.commitTransaction();
      session.endSession();

      res.status(200).json({
        status: 'success',
        message: 'Evidence cryptographically committed to the immutable ledger. Backend RAM was never touched.',
        evidence: {
          verificationTier,
          imageHash,
          distanceMeters,
          notes,
          milestoneStatus: milestone.status
        }
      });
    } catch (txError) {
      await session.abortTransaction();
      session.endSession();
      return handleGovernanceTxError(txError, next);
    }
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/governance/proof/evidence/live/:ledgerId/milestone/:milestoneIndex
// @desc    Step 3 — Live GPS ping path (highest trust tier).
//          The client calls navigator.geolocation.getCurrentPosition() IN-APP
//          immediately before taking the photo. Coordinates come from the live
//          GPS chip, not EXIF — completely immune to image EXIF spoofing tools.
//
//          Body (application/json):
//            s3KeyToken  {string}  JWT from Step 1
//            imageHash   {string}  SHA-256 hex computed client-side
//            lat         {number}  Live GPS latitude from navigator.geolocation
//            lng         {number}  Live GPS longitude
//            accuracy    {number}  coords.accuracy in metres (for Dynamic Thresholding)
//
//          Dynamic Accuracy Thresholding: min(80, max(40, accuracy))
//          Accommodates Walton/Symphony/degraded GPS (drift 20–40m in rebar sites)
//          while blocking the 100m+ spoofing window.
//
// @access  Private (Assigned CONTRACTOR only)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/proof/evidence/live/:ledgerId/milestone/:milestoneIndex',
  verifyToken,
  requireRole(['CONTRACTOR']),
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;
    const idx = parseInt(milestoneIndex, 10);
    const { s3KeyToken, imageHash, lat, lng, accuracy } = req.body;

    // ── Input validation ──────────────────────────────────────────────────────
    if (!s3KeyToken || typeof s3KeyToken !== 'string') {
      return next(Object.assign(new Error('s3KeyToken is required.'), { statusCode: 400, isOperational: true }));
    }
    if (!imageHash || typeof imageHash !== 'string' || !/^[a-f0-9]{64}$/i.test(imageHash)) {
      return next(Object.assign(new Error('imageHash must be a 64-character hex SHA-256 string.'), { statusCode: 400, isOperational: true }));
    }
    const pingLat        = parseFloat(lat);
    const pingLng        = parseFloat(lng);
    const deviceAccuracy = parseFloat(accuracy);

    if (!Number.isFinite(pingLat) || !Number.isFinite(pingLng)) {
      return next(Object.assign(new Error('lat and lng are required and must be finite numbers.'), { statusCode: 400, isOperational: true }));
    }

    // ── Verify JWT binding token ──────────────────────────────────────────────
    let tokenPayload;
    try {
      tokenPayload = jwt.verify(s3KeyToken, process.env.JWT_SECRET);
    } catch (jwtErr) {
      return next(Object.assign(new Error('Invalid or expired s3KeyToken. Obtain a new pre-signed URL.'), { statusCode: 401, isOperational: true }));
    }

    if (
      tokenPayload.ledgerId       !== ledgerId ||
      tokenPayload.milestoneIndex !== idx      ||
      tokenPayload.contractorId   !== req.user.userId
    ) {
      return next(Object.assign(
        new Error('Token boundary violation: s3KeyToken does not match this ledger, milestone, or contractor.'),
        { statusCode: 403, isOperational: true }
      ));
    }

    const s3ObjectKey = tokenPayload.s3Key;

    // ── Ledger guards ─────────────────────────────────────────────────────────
    const ledger = await EscrowLedger.findById(ledgerId);
    if (!ledger) return next(Object.assign(new Error('Escrow ledger not found.'), { statusCode: 404, isOperational: true }));
    if (ledger.contractorId.toString() !== req.user.userId) {
      return next(Object.assign(new Error('Authorization Breach: You are not the assigned contractor.'), { statusCode: 403, isOperational: true }));
    }
    if (idx < 0 || idx >= ledger.milestones.length) {
      return next(Object.assign(new Error('Milestone index out of bounds.'), { statusCode: 400, isOperational: true }));
    }
    if (!['FUNDED', 'PARTIALLY_DISBURSED'].includes(ledger.ledgerStatus)) {
      return next(Object.assign(new Error('Escrow must be funded before evidence can be submitted.'), { statusCode: 403, isOperational: true }));
    }
    const targetMilestone = ledger.milestones[idx];
    if (!['IN_PROGRESS', 'PROOF_SUBMITTED'].includes(targetMilestone.status)) {
      return next(Object.assign(new Error(`Milestone must be IN_PROGRESS or PROOF_SUBMITTED. Current: ${targetMilestone.status}`), { statusCode: 400, isOperational: true }));
    }

    // ── HeadObject: physical reconciliation ───────────────────────────────────
    const uploadCheck = await validateUploadedObject(s3ObjectKey);
    if (!uploadCheck.ok) {
      return next(Object.assign(
        new Error(uploadCheck.reason || 'Physical reconciliation failed: File not found in S3. Complete the upload before confirming evidence.'),
        { statusCode: uploadCheck.statusCode || 400, isOperational: true }
      ));
    }

    // ── Fetch project GPS ─────────────────────────────────────────────────────
    const project = await Project.findById(ledger.projectId).select('siteCoordinates').lean();
    const projectLat = project?.siteCoordinates?.latitude  ?? null;
    const projectLng = project?.siteCoordinates?.longitude ?? null;

    if (projectLat === null || projectLng === null) {
      return next(Object.assign(
        new Error('Project has no site coordinates. Add GPS coordinates to the project or use the standard evidence path.'),
        { statusCode: 400, isOperational: true }
      ));
    }

    // ── Dynamic Accuracy Thresholding — verifyLivePing throws 422 on fail ─────
    // Runs entirely on the JSON coordinates — zero image bytes consumed.
    const livePingResult = verifyLivePing(projectLat, projectLng, pingLat, pingLng, deviceAccuracy);

    // ── Double-spend check ────────────────────────────────────────────────────
    const hashCollision = await EscrowLedger.findOne({
      'milestones.evidenceLog.imageHash': imageHash.toLowerCase()
    }).lean();

    if (hashCollision) {
      console.error(`🚨 [LiveEvidence] Double-spend by contractor ${req.user.userId} — hash: ${imageHash}`);
      return next(Object.assign(
        new Error('Fraud Alert: This image has already been submitted as evidence on another milestone.'),
        { statusCode: 409, isOperational: true }
      ));
    }

    // ── ACID commit ───────────────────────────────────────────────────────────
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const freshLedger = await EscrowLedger.findById(ledgerId).session(session);
      const milestone   = freshLedger.milestones[idx];

      const accuracyLabel = Number.isFinite(deviceAccuracy) ? `${deviceAccuracy}m` : 'unknown';
      milestone.evidenceLog = milestone.evidenceLog || [];
      milestone.evidenceLog.push({
        imageHash:        imageHash.toLowerCase(),
        verificationTier: VerificationTier.CRYPTOGRAPHIC_PROOF,
        livePingVerified: true,
        distanceMeters:   livePingResult.distanceMeters,
        s3Key:            s3ObjectKey,
        notes: [
          `Live GPS ping verified: ${Math.round(livePingResult.distanceMeters)}m from site ` +
          `(dynamic radius: ${Math.round(livePingResult.dynamicRadius)}m, device accuracy: ${accuracyLabel}). ` +
          `EXIF spoofing surface eliminated.`
        ],
        submittedAt: new Date()
      });

      // Live-ping always auto-advances — it is the maximum trust tier
      milestone.status = 'PROOF_SUBMITTED';
      milestone.proofOfWorkUrl = s3ObjectKey;
      if (!milestone.proofSubmittedAt) milestone.proofSubmittedAt = new Date();

      freshLedger.markModified('milestones');
      await freshLedger.save({ session });

      await emitAudit({
        session,
        entityId:   freshLedger._id,
        entityType: 'ESCROW_LEDGER',
        action:     'EVIDENCE_SUBMITTED_LIVE',
        actorId:    req.user.userId,
        actorRole:  req.user.role,
        metadata: {
          milestoneIndex:   idx,
          verificationTier: VerificationTier.CRYPTOGRAPHIC_PROOF,
          livePingVerified: true,
          distanceMeters:   livePingResult.distanceMeters,
          dynamicRadius:    livePingResult.dynamicRadius,
          imageHash,
          s3Key:            s3ObjectKey
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      await session.commitTransaction();
      session.endSession();

      res.status(200).json({
        status: 'success',
        message: 'Live-capture evidence verified and committed. Backend RAM untouched. EXIF spoofing eliminated.',
        evidence: {
          verificationTier: VerificationTier.CRYPTOGRAPHIC_PROOF,
          livePingVerified: true,
          distanceMeters:   livePingResult.distanceMeters,
          dynamicRadius:    livePingResult.dynamicRadius,
          imageHash,
          milestoneStatus:  'PROOF_SUBMITTED'
        }
      });
    } catch (txError) {
      await session.abortTransaction();
      session.endSession();
      return handleGovernanceTxError(txError, next);
    }
  })
);

module.exports = router;

