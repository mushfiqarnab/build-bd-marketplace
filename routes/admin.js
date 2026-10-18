// routes/admin.js — platform-operator money operations (ADMIN only).
//
// Refund queue for orphan gateway payments: money SSLCommerz captured for a
// ledger that could not take it (client paid twice, or paid after the
// abandonment sweeper cancelled the contract). See routes/payment.js /ipn.
// The refund itself is issued by an operator in the SSLCommerz merchant panel;
// this API lists what is owed and records, with an audit entry, that it was paid.
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const { verifyToken, requireRole } = require('../middleware/auth');
const { enforceIdempotency } = require('../middleware/idempotency');
const catchAsync = require('../utils/catchAsync');
const { emitAudit } = require('../services/auditService');
const EscrowLedger = require('../models/EscrowLedger');

const LIST_LIMIT = 200;
const VAL_ID_RE = /^[\w.\-]{1,128}$/;
const REFERENCE_RE = /^[\w.\-\/]{4,64}$/;

// ─────────────────────────────────────────────────────────────────────────────
// @route   GET /api/admin/refunds?status=pending|refunded|all
// @desc    Orphan gateway payments, newest first, with the client's phone.
// @access  Private (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/refunds', verifyToken, requireRole(['ADMIN']), catchAsync(async (req, res) => {
  const status = ['pending', 'refunded', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  const byStatus = status === 'pending' ? { 'orphanPayments.refundedAt': null }
    : status === 'refunded' ? { 'orphanPayments.refundedAt': { $ne: null } }
    : {};

  const rows = await EscrowLedger.aggregate([
    { $match: { 'orphanPayments.valId': { $exists: true } } },
    { $unwind: '$orphanPayments' },
    { $match: byStatus },
    { $sort: { 'orphanPayments.receivedAt': -1 } },
    { $limit: LIST_LIMIT },
    { $lookup: { from: 'users', localField: 'clientId', foreignField: '_id', as: 'client', pipeline: [{ $project: { phoneNumber: 1 } }] } },
    {
      $project: {
        _id: 0,
        ledgerId: '$_id',
        projectId: 1,
        ledgerStatus: 1,
        clientPhone: { $first: '$client.phoneNumber' },
        tranId: '$orphanPayments.tranId',
        valId: '$orphanPayments.valId',
        amount: '$orphanPayments.amount',
        reason: '$orphanPayments.reason',
        receivedAt: '$orphanPayments.receivedAt',
        refundedAt: '$orphanPayments.refundedAt',
        refundReference: '$orphanPayments.refundReference',
        refundNote: '$orphanPayments.refundNote'
      }
    }
  ]);

  const pendingTotal = rows.filter((r) => !r.refundedAt).reduce((t, r) => t + r.amount, 0);
  res.status(200).json({
    status: 'success',
    data: { filter: status, count: rows.length, pendingTotalBDT: pendingTotal, truncated: rows.length === LIST_LIMIT, refunds: rows }
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/admin/refunds/:ledgerId/:valId/complete
// @desc    Record that the operator refunded this payment in SSLCommerz.
//          Body: { refundReference (SSLCommerz refund ref, 4-64 chars), note? }
//          CAS on refundedAt=null: a second completion returns 409.
// @access  Private (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/refunds/:ledgerId/:valId/complete',
  verifyToken,
  requireRole(['ADMIN']),
  enforceIdempotency,
  catchAsync(async (req, res, next) => {
    const { ledgerId, valId } = req.params;
    const refundReference = typeof req.body.refundReference === 'string' ? req.body.refundReference.trim() : '';
    const note = typeof req.body.note === 'string' ? req.body.note.trim().slice(0, 500) : '';

    if (!mongoose.isValidObjectId(ledgerId) || !VAL_ID_RE.test(valId)) {
      return next(Object.assign(new Error('Invalid ledger or payment identifier.'), { statusCode: 400, isOperational: true }));
    }
    if (!REFERENCE_RE.test(refundReference)) {
      return next(Object.assign(
        new Error('refundReference must be the SSLCommerz refund reference (4-64 letters, digits, . _ - /).'),
        { statusCode: 400, isOperational: true }
      ));
    }

    const session = await mongoose.startSession();
    let refunded = null;
    try {
      await session.withTransaction(async () => {
        const now = new Date();
        const ledger = await EscrowLedger.findOneAndUpdate(
          { _id: ledgerId, orphanPayments: { $elemMatch: { valId, refundedAt: null } } },
          {
            $set: {
              'orphanPayments.$.refundedAt': now,
              'orphanPayments.$.refundReference': refundReference,
              'orphanPayments.$.refundNote': note || null,
              'orphanPayments.$.refundedBy': req.user.userId
            }
          },
          { session, returnDocument: 'after' }
        );
        if (!ledger) {
          throw Object.assign(new Error('No unrefunded payment with that id on this ledger (already refunded, or not an orphan payment).'), { statusCode: 409, isOperational: true });
        }
        const payment = ledger.orphanPayments.find((p) => p.valId === valId);
        await emitAudit({
          session,
          entityId:   ledger._id,
          entityType: 'ESCROW_LEDGER',
          action:     'ORPHAN_PAYMENT_REFUNDED',
          actorId:    req.user.userId,
          actorRole:  req.user.role,
          metadata:   { tranId: payment.tranId, valId, amountBDT: payment.amount, reason: payment.reason, refundReference, note: note || null },
          ipAddress:  req.ip || 'SYSTEM_INTERNAL'
        });
        refunded = { ledgerId: ledger._id, valId, amount: payment.amount, refundReference, refundedAt: now };
      });
    } finally {
      session.endSession();
    }

    res.status(200).json({ status: 'success', message: 'Refund recorded.', data: refunded });
  })
);

module.exports = router;
