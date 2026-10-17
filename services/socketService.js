// services/socketService.js
// Phase 26 — Authenticated Real-Time Negotiation Gateway
//
// Architecture:
//   Socket.io is initialized with the raw http.Server (not Express app) so it
//   shares the same port as the REST API. The io instance is attached to the
//   Express app object (app.set('io', io)) so REST routes can emit events into
//   the same rooms.
//
// Security model:
//   - Every Socket.io connection goes through a JWT handshake middleware.
//     Unauthenticated sockets are disconnected before any event handler fires.
//   - Room names are MongoDB ObjectId strings of the bid. Clients call
//     `join_room` with a bidId; the server verifies the caller is a participant
//     before admitting them. This prevents bid snooping via room guessing.
//   - Messages are persisted to MongoDB BEFORE being emitted to the room.
//     This ensures the database is always the source of truth even if a
//     client disconnects mid-flight.

const { Server } = require('socket.io');
const jwt        = require('jsonwebtoken');
const User       = require('../models/User');
const Bid        = require('../models/Bid');
const Project    = require('../models/Project');
const Message    = require('../models/Message');

// ─────────────────────────────────────────────
// JWT Handshake Middleware
// Extracts the token from socket.handshake.auth.token, verifies it,
// and populates socket.data.user before the connection is established.
// ─────────────────────────────────────────────
async function jwtHandshake(socket, next) {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('AUTH_MISSING: No authentication token provided in handshake.'));
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtErr) {
      const msg = jwtErr.name === 'TokenExpiredError'
        ? 'AUTH_EXPIRED: Session token has expired.'
        : 'AUTH_INVALID: Invalid authentication signature.';
      return next(new Error(msg));
    }

    // Verify the user account is still active
    const user = await User.findById(decoded.userId).select('status role').lean();
    if (!user || user.status !== 'ACTIVE') {
      return next(new Error('AUTH_DENIED: Account is suspended or unverified.'));
    }

    // Attach sanitized identity to the socket for use in event handlers
    socket.data.user = {
      userId: String(user._id),
      role:   user.role
    };

    next();
  } catch (err) {
    next(new Error('AUTH_ERROR: Handshake authentication failed.'));
  }
}

// ─────────────────────────────────────────────
// HELPER: Verify a user is a participant in a bid thread.
// Returns { bid, isClient, isContractor } or null on failure.
// ─────────────────────────────────────────────
async function checkParticipant(bidId, userId) {
  const bid = await Bid.findById(bidId).select('contractorId projectId status').lean();
  if (!bid) return null;

  const project = await Project.findById(bid.projectId).select('clientId').lean();
  if (!project) return null;

  const isContractor = bid.contractorId.toString() === userId;
  const isClient     = project.clientId.toString()  === userId;

  if (!isContractor && !isClient) return null;

  return { bid, project, isContractor, isClient };
}

