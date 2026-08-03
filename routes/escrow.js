// routes/escrow.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Middleware & Utilities
const { verifyToken, requireRole } = require('../middleware/auth');
const { uploadProof } = require('../middleware/upload');
const catchAsync = require('../utils/catchAsync');

// Database Models
const EscrowLedger = require('../models/EscrowLedger');

// ==========================================
// @route   POST /api/escrow/:ledgerId/milestone/:milestoneIndex/proof
// @desc    Upload construction proof of work and anchor it to an escrow milestone
// @access  Private (Strictly assigned CONTRACTOR only)
// ==========================================
router.post(
  '/:ledgerId/milestone/:milestoneIndex/proof',
  verifyToken,
  requireRole(['CONTRACTOR']),
  uploadProof, 
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;

    if (!req.file) {
      const err = new Error('Proof of work attachment is mandatory.');
      err.statusCode = 400;
      err.isOperational = true;
      return next(err);
    }

    const ledger = await EscrowLedger.findById(ledgerId);
    if (!ledger) {
      const err = new Error('Target escrow ledger not found.');
      err.statusCode = 404;
      err.isOperational = true;
      return next(err);
    }

    if (ledger.contractorId.toString() !== req.user.userId) {
      const err = new Error('Authorization Breach: You are not the assigned contractor for this contract ledger.');
      err.statusCode = 403;
      err.isOperational = true;
      return next(err);
    }

    const index = parseInt(milestoneIndex, 10);
    if (isNaN(index) || !ledger.milestones[index]) {
      const err = new Error('Invalid milestone index specified.');
      err.statusCode = 400;
      err.isOperational = true;
      return next(err);
    }

    // 🛡️ FINANCIAL SECURITY GUARD: Prevent proof uploads on unfunded escrows
    if (ledger.ledgerStatus === 'PENDING_FUNDING') {
      const financialError = new Error('Transaction Rejected: Escrow ledger must be funded by the client before construction proof of work can be submitted.');
      financialError.statusCode = 403;
      financialError.isOperational = true;
      return next(financialError);
    }

    const secureHash = crypto.randomBytes(16).toString('hex');
    const fileExtension = req.file.originalname.split('.').pop().toLowerCase();
    const cloudAssetUrl = `https://storage.buildbd.internal/proofs/${ledgerId}-m${index}-${secureHash}.${fileExtension}`;

    ledger.milestones[index].proofOfWorkUrl = cloudAssetUrl;
    ledger.milestones[index].status = 'IN_PROGRESS';

    await ledger.save();

    res.status(200).json({
      status: 'success',
      message: 'Proof of work securely anchored to escrow milestone.',
      milestone: ledger.milestones[index],
      ledgerStatus: ledger.ledgerStatus
    });
  })
);

module.exports = router;