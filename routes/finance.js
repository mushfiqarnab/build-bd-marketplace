const express = require('express');
const router = express.Router();

const User = require('../models/User');
const WithdrawalLedger = require('../models/WithdrawalLedger');
const { enforceIdempotency } = require('../middleware/idempotency');
const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const { runTransaction } = require('../utils/transaction');
const { emitAudit } = require('../services/auditService');

/** A withdrawal as shown to its owner: never the full bank account / routing number. */
function toWithdrawalDto(w) {
  const d = w && typeof w.toObject === 'function' ? w.toObject() : w;
  const acct = String((d.destinationBankDetails && d.destinationBankDetails.accountNumber) || '');
  return {
    _id: d._id,
    withdrawalId: d._id,
    amount: d.amount,
    currency: d.currency,
    status: d.status,
    bankName: d.destinationBankDetails ? d.destinationBankDetails.bankName : null,
    accountLast4: acct ? acct.slice(-4) : null,
    bankTransactionId: d.bankTransactionId || null,
    failureReason: d.status === 'FAILED' ? d.failureReason || null : null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt
  };
}

function withdrawalAuditMeta(w, extra = {}) {
  const acct = String((w.destinationBankDetails && w.destinationBankDetails.accountNumber) || '');
  return { amount: w.amount, bankName: w.destinationBankDetails ? w.destinationBankDetails.bankName : null, accountLast4: acct ? acct.slice(-4) : null, ...extra };
}
const {
  initiatePayout,
  classifyPayoutError,
  isPayoutConfigured
} = require('../services/bankPayoutClient');

async function executeCompensatingRefund(withdrawalRecord, failureReason, actor) {
  try {
    // Retried transaction: the PROCESSING CAS makes a re-run refund at most once.
    const locked = await runTransaction(async (session) => {
      const claimed = await WithdrawalLedger.findOneAndUpdate(
        { _id: withdrawalRecord._id, status: 'PROCESSING' },
        {
          $set: {
            status: 'FAILED',
            failureReason
          }
        },
        { session, returnDocument: 'after' }
      );
      if (!claimed) return null;

      await User.findByIdAndUpdate(
        withdrawalRecord.userId,
        { $inc: { 'wallet.availableToWithdraw': withdrawalRecord.amount } },
        { session }
      );
      await emitAudit({
        session,
        entityId: claimed._id,
        entityType: 'WITHDRAWAL_LEDGER',
        action: 'WITHDRAWAL_FAILED',
        actorId: withdrawalRecord.userId,
        actorRole: (actor && actor.role) || 'SYSTEM',
        metadata: withdrawalAuditMeta(claimed, { reason: failureReason, refunded: true }),
        ipAddress: (actor && actor.ip) || 'SYSTEM_INTERNAL'
      });
      return claimed;
    });

    // Another worker (or prior attempt) already resolved this ledger.
    if (!locked) {
      const current = await WithdrawalLedger.findById(withdrawalRecord._id);
      return { refunded: false, ledger: current };
    }
    return { refunded: true, ledger: locked };
  } catch (refundError) {
    console.error('CRITICAL: Compensating refund failed!', refundError);
    return { refunded: false, ledger: withdrawalRecord, error: refundError };
  }
}

