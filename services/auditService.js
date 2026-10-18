const AuditLog = require('../models/AuditLog');

/**
 * Strips restricted Personally Identifiable Information (PII) from metadata
 * before it is permanently sealed in the cryptographic ledger.
 */
const scrubPII = (metadata) => {
  if (!metadata || typeof metadata !== 'object') return metadata;

  const sanitized = JSON.parse(JSON.stringify(metadata));
  const restrictedKeys = ['password', 'phoneNumber', 'creditCard', 'cvv', 'token', 'secret', 'accountNumber', 'routingNumber', 'accountName', 'bankDetails'];

  const recursiveScrub = (obj) => {
    Object.keys(obj).forEach((key) => {
      if (restrictedKeys.includes(key)) {
        obj[key] = '[REDACTED_FOR_COMPLIANCE]';
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        recursiveScrub(obj[key]);
      }
    });
  };

  recursiveScrub(sanitized);
  return sanitized;
};

/**
 * Emits a transaction-bound, PII-scrubbed audit log.
 */
exports.emitAudit = async ({
  session,
  entityId,
  entityType,
  action,
  actorId,
  actorRole,
  metadata = {},
  ipAddress = 'SYSTEM_INTERNAL'
}) => {
  if (!session) {
    throw new Error('FATAL: Audit logs must be bound to a distributed ACID transaction session.');
  }

  const sanitizedMetadata = scrubPII(metadata);

  const payload = {
    entityId,
    entityType,
    action,
    actorId,
    actorRole,
    metadata: sanitizedMetadata,
    ipAddress
  };

  const [log] = await AuditLog.create([payload], { session });

  if (!log) {
    throw new Error('Critical Integrity Failure: Audit ledger failed to generate receipt.');
  }

  return log;
};
