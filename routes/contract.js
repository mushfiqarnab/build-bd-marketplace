// routes/contract.js
// Phase 27 — Contract Formation Engine
//
// This route is the keystone bridge between an accepted bid negotiation
// and the live EscrowLedger payment system. Without it, no contract can
// ever be funded.
//
// Single endpoint:
//   POST /api/contracts/create-from-bid/:bidId
//
// What it does atomically (single MongoDB session):
//   1. Validates the caller is the client who owns the project
//   2. Verifies the bid is in ACCEPTED status
//   3. Idempotency guard: rejects if an EscrowLedger already exists for
//      this project (prevents double-contract on network retry)
//   4. Derives EscrowLedger milestones from bid.itemizedBreakdown with
//      IEEE 754-safe releasePercentage arithmetic; last milestone absorbs
//      any rounding delta to guarantee the EscrowLedger validator passes
//   5. Atomically creates the EscrowLedger
//   6. Atomically sets Project.status → ASSIGNED and records awardedContractorId
//   7. Atomically increments ContractorProfile.availability.currentProjects
//   8. Emits a FUNDS_LOCKED AuditLog entry bound to the session
//   9. Commits and returns the new ledger ID
//
// Schema compliance notes (cross-checked against every model before writing):
//   - EscrowLedger: projectId, clientId, contractorId, totalContractValue,
//     ledgerStatus ('PENDING_FUNDING'), milestones[]{title, releasePercentage, amount}
//     The milestones array validator requires sum(releasePercentage) ≈ 100.0 ± 0.015
//   - Project.status valid values: OPEN | UNDER_BIDDING | ASSIGNED | COMPLETED | CANCELLED
//     'IN_PROGRESS' does NOT exist — plan was wrong, we use ASSIGNED.
//   - Bid.status valid values: PENDING | ACCEPTED | REJECTED | WITHDRAWN | TAMPERED_FLAGGED
//     'CONTRACT_SIGNED' does NOT exist — bid stays ACCEPTED; the EscrowLedger is
//     the authoritative contract record.
//   - AuditLog action 'FUNDS_LOCKED' was added to the enum in the Phase 26 audit fix.
//   - platformFee is NOT stored on EscrowLedger — it is calculated at settlement
//     time in settlementService.js using cents-integer arithmetic, as designed.

const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');

const { verifyToken, requireRole } = require('../middleware/auth');
const { enforceIdempotency }       = require('../middleware/idempotency');
const { emitAudit }                = require('../services/auditService');
const catchAsync                   = require('../utils/catchAsync');
const { toLedgerDto }              = require('../utils/dto');
const { runTransaction }           = require('../utils/transaction');

const Bid               = require('../models/Bid');
const Project           = require('../models/Project');
const EscrowLedger      = require('../models/EscrowLedger');
const ContractorProfile = require('../models/ContractorProfile');

// ─────────────────────────────────────────────
// HELPER: Build a compliant milestones array for EscrowLedger
// from a bid's itemizedBreakdown.
//
// EscrowLedger.milestoneSchema requires:
//   title (String, required)
//   releasePercentage (Number, required, 0-100)
//   amount (Number, required, ≥0)
//
// The EscrowLedger-level validator asserts:
//   |sum(releasePercentage) - 100| < 0.015
//
// We compute each percentage using cents-integer arithmetic to minimise
// IEEE 754 drift, then force the last item to absorb any residual delta.
// ─────────────────────────────────────────────
function buildMilestones(itemizedBreakdown, totalContractValue) {
  // 🛡️ Phase-2 P0-10 fix: all milestone.amount values are integer BDT. The
  // EscrowLedger schema validator rejects floats, so this function MUST round
  // every amount to the nearest whole BDT and give the last milestone the
  // residual so the total still sums to totalContractValue exactly.
  const totalInt = Math.round(totalContractValue);

  if (!Array.isArray(itemizedBreakdown) || itemizedBreakdown.length === 0) {
    return [{
      title: 'Full Project Completion',
      releasePercentage: 100,
      amount: totalInt
    }];
  }

  let accumulatedAmount = 0;
  let accumulatedPercentage = 0;

  return itemizedBreakdown.map((item, index) => {
    const isLast = index === itemizedBreakdown.length - 1;

    if (isLast) {
      // Last milestone absorbs the residual amount (ensures sum == totalInt
      // exactly) and the residual percentage (ensures sum ≈ 100 within the
      // EscrowLedger schema validator's 0.015 epsilon).
      const residualAmount = totalInt - accumulatedAmount;
      const residualPercentage = Number((100 - accumulatedPercentage).toFixed(4));
      return {
        title:             String(item.title || `Milestone ${index + 1}`).trim(),
        releasePercentage: residualPercentage,
        amount:            residualAmount
      };
    }

    const itemAmount = Math.round(item.amount || 0);
    const itemPercentage = totalInt > 0
      ? Number(((itemAmount / totalInt) * 100).toFixed(4))
      : 0;

    accumulatedAmount += itemAmount;
    accumulatedPercentage += itemPercentage;

    return {
      title:             String(item.title || `Milestone ${index + 1}`).trim(),
      releasePercentage: itemPercentage,
      amount:            itemAmount
    };
  });
}