// ─────────────────────────────────────────────
// initializeSocket
// Call once from server.js, passing the http.Server and Express app.
// ─────────────────────────────────────────────
function initializeSocket(httpServer, app) {
  // 🛡️ Phase-3 P1 fix: Socket.io CORS must mirror the HTTP tier. The '*'
  // fallback is only kept for dev/test; in production the server.js boot
  // assertion rejects an unset or '*' CORS_ORIGIN before we reach here.
  const cfg = (process.env.CORS_ORIGIN || '').trim();
  const socketOrigin = cfg || (process.env.NODE_ENV === 'production' ? false : '*');
  const io = new Server(httpServer, {
    cors: {
      origin:  socketOrigin,
      methods: ['GET', 'POST']
    },
    // Use polling as fallback for environments that block WebSocket upgrades
    transports: ['websocket', 'polling']
  });

  // ── Global JWT handshake guard ──────────────────────────────────────────────
  io.use(jwtHandshake);

  io.on('connection', (socket) => {
    const { userId, role } = socket.data.user;
    console.log(`🔌 [Socket] User ${userId} (${role}) connected — socket ${socket.id}`);

    // ── join_room ─────────────────────────────────────────────────────────────
    // Client emits: { bidId: '<MongoObjectId>' }
    // Server verifies participation then joins the socket to that room.
    socket.on('join_room', async ({ bidId } = {}) => {
      try {
        if (!bidId) {
          return socket.emit('error', { code: 'INVALID_BID', message: 'bidId is required.' });
        }

        const participation = await checkParticipant(bidId, userId);
        if (!participation) {
          return socket.emit('error', {
            code:    'ACCESS_DENIED',
            message: 'You are not a participant in this negotiation thread.'
          });
        }

        socket.join(bidId);
        socket.emit('room_joined', { bidId });
        console.log(`📥 [Socket] User ${userId} joined room ${bidId}`);
      } catch (err) {
        console.error(`[Socket] join_room error: ${err.message}`);
        socket.emit('error', { code: 'SERVER_ERROR', message: 'Failed to join room.' });
      }
    });

    // ── send_message ─────────────────────────────────────────────────────────
    // Client emits: { bidId, messageType, text, revisedAmount?, revisedDays? }
    // Server persists the message, then broadcasts 'new_message' to the room.
    socket.on('send_message', async (data = {}) => {
      try {
        const { bidId, messageType = 'TEXT', text, revisedAmount, revisedDays } = data;

        if (!bidId || !text) {
          return socket.emit('error', { code: 'INVALID_PAYLOAD', message: 'bidId and text are required.' });
        }

        if (!['TEXT', 'REVISED_OFFER'].includes(messageType)) {
          return socket.emit('error', { code: 'INVALID_TYPE', message: "messageType must be 'TEXT' or 'REVISED_OFFER'." });
        }

        const participation = await checkParticipant(bidId, userId);
        if (!participation) {
          return socket.emit('error', { code: 'ACCESS_DENIED', message: 'Not a participant in this thread.' });
        }

        const { bid, project, isContractor } = participation;

        if (bid.status !== 'PENDING') {
          return socket.emit('error', {
            code:    'BID_CLOSED',
            message: `Bid is in '${bid.status}' state. Negotiation is closed.`
          });
        }

        const recipientId = isContractor ? project.clientId : bid.contractorId;

        const payload = { text: String(text).trim().slice(0, 2000) };
        if (messageType === 'REVISED_OFFER') {
          const rAmount = Number(revisedAmount);
          const rDays   = Number(revisedDays);
          if (!rAmount || rAmount < 100 || !rDays || rDays < 1) {
            return socket.emit('error', {
              code:    'INVALID_OFFER',
              message: 'REVISED_OFFER requires valid revisedAmount (≥100) and revisedDays (≥1).'
            });
          }
          payload.revisedAmount = rAmount;
          payload.revisedDays   = rDays;
        }

        // Persist first — emit only on success
        const message = await Message.create({
          bidId,
          senderId:   userId,
          senderRole: isContractor ? 'CONTRACTOR' : 'CLIENT',
          recipientId,
          messageType,
          payload
        });

        // Broadcast to all sockets in the room (including sender for confirmation)
        io.to(bidId).emit('new_message', message);

      } catch (err) {
        console.error(`[Socket] send_message error: ${err.message}`);
        socket.emit('error', { code: 'SERVER_ERROR', message: 'Message could not be delivered.' });
      }
    });

    // ── leave_room ────────────────────────────────────────────────────────────
    socket.on('leave_room', ({ bidId } = {}) => {
      if (bidId) socket.leave(bidId);
    });

    socket.on('disconnect', (reason) => {
      console.log(`🔌 [Socket] User ${userId} disconnected (${reason})`);
    });
  });

  // Attach the io instance to the Express app so REST routes can emit events
  app.set('io', io);

  console.log('🔌 Socket.io negotiation gateway initialized.');
  return io;
}

module.exports = { initializeSocket };
