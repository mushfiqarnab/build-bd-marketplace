// routes/projectMaterials.js
// 🧱 Phase 3: Project Material Transparency Ledger
// Reconciles planned material orders against delivered chalan and site evidence.
// Integrates with ProjectShareToken delegation, EXIF facts, and gentle variance flags.
'use strict';

const express = require('express');
const router = express.Router({ mergeParams: true });
const mongoose = require('mongoose');
const { verifyToken, requireRole, allowRoleOrScopedToken } = require('../middleware/auth');
const { enforceIdempotency } = require('../middleware/idempotency');
const catchAsync = require('../utils/catchAsync');
const Project = require('../models/Project');
const MaterialDeliveryLog = require('../models/MaterialDeliveryLog');
const { runTransaction } = require('../utils/transaction');
const { emitAudit } = require('../services/auditService');
const { notifyMaterialVariance } = require('../services/notificationService');

function operational(message, statusCode) {
  return Object.assign(new Error(message), { statusCode, isOperational: true });
}

// Helper to check caller authorization for this project
async function getAuthorizedProject(projectId, req) {
  if (!mongoose.Types.ObjectId.isValid(projectId)) {
    throw operational('Invalid project ID format.', 400);
  }
  const project = await Project.findById(projectId).lean();
  if (!project) {
    throw operational('Project not found.', 404);
  }

  // Delegate token check
  if (req.user && req.user.isDelegate) {
    if (req.user.projectId !== String(project._id)) {
      throw operational('Delegation token not authorized for this project.', 403);
    }
    return project;
  }

  // Direct user check
  const userIdStr = String(req.user.userId || req.user._id);
  const isOwner = String(project.clientId) === userIdStr;
  const isAwardedContractor = project.awardedContractorId && String(project.awardedContractorId) === userIdStr;
  const isStaff = ['ADMIN', 'MODERATOR'].includes(req.user.role);

  if (!isOwner && !isAwardedContractor && !isStaff) {
    throw operational('You do not have authorization to access material records for this project.', 403);
  }

  return project;
}

// ── GET /api/projects/:id/materials ──────────────────────────────────────────
// Returns project planned materials alongside delivery logs, variance flags, and totals.
router.get('/',
  verifyToken,
  allowRoleOrScopedToken(['CLIENT', 'CONTRACTOR', 'ADMIN'], ['FAMILY_VIEWER', 'SITE_WATCHER']),
  catchAsync(async (req, res) => {
    const projectId = req.params.id;
    const project = await getAuthorizedProject(projectId, req);

    const query = { projectId };
    if (req.query.milestoneId && mongoose.Types.ObjectId.isValid(req.query.milestoneId)) {
      query.milestoneId = req.query.milestoneId;
    }
    if (req.query.flaggedOnly === 'true') {
      query['informationalFlags.0'] = { $exists: true };
    }

    const deliveries = await MaterialDeliveryLog.find(query).sort({ createdAt: -1 }).lean();

    const hideFinancials = !!(req.user && req.user.hideFinancials);

    // Compute planned vs delivered reconciliation summary
    let totalPlannedCost = 0;
    let totalActualCost = 0;
    let totalFlagsCount = 0;
    let unacknowledgedFlagsCount = 0;

    const sanitizedDeliveries = deliveries.map((d) => {
      const flags = d.informationalFlags || [];
      totalFlagsCount += flags.length;
      unacknowledgedFlagsCount += flags.filter((f) => !f.acknowledgedByClientAt).length;

      if (!hideFinancials) {
        totalPlannedCost += Number(d.plannedSpec?.estimatedUnitPrice || 0) * Number(d.plannedSpec?.plannedQty || 0);
        totalActualCost += Number(d.actualSpec?.totalActualCost || 0);
      }

      if (hideFinancials) {
        return {
          ...d,
          plannedSpec: d.plannedSpec ? {
            brand: d.plannedSpec.brand,
            gradeSpec: d.plannedSpec.gradeSpec,
            unit: d.plannedSpec.unit,
            plannedQty: d.plannedSpec.plannedQty,
            estimatedUnitPrice: undefined
          } : undefined,
          actualSpec: d.actualSpec ? {
            brand: d.actualSpec.brand,
            gradeSpec: d.actualSpec.gradeSpec,
            unit: d.actualSpec.unit,
            actualQty: d.actualSpec.actualQty,
            actualUnitPrice: undefined,
            totalActualCost: undefined
          } : undefined
        };
      }
      return d;
    });

    res.status(200).json({
      success: true,
      projectId: String(project._id),
      projectTitle: project.title,
      hideFinancials,
      summary: {
        totalDeliveries: deliveries.length,
        totalFlags: totalFlagsCount,
        unacknowledgedFlags: unacknowledgedFlagsCount,
        totalPlannedCost: hideFinancials ? null : Math.round(totalPlannedCost),
        totalActualCost: hideFinancials ? null : Math.round(totalActualCost),
        costVariance: hideFinancials ? null : Math.round(totalActualCost - totalPlannedCost)
      },
      deliveries: sanitizedDeliveries
    });
  })
);