router.post(
  '/withdraw',
  verifyToken,
  // Audit G4: a CLIENT also holds withdrawable money (dispute refunds credit the client wallet), so clients
  // and suppliers must be able to take it out through the same audited flow.
  requireRole(['CONTRACTOR', 'CLIENT', 'SUPPLIER']),
  enforceIdempotency,
  catchAsync(async (req, res, next) => {
    // Audit D2: refuse BEFORE any wallet is debited or bank detail leaves the server.
    if (!isPayoutConfigured()) {
      return res.status(503).json({
        status: 'error',
        message: 'Withdrawals are temporarily unavailable: bank payouts are not enabled on this server yet. Your balance is unchanged.'
      });
    }
    const { amount, bankDetails } = req.body;
    const idempotencyKey = req.headers['x-idempotency-key'];

    if (!Number.isFinite(Number(amount)) || Number(amount) < 500) {
      return res.status(400).json({ status: 'error', message: 'Minimum withdrawal is 500 BDT.' });
    }
    // Wallets hold whole taka; a fractional amount used to debit the wallet
    // and only fail later, at the ledger's integer validator.
    if (!Number.isInteger(Number(amount))) {
      return res.status(400).json({ status: 'error', message: 'Withdrawal amount must be a whole number of taka.' });
    }

    if (
      !bankDetails ||
      !bankDetails.accountName ||
      !bankDetails.accountNumber ||
      !bankDetails.routingNumber ||
      !bankDetails.bankName
    ) {
      return res.status(400).json({
        status: 'error',
        message: 'Complete destinationBankDetails are required.'
      });
    }

    const numericAmount = Number(amount);
    let withdrawalRecord;

    try {
      // Debit + ledger row in one retried transaction. A write conflict (two
      // withdrawals at once) re-runs it instead of failing; the $gte guard
      // still makes overdrawing impossible.
      withdrawalRecord = await runTransaction(async (session) => {
        const user = await User.findById(req.user.userId).session(session);
        if (!user) {
          throw Object.assign(new Error('User not found.'), { statusCode: 404, isOperational: true });
        }

        // Atomic debit under the same transaction as ledger creation.
        const debitResult = await User.findOneAndUpdate(
          {
            _id: user._id,
            'wallet.availableToWithdraw': { $gte: numericAmount }
          },
          { $inc: { 'wallet.availableToWithdraw': -numericAmount } },
          { session, returnDocument: 'after' }
        );

        if (!debitResult) {
          throw Object.assign(new Error('Insufficient available fiat funds.'), {
            statusCode: 400,
            isOperational: true
          });
        }

        const [record] = await WithdrawalLedger.create(
          [
            {
              userId: user._id,
              amount: numericAmount,
              destinationBankDetails: bankDetails,
              idempotencyKey
            }
          ],
          { session }
        );
        await emitAudit({
          session,
          entityId: record._id,
          entityType: 'WITHDRAWAL_LEDGER',
          action: 'WITHDRAWAL_REQUESTED',
          actorId: req.user.userId,
          actorRole: req.user.role,
          metadata: withdrawalAuditMeta(record),
          ipAddress: req.ip || 'SYSTEM_INTERNAL'
        });
        return record;
      });
    } catch (error) {
      // Known refusals keep their answer; anything else is a real fault and
      // goes to the global handler (generic 500, no raw database text).
      if (error.isOperational) return res.status(error.statusCode).json({ status: 'error', message: error.message });
      throw error;
    }

    try {
      const bankResponse = await initiatePayout({
        amount: numericAmount,
        bankDetails,
        clientReference: idempotencyKey
      });

      // CAS on PROCESSING: if the reconciliation sweeper already settled this row, we must not overwrite it.
      const finalized = await runTransaction(async (session) => {
        const done = await WithdrawalLedger.findOneAndUpdate(
          { _id: withdrawalRecord._id, status: 'PROCESSING' },
          { $set: { status: 'COMPLETED', bankTransactionId: bankResponse.bankTransactionId || `MOCK_TX_${withdrawalRecord._id}`, failureReason: null } },
          { session, returnDocument: 'after' }
        );
        if (done) {
          await emitAudit({
            session,
            entityId: done._id,
            entityType: 'WITHDRAWAL_LEDGER',
            action: 'WITHDRAWAL_COMPLETED',
            actorId: req.user.userId,
            actorRole: req.user.role,
            metadata: withdrawalAuditMeta(done, { bankTransactionId: done.bankTransactionId }),
            ipAddress: req.ip || 'SYSTEM_INTERNAL'
          });
        }
        return done;
      });
      const current = finalized || await WithdrawalLedger.findById(withdrawalRecord._id);

      return res.status(200).json({
        status: 'success',
        message: 'Withdrawal successfully routed to external bank.',
        data: toWithdrawalDto(current)
      });
    } catch (networkError) {
      const classification = classifyPayoutError(networkError);

      // Only refund when the bank has definitively rejected the payout.
      // Timeouts / 5xx / DNS failures stay PROCESSING for the reconciliation sweeper —
      // auto-refunding an ambiguous outcome risks double-paying after a late bank success.
      if (classification.kind === 'DEFINITE_FAILURE') {
        const refundResult = await executeCompensatingRefund(
          withdrawalRecord,
          classification.message,
          { role: req.user.role, ip: req.ip }
        );

        if (refundResult.refunded) {
          return res.status(502).json({
            status: 'error',
            message: 'External banking network rejected the payout. Funds have been restored to your wallet.',
            data: { withdrawalId: withdrawalRecord._id, ledgerStatus: 'FAILED' }
          });
        }

        return res.status(503).json({
          status: 'error',
          message:
            'Bank rejected the payout, but the automatic refund could not complete. Support has been alerted.',
          data: { withdrawalId: withdrawalRecord._id, ledgerStatus: refundResult.ledger?.status || 'PROCESSING' }
        });
      }

      try {
        // Only while still PROCESSING: never overwrite what the reconciliation sweeper decided meanwhile.
        await WithdrawalLedger.updateOne({ _id: withdrawalRecord._id, status: 'PROCESSING' }, { $set: { failureReason: classification.message } });
      } catch (persistError) {
        console.error('Failed to persist ambiguous withdrawal failure reason:', persistError.message);
      }

      return res.status(202).json({
        status: 'pending',
        message:
          'Withdrawal accepted locally but bank confirmation is pending. Funds remain reserved until reconciliation confirms the outcome.',
        data: { withdrawalId: withdrawalRecord._id, ledgerStatus: 'PROCESSING' }
      });
    }
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// @route   GET /api/finance/withdrawals
// @desc    The caller's own withdrawals, newest first. The destination account
//          number is masked to its last 4 digits.
// @access  Private (CONTRACTOR | CLIENT)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/withdrawals', verifyToken, requireRole(['CONTRACTOR', 'CLIENT', 'SUPPLIER']), catchAsync(async (req, res) => {
  const rows = await WithdrawalLedger.find({ userId: req.user.userId })
    .sort({ createdAt: -1 })
    .limit(50)
    .select('amount status bankTransactionId failureReason destinationBankDetails.bankName destinationBankDetails.accountNumber createdAt updatedAt')
    .lean();

  res.status(200).json({
    status: 'success',
    data: {
      withdrawals: rows.map((w) => {
        const acct = String((w.destinationBankDetails && w.destinationBankDetails.accountNumber) || '');
        return {
          withdrawalId: w._id,
          amount: w.amount,
          status: w.status,
          bankName: w.destinationBankDetails ? w.destinationBankDetails.bankName : null,
          accountLast4: acct ? acct.slice(-4) : null,
          bankTransactionId: w.bankTransactionId || null,
          failureReason: w.status === 'FAILED' ? w.failureReason || null : null,
          requestedAt: w.createdAt,
          updatedAt: w.updatedAt
        };
      })
    }
  });
}));

module.exports = router;
