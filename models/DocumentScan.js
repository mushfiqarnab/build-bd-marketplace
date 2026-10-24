// models/DocumentScan.js
// 🛡️ Anti-Fraud Document & Credential Ledger
// Scans, fingerprints, and cross-checks every uploaded document across accounts.
'use strict';

const mongoose = require('mongoose');

const documentScanSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  fileHash: {
    type: String,
    required: true,
    index: true
  },
  fileName: {
    type: String,
    trim: true
  },
  mimeType: {
    type: String,
    trim: true
  },
  documentCategory: {
    type: String,
    enum: ['NID', 'TRADE_LICENSE', 'EXPERIENCE_CERTIFICATE', 'WORK_COMPLETION_PHOTO', 'OTHER'],
    required: true,
    default: 'OTHER'
  },
  declaredNumber: {
    type: String,
    trim: true
  },
  fraudStatus: {
    type: String,
    enum: ['CLEARED', 'SUSPICIOUS', 'REJECTED'],
    required: true,
    default: 'CLEARED',
    index: true
  },
  fraudRiskScore: {
    type: Number,
    required: true,
    min: 0,
    max: 100,
    default: 100
  },
  fraudFlags: [{
    type: String
  }],
  exifData: {
    hasGps: { type: Boolean, default: false },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    capturedAt: { type: Date, default: null },
    cameraMake: { type: String, default: null },
    cameraModel: { type: String, default: null },
    software: { type: String, default: null }
  }
}, { timestamps: true });

// Cross-account duplicate detection index
documentScanSchema.index({ fileHash: 1, userId: 1 });
documentScanSchema.index({ fraudStatus: 1, createdAt: -1 });

module.exports = mongoose.model('DocumentScan', documentScanSchema);
