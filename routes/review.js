// routes/review.js
// Phase 26.B — Cryptographic Reputation & Review Engine
//
// POST /api/reviews
//   - Protected: verifyToken + requireRole(['CLIENT'])
//   - Proof-of-Work Gate: at least one milestone CLIENT_APPROVED/RELEASED
//     OR ledger FULLY_DISBURSED before review is accepted
//   - ACID transaction: insert Review → aggregate ratings → update ContractorProfile → AuditLog
//   - Kernel-level duplicate prevention via unique index (projectId, clientId)
//
// GET /api/reviews/contractor/:contractorId
//   - Public: returns all reviews + aggregate metrics for a contractor

'use strict';

const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');

const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync   = require('../utils/catchAsync');
const { runTransaction, TxResponse } = require('../utils/transaction');
const Review           = require('../models/Review');
const EscrowLedger     = require('../models/EscrowLedger');
const Project          = require('../models/Project');
const Bid              = require('../models/Bid');
const ContractorProfile = require('../models/ContractorProfile');
const AuditLog         = require('../models/AuditLog');

// Milestone statuses that satisfy the Proof-of-Work gate
const APPROVED_STATUSES = ['CLIENT_APPROVED', 'RELEASED', 'PAID_OFFLINE', 'COMPLETED'];

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/reviews
// Submit a verified post-milestone review for a contractor.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', verifyToken, requireRole(['CLIENT']), catchAsync(async (req, res, next) => {
  const { userId } = req.user;
  const { projectId, bidId, rating, metrics, comment } = req.body;

  if (!projectId || !bidId) {
    return next(Object.assign(
      new Error('projectId and bidId are required.'),
      { statusCode: 400, isOperational: true }
    ));
  }

  try {
    // Retried transaction (utils/transaction.js). Refusals throw, rolling it back.
    const outcome = await runTransaction(async (session) => {
      // ── Verify client owns the project ───────────────────────────────────────
      const project = await Project.findById(projectId).select('clientId awardedContractorId').session(session).lean();
      if (!project) {
        throw Object.assign(new Error('Project not found.'), { statusCode: 404, isOperational: true });
      }
      if (project.clientId.toString() !== userId) {
        throw Object.assign(
          new Error('Forbidden: You are not the client of this project.'),
          { statusCode: 403, isOperational: true }
        );
      }

      // ── Fetch the EscrowLedger ────────────────────────────────────────────────
      // The live contract only: a cancelled (abandoned) ledger is history, not a hire.
      const ledger = await EscrowLedger.findOne({ projectId, ledgerStatus: { $ne: 'CANCELLED' } }).session(session).lean();
      if (!ledger) {
        throw Object.assign(
          new Error('No escrow ledger found for this project.'),
          { statusCode: 404, isOperational: true }
        );
      }

      // ── Proof-of-Work Gate ───────────────────────────────────────────────────
      const hasApprovedMilestone = ledger.ledgerStatus === 'FULLY_DISBURSED' ||
        (ledger.milestones || []).some((m) => APPROVED_STATUSES.includes(m.status));

      if (!hasApprovedMilestone) {
        throw new TxResponse(422, {
          status: 'error',
          error: 'Proof-of-Work Gate: Cannot review contractor before at least one milestone is verified and approved.'
        });
      }

      // ── Resolve contractorId (from bid or ledger) ────────────────────────────
      const bid = await Bid.findById(bidId).select('contractorId projectId').session(session).lean();
      if (!bid) {
        throw Object.assign(new Error('Bid not found.'), { statusCode: 404, isOperational: true });
      }
      // The reviewed contractor is the one the contract was formed with — never whoever a
      // client-supplied bidId happens to point at (that allowed rating any contractor).
      if (String(bid.projectId) !== String(projectId) || String(bid.contractorId) !== String(ledger.contractorId)) {
        throw Object.assign(
          new Error('This bid is not the accepted bid of this project\'s contract. Only the hired contractor can be reviewed.'),
          { statusCode: 403, isOperational: true }
        );
      }
      const contractorId = ledger.contractorId;

      // ── Insert Review (catch duplicate key = 11000) ──────────────────────────
      let review;
      try {
        [review] = await Review.create([{
          projectId,
          bidId,
          ledgerId: ledger._id,
          clientId: userId,
          contractorId,
          rating,
          metrics,
          comment
        }], { session });
      } catch (dbErr) {
        // Inside a transaction a duplicate key aborts it: answer, don't continue.
        if (dbErr.code === 11000) {
          throw new TxResponse(409, { status: 'error', error: 'You have already submitted a review for this project.' });
        }
        throw dbErr;
      }

      // ── Aggregate new average rating for contractor ──────────────────────────
      const [agg] = await Review.aggregate([
        { $match: { contractorId: new mongoose.Types.ObjectId(contractorId) } },
        { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }
      ]).session(session);
      const totalCount = agg ? agg.count : 0;
      const avgRating  = totalCount > 0 ? Number(agg.avg.toFixed(2)) : rating;

      // Compute new trust score (weighted: 20 * avgRating, capped at 100)
      const newTrustScore = Math.min(100, Math.round(avgRating * 20));

      // Raise probation canBidAbove ceiling after every completed review
      const profileUpdate = {
        'statistics.averageRating': avgRating,
        'statistics.totalProjectsCompleted': totalCount,
        trustScore: newTrustScore,
        $inc: { 'verification.probationStatus.projectsCompleted': 1 }
      };

      await ContractorProfile.findOneAndUpdate(
        { userId: contractorId },
        profileUpdate,
        { returnDocument: 'after', session }
      );

      // ── Immutable AuditLog ───────────────────────────────────────────────────
      await AuditLog.create([{
        entityId:   review._id,
        entityType: 'REVIEW',
        action:     'REVIEW_SUBMITTED',
        actorId:    userId,
        actorRole:  'CLIENT',
        metadata: {
          projectId: String(projectId),
          bidId:     String(bidId),
          contractorId: String(contractorId),
          rating,
          newAvgRating: avgRating,
          totalReviews: totalCount
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      }], { session });

      return { review, contractorStats: { averageRating: avgRating, totalReviews: totalCount, trustScore: newTrustScore } };
    });

    res.status(201).json({ status: 'success', data: outcome });
  } catch (err) {
    if (err instanceof TxResponse) return err.send(res);
    throw err;
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/reviews/contractor/:contractorId
// Public endpoint — aggregate rating metrics for a contractor profile page.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/contractor/:contractorId', catchAsync(async (req, res, next) => {
  const { contractorId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(contractorId)) {
    return next(Object.assign(new Error('Invalid contractor ID.'), { statusCode: 400, isOperational: true }));
  }

  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const page  = Math.max(1, parseInt(req.query.page, 10) || 1);

  const [reviews, [agg]] = await Promise.all([
    Review.find({ contractorId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('-__v')
      .lean(),
    Review.aggregate([
      { $match: { contractorId: new mongoose.Types.ObjectId(contractorId) } },
      { $group: {
        _id: null,
        count: { $sum: 1 },
        avg: { $avg: '$rating' },
        quality: { $avg: { $ifNull: ['$metrics.quality', 0] } },
        timeline: { $avg: { $ifNull: ['$metrics.timeline', 0] } },
        communication: { $avg: { $ifNull: ['$metrics.communication', 0] } }
      } }
    ])
  ]);

  const count = agg ? agg.count : 0;
  const round = (n) => Number(n.toFixed(2));
  const avgRating = agg ? round(agg.avg) : 0;
  const metricAvg = (key) => (agg ? round(agg[key]) : 0);

  res.status(200).json({
    status: 'success',
    data: {
      contractorId,
      aggregates: {
        totalReviews: count,
        averageRating: avgRating,
        metrics: {
          quality:       metricAvg('quality'),
          timeline:      metricAvg('timeline'),
          communication: metricAvg('communication')
        }
      },
      reviews,
      pagination: { page, limit, totalPages: Math.ceil(count / limit) || 0 }
    }
  });
}));

module.exports = router;
