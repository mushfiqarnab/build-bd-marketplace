// routes/chat.js
// Phase 26 — Negotiation Chat REST API
//
// Access control:
//   All endpoints require a valid JWT (verifyToken).
//   Only the two parties to the bid (client who owns the project, contractor
//   who submitted the bid) may read or write messages on that thread.
//   This is enforced by the verifyBidParticipant helper below — it mirrors
//   the same "ownership check first" pattern used in bidIsolation.js.
//
// Transaction note:
//   POST /accept-offer uses a Mongoose session for atomic bid + message update.
//   This requires MongoDB to be running as a replica set (Atlas M0+ satisfies
//   this). If the connection does not support transactions, Mongoose will throw
//   a MongoServerError with code 20 ("Transaction numbers are only allowed on a
//   replica set member or mongos"). We catch this specifically to surface a clear
//   operational error rather than a generic 500.

const express  = require('express');
const router   = express.Router({ mergeParams: true });
const mongoose = require('mongoose');

const { verifyToken }   = require('../middleware/auth');
const catchAsync        = require('../utils/catchAsync');
const Message           = require('../models/Message');
const Bid               = require('../models/Bid');
const Project           = require('../models/Project');

const PAGE_SIZE = 30; // messages per page

// ─────────────────────────────────────────────
// HELPER: Verify the calling user is one of the two
//         participants in this bid negotiation thread.
// Returns { bid, project } on success, calls next(err) on failure.
// ─────────────────────────────────────────────
async function verifyBidParticipant(bidId, userId, next) {
  const bid = await Bid.findById(bidId).select('contractorId projectId status').lean();
  if (!bid) {
    const err = Object.assign(
      new Error('Bid not found.'),
      { statusCode: 404, isOperational: true }
    );
    next(err);
    return null;
  }

  const project = await Project.findById(bid.projectId).select('clientId').lean();
  if (!project) {
    const err = Object.assign(
      new Error('Parent project not found.'),
      { statusCode: 404, isOperational: true }
    );
    next(err);
    return null;
  }

  const isContractor = bid.contractorId.toString() === userId;
  const isClient     = project.clientId.toString()  === userId;

  if (!isContractor && !isClient) {
    const err = Object.assign(
      new Error('Access Denied: You are not a participant in this negotiation thread.'),
      { statusCode: 403, isOperational: true }
    );
    next(err);
    return null;
  }

  return { bid, project, isContractor, isClient };
}

