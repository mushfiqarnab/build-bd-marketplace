// models/AuditLog.js
const mongoose = require('mongoose');
const crypto = require('crypto');

function normalizeMetadata(value) {
  if (value === null || value === undefined) return {};
  if (Array.isArray(value)) {
    return value.map((item) => normalizeMetadata(item));
  }
  if (typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = normalizeMetadata(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function buildSignaturePayload(document) {
  return JSON.stringify({
    entityId: document.entityId?.toString?.() || '',
    entityType: document.entityType,
    action: document.action,
    actorId: document.actorId?.toString?.() || '',
    actorRole: document.actorRole,
    metadata: normalizeMetadata(document.metadata),
    ipAddress: document.ipAddress || 'SYSTEM_INTERNAL'
  });
}

const auditLogSchema = new mongoose.Schema({
  entityId: { 
    type: mongoose.Schema.Types.ObjectId, 
    required: true, 
    index: true,
    immutable: true // 🛡️ Native Mongoose immutability
  },
  entityType: { 
    type: String, 
    enum: ['ESCROW_LEDGER', 'USER_WALLET', 'SYSTEM_TREASURY', 'PLATFORM_ARBITRATION'], 
    required: true,
    immutable: true
  },
  action: { 
    type: String, 
    enum: [
      'PAYMENT_INITIATED',
      'FUNDS_DEPOSITED', 
      'MILESTONE_APPROVED', 
      'MILESTONE_DISPUTED', 
      'ARBITRATION_VERDICT_CLIENT',
      'ARBITRATION_VERDICT_CONTRACTOR'
    ],
    required: true,
    immutable: true
  },
  actorId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true,
    immutable: true
  },
  actorRole: { 
    type: String, 
    required: true,
    immutable: true
  },
  metadata: { 
    type: mongoose.Schema.Types.Mixed,
    default: {},
    immutable: true,
    set: normalizeMetadata
  },
  ipAddress: { 
    type: String,
    default: 'SYSTEM_INTERNAL',
    immutable: true
  },
  // 🛡️ FUTURISTIC EDGE-TECH: Data-at-Rest Tamper Evidence
  cryptographicSignature: {
    type: String,
    required: true,
    immutable: true
  }
}, {
  timestamps: true,
  versionKey: false
});

// ==========================================
// 🛡️ CRYPTOGRAPHIC SEALING (PRE-VALIDATE + PRE-SAVE)
// ==========================================
auditLogSchema.pre('validate', function() {
  if (!this.isNew || this.cryptographicSignature) {
    return;
  }

  const payload = buildSignaturePayload(this);
  const salt = process.env.JWT_SECRET || 'FALLBACK_LOCAL_SECRET_9982';
  this.cryptographicSignature = crypto
    .createHmac('sha256', salt)
    .update(payload)
    .digest('hex');
});

auditLogSchema.pre('save', function() {
  if (!this.isNew) {
    throw new Error('FATAL: Audit logs are cryptographically immutable and cannot be modified via save().');
  }

  if (!this.cryptographicSignature) {
    throw new Error('FATAL: Audit signature generation failed before persistence.');
  }
});

// ==========================================
// 🛡️ MONGODB PROTOTYPE CHAIN LOCKDOWN
// ==========================================
const blockMutation = function() {
  throw new Error('FATAL SECURITY BREACH: Attempted to mutate or delete an immutable Audit Log. Operation aborted.');
};

// Intercept all conceivable update/delete methods
auditLogSchema.pre('updateOne', blockMutation);
auditLogSchema.pre('updateMany', blockMutation);
auditLogSchema.pre('findOneAndUpdate', blockMutation);
auditLogSchema.pre('replaceOne', blockMutation);
auditLogSchema.pre('deleteOne', blockMutation);
auditLogSchema.pre('deleteMany', blockMutation);
auditLogSchema.pre('findOneAndDelete', blockMutation);
auditLogSchema.pre('findOneAndRemove', blockMutation);
auditLogSchema.pre('remove', blockMutation); // Legacy support

// ==========================================
// 🛡️ TAMPER VERIFICATION METHOD (Static)
// ==========================================
// This allows the server to audit its own database for malicious tampering
auditLogSchema.statics.verifyIntegrity = function(logDocument) {
  const payload = buildSignaturePayload(logDocument);

  const salt = process.env.JWT_SECRET || 'FALLBACK_LOCAL_SECRET_9982';
  const expectedSignature = crypto.createHmac('sha256', salt).update(payload).digest('hex');

  return logDocument.cryptographicSignature === expectedSignature;
};

auditLogSchema.index({ entityId: 1, action: 1 });
auditLogSchema.index({ entityType: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);