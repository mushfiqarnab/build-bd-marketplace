// models/MaterialOrder.js — Materials Marketplace Purchase Order & RFQ Schema
'use strict';

const mongoose = require('mongoose');
const { MATERIAL_CATEGORIES } = require('./SupplierProfile');
const { integerBDT } = require('../utils/money');

const ORDER_STATUSES = [
  'PENDING_SUPPLIER_ACCEPTANCE',
  'ACCEPTED',
  'REJECTED',
  'ESCROW_FUNDED',
  'IN_TRANSIT',
  'DELIVERED',
  'COMPLETED',
  'DISPUTED',
  'CANCELLED'
];

const orderItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MaterialProduct',
      required: true
    },
    category: {
      type: String,
      enum: MATERIAL_CATEGORIES,
      required: true
    },
    brand: {
      type: String,
      required: true,
      trim: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    unit: {
      type: String,
      required: true
    },
    quantity: {
      type: Number,
      required: true,
      min: [1, 'Quantity must be at least 1'],
      validate: {
        validator: Number.isInteger,
        message: 'Order quantity must be a whole integer'
      }
    },
    unitPriceBDT: {
      type: Number,
      required: true,
      validate: integerBDT('items.unitPriceBDT')
    },
    totalPriceBDT: {
      type: Number,
      required: true,
      validate: integerBDT('items.totalPriceBDT')
    },
    tierDiscountPercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    }
  },
  { _id: false }
);

const materialOrderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true
    },
    buyerUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    buyerRole: {
      type: String,
      enum: ['CLIENT', 'CONTRACTOR'],
      required: true
    },
    supplierUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupplierProfile',
      required: true,
      index: true
    },
    items: {
      type: [orderItemSchema],
      required: true,
      validate: [
        function (items) {
          return Array.isArray(items) && items.length > 0;
        },
        'Purchase order must contain at least one material item'
      ]
    },
    itemsSubtotalBDT: {
      type: Number,
      required: true,
      validate: integerBDT('itemsSubtotalBDT')
    },
    deliveryChargeBDT: {
      type: Number,
      default: 0,
      min: [0, 'Delivery charge cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: 'Delivery charge must be an integer in BDT'
      }
    },
    platformFeeBDT: {
      type: Number,
      default: 0,
      min: [0, 'Platform fee cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: 'Platform fee must be an integer in BDT'
      }
    },
    totalAmountBDT: {
      type: Number,
      required: true,
      validate: integerBDT('totalAmountBDT')
    },
    deliveryDetails: {
      deliveryDistrict: {
        type: String,
        required: true,
        trim: true
      },
      deliveryAddress: {
        type: String,
        required: true,
        trim: true,
        minlength: 5,
        maxlength: 300
      },
      receiverName: {
        type: String,
        required: true,
        trim: true,
        minlength: 2,
        maxlength: 60
      },
      receiverPhone: {
        type: String,
        required: true,
        trim: true
      },
      siteNotes: {
        type: String,
        trim: true,
        maxlength: 500,
        default: ''
      }
    },
    logistics: {
      carrierName: { type: String, trim: true, default: '' },
      challanNumber: { type: String, trim: true, default: '' },
      vehicleNumber: { type: String, trim: true, default: '' },
      driverPhone: { type: String, trim: true, default: '' },
      challanDocumentUrl: { type: String, trim: true, default: '' },
      weightSlipUrl: { type: String, trim: true, default: '' },
      dispatchedAt: { type: Date },
      deliveredAt: { type: Date }
    },
    status: {
      type: String,
      enum: ORDER_STATUSES,
      default: 'PENDING_SUPPLIER_ACCEPTANCE',
      index: true
    },
    escrowStatus: {
      type: String,
      enum: ['PENDING', 'FUNDED', 'RELEASED', 'FROZEN', 'REFUNDED'],
      default: 'PENDING',
      index: true
    },
    rejectionReason: {
      type: String,
      trim: true,
      default: ''
    },
    disputeDetails: {
      reason: { type: String, trim: true },
      raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      raisedAt: { type: Date },
      status: {
        type: String,
        enum: ['OPEN', 'RESOLVED_RELEASED_TO_SUPPLIER', 'RESOLVED_REFUNDED_TO_BUYER']
      }
    },
    escrowLedgerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EscrowLedger'
    }
  },
  {
    timestamps: true
  }
);

// Compound indexes for performant querying of orders by user role and status
materialOrderSchema.index({ buyerUserId: 1, status: 1, createdAt: -1 });
materialOrderSchema.index({ supplierUserId: 1, status: 1, createdAt: -1 });
materialOrderSchema.index({ 'deliveryDetails.deliveryDistrict': 1, status: 1 });

function generateOrderNumber() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `ORD-${yyyy}${mm}${dd}-${rand}`;
}

materialOrderSchema.statics.generateOrderNumber = generateOrderNumber;
materialOrderSchema.statics.ORDER_STATUSES = ORDER_STATUSES;

const MaterialOrder = mongoose.models.MaterialOrder || mongoose.model('MaterialOrder', materialOrderSchema);

module.exports = MaterialOrder;
