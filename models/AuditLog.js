// models/AuditLog.js
const mongoose = require('mongoose');
const crypto = require('crypto');

// 🛡️ Phase-3 P1 fix: resolve the HMAC salt once at module load with explicit
// precedence (AUDIT_HMAC_SECRET → JWT_SECRET), and fail at boot in production
// if neither is set. The previous `|| 'FALLBACK_LOCAL_SECRET_9982'` literal
// was a known public constant — any attacker who read this file could forge
// signatures that pass verifyIntegrity. Rotating JWT_SECRET broke every
// historical signature; a dedicated AUDIT_HMAC_SECRET lets ops rotate the
// auth secret without invalidating audit history.
function resolveAuditSalt() {
  const salt = (process.env.AUDIT_HMAC_SECRET || process.env.JWT_SECRET || '').trim();
  if (!salt) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('AUDIT_HMAC_SECRET (or JWT_SECRET as a fallback) is required in production. Set it to a 64-byte random hex value in .env.beta and keep it stable — rotating it invalidates every historical audit signature.');
    }
    // In dev/test, use a deterministic non-secret so historical signatures
    // from earlier runs still verify locally.
    return 'DEV_LOCAL_AUDIT_SALT';
  }
  return salt;
}
const AUDIT_SALT = resolveAuditSalt();

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
    enum: ['ESCROW_LEDGER', 'USER_WALLET', 'SYSTEM_TREASURY', 'PLATFORM_ARBITRATION', 'PAYMENT_RECEIPT', 'DISPUTE_TICKET', 'MESSAGE', 'REVIEW', 'WITHDRAWAL_LEDGER', 'PROJECT', 'CONTRACTOR_PROFILE', 'SUPPLIER_PROFILE', 'MATERIAL_PRODUCT', 'MATERIAL_ORDER', 'PROJECT_SHARE', 'MATERIAL_DELIVERY_LOG', 'CONTRACT', 'LABOUR_SUBSCRIPTION'],
    required: true,
    immutable: true
  },
  action: { 
    type: String, 
    enum: [
      'PAYMENT_INITIATED',
      'FUNDS_DEPOSITED',
      'FUNDS_LOCKED',              // escrow init / contract lock
      'CONTRACT_EXPIRED_UNPAID',   // abandonment worker: rolled back ghost contract
      'ORPHAN_PAYMENT_REFUND_REQUIRED', // IPN: gateway captured money for a ledger that could not be funded
      'ORPHAN_PAYMENT_REFUNDED',        // admin: recorded the SSLCommerz refund of an orphan payment
      'MILESTONE_APPROVED',        // governance.js: client approves milestone (standard online flow)
      'MILESTONE_APPROVED_CLIENT', // settlement.js: client approves offline proof
      'MILESTONE_REJECTED_CLIENT', // settlement.js: client rejects offline proof
      'MILESTONE_DISPUTED', 
      'MILESTONE_STALL_ESCALATED', // milestoneEscalationService: review window expired, contractor escalation unlocked 
      'ARBITRATION_VERDICT_CLIENT',
      'ARBITRATION_VERDICT_CONTRACTOR',
      'PROOF_SUBMITTED',
      'OFFLINE_PAYMENT_SUBMITTED',
      'OFFLINE_PAYMENT_CONFIRMED',
      'EVIDENCE_SUBMITTED',
      'EVIDENCE_SUBMITTED_LIVE',
      'DISPUTE_RESOLVED',
      'OFFER_ACCEPTED',
      'REVIEW_SUBMITTED',
      'WITHDRAWAL_REQUESTED',      // money leaving the platform: wallet debited, payout started
      'WITHDRAWAL_COMPLETED',      // bank confirmed
      'WITHDRAWAL_FAILED',         // bank refused / reconciliation failed → wallet refunded
      'PROJECT_CANCELLED',         // client closed an OPEN project
      'CONTRACTOR_PROFILE_UPDATED', // contractor edited their trade profile
      'CONTRACTOR_VERIFIED',       // admin verified a contractor KYC application
      'CONTRACTOR_REJECTED',       // admin rejected a contractor KYC application
      'SUPPLIER_VERIFIED',         // admin verified a supplier KYC application
      'SUPPLIER_REJECTED',         // admin rejected a supplier KYC application
      'SUPPLIER_PROFILE_UPDATED',  // supplier created or updated their profile
      'MATERIAL_PRODUCT_CREATED',  // supplier created a new material SKU
      'MATERIAL_PRODUCT_UPDATED',  // supplier updated pricing/stock on a SKU
      'MATERIAL_PRODUCT_ARCHIVED', // supplier archived a SKU
      'MATERIAL_ORDER_CREATED',    // buyer placed a material purchase order / RFQ
      'MATERIAL_ORDER_ACCEPTED',   // supplier accepted the purchase order
      'MATERIAL_ORDER_REJECTED',   // supplier rejected the purchase order
      'MATERIAL_ORDER_ESCROW_FUNDED', // buyer pre-funded 100% escrow for the order
      'MATERIAL_ORDER_DISPATCHED', // supplier marked shipment in transit with waybill/challan
      'MATERIAL_ORDER_DELIVERED',  // supplier marked shipment arrived at delivery site
      'MATERIAL_ORDER_COMPLETED',  // buyer confirmed delivery & quality, escrow released
      'MATERIAL_ORDER_DISPUTED',   // dispute opened on material quantity or quality
      'MATERIAL_ORDER_DISPUTE_RESOLVED', // admin or moderator resolved a disputed material order
      'MATERIAL_ORDER_CANCELLED',  // order cancelled prior to dispatch
      'PROJECT_SHARE_CREATED',     // client generated a family/site-watcher delegation token
      'PROJECT_SHARE_REVOKED',     // client revoked an active delegation share token
      'MATERIAL_DELIVERY_LOGGED',  // contractor or site watcher logged material delivery entry
      'MATERIAL_DELIVERY_ACKNOWLEDGED', // client acknowledged gentle variance flags on delivery
      'CONTRACT_CREATED',          // labour subscription contract creation
      'MICRO_DISPATCH_CREATED',    // instant utility micro dispatch booking
      'SECURITY_DISPUTE_FILED'     // 48-hour domestic labour police GD dispute
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
  this.cryptographicSignature = crypto
    .createHmac('sha256', AUDIT_SALT)
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
  const expectedSignature = crypto.createHmac('sha256', AUDIT_SALT).update(payload).digest('hex');
  return logDocument.cryptographicSignature === expectedSignature;
};

auditLogSchema.index({ entityId: 1, action: 1 });
auditLogSchema.index({ entityType: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);