// routes/arbitration.js
// ⚖️ Phase 23 — Mathematically Sealed Dispute Arbitration Router
//
// Architecturally Hardened against the Transaction Ordering Bug:
//   1. session.startTransaction() is invoked IMMEDIATELY after startSession().
//   2. Atomic in-transaction check-and-set claim via findOneAndUpdate prevents race conditions under high concurrency.
//   3. Non-repudiation justification guard (>= 20 chars) enforced by Build-BD binding arbitration policy.
//   4. Guaranteed session.endSession() in finally block prevents connection pool socket exhaustion.

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const { emitAudit } = require('../services/auditService');
const { enforceIdempotency } = require('../middleware/idempotency');
const { creditPendingClearance } = require('../services/settlementService');
const { allMilestonesTerminal, unlockNextMilestone, clearanceDate } = require('../utils/money');

const DisputeTicket = require('../models/DisputeTicket');
const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// @route   GET /api/moderation/dispute/:ticketId
// @desc    Fetch complete Evidence Dossier for moderator review
// @access  Private (MODERATOR | ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/dispute/:ticketId',
  verifyToken,
  requireRole(['MODERATOR', 'ADMIN']),
  catchAsync(async (req, res, next) => {
    const { ticketId } = req.params;

    let ticket = null;
    if (mongoose.Types.ObjectId.isValid(ticketId)) {
      ticket = await DisputeTicket.findById(ticketId)
        .populate({ path: 'projectId', select: 'title category description location budget status siteCoordinates' })
        .populate({ path: 'clientId', select: 'phoneNumber status role wallet' })
        .populate({ path: 'contractorId', select: 'phoneNumber status role wallet' })
        .populate({ path: 'resolution.moderatorId', select: 'phoneNumber status role' })
        .lean();
    }

    if (!ticket && mongoose.Types.ObjectId.isValid(ticketId)) {
      ticket = await DisputeTicket.findOne({ ledgerId: ticketId })
        .populate({ path: 'projectId', select: 'title category description location budget status siteCoordinates' })
        .populate({ path: 'clientId', select: 'phoneNumber status role wallet' })
        .populate({ path: 'contractorId', select: 'phoneNumber status role wallet' })
        .populate({ path: 'resolution.moderatorId', select: 'phoneNumber status role' })
        .lean();
    }

    if (!ticket) {
      return next(Object.assign(new Error('Dispute ticket not found.'), { statusCode: 404, isOperational: true }));
    }

    res.status(200).json({
      status: 'success',
      message: 'Evidence dossier successfully retrieved for moderator review.',
      dossier: ticket
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/moderation/dispute/:ticketId/resolve
// @desc    Mathematically Sealed Moderator Arbitration Handler
//          Correct transaction ordering, atomic check-and-set, zero connection leaks.
// @access  Private (MODERATOR | ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/dispute/:ticketId/resolve',
  verifyToken,
  requireRole(['MODERATOR', 'ADMIN']),
  enforceIdempotency, // 🛡️ Phase-3 P1 fix: retry-safe moderator verdict.
  async (req, res, next) => {
    // 🔒 1. SESSION & TRANSACTION STARTED IMMEDIATELY BEFORE ANY DB OPERATIONAL TOUCH
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { verdict, justification } = req.body;
      const moderatorId = req.user.userId;
      const moderatorRole = req.user.role || 'MODERATOR';

      // ── Input Validations inside Session ──────────────────────────────────
      if (!['FORCE_APPROVE', 'CANCEL_AND_RESTART'].includes(verdict)) {
        await session.abortTransaction();
        return res.status(400).json({ status: 'fail', message: 'Invalid verdict command. Must be FORCE_APPROVE or CANCEL_AND_RESTART.' });
      }

      const cleanJustification = String(justification || '').trim();
      if (cleanJustification.length < 20) {
        await session.abortTransaction();
        return res.status(400).json({
          status: 'fail',
          message: 'A detailed justification (minimum 20 characters) is required for auditability under Build-BD binding arbitration policy.'
        });
      }

      // 🔒 2. ATOMIC IN-TRANSACTION CLAIM: Prevents race conditions under high concurrency
      const ticket = await DisputeTicket.findOneAndUpdate(
        {
          _id: req.params.ticketId,
          status: { $in: ['OPEN_FOR_REVIEW', 'MEDIATION_IN_PROGRESS'] }
        },
        {
          $set: { status: 'MEDIATION_IN_PROGRESS' }
        },
        { returnDocument: 'after', session }
      );


      if (!ticket) {
        await session.abortTransaction();
        return res.status(404).json({
          status: 'fail',
          message: 'Dispute ticket not found or already resolved by another moderator.'
        });
      }

      // 🔒 3. FETCH LEDGER WITHIN ACTIVE TRANSACTION SESSION
      const ledger = await EscrowLedger.findById(ticket.ledgerId).session(session);
      if (!ledger) {
        await session.abortTransaction();
        return res.status(404).json({ status: 'fail', message: 'Associated Escrow Ledger not found.' });
      }

      const milestoneIndex = ticket.milestoneIndex;
      if (milestoneIndex < 0 || milestoneIndex >= ledger.milestones.length) {
        await session.abortTransaction();
        return res.status(400).json({ status: 'fail', message: 'Milestone index out of bounds on escrow ledger.' });
      }

      const milestone = ledger.milestones[milestoneIndex];

      // 🛡️ Phase-4: a verdict may only act on a milestone that is actually in
      // dispute. FORCE_APPROVE now moves money on online-funded ledgers, so
      // without this guard a moderator could re-approve an already COMPLETED
      // milestone and credit the contractor twice.
      if (milestone.status !== 'DISPUTED') {
        await session.abortTransaction();
        return res.status(409).json({
          status: 'fail',
          message: `Milestone is not in dispute (current status: ${milestone.status}). No verdict applied.`
        });
      }

      // ── 4. APPLY VERDICT STATE MUTATIONS ───────────────────────────────────
      if (verdict === 'FORCE_APPROVE') {
        if (ledger.paidByValId) {
          // Online-funded (SSLCommerz) ledger: the money is already in escrow,
          // so approving must release it the same way /governance/approve
          // does. Before Phase 4 this set CLIENT_APPROVED, which no online
          // flow ever advances — the contractor who won the dispute was
          // never paid.
          await creditPendingClearance(session, { contractorId: ledger.contractorId, amount: milestone.amount });
          milestone.status = 'COMPLETED';
          milestone.settlementStatus = 'PENDING_CLEARANCE';
          milestone.clearsAt = clearanceDate();
        } else {
          // Offline-settled ledger: the client still pays the contractor
          // directly (bKash/Nagad/Cash); CLIENT_APPROVED unlocks submit-payment.
          milestone.status = 'CLIENT_APPROVED';
        }
        milestone.approvedAt = new Date();
        ticket.status = 'RESOLVED_FORCE_APPROVED';
      } else {
        milestone.status = 'LOCKED'; // Reset milestone for renegotiation
        milestone.disputeReason = null;
        ticket.status = 'RESOLVED_CANCELLED';
      }

      // Sequential gating: a COMPLETED verdict opens the next milestone;
      // CLIENT_APPROVED (offline) and LOCKED (renegotiation) keep it closed.
      unlockNextMilestone(ledger.milestones);

      // Re-evaluate EscrowLedger status
      const hasDisputed = ledger.milestones.some((m) => m.status === 'DISPUTED');
      if (!hasDisputed) {
        if (allMilestonesTerminal(ledger.milestones)) {
          ledger.ledgerStatus = 'FULLY_DISBURSED';
        } else {
          const hasPaid = ledger.milestones.some((m) => m.status === 'PAID_OFFLINE' || m.status === 'COMPLETED');
          ledger.ledgerStatus = hasPaid ? 'PARTIALLY_DISBURSED' : 'FUNDED';
        }
      }

      ticket.resolution = {
        moderatorId,
        verdict,
        justification: cleanJustification,
        resolvedAt: new Date()
      };

      ledger.markModified('milestones');
      await ticket.save({ session });
      await ledger.save({ session });

      // 🔒 5. IMMUTABLE AUDIT LOG EMISSION WITHIN ACTIVE TRANSACTION
      await emitAudit({
        session,
        entityId: ticket._id,
        entityType: 'DISPUTE_TICKET',
        action: 'DISPUTE_RESOLVED',
        actorId: moderatorId,
        actorRole: moderatorRole,
        metadata: {
          verdict,
          justification: cleanJustification,
          ledgerId: ledger._id,
          milestoneIndex
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      // 🚀 6. COMMIT TRANSACTION: All mutations commit atomically together
      await session.commitTransaction();

      res.status(200).json({
        status: 'success',
        message: `Dispute successfully resolved with verdict: ${verdict}`,
        resolution: {
          ticketId: ticket._id,
          verdict,
          ticketStatus: ticket.status,
          milestoneStatus: milestone.status,
          resolvedAt: ticket.resolution.resolvedAt
        }
      });
    } catch (error) {
      if (session.inTransaction()) {
        await session.abortTransaction();
      }
      next(error);
    } finally {
      // 🛡️ 7. GUARANTEED RESOURCE CLEANUP: Prevents connection pool socket exhaustion
      session.endSession();
    }
  }
);

module.exports = router;
