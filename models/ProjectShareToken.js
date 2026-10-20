// models/ProjectShareToken.js
// Probashi Mode & Family Delegation tokens (Phase 2)
// Decouples financial release authority from site observation and evidence upload.
'use strict';

const mongoose = require('mongoose');

const ProjectShareTokenSchema = new mongoose.Schema({
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: [true, 'Share token must be linked to a project'],
    immutable: true,
    index: true
  },
  clientUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Share token must be linked to a client user ID'],
    immutable: true,
    index: true
  },
  tokenHash: {
    type: String,
    required: [true, 'Token hash is mandatory'],
    unique: true,
    trim: true
  },
  scopedRole: {
    type: String,
    required: [true, 'Scoped role is mandatory'],
    enum: {
      values: ['FAMILY_VIEWER', 'SITE_WATCHER'],
      message: '{VALUE} is not a valid delegation role'
    }
  },
  delegateName: {
    type: String,
    required: [true, 'Delegate name is mandatory'],
    trim: true,
    maxlength: [80, 'Delegate name cannot exceed 80 characters']
  },
  delegatePhone: {
    type: String,
    trim: true,
    default: null
  },
  hideFinancials: {
    type: Boolean,
    default: true
  },
  isRevoked: {
    type: Boolean,
    default: false,
    index: true
  },
  expiresAt: {
    type: Date,
    required: [true, 'Expiration date is mandatory'],
    index: true
  }
}, { timestamps: true });

// Compound indexes required by query-plans.js & master plan
ProjectShareTokenSchema.index({ tokenHash: 1, isRevoked: 1, expiresAt: 1 }, { unique: true });
ProjectShareTokenSchema.index({ projectId: 1, clientUserId: 1, isRevoked: 1 });

module.exports = mongoose.model('ProjectShareToken', ProjectShareTokenSchema);
