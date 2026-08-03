const dns = require('dns');
const mongoose = require('mongoose');
require('dotenv').config();

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
  console.log('🌐 Forced public DNS override active for reconciliation test.');
} catch (err) {
  console.warn('⚠️ DNS override failed:', err.message);
}

const User = require('../models/User');
const WithdrawalLedger = require('../models/WithdrawalLedger');
const bankPayoutClient = require('../services/bankPayoutClient');
const { runReconciliationCycle } = require('../services/reconciliationService');

async function createGhostWithdrawal(userId, amount, overrides = {}) {
  const staleDate = new Date(Date.now() - 20 * 60 * 1000); // older than 15m grace
  const doc = await WithdrawalLedger.create({
    userId,
    amount,
    destinationBankDetails: {
      accountName: 'Ghost Contractor',
      accountNumber: '99887766',
      routingNumber: '111',
      bankName: 'Ghost Bank'
    },
    status: 'PROCESSING',
    idempotencyKey: `recon-key-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    reconciliationAttempts: 0,
    ...overrides
  });

  // Force stale updatedAt (mongoose timestamps otherwise stamp "now").
  await WithdrawalLedger.collection.updateOne(
    { _id: doc._id },
    { $set: { updatedAt: staleDate, createdAt: staleDate } }
  );

  return WithdrawalLedger.findById(doc._id);
}

async function runReconciliationDiagnostics() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000
    });
    console.log('✅ Connected to MongoDB for reconciliation diagnostics.');

    const contractor = await User.create({
      role: 'CONTRACTOR',
      phoneNumber: `018${Math.floor(10000000 + Math.random() * 90000000)}`,
      wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 200 },
      status: 'ACTIVE'
    });

    const createdIds = [];

    try {
      // --- Case A: Bank SUCCESS after process death → COMPLETED, no refund ---
      const successGhost = await createGhostWithdrawal(contractor._id, 500);
      createdIds.push(successGhost._id);

      await User.findByIdAndUpdate(contractor._id, {
        $set: { 'wallet.availableToWithdraw': 200 }
      });

      bankPayoutClient.setTestOverrides({
        queryPayoutStatus: async ({ withdrawalId }) => {
          if (String(withdrawalId) === String(successGhost._id)) {
            return { status: 'SUCCESS', bankTransactionId: 'BANK_TX_SUCCESS_1' };
          }
          return { status: 'UNKNOWN', bankTransactionId: null };
        }
      });

      const successSummary = await runReconciliationCycle({ gracePeriodMs: 15 * 60 * 1000 });
      if (successSummary.completed < 1) {
        throw new Error(`Expected at least 1 COMPLETED reconciliation, got ${JSON.stringify(successSummary)}`);
      }

      const successLedger = await WithdrawalLedger.findById(successGhost._id);
      if (successLedger.status !== 'COMPLETED') {
        throw new Error(`SUCCESS ghost should be COMPLETED, got ${successLedger.status}`);
      }
      if (successLedger.bankTransactionId !== 'BANK_TX_SUCCESS_1') {
        throw new Error('SUCCESS ghost missing reconciled bankTransactionId.');
      }

      const afterSuccessUser = await User.findById(contractor._id);
      if (afterSuccessUser.wallet.availableToWithdraw !== 200) {
        throw new Error(
          `SUCCESS path must not alter wallet; expected 200, got ${afterSuccessUser.wallet.availableToWithdraw}`
        );
      }
      console.log('✅ Case A: SUCCESS oracle → COMPLETED without wallet mutation.');

      // --- Case B: Bank FAILED after process death → FAILED + compensating refund ---
      const failGhost = await createGhostWithdrawal(contractor._id, 300);
      createdIds.push(failGhost._id);

      bankPayoutClient.setTestOverrides({
        queryPayoutStatus: async ({ withdrawalId }) => {
          if (String(withdrawalId) === String(failGhost._id)) {
            return { status: 'FAILED', bankTransactionId: null };
          }
          return { status: 'UNKNOWN', bankTransactionId: null };
        }
      });

      const failSummary = await runReconciliationCycle({ gracePeriodMs: 15 * 60 * 1000 });
      if (failSummary.refunded < 1) {
        throw new Error(`Expected at least 1 refund reconciliation, got ${JSON.stringify(failSummary)}`);
      }

      const failLedger = await WithdrawalLedger.findById(failGhost._id);
      if (failLedger.status !== 'FAILED') {
        throw new Error(`FAILED ghost should be FAILED, got ${failLedger.status}`);
      }

      const afterFailUser = await User.findById(contractor._id);
      if (afterFailUser.wallet.availableToWithdraw !== 500) {
        throw new Error(
          `FAILED path should refund 300 (200+300=500); got ${afterFailUser.wallet.availableToWithdraw}`
        );
      }
      console.log('✅ Case B: FAILED oracle → FAILED + compensating refund.');

      // --- Case C: UNKNOWN must NEVER refund; escalate to MANUAL_REVIEW at max attempts ---
      const unknownGhost = await createGhostWithdrawal(contractor._id, 100, {
        reconciliationAttempts: 4 // next claim reaches MAX_ATTEMPTS (5)
      });
      createdIds.push(unknownGhost._id);

      const balanceBeforeUnknown = (await User.findById(contractor._id)).wallet.availableToWithdraw;

      bankPayoutClient.setTestOverrides({
        queryPayoutStatus: async () => ({ status: 'UNKNOWN', bankTransactionId: null })
      });

      const unknownSummary = await runReconciliationCycle({ gracePeriodMs: 15 * 60 * 1000 });
      if (unknownSummary.quarantined < 1) {
        throw new Error(
          `Expected MANUAL_REVIEW quarantine on exhausted UNKNOWN, got ${JSON.stringify(unknownSummary)}`
        );
      }

      const unknownLedger = await WithdrawalLedger.findById(unknownGhost._id);
      if (unknownLedger.status !== 'MANUAL_REVIEW') {
        throw new Error(`UNKNOWN exhaustion should quarantine, got ${unknownLedger.status}`);
      }

      const afterUnknownUser = await User.findById(contractor._id);
      if (afterUnknownUser.wallet.availableToWithdraw !== balanceBeforeUnknown) {
        throw new Error(
          `UNKNOWN must never auto-refund; balance mutated ${balanceBeforeUnknown} → ${afterUnknownUser.wallet.availableToWithdraw}`
        );
      }
      console.log('✅ Case C: UNKNOWN exhaustion → MANUAL_REVIEW with zero wallet mutation.');

      console.log('✅ Anti-entropy reconciliation engine verified (SUCCESS / FAILED / UNKNOWN).');
      process.exit(0);
    } finally {
      bankPayoutClient.clearTestOverrides();
      await WithdrawalLedger.deleteMany({ _id: { $in: createdIds } });
      await User.findByIdAndDelete(contractor._id);
    }
  } catch (error) {
    bankPayoutClient.clearTestOverrides();
    console.error('💥 RECONCILIATION DIAGNOSTIC FAILED:', error.message);
    process.exit(1);
  }
}

runReconciliationDiagnostics();
