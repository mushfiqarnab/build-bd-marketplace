const express = require('express');
const router = express.Router();

const User = require('../models/User');
const WithdrawalLedger = require('../models/WithdrawalLedger');
const { enforceIdempotency } = require('../middleware/idempotency');
const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const { runTransaction } = require('../utils/transaction');
const {
  initiatePayout,
  classifyPayoutError
} = require('../services/bankPayoutClient');

async function executeCompensatingRefund(withdrawalRecord, failureReason) {
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
  requireRole(['CONTRACTOR']),
  enforceIdempotency,
  catchAsync(async (req, res, next) => {
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

      withdrawalRecord.status = 'COMPLETED';
      withdrawalRecord.bankTransactionId =
        bankResponse.bankTransactionId || `MOCK_TX_${withdrawalRecord._id}`;
      await withdrawalRecord.save();

      return res.status(200).json({
        status: 'success',
        message: 'Withdrawal successfully routed to external bank.',
        data: withdrawalRecord
      });
    } catch (networkError) {
      const classification = classifyPayoutError(networkError);

      // Only refund when the bank has definitively rejected the payout.
      // Timeouts / 5xx / DNS failures stay PROCESSING for the reconciliation sweeper —
      // auto-refunding an ambiguous outcome risks double-paying after a late bank success.
      if (classification.kind === 'DEFINITE_FAILURE') {
        const refundResult = await executeCompensatingRefund(
          withdrawalRecord,
          classification.message
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

      withdrawalRecord.failureReason = classification.message;
      try {
        await withdrawalRecord.save();
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
// @access  Private (CONTRACTOR)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/withdrawals', verifyToken, requireRole(['CONTRACTOR']), catchAsync(async (req, res) => {
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
