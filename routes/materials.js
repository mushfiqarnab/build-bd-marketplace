// routes/materials.js — Materials Marketplace Catalog & SKU Management
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const { SupplierProfile, MATERIAL_CATEGORIES } = require('../models/SupplierProfile');
const { MaterialProduct, MATERIAL_UNITS, PRODUCT_STATUSES } = require('../models/MaterialProduct');

const bad = (message, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode, isOperational: true });

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/materials/products
// Create a new material product SKU
// Access: Private (VERIFIED SUPPLIER)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/products',
  verifyToken,
  requireRole(['SUPPLIER']),
  catchAsync(async (req, res, next) => {
    const userId = req.user.userId || req.user.id;

    // Verify supplier has an approved/verified profile
    const supplierProfile = await SupplierProfile.findOne({ userId });
    if (!supplierProfile) {
      return next(bad('Supplier profile not found. Please complete supplier onboarding first.', 404));
    }

    if (supplierProfile.verification?.status !== 'VERIFIED') {
      return next(bad('Only verified suppliers can publish material listings. Your KYC is currently pending review.', 403));
    }

    const {
      category,
      brand,
      title,
      description,
      unit,
      basePriceBDT,
      bulkTiers,
      specifications,
      stockQuantity,
      minOrderQuantity,
      deliveryTerms
    } = req.body || {};

    if (!category || !MATERIAL_CATEGORIES.includes(category)) {
      return next(bad(`Invalid material category. Allowed: ${MATERIAL_CATEGORIES.join(', ')}`));
    }

    if (!brand || typeof brand !== 'string' || brand.trim().length < 2 || brand.trim().length > 60) {
      return next(bad('Valid brand name is required (2–60 characters).'));
    }

    if (!title || typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 120) {
      return next(bad('Valid product title is required (3–120 characters).'));
    }

    if (!unit || !MATERIAL_UNITS.includes(unit)) {
      return next(bad(`Invalid unit of measurement. Allowed: ${MATERIAL_UNITS.join(', ')}`));
    }

    const priceNum = Number(basePriceBDT);
    if (!Number.isInteger(priceNum) || priceNum <= 0) {
      return next(bad('basePriceBDT must be a positive integer in BDT.'));
    }

    // Validate bulk pricing tiers if provided
    const validatedTiers = [];
    if (Array.isArray(bulkTiers) && bulkTiers.length > 0) {
      for (let i = 0; i < bulkTiers.length; i++) {
        const tier = bulkTiers[i];
        const minQ = Number(tier.minQuantity);
        const tierPrice = Number(tier.unitPriceBDT);

        if (!Number.isInteger(minQ) || minQ < 1) {
          return next(bad('Each bulk tier minQuantity must be an integer >= 1.'));
        }
        if (!Number.isInteger(tierPrice) || tierPrice <= 0) {
          return next(bad('Each bulk tier unitPriceBDT must be a positive integer in BDT.'));
        }
        if (tierPrice > priceNum) {
          return next(bad(`Bulk tier price (${tierPrice}) cannot exceed base price (${priceNum}).`));
        }
        if (i > 0) {
          if (minQ <= validatedTiers[i - 1].minQuantity) {
            return next(bad('Bulk tiers must be specified in strictly increasing order of minQuantity.'));
          }
          if (tierPrice > validatedTiers[i - 1].unitPriceBDT) {
            return next(bad('Bulk tier unit prices must decrease or stay equal as order quantity increases.'));
          }
        }
        validatedTiers.push({ minQuantity: minQ, unitPriceBDT: tierPrice });
      }
    }

    const stock = Number.isInteger(Number(stockQuantity)) ? Math.max(0, Number(stockQuantity)) : 0;
    const minOrder = Number.isInteger(Number(minOrderQuantity)) ? Math.max(1, Number(minOrderQuantity)) : 1;

    // Delivery districts validation
    const districts = Array.isArray(deliveryTerms?.deliveryDistricts)
      ? deliveryTerms.deliveryDistricts.map((d) => String(d).trim()).filter(Boolean)
      : supplierProfile.serviceDistricts;

    const leadDays = Number.isInteger(Number(deliveryTerms?.leadTimeDays))
      ? Math.min(30, Math.max(1, Number(deliveryTerms.leadTimeDays)))
      : 2;

    const deliveryCharge = Number.isInteger(Number(deliveryTerms?.deliveryChargePerUnitBDT))
      ? Math.max(0, Number(deliveryTerms.deliveryChargePerUnitBDT))
      : 0;

    const product = await MaterialProduct.create({
      supplierId: supplierProfile._id,
      supplierUserId: userId,
      category,
      brand: brand.trim(),
      title: title.trim(),
      description: typeof description === 'string' ? description.trim() : '',
      unit,
      basePriceBDT: priceNum,
      bulkTiers: validatedTiers,
      specifications: {
        diameterMm: specifications?.diameterMm ? Number(specifications.diameterMm) : undefined,
        grade: typeof specifications?.grade === 'string' ? specifications.grade.trim() : undefined,
        standard: typeof specifications?.standard === 'string' ? specifications.standard.trim() : undefined,
        cementType: typeof specifications?.cementType === 'string' ? specifications.cementType.trim() : undefined,
        bagWeightKg: Number.isInteger(Number(specifications?.bagWeightKg)) ? Number(specifications.bagWeightKg) : 50,
        bstiCertified: specifications?.bstiCertified !== false,
        bstiLicenseNumber: typeof specifications?.bstiLicenseNumber === 'string' ? specifications.bstiLicenseNumber.trim() : ''
      },
      stockQuantity: stock,
      minOrderQuantity: minOrder,
      deliveryTerms: {
        leadTimeDays: leadDays,
        deliveryDistricts: districts,
        deliveryChargePerUnitBDT: deliveryCharge,
        freeDeliveryMinQuantity: Number.isInteger(Number(deliveryTerms?.freeDeliveryMinQuantity)) ? Number(deliveryTerms.freeDeliveryMinQuantity) : null
      },
      status: stock > 0 ? 'ACTIVE' : 'OUT_OF_STOCK'
    });

    res.status(201).json({
      status: 'success',
      message: 'Material product SKU created successfully.',
      data: { product }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/materials/products/:id
// Update product pricing, stock, tiers, or status
// Access: Private (SUPPLIER - Owner Only)
// ─────────────────────────────────────────────────────────────────────────────
router.patch(
  '/products/:id',
  verifyToken,
  requireRole(['SUPPLIER']),
  catchAsync(async (req, res, next) => {
    const userId = req.user.userId || req.user.id;
    const productId = req.params.id;

    if (!mongoose.isValidObjectId(productId)) {
      return next(bad('Invalid product ID.', 400));
    }

    const product = await MaterialProduct.findById(productId);
    if (!product) {
      return next(bad('Material product not found.', 404));
    }

    if (String(product.supplierUserId) !== String(userId)) {
      return next(bad('Unauthorized: You do not own this material listing.', 403));
    }

    const {
      basePriceBDT,
      bulkTiers,
      stockQuantity,
      minOrderQuantity,
      deliveryTerms,
      status,
      title,
      description
    } = req.body || {};

    if (basePriceBDT !== undefined) {
      const priceNum = Number(basePriceBDT);
      if (!Number.isInteger(priceNum) || priceNum <= 0) {
        return next(bad('basePriceBDT must be a positive integer in BDT.'));
      }
      product.basePriceBDT = priceNum;
    }

    if (Array.isArray(bulkTiers)) {
      const validatedTiers = [];
      const currentBase = product.basePriceBDT;

      for (let i = 0; i < bulkTiers.length; i++) {
        const tier = bulkTiers[i];
        const minQ = Number(tier.minQuantity);
        const tierPrice = Number(tier.unitPriceBDT);

        if (!Number.isInteger(minQ) || minQ < 1) {
          return next(bad('Each bulk tier minQuantity must be an integer >= 1.'));
        }
        if (!Number.isInteger(tierPrice) || tierPrice <= 0) {
          return next(bad('Each bulk tier unitPriceBDT must be a positive integer in BDT.'));
        }
        if (tierPrice > currentBase) {
          return next(bad(`Bulk tier price (${tierPrice}) cannot exceed base price (${currentBase}).`));
        }
        if (i > 0) {
          if (minQ <= validatedTiers[i - 1].minQuantity) {
            return next(bad('Bulk tiers must be specified in strictly increasing order of minQuantity.'));
          }
          if (tierPrice > validatedTiers[i - 1].unitPriceBDT) {
            return next(bad('Bulk tier unit prices must decrease or stay equal as order quantity increases.'));
          }
        }
        validatedTiers.push({ minQuantity: minQ, unitPriceBDT: tierPrice });
      }
      product.bulkTiers = validatedTiers;
    }

    if (stockQuantity !== undefined) {
      const stock = Number(stockQuantity);
      if (!Number.isInteger(stock) || stock < 0) {
        return next(bad('Stock quantity must be a non-negative integer.'));
      }
      product.stockQuantity = stock;
      if (stock === 0 && product.status === 'ACTIVE') {
        product.status = 'OUT_OF_STOCK';
      }
    }

    if (minOrderQuantity !== undefined) {
      const minOrder = Number(minOrderQuantity);
      if (!Number.isInteger(minOrder) || minOrder < 1) {
        return next(bad('minOrderQuantity must be an integer >= 1.'));
      }
      product.minOrderQuantity = minOrder;
    }

    if (status !== undefined) {
      if (!PRODUCT_STATUSES.includes(status)) {
        return next(bad(`Invalid status. Allowed: ${PRODUCT_STATUSES.join(', ')}`));
      }
      product.status = status;
    }

    if (typeof title === 'string' && title.trim().length >= 3) {
      product.title = title.trim();
    }

    if (typeof description === 'string') {
      product.description = description.trim();
    }

    if (deliveryTerms && typeof deliveryTerms === 'object') {
      if (Array.isArray(deliveryTerms.deliveryDistricts)) {
        product.deliveryTerms.deliveryDistricts = deliveryTerms.deliveryDistricts
          .map((d) => String(d).trim())
          .filter(Boolean);
      }
      if (Number.isInteger(Number(deliveryTerms.leadTimeDays))) {
        product.deliveryTerms.leadTimeDays = Math.min(30, Math.max(1, Number(deliveryTerms.leadTimeDays)));
      }
      if (Number.isInteger(Number(deliveryTerms.deliveryChargePerUnitBDT))) {
        product.deliveryTerms.deliveryChargePerUnitBDT = Math.max(0, Number(deliveryTerms.deliveryChargePerUnitBDT));
      }
    }

    await product.save();

    res.status(200).json({
      status: 'success',
      message: 'Product SKU updated successfully.',
      data: { product }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/materials/products/my
// Supplier self-inventory of SKUs
// Access: Private (SUPPLIER)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/products/my',
  verifyToken,
  requireRole(['SUPPLIER']),
  catchAsync(async (req, res) => {
    const userId = req.user.userId || req.user.id;
    const products = await MaterialProduct.find({ supplierUserId: userId })
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      status: 'success',
      data: { count: products.length, products }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/materials/catalog
// Public marketplace materials catalog with filter rails
// Access: Public
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/catalog',
  catchAsync(async (req, res) => {
    const query = { status: 'ACTIVE' };

    if (req.query.category && typeof req.query.category === 'string') {
      const cat = req.query.category.trim().toUpperCase();
      if (MATERIAL_CATEGORIES.includes(cat)) {
        query.category = cat;
      }
    }

    if (req.query.district && typeof req.query.district === 'string') {
      query['deliveryTerms.deliveryDistricts'] = req.query.district.trim();
    }

    if (req.query.brand && typeof req.query.brand === 'string') {
      query.brand = new RegExp(`^${req.query.brand.trim()}$`, 'i');
    }

    if (req.query.minPrice !== undefined || req.query.maxPrice !== undefined) {
      query.basePriceBDT = {};
      const min = parseInt(req.query.minPrice, 10);
      const max = parseInt(req.query.maxPrice, 10);
      if (Number.isInteger(min) && min >= 0) query.basePriceBDT.$gte = min;
      if (Number.isInteger(max) && max > 0) query.basePriceBDT.$lte = max;
      if (Object.keys(query.basePriceBDT).length === 0) delete query.basePriceBDT;
    }

    const sortOption = {};
    if (req.query.sort === 'price_desc') {
      sortOption.basePriceBDT = -1;
    } else if (req.query.sort === 'newest') {
      sortOption.createdAt = -1;
    } else {
      sortOption.basePriceBDT = 1; // Default: lowest price first
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const [products, total] = await Promise.all([
      MaterialProduct.find(query)
        .populate({
          path: 'supplierId',
          select: 'businessName statistics.trustScore statistics.averageRating verification.status'
        })
        .sort(sortOption)
        .skip(skip)
        .limit(limit)
        .lean(),
      MaterialProduct.countDocuments(query)
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        products,
        total,
        page,
        limit,
        hasMore: skip + products.length < total
      }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/materials/products/:id
// Public single material product card & tier specifications
// Access: Public
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/products/:id',
  catchAsync(async (req, res, next) => {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return next(bad('Invalid product ID.', 400));
    }

    const product = await MaterialProduct.findOne({
      _id: req.params.id,
      status: { $in: ['ACTIVE', 'OUT_OF_STOCK'] }
    })
      .populate({
        path: 'supplierId',
        select: 'businessName statistics.trustScore statistics.averageRating serviceDistricts'
      })
      .lean();

    if (!product) {
      return next(bad('Material product not found.', 404));
    }

    res.status(200).json({
      status: 'success',
      data: { product }
    });
  })
);

module.exports = router;
