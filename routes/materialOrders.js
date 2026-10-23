// routes/materialOrders.js — Materials Marketplace Purchase Orders & Delivery Escrow
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const MaterialOrder = require('../models/MaterialOrder');
const { MaterialProduct } = require('../models/MaterialProduct');
const { SupplierProfile } = require('../models/SupplierProfile');
const Project = require('../models/Project');
const EscrowLedger = require('../models/EscrowLedger');
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');
const { runTransaction } = require('../utils/transaction');
const { emitAudit } = require('../services/auditService');
const { verifyToken, requireRole } = require('../middleware/auth');
const { enforceIdempotency } = require('../middleware/idempotency');
const { treasuryFilter } = require('../services/settlementService');
const catchAsync = require('../utils/catchAsync');
const { normalizeBdPhone } = require('../utils/phone');

const router = express.Router();

function bad(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, isOperational: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/materials/orders
// Create a new purchase order / RFQ from verified catalog SKUs
// Access: Private (CLIENT, CONTRACTOR)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/',
  verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR']),
  catchAsync(async (req, res, next) => {
    const buyerUserId = req.user.userId || req.user.id;
    const buyerRole = req.user.role;

    const {
      supplierId,
      items,
      deliveryDetails,
      projectId,
      milestoneIndex,
      boqLineItem,
      plannedBrand,
      plannedQuantity
    } = req.body || {};

    if (!supplierId || !mongoose.isValidObjectId(supplierId)) {
      return next(bad('Valid supplierId is required.'));
    }

    // Optional project & milestone linking validation (WP 1.4)
    let validatedProjectId = null;
    let validatedMilestoneIndex = null;
    let validatedBoqLineItem = '';
    let validatedPlannedBrand = '';
    let validatedPlannedQuantity = null;

    if (projectId) {
      if (!mongoose.isValidObjectId(projectId)) {
        return next(bad('Invalid projectId format.'));
      }
      const project = await Project.findById(projectId).lean();
      if (!project) {
        return next(bad('Project not found.', 404));
      }
      const isClient = project.clientId.toString() === String(buyerUserId);
      const isContractor = project.awardedContractorId && project.awardedContractorId.toString() === String(buyerUserId);
      const isAdmin = req.user.role === 'ADMIN';
      if (!isClient && !isContractor && !isAdmin) {
        return next(bad('Access Denied: You are not a party to this construction project.', 403));
      }
      validatedProjectId = project._id;

      if (milestoneIndex !== undefined && milestoneIndex !== null && milestoneIndex !== '') {
        const mIdx = Number(milestoneIndex);
        if (!Number.isInteger(mIdx) || mIdx < 0) {
          return next(bad('milestoneIndex must be a non-negative integer.'));
        }
        const ledger = await EscrowLedger.findOne({ projectId: project._id }).lean();
        if (ledger && Array.isArray(ledger.milestones) && mIdx >= ledger.milestones.length) {
          return next(bad(`milestoneIndex ${mIdx} is out of bounds for this contract (${ledger.milestones.length} milestones).`));
        }
        validatedMilestoneIndex = mIdx;
      }

      if (boqLineItem && typeof boqLineItem === 'string') {
        validatedBoqLineItem = boqLineItem.trim().slice(0, 100);
      }
      if (plannedBrand && typeof plannedBrand === 'string') {
        validatedPlannedBrand = plannedBrand.trim().slice(0, 100);
      }
      if (plannedQuantity !== undefined && plannedQuantity !== null && plannedQuantity !== '') {
        const pQty = Number(plannedQuantity);
        if (Number.isFinite(pQty) && pQty >= 0) {
          validatedPlannedQuantity = pQty;
        }
      }
    }

    const supplierProfile = await SupplierProfile.findById(supplierId);
    if (!supplierProfile) {
      return next(bad('Supplier profile not found.', 404));
    }

    if (supplierProfile.verification?.status !== 'VERIFIED') {
      return next(bad('Cannot place orders with unverified suppliers.', 403));
    }

    if (!Array.isArray(items) || items.length === 0) {
      return next(bad('Purchase order must contain at least one item.'));
    }

    // Validate delivery details
    if (!deliveryDetails || typeof deliveryDetails !== 'object') {
      return next(bad('Delivery details are required.'));
    }

    const district = typeof deliveryDetails.deliveryDistrict === 'string' ? deliveryDetails.deliveryDistrict.trim() : '';
    const address = typeof deliveryDetails.deliveryAddress === 'string' ? deliveryDetails.deliveryAddress.trim() : '';
    const receiverName = typeof deliveryDetails.receiverName === 'string' ? deliveryDetails.receiverName.trim() : '';
    const rawReceiverPhone = typeof deliveryDetails.receiverPhone === 'string' ? deliveryDetails.receiverPhone.trim() : '';

    if (!district) return next(bad('Delivery district is required.'));
    if (!address || address.length < 5 || address.length > 300) {
      return next(bad('Delivery address must be between 5 and 300 characters.'));
    }
    if (!receiverName || receiverName.length < 2 || receiverName.length > 60) {
      return next(bad('Receiver name must be between 2 and 60 characters.'));
    }

    const normalizedPhone = normalizeBdPhone(rawReceiverPhone);
    if (!normalizedPhone) {
      return next(bad('Receiver phone must be a valid 11-digit Bangladeshi phone number.'));
    }

    // Validate each line item and compute pricing
    const validatedItems = [];
    let itemsSubtotalBDT = 0;
    let totalDeliveryChargeBDT = 0;

    for (const item of items) {
      if (!item.productId || !mongoose.isValidObjectId(item.productId)) {
        return next(bad('Each item must contain a valid productId.'));
      }

      const qty = Number(item.quantity);
      if (!Number.isInteger(qty) || qty < 1) {
        return next(bad('Item quantity must be a positive integer.'));
      }

      const product = await MaterialProduct.findOne({
        _id: item.productId,
        supplierId: supplierProfile._id,
        status: 'ACTIVE'
      });

      if (!product) {
        return next(bad(`Material product ${item.productId} is not available from this supplier.`, 404));
      }

      // Verify district coverage across product and supplier
      const productDistricts = (Array.isArray(product.deliveryTerms?.deliveryDistricts) && product.deliveryTerms.deliveryDistricts.length > 0)
        ? product.deliveryTerms.deliveryDistricts
        : product.deliveryTerms?.supportedDistricts;
      const effectiveDistricts = (Array.isArray(productDistricts) && productDistricts.length > 0)
        ? productDistricts
        : (supplierProfile.serviceDistricts || []);

      if (effectiveDistricts.length > 0 && !effectiveDistricts.includes(district)) {
        return next(bad(`Delivery to district "${district}" is not supported by this supplier.`));
      }

      if (qty < (product.minOrderQuantity || 1)) {
        return next(bad(`Minimum order quantity for "${product.title}" is ${product.minOrderQuantity || 1} ${product.unit}.`));
      }

      if (product.stockQuantity < qty) {
        return next(bad(`Insufficient stock for "${product.title}". Available: ${product.stockQuantity} ${product.unit}.`));
      }

      // Calculate unit price based on bulk volume tiers
      let unitPriceBDT = product.basePriceBDT;
      if (Array.isArray(product.bulkTiers) && product.bulkTiers.length > 0) {
        const sortedDesc = [...product.bulkTiers].sort((a, b) => b.minQuantity - a.minQuantity);
        const matchedTier = sortedDesc.find((t) => qty >= t.minQuantity);
        if (matchedTier) {
          unitPriceBDT = matchedTier.unitPriceBDT;
        }
      }

      let tierDiscountPercent = 0;
      if (unitPriceBDT < product.basePriceBDT) {
        tierDiscountPercent = Math.round(((product.basePriceBDT - unitPriceBDT) / product.basePriceBDT) * 100);
      }

      const lineTotalBDT = qty * unitPriceBDT;
      itemsSubtotalBDT += lineTotalBDT;

      // Delivery charges (supports per-unit and flat deliveryChargeBDT + free delivery thresholds)
      const deliveryChargePerUnit = product.deliveryTerms?.deliveryChargePerUnitBDT || 0;
      const flatDeliveryCharge = product.deliveryTerms?.deliveryChargeBDT || 0;
      const freeMinQty = product.deliveryTerms?.freeDeliveryMinQuantity;
      const freeMinOrderBDT = product.deliveryTerms?.freeDeliveryMinOrderBDT;
      let itemDeliveryCharge = (qty * deliveryChargePerUnit) + flatDeliveryCharge;
      if ((Number.isFinite(freeMinQty) && freeMinQty > 0 && qty >= freeMinQty) ||
          (Number.isFinite(freeMinOrderBDT) && freeMinOrderBDT > 0 && lineTotalBDT >= freeMinOrderBDT)) {
        itemDeliveryCharge = 0;
      }
      totalDeliveryChargeBDT += itemDeliveryCharge;

      validatedItems.push({
        productId: product._id,
        category: product.category,
        brand: product.brand,
        title: product.title,
        unit: product.unit,
        quantity: qty,
        unitPriceBDT,
        totalPriceBDT: lineTotalBDT,
        tierDiscountPercent
      });
    }

    // 2% platform fee on material purchases
    const platformFeeBDT = Math.round(itemsSubtotalBDT * 0.02);
    const totalAmountBDT = itemsSubtotalBDT + totalDeliveryChargeBDT + platformFeeBDT;

    const orderNumber = MaterialOrder.generateOrderNumber();

    const order = await MaterialOrder.create({
      orderNumber,
      buyerUserId,
      buyerRole,
      supplierUserId: supplierProfile.userId,
      supplierId: supplierProfile._id,
      items: validatedItems,
      itemsSubtotalBDT,
      deliveryChargeBDT: totalDeliveryChargeBDT,
      platformFeeBDT,
      totalAmountBDT,
      deliveryDetails: {
        deliveryDistrict: district,
        deliveryAddress: address,
        receiverName,
        receiverPhone: normalizedPhone,
        unloadingRequired: Boolean(deliveryDetails.unloadingRequired),
        siteNotes: typeof (deliveryDetails.siteNotes || deliveryDetails.buyerNotes) === 'string'
          ? (deliveryDetails.siteNotes || deliveryDetails.buyerNotes).trim().slice(0, 500)
          : ''
      },
      projectId: validatedProjectId,
      milestoneIndex: validatedMilestoneIndex,
      boqLineItem: validatedBoqLineItem,
      plannedBrand: validatedPlannedBrand,
      plannedQuantity: validatedPlannedQuantity,
      status: 'PENDING_SUPPLIER_ACCEPTANCE',
      escrowStatus: 'PENDING'
    });

    await AuditLog.create({
      entityId: order._id,
      entityType: 'MATERIAL_ORDER',
      action: 'MATERIAL_ORDER_CREATED',
      actorId: buyerUserId,
      actorRole: buyerRole,
      metadata: {
        orderNumber,
        supplierId: String(supplierProfile._id),
        itemCount: validatedItems.length,
        totalAmountBDT,
        platformFeeBDT,
        deliveryDistrict: district,
        projectId: validatedProjectId ? String(validatedProjectId) : null,
        milestoneIndex: validatedMilestoneIndex
      },
      ipAddress: req.ip
    });

    res.status(201).json({
      status: 'success',
      message: 'Material purchase order placed successfully and sent to supplier for acceptance.',
      data: { order }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/materials/orders
// List user's purchase orders (Buyer view or Supplier view)
// Access: Private (CLIENT, CONTRACTOR, SUPPLIER)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/',
  verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR', 'SUPPLIER']),
  catchAsync(async (req, res) => {
    const userId = req.user.userId || req.user.id;
    const role = req.user.role;

    const query = {};
    if (role === 'SUPPLIER') {
      query.supplierUserId = userId;
    } else {
      query.buyerUserId = userId;
    }

    // Scoped project materials query (WP 1.4)
    if (req.query.projectId && mongoose.isValidObjectId(req.query.projectId)) {
      const project = await Project.findById(req.query.projectId).lean();
      if (project) {
        const isClient = project.clientId.toString() === String(userId);
        const isContractor = project.awardedContractorId && project.awardedContractorId.toString() === String(userId);
        const isAdmin = role === 'ADMIN';
        if (isClient || isContractor || isAdmin) {
          delete query.buyerUserId;
          query.projectId = project._id;
          if (req.query.milestoneIndex !== undefined && req.query.milestoneIndex !== '') {
            const mIdx = Number(req.query.milestoneIndex);
            if (Number.isInteger(mIdx) && mIdx >= 0) {
              query.milestoneIndex = mIdx;
            }
          }
        }
      }
    }

    const requestedStatus = req.query.status === 'DISPATCHED' ? 'IN_TRANSIT' : req.query.status;
    if (requestedStatus && MaterialOrder.ORDER_STATUSES.includes(requestedStatus)) {
      query.status = requestedStatus;
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      MaterialOrder.find(query)
        .populate('supplierId', 'businessName tradeLicenseNumber statistics.trustScore')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      MaterialOrder.countDocuments(query)
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        orders,
        total,
        page,
        limit,
        hasMore: skip + orders.length < total
      }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/materials/orders/project/:projectId/ledger
// Project Materials Transparency Ledger for Homeowners and Contractors
// Access: Private (CLIENT of project, CONTRACTOR awarded, ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/project/:projectId/ledger',
  verifyToken,
  catchAsync(async (req, res, next) => {
    const { projectId } = req.params;
    const userId = String(req.user.userId || req.user.id);
    const userRole = req.user.role;

    if (!mongoose.isValidObjectId(projectId)) {
      return next(bad('Invalid project ID format.', 400));
    }

    const project = await Project.findById(projectId).select('title clientId awardedContractorId budget status').lean();
    if (!project) {
      return next(bad('Project not found.', 404));
    }

    const isClient = String(project.clientId) === userId;
    const isContractor = project.awardedContractorId && String(project.awardedContractorId) === userId;
    const isAdmin = userRole === 'ADMIN';

    if (!isClient && !isContractor && !isAdmin) {
      return next(bad('Access Denied: You are not a party to this project\'s materials ledger.', 403));
    }

    const [ledger, orders] = await Promise.all([
      EscrowLedger.findOne({ projectId: project._id }).select('milestones ledgerStatus totalContractValue').lean(),
      MaterialOrder.find({ projectId: project._id })
        .populate('supplierId', 'companyName businessName tradeLicenseNumber phone serviceDistricts')
        .populate('buyerUserId', 'name role phoneNumber')
        .sort({ milestoneIndex: 1, createdAt: -1 })
        .lean()
    ]);

    // Compute summary metrics
    let totalSpendBDT = 0;
    let deliveredSpendBDT = 0;
    const ordersCount = orders.length;
    let deliveredOrdersCount = 0;
    let variancesCount = 0;

    // Grouping by boqLineItem or category/milestone
    const lineItemMap = new Map();

    for (const order of orders) {
      const isNotCancelled = order.status !== 'CANCELLED' && order.status !== 'REJECTED';
      const isDeliveredOrDone = order.status === 'DELIVERED' || order.status === 'COMPLETED';

      if (isNotCancelled) {
        totalSpendBDT += order.totalAmountBDT || 0;
      }
      if (isDeliveredOrDone) {
        deliveredSpendBDT += order.totalAmountBDT || 0;
        deliveredOrdersCount += 1;
      }

      for (const item of (order.items || [])) {
        const groupKey = order.boqLineItem
          ? `${order.boqLineItem}__${order.milestoneIndex ?? 'all'}`
          : `${item.title}__${item.category}__${order.milestoneIndex ?? 'all'}`;

        if (!lineItemMap.has(groupKey)) {
          let milestoneTitle = '';
          if (ledger && Array.isArray(ledger.milestones) && order.milestoneIndex !== null && order.milestoneIndex !== undefined) {
            milestoneTitle = ledger.milestones[order.milestoneIndex]?.title || `Milestone ${order.milestoneIndex + 1}`;
          }

          lineItemMap.set(groupKey, {
            groupKey,
            boqLineItem: order.boqLineItem || item.title,
            milestoneIndex: order.milestoneIndex ?? null,
            milestoneTitle,
            category: item.category,
            unit: item.unit,
            plannedBrand: order.plannedBrand || '',
            plannedQuantity: order.plannedQuantity ?? null,
            deliveredQuantity: 0,
            inTransitQuantity: 0,
            orderedQuantity: 0,
            totalSpendBDT: 0,
            actualBrands: new Set(),
            orders: [],
            variances: []
          });
        }

        const group = lineItemMap.get(groupKey);
        group.actualBrands.add(item.brand);

        if (isNotCancelled) {
          group.orderedQuantity += item.quantity;
          group.totalSpendBDT += item.totalPriceBDT;
        }
        if (isDeliveredOrDone) {
          group.deliveredQuantity += item.quantity;
        } else if (order.status === 'IN_TRANSIT') {
          group.inTransitQuantity += item.quantity;
        }

        const supplierName = order.supplierId?.businessName || order.supplierId?.companyName || 'Verified Supplier';

        group.orders.push({
          orderId: order._id,
          orderNumber: order.orderNumber,
          status: order.status,
          escrowStatus: order.escrowStatus,
          brand: item.brand,
          title: item.title,
          quantity: item.quantity,
          unit: item.unit,
          unitPriceBDT: item.unitPriceBDT,
          totalPriceBDT: item.totalPriceBDT,
          supplierName,
          carrierName: order.logistics?.carrierName || '',
          challanNumber: order.logistics?.challanNumber || '',
          dispatchedAt: order.logistics?.dispatchedAt || null,
          deliveredAt: order.logistics?.deliveredAt || null,
          siteDeliveryPhotoUrl: order.siteDeliveryPhotoUrl || '',
          challanDocumentUrl: order.logistics?.challanDocumentUrl || '',
          siteDeliveryPhotoTimestamp: order.siteDeliveryPhotoTimestamp || null,
          siteDeliveryPhotoGps: order.siteDeliveryPhotoGps || null,
          bstiLicenseNumber: order.bstiLicenseNumber || '',
          millTestCertUrl: order.millTestCertUrl || '',
          createdAt: order.createdAt
        });
      }
    }

    // Process variance detections for each group
    const items = [];
    for (const group of lineItemMap.values()) {
      group.actualBrands = Array.from(group.actualBrands);

      // Variance 1: Brand difference
      if (group.plannedBrand) {
        const plannedNorm = group.plannedBrand.toLowerCase().trim();
        const brandMismatches = group.actualBrands.filter((b) => b.toLowerCase().trim() !== plannedNorm);
        if (brandMismatches.length > 0) {
          group.variances.push({
            type: 'BRAND_DIFFERENCE',
            severity: 'NEUTRAL_NOTICE',
            code: 'ledger.variance.brandDifference',
            messageEn: `Brand differs from agreed plan (Ordered: ${brandMismatches.join(', ')}, Planned: ${group.plannedBrand})`,
            messageBn: `ব্র্যান্ড পরিকল্পনা থেকে ভিন্ন (অর্ডার: ${brandMismatches.join(', ')}, পরিকল্পনা: ${group.plannedBrand})`,
            planned: group.plannedBrand,
            actual: brandMismatches.join(', ')
          });
        }
      }

      // Variance 2: Quantity exceeding plan
      if (group.plannedQuantity !== null && group.orderedQuantity > group.plannedQuantity) {
        const excess = group.orderedQuantity - group.plannedQuantity;
        group.variances.push({
          type: 'QUANTITY_EXCEEDING',
          severity: 'NEUTRAL_NOTICE',
          code: 'ledger.variance.quantityExceeding',
          messageEn: `Quantity exceeds plan (+${excess} ${group.unit})`,
          messageBn: `পরিমাণ পরিকল্পনার চেয়ে বেশি (+${excess} ${group.unit})`,
          planned: group.plannedQuantity,
          actual: group.orderedQuantity
        });
      }

      // Variance 3: Missing photo for delivered orders
      const deliveredOrdersWithoutPhoto = group.orders.filter((o) => (o.status === 'DELIVERED' || o.status === 'COMPLETED') && !o.siteDeliveryPhotoUrl);
      if (deliveredOrdersWithoutPhoto.length > 0) {
        group.variances.push({
          type: 'MISSING_PHOTO',
          severity: 'NEUTRAL_NOTICE',
          code: 'ledger.variance.missingPhoto',
          messageEn: 'Site delivery photo not recorded for delivered batch',
          messageBn: 'ডেলিভারির সাইট ছবি সংযুক্ত নেই'
        });
      }

      // Variance 4: BSTI license missing on rod/cement
      if (['ROD', 'ROD_REBAR', 'CEMENT'].includes(group.category)) {
        const deliveredOrdersWithoutBsti = group.orders.filter((o) => (o.status === 'DELIVERED' || o.status === 'COMPLETED') && !o.bstiLicenseNumber);
        if (deliveredOrdersWithoutBsti.length > 0) {
          group.variances.push({
            type: 'MISSING_BSTI',
            severity: 'NEUTRAL_NOTICE',
            code: 'ledger.variance.missingBsti',
            messageEn: 'BSTI licence number not provided for delivered batch',
            messageBn: 'বিএসটিআই লাইসেন্স নম্বর উল্লেখ নেই'
          });
        }
      }

      variancesCount += group.variances.length;
      items.push(group);
    }

    res.status(200).json({
      status: 'success',
      data: {
        projectId: project._id,
        projectTitle: project.title,
        summary: {
          totalSpendBDT,
          deliveredSpendBDT,
          ordersCount,
          deliveredOrdersCount,
          variancesCount
        },
        items,
        orders: orders.map((o) => ({
          _id: o._id,
          orderNumber: o.orderNumber,
          status: o.status,
          escrowStatus: o.escrowStatus,
          boqLineItem: o.boqLineItem,
          milestoneIndex: o.milestoneIndex,
          totalAmountBDT: o.totalAmountBDT,
          createdAt: o.createdAt
        })),
        bstiVerificationPortal: 'http://bsti.portal.gov.bd/'
      }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/materials/orders/:id
// Get order details with line items, logistics, and dispute state
// Access: Private (Buyer, Supplier, Admin, Moderator, or Project party)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/:id',
  verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR', 'SUPPLIER', 'ADMIN', 'MODERATOR']),
  catchAsync(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(bad('Invalid order ID.', 400));
    }

    const order = await MaterialOrder.findById(req.params.id)
      .populate('supplierId', 'businessName tradeLicenseNumber serviceDistricts statistics')
      .populate('buyerUserId', 'phoneNumber role')
      .lean();

    if (!order) {
      return next(bad('Material purchase order not found.', 404));
    }

    const userId = String(req.user.userId || req.user.id);
    const role = req.user.role;
    const isOwner = String(order.buyerUserId?._id || order.buyerUserId) === userId;
    const isSupplier = String(order.supplierUserId) === userId;
    const isPrivileged = ['ADMIN', 'MODERATOR'].includes(role);

    let isProjectParty = false;
    if (order.projectId) {
      const project = await Project.findById(order.projectId).select('clientId awardedContractorId').lean();
      if (project) {
        if (String(project.clientId) === userId || (project.awardedContractorId && String(project.awardedContractorId) === userId)) {
          isProjectParty = true;
        }
      }
    }

    if (!isOwner && !isSupplier && !isPrivileged && !isProjectParty) {
      return next(bad('Unauthorized: You do not have permission to view this order.', 403));
    }

    res.status(200).json({
      status: 'success',
      data: { order }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/materials/orders/:id/accept
// Supplier accepts the purchase order
// Access: Private (SUPPLIER - owner only)
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/:id/accept',
  verifyToken,
  requireRole(['SUPPLIER']),
  catchAsync(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(bad('Invalid order ID.', 400));
    }

    const userId = req.user.userId || req.user.id;
    const order = await MaterialOrder.findById(req.params.id);

    if (!order) return next(bad('Material order not found.', 404));
    if (String(order.supplierUserId) !== String(userId)) {
      return next(bad('Unauthorized: Only the assigned supplier can accept this order.', 403));
    }

    if (order.status !== 'PENDING_SUPPLIER_ACCEPTANCE') {
      return next(bad(`Order cannot be accepted in its current status: ${order.status}`));
    }

    order.status = 'ACCEPTED';
    await order.save();

    await AuditLog.create({
      entityId: order._id,
      entityType: 'MATERIAL_ORDER',
      action: 'MATERIAL_ORDER_ACCEPTED',
      actorId: userId,
      actorRole: 'SUPPLIER',
      metadata: { orderNumber: order.orderNumber },
      ipAddress: req.ip
    });

    res.status(200).json({
      status: 'success',
      message: 'Material order accepted. Awaiting buyer escrow funding.',
      data: { order }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/materials/orders/:id/reject
// Supplier rejects the purchase order with justification
// Access: Private (SUPPLIER - owner only)
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/:id/reject',
  verifyToken,
  requireRole(['SUPPLIER']),
  catchAsync(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(bad('Invalid order ID.', 400));
    }

    const userId = req.user.userId || req.user.id;
    const order = await MaterialOrder.findById(req.params.id);

    if (!order) return next(bad('Material order not found.', 404));
    if (String(order.supplierUserId) !== String(userId)) {
      return next(bad('Unauthorized: Only the assigned supplier can reject this order.', 403));
    }

    if (order.status !== 'PENDING_SUPPLIER_ACCEPTANCE') {
      return next(bad(`Order cannot be rejected in its current status: ${order.status}`));
    }

    const { rejectionReason } = req.body || {};
    if (!rejectionReason || typeof rejectionReason !== 'string' || rejectionReason.trim().length < 5) {
      return next(bad('A valid rejection reason (minimum 5 characters) is required.'));
    }

    order.status = 'REJECTED';
    order.rejectionReason = rejectionReason.trim();
    await order.save();

    await AuditLog.create({
      entityId: order._id,
      entityType: 'MATERIAL_ORDER',
      action: 'MATERIAL_ORDER_REJECTED',
      actorId: userId,
      actorRole: 'SUPPLIER',
      metadata: { orderNumber: order.orderNumber, rejectionReason: order.rejectionReason },
      ipAddress: req.ip
    });

    res.status(200).json({
      status: 'success',
      message: 'Material order rejected.',
      data: { order }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/materials/orders/:id/fund-escrow
// Buyer pre-funds 100% escrow for the order before dispatch
// Access: Private (Buyer - CLIENT, CONTRACTOR)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:id/fund-escrow',
  verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR']),
  enforceIdempotency,
  catchAsync(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(bad('Invalid order ID.', 400));
    }

    const userId = req.user.userId || req.user.id;

    let updatedOrder = null;
    await runTransaction(async (session) => {
      const order = await MaterialOrder.findById(req.params.id).session(session);

      if (!order) throw bad('Material order not found.', 404);
      if (String(order.buyerUserId) !== String(userId)) {
        throw bad('Unauthorized: Only the buyer can fund escrow for this order.', 403);
      }

      if (order.status !== 'ACCEPTED') {
        throw bad(`Order must be ACCEPTED by supplier before escrow funding. Current status: ${order.status}`);
      }

      // Atomically decrement stock from active SKUs with strict verification
      for (const item of order.items) {
        const stockUpdate = await MaterialProduct.updateOne(
          { _id: item.productId, stockQuantity: { $gte: item.quantity } },
          { $inc: { stockQuantity: -item.quantity } },
          { session }
        );
        if (stockUpdate.modifiedCount !== 1) {
          throw Object.assign(new Error(`Insufficient stock for product ${item.title || item.productId}. Escrow funding aborted.`), { statusCode: 409, isOperational: true });
        }
      }

      order.status = 'ESCROW_FUNDED';
      order.escrowStatus = 'FUNDED';
      await order.save({ session });

      await emitAudit({
        session,
        entityId: order._id,
        entityType: 'MATERIAL_ORDER',
        action: 'MATERIAL_ORDER_ESCROW_FUNDED',
        actorId: userId,
        actorRole: req.user.role,
        metadata: {
          orderNumber: order.orderNumber,
          fundedAmountBDT: order.totalAmountBDT
        },
        ipAddress: req.ip || '127.0.0.1'
      });
      updatedOrder = order;
    });

    res.status(200).json({
      status: 'success',
      message: 'Order 100% pre-funded into escrow. Supplier notified to dispatch shipment.',
      data: { order: updatedOrder }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/materials/orders/:id/dispatch
// Supplier dispatches shipment with challan / waybill details
// Access: Private (SUPPLIER - owner only)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:id/dispatch',
  verifyToken,
  requireRole(['SUPPLIER']),
  catchAsync(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(bad('Invalid order ID.', 400));
    }

    const userId = req.user.userId || req.user.id;
    const order = await MaterialOrder.findById(req.params.id);

    if (!order) return next(bad('Material order not found.', 404));
    if (String(order.supplierUserId) !== String(userId)) {
      return next(bad('Unauthorized: Only the assigned supplier can dispatch this order.', 403));
    }

    if (order.status !== 'ESCROW_FUNDED') {
      return next(bad(`Shipment cannot be dispatched before escrow is funded. Current status: ${order.status}`));
    }

    const carrierName = typeof req.body.carrierName === 'string' ? req.body.carrierName.trim() : '';
    const challanNumber = typeof req.body.challanNumber === 'string' ? req.body.challanNumber.trim() : '';
    const vehicleNumber = typeof (req.body.vehicleNumber || req.body.truckNumber) === 'string'
      ? (req.body.vehicleNumber || req.body.truckNumber).trim()
      : '';
    const driverPhone = typeof req.body.driverPhone === 'string' ? req.body.driverPhone.trim() : '';

    if (!challanNumber || challanNumber.length < 3) {
      return next(bad('Valid challan number is required (min 3 characters).'));
    }

    order.status = 'IN_TRANSIT';
    order.logistics.carrierName = carrierName;
    order.logistics.challanNumber = challanNumber;
    order.logistics.vehicleNumber = vehicleNumber;
    order.logistics.driverPhone = driverPhone;
    order.logistics.dispatchedAt = new Date();
    await order.save();

    await AuditLog.create({
      entityId: order._id,
      entityType: 'MATERIAL_ORDER',
      action: 'MATERIAL_ORDER_DISPATCHED',
      actorId: userId,
      actorRole: 'SUPPLIER',
      metadata: {
        orderNumber: order.orderNumber,
        challanNumber: order.logistics.challanNumber,
        vehicleNumber: order.logistics.vehicleNumber
      },
      ipAddress: req.ip
    });

    res.status(200).json({
      status: 'success',
      message: 'Shipment dispatched and marked IN_TRANSIT with delivery waybill details.',
      data: { order }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/materials/orders/:id/mark-delivered
// Supplier marks shipment arrived at site with delivery slip
// Access: Private (SUPPLIER - owner only)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:id/mark-delivered',
  verifyToken,
  requireRole(['SUPPLIER']),
  catchAsync(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(bad('Invalid order ID.', 400));
    }

    const userId = req.user.userId || req.user.id;
    const order = await MaterialOrder.findById(req.params.id);

    if (!order) return next(bad('Material order not found.', 404));
    if (String(order.supplierUserId) !== String(userId)) {
      return next(bad('Unauthorized: Only the assigned supplier can update delivery status.', 403));
    }

    if (order.status !== 'IN_TRANSIT') {
      return next(bad(`Order must be IN_TRANSIT to mark delivered. Current status: ${order.status}`));
    }

    const {
      weightSlipUrl,
      challanDocumentUrl,
      deliveryProofNotes,
      siteDeliveryPhotoUrl,
      siteDeliveryPhotoTimestamp,
      siteDeliveryPhotoGps,
      bstiLicenseNumber,
      millTestCertUrl
    } = req.body || {};

    order.status = 'DELIVERED';
    order.logistics.deliveredAt = new Date();
    if (weightSlipUrl) order.logistics.weightSlipUrl = String(weightSlipUrl).trim();
    if (challanDocumentUrl) order.logistics.challanDocumentUrl = String(challanDocumentUrl).trim();
    if (deliveryProofNotes) order.logistics.deliveryProofNotes = String(deliveryProofNotes).trim().slice(0, 500);

    if (siteDeliveryPhotoUrl) order.siteDeliveryPhotoUrl = String(siteDeliveryPhotoUrl).trim();
    if (siteDeliveryPhotoTimestamp) {
      const d = new Date(siteDeliveryPhotoTimestamp);
      if (!isNaN(d.getTime())) order.siteDeliveryPhotoTimestamp = d;
    } else if (siteDeliveryPhotoUrl) {
      order.siteDeliveryPhotoTimestamp = new Date();
    }
    if (siteDeliveryPhotoGps && typeof siteDeliveryPhotoGps === 'object') {
      const lat = Number(siteDeliveryPhotoGps.latitude);
      const lng = Number(siteDeliveryPhotoGps.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        order.siteDeliveryPhotoGps = { latitude: lat, longitude: lng };
      }
    }
    if (bstiLicenseNumber) order.bstiLicenseNumber = String(bstiLicenseNumber).trim();
    if (millTestCertUrl) order.millTestCertUrl = String(millTestCertUrl).trim();

    await order.save();

    await AuditLog.create({
      entityId: order._id,
      entityType: 'MATERIAL_ORDER',
      action: 'MATERIAL_ORDER_DELIVERED',
      actorId: userId,
      actorRole: 'SUPPLIER',
      metadata: { orderNumber: order.orderNumber },
      ipAddress: req.ip
    });

    res.status(200).json({
      status: 'success',
      message: 'Order marked as DELIVERED at site. Awaiting buyer quality inspection and sign-off.',
      data: { order }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/materials/orders/:id/confirm-delivery
// Buyer inspects materials and approves delivery release
// Access: Private (Buyer - CLIENT, CONTRACTOR)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:id/confirm-delivery',
  verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR']),
  enforceIdempotency,
  catchAsync(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(bad('Invalid order ID.', 400));
    }

    const userId = req.user.userId || req.user.id;

    let updatedOrder = null;
    await runTransaction(async (session) => {
      const order = await MaterialOrder.findById(req.params.id).session(session);

      if (!order) throw bad('Material order not found.', 404);
      if (String(order.buyerUserId) !== String(userId)) {
        throw bad('Unauthorized: Only the buyer can confirm delivery and release funds.', 403);
      }

      if (!['IN_TRANSIT', 'DELIVERED'].includes(order.status)) {
        throw bad(`Delivery cannot be confirmed in current status: ${order.status}`);
      }

      order.status = 'COMPLETED';
      order.escrowStatus = 'RELEASED';
      await order.save({ session });

      // Increment supplier completed transactions count
      const supplierProfile = await SupplierProfile.findByIdAndUpdate(
        order.supplierId,
        { $inc: { 'statistics.totalOrdersFulfilled': 1 } },
        { session, new: true }
      );

      // Atomically credit supplier's withdrawable wallet
      const netSupplierPayoutBDT = order.totalAmountBDT - (order.platformFeeBDT || 0);
      const supplierUserId = supplierProfile?.userId || order.supplierUserId;
      if (supplierUserId) {
        await User.findByIdAndUpdate(
          supplierUserId,
          { $inc: { 'wallet.availableToWithdraw': netSupplierPayoutBDT } },
          { session }
        );
      }

      // Atomically credit 2% platform fee to platform treasury
      if (order.platformFeeBDT && order.platformFeeBDT > 0) {
        await User.findOneAndUpdate(
          treasuryFilter(),
          { $inc: { 'wallet.availableToWithdraw': order.platformFeeBDT } },
          { session }
        );
      }

      await emitAudit({
        session,
        entityId: order._id,
        entityType: 'MATERIAL_ORDER',
        action: 'MATERIAL_ORDER_COMPLETED',
        actorId: userId,
        actorRole: req.user.role,
        metadata: {
          orderNumber: order.orderNumber,
          releasedAmountBDT: netSupplierPayoutBDT,
          platformFeeBDT: order.platformFeeBDT
        },
        ipAddress: req.ip || '127.0.0.1'
      });
      updatedOrder = order;
    });

    res.status(200).json({
      status: 'success',
      message: 'Delivery confirmed and escrow funds released to supplier.',
      data: { order: updatedOrder }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/materials/orders/:id/dispute
// Open dispute on delivery quality, underweight rebar, or broken bags
// Access: Private (Buyer or Supplier)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:id/dispute',
  verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR', 'SUPPLIER']),
  catchAsync(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(bad('Invalid order ID.', 400));
    }

    const userId = req.user.userId || req.user.id;
    const order = await MaterialOrder.findById(req.params.id);

    if (!order) return next(bad('Material order not found.', 404));

    const isBuyer = String(order.buyerUserId) === String(userId);
    const isSupplier = String(order.supplierUserId) === String(userId);
    if (!isBuyer && !isSupplier) {
      return next(bad('Unauthorized: Only order participants can open a dispute.', 403));
    }

    if (!['ESCROW_FUNDED', 'IN_TRANSIT', 'DELIVERED'].includes(order.status)) {
      return next(bad(`Order cannot be disputed in status: ${order.status}`));
    }

    const { reason } = req.body || {};
    if (!reason || typeof reason !== 'string' || reason.trim().length < 10) {
      return next(bad('A detailed dispute reason (minimum 10 characters) is required.'));
    }

    order.status = 'DISPUTED';
    order.escrowStatus = 'FROZEN';
    order.disputeDetails = {
      reason: reason.trim(),
      raisedBy: userId,
      raisedAt: new Date(),
      status: 'OPEN'
    };
    await order.save();

    await AuditLog.create({
      entityId: order._id,
      entityType: 'MATERIAL_ORDER',
      action: 'MATERIAL_ORDER_DISPUTED',
      actorId: userId,
      actorRole: req.user.role,
      metadata: {
        orderNumber: order.orderNumber,
        disputeReason: order.disputeDetails.reason
      },
      ipAddress: req.ip
    });

    res.status(200).json({
      status: 'success',
      message: 'Dispute opened and escrow funds frozen pending moderation review.',
      data: { order }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/materials/orders/:id/resolve-dispute
// Moderation arbitration of frozen material order disputes
// Access: Private (Staff: ADMIN, MODERATOR)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/:id/resolve-dispute',
  verifyToken,
  requireRole(['ADMIN', 'MODERATOR']),
  enforceIdempotency,
  catchAsync(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(bad('Invalid order ID.', 400));
    }

    const { resolution, notes } = req.body || {};
    if (!['REFUND_BUYER', 'RELEASE_SUPPLIER'].includes(resolution)) {
      return next(bad("resolution must be 'REFUND_BUYER' or 'RELEASE_SUPPLIER'."));
    }

    const staffId = req.user.userId || req.user.id;
    let resolvedOrder = null;

    await runTransaction(async (session) => {
      const order = await MaterialOrder.findById(req.params.id).session(session);
      if (!order) throw bad('Material order not found.', 404);

      if (order.status !== 'DISPUTED' || order.escrowStatus !== 'FROZEN') {
        throw bad(`Order is not in DISPUTED/FROZEN state (current status: ${order.status}, escrow: ${order.escrowStatus}).`, 409);
      }

      if (resolution === 'REFUND_BUYER') {
        order.status = 'CANCELLED';
        order.escrowStatus = 'REFUNDED';
        order.disputeDetails = order.disputeDetails || {};
        order.disputeDetails.status = 'RESOLVED_REFUNDED_TO_BUYER';
        order.disputeDetails.resolvedAt = new Date();
        order.disputeDetails.resolvedBy = staffId;
        order.disputeDetails.resolutionNotes = String(notes || '').trim();

        // Credit 100% back to buyer's wallet
        await User.findByIdAndUpdate(
          order.buyerUserId,
          { $inc: { 'wallet.availableToWithdraw': order.totalAmountBDT } },
          { session }
        );
      } else {
        // RELEASE_SUPPLIER
        order.status = 'COMPLETED';
        order.escrowStatus = 'RELEASED';
        order.disputeDetails = order.disputeDetails || {};
        order.disputeDetails.status = 'RESOLVED_RELEASED_TO_SUPPLIER';
        order.disputeDetails.resolvedAt = new Date();
        order.disputeDetails.resolvedBy = staffId;
        order.disputeDetails.resolutionNotes = String(notes || '').trim();

        const netPayout = order.totalAmountBDT - (order.platformFeeBDT || 0);
        await User.findByIdAndUpdate(
          order.supplierUserId,
          { $inc: { 'wallet.availableToWithdraw': netPayout } },
          { session }
        );

        if (order.platformFeeBDT && order.platformFeeBDT > 0) {
          await User.findOneAndUpdate(
            treasuryFilter(),
            { $inc: { 'wallet.availableToWithdraw': order.platformFeeBDT } },
            { session }
          );
        }

        await SupplierProfile.findByIdAndUpdate(
          order.supplierId,
          { $inc: { 'statistics.totalOrdersFulfilled': 1 } },
          { session }
        );
      }

      await order.save({ session });

      await emitAudit({
        session,
        entityId: order._id,
        entityType: 'MATERIAL_ORDER',
        action: 'MATERIAL_ORDER_DISPUTE_RESOLVED',
        actorId: staffId,
        actorRole: req.user.role,
        metadata: {
          orderNumber: order.orderNumber,
          resolution,
          refundedOrReleasedAmountBDT: order.totalAmountBDT,
          notes: order.disputeDetails.resolutionNotes
        },
        ipAddress: req.ip || '127.0.0.1'
      });

      resolvedOrder = order;
    });

    res.status(200).json({
      status: 'success',
      message: `Dispute successfully resolved with outcome: ${resolution}.`,
      data: { order: resolvedOrder }
    });
  })
);

module.exports = router;
