// routes/chat.js
// Phase 26 — Negotiation Chat REST API (Hardened Dual-Alias Architecture)
//
// Access control:
//   All endpoints require a valid JWT (verifyToken).
//   Only the two parties to the bid (client who owns the project, contractor
//   who submitted the bid) may read or write messages on that thread.
//
// Dual-alias route support:
//   - GET  /api/chat/:bidId          AND GET  /api/chat/bid/:bidId
//   - POST /api/chat/:bidId/message  AND POST /api/chat/:bidId/messages AND POST /api/chat/bid/:bidId/message
//   - POST /api/chat/:bidId/accept-offer AND POST /api/chat/offer/:messageId/accept

'use strict';

const express  = require('express');
const router   = express.Router({ mergeParams: true });
const mongoose = require('mongoose');

const { verifyToken }           = require('../middleware/auth');
const catchAsync                = require('../utils/catchAsync');
const Message                   = require('../models/Message');
const Bid                       = require('../models/Bid');
const Project                   = require('../models/Project');
const EscrowLedger              = require('../models/EscrowLedger');
const AuditLog                  = require('../models/AuditLog');
const { runTransaction, TxResponse } = require('../utils/transaction');
const { computeBidFingerprint } = require('../services/bidEligibilityService');

const PAGE_SIZE = 30; // messages per page

// ─────────────────────────────────────────────
// HELPER: Verify the calling user is one of the two
//         participants in this bid negotiation thread.
// Returns { bid, project, isContractor, isClient } on success, calls next(err) on failure.
// ─────────────────────────────────────────────
async function verifyBidParticipant(bidId, userId, next) {
  if (!mongoose.Types.ObjectId.isValid(bidId)) {
    const err = Object.assign(
      new Error('Invalid bid ID format.'),
      { statusCode: 400, isOperational: true }
    );
    if (next) next(err);
    return null;
  }

  const bid = await Bid.findById(bidId).select('contractorId projectId status').lean();
  if (!bid) {
    const err = Object.assign(
      new Error('Bid not found.'),
      { statusCode: 404, isOperational: true }
    );
    if (next) next(err);
    return null;
  }

  const project = await Project.findById(bid.projectId).select('clientId').lean();
  if (!project) {
    const err = Object.assign(
      new Error('Parent project not found.'),
      { statusCode: 404, isOperational: true }
    );
    if (next) next(err);
    return null;
  }

  const isContractor = bid.contractorId.toString() === userId;
  const isClient     = project.clientId.toString()  === userId;

  if (!isContractor && !isClient) {
    const err = Object.assign(
      new Error('Access Denied: You are not a participant in this negotiation thread.'),
      { statusCode: 403, isOperational: true }
    );
    if (next) next(err);
    return null;
  }

  return { bid, project, isContractor, isClient };
}

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/chat/offer/:messageId/accept
// @desc    Atomically accept an offer by its Message ID.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/offer/:messageId/accept', verifyToken, catchAsync(acceptOfferHandler));