// ── POST /api/projects/:id/materials/deliveries ──────────────────────────────
// Records a material delivery log with chalan & site evidence, computes flags deterministically.
router.post('/deliveries',
  verifyToken,
  allowRoleOrScopedToken(['CLIENT', 'CONTRACTOR', 'ADMIN'], ['SITE_WATCHER']),
  enforceIdempotency,
  catchAsync(async (req, res) => {
    const projectId = req.params.id;
    const project = await getAuthorizedProject(projectId, req);

    // Block FAMILY_VIEWER from writing (SITE_WATCHER allowed)
    if (req.user && req.user.role === 'FAMILY_VIEWER') {
      throw operational('Family viewers have read-only access and cannot record deliveries.', 403);
    }

    const {
      milestoneId,
      plannedItemIndex,
      category,
      itemName,
      plannedSpec = {},
      actualSpec = {},
      truckDimensions = {},
      supplierInfo = {},
      evidence = {}
    } = req.body;

    if (!category || typeof category !== 'string' || !category.trim()) {
      throw operational('Material category is required.', 400);
    }
    if (!itemName || typeof itemName !== 'string' || !itemName.trim()) {
      throw operational('Material item name is required.', 400);
    }

    // Deterministic truck CFT dimension calculation
    const lengthFt = Math.max(0, Number(truckDimensions.lengthFt) || 0);
    const widthFt = Math.max(0, Number(truckDimensions.widthFt) || 0);
    const heightFt = Math.max(0, Number(truckDimensions.heightFt) || 0);
    let calculatedCft = 0;
    if (lengthFt > 0 && widthFt > 0 && heightFt > 0) {
      calculatedCft = Math.round(lengthFt * widthFt * heightFt * 100) / 100;
    }

    // Normalize actualSpec quantities & integer Taka math
    const unit = String(actualSpec.unit || plannedSpec.unit || 'unit').trim();
    let actualQty = Math.max(0, Number(actualSpec.actualQty) || 0);
    if (unit.toUpperCase() === 'CFT' && actualQty === 0 && calculatedCft > 0) {
      actualQty = calculatedCft;
    }
    const actualUnitPrice = Math.max(0, Math.round(Number(actualSpec.actualUnitPrice) || 0));
    const totalActualCost = Math.max(0, Math.round(actualQty * actualUnitPrice));

    const normalizedActualSpec = {
      brand: String(actualSpec.brand || '').trim(),
      gradeSpec: String(actualSpec.gradeSpec || '').trim(),
      unit,
      actualQty,
      actualUnitPrice,
      totalActualCost
    };

    const normalizedPlannedSpec = {
      brand: String(plannedSpec.brand || '').trim(),
      gradeSpec: String(plannedSpec.gradeSpec || '').trim(),
      unit: String(plannedSpec.unit || unit).trim(),
      plannedQty: Math.max(0, Number(plannedSpec.plannedQty) || 0),
      estimatedUnitPrice: Math.max(0, Math.round(Number(plannedSpec.estimatedUnitPrice) || 0))
    };

    // Deterministic gentle informational flags computation
    const informationalFlags = [];

    // 1. BRAND_DIFF
    if (normalizedPlannedSpec.brand && normalizedActualSpec.brand &&
        normalizedPlannedSpec.brand.toLowerCase() !== normalizedActualSpec.brand.toLowerCase()) {
      informationalFlags.push({
        flagType: 'BRAND_DIFF',
        plannedValue: normalizedPlannedSpec.brand,
        actualValue: normalizedActualSpec.brand
      });
    }

    // 2. QUANTITY_DIFF
    if (normalizedPlannedSpec.plannedQty > 0 && normalizedActualSpec.actualQty !== normalizedPlannedSpec.plannedQty) {
      informationalFlags.push({
        flagType: 'QUANTITY_DIFF',
        plannedValue: String(normalizedPlannedSpec.plannedQty),
        actualValue: String(normalizedActualSpec.actualQty)
      });
    }

    // 3. GRADE_DIFF
    if (normalizedPlannedSpec.gradeSpec && normalizedActualSpec.gradeSpec &&
        normalizedPlannedSpec.gradeSpec.toLowerCase() !== normalizedActualSpec.gradeSpec.toLowerCase()) {
      informationalFlags.push({
        flagType: 'GRADE_DIFF',
        plannedValue: normalizedPlannedSpec.gradeSpec,
        actualValue: normalizedActualSpec.gradeSpec
      });
    }

    // 4. PRICE_DIFF
    if (normalizedPlannedSpec.estimatedUnitPrice > 0 && normalizedActualSpec.actualUnitPrice > normalizedPlannedSpec.estimatedUnitPrice) {
      informationalFlags.push({
        flagType: 'PRICE_DIFF',
        plannedValue: String(normalizedPlannedSpec.estimatedUnitPrice),
        actualValue: String(normalizedActualSpec.actualUnitPrice)
      });
    }

    let createdLog = null;
    await runTransaction(async (session) => {
      const doc = new MaterialDeliveryLog({
        projectId: project._id,
        milestoneId: milestoneId && mongoose.Types.ObjectId.isValid(milestoneId) ? milestoneId : null,
        plannedItemIndex: Number.isInteger(Number(plannedItemIndex)) ? Number(plannedItemIndex) : null,
        loggedByUserId: req.user.isDelegate ? null : req.user.userId,
        loggedByShareTokenId: req.user.isDelegate && req.share ? req.share._id : null,
        category: category.trim(),
        itemName: itemName.trim(),
        plannedSpec: normalizedPlannedSpec,
        actualSpec: normalizedActualSpec,
        truckDimensions: {
          lengthFt,
          widthFt,
          heightFt,
          calculatedCft
        },
        supplierInfo: {
          dealerName: String(supplierInfo.dealerName || '').trim(),
          dealerPhone: String(supplierInfo.dealerPhone || '').trim(),
          chalanNo: String(supplierInfo.chalanNo || '').trim(),
          bstiLicenseNo: String(supplierInfo.bstiLicenseNo || '').trim()
        },
        evidence: {
          chalanEvidenceId: evidence.chalanEvidenceId && mongoose.Types.ObjectId.isValid(evidence.chalanEvidenceId) ? evidence.chalanEvidenceId : null,
          siteMaterialEvidenceId: evidence.siteMaterialEvidenceId && mongoose.Types.ObjectId.isValid(evidence.siteMaterialEvidenceId) ? evidence.siteMaterialEvidenceId : null,
          chalanPhotoUrl: String(evidence.chalanPhotoUrl || '').trim(),
          siteDeliveryPhotoUrl: String(evidence.siteDeliveryPhotoUrl || '').trim(),
          exifVerified: !!evidence.exifVerified,
          gpsLat: typeof evidence.gpsLat === 'number' ? evidence.gpsLat : null,
          gpsLng: typeof evidence.gpsLng === 'number' ? evidence.gpsLng : null,
          capturedAt: evidence.capturedAt ? new Date(evidence.capturedAt) : new Date()
        },
        informationalFlags
      });

      await doc.save({ session });
      createdLog = doc.toObject();

      await emitAudit({
        entityId: doc._id,
        entityType: 'MATERIAL_DELIVERY_LOG',
        action: 'MATERIAL_DELIVERY_LOGGED',
        actorId: req.user.isDelegate ? req.share._id : req.user.userId,
        actorRole: req.user.role,
        metadata: {
          projectId: String(project._id),
          category: doc.category,
          itemName: doc.itemName,
          flagsCount: informationalFlags.length,
          flags: informationalFlags.map((f) => f.flagType)
        },
        session
      });
    });

    if (informationalFlags.length > 0) {
      const io = req.app.get('io');
      if (io) {
        io.to(String(project._id)).emit('material_variance_flagged', {
          projectId: String(project._id),
          deliveryId: createdLog._id,
          category: createdLog.category,
          itemName: createdLog.itemName,
          flags: informationalFlags
        });
      }
      notifyMaterialVariance({
        clientId: project.clientId,
        projectId: project._id,
        flags: informationalFlags.map((f) => f.flagType),
        io
      }).catch(() => {});
    }

    res.status(201).json({
      success: true,
      delivery: createdLog
    });
  })
);

