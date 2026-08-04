const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const User = require('../models/User');
const WithdrawalLedger = require('../models/WithdrawalLedger');
const { enforceIdempotency } = require('../middleware/idempotency');
const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const {
  initiatePayout,
  classifyPayoutError
} = require('../services/bankPayoutClient');

async function executeCompensatingRefund(withdrawalRecord, failureReason) {
  const refundSession = await mongoose.startSession();
  refundSession.startTransaction();
  try {
    const locked = await WithdrawalLedger.findOneAndUpdate(
      { _id: withdrawalRecord._id, status: 'PROCESSING' },
      {
        $set: {
          status: 'FAILED',
          failureReason
        }
      },
      { session: refundSession, returnDocument: 'after' }
    );

    // Another worker (or prior attempt) already resolved this ledger.
    if (!locked) {
      await refundSession.abortTransaction();
      const current = await WithdrawalLedger.findById(withdrawalRecord._id);
      return { refunded: false, ledger: current };
    }

    await User.findByIdAndUpdate(
      withdrawalRecord.userId,
      { $inc: { 'wallet.availableToWithdraw': withdrawalRecord.amount } },
      { session: refundSession }
    );

    await refundSession.commitTransaction();
    return { refunded: true, ledger: locked };
  } catch (refundError) {
    await refundSession.abortTransaction();
    console.error('CRITICAL: Compensating refund failed!', refundError);
    return { refunded: false, ledger: withdrawalRecord, error: refundError };
  } finally {
    refundSession.endSession();
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

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const user = await User.findById(req.user.userId).session(session);
      if (!user) {
        throw Object.assign(new Error('User not found.'), { statusCode: 404, isOperational: true });
      }

      if (user.wallet.availableToWithdraw < numericAmount) {
        throw Object.assign(new Error('Insufficient available fiat funds.'), {
          statusCode: 400,
          isOperational: true
        });
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

      [withdrawalRecord] = await WithdrawalLedger.create(
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

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      return res.status(error.statusCode || 400).json({ status: 'error', message: error.message });
    } finally {
      session.endSession();
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

module.exports = router;
