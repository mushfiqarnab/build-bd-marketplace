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
const { computeMicroSettlementSplit, interpretUserUtterance } = require('../services/aiOrchestratorService');
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

    const project = await runTransaction(async (session) => {
      const doc = new Project({
        clientId: req.user.userId,
        title: `Micro Utility: ${categoryCode} in ${thana.trim()}`,
        description: description ? String(description).trim() : `Micro Utility Emergency Dispatch (${categoryCode}, Floor ${floor})`,
        category: 'Renovation',
        location: thana.trim(),
        budget: Math.max(1000, settlementSplit.grossTotalBdt),
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
    const { categoryCode = 'MID_PAINTING', areaSqft = 1800, thana = 'Dhaka' } = req.body || {};

    const utterance = categoryCode === 'MID_SHIFTING'
      ? `${thana} বাসা বদল শিফটিং`
      : `${thana} ${areaSqft} স্কয়ার ফিট ফ্ল্যাট পেইন্টিং`;

    const plan = interpretUserUtterance(utterance);

    res.status(200).json({
      status: 'success',
      data: {
        vertical: plan.vertical,
        tier: plan.tier,
        categoryCode,
        extractedSlots: plan.extractedSlots,
        pricingEstimate: plan.pricingEstimate,
        assistantReply: plan.assistantReply
      }
    });
  })
);

module.exports = router;
