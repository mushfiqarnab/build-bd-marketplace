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
//      Server verifies signature + advances counter. Non-repudiable under Build-BD policy.

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const { verifyToken, requireRole } = require('../middleware/auth');
const { enforceBidIsolation } = require('../middleware/bidIsolation');
const { emitAudit } = require('../services/auditService');
const catchAsync = require('../utils/catchAsync');
const { maskPhone } = require('../utils/dto');
const { runTransaction } = require('../utils/transaction');

const Project = require('../models/Project');
const Bid = require('../models/Bid');
const EscrowLedger = require('../models/EscrowLedger');
const ContractorProfile = require('../models/ContractorProfile');
const PasskeyCredential = require('../models/PasskeyCredential');
const {
  computeBidFingerprint,
  assertContractorBidEligibility
} = require('../services/bidEligibilityService');
const { finalizeBidAward, buildMilestones } = require('../services/bidAwardService');

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

// Each line item becomes an escrow milestone at accept time, so every amount
// must be a positive whole-taka value. A negative item can still sum to the
// bid total, and would otherwise only fail (as a 500) when the client accepts.
function lineItemAmountError(itemizedBreakdown) {
  if (!Array.isArray(itemizedBreakdown)) return null;
  const bad = itemizedBreakdown.findIndex((item) =>
    !item || !Number.isInteger(item.amount) || item.amount < 1);
  if (bad === -1) return null;
  return Object.assign(
    new Error(`itemizedBreakdown[${bad}].amount must be a whole number of taka, at least 1.`),
    { statusCode: 400, isOperational: true }
  );
}

