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

  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // ── Verify client owns the project ───────────────────────────────────────
    const project = await Project.findById(projectId).select('clientId awardedContractorId').session(session).lean();
    if (!project) {
      await session.abortTransaction();
      return next(Object.assign(new Error('Project not found.'), { statusCode: 404, isOperational: true }));
    }
    if (project.clientId.toString() !== userId) {
      await session.abortTransaction();
      return next(Object.assign(
        new Error('Forbidden: You are not the client of this project.'),
        { statusCode: 403, isOperational: true }
      ));
    }

    // ── Fetch the EscrowLedger ────────────────────────────────────────────────
    const ledger = await EscrowLedger.findOne({ projectId }).session(session).lean();
    if (!ledger) {
      await session.abortTransaction();
      return next(Object.assign(
        new Error('No escrow ledger found for this project.'),
        { statusCode: 404, isOperational: true }
      ));
    }

    // ── Proof-of-Work Gate ───────────────────────────────────────────────────
    const hasApprovedMilestone = ledger.ledgerStatus === 'FULLY_DISBURSED' ||
      (ledger.milestones || []).some((m) => APPROVED_STATUSES.includes(m.status));

    if (!hasApprovedMilestone) {
      await session.abortTransaction();
      return res.status(422).json({
        status: 'error',
        error: 'Proof-of-Work Gate: Cannot review contractor before at least one milestone is verified and approved.'
      });
    }

    // ── Resolve contractorId (from bid or ledger) ────────────────────────────
    const bid = await Bid.findById(bidId).select('contractorId projectId').session(session).lean();
    if (!bid) {
      await session.abortTransaction();
      return next(Object.assign(new Error('Bid not found.'), { statusCode: 404, isOperational: true }));
    }
    const contractorId = bid.contractorId;

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
      await session.abortTransaction();
      if (dbErr.code === 11000) {
        return res.status(409).json({ status: 'error', error: 'You have already submitted a review for this project.' });
      }
      throw dbErr;
    }

    // ── Aggregate new average rating for contractor ──────────────────────────
    const allReviews = await Review.find({ contractorId }).session(session).select('rating').lean();
    const totalCount = allReviews.length;
    const avgRating  = totalCount > 0
      ? Number((allReviews.reduce((sum, r) => sum + r.rating, 0) / totalCount).toFixed(2))
      : rating;

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

    await session.commitTransaction();

    res.status(201).json({
      status: 'success',
      data: {
        review,
        contractorStats: { averageRating: avgRating, totalReviews: totalCount, trustScore: newTrustScore }
      }
    });

  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    throw err;
  } finally {
    await session.endSession();
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

  const reviews = await Review.find({ contractorId })
    .sort({ createdAt: -1 })
    .select('-__v')
    .lean();

  const count = reviews.length;
  const avgRating = count > 0
    ? Number((reviews.reduce((sum, r) => sum + r.rating, 0) / count).toFixed(2))
    : 0;

  const metricAvg = (key) => count > 0
    ? Number((reviews.reduce((sum, r) => sum + (r.metrics?.[key] || 0), 0) / count).toFixed(2))
    : 0;

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
      reviews
    }
  });
}));

module.exports = router;