// ─────────────────────────────────────────────────────────────────────────────
// @route   GET /api/chat/:bidId  &  GET /api/chat/bid/:bidId
// @desc    Fetch paginated message history for a bid negotiation thread.
// ─────────────────────────────────────────────────────────────────────────────
router.get(['/bid/:bidId', '/:bidId'], verifyToken, catchAsync(async (req, res, next) => {
  const { bidId }  = req.params;
  const { userId } = req.user;

  const participation = await verifyBidParticipant(bidId, userId, next);
  if (!participation) return;

  const limit  = Math.min(parseInt(req.query.limit, 10) || PAGE_SIZE, 50);
  const before = req.query.before ? new Date(req.query.before) : null;

  const filter = { bidId };
  if (before && !isNaN(before.getTime())) {
    filter.createdAt = { $lt: before };
  }

  const messages = await Message
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .select('-__v')
    .lean();

  // Reverse so the client receives oldest-first order
  messages.reverse();

  const nextCursor = messages.length === limit
    ? messages[0].createdAt.toISOString()
    : null;

  res.status(200).json({
    status: 'success',
    data: {
      messages,
      pagination: {
        limit,
        nextCursor,
        hasMore: nextCursor !== null
      }
    }
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/chat/:bidId/message (and /:bidId/messages, /bid/:bidId/message)
// @desc    Send a TEXT or REVISED_OFFER message on a bid thread.
// ─────────────────────────────────────────────────────────────────────────────
router.post(['/bid/:bidId/message', '/:bidId/message', '/:bidId/messages'], verifyToken, catchAsync(async (req, res, next) => {
  const { bidId }  = req.params;
  const { userId } = req.user;

  const participation = await verifyBidParticipant(bidId, userId, next);
  if (!participation) return;

  const { bid, project, isContractor } = participation;

  if (bid.status !== 'PENDING') {
    return next(Object.assign(
      new Error(`Cannot send messages on a bid with status '${bid.status}'.`),
      { statusCode: 409, isOperational: true }
    ));
  }

  const { messageType = 'TEXT', text, content, revisedAmount, revisedAmountBDT, revisedDays, estimatedDays } = req.body;

  const resolvedText = text || content;
  const resolvedAmount = revisedAmount !== undefined ? revisedAmount : (revisedAmountBDT !== undefined ? revisedAmountBDT : req.body.amount);
  const resolvedDays = revisedDays !== undefined ? revisedDays : estimatedDays;

  if (!['TEXT', 'REVISED_OFFER', 'SCOPE_CHANGE'].includes(messageType)) {
    return next(Object.assign(
      new Error("messageType must be 'TEXT', 'REVISED_OFFER', or 'SCOPE_CHANGE'."),
      { statusCode: 400, isOperational: true }
    ));
  }

  if (messageType === 'REVISED_OFFER') {
    if (resolvedAmount === undefined || Number(resolvedAmount) < 100) {
      return next(Object.assign(
        new Error('Proposed amount must be at least 100 BDT.'),
        { statusCode: 400, isOperational: true }
      ));
    }
    if (resolvedDays === undefined || Number(resolvedDays) < 1) {
      return next(Object.assign(
        new Error('Estimated timeline must be at least 1 day.'),
        { statusCode: 400, isOperational: true }
      ));
    }

    // Mark previous PENDING revised offers on this bid thread as SUPERSEDED
    await Message.updateMany(
      { bidId, messageType: 'REVISED_OFFER', offerStatus: 'PENDING' },
      { $set: { offerStatus: 'SUPERSEDED' } }
    );
  }

  const recipientId = isContractor
    ? project.clientId
    : bid.contractorId;

  const payload = { text: resolvedText };
  if (messageType === 'REVISED_OFFER') {
    payload.revisedAmount = Number(resolvedAmount);
    payload.revisedDays   = Number(resolvedDays);
  }

  const message = await Message.create({
    bidId,
    senderId:    userId,
    senderRole:  isContractor ? 'CONTRACTOR' : 'CLIENT',
    recipientId,
    messageType,
    payload
  });

  const io = req.app.get('io');
  if (io) {
    io.to(bidId.toString()).emit('new_message', message);
  }

  res.status(201).json({ status: 'success', data: { message } });
}));

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/chat/:bidId/accept-offer
// @desc    Atomically accept the active REVISED_OFFER on this bid thread.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:bidId/accept-offer', verifyToken, catchAsync(acceptOfferHandler));

// ─────────────────────────────────────────────────────────────────────────────
// Shared ACID Handler: Accept Offer
// ─────────────────────────────────────────────────────────────────────────────
async function acceptOfferHandler(req, res, next) {
  const { userId } = req.user;
  const paramBidId = req.params.bidId;
  const paramMessageId = req.params.messageId || req.body.messageId;

  try {
    // Retried transaction (utils/transaction.js); refusals throw TxResponse so
    // the claim on the offer rolls back. Nothing outside the DB happens inside.
    const accepted = await runTransaction(async (session) => {
      let offerMsg = null;
      let resolvedBidId = paramBidId;

      if (paramMessageId) {
        offerMsg = await Message.findOneAndUpdate(
          { _id: paramMessageId, messageType: 'REVISED_OFFER', offerStatus: 'PENDING' },
          { $set: { offerStatus: 'ACCEPTED' } },
          { returnDocument: 'after', session }
        );
        if (!offerMsg) {
          throw new TxResponse(409, { status: 'error', error: 'Offer already processed or not pending.' });
        }
        resolvedBidId = offerMsg.bidId;
      } else if (paramBidId) {
        offerMsg = await Message.findOneAndUpdate(
          { bidId: paramBidId, messageType: 'REVISED_OFFER', offerStatus: 'PENDING' },
          { $set: { offerStatus: 'ACCEPTED' } },
          { sort: { createdAt: -1 }, returnDocument: 'after', session }
        );
        if (!offerMsg) {
          throw new TxResponse(409, { status: 'error', error: 'No pending REVISED_OFFER found on this negotiation thread or offer already processed.' });
        }
        resolvedBidId = paramBidId;
      } else {
        throw new TxResponse(400, { status: 'error', error: 'bidId or messageId is required to accept an offer.' });
      }

      const bid = await Bid.findById(resolvedBidId).session(session);
      if (!bid) {
        throw new TxResponse(404, { status: 'error', error: 'Bid not found.' });
      }

      if (bid.status !== 'PENDING') {
        throw new TxResponse(409, { status: 'error', error: `This bid is already in '${bid.status}' state and cannot be accepted.` });
      }

      const project = await Project.findById(bid.projectId).session(session);
      if (!project) {
        throw new TxResponse(404, { status: 'error', error: 'Parent project not found.' });
      }

      // Counterparty authorization check
      const isClient = project.clientId.toString() === userId;
      const isCounterparty = offerMsg.senderId.toString() !== userId;
      if (!isClient && !isCounterparty) {
        throw new TxResponse(403, { status: 'error', error: 'Forbidden: You are not authorized to accept this offer.' });
      }

      // Supersede any remaining pending offers on this thread
      await Message.updateMany(
        { bidId: resolvedBidId, messageType: 'REVISED_OFFER', offerStatus: 'PENDING', _id: { $ne: offerMsg._id } },
        { $set: { offerStatus: 'SUPERSEDED' } },
        { session }
      );

      const revisedAmount = offerMsg.payload?.revisedAmount ?? offerMsg.payload?.acceptedAmount ?? 0;
      const revisedDays   = offerMsg.payload?.revisedDays ?? offerMsg.payload?.acceptedDays ?? 0;

      // Mutate the parent Bid document
      bid.status = 'ACCEPTED';
      bid.bidAmount = revisedAmount;
      bid.estimatedDays = revisedDays;
      if (typeof computeBidFingerprint === 'function') {
        try {
          bid.bidFingerprint = computeBidFingerprint({
            projectId: String(bid.projectId),
            contractorId: String(bid.contractorId),
            bidAmount: revisedAmount,
            estimatedDays: revisedDays,
            proposalText: bid.proposalText
          });
        } catch {
          // preserve existing if fingerprint parameter signature varies
        }
      }
      await bid.save({ session, validateBeforeSave: false });

      // Check if an EscrowLedger exists for this projectId
      // Only an unfunded escrow for THIS contractor may be re-priced: a funded
      // one holds a fixed amount of real money, and a cancelled one is history.
      let ledger = await EscrowLedger.findOne({ projectId: bid.projectId, contractorId: bid.contractorId, ledgerStatus: 'PENDING_FUNDING' }).session(session);
      if (ledger) {
        // 🛡️ Phase-2 P0-10 fix: EscrowLedger.totalContractValue is integer BDT.
        ledger.totalContractValue = Math.round(revisedAmount);
        if (Array.isArray(ledger.milestones) && ledger.milestones.length > 0) {
          const unapproved = ledger.milestones.filter(m => !['CLIENT_APPROVED', 'RELEASED', 'PAID_OFFLINE', 'COMPLETED', 'SETTLED'].includes(m.status));
          if (unapproved.length > 0) {
            const approvedSum = ledger.milestones
              .filter(m => ['CLIENT_APPROVED', 'RELEASED', 'PAID_OFFLINE', 'COMPLETED', 'SETTLED'].includes(m.status))
              .reduce((sum, m) => sum + (m.amount || 0), 0);
            const remainingAmount = Math.max(0, revisedAmount - approvedSum);
            const totalUnapprovedPct = unapproved.reduce((sum, m) => sum + (m.releasePercentage || 0), 0) || 100;
            let allocated = 0;
            unapproved.forEach((m, idx) => {
              if (idx === unapproved.length - 1) {
                m.amount = Math.max(0, remainingAmount - allocated);
              } else {
                m.amount = Math.round(remainingAmount * ((m.releasePercentage || (100 / unapproved.length)) / totalUnapprovedPct));
                allocated += m.amount;
              }
            });
          }
        }
        await ledger.save({ session });
      }

      // Write system alert / OFFER_ACCEPTED record
      const [acceptedMsg] = await Message.create([{
        bidId: resolvedBidId,
        senderId: userId,
        senderRole: isClient ? 'CLIENT' : 'CONTRACTOR',
        recipientId: isClient ? bid.contractorId : project.clientId,
        messageType: 'OFFER_ACCEPTED',
        payload: {
          text: 'Offer accepted. The bid terms have been updated.',
          acceptedAmount: revisedAmount,
          acceptedDays: revisedDays
        },
        offerStatus: 'ACCEPTED'
      }], { session });

      // Record immutable AuditLog
      await AuditLog.create([{
        entityId: offerMsg._id,
        entityType: 'MESSAGE',
        action: 'OFFER_ACCEPTED',
        actorId: userId,
        actorRole: isClient ? 'CLIENT' : 'CONTRACTOR',
        metadata: {
          bidId: String(resolvedBidId),
          projectId: String(bid.projectId),
          acceptedAmount: revisedAmount,
          acceptedDays: revisedDays
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      }], { session });

      return { resolvedBidId, revisedAmount, revisedDays, acceptedMsg, offerMsg, bid, ledger };
    });
    const { resolvedBidId, revisedAmount, revisedDays, acceptedMsg, offerMsg, bid, ledger } = accepted;

    // Broadcast only after commit, so a retried attempt never announces twice.
    const io = req.app.get('io');
    if (io) {
      io.to(resolvedBidId.toString()).emit('offer_accepted', {
        bidId: resolvedBidId,
        acceptedAmount: revisedAmount,
        acceptedDays: revisedDays,
        message: acceptedMsg
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Offer accepted. Bid terms updated atomically.',
      data: {
        acceptedAmount: revisedAmount,
        acceptedDays: revisedDays,
        systemMessage: acceptedMsg,
        message: offerMsg,
        bid,
        ledger
      }
    });

  } catch (err) {
    if (err instanceof TxResponse) return err.send(res);
    if (err.codeName === 'IllegalOperation' || err.code === 20) {
      return next(Object.assign(
        new Error('Atomic transactions require a MongoDB replica set. Contact the platform administrator.'),
        { statusCode: 503, isOperational: true }
      ));
    }
    throw err;
  }
}

module.exports = router;