// Cross-field validation (Roadmap §1.4 / Sync Guide §3.1): when itemizedBreakdown
// is provided, milestone amounts must sum to exactly the total bidAmount.
function breakdownSumError(itemizedBreakdown, bidAmount) {
  if (!Array.isArray(itemizedBreakdown) || itemizedBreakdown.length === 0) return null;
  const sum = itemizedBreakdown.reduce((acc, it) => acc + (Number(it && it.amount) || 0), 0);
  if (sum !== Math.round(Number(bidAmount))) {
    return Object.assign(
      new Error(`itemizedBreakdown amounts (${sum}) must sum to exactly bidAmount (${Math.round(Number(bidAmount))}).`),
      { statusCode: 400, isOperational: true }
    );
  }
  return null;
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
    const lineItemErr = lineItemAmountError(itemizedBreakdown);
    if (lineItemErr) return next(lineItemErr);
    const sumErr = breakdownSumError(itemizedBreakdown, bidAmount);
    if (sumErr) return next(sumErr);
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

  const withdrawnBid = await Bid.findOne({ projectId, contractorId: req.user.userId, status: 'WITHDRAWN' });
  if (withdrawnBid) {
    withdrawnBid.bidAmount = bidAmount;
    withdrawnBid.estimatedDays = estimatedDays;
    withdrawnBid.proposalText = proposalText;
    withdrawnBid.bidFingerprint = bidFingerprint;
    withdrawnBid.itemizedBreakdown = itemizedBreakdown || [];
    withdrawnBid.cryptographicProof = undefined;
    withdrawnBid.status = 'PENDING';
    await withdrawnBid.save();
    return res.status(201).json({
      status: 'success',
      message: 'Bid securely re-submitted and cryptographically fingerprinted.',
      bid: withdrawnBid
    });
  }

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
// @desc    FIDO2 biometric bid submission (cryptographic non-repudiation under Build-BD policy)
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

  const lineItemErr = lineItemAmountError(itemizedBreakdown);
  if (lineItemErr) return next(lineItemErr);
  const sumErr = breakdownSumError(itemizedBreakdown, bidAmount);
  if (sumErr) return next(sumErr);

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

  const withdrawnSignedBid = await Bid.findOne({ projectId, contractorId: req.user.userId, status: 'WITHDRAWN' });
  if (withdrawnSignedBid) {
    withdrawnSignedBid.bidAmount = safeAmount;
    withdrawnSignedBid.estimatedDays = safeDays;
    withdrawnSignedBid.proposalText = safeProposal;
    withdrawnSignedBid.bidFingerprint = bidFingerprint;
    withdrawnSignedBid.itemizedBreakdown = itemizedBreakdown || [];
    withdrawnSignedBid.cryptographicProof = {
      signature: String(fidoResponse.response?.signature || ''),
      authenticatorData: String(fidoResponse.response?.authenticatorData || ''),
      counterAtSigning: newCounter,
      signedAt
    };
    withdrawnSignedBid.status = 'PENDING';
    await withdrawnSignedBid.save();
    return res.status(201).json({
      status: 'success',
      message: 'Bid cryptographically signed with biometric authentication. Non-repudiation guaranteed.',
      bid: withdrawnSignedBid
    });
  }

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
// @route   GET /api/bids/mine
// @desc    The signed-in contractor's own bids, newest first, with the
//          project title/status/location. Never exposes other bidders.
// @access  Private (CONTRACTOR)
router.get('/mine',
  verifyToken,
  requireRole(['CONTRACTOR']),
  catchAsync(async (req, res) => {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const filter = { contractorId: req.user.userId };
    if (req.query.status) filter.status = String(req.query.status);

    const [bids, total] = await Promise.all([
      Bid.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('projectId bidAmount estimatedDays status createdAt updatedAt')
        .populate({ path: 'projectId', select: 'title category location budget status' })
        .lean(),
      Bid.countDocuments(filter)
    ]);

    res.status(200).json({
      status: 'success',
      metrics: { total, currentPage: page, totalPages: Math.ceil(total / limit) || 0 },
      bids: bids.map(({ projectId, ...b }) => ({
        ...b,
        projectId: projectId && projectId._id ? projectId._id : projectId,
        project: projectId || null
      }))
    });
  })
);

router.get('/project/:projectId',
  verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR']),
  enforceBidIsolation,
  catchAsync(async (req, res, next) => {
    const { sortBy, page = 1, limit = 20 } = req.query;

    let sortLogic = { createdAt: 1 };
    if (sortBy === 'price') sortLogic = { bidAmount: 1 };
    if (sortBy === 'time')  sortLogic = { estimatedDays: 1 };

    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const parsedPage  = Math.max(1, parseInt(page, 10) || 1);
    const skip        = (parsedPage - 1) * parsedLimit;

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

    // Audit G9: before an award a client sees WHO bid (profile name, masked phone) but cannot contact
    // them outside the platform. Contact opens up once the bid is accepted.
    if (req.user.role === 'CLIENT' && bids.length) {
      const profiles = await ContractorProfile.find({ userId: { $in: bids.map((b) => b.contractorId && b.contractorId._id).filter(Boolean) } })
        .select('userId fullName').lean();
      const nameById = new Map(profiles.map((p) => [String(p.userId), p.fullName]));
      for (const b of bids) {
        if (!b.contractorId) continue;
        b.contractorName = nameById.get(String(b.contractorId._id)) || null;
        if (b.status !== 'ACCEPTED') b.contractorId.phoneNumber = maskPhone(b.contractorId.phoneNumber);
      }
    }

    res.status(200).json({
      status: 'success',
      metrics: {
        totalBidsReceived: totalBids,
        currentPage: parsedPage,
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

  if (!['PENDING', 'ACCEPTED'].includes(targetBid.status)) {
    return next(Object.assign(new Error(`Bid is not PENDING (current: ${targetBid.status}).`), { statusCode: 409, isOperational: true }));
  }

  if (targetBid.bidAmount < MIN_BID_AMOUNT) {
    return next(Object.assign(new Error('Architectural Violation: Escrow cannot be generated for an invalid contract value.'), { statusCode: 400, isOperational: true }));
  }

  let awardedBid = null;
  let ledgerId = null;

  try {
    // runTransaction (utils/transaction.js) re-runs the whole callback on a TransientTransactionError
    // (WriteConflict, code 112). Everything is re-read inside it, so a retry that lost the race sees the
    // project ASSIGNED and fails the CAS with 409; a conflict that persists is a retryable 409, not a 500.
    await runTransaction(async (session) => {
      const bid = await Bid.findOne({ _id: targetBid._id, status: { $in: ['PENDING', 'ACCEPTED'] } }).session(session);
      if (!bid) {
        throw Object.assign(new Error('Bid is no longer PENDING.'), { statusCode: 409, isOperational: true });
      }

      bid.status = 'ACCEPTED';
      await bid.save({ session });

      // 🛡️ Phase-0 / §2 Roadmap fix: finalizeBidAward is the single source of truth for contract award
      const { project, ledger: newLedger } = await finalizeBidAward({
        session,
        project: { _id: bid.projectId, clientId: req.user.userId },
        bid,
        actorId: req.user.userId,
        actorRole: req.user.role,
        req
      });

      awardedBid = bid;
      ledgerId = newLedger._id;
    });

    res.status(200).json({
      status: 'success',
      message: 'Contract awarded and Escrow Ledger successfully locked.',
      awardedBid,
      escrowLedger: ledgerId
    });
  } catch (executionError) {
    if (executionError.isOperational) return next(executionError);
    if (executionError.code === 112 ||
        (executionError.hasErrorLabel && executionError.hasErrorLabel('TransientTransactionError'))) {
      return next(Object.assign(new Error('Another request changed this project at the same moment. Please refresh and retry.'), { statusCode: 409, isOperational: true, retryable: true }));
    }
    // Unexpected failure: log it, and let the global handler answer a generic
    // 500 instead of echoing raw database messages to the client.
    console.error('💥 [Critical Accept-Bid Error]:', executionError);
    return next(executionError);
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/bids/:bidId/withdraw
// @desc    Contractor withdraws their own PENDING bid. CAS prevents a race with
//          a client accepting the bid at the same instant: only (owner, PENDING)
//          bids transition — any other current state surfaces a 409.
// @access  Private (Strictly the contractor who owns this bid)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/:bidId/withdraw', verifyToken, requireRole(['CONTRACTOR']), catchAsync(async (req, res, next) => {
  const { bidId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(bidId)) {
    return next(Object.assign(new Error('Invalid bid ID format.'), { statusCode: 400, isOperational: true }));
  }

  const withdrawn = await Bid.findOneAndUpdate(
    { _id: bidId, contractorId: req.user.userId, status: 'PENDING' },
    { $set: { status: 'WITHDRAWN' } },
    { returnDocument: 'after' }
  );

  if (!withdrawn) {
    // Covers all three reasons uniformly to avoid leaking existence of someone
    // else's bid: not yours, not PENDING anymore (already accepted / rejected /
    // withdrawn / tamper-flagged), or no such bid.
    return next(Object.assign(
      new Error('Withdrawal rejected. Bid is not yours, or no longer in PENDING state.'),
      { statusCode: 409, isOperational: true }
    ));
  }

  res.status(200).json({
    status: 'success',
    message: 'Bid withdrawn.',
    bidId: withdrawn._id,
    bidStatus: withdrawn.status
  });
}));

module.exports = router;
