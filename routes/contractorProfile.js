const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const ContractorProfile = require('../models/ContractorProfile');

// @route   POST /api/contractor-profile
// @desc    Create the authenticated contractor's trade profile (once)
// @access  Private (CONTRACTOR)
router.post('/', verifyToken, requireRole(['CONTRACTOR']), catchAsync(async (req, res, next) => {
  const { businessType, fullName, tradeLicense, serviceAreas, availability } = req.body;

  if (!businessType || !['INDIVIDUAL', 'COMPANY'].includes(businessType)) {
    return next(Object.assign(new Error('businessType must be INDIVIDUAL or COMPANY.'), {
      statusCode: 400,
      isOperational: true
    }));
  }

  if (!fullName || String(fullName).trim().length < 2) {
    return next(Object.assign(new Error('fullName is required.'), {
      statusCode: 400,
      isOperational: true
    }));
  }

  try {
    const profile = await ContractorProfile.create({
      userId: req.user.userId,
      businessType,
      fullName: String(fullName).trim(),
      tradeLicense: tradeLicense ? String(tradeLicense).trim() : undefined,
      serviceAreas: Array.isArray(serviceAreas) ? serviceAreas : [],
      availability: {
        currentProjects: 0,
        maxConcurrentProjects: Math.max(1, Number(availability?.maxConcurrentProjects) || 3)
      }
      // verification defaults: UNVERIFIED + isProbation=true + canBidAbove=100000
    });

    res.status(201).json({
      status: 'success',
      message: 'Contractor profile created. Await verification before bidding.',
      profile
    });
  } catch (error) {
    if (error.code === 11000) {
      return next(Object.assign(new Error('Contractor profile already exists for this account.'), {
        statusCode: 409,
        isOperational: true
      }));
    }
    return next(error);
  }
}));

// @route   GET /api/contractor-profile/me
// @desc    Fetch own contractor profile
// @access  Private (CONTRACTOR)
router.get('/me', verifyToken, requireRole(['CONTRACTOR']), catchAsync(async (req, res, next) => {
  const profile = await ContractorProfile.findOne({ userId: req.user.userId });
  if (!profile) {
    return next(Object.assign(new Error('Contractor profile not found.'), {
      statusCode: 404,
      isOperational: true
    }));
  }

  res.status(200).json({ status: 'success', profile });
}));

// @route   PATCH /api/contractor-profile/:userId/verify
// @desc    Admin verification decision (ops SLA path from spec §8)
// @access  Private (ADMIN)
router.patch('/:userId/verify', verifyToken, requireRole(['ADMIN']), catchAsync(async (req, res, next) => {
  const { status, verificationLevel, clearProbation, canBidAbove } = req.body;

  if (!status || !['VERIFIED', 'REJECTED', 'PENDING', 'UNVERIFIED'].includes(status)) {
    return next(Object.assign(new Error('status must be VERIFIED, REJECTED, PENDING, or UNVERIFIED.'), {
      statusCode: 400,
      isOperational: true
    }));
  }

  const update = {
    'verification.status': status
  };

  if (verificationLevel && ['BASIC', 'STANDARD', 'PREMIUM'].includes(verificationLevel)) {
    update['verification.verificationLevel'] = verificationLevel;
  }

  if (typeof clearProbation === 'boolean') {
    update['verification.probationStatus.isProbation'] = !clearProbation;
  }

  if (Number.isFinite(Number(canBidAbove)) && Number(canBidAbove) > 0) {
    update['verification.probationStatus.canBidAbove'] = Number(canBidAbove);
  }

  const profile = await ContractorProfile.findOneAndUpdate(
    { userId: req.params.userId },
    { $set: update },
    { returnDocument: 'after' }
  );

  if (!profile) {
    return next(Object.assign(new Error('Contractor profile not found.'), {
      statusCode: 404,
      isOperational: true
    }));
  }

  res.status(200).json({
    status: 'success',
    message: `Contractor verification updated to ${status}.`,
    profile
  });
}));

module.exports = router;
