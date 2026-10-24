const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const crypto = require('crypto');
const { verifyToken, requireRole } = require('../middleware/auth');
const { strictAuthAndBidLimiter } = require('../middleware/rateLimiter');
const catchAsync = require('../utils/catchAsync');
const { runTransaction } = require('../utils/transaction');
const { emitAudit } = require('../services/auditService');
const { scanDocument, validateBangladeshiNid } = require('../services/fraudDetectionService');
const User = require('../models/User');
const { issueSession } = require('../services/sessionService');
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
// @desc    Create the authenticated contractor's trade profile (once). Allows CLIENT / PENDING_ONBOARDING to become a Service Provider later.
// @access  Private (CONTRACTOR, CLIENT, PENDING_ONBOARDING)
router.post('/', strictAuthAndBidLimiter, verifyToken, requireRole(['CONTRACTOR', 'CLIENT', 'PENDING_ONBOARDING']), catchAsync(async (req, res, next) => {
  const { businessType, fullName, tradeLicense, nid, nidNumber, serviceAreas, availability, contractorTier } = req.body;
  if (contractorTier !== undefined && !CONTRACTOR_TIERS.includes(contractorTier)) {
    return next(bad(`contractorTier must be one of ${CONTRACTOR_TIERS.join(', ')}.`));
  }

  if (businessType !== undefined && !['INDIVIDUAL', 'COMPANY'].includes(businessType)) {
    return next(Object.assign(new Error('businessType must be INDIVIDUAL or COMPANY.'), {
      statusCode: 400,
      isOperational: true
    }));
  }

  const effectiveBusinessType = (businessType && ['INDIVIDUAL', 'COMPANY'].includes(businessType)) ? businessType : 'INDIVIDUAL';
  const trimmedName = String(fullName || '').trim();
  if (trimmedName && trimmedName.length < 2) {
    return next(Object.assign(new Error('fullName must be at least 2 characters.'), {
      statusCode: 400,
      isOperational: true
    }));
  }

  // General name default per user directive: mistris/technicians receive an inclusive general name
  const effectiveFullName = trimmedName.length >= 2
    ? trimmedName
    : (effectiveBusinessType === 'COMPANY' ? 'ট্রেড প্রতিষ্ঠান (Service Firm)' : 'স্বতন্ত্র সেবাদাতা ও কারিগর');

  const rawNid = String(nid || nidNumber || '').trim();
  const nidValidation = rawNid ? validateBangladeshiNid(rawNid) : { valid: false };
  const hasValidNid = nidValidation.valid;
  const nidHash = hasValidNid
    ? crypto.createHmac('sha256', process.env.NID_HASH_SECRET || process.env.BID_SEAL_SECRET || process.env.JWT_SECRET || 'buildbd-nid-salt').update(rawNid).digest('hex')
    : undefined;

  const validGenres = pickEnum(req.body.workGenres, WORK_GENRES);
  // Auto-verification under probation is reserved strictly for INDIVIDUAL tradesmen (Mistri Sardar).
  // Corporate entities (businessType: 'COMPANY') require trade license review and cannot be auto-verified.
  const isMistriTier = effectiveBusinessType === 'INDIVIDUAL' && (contractorTier === 'MISTRI_SARDAR' || !contractorTier);

  let initialVerification = {
    status: 'UNVERIFIED',
    verificationLevel: 'BASIC',
    probationStatus: { isProbation: true, projectsCompleted: 0, projectsRequired: 3, canBidAbove: 100000 }
  };
  if (isMistriTier && hasValidNid && validGenres.length > 0) {
    initialVerification = {
      status: 'VERIFIED',
      verificationLevel: 'BASIC',
      verifiedAt: new Date(),
      probationStatus: {
        isProbation: true,
        projectsCompleted: 0,
        projectsRequired: 3,
        canBidAbove: 100000
      }
    };
  }

  try {
    const profile = await runTransaction(async (session) => {
      const [createdProfile] = await ContractorProfile.create([{
        userId: req.user.userId,
        businessType: effectiveBusinessType,
        fullName: effectiveFullName,
        tradeLicense: tradeLicense ? String(tradeLicense).trim() : undefined,
        ...(nidHash ? { nidHash } : {}),
        serviceAreas: Array.isArray(serviceAreas) ? serviceAreas : [],
        ...(contractorTier ? { contractorTier } : {}),
        workGenres: validGenres,
        supportedModalities: pickEnum(req.body.supportedModalities, MODALITIES),
        verification: initialVerification,
        availability: {
          currentProjects: 0,
          maxConcurrentProjects: Math.max(1, Number(availability?.maxConcurrentProjects) || 3)
        }
      }], { session });

      // Automatically upgrade user role if they became a contractor / service provider later
      if (req.user.role !== 'CONTRACTOR') {
        await User.collection.updateOne(
          { _id: new mongoose.Types.ObjectId(req.user.userId) },
          { $set: { role: 'CONTRACTOR', status: 'ACTIVE' } },
          { session }
        );
      }

      const isAutoVerified = initialVerification.status === 'VERIFIED';
      await emitAudit({
        session,
        entityId: createdProfile._id,
        entityType: 'CONTRACTOR_PROFILE',
        action: isAutoVerified ? 'CONTRACTOR_AUTO_VERIFIED' : 'CONTRACTOR_PROFILE_CREATED',
        actorId: req.user.userId,
        actorRole: req.user.role,
        metadata: {
          contractorTier: createdProfile.contractorTier,
          businessType: createdProfile.businessType,
          hasNid: Boolean(createdProfile.nidHash),
          status: createdProfile.verification.status
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      return createdProfile;
    });

    if (req.user.role !== 'CONTRACTOR') {
      const updatedUser = await User.findById(req.user.userId).lean();
      if (updatedUser) {
        issueSession(res, updatedUser);
        req.user.role = 'CONTRACTOR';
      }
    }

    const isAutoVerified = initialVerification.status === 'VERIFIED';
    res.status(201).json({
      status: 'success',
      message: isAutoVerified
        ? 'Contractor profile created and verified under probation tier (up to ৳100,000 bids).'
        : 'Contractor profile created. Await verification before bidding.',
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
// @access  Private (CONTRACTOR, CLIENT, PENDING_ONBOARDING)
router.get('/me', verifyToken, requireRole(['CONTRACTOR', 'CLIENT', 'PENDING_ONBOARDING']), catchAsync(async (req, res, next) => {
  const profile = await ContractorProfile.findOne({ userId: req.user.userId });
  if (!profile) {
    return next(Object.assign(new Error('Contractor profile not found.'), {
      statusCode: 404,
      isOperational: true
    }));
  }

  res.status(200).json({ status: 'success', profile });
}));

// @route   PATCH /api/contractor-profile/me
// @desc    The contractor edits their OWN trade profile (audit K2: it could be created but never corrected).
//          Changing the name, licence or business type of a VERIFIED profile sends it back to PENDING so an
//          admin re-checks it — verification cannot be earned once and then edited away.
// @access  Private (CONTRACTOR)
router.patch('/me', strictAuthAndBidLimiter, verifyToken, requireRole(['CONTRACTOR']), catchAsync(async (req, res, next) => {
  const b = req.body || {};
  const set = {};
  let needsReview = false;
  const text = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;

  if (b.fullName !== undefined) {
    if (!text(b.fullName, 2, 80)) return next(bad('fullName must be 2–80 characters.'));
    set.fullName = b.fullName.trim(); needsReview = true;
  }
  if (b.tradeLicense !== undefined) {
    if (b.tradeLicense !== null && b.tradeLicense !== '' && !text(b.tradeLicense, 1, 60)) return next(bad('tradeLicense must be at most 60 characters.'));
    set.tradeLicense = b.tradeLicense ? b.tradeLicense.trim() : undefined; needsReview = true;
  }
  if (b.businessType !== undefined) {
    if (!['INDIVIDUAL', 'COMPANY'].includes(b.businessType)) return next(bad('businessType must be INDIVIDUAL or COMPANY.'));
    set.businessType = b.businessType; needsReview = true;
  }
  if (b.contractorTier !== undefined) {
    if (!CONTRACTOR_TIERS.includes(b.contractorTier)) return next(bad(`contractorTier must be one of ${CONTRACTOR_TIERS.join(', ')}.`));
    set.contractorTier = b.contractorTier;
  }
  if (b.workGenres !== undefined) {
    if (!Array.isArray(b.workGenres)) return next(bad('workGenres must be a list.'));
    set.workGenres = pickEnum(b.workGenres, WORK_GENRES);
  }
  if (b.supportedModalities !== undefined) {
    if (!Array.isArray(b.supportedModalities)) return next(bad('supportedModalities must be a list.'));
    set.supportedModalities = pickEnum(b.supportedModalities, MODALITIES);
  }
  if (b.serviceAreas !== undefined) {
    if (!Array.isArray(b.serviceAreas) || b.serviceAreas.length > 20) return next(bad('serviceAreas must be a list of at most 20 districts.'));
    const clean = [];
    for (const a of b.serviceAreas) {
      if (!a || !text(a.district, 1, 60)) return next(bad('Every service area needs a district (1–60 characters).'));
      const areas = Array.isArray(a.areas) ? a.areas : [];
      if (areas.length > 20 || areas.some((x) => !text(x, 1, 60))) return next(bad('Each district may list up to 20 areas of 1–60 characters.'));
      clean.push({ district: a.district.trim(), areas: areas.map((x) => x.trim()), willingToTravel: Boolean(a.willingToTravel) });
    }
    set.serviceAreas = clean;
  }
  if (b.availability !== undefined) {
    const max = b.availability && b.availability.maxConcurrentProjects;
    if (!Number.isInteger(max) || max < 1 || max > 50) return next(bad('availability.maxConcurrentProjects must be a whole number from 1 to 50.'));
    set['availability.maxConcurrentProjects'] = max;
  }
  if (!Object.keys(set).length) return next(bad('Nothing to update: send at least one editable field.'));

  const profile = await runTransaction(async (session) => {
    const p = await ContractorProfile.findOne({ userId: req.user.userId }).session(session);
    if (!p) throw Object.assign(new Error('Contractor profile not found. Create it first.'), { statusCode: 404, isOperational: true });
    let backToReview = false;
    for (const [k, v] of Object.entries(set)) p.set(k, v);
    if (needsReview && p.verification.status === 'VERIFIED') { p.verification.status = 'PENDING'; backToReview = true; }
    await p.save({ session });
    await emitAudit({
      session,
      entityId: p._id,
      entityType: 'CONTRACTOR_PROFILE',
      action: 'CONTRACTOR_PROFILE_UPDATED',
      actorId: req.user.userId,
      actorRole: req.user.role,
      metadata: { fields: Object.keys(set), sentBackToReview: backToReview },
      ipAddress: req.ip || 'SYSTEM_INTERNAL'
    });
    return p;
  });

  res.status(200).json({
    status: 'success',
    message: profile.verification.status === 'PENDING' ? 'Profile updated. It will be re-checked before it is public again.' : 'Profile updated.',
    profile
  });
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
  const category = str(q.category);
  if (category) {
    const { getContractorGenresForCategory } = require('../config/bdWorkTaxonomy');
    const matchedGenres = getContractorGenresForCategory(category);
    if (matchedGenres && matchedGenres.length > 0) {
      filter.workGenres = { $in: matchedGenres };
    }
  }
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
  const p = await ContractorProfile.findOne({
    $or: [{ userId: req.params.userId }, { _id: req.params.userId }],
    'verification.status': 'VERIFIED'
  }).select(CARD_FIELDS).lean();
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
    .select('userId businessType fullName tradeLicense nidHash serviceAreas verification.status verification.verificationLevel createdAt')
    .populate({ path: 'userId', select: 'phoneNumber' })
    .lean();

  const allTradeLicenses = profiles.map((p) => p.tradeLicense).filter(Boolean);
  const duplicateLicenses = new Set();
  if (allTradeLicenses.length > 0) {
    const existingMatches = await ContractorProfile.find({
      tradeLicense: { $in: allTradeLicenses }
    }).select('tradeLicense userId').lean();
    const licenseCounts = {};
    for (const m of existingMatches) {
      licenseCounts[m.tradeLicense] = (licenseCounts[m.tradeLicense] || 0) + 1;
      if (licenseCounts[m.tradeLicense] > 1) duplicateLicenses.add(m.tradeLicense);
    }
  }

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
        isDuplicateTradeLicense: p.tradeLicense ? duplicateLicenses.has(p.tradeLicense) : false,
        hasNid: Boolean(p.nidHash),
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

  if (!mongoose.Types.ObjectId.isValid(req.params.userId)) {
    return next(Object.assign(new Error('Invalid contractor userId.'), {
      statusCode: 400,
      isOperational: true
    }));
  }

  const profile = await runTransaction(async (session) => {
    const updated = await ContractorProfile.findOneAndUpdate(
      { userId: req.params.userId },
      { $set: update },
      { returnDocument: 'after', session }
    );
    if (!updated) return null;

    await emitAudit({
      session,
      entityId: updated._id,
      entityType: 'CONTRACTOR_PROFILE',
      action: status === 'VERIFIED' ? 'CONTRACTOR_VERIFIED' : (status === 'REJECTED' ? 'CONTRACTOR_REJECTED' : 'CONTRACTOR_PROFILE_UPDATED'),
      actorId: req.user.userId,
      actorRole: req.user.role,
      metadata: {
        targetUserId: String(req.params.userId),
        status,
        verificationLevel: updated.verification?.verificationLevel || null,
        isProbation: Boolean(updated.verification?.probationStatus?.isProbation)
      },
      ipAddress: req.ip || 'SYSTEM_INTERNAL'
    });
    return updated;
  });

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

// @route   POST /api/contractor-profile/fields
// @desc    Register or expand a work field / trade with past work description and completion evidence documents
// @access  Private (CONTRACTOR, CLIENT, PENDING_ONBOARDING)
router.post('/fields', strictAuthAndBidLimiter, verifyToken, requireRole(['CONTRACTOR', 'CLIENT', 'PENDING_ONBOARDING']), catchAsync(async (req, res, next) => {
  const { genre, tier, pastWorkSummary, completionDocuments } = req.body || {};
  if (!genre || !WORK_GENRES.includes(genre)) {
    return next(bad(`genre must be one of: ${WORK_GENRES.join(', ')}`));
  }

  const profile = await ContractorProfile.findOne({ userId: req.user.userId });
  if (!profile) {
    return next(Object.assign(new Error('Contractor profile not found. Complete your base profile first.'), { statusCode: 404, isOperational: true }));
  }

  // Sanitize documents and run fraud scan
  const scannedDocs = [];
  let worstFraudStatus = 'CLEARED';
  let minRiskScore = 100;

  if (Array.isArray(completionDocuments)) {
    for (const doc of completionDocuments) {
      if (!doc || !doc.title) continue;
      let fraudStatus = 'PENDING_VERIFICATION';
      let fraudRiskScore = 50;

      // If document contains base64 data for on-the-fly fraud scanning
      if (doc.fileData && typeof doc.fileData === 'string') {
        const buffer = Buffer.from(doc.fileData.replace(/^data:.*?;base64,/, ''), 'base64');
        if (buffer.length > 10 * 1024 * 1024) {
          return next(bad('File exceeds maximum size of 10MB.'));
        }
        const scanResult = await scanDocument({
          buffer,
          fileName: doc.title,
          mimeType: doc.mimeType || 'image/jpeg',
          userId: req.user.userId,
          documentCategory: 'WORK_COMPLETION_PHOTO'
        });
        fraudStatus = scanResult.fraudStatus;
        fraudRiskScore = scanResult.fraudRiskScore;
        if (scanResult.fileHash) doc.documentHash = scanResult.fileHash;
      } else if (doc.documentHash) {
        const DocumentScan = require('../models/DocumentScan');
        const recordedScan = await DocumentScan.findOne({
          fileHash: String(doc.documentHash),
          userId: req.user.userId
        }).lean();
        if (recordedScan) {
          fraudStatus = recordedScan.fraudStatus;
          fraudRiskScore = recordedScan.fraudRiskScore;
        }
      }

      if (fraudStatus === 'REJECTED') worstFraudStatus = 'REJECTED';
      else if (fraudStatus === 'SUSPICIOUS' && worstFraudStatus !== 'REJECTED') worstFraudStatus = 'SUSPICIOUS';

      minRiskScore = Math.min(minRiskScore, fraudRiskScore);

      scannedDocs.push({
        title: String(doc.title).slice(0, 120),
        documentUrl: doc.documentUrl ? String(doc.documentUrl).slice(0, 500) : undefined,
        documentHash: doc.documentHash ? String(doc.documentHash) : undefined,
        fraudStatus,
        fraudRiskScore,
        uploadedAt: new Date()
      });
    }
  }

  if (worstFraudStatus === 'REJECTED') {
    return next(Object.assign(new Error('Document verification rejected: Anti-fraud scanner detected duplicate, manipulated, or invalid evidence files.'), {
      statusCode: 422,
      isOperational: true
    }));
  }

  // Defer role upgrade until after document validation and fraud scanning passes
  if (req.user.role !== 'CONTRACTOR') {
    await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(req.user.userId) },
      { $set: { role: 'CONTRACTOR', status: 'ACTIVE' } }
    );
    const updatedUser = await User.findById(req.user.userId).lean();
    if (updatedUser) {
      issueSession(res, updatedUser);
      req.user.role = 'CONTRACTOR';
    }
  }

  // Update or push into workFields
  profile.workFields = profile.workFields || [];
  const existingIdx = profile.workFields.findIndex(f => f.genre === genre);
  const fieldData = {
    genre,
    tier: ['MICRO', 'GENERAL', 'ADVANCED'].includes(tier) ? tier : 'MICRO',
    status: worstFraudStatus === 'CLEARED' && scannedDocs.length > 0 ? 'ACTIVE' : 'PENDING_VERIFICATION',
    pastWorkSummary: pastWorkSummary ? String(pastWorkSummary).slice(0, 2000) : '',
    completionDocuments: scannedDocs,
    verifiedAt: worstFraudStatus === 'CLEARED' && scannedDocs.length > 0 ? new Date() : null
  };

  if (existingIdx >= 0) {
    profile.workFields[existingIdx] = fieldData;
  } else {
    profile.workFields.push(fieldData);
  }

  if (fieldData.status === 'ACTIVE' && !profile.workGenres.includes(genre)) {
    profile.workGenres.push(genre);
  }

  await profile.save();

  res.status(200).json({
    status: 'success',
    message: fieldData.status === 'ACTIVE'
      ? `Field '${genre}' successfully verified and unlocked for bidding.`
      : `Field '${genre}' submitted for verification. Experience documents recorded.`,
    field: fieldData,
    fraudRiskScore: minRiskScore
  });
}));

// @route   POST /api/contractor-profile/scan-document
// @desc    Pre-upload fraud inspection for certificates, NID, and completion proofs
// @access  Private (CONTRACTOR, CLIENT, PENDING_ONBOARDING)
router.post('/scan-document', strictAuthAndBidLimiter, verifyToken, requireRole(['CONTRACTOR', 'CLIENT', 'PENDING_ONBOARDING']), catchAsync(async (req, res, next) => {
  const { fileData, fileName, mimeType, documentCategory, declaredNumber } = req.body || {};
  if (!fileData || typeof fileData !== 'string') {
    return next(bad('fileData (base64) is required.'));
  }

  const buffer = Buffer.from(fileData.replace(/^data:.*?;base64,/, ''), 'base64');
  if (buffer.length > 10 * 1024 * 1024) {
    return next(bad('File exceeds maximum size of 10MB.'));
  }

  const result = await scanDocument({
    buffer,
    fileName,
    mimeType,
    userId: req.user.userId,
    documentCategory: ['NID', 'TRADE_LICENSE', 'EXPERIENCE_CERTIFICATE', 'WORK_COMPLETION_PHOTO', 'OTHER'].includes(documentCategory) ? documentCategory : 'OTHER',
    declaredNumber
  });

  res.status(200).json({
    status: 'success',
    data: result
  });
}));

module.exports = router;
