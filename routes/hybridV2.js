// routes/hybridV2.js
// Dual-Speed Hybrid Services Marketplace Routes (Tier 1 Micro Utility & Tier 2 Mid Split-BOQ)
'use strict';

const express = require('express');
const router = express.Router();
const catchAsync = require('../utils/catchAsync');
const { verifyToken, requireRole } = require('../middleware/auth');
const { enforceIdempotency } = require('../middleware/idempotency');
const { runTransaction } = require('../utils/transaction');
const { emitAudit } = require('../services/auditService');
const {
  computeMicroSettlementSplit,
  interpretUserUtterance,
  estimateRenovationPaintingSplit,
  estimateHomeShiftingSplit,
  estimateDeepCleaningSplit,
  estimateTilesAndMasonrySplit
} = require('../services/aiOrchestratorService');
const Project = require('../models/Project');

function operational(message, statusCode) {
  return Object.assign(new Error(message), { statusCode, isOperational: true });
}

// ── 1. POST /api/v2/projects/micro/dispatch (Tier 1 Micro Utility Dispatch) ──
router.post(
  '/micro/dispatch',
  verifyToken,
  requireRole(['CLIENT']),
  enforceIdempotency,
  catchAsync(async (req, res, next) => {
    const {
      categoryCode = 'MICRO_UTILITY',
      thana,
      district = 'Dhaka',
      floorLevel = 1,
      baseLaborBdt = 800,
      sparePartsBdt = 0,
      description
    } = req.body || {};

    if (!thana || typeof thana !== 'string' || !thana.trim()) {
      return next(operational('Thana location is required for micro technician dispatch.', 400));
    }

    const labor = Number(baseLaborBdt);
    const parts = Number(sparePartsBdt);
    const floor = Math.max(1, Number(floorLevel) || 1);

    if (!Number.isInteger(labor) || labor < 200) {
      return next(operational('baseLaborBdt must be an integer of at least 200 BDT.', 400));
    }
    if (!Number.isInteger(parts) || parts < 0) {
      return next(operational('sparePartsBdt must be a non-negative integer BDT value.', 400));
    }

    // Anti-collusion cap: Spare parts addendum cannot exceed 3x base labor or 5,000 BDT without cash memo audit
    const maxAllowedParts = Math.min(labor * 3, 5000);
    const requiresCashMemoAudit = parts > maxAllowedParts;

    const outdoorHangingSurchargeBdt = floor > 8 ? 800 : (floor >= 2 ? 400 : 0);
    const totalLaborBdt = labor + outdoorHangingSurchargeBdt;
    const settlementSplit = computeMicroSettlementSplit(totalLaborBdt, parts);

    let projectCategory = 'Electrical';
    if (/AC/i.test(categoryCode)) projectCategory = 'AC & Appliance';
    else if (/PLUMB/i.test(categoryCode)) projectCategory = 'Plumbing';
    else if (/PAINT/i.test(categoryCode)) projectCategory = 'Painting';
    else if (/CARP/i.test(categoryCode)) projectCategory = 'Carpentry & Woodwork';
    else if (/TILE|MASON/i.test(categoryCode)) projectCategory = 'Masonry & Tiles';
    else if (/WELD/i.test(categoryCode)) projectCategory = 'Welding & Fabrication';
    else if (/CCTV|SEC/i.test(categoryCode)) projectCategory = 'CCTV & Smart Security';
    else if (/SOLAR|IPS/i.test(categoryCode)) projectCategory = 'IPS, Solar & Power Backup';

    const project = await runTransaction(async (session) => {
      const doc = new Project({
        clientId: req.user.userId,
        title: `Micro Utility: ${categoryCode} in ${thana.trim()}`,
        description: description ? String(description).trim() : `Micro Utility Emergency Dispatch (${categoryCode}, Floor ${floor})`,
        category: projectCategory,
        location: thana.trim(),
        budget: Math.max(200, settlementSplit.grossTotalBdt),
        status: 'OPEN'
      });

      await doc.save({ session });

      await emitAudit({
        session,
        action: 'MICRO_DISPATCH_CREATED',
        actorId: req.user.userId,
        actorRole: req.user.role,
        entityType: 'PROJECT',
        entityId: doc._id,
        metadata: { categoryCode, thana, floorLevel: floor, settlementSplit, requiresCashMemoAudit },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      return doc;
    });

    res.status(201).json({
      status: 'success',
      data: {
        project,
        settlementSplit,
        outdoorHangingSurchargeBdt,
        requiresCashMemoAudit
      }
    });
  })
);

// ── 2. POST /api/v2/projects/mid/estimate-boq (Tier 2 Mid Renovation Split-BOQ) 
router.post(
  '/mid/estimate-boq',
  verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR', 'ADMIN', 'MODERATOR']),
  catchAsync(async (req, res, next) => {
    const {
      categoryCode = 'MID_PAINTING',
      areaSqft = 1800,
      areaSqFt,
      thana = 'Dhaka',
      paintTier = 'STANDARD',
      dampWallPercent = 0,
      includeWaterTank = false,
      includePestControl = false
    } = req.body || {};
    const resolvedArea = Number(areaSqFt || areaSqft || 1800);

    let pricingEstimate;
    let assistantReply;
    if (categoryCode === 'MID_SHIFTING') {
      pricingEstimate = estimateHomeShiftingSplit(req.body || {});
      assistantReply = {
        bn: `বাসা বদল (Shifting) এস্টিমেট প্রস্তুত: মোট ৳${pricingEstimate.totalEstimatedBdt.toLocaleString()}।`,
        en: `Home Shifting Split-BOQ ready: Total ৳${pricingEstimate.totalEstimatedBdt.toLocaleString()}.`
      };
    } else if (categoryCode === 'MID_DEEP_CLEAN') {
      pricingEstimate = estimateDeepCleaningSplit({ areaSqFt: resolvedArea, includeWaterTank, includePestControl });
      assistantReply = {
        bn: `ডিপ ক্লিনিং ও স্যানিটাইজেশন BOQ প্রস্তুত (${resolvedArea} sft): মোট ৳${pricingEstimate.totalEstimatedBdt.toLocaleString()}।`,
        en: `Deep Cleaning & Sanitization BOQ ready (${resolvedArea} sq ft): Total ৳${pricingEstimate.totalEstimatedBdt.toLocaleString()}.`
      };
    } else if (categoryCode === 'MID_TILES_MASONRY') {
      pricingEstimate = estimateTilesAndMasonrySplit({ areaSqFt: resolvedArea, paintTier });
      assistantReply = {
        bn: `টাইলস ও মেসনরি ফিনিশিং BOQ প্রস্তুত (${resolvedArea} sft): মোট ৳${pricingEstimate.totalEstimatedBdt.toLocaleString()}।`,
        en: `Tiles & Masonry Finishing BOQ ready (${resolvedArea} sq ft): Total ৳${pricingEstimate.totalEstimatedBdt.toLocaleString()}.`
      };
    } else {
      pricingEstimate = estimateRenovationPaintingSplit({ areaSqFt: resolvedArea, paintTier, dampWallPercent });
      assistantReply = {
        bn: `ফ্ল্যাট পেইন্টিং ও ড্যাম্প ট্রিটমেন্ট BOQ প্রস্তুত (${resolvedArea} sft): মোট ৳${pricingEstimate.totalEstimatedBdt.toLocaleString()}।`,
        en: `Apartment Painting & Damp Treatment BOQ ready (${resolvedArea} sq ft): Total ৳${pricingEstimate.totalEstimatedBdt.toLocaleString()}.`
      };
    }

    res.status(200).json({
      status: 'success',
      data: {
        vertical: 'TIER_2_MID',
        tier: 'MID',
        categoryCode,
        extractedSlots: {
          categoryCode,
          thana,
          areaSqft: resolvedArea,
          areaSqFt: resolvedArea,
          paintTier,
          materialMode: 'BOQ_SPLIT_CART',
          emiEligible16Banks: pricingEstimate.totalEstimatedBdt >= 5000
        },
        pricingEstimate,
        assistantReply
      }
    });
  })
);

module.exports = router;
