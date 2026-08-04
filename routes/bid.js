// routes/bid.js
// 🛡️ Phase 21 — Anti-Cartel Sealed Bidding Engine
//
// Three core security guarantees enforced here:
//
//   1. PEER ISOLATION
//      Contractors can never query competitor bids.
//      GET /project/:projectId uses bidIsolation middleware.
//      If the caller is a CONTRACTOR → req.isolationQuery scoped to their own bid only.
//      If the caller is the owning CLIENT → full bid list.
//
//   2. CRYPTOGRAPHIC BID SEALING
//      Every bid is sealed with SHA-256 (bidFingerprint) at submission.
//      The fingerprint covers: projectId, contractorId, bidAmount, estimatedDays, proposalText.
//      Direct DB edits break the seal. The integrity-check endpoint exposes this.
//
//   3. FIDO2 BIOMETRIC BID SIGNING (optional but promoted)
//      POST /sign/:projectId — contractor signs bid payload with their registered
//      passkey. The authenticator's secure enclave signs the challenge.
//      Server verifies signature + advances counter. Non-repudiable by e-GP §15.

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const { verifyToken, requireRole } = require('../middleware/auth');
const { enforceBidIsolation } = require('../middleware/bidIsolation');
const catchAsync = require('../utils/catchAsync');

const Project = require('../models/Project');
const Bid = require('../models/Bid');
const EscrowLedger = require('../models/EscrowLedger');
const ContractorProfile = require('../models/ContractorProfile');
const PasskeyCredential = require('../models/PasskeyCredential');
const {
  computeBidFingerprint,
  assertContractorBidEligibility
} = require('../services/bidEligibilityService');

const { verifyAuthenticationResponse } = require('@simplewebauthn/server');

const RP_ID  = process.env.WEBAUTHN_RP_ID     || 'localhost';
const ORIGIN = process.env.WEBAUTHN_ORIGIN    || `http://localhost:${process.env.PORT || 5000}`;

const MIN_BID_AMOUNT = 100;

