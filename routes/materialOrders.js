// routes/materialOrders.js — Materials Marketplace Purchase Orders & Delivery Escrow
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const MaterialOrder = require('../models/MaterialOrder');
const { MaterialProduct } = require('../models/MaterialProduct');
const { SupplierProfile } = require('../models/SupplierProfile');
const AuditLog = require('../models/AuditLog');
const { verifyToken, requireRole } = require('../middleware/auth');
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
      deliveryDetails
    } = req.body || {};

    if (!supplierId || !mongoose.isValidObjectId(supplierId)) {
      return next(bad('Valid supplierId is required.'));
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
      const productDistricts = product.deliveryTerms?.deliveryDistricts || product.deliveryTerms?.supportedDistricts;
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

      // Delivery charges
      const deliveryChargePerUnit = product.deliveryTerms?.deliveryChargePerUnitBDT || 0;
      totalDeliveryChargeBDT += qty * deliveryChargePerUnit;

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
        siteNotes: typeof deliveryDetails.siteNotes === 'string' ? deliveryDetails.siteNotes.trim().slice(0, 500) : ''
      },
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
        deliveryDistrict: district
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

    if (req.query.status && MaterialOrder.ORDER_STATUSES.includes(req.query.status)) {
      query.status = req.query.status;
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
// GET /api/materials/orders/:id
// Get order details with line items, logistics, and dispute state
// Access: Private (Buyer, Supplier, Admin, Moderator)
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

    if (!isOwner && !isSupplier && !isPrivileged) {
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
  catchAsync(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(bad('Invalid order ID.', 400));
    }

    const userId = req.user.userId || req.user.id;
    const order = await MaterialOrder.findById(req.params.id);

    if (!order) return next(bad('Material order not found.', 404));
    if (String(order.buyerUserId) !== String(userId)) {
      return next(bad('Unauthorized: Only the buyer can fund escrow for this order.', 403));
    }

    if (order.status !== 'ACCEPTED') {
      return next(bad(`Order must be ACCEPTED by supplier before escrow funding. Current status: ${order.status}`));
    }

    // Atomically decrement stock from active SKUs
    for (const item of order.items) {
      await MaterialProduct.updateOne(
        { _id: item.productId, stockQuantity: { $gte: item.quantity } },
        { $inc: { stockQuantity: -item.quantity } }
      );
    }

    order.status = 'ESCROW_FUNDED';
    order.escrowStatus = 'FUNDED';
    await order.save();

    await AuditLog.create({
      entityId: order._id,
      entityType: 'MATERIAL_ORDER',
      action: 'MATERIAL_ORDER_ESCROW_FUNDED',
      actorId: userId,
      actorRole: req.user.role,
      metadata: {
        orderNumber: order.orderNumber,
        fundedAmountBDT: order.totalAmountBDT
      },
      ipAddress: req.ip
    });

    res.status(200).json({
      status: 'success',
      message: 'Order 100% pre-funded into escrow. Supplier notified to dispatch shipment.',
      data: { order }
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

    const { weightSlipUrl, challanDocumentUrl } = req.body || {};

    order.status = 'DELIVERED';
    order.logistics.deliveredAt = new Date();
    if (weightSlipUrl) order.logistics.weightSlipUrl = String(weightSlipUrl).trim();
    if (challanDocumentUrl) order.logistics.challanDocumentUrl = String(challanDocumentUrl).trim();
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
  catchAsync(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(bad('Invalid order ID.', 400));
    }

    const userId = req.user.userId || req.user.id;
    const order = await MaterialOrder.findById(req.params.id);

    if (!order) return next(bad('Material order not found.', 404));
    if (String(order.buyerUserId) !== String(userId)) {
      return next(bad('Unauthorized: Only the buyer can confirm delivery and release funds.', 403));
    }

    if (!['IN_TRANSIT', 'DELIVERED'].includes(order.status)) {
      return next(bad(`Delivery cannot be confirmed in current status: ${order.status}`));
    }

    order.status = 'COMPLETED';
    order.escrowStatus = 'RELEASED';
    await order.save();

    // Increment supplier completed transactions count
    await SupplierProfile.findByIdAndUpdate(order.supplierId, {
      $inc: { 'statistics.totalOrdersFulfilled': 1 }
    });

    await AuditLog.create({
      entityId: order._id,
      entityType: 'MATERIAL_ORDER',
      action: 'MATERIAL_ORDER_COMPLETED',
      actorId: userId,
      actorRole: req.user.role,
      metadata: {
        orderNumber: order.orderNumber,
        releasedAmountBDT: order.totalAmountBDT - order.platformFeeBDT,
        platformFeeBDT: order.platformFeeBDT
      },
      ipAddress: req.ip
    });

    res.status(200).json({
      status: 'success',
      message: 'Delivery confirmed and escrow funds released to supplier.',
      data: { order }
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

module.exports = router;
