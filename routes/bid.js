// routes/bid.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');

const Project = require('../models/Project');
const Bid = require('../models/Bid');
const EscrowLedger = require('../models/EscrowLedger');
const ContractorProfile = require('../models/ContractorProfile');
const {
  computeBidFingerprint,
  assertContractorBidEligibility
} = require('../services/bidEligibilityService');

const MIN_BID_AMOUNT = 100;

// ==========================================
// @route   POST /api/bids/:projectId
// @desc    Submit a blind bid with verification + probation guards
// @access  Private (CONTRACTOR)
// ==========================================
router.post('/:projectId', verifyToken, requireRole(['CONTRACTOR']), catchAsync(async (req, res, next) => {
  const { projectId } = req.params;
  const { bidAmount, estimatedDays, proposalText } = req.body;

  const safeAmount = Number(bidAmount);
  const safeDays = Number(estimatedDays);
  const safeProposal = String(proposalText || '').trim();

  if (!Number.isFinite(safeAmount) || safeAmount < MIN_BID_AMOUNT || !Number.isFinite(safeDays) || safeDays < 1 || !safeProposal) {
    return next(Object.assign(
      new Error(`Valid bid amount (>= ${MIN_BID_AMOUNT}), estimated days (>= 1), and proposal text are mandatory.`),
      { statusCode: 400, isOperational: true }
    ));
  }

  const currentProject = await Project.findById(projectId).select('status clientId');

  if (!currentProject) {
    return next(Object.assign(new Error('Target project does not exist.'), { statusCode: 404, isOperational: true }));
  }

  if (currentProject.status !== 'OPEN') {
    return next(Object.assign(new Error('Transaction rejected: Bidding window has closed.'), { statusCode: 403, isOperational: true }));
  }

  if (currentProject.clientId.toString() === req.user.userId) {
    return next(Object.assign(new Error('Architectural violation: Contractors cannot place bids on their own projects.'), {
      statusCode: 403,
      isOperational: true
    }));
  }

  const eligibility = await assertContractorBidEligibility({
    userId: req.user.userId,
    bidAmount: safeAmount
  });

  if (!eligibility.ok) {
    return next(Object.assign(new Error(eligibility.message), {
      statusCode: eligibility.statusCode,
      isOperational: true
    }));
  }

  const bidFingerprint = computeBidFingerprint({
    projectId,
    contractorId: req.user.userId,
    bidAmount: safeAmount,
    estimatedDays: safeDays,
    proposalText: safeProposal
  });

  try {
    const newBid = await Bid.create({
      projectId,
      contractorId: req.user.userId,
      bidAmount: safeAmount,
      estimatedDays: safeDays,
      proposalText: safeProposal,
      bidFingerprint
    });

    res.status(201).json({
      status: 'success',
      message: 'Bid securely submitted and cryptographically fingerprinted.',
      bid: newBid
    });
  } catch (dbError) {
    if (dbError.code === 11000) {
      return next(Object.assign(new Error('Duplicate entry: You have already submitted a proposal for this project.'), {
        statusCode: 409,
        isOperational: true
      }));
    }
    return next(dbError);
  }
}));

// ==========================================
// @route   GET /api/bids/project/:projectId
// @desc    Client-owner bid list (amounts visible only to owning client)
// @access  Private (CLIENT owner)
// ==========================================
router.get('/project/:projectId', verifyToken, requireRole(['CLIENT']), catchAsync(async (req, res, next) => {
  const { projectId } = req.params;
  const { sortBy, page = 1, limit = 20 } = req.query;

  const project = await Project.findById(projectId).select('clientId status');

  if (!project) {
    return next(Object.assign(new Error('Project not found.'), { statusCode: 404, isOperational: true }));
  }

  if (project.clientId.toString() !== req.user.userId) {
    return next(Object.assign(new Error('Confidentiality Breach: You are not authorized to view bids for a project you do not own.'), {
      statusCode: 403,
      isOperational: true
    }));
  }

  let sortLogic = { createdAt: 1 };
  if (sortBy === 'price') sortLogic = { bidAmount: 1 };
  if (sortBy === 'time') sortLogic = { estimatedDays: 1 };

  const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

  const [bids, totalBids] = await Promise.all([
    Bid.find({ projectId })
      .sort(sortLogic)
      .skip(skip)
      .limit(parsedLimit)
      .populate({ path: 'contractorId', select: 'phoneNumber status role' })
      .lean(),
    Bid.countDocuments({ projectId })
  ]);

  res.status(200).json({
    status: 'success',
    metrics: {
      totalBidsReceived: totalBids,
      projectStatus: project.status,
      currentPage: parseInt(page, 10) || 1,
      totalPages: Math.ceil(totalBids / parsedLimit) || 0
    },
    bids
  });
}));

