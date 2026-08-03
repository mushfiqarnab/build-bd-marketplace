// tests/auditlog-e2e.js
const dns = require('dns');
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (err) {
  console.warn('⚠️ DNS override failed:', err.message);
}

const mongoose = require('mongoose');
require('dotenv').config();
const AuditLog = require('../models/AuditLog');
const User = require('../models/User');

async function runAuditLogDiagnostics() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000
    });

    const actor = await User.create({
      role: 'ADMIN',
      phoneNumber: `017${Math.floor(10000000 + Math.random() * 90000000)}`,
      wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 },
      status: 'ACTIVE'
    });

    const metadataA = { amount: 100, currency: 'BDT', note: 'Alpha' };
    const metadataB = { note: 'Alpha', currency: 'BDT', amount: 100 };

    const logA = await AuditLog.create({
      entityId: actor._id,
      entityType: 'SYSTEM_TREASURY',
      action: 'FUNDS_DEPOSITED',
      actorId: actor._id,
      actorRole: 'ADMIN',
      metadata: metadataA
    });

    const logB = await AuditLog.create({
      entityId: actor._id,
      entityType: 'SYSTEM_TREASURY',
      action: 'FUNDS_DEPOSITED',
      actorId: actor._id,
      actorRole: 'ADMIN',
      metadata: metadataB
    });

    if (logA.cryptographicSignature === logB.cryptographicSignature) {
      console.log('✅ Audit signature deterministic across metadata key order.');
    } else {
      throw new Error('Signature instability detected: same semantic metadata produced different signatures.');
    }

    if (!AuditLog.verifyIntegrity(logA)) {
      throw new Error('Integrity verification failed for a fresh audit log.');
    }

    console.log('✅ Audit log integrity verification passed.');
    process.exit(0);
  } catch (error) {
    console.error('💥 AUDITLOG DIAGNOSTIC FAILED:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

runAuditLogDiagnostics();