// ── PATCH /api/projects/:id/materials/deliveries/:logId/acknowledge ──────────
// Marks gentle variance flags acknowledged by client owner.
router.patch('/deliveries/:logId/acknowledge',
  verifyToken,
  requireRole(['CLIENT']),
  enforceIdempotency,
  catchAsync(async (req, res) => {
    const { id: projectId, logId } = req.params;
    const project = await getAuthorizedProject(projectId, req);

    if (String(project.clientId) !== String(req.user.userId || req.user._id)) {
      throw operational('Only the project owner can acknowledge material variance flags.', 403);
    }

    if (!mongoose.Types.ObjectId.isValid(logId)) {
      throw operational('Invalid delivery log ID.', 400);
    }

    let updatedLog = null;
    await runTransaction(async (session) => {
      const log = await MaterialDeliveryLog.findOne({
        _id: logId,
        projectId: project._id
      }).session(session);

      if (!log) {
        throw operational('Material delivery record not found for this project.', 404);
      }

      const now = new Date();
      for (const flag of log.informationalFlags) {
        if (!flag.acknowledgedByClientAt) {
          flag.acknowledgedByClientAt = now;
        }
      }

      await log.save({ session });
      updatedLog = log.toObject();

      await emitAudit({
        entityId: log._id,
        entityType: 'MATERIAL_DELIVERY_LOG',
        action: 'MATERIAL_DELIVERY_ACKNOWLEDGED',
        actorId: req.user.userId,
        actorRole: req.user.role,
        metadata: {
          projectId: String(project._id),
          acknowledgedCount: log.informationalFlags.length
        },
        session
      });
    });

    res.status(200).json({
      success: true,
      delivery: updatedLog
    });
  })
);

module.exports = router;
