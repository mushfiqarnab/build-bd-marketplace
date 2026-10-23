// routes/supplier.js — Materials Marketplace Supplier Onboarding, KYC & Directory
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const router = express.Router();

const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const { runTransaction } = require('../utils/transaction');
const { emitAudit } = require('../services/auditService');
const { SupplierProfile, MATERIAL_CATEGORIES } = require('../models/SupplierProfile');
const User = require('../models/User');

const bad = (message, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode, isOperational: true });

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/supplier/profile
// Create or update authenticated supplier's trade & KYC profile
// Access: Private (SUPPLIER)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/profile',
  verifyToken,
  requireRole(['SUPPLIER']),
  catchAsync(async (req, res, next) => {
    const userId = req.user.userId || req.user.id;
    const {
      businessName,
      tradeLicenseNumber,
      nidNumber,
      bstiLicenseNumber,
      bstiQrDocUrl,
      categories,
      serviceDistricts
    } = req.body || {};

    if (!businessName || typeof businessName !== 'string' || businessName.trim().length < 2 || businessName.trim().length > 120) {
      return next(bad('Valid business name is required (2–120 characters).'));
    }

    if (!tradeLicenseNumber || typeof tradeLicenseNumber !== 'string' || tradeLicenseNumber.trim().length < 3 || tradeLicenseNumber.trim().length > 64) {
      return next(bad('Valid trade license number is required (3–64 characters).'));
    }

    if (!nidNumber || typeof nidNumber !== 'string' || nidNumber.trim().length < 10 || nidNumber.trim().length > 20) {
      return next(bad('Valid National ID number is required (10–20 characters).'));
    }

    if (!Array.isArray(categories) || categories.length === 0) {
      return next(bad('At least one material category is required.'));
    }

    const invalidCat = categories.find((c) => !MATERIAL_CATEGORIES.includes(c));
    if (invalidCat) {
      return next(bad(`Invalid material category: ${invalidCat}. Allowed categories: ${MATERIAL_CATEGORIES.join(', ')}`));
    }

    if (!Array.isArray(serviceDistricts) || serviceDistricts.length === 0) {
      return next(bad('At least one service district is required.'));
    }

    const cleanDistricts = serviceDistricts
      .filter((d) => typeof d === 'string' && d.trim().length > 0)
      .map((d) => d.trim());

    if (cleanDistricts.length === 0) {
      return next(bad('Valid service districts must be specified.'));
    }

    const normTrade = tradeLicenseNumber.trim().toUpperCase();

    // Check unique trade license across other supplier accounts
    const existing = await SupplierProfile.findOne({ tradeLicenseNumber: normTrade });
    if (existing && String(existing.userId) !== String(userId)) {
      return next(bad('Trade license number is already registered to another supplier account.', 409));
    }

    const cleanNid = nidNumber.trim();
    const nidHash = crypto.createHash('sha256').update(cleanNid).digest('hex');
    const nidLast4 = cleanNid.slice(-4);

    const updateDoc = {
      userId,
      businessName: businessName.trim(),
      tradeLicenseNumber: normTrade,
      nidNumber: cleanNid,
      nidHash,
      nidLast4,
      bstiLicenseNumber: typeof bstiLicenseNumber === 'string' ? bstiLicenseNumber.trim() : '',
      bstiQrDocUrl: typeof bstiQrDocUrl === 'string' ? bstiQrDocUrl.trim() : '',
      categories: [...new Set(categories)],
      serviceDistricts: [...new Set(cleanDistricts)],
      'verification.status': 'PENDING_VERIFICATION'
    };

    const profile = await SupplierProfile.findOneAndUpdate(
      { userId },
      { $set: updateDoc },
      { returnDocument: 'after', upsert: true, runValidators: true }
    );

    res.status(201).json({
      status: 'success',
      message: 'Supplier KYC profile submitted for verification.',
      data: { profile }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/supplier/me
// Fetch authenticated supplier's own profile
// Access: Private (SUPPLIER)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/me',
  verifyToken,
  requireRole(['SUPPLIER']),
  catchAsync(async (req, res, next) => {
    const userId = req.user.userId || req.user.id;
    const profile = await SupplierProfile.findOne({ userId });

    if (!profile) {
      return next(bad('Supplier profile not found.', 404));
    }

    res.status(200).json({
      status: 'success',
      data: { profile }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/supplier/pending
// Admin verification queue of suppliers awaiting KYC clearance (oldest first)
// Access: Private (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/pending',
  verifyToken,
  requireRole(['ADMIN']),
  catchAsync(async (req, res) => {
    const profiles = await SupplierProfile.find({ 'verification.status': 'PENDING_VERIFICATION' })
      .sort({ createdAt: 1 })
      .limit(100)
      .populate({ path: 'userId', select: 'phoneNumber status' })
      .lean();

    const formatted = profiles.map((p) => ({
      _id: p._id,
      userId: p.userId?._id || p.userId,
      phoneNumber: p.userId?.phoneNumber || 'N/A',
      userStatus: p.userId?.status || 'PENDING_VERIFICATION',
      businessName: p.businessName,
      tradeLicenseNumber: p.tradeLicenseNumber,
      nidNumber: p.nidNumber,
      bstiLicenseNumber: p.bstiLicenseNumber || '',
      bstiQrDocUrl: p.bstiQrDocUrl || '',
      categories: p.categories || [],
      serviceDistricts: p.serviceDistricts || [],
      verificationStatus: p.verification?.status || 'PENDING_VERIFICATION',
      submittedAt: p.createdAt
    }));

    res.status(200).json({
      status: 'success',
      data: {
        count: formatted.length,
        suppliers: formatted
      }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/supplier/:userId/verify
// Admin verification decision (VERIFIED or REJECTED) with cryptographic audit
// Access: Private (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/:userId/verify',
  verifyToken,
  requireRole(['ADMIN']),
  catchAsync(async (req, res, next) => {
    const targetId = req.params.userId;
    const { status, rejectionReason } = req.body || {};

    if (!status || !['VERIFIED', 'REJECTED'].includes(status)) {
      return next(bad('status must be either VERIFIED or REJECTED.'));
    }

    if (status === 'REJECTED' && (!rejectionReason || typeof rejectionReason !== 'string' || rejectionReason.trim().length === 0)) {
      return next(bad('Rejection reason is required when rejecting a supplier.'));
    }

    const verifiedProfile = await runTransaction(async (session) => {
      const isObjectId = mongoose.isValidObjectId(targetId);
      const query = isObjectId
        ? { $or: [{ userId: targetId }, { _id: targetId }] }
        : { userId: targetId };

      const profile = await SupplierProfile.findOne(query).session(session);
      if (!profile) {
        throw bad('Supplier profile not found.', 404);
      }

      const now = new Date();
      profile.verification = {
        status,
        verifiedAt: now,
        verifiedBy: req.user.userId || req.user.id,
        rejectionReason: status === 'REJECTED' ? rejectionReason.trim() : ''
      };

      await profile.save({ session });

      if (status === 'VERIFIED') {
        await User.updateOne(
          { _id: profile.userId, status: 'PENDING_VERIFICATION' },
          { $set: { status: 'ACTIVE' } },
          { session }
        );
      }

      await emitAudit({
        session,
        entityId: profile._id,
        entityType: 'SUPPLIER_PROFILE',
        action: status === 'VERIFIED' ? 'SUPPLIER_VERIFIED' : 'SUPPLIER_REJECTED',
        actorId: req.user.userId || req.user.id,
        actorRole: req.user.role,
        metadata: {
          supplierUserId: String(profile.userId),
          businessName: profile.businessName,
          tradeLicenseNumber: profile.tradeLicenseNumber,
          rejectionReason: status === 'REJECTED' ? rejectionReason.trim() : undefined
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      return profile;
    });

    res.status(200).json({
      status: 'success',
      message: `Supplier verification updated to ${status}.`,
      data: { profile: verifiedProfile }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/supplier/directory
// Public directory of verified suppliers with category & district filters
// Access: Public
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/directory',
  catchAsync(async (req, res) => {
    const query = { 'verification.status': 'VERIFIED' };

    if (req.query.district && typeof req.query.district === 'string') {
      query.serviceDistricts = req.query.district.trim();
    }

    if (req.query.category && typeof req.query.category === 'string') {
      const cat = req.query.category.trim().toUpperCase();
      if (MATERIAL_CATEGORIES.includes(cat)) {
        query.categories = cat;
      }
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [suppliers, total] = await Promise.all([
      SupplierProfile.find(query)
        .select('-nidNumber')
        .sort({ 'statistics.trustScore': -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      SupplierProfile.countDocuments(query)
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        suppliers,
        total,
        page,
        limit,
        hasMore: skip + suppliers.length < total
      }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/supplier/:id
// Public single verified supplier card
// Access: Public
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:id',
  catchAsync(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(bad('Invalid supplier ID.', 400));
    }

    const profile = await SupplierProfile.findOne({
      $or: [{ _id: req.params.id }, { userId: req.params.id }],
      'verification.status': 'VERIFIED'
    })
      .select('-nidNumber')
      .lean();

    if (!profile) {
      return next(bad('Verified supplier profile not found.', 404));
    }

    res.status(200).json({
      status: 'success',
      data: { profile }
    });
  })
);

module.exports = router;