// ==========================================
// @route   PUT /api/bids/:bidId/accept
// @desc    Accept bid + create escrow inside one Mongo transaction
// @access  Private (CLIENT)
// ==========================================
router.put('/:bidId/accept', verifyToken, requireRole(['CLIENT']), catchAsync(async (req, res, next) => {
  const { bidId } = req.params;

  const targetBid = await Bid.findById(bidId);
  if (!targetBid) {
    return next(Object.assign(new Error('Bid not found.'), { statusCode: 404, isOperational: true }));
  }

  if (targetBid.status !== 'PENDING') {
    return next(Object.assign(new Error(`Bid is not PENDING (current: ${targetBid.status}).`), {
      statusCode: 409,
      isOperational: true
    }));
  }

  if (targetBid.bidAmount < MIN_BID_AMOUNT) {
    return next(Object.assign(new Error('Architectural Violation: Escrow cannot be generated for an invalid contract value.'), {
      statusCode: 400,
      isOperational: true
    }));
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // CAS inside the transaction so failure rolls project back to OPEN.
    const project = await Project.findOneAndUpdate(
      {
        _id: targetBid.projectId,
        clientId: req.user.userId,
        status: 'OPEN'
      },
      { $set: { status: 'ASSIGNED' } },
      { session, returnDocument: 'after' }
    );

    if (!project) {
      await session.abortTransaction();
      return next(Object.assign(new Error('Concurrency Lock Triggered: This project is no longer OPEN, or you lack authorization.'), {
        statusCode: 409,
        isOperational: true
      }));
    }

    targetBid.status = 'ACCEPTED';
    await targetBid.save({ session });

    await Bid.updateMany(
      { projectId: project._id, _id: { $ne: targetBid._id }, status: 'PENDING' },
      { $set: { status: 'REJECTED' } },
      { session }
    );

    const totalValue = targetBid.bidAmount;
    const tranche1 = Math.round(totalValue * 0.30);
    const tranche2 = Math.round(totalValue * 0.40);
    const tranche3 = totalValue - (tranche1 + tranche2);

    const [newLedger] = await EscrowLedger.create(
      [
        {
          projectId: project._id,
          clientId: project.clientId,
          contractorId: targetBid.contractorId,
          totalContractValue: totalValue,
          ledgerStatus: 'PENDING_FUNDING',
          milestones: [
            { title: 'Project Mobilization (Advance)', releasePercentage: 30, amount: tranche1 },
            { title: 'Midpoint Completion', releasePercentage: 40, amount: tranche2 },
            { title: 'Final Handover & Sign-off', releasePercentage: 30, amount: tranche3 }
          ]
        }
      ],
      { session }
    );

    // Capacity accounting for the awarded contractor.
    await ContractorProfile.findOneAndUpdate(
      { userId: targetBid.contractorId },
      { $inc: { 'availability.currentProjects': 1 } },
      { session }
    );

    await session.commitTransaction();

    res.status(200).json({
      status: 'success',
      message: 'Contract awarded and Escrow Ledger successfully locked.',
      awardedBid: targetBid,
      escrowLedger: newLedger._id
    });
  } catch (executionError) {
    await session.abortTransaction();
    console.error('💥 [Critical Accept-Bid Error]:', executionError);
    return next(Object.assign(new Error(`Execution Failure: ${executionError.message}`), {
      statusCode: 500,
      isOperational: true
    }));
  } finally {
    session.endSession();
  }
}));

module.exports = router;