/** A project's current contract: any ledger that was not cancelled as abandoned. */
function liveLedgerFilter(projectId) {
  return { projectId, ledgerStatus: { $ne: 'CANCELLED' } };
}

/** True when an existing ledger IS the contract this bid would form. */
function isSameContract(ledger, bid, userId) {
  return String(ledger.clientId) === userId && String(ledger.contractorId) === String(bid.contractorId);
}

/** Idempotent-retry body: a summary only (no gateway session keys / tran ids). */
function formedResponse(ledger) {
  return {
    status: 'success',
    message: 'Contract already formed for this project. Escrow ledger retrieved.',
    data: {
      ledgerId: ledger._id,
      projectId: ledger.projectId,
      contractorId: ledger.contractorId,
      totalContractValue: ledger.totalContractValue,
      ledgerStatus: ledger.ledgerStatus,
      milestoneCount: ledger.milestones ? ledger.milestones.length : 0,
      nextStep: `POST /api/payment/initiate/${ledger._id}`
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/contracts/create-from-bid/:bidId
// @desc    Bridge an ACCEPTED bid into a funded EscrowLedger contract.
//          This is the keystone of the platform user journey.
//
// @guards  verifyToken → requireRole(['CLIENT']) → enforceIdempotency
//
// The X-Idempotency-Key header (UUID from the client) ensures that if the
// network drops after the DB commits but before the response arrives,
// the client can safely retry without creating a second contract.
//
// @access  Private (CLIENT who owns the project)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/create-from-bid/:bidId',
  verifyToken,
  requireRole(['CLIENT']),
  enforceIdempotency,
  catchAsync(async (req, res, next) => {
    const { bidId }  = req.params;
    const { userId } = req.user;

    if (!mongoose.Types.ObjectId.isValid(bidId)) {
      return next(Object.assign(
        new Error('Invalid bid ID format.'),
        { statusCode: 400, isOperational: true }
      ));
    }

    // ── Pre-flight reads (outside transaction — reads are cheaper before we hold a session lock) ──

    const bid = await Bid
      .findById(bidId)
      .select('projectId contractorId bidAmount estimatedDays itemizedBreakdown status')
      .lean();

    if (!bid) {
      return next(Object.assign(
        new Error('Bid not found.'),
        { statusCode: 404, isOperational: true }
      ));
    }

    if (bid.status !== 'ACCEPTED') {
      return next(Object.assign(
        new Error(`Contract formation requires an ACCEPTED bid. Current bid status: '${bid.status}'.`),
        { statusCode: 409, isOperational: true }
      ));
    }

    const project = await Project
      .findById(bid.projectId)
      .select('clientId status title awardedContractorId')
      .lean();

    if (!project) {
      return next(Object.assign(
        new Error('Parent project not found.'),
        { statusCode: 404, isOperational: true }
      ));
    }

    // Ownership check: only the project's client may form the contract
    if (project.clientId.toString() !== userId) {
      return next(Object.assign(
        new Error('Access Denied: You are not the owner of this project.'),
        { statusCode: 403, isOperational: true }
      ));
    }

    // Pre-flight idempotency: a retry for THIS bid's contract returns it with
    // 200. A cancelled ledger (abandoned, then the project re-opened) is
    // history, not a contract; and a live ledger for a DIFFERENT contractor
    // is a conflict — answering "success" with it would hand the client the
    // wrong contractor's escrow.
    const existingLedger = await EscrowLedger
      .findOne(liveLedgerFilter(bid.projectId))
      .lean();

    if (existingLedger) {
      if (isSameContract(existingLedger, bid, userId)) {
        return res.status(200).json(formedResponse(existingLedger));
      }
      return next(Object.assign(
        new Error(
          `A contract already exists for this project (ledger: ${existingLedger._id}, ` +
          `status: ${existingLedger.ledgerStatus}). Duplicate contract formation rejected.`
        ),
        { statusCode: 409, isOperational: true }
      ));
    }

    // ── Build milestone plan from bid breakdown ───────────────────────────────
    // 🛡️ Phase-2 P0-10 fix: EscrowLedger money fields are integer BDT.
    const totalContractValue = Math.round(bid.bidAmount);
    const milestones = buildMilestones(bid.itemizedBreakdown, totalContractValue);

    // ── ACID TRANSACTION ─────────────────────────────────────────────────────
    // runTransaction (utils/transaction.js) re-runs the callback on a TransientTransactionError (write
    // conflict, "catalog changes") and turns a conflict that persists into a retryable 409, never a 500.
    let escrowLedger = null;
    let alreadyFormed = null;

    try {
      ({ escrowLedger, alreadyFormed } = await runTransaction(async (session) => {
        let formed = null;
        let created = null;

        // ── 1. Re-check idempotency inside the session (TOCTOU guard) ──────────
        // The pre-flight check above reduced the likelihood of a race, but two
        // concurrent requests could both pass it before either commits. This
        // in-transaction re-check is the definitive guard.
        const ledgerConflict = await EscrowLedger.findOne(
          liveLedgerFilter(bid.projectId),
          null,
          { session }
        ).lean();

        if (ledgerConflict) {
          if (isSameContract(ledgerConflict, bid, userId)) {
            return { escrowLedger: null, alreadyFormed: ledgerConflict };
          }
          throw Object.assign(
            new Error('Concurrent contract formation detected. Duplicate rejected by in-transaction guard.'),
            { statusCode: 409, isOperational: true }
          );
        }

        // ── 2. Create the EscrowLedger ─────────────────────────────────────────
        [created] = await EscrowLedger.create(
          [{
            projectId:          bid.projectId,
            clientId:           project.clientId,
            contractorId:       bid.contractorId,
            totalContractValue,
            ledgerStatus:       'PENDING_FUNDING',
            milestones
          }],
          { session }
        );

        // ── 3. Transition project to ASSIGNED ──────────────────────────────────
        await Project.findByIdAndUpdate(
          bid.projectId,
          {
            $set: {
              status:               'ASSIGNED',
              awardedContractorId:  bid.contractorId
            }
          },
          { session }
        );

        // ── 4. Increment contractor's active project counter ───────────────────
        // Uses $inc so concurrent completions cannot race to the wrong value.
        await ContractorProfile.findOneAndUpdate(
          { userId: bid.contractorId },
          { $inc: { 'availability.currentProjects': 1 } },
          { session }
        );

        // ── 5. Emit immutable AuditLog entry (session-bound, cryptographically sealed) ──
        await emitAudit({
          session,
          entityId:   created._id,
          entityType: 'ESCROW_LEDGER',
          action:     'FUNDS_LOCKED',
          actorId:    userId,
          actorRole:  req.user.role,
          metadata: {
            bidId:              bidId,
            projectId:          bid.projectId.toString(),
            contractorId:       bid.contractorId.toString(),
            totalContractValue,
            milestoneCount:     milestones.length,
            ledgerStatus:       'PENDING_FUNDING'
          },
          ipAddress: req.ip || 'SYSTEM_INTERNAL'
        });
        return { escrowLedger: created, alreadyFormed: formed };
      }));
    } catch (err) {
      // The transaction is already aborted — no partial state ever persists.
      // Surface a missing replica set as a clear ops error rather than a cryptic 500.
      if (err.codeName === 'IllegalOperation' || err.code === 20) {
        return next(Object.assign(
          new Error('Atomic contract formation requires a MongoDB replica set. Contact the platform administrator.'),
          { statusCode: 503, isOperational: true }
        ));
      }
      throw err;
    }

    if (alreadyFormed) return res.status(200).json(formedResponse(alreadyFormed));

    // ─────────────────────────────────────────────────────────────────────────
    // Success — return everything the client needs to proceed to payment
    // ─────────────────────────────────────────────────────────────────────────
    res.status(201).json({
      status: 'success',
      message: 'Contract formed. Escrow ledger created and awaiting payment funding.',
      data: {
        ledgerId:           escrowLedger._id,
        projectId:          bid.projectId,
        contractorId:       bid.contractorId,
        totalContractValue,
        ledgerStatus:       'PENDING_FUNDING',
        milestoneCount:     milestones.length,
        nextStep:           `POST /api/payment/initiate/${escrowLedger._id}`
      }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// @route   GET /api/contracts/by-project/:projectId
// @desc    Fetch the contract (EscrowLedger) for a specific project.
//          Used by both parties to check contract status and milestone list.
//
// @access  Private (CLIENT who owns the project, or CONTRACTOR awarded it)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/by-project/:projectId',
  verifyToken,
  catchAsync(async (req, res, next) => {
    const { projectId } = req.params;
    const { userId }    = req.user;

    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return next(Object.assign(
        new Error('Invalid project ID format.'),
        { statusCode: 400, isOperational: true }
      ));
    }

    const project = await Project.findById(projectId).select('clientId awardedContractorId').lean();
    if (!project) {
      return next(Object.assign(new Error('Project not found.'), { statusCode: 404, isOperational: true }));
    }

    const isClient     = project.clientId.toString() === userId;
    const isContractor = project.awardedContractorId?.toString() === userId;

    if (!isClient && !isContractor) {
      return next(Object.assign(
        new Error('Access Denied: You are not a party to this contract.'),
        { statusCode: 403, isOperational: true }
      ));
    }

    const ledger = await EscrowLedger
      .findOne({ projectId })
      .select('-__v')
      .lean();

    if (!ledger) {
      return next(Object.assign(
        new Error('No contract found for this project. A contract must be formed first.'),
        { statusCode: 404, isOperational: true }
      ));
    }

    res.status(200).json({ status: 'success', data: { ledger: toLedgerDto(ledger) } });
  })
);

module.exports = router;
