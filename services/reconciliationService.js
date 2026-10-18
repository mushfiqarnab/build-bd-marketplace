const { runTransaction } = require('../utils/transaction');
const WithdrawalLedger = require('../models/WithdrawalLedger');
const User = require('../models/User');
const { queryPayoutStatus } = require('./bankPayoutClient');

const GRACE_PERIOD_MS = Number(process.env.RECONCILIATION_GRACE_MS || 15 * 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.RECONCILIATION_MAX_ATTEMPTS || 5);
const BATCH_LIMIT = Number(process.env.RECONCILIATION_BATCH_LIMIT || 50);

/**
 * Atomically claim one stale PROCESSING withdrawal for this worker.
 * Claim bumps reconciliationAttempts + lastReconciledAt so concurrent sweepers skip it.
 */
async function claimStaleWithdrawal(candidateId, staleThreshold) {
  return WithdrawalLedger.findOneAndUpdate(
    {
      _id: candidateId,
      status: 'PROCESSING',
      updatedAt: { $lt: staleThreshold },
      reconciliationAttempts: { $lt: MAX_ATTEMPTS }
    },
    {
      $inc: { reconciliationAttempts: 1 },
      $set: { lastReconciledAt: new Date() }
    },
    { returnDocument: 'after' }
  );
}

async function markCompleted(withdrawal, bankTransactionId) {
  const updated = await WithdrawalLedger.findOneAndUpdate(
    { _id: withdrawal._id, status: 'PROCESSING' },
    {
      $set: {
        status: 'COMPLETED',
        bankTransactionId: bankTransactionId || withdrawal.bankTransactionId || `RECONCILED_${withdrawal._id}`,
        failureReason: null
      }
    },
    { returnDocument: 'after' }
  );
  return Boolean(updated);
}

/**
 * Compensating refund ONLY after the bank oracle confirms FAILED.
 * Uses CAS on status=PROCESSING so concurrent workers cannot double-refund.
 */
async function markFailedAndRefund(withdrawal, failureReason) {
  // Retried transaction: the PROCESSING CAS makes a re-run refund at most once.
  return runTransaction(async (session) => {
    const locked = await WithdrawalLedger.findOneAndUpdate(
      { _id: withdrawal._id, status: 'PROCESSING' },
      {
        $set: {
          status: 'FAILED',
          failureReason
        }
      },
      { session, returnDocument: 'after' }
    );

    if (!locked) {
      return { applied: false, reason: 'already_resolved' };
    }

    await User.findByIdAndUpdate(
      withdrawal.userId,
      { $inc: { 'wallet.availableToWithdraw': withdrawal.amount } },
      { session }
    );

    return { applied: true, ledger: locked };
  });
}

async function escalateToManualReview(withdrawal, reason) {
  return WithdrawalLedger.findOneAndUpdate(
    { _id: withdrawal._id, status: 'PROCESSING' },
    {
      $set: {
        status: 'MANUAL_REVIEW',
        failureReason: reason
      }
    },
    { returnDocument: 'after' }
  );
}

/**
 * Anti-entropy sweeper: converges ghost PROCESSING withdrawals against the bank oracle.
 *
 * Convergence rules (non-negotiable):
 * - SUCCESS  → COMPLETED (no wallet change; funds already reserved)
 * - FAILED   → FAILED + compensating refund
 * - PENDING / UNKNOWN → leave PROCESSING; after max attempts → MANUAL_REVIEW (never auto-refund)
 *
 * Refunding on UNKNOWN is how you double-pay contractors after a late bank success.
 */
async function runReconciliationCycle({ now = new Date(), gracePeriodMs = GRACE_PERIOD_MS } = {}) {
  const staleThreshold = new Date(now.getTime() - gracePeriodMs);
  const summary = {
    scanned: 0,
    claimed: 0,
    completed: 0,
    refunded: 0,
    pending: 0,
    quarantined: 0,
    skipped: 0,
    errors: 0
  };

  const candidates = await WithdrawalLedger.find({
    status: 'PROCESSING',
    updatedAt: { $lt: staleThreshold },
    reconciliationAttempts: { $lt: MAX_ATTEMPTS }
  })
    .sort({ updatedAt: 1 })
    .limit(BATCH_LIMIT)
    .select('_id');

  summary.scanned = candidates.length;
  if (candidates.length === 0) return summary;

  console.log(
    `🔄 [Reconciliation] Found ${candidates.length} stale PROCESSING withdrawal(s). Starting anti-entropy sweep...`
  );

  for (const candidate of candidates) {
    let claimed;
    try {
      claimed = await claimStaleWithdrawal(candidate._id, staleThreshold);
      if (!claimed) {
        summary.skipped += 1;
        continue;
      }
      summary.claimed += 1;

      // Oracle call MUST stay outside any Mongo transaction (saga invariant).
      const oracle = await queryPayoutStatus({
        clientReference: claimed.idempotencyKey,
        bankTransactionId: claimed.bankTransactionId,
        withdrawalId: claimed._id
      });

      if (oracle.status === 'SUCCESS') {
        const ok = await markCompleted(claimed, oracle.bankTransactionId);
        if (ok) {
          summary.completed += 1;
          console.log(`✅ [Reconciled] ${claimed._id} → COMPLETED (bank SUCCESS).`);
        } else {
          summary.skipped += 1;
        }
        continue;
      }

      if (oracle.status === 'FAILED') {
        const result = await markFailedAndRefund(
          claimed,
          `Anti-entropy reconciliation: bank oracle reported FAILED.`
        );
        if (result.applied) {
          summary.refunded += 1;
          console.log(
            `🔄 [Reconciled] ${claimed._id} → FAILED + refunded ${claimed.amount} ${claimed.currency || 'BDT'}.`
          );
        } else {
          summary.skipped += 1;
        }
        continue;
      }

      // PENDING or UNKNOWN — never refund. Escalate only after budget exhausted.
      if (claimed.reconciliationAttempts >= MAX_ATTEMPTS) {
        const quarantined = await escalateToManualReview(
          claimed,
          `Anti-entropy reconciliation exhausted after ${MAX_ATTEMPTS} attempts (last oracle=${oracle.status}).`
        );
        if (quarantined) {
          summary.quarantined += 1;
          console.warn(`🚨 [Quarantine] ${claimed._id} moved to MANUAL_REVIEW (oracle=${oracle.status}).`);
        } else {
          summary.skipped += 1;
        }
      } else {
        summary.pending += 1;
        console.log(
          `⏳ [Reconciled] ${claimed._id} still ${oracle.status}; attempt ${claimed.reconciliationAttempts}/${MAX_ATTEMPTS}.`
        );
      }
    } catch (innerError) {
      summary.errors += 1;
      console.error(
        `❌ [Reconciliation] Failed on ${candidate._id}:`,
        innerError.message
      );
    }
  }

  return summary;
}

module.exports = {
  runReconciliationCycle,
  claimStaleWithdrawal,
  markCompleted,
  markFailedAndRefund,
  escalateToManualReview,
  GRACE_PERIOD_MS,
  MAX_ATTEMPTS,
  BATCH_LIMIT
};
