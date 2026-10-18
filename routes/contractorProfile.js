const express = require('express');
const router = express.Router();
const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const ContractorProfile = require('../models/ContractorProfile');
const { WORK_GENRES, MODALITIES, CONTRACTOR_TIERS } = ContractorProfile;

// Pilot switch: which genres the directory advertises (comma list; default = all).
// Narrowing it hides chips in the UI without touching stored data.
const enabledGenres = () => {
  const raw = (process.env.ENABLED_WORK_GENRES || '').split(',').map((s) => s.trim()).filter(Boolean);
  const on = raw.filter((g) => WORK_GENRES.includes(g));
  return on.length ? on : WORK_GENRES;
};
const pickEnum = (list, allowed) => (Array.isArray(list) ? [...new Set(list.filter((x) => allowed.includes(x)))] : []);
const bad = (message) => Object.assign(new Error(message), { statusCode: 400, isOperational: true });

// Public-safe projection: never phone number, never licence number.
const toDirectoryCard = (p) => ({
  userId: p.userId,
  fullName: p.fullName,
  businessType: p.businessType,
  contractorTier: p.contractorTier || 'MISTRI_SARDAR',
  workGenres: p.workGenres || [],
  supportedModalities: p.supportedModalities || [],
  serviceAreas: (p.serviceAreas || []).map((a) => ({ district: a.district, areas: a.areas || [] })),
  verificationLevel: p.verification ? p.verification.verificationLevel : 'BASIC',
  hasTradeLicense: Boolean(p.tradeLicense),
  completedProjects: p.statistics ? p.statistics.totalProjectsCompleted : 0,
  avgRatingMilli: Math.round(Math.max(0, Math.min(5, (p.statistics && p.statistics.averageRating) || 0)) * 1000),
  trustScore: p.trustScore || 0
});
const CARD_FIELDS = 'userId fullName businessType tradeLicense contractorTier workGenres supportedModalities serviceAreas verification.verificationLevel statistics.totalProjectsCompleted statistics.averageRating trustScore';

// @route   POST /api/contractor-profile
// @desc    Create the authenticated contractor's trade profile (once)
// @access  Private (CONTRACTOR)
router.post('/', verifyToken, requireRole(['CONTRACTOR']), catchAsync(async (req, res, next) => {
  const { businessType, fullName, tradeLicense, serviceAreas, availability, contractorTier } = req.body;
  if (contractorTier !== undefined && !CONTRACTOR_TIERS.includes(contractorTier)) {
    return next(bad(`contractorTier must be one of ${CONTRACTOR_TIERS.join(', ')}.`));
  }

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
      ...(contractorTier ? { contractorTier } : {}),
      workGenres: pickEnum(req.body.workGenres, WORK_GENRES),
      supportedModalities: pickEnum(req.body.supportedModalities, MODALITIES),
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

// GET /api/contractor-profile/directory — verified contractors, best-trusted first.
// Any signed-in user; filters are enum/length-checked strings only (no operator injection).
// Query: workGenre, modality, tier, district, page (1-50), limit (max 20).
router.get('/directory', verifyToken, requireRole(['CLIENT', 'CONTRACTOR', 'ADMIN', 'MODERATOR']), catchAsync(async (req, res, next) => {
  const q = req.query;
  const str = (v) => (typeof v === 'string' ? v.trim() : undefined);
  const filter = { 'verification.status': 'VERIFIED' };

  const workGenre = str(q.workGenre);
  if (workGenre) { if (!WORK_GENRES.includes(workGenre)) return next(bad('Unknown workGenre.')); filter.workGenres = workGenre; }
  const modality = str(q.modality);
  if (modality) { if (!MODALITIES.includes(modality)) return next(bad('Unknown modality.')); filter.supportedModalities = modality; }
  const tier = str(q.tier);
  if (tier) { if (!CONTRACTOR_TIERS.includes(tier)) return next(bad('Unknown tier.')); filter.contractorTier = tier; }
  const district = str(q.district);
  if (district) { if (district.length > 60) return next(bad('district too long.')); filter['serviceAreas.district'] = district; }

  const limit = Math.min(20, Math.max(1, parseInt(q.limit, 10) || 20));
  const page = Math.min(50, Math.max(1, parseInt(q.page, 10) || 1));

  const rows = await ContractorProfile.find(filter)
    .sort({ trustScore: -1, _id: -1 })
    .skip((page - 1) * limit)
    .limit(limit + 1)
    .select(CARD_FIELDS)
    .lean();

  res.status(200).json({
    status: 'success',
    data: {
      page,
      hasMore: rows.length > limit,
      enabledGenres: enabledGenres(),
      contractors: rows.slice(0, limit).map(toDirectoryCard)
    }
  });
}));

// GET /api/contractor-profile/directory/:userId — one verified contractor's card.
router.get('/directory/:userId', verifyToken, requireRole(['CLIENT', 'CONTRACTOR', 'ADMIN', 'MODERATOR']), catchAsync(async (req, res, next) => {
  if (!/^[a-f\d]{24}$/i.test(String(req.params.userId))) return next(bad('Invalid contractor id.'));
  const p = await ContractorProfile.findOne({ userId: req.params.userId, 'verification.status': 'VERIFIED' }).select(CARD_FIELDS).lean();
  if (!p) {
    return next(Object.assign(new Error('Contractor not found.'), { statusCode: 404, isOperational: true }));
  }
  res.status(200).json({ status: 'success', data: { contractor: toDirectoryCard(p), enabledGenres: enabledGenres() } });
}));

// @route   PATCH /api/contractor-profile/:userId/verify
// @desc    Admin verification decision (ops SLA path from spec §8)
// @access  Private (ADMIN)
// GET /api/contractor-profile/pending — admin queue of contractors awaiting
// verification (UNVERIFIED or PENDING), oldest first. ADMIN only.
router.get('/pending', verifyToken, requireRole(['ADMIN']), catchAsync(async (req, res) => {
  const profiles = await ContractorProfile.find({ 'verification.status': { $in: ['UNVERIFIED', 'PENDING'] } })
    .sort({ createdAt: 1 })
    .limit(100)
    .select('userId businessType fullName tradeLicense serviceAreas verification.status verification.verificationLevel createdAt')
    .populate({ path: 'userId', select: 'phoneNumber' })
    .lean();

  res.status(200).json({
    status: 'success',
    data: {
      count: profiles.length,
      profiles: profiles.map((p) => ({
        userId: p.userId ? p.userId._id : null,
        phoneNumber: p.userId ? p.userId.phoneNumber : null,
        businessType: p.businessType,
        fullName: p.fullName,
        tradeLicense: p.tradeLicense || null,
        serviceAreas: p.serviceAreas || [],
        verificationStatus: p.verification ? p.verification.status : null,
        submittedAt: p.createdAt
      }))
    }
  });
}));

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