// ─────────────────────────────────────────────────────────────────────────────
// @route   GET /api/chat/:bidId
// @desc    Fetch paginated message history for a bid negotiation thread.
//          Uses keyset pagination on createdAt for O(log n) cursor scans.
//          Query params:
//            ?limit=30          — messages per page (max 50)
//            ?before=<ISO date> — fetch messages older than this timestamp
// @access  Private (bid participants only)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:bidId', verifyToken, catchAsync(async (req, res, next) => {
  const { bidId }  = req.params;
  const { userId } = req.user;

  const participation = await verifyBidParticipant(bidId, userId, next);
  if (!participation) return;

  const limit  = Math.min(parseInt(req.query.limit) || PAGE_SIZE, 50);
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
        nextCursor, // pass as ?before= in the next request to get older messages
        hasMore: nextCursor !== null
      }
    }
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/chat/:bidId/message
// @desc    Send a TEXT or REVISED_OFFER message on a bid thread.
//          The socket gateway layer persists messages via this same logic
//          (see services/socketService.js), but this REST endpoint is exposed
//          so non-WebSocket clients (and tests) can also post messages.
// @access  Private (bid participants only)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:bidId/message', verifyToken, catchAsync(async (req, res, next) => {
  const { bidId }  = req.params;
  const { userId, role } = req.user;

  const participation = await verifyBidParticipant(bidId, userId, next);
  if (!participation) return;

  const { bid, project, isContractor } = participation;

  if (bid.status !== 'PENDING') {
    return next(Object.assign(
      new Error(`Cannot send messages on a bid with status '${bid.status}'.`),
      { statusCode: 409, isOperational: true }
    ));
  }

  const { messageType = 'TEXT', text, revisedAmount, revisedDays } = req.body;

  if (!['TEXT', 'REVISED_OFFER'].includes(messageType)) {
    return next(Object.assign(
      new Error("messageType must be 'TEXT' or 'REVISED_OFFER'."),
      { statusCode: 400, isOperational: true }
    ));
  }

  const recipientId = isContractor
    ? project.clientId
    : bid.contractorId;

  const payload = { text };
  if (messageType === 'REVISED_OFFER') {
    payload.revisedAmount = Number(revisedAmount);
    payload.revisedDays   = Number(revisedDays);
  }

  const message = await Message.create({
    bidId,
    senderId:    userId,
    senderRole:  isContractor ? 'CONTRACTOR' : 'CLIENT',
    recipientId,
    messageType,
    payload
  });

  // Emit to the Socket.io room so connected clients receive it instantly.
  // The io instance is attached to app by socketService.js.
  const io = req.app.get('io');
  if (io) {
    io.to(bidId).emit('new_message', message);
  }

  res.status(201).json({ status: 'success', data: { message } });
}));

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/chat/:bidId/accept-offer
// @desc    Atomically accept the most recent REVISED_OFFER on this bid thread.
//
//          Transaction sequence (single MongoDB session):
//            1. Find the latest PENDING REVISED_OFFER message for this bid.
//            2. Mark that message's offerStatus → 'ACCEPTED'.
//            3. Mark all other PENDING REVISED_OFFERs on this bid → 'SUPERSEDED'.
//            4. Update the parent Bid: status → 'ACCEPTED', bidAmount and
//               estimatedDays → the values from the accepted offer payload.
//            5. Create an OFFER_ACCEPTED system message as the permanent record.
//            6. Commit. Any failure triggers an automatic rollback.
//
//          Only the CLIENT (project owner) may accept an offer.
//
// @access  Private (CLIENT only)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:bidId/accept-offer', verifyToken, catchAsync(async (req, res, next) => {
  const { bidId }  = req.params;
  const { userId } = req.user;

  const participation = await verifyBidParticipant(bidId, userId, next);
  if (!participation) return;

  const { bid, project, isClient } = participation;

  if (!isClient) {
    return next(Object.assign(
      new Error('Only the project owner (CLIENT) may accept a negotiated offer.'),
      { statusCode: 403, isOperational: true }
    ));
  }

  if (bid.status !== 'PENDING') {
    return next(Object.assign(
      new Error(`This bid is already in '${bid.status}' state and cannot be accepted.`),
      { statusCode: 409, isOperational: true }
    ));
  }

  // Find the most recent open revised offer to accept
  const offerToAccept = await Message.findOne({
    bidId,
    messageType: 'REVISED_OFFER',
    offerStatus: 'PENDING'
  }).sort({ createdAt: -1 }).lean();

  if (!offerToAccept) {
    return next(Object.assign(
      new Error('No pending REVISED_OFFER found on this negotiation thread.'),
      { statusCode: 404, isOperational: true }
    ));
  }

  const { revisedAmount, revisedDays } = offerToAccept.payload;

  // ── ACID TRANSACTION ────────────────────────────────────────────────────────
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    // 1. Accept the target offer message
    await Message.updateOne(
      { _id: offerToAccept._id },
      { $set: { offerStatus: 'ACCEPTED' } },
      { session }
    );

    // 2. Supersede any other pending offers on this thread
    await Message.updateMany(
      { bidId, messageType: 'REVISED_OFFER', offerStatus: 'PENDING', _id: { $ne: offerToAccept._id } },
      { $set: { offerStatus: 'SUPERSEDED' } },
      { session }
    );

    // 3. Mutate the parent Bid document to reflect the accepted terms
    await Bid.findByIdAndUpdate(
      bidId,
      {
        $set: {
          status:       'ACCEPTED',
          bidAmount:    revisedAmount,
          estimatedDays: revisedDays
        }
      },
      { session, runValidators: false } // skip fingerprint/breakdown validators; terms are authoritative
    );

    // 4. Write an immutable OFFER_ACCEPTED system message as the audit record
    const [acceptedMsg] = await Message.create([{
      bidId,
      senderId:    userId,
      senderRole:  'CLIENT',
      recipientId: bid.contractorId,
      messageType: 'OFFER_ACCEPTED',
      payload: {
        text:          'Offer accepted. The bid terms have been updated.',
        acceptedAmount: revisedAmount,
        acceptedDays:   revisedDays
      },
      offerStatus: 'ACCEPTED'
    }], { session });

    await session.commitTransaction();

    // Broadcast the terminal event to the room
    const io = req.app.get('io');
    if (io) {
      io.to(bidId).emit('offer_accepted', {
        bidId,
        acceptedAmount: revisedAmount,
        acceptedDays:   revisedDays,
        message: acceptedMsg
      });
    }

    res.status(200).json({
      status: 'success',
      message: 'Offer accepted. Bid terms updated atomically.',
      data: {
        acceptedAmount: revisedAmount,
        acceptedDays:   revisedDays,
        systemMessage:  acceptedMsg
      }
    });

  } catch (err) {
    await session.abortTransaction();

    // Surface a friendly error if the deployment doesn't support transactions
    if (err.codeName === 'IllegalOperation' || err.code === 20) {
      return next(Object.assign(
        new Error('Atomic transactions require a MongoDB replica set. Contact the platform administrator.'),
        { statusCode: 503, isOperational: true }
      ));
    }
    throw err; // re-throw for the global error handler
  } finally {
    session.endSession();
  }
}));

module.exports = router;
