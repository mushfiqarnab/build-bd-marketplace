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
const { runTransaction } = require('../utils/transaction');
const { emitAudit } = require('../services/auditService');
const EscrowLedger = require('../models/EscrowLedger');
const Project = require('../models/Project');
const MaterialOrder = require('../models/MaterialOrder');
const ContractorProfile = require('../models/ContractorProfile');
const DisputeTicket = require('../models/DisputeTicket');

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

    // Retried transaction (utils/transaction.js): the refundedAt=null CAS makes a re-run record the refund once.
    const refunded = await runTransaction(async (session) => {
      {
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
        return { ledgerId: ledger._id, valId, amount: payment.amount, refundReference, refundedAt: now };
      }
    });

    res.status(200).json({ status: 'success', message: 'Refund recorded.', data: refunded });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// @route   GET /api/admin/analytics
// @desc    Executive & operations marketplace telemetry snapshot (whole-Taka BDT).
// @access  Private (ADMIN, MODERATOR)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/analytics', verifyToken, requireRole(['ADMIN', 'MODERATOR']), catchAsync(async (req, res) => {
  const [
    ledgers,
    projects,
    materialOrders,
    verifiedContractors,
    openDisputes
  ] = await Promise.all([
    EscrowLedger.find({
      ledgerStatus: { $in: ['PENDING_FUNDING', 'FUNDED', 'PARTIALLY_DISBURSED', 'FULLY_DISBURSED', 'IN_ARBITRATION'] }
    })
      .sort({ createdAt: -1 })
      .limit(120)
      .select('projectId ledgerStatus milestones createdAt paidAt')
      .lean(),
    Project.find({ status: { $in: ['OPEN', 'UNDER_BIDDING', 'ASSIGNED', 'COMPLETED', 'CANCELLED'] } })
      .sort({ createdAt: -1 })
      .limit(120)
      .select('title category location budget status createdAt')
      .lean(),
    MaterialOrder.find({})
      .limit(80)
      .select('orderNumber status items totalAmountBDT platformFeeBDT deliveryDetails createdAt')
      .lean(),
    ContractorProfile.countDocuments({ 'verification.status': 'VERIFIED' }),
    DisputeTicket.countDocuments({ status: 'OPEN_FOR_REVIEW' })
  ]);

  const projectById = new Map(projects.map((p) => [String(p._id), p]));

  const liveRecords = [];
  for (const ledger of ledgers) {
    const milestones = Array.isArray(ledger.milestones) ? ledger.milestones : [];
    const grossAmountBDT = milestones.reduce((sum, m) => sum + (Number.isInteger(m.amount) ? m.amount : Math.round(Number(m.amount) || 0)), 0);
    if (grossAmountBDT <= 0) continue;
    const platformFeeBDT = Math.round(grossAmountBDT * 0.05);
    const retainageHoldBDT = Math.round(grossAmountBDT * 0.10);
    const netDisbursedBDT = grossAmountBDT - platformFeeBDT - retainageHoldBDT;
    const proj = projectById.get(String(ledger.projectId));
    const hasCryptoProof = milestones.some((m) =>
      Array.isArray(m.evidenceLog) && m.evidenceLog.some((ev) => ev.verificationTier === 'CRYPTOGRAPHIC_PROOF')
    );

    liveRecords.push({
      id: `ESC-${String(ledger._id).slice(-6).toUpperCase()}`,
      date: (ledger.paidAt || ledger.createdAt || new Date()).toISOString().slice(0, 10),
      stream: 'ESCROW_CONTRACT',
      title: proj ? proj.title : 'Escrow Milestone Contract',
      counterparty: 'Verified Contractor',
      division: proj && proj.location ? String(proj.location).split(',')[0].trim() : 'Dhaka',
      district: proj && proj.location ? String(proj.location) : 'Dhaka',
      segment: proj && proj.category ? proj.category : 'Residential',
      contractorTier: 'ENGINEERING_FIRM',
      status: ledger.ledgerStatus || 'FUNDED',
      verificationTier: hasCryptoProof ? 'CRYPTOGRAPHIC_PROOF' : 'GPS_ONLY',
      grossAmountBDT,
      platformFeeBDT,
      retainageHoldBDT,
      netDisbursedBDT,
      trustScore: 92,
      settlementHours: 18,
      milestoneCount: milestones.length || 1
    });
  }

  for (const order of materialOrders) {
    const grossAmountBDT = Number.isInteger(order.totalAmountBDT) ? order.totalAmountBDT : Math.round(Number(order.totalAmountBDT) || 0);
    if (grossAmountBDT <= 0) continue;
    const platformFeeBDT = Number.isInteger(order.platformFeeBDT) && order.platformFeeBDT > 0
      ? order.platformFeeBDT
      : Math.round(grossAmountBDT * 0.05);
    const retainageHoldBDT = 0;
    const netDisbursedBDT = grossAmountBDT - platformFeeBDT - retainageHoldBDT;
    const primaryItem = Array.isArray(order.items) && order.items[0] ? order.items[0] : null;
    const mappedStatus = order.status === 'COMPLETED' || order.status === 'DELIVERED'
      ? 'FULLY_DISBURSED'
      : order.status === 'DISPUTED'
        ? 'IN_ARBITRATION'
        : order.status === 'IN_TRANSIT'
          ? 'IN_TRANSIT'
          : 'FUNDED';

    liveRecords.push({
      id: order.orderNumber || `MAT-${String(order._id).slice(-6).toUpperCase()}`,
      date: (order.createdAt || new Date()).toISOString().slice(0, 10),
      stream: 'MATERIAL_ORDER',
      title: primaryItem ? `${primaryItem.brand} ${primaryItem.title}` : 'Bulk Material Purchase Order',
      counterparty: 'Verified Material Dealer',
      division: order.deliveryDetails?.deliveryDistrict || 'Dhaka',
      district: order.deliveryDetails?.deliveryDistrict || 'Dhaka',
      segment: primaryItem?.category || 'CEMENT',
      contractorTier: 'MATERIAL_DEALER',
      status: mappedStatus,
      verificationTier: 'GPS_ONLY',
      grossAmountBDT,
      platformFeeBDT,
      retainageHoldBDT,
      netDisbursedBDT,
      trustScore: 90,
      settlementHours: 14,
      milestoneCount: Array.isArray(order.items) ? order.items.length : 1
    });
  }

  res.status(200).json({
    status: 'success',
    data: {
      generatedAt: new Date().toISOString(),
      verifiedContractors,
      openDisputes,
      totalLiveRecords: liveRecords.length,
      records: liveRecords
    }
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// @route   GET /api/admin/otp-relay
// @desc    Active ৳0 cloud operator fallback OTP codes (ADMIN only; replaces
//          requiring local SSH/terminal access to logs/otp-relay.log on cloud hosts).
// @access  Private (ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/otp-relay', verifyToken, requireRole(['ADMIN']), catchAsync(async (req, res) => {
  if (req.user && req.user.isDelegate) {
    return res.status(403).json({ status: 'error', message: 'Forbidden: Delegated tokens cannot view operator OTP relay.' });
  }
  const { resolveOtpDelivery, hasValidSmsConfig, resolveSmsConfig, readActiveOperatorOtps } = require('../services/otpDelivery');
  const deliveryMode = resolveOtpDelivery() || 'unconfigured';
  const smsCfg = resolveSmsConfig();
  const entries = readActiveOperatorOtps();

  res.status(200).json({
    status: 'success',
    data: {
      deliveryMode,
      smsConfigured: hasValidSmsConfig(),
      smsProvider: smsCfg.provider,
      count: entries.length,
      entries
    }
  });
}));

module.exports = router;