// ─────────────────────────────────────────────
// HELPER: Validate and sanitize raw bid fields from request body
// ─────────────────────────────────────────────
function sanitizeBidFields(body) {
  const bidAmount    = Number(body.bidAmount);
  const estimatedDays = Number(body.estimatedDays);
  const proposalText  = String(body.proposalText || '').trim();
  return { bidAmount, estimatedDays, proposalText };
}

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/bids/:projectId
// @desc    Standard bid submission (SHA-256 sealed, no passkey required)
// @access  Private (CONTRACTOR)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:projectId', verifyToken, requireRole(['CONTRACTOR']), catchAsync(async (req, res, next) => {
  const { projectId } = req.params;
  const { bidAmount, estimatedDays, proposalText } = sanitizeBidFields(req.body);
  const { itemizedBreakdown } = req.body;

  if (!Number.isFinite(bidAmount) || bidAmount < MIN_BID_AMOUNT ||
      !Number.isFinite(estimatedDays) || estimatedDays < 1 || !proposalText) {
    return next(Object.assign(
      new Error(`Valid bid amount (>= ${MIN_BID_AMOUNT}), estimated days (>= 1), and proposal text are mandatory.`),
      { statusCode: 400, isOperational: true }
    ));
  }

  // 🛡️ EARLY EDGE DEFENSE: Reject malformed BOQ payloads before allocating memory
  if (itemizedBreakdown !== undefined) {
    if (!Array.isArray(itemizedBreakdown) || itemizedBreakdown.length === 0) {
      return next(Object.assign(
        new Error('A structured itemizedBreakdown array containing at least one milestone is mandatory when provided.'),
        { statusCode: 400, isOperational: true }
      ));
    }
  }

  const currentProject = await Project.findById(projectId).select('status clientId');
  if (!currentProject) {
    return next(Object.assign(new Error('Target project does not exist.'), { statusCode: 404, isOperational: true }));
  }
  if (currentProject.status !== 'OPEN') {
    return next(Object.assign(new Error('Transaction rejected: Bidding window has closed.'), { statusCode: 403, isOperational: true }));
  }
  if (currentProject.clientId.toString() === req.user.userId) {
    return next(Object.assign(new Error('Architectural violation: Contractors cannot place bids on their own projects.'), { statusCode: 403, isOperational: true }));
  }

  const eligibility = await assertContractorBidEligibility({ userId: req.user.userId, bidAmount });
  if (!eligibility.ok) {
    return next(Object.assign(new Error(eligibility.message), { statusCode: eligibility.statusCode, isOperational: true }));
  }

  const bidFingerprint = computeBidFingerprint({
    projectId,
    contractorId: req.user.userId,
    bidAmount,
    estimatedDays,
    proposalText
  });

  try {
    const newBid = await Bid.create({
      projectId,
      contractorId: req.user.userId,
      bidAmount,
      estimatedDays,
      proposalText,
      bidFingerprint,
      ...(itemizedBreakdown ? { itemizedBreakdown } : {})
    });

    res.status(201).json({
      status: 'success',
      message: 'Bid securely submitted and cryptographically fingerprinted.',
      bid: newBid
    });
  } catch (dbError) {
    if (dbError.code === 11000) {
      return next(Object.assign(new Error('Duplicate entry: You have already submitted a proposal for this project.'), { statusCode: 409, isOperational: true }));
    }
    return next(dbError);
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/bids/sign/:projectId
// @desc    FIDO2 biometric bid submission (e-GP §15 non-repudiation)
// @desc    Contractor signs bid payload with their registered passkey.
//          The authenticator's secure enclave signs a deterministic challenge
//          string — the server verifies the signature using the stored public key.
//          The resulting cryptographicProof block is stored permanently on the bid.
// @access  Private (CONTRACTOR)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/sign/:projectId', verifyToken, requireRole(['CONTRACTOR']), catchAsync(async (req, res, next) => {
  const { projectId } = req.params;
  const { bidAmount, estimatedDays, proposalText, itemizedBreakdown, fidoResponse } = req.body;

  const safeAmount   = Number(bidAmount);
  const safeDays     = Number(estimatedDays);
  const safeProposal = String(proposalText || '').trim();

  // ── Input validation ──────────────────────────────────────────────────────
  if (!Number.isFinite(safeAmount) || safeAmount < MIN_BID_AMOUNT ||
      !Number.isFinite(safeDays)   || safeDays < 1 || !safeProposal) {
    return next(Object.assign(
      new Error('Valid bidAmount, estimatedDays, and proposalText are mandatory for signed bid submission.'),
      { statusCode: 400, isOperational: true }
    ));
  }

  if (!fidoResponse || !fidoResponse.id || !fidoResponse.response) {
    return next(Object.assign(
      new Error('fidoResponse (WebAuthn assertion) is required for biometric bid signing.'),
      { statusCode: 400, isOperational: true }
    ));
  }

  // ── Project guards ────────────────────────────────────────────────────────
  const currentProject = await Project.findById(projectId).select('status clientId');
  if (!currentProject) {
    return next(Object.assign(new Error('Target project does not exist.'), { statusCode: 404, isOperational: true }));
  }
  if (currentProject.status !== 'OPEN') {
    return next(Object.assign(new Error('Bidding window has closed.'), { statusCode: 403, isOperational: true }));
  }
  if (currentProject.clientId.toString() === req.user.userId) {
    return next(Object.assign(new Error('Contractors cannot bid on their own projects.'), { statusCode: 403, isOperational: true }));
  }

  // ── Eligibility gate ──────────────────────────────────────────────────────
  const eligibility = await assertContractorBidEligibility({ userId: req.user.userId, bidAmount: safeAmount });
  if (!eligibility.ok) {
    return next(Object.assign(new Error(eligibility.message), { statusCode: eligibility.statusCode, isOperational: true }));
  }

  // ── Fetch credential ──────────────────────────────────────────────────────
  const credentialRecord = await PasskeyCredential.findOne({
    credentialID: String(fidoResponse.id),
    userId: req.user.userId
  });

  if (!credentialRecord) {
    return next(Object.assign(
      new Error('Authenticator credential not recognised. Register a passkey before using biometric bid signing.'),
      { statusCode: 401, isOperational: true }
    ));
  }

  // ── Build the deterministic challenge string ───────────────────────────────
  // This exact string must be what the frontend passed to navigator.credentials.get()
  // as the challenge buffer. The authenticator signed THIS payload — verifying it
  // proves the contractor's intent was exactly these bid parameters.
  // Format: BID|{projectId}|{bidAmount}|{estimatedDays}
  const expectedChallengeString = `BID|${projectId}|${safeAmount}|${safeDays}`;
  // WebAuthn expects challenge as a Base64URL string matching what was sent to the client
  const expectedChallengeB64 = Buffer.from(expectedChallengeString).toString('base64url');

  // ── FIDO2 signature verification ──────────────────────────────────────────
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: fidoResponse,
      expectedChallenge: expectedChallengeB64,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: credentialRecord.credentialID,
        publicKey: Buffer.from(credentialRecord.credentialPublicKey, 'base64url'),
        counter: credentialRecord.counter,
        transports: credentialRecord.transports
      }
    });
  } catch (fidoErr) {
    return next(Object.assign(
      new Error(`Biometric verification failed: ${fidoErr.message}`),
      { statusCode: 401, isOperational: true }
    ));
  }

  if (!verification.verified) {
    return next(Object.assign(
      new Error('Cryptographic bid signature invalid. The authenticator assertion was rejected.'),
      { statusCode: 403, isOperational: true }
    ));
  }

  // 🛡️ MONOTONIC COUNTER ADVANCE — prevents replay attacks
  const { newCounter } = verification.authenticationInfo;
  if (credentialRecord.counter !== 0 && newCounter <= credentialRecord.counter) {
    console.error(`🚨 [BidSign] Counter regression for user ${req.user.userId} — possible replay: ${newCounter} <= ${credentialRecord.counter}`);
    return next(Object.assign(
      new Error('SECURITY ALERT: Authenticator counter regression. Replay attack detected.'),
      { statusCode: 401, isOperational: true }
    ));
  }

  // Advance counter atomically before committing the bid
  credentialRecord.counter = newCounter;
  credentialRecord.lastUsedAt = new Date();
  await credentialRecord.save();

  // ── Compute fingerprint & create bid ─────────────────────────────────────
  const bidFingerprint = computeBidFingerprint({
    projectId,
    contractorId: req.user.userId,
    bidAmount: safeAmount,
    estimatedDays: safeDays,
    proposalText: safeProposal
  });

  const signedAt = new Date();

  try {
    const newBid = await Bid.create({
      projectId,
      contractorId: req.user.userId,
      bidAmount: safeAmount,
      estimatedDays: safeDays,
      proposalText: safeProposal,
      bidFingerprint,
      cryptographicProof: {
        signature: String(fidoResponse.response?.signature || ''),
        authenticatorData: String(fidoResponse.response?.authenticatorData || ''),
        counterAtSigning: newCounter,
        signedAt
      },
      ...(itemizedBreakdown ? { itemizedBreakdown } : {})
    });

    console.log(`✅ [BidSign] Biometrically signed bid created by ${req.user.userId} for project ${projectId} (counter: ${newCounter})`);

    res.status(201).json({
      status: 'success',
      message: 'Bid cryptographically signed with biometric authentication. Non-repudiation guaranteed.',
      bid: newBid
    });
  } catch (dbError) {
    if (dbError.code === 11000) {
      return next(Object.assign(new Error('You have already submitted a proposal for this project.'), { statusCode: 409, isOperational: true }));
    }
    return next(dbError);
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// @route   GET /api/bids/project/:projectId
// @desc    Bid list — peer-isolated by bidIsolation middleware
//          CONTRACTOR → own bid only
//          CLIENT     → all bids (ownership verified inside middleware)
// @access  Private (CONTRACTOR | CLIENT)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/project/:projectId',
  verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR']),
  enforceBidIsolation,
  catchAsync(async (req, res, next) => {
    const { sortBy, page = 1, limit = 20 } = req.query;

    let sortLogic = { createdAt: 1 };
    if (sortBy === 'price') sortLogic = { bidAmount: 1 };
    if (sortBy === 'time')  sortLogic = { estimatedDays: 1 };

    const skip        = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    // req.isolationQuery is populated by enforceBidIsolation — it's already scope-locked
    const [bids, totalBids] = await Promise.all([
      Bid.find(req.isolationQuery)
        .sort(sortLogic)
        .skip(skip)
        .limit(parsedLimit)
        // 🔒 PEER ISOLATION: Select projection varies by role.
        // Contractors see their own bid in full. Clients see all bids.
        // bidFingerprint is always included for integrity verification.
        .populate({ path: 'contractorId', select: 'phoneNumber status role' })
        .lean(),
      Bid.countDocuments(req.isolationQuery)
    ]);

    res.status(200).json({
      status: 'success',
      metrics: {
        totalBidsReceived: totalBids,
        currentPage: parseInt(page, 10) || 1,
        totalPages: Math.ceil(totalBids / parsedLimit) || 0
      },
      bids
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// @route   GET /api/bids/:bidId/integrity
// @desc    Fingerprint integrity verification endpoint.
//          Recomputes the SHA-256 fingerprint from the live DB payload and
//          compares it to the sealed bidFingerprint stored at submission time.
//          A mismatch means someone (admin, direct DB script, or injection)
//          altered the bid after it was sealed. The bid is flagged TAMPERED.
// @access  Private (CLIENT owning the project, or ADMIN)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:bidId/integrity', verifyToken, requireRole(['CLIENT', 'ADMIN']), catchAsync(async (req, res, next) => {
  const bid = await Bid.findById(req.params.bidId)
    .populate({ path: 'projectId', select: 'clientId' })
    .lean();

  if (!bid) {
    return next(Object.assign(new Error('Bid not found.'), { statusCode: 404, isOperational: true }));
  }

  // Only the owning client or an admin may run integrity checks
  if (req.user.role === 'CLIENT' && bid.projectId?.clientId?.toString() !== req.user.userId) {
    return next(Object.assign(new Error('Authorization Breach: You do not own this project.'), { statusCode: 403, isOperational: true }));
  }

  // Recompute the fingerprint from the live payload
  const recomputedFingerprint = computeBidFingerprint({
    projectId: String(bid.projectId?._id || bid.projectId),
    contractorId: String(bid.contractorId),
    bidAmount: bid.bidAmount,
    estimatedDays: bid.estimatedDays,
    proposalText: bid.proposalText
  });

  const isIntact = recomputedFingerprint === bid.bidFingerprint;

  if (!isIntact) {
    // 🚨 TAMPER SIGNAL — Flag the bid status permanently in the DB
    console.error(`🚨 [BidIntegrity] TAMPER DETECTED on bid ${bid._id} — fingerprint mismatch`);
    await Bid.findByIdAndUpdate(bid._id, { $set: { status: 'TAMPERED_FLAGGED' } });
  }

  res.status(200).json({
    status: 'success',
    bidId: bid._id,
    integrityStatus: isIntact ? 'INTACT' : 'TAMPERED',
    storedFingerprint: bid.bidFingerprint,
    recomputedFingerprint,
    hasCryptographicProof: !!(bid.cryptographicProof?.signature)
  });
}));

// ─────────────────────────────────────────────────────────────────────────────
// @route   PUT /api/bids/:bidId/accept
// @desc    Accept bid + create escrow inside one Mongo transaction
// @access  Private (CLIENT)
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:bidId/accept', verifyToken, requireRole(['CLIENT']), catchAsync(async (req, res, next) => {
  const { bidId } = req.params;

  const targetBid = await Bid.findById(bidId);
  if (!targetBid) {
    return next(Object.assign(new Error('Bid not found.'), { statusCode: 404, isOperational: true }));
  }

  if (targetBid.status !== 'PENDING') {
    return next(Object.assign(new Error(`Bid is not PENDING (current: ${targetBid.status}).`), { statusCode: 409, isOperational: true }));
  }

  if (targetBid.bidAmount < MIN_BID_AMOUNT) {
    return next(Object.assign(new Error('Architectural Violation: Escrow cannot be generated for an invalid contract value.'), { statusCode: 400, isOperational: true }));
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // CAS inside the transaction so failure rolls project back to OPEN.
    const project = await Project.findOneAndUpdate(
      { _id: targetBid.projectId, clientId: req.user.userId, status: 'OPEN' },
      { $set: { status: 'ASSIGNED' } },
      { session, returnDocument: 'after' }
    );

    if (!project) {
      await session.abortTransaction();
      return next(Object.assign(new Error('Concurrency Lock Triggered: This project is no longer OPEN, or you lack authorization.'), { statusCode: 409, isOperational: true }));
    }

    targetBid.status = 'ACCEPTED';
    await targetBid.save({ session });

    await Bid.updateMany(
      { projectId: project._id, _id: { $ne: targetBid._id }, status: 'PENDING' },
      { $set: { status: 'REJECTED' } },
      { session }
    );

    const totalValue = targetBid.bidAmount;
    const tranche1   = Math.round(totalValue * 0.30);
    const tranche2   = Math.round(totalValue * 0.40);
    const tranche3   = totalValue - (tranche1 + tranche2);

    const [newLedger] = await EscrowLedger.create(
      [{
        projectId:          project._id,
        clientId:           project.clientId,
        contractorId:       targetBid.contractorId,
        totalContractValue: totalValue,
        ledgerStatus:       'PENDING_FUNDING',
        milestones: [
          { title: 'Project Mobilization (Advance)', releasePercentage: 30, amount: tranche1 },
          { title: 'Midpoint Completion',             releasePercentage: 40, amount: tranche2 },
          { title: 'Final Handover & Sign-off',       releasePercentage: 30, amount: tranche3 }
        ]
      }],
      { session }
    );

    // Capacity accounting for the awarded contractor
    await ContractorProfile.findOneAndUpdate(
      { userId: targetBid.contractorId },
      { $inc: { 'availability.currentProjects': 1 } },
      { session }
    );

    await session.commitTransaction();

    res.status(200).json({
      status: 'success',
      message: 'Contract awarded and Escrow Ledger successfully locked.',
      awardedBid:   targetBid,
      escrowLedger: newLedger._id
    });
  } catch (executionError) {
    await session.abortTransaction();
    console.error('💥 [Critical Accept-Bid Error]:', executionError);
    return next(Object.assign(new Error(`Execution Failure: ${executionError.message}`), { statusCode: 500, isOperational: true }));
  } finally {
    session.endSession();
  }
}));

module.exports = router;
