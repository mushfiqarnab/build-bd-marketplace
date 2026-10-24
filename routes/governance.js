// routes/governance.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

// Middleware & Utilities
const { verifyToken, requireRole, allowRoleOrScopedToken } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const { emitAudit } = require('../services/auditService');
const { generateUploadSignature, verifyObjectExists, validateUploadedObject, storageConfig, getSignedReadUrl } = require('../services/s3Service');
const { enforceIdempotency } = require('../middleware/idempotency');
const { creditPendingClearance, incWallet } = require('../services/settlementService');
const { unlockNextMilestone, settledLedgerStatus, clearanceDate } = require('../utils/money');
const { runTransaction } = require('../utils/transaction');
const { toLedgerDto } = require('../utils/dto');
const { onLedgerSettled } = require('../services/ledgerLifecycle');
const { notifyEvidenceSubmitted, notifyDisputeCreated } = require('../services/notificationService');

// Database Models
const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');
const DisputeTicket = require('../models/DisputeTicket');

/**
 * Appends one evidence entry and moves the milestone to PROOF_SUBMITTED, in a
 * retried transaction. Every rule the route checked beforehand is checked
 * AGAIN on the in-session read: the old code re-read the ledger but trusted
 * the earlier checks, so a photo committed while the client was approving
 * flipped a COMPLETED (already paid) milestone back to PROOF_SUBMITTED — and
 * it could be approved and paid a second time. A DISPUTED milestone could be
 * pulled out of arbitration the same way.
 */
async function commitEvidence({ ledgerId, idx, contractorId, entry, auditAction, auditMetadata, req }) {
  return runTransaction(async (session) => {
    const ledger = await EscrowLedger.findById(ledgerId).session(session);
    if (!ledger || ledger.contractorId.toString() !== contractorId) {
      throw Object.assign(new Error('Authorization Breach: You are not the assigned contractor.'), { statusCode: 403, isOperational: true });
    }
    const milestone = ledger.milestones[idx];
    if (!['FUNDED', 'PARTIALLY_DISBURSED'].includes(ledger.ledgerStatus) || !milestone
        || !['IN_PROGRESS', 'PROOF_SUBMITTED'].includes(milestone.status)) {
      throw Object.assign(
        new Error(`This milestone changed while your evidence was uploading (now '${milestone ? milestone.status : 'missing'}', escrow '${ledger.ledgerStatus}'). Nothing was recorded.`),
        { statusCode: 409, isOperational: true }
      );
    }
    const reused = await EscrowLedger.exists({ 'milestones.evidenceLog.imageHash': entry.imageHash }).session(session);
    if (reused) {
      throw Object.assign(
        new Error('Duplicate evidence: This image has already been submitted as evidence on another milestone. Each milestone requires unique photographic proof.'),
        { statusCode: 409, isOperational: true }
      );
    }

    milestone.evidenceLog = milestone.evidenceLog || [];
    milestone.evidenceLog.push({ ...entry, submittedAt: new Date() });
    // Advance to PROOF_SUBMITTED so the client can audit, approve, or dispute.
    milestone.status = 'PROOF_SUBMITTED';
    milestone.proofOfWorkUrl = entry.s3Key;
    if (!milestone.proofSubmittedAt) milestone.proofSubmittedAt = new Date();
    ledger.markModified('milestones');
    await ledger.save({ session });

    await emitAudit({
      session,
      entityId:   ledger._id,
      entityType: 'ESCROW_LEDGER',
      action:     auditAction,
      actorId:    req.user.userId,
      actorRole:  req.user.role,
      metadata:   { milestoneIndex: idx, ...auditMetadata },
      ipAddress:  req.ip || 'SYSTEM_INTERNAL'
    });
    return milestone.status;
  });
}

// Every /milestone/:milestoneIndex route: only a plain non-negative integer is
// an index. parseInt('abc') is NaN and slips past `idx < 0 || idx >= length`,
// then `milestones[NaN].status` throws a 500 (found by the state-machine fuzzer).
router.param('milestoneIndex', (req, res, next, value) => {
  if (!/^\d{1,4}$/.test(String(value))) {
    return next(Object.assign(new Error('Milestone index must be a non-negative whole number.'), { statusCode: 400, isOperational: true }));
  }
  return next();
});

// ==========================================
// @route   POST /api/governance/approve/:ledgerId/milestone/:milestoneIndex
// @desc    Atomically approve milestone and disburse fractional escrow funds
// @access  Private (Strictly assigned CLIENT only)
// ==========================================
router.post(
  '/approve/:ledgerId/milestone/:milestoneIndex',
  verifyToken,
  requireRole(['CLIENT']),
  enforceIdempotency,
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;
    const idx = parseInt(milestoneIndex, 10);

    const payload = await runTransaction(async (session) => {
      const ledger = await EscrowLedger.findById(ledgerId).session(session);
      if (!ledger) {
        const err = new Error('Target escrow ledger not found.');
        err.statusCode = 404;
        err.isOperational = true;
        throw err;
      }

      if (ledger.clientId.toString() !== req.user.userId) {
        const err = new Error('Authorization Breach: You do not own the client rights to liquidate this escrow.');
        err.statusCode = 403;
        err.isOperational = true;
        throw err;
      }

      if (ledger.ledgerStatus !== 'FUNDED' && ledger.ledgerStatus !== 'PARTIALLY_DISBURSED') {
        const err = new Error(`Transaction Rejected: Escrow ledger is currently '${ledger.ledgerStatus}'. Funds cannot be released.`);
        err.statusCode = 400;
        err.isOperational = true;
        throw err;
      }

      if (idx < 0 || idx >= ledger.milestones.length) {
        const err = new Error('Index Out of Bounds: The specified milestone identifier does not exist.');
        err.statusCode = 400;
        err.isOperational = true;
        throw err;
      }

      const targetMilestone = ledger.milestones[idx];
      if (targetMilestone.status !== 'PROOF_SUBMITTED') {
        const err = new Error(`Governance Exception: Milestone state must be 'PROOF_SUBMITTED'. Active state is '${targetMilestone.status}'.`);
        err.statusCode = 400;
        err.isOperational = true;
        throw err;
      }

      // 🛡️ Phase-4: one integer-BDT split shared with every other money path.
      const { contractor: contractorPayoutFinal, platform: platformFeeFinal } =
        await creditPendingClearance(session, { contractorId: ledger.contractorId, amount: targetMilestone.amount });
      const clearsAtDate = clearanceDate();

      ledger.milestones[idx].status = 'COMPLETED';
      ledger.milestones[idx].approvedAt = new Date();
      ledger.milestones[idx].settlementStatus = 'PENDING_CLEARANCE';
      ledger.milestones[idx].clearsAt = clearsAtDate;
      unlockNextMilestone(ledger.milestones);

      // REFUNDED / PAID_OFFLINE are terminal too — the old `!== 'COMPLETED'`
      // check meant a ledger with any refund could never reach FULLY_DISBURSED.
      const previousLedgerStatus = ledger.ledgerStatus;
      ledger.ledgerStatus = settledLedgerStatus(ledger.milestones);

      await ledger.save({ session });
      await onLedgerSettled(session, ledger, previousLedgerStatus); // frees the contractor's slot, completes the project

      await emitAudit({
        session,
        entityId: ledger._id,
        entityType: 'ESCROW_LEDGER',
        action: 'MILESTONE_APPROVED',
        actorId: req.user.userId,
        actorRole: req.user.role,
        metadata: {
          milestoneIndex: idx,
          grossAmount: targetMilestone.amount,
          contractorNet: contractorPayoutFinal,
          platformFee: platformFeeFinal
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      return {
        status: 'success',
        message: `Milestone ${idx} successfully approved. Funds atomically disbursed.`,
        disbursedAmounts: {
          totalGross: targetMilestone.amount,
          contractorNet: contractorPayoutFinal,
          platformCommission: platformFeeFinal
        },
        currentLedgerStatus: ledger.ledgerStatus
      };
    });

    // Operational errors keep their status; a conflict that outlives the
    // driver's retries is a 409 (utils/transaction.js); bugs become a 500.
    res.status(200).json(payload);
  })
);

// ==========================================
// @route   GET /api/governance/escrow/:projectId
// @desc    Retrieve escrow ledger details for an authorized client or contractor
// @access  Private (Strictly assigned CLIENT or CONTRACTOR)
// ==========================================
router.get(
  '/escrow/:projectId',
  verifyToken,
  allowRoleOrScopedToken(['CLIENT', 'CONTRACTOR'], ['FAMILY_VIEWER', 'SITE_WATCHER']),
  catchAsync(async (req, res, next) => {
    const { projectId } = req.params;

    if (req.user.isDelegate && req.user.projectId !== String(projectId)) {
      return next(Object.assign(new Error('Delegation token not authorized for this project.'), { statusCode: 403, isOperational: true }));
    }

    const ledger = await EscrowLedger.findOne({
      projectId,
      ...(req.user.isDelegate
        ? {}
        : {
            $or: [
              { clientId: req.user.userId },
              { contractorId: req.user.userId }
            ]
          })
    }).lean();

    if (!ledger) {
      const err = new Error('Escrow ledger not found or access denied.');
      err.statusCode = 404;
      err.isOperational = true;
      return next(err);
    }

    const dto = toLedgerDto(ledger);
    if (req.user.isDelegate && req.user.hideFinancials) {
      dto.totalContractValue = null;
      if (Array.isArray(dto.milestones)) {
        dto.milestones = dto.milestones.map((m) => ({
          ...m,
          amount: null,
          contractorPayoutBDT: null,
          platformFeeBDT: null
        }));
      }
    }

    res.status(200).json({
      status: 'success',
      data: dto
    });
  })
);

// ==========================================
// @route   GET /api/governance/proof/view/:ledgerId/milestone/:milestoneIndex/:evidenceIndex?
// @desc    Secure, authenticated stream of milestone proof images.
// @access  Private (Authorized CLIENT, CONTRACTOR for this ledger, or ADMIN/MODERATOR)
// ==========================================
router.get(
  [
    '/proof/view/:ledgerId/milestone/:milestoneIndex',
    '/proof/view/:ledgerId/milestone/:milestoneIndex/:evidenceIndex'
  ],
  verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR', 'ADMIN', 'MODERATOR']),
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex, evidenceIndex } = req.params;
    const idx = parseInt(milestoneIndex, 10);
    const evIdx = evidenceIndex !== undefined ? parseInt(evidenceIndex, 10) : null;

    if (!Number.isInteger(idx) || idx < 0) {
      return next(Object.assign(new Error('Invalid milestone index.'), { statusCode: 400, isOperational: true }));
    }

    const ledger = await EscrowLedger.findById(ledgerId).select('clientId contractorId milestones').lean();
    if (!ledger) {
      return next(Object.assign(new Error('Escrow ledger not found.'), { statusCode: 404, isOperational: true }));
    }

    const isParty = ledger.clientId.toString() === req.user.userId || ledger.contractorId.toString() === req.user.userId;
    const isStaff = ['ADMIN', 'MODERATOR'].includes(req.user.role);
    if (!isParty && !isStaff) {
      return next(Object.assign(new Error('Access Denied: You are not authorized to view evidence for this contract.'), { statusCode: 403, isOperational: true }));
    }

    const milestone = ledger.milestones && ledger.milestones[idx];
    if (!milestone) {
      return next(Object.assign(new Error('Milestone not found.'), { statusCode: 404, isOperational: true }));
    }

    let s3Key = null;
    if (evIdx !== null && Number.isInteger(evIdx) && milestone.evidenceLog && milestone.evidenceLog[evIdx]) {
      s3Key = milestone.evidenceLog[evIdx].s3Key;
    } else {
      s3Key = milestone.proofOfWorkUrl || (milestone.evidenceLog && milestone.evidenceLog[0] && milestone.evidenceLog[0].s3Key);
    }

    if (!s3Key) {
      return next(Object.assign(new Error('No evidence image recorded for this milestone.'), { statusCode: 404, isOperational: true }));
    }

    const storageProvider = storageConfig?.provider || 'local';
    if (storageProvider !== 'local' && !storageConfig?.isMock) {
      const signedReadUrl = await getSignedReadUrl(s3Key);
      return res.redirect(302, signedReadUrl);
    }

    const { resolveLocalConfig, assertSafeKey } = require('../services/localStorageAdapter');
    assertSafeKey(s3Key);

    const config = resolveLocalConfig(process.env);
    const filePath = path.join(config.dir, s3Key);

    if (!fs.existsSync(filePath)) {
      return next(Object.assign(new Error('Physical proof file not found in storage.'), { statusCode: 404, isOperational: true }));
    }

    let contentType = 'image/jpeg';
    try {
      const metaPath = filePath + '.meta.json';
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta && meta.contentType) contentType = meta.contentType;
      }
    } catch (_) { /* fallback to image/jpeg */ }

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(filePath).pipe(res);
  })
);

// ==========================================
// @route   GET /api/governance/audit-trail/:ledgerId
// @desc    Return immutable chronological history for an authorized ledger
// @access  Private (Strictly assigned CLIENT or CONTRACTOR)
// ==========================================
router.get(
  '/audit-trail/:ledgerId',
  verifyToken,
  allowRoleOrScopedToken(['CLIENT', 'CONTRACTOR'], ['FAMILY_VIEWER', 'SITE_WATCHER']),
  catchAsync(async (req, res, next) => {
    const { ledgerId } = req.params;

    const ledger = await EscrowLedger.findById(ledgerId).lean();
    if (!ledger) {
      const err = new Error('Escrow ledger not found.');
      err.statusCode = 404;
      err.isOperational = true;
      return next(err);
    }

    if (req.user.isDelegate) {
      if (req.user.projectId !== String(ledger.projectId)) {
        const err = new Error('Delegation token not authorized for this project.');
        err.statusCode = 403;
        err.isOperational = true;
        return next(err);
      }
    } else if (ledger.clientId.toString() !== req.user.userId && ledger.contractorId.toString() !== req.user.userId) {
      const err = new Error('Access denied: you are not a participant in this escrow.');
      err.statusCode = 403;
      err.isOperational = true;
      return next(err);
    }

    const auditTrail = await require('../models/AuditLog')
      .find({ entityId: ledgerId })
      .sort({ createdAt: 1 })
      .lean();

    res.status(200).json({
      status: 'success',
      data: auditTrail
    });
  })
);

// ==========================================
// 🛡️ TIER-1 CLOUD: STEP 1 - Generate Pre-Signed URL & Cryptographic Proof Token (CPT)
// @route   POST /api/governance/proof/signature/:ledgerId/milestone/:milestoneIndex
// @desc    Generate time-limited S3 pre-signed upload URL & cryptographic binding token
// @access  Private (Strictly assigned CONTRACTOR only)
// ==========================================
router.post(
  '/proof/signature/:ledgerId/milestone/:milestoneIndex',
  verifyToken,
  requireRole(['CONTRACTOR']),
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;
    const { contentType } = req.body;
    const idx = parseInt(milestoneIndex, 10);

    if (!contentType) {
      return next(Object.assign(new Error('contentType is required (e.g., application/pdf, image/jpeg).'), { statusCode: 400, isOperational: true }));
    }

    const ledger = await EscrowLedger.findById(ledgerId).lean();
    if (!ledger) {
      return next(Object.assign(new Error('Target escrow ledger not found.'), { statusCode: 404, isOperational: true }));
    }

    if (ledger.contractorId.toString() !== req.user.userId) {
      return next(Object.assign(new Error('Authorization Breach: You are not the assigned contractor for this escrow.'), { statusCode: 403, isOperational: true }));
    }

    if (idx < 0 || idx >= ledger.milestones.length) {
      return next(Object.assign(new Error('Milestone index out of bounds.'), { statusCode: 400, isOperational: true }));
    }

    const targetMilestone = ledger.milestones[idx];
    if (targetMilestone.status !== 'IN_PROGRESS') {
      return next(Object.assign(new Error(`Proof signature request rejected. Milestone status must be IN_PROGRESS. Current status: ${targetMilestone.status}`), { statusCode: 400, isOperational: true }));
    }

    if (ledger.ledgerStatus !== 'FUNDED' && ledger.ledgerStatus !== 'PARTIALLY_DISBURSED') {
      return next(Object.assign(new Error('Transaction Rejected: Escrow ledger must be funded by the client before construction proof of work can be submitted.'), { statusCode: 403, isOperational: true }));
    }

    const signature = await generateUploadSignature(ledgerId, idx, contentType);

    // 🛡️ CRYPTOGRAPHIC BINDING: Issue a short-lived token (CPT) signed with JWT_SECRET
    // Prevents Phantom Proof spoofing by binding the exact fileKey to this ledger and milestone
    const jwt = require('jsonwebtoken');
    const proofToken = jwt.sign(
      {
        fileKey: signature.fileKey,
        ledgerId: String(ledger._id),
        milestoneIndex: idx
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m', algorithm: 'HS256' }
    );

    res.status(200).json({
      status: 'success',
      message: 'Cloud upload signature and CPT generated successfully.',
      data: {
        ...signature,
        proofToken
      }
    });
  })
);

// ==========================================
// 🛡️ TIER-1 CLOUD: STEP 2 - Verify CPT & Execute ACID Confirmation
// @route   POST /api/governance/proof/confirm/:ledgerId/milestone/:milestoneIndex
// @desc    Cryptographically verify CPT, confirm cloud upload, and mutate state
// @access  Private (Strictly assigned CONTRACTOR only)
// ==========================================
router.post(
  '/proof/confirm/:ledgerId/milestone/:milestoneIndex',
  verifyToken,
  requireRole(['CONTRACTOR']),
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;
    const { proofToken } = req.body;
    const idx = parseInt(milestoneIndex, 10);

    if (!proofToken || typeof proofToken !== 'string') {
      return next(Object.assign(new Error('Cryptographic proofToken is required to confirm cloud upload.'), { statusCode: 400, isOperational: true }));
    }

    const jwt = require('jsonwebtoken');
    let decodedToken;
    try {
      decodedToken = jwt.verify(proofToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (jwtError) {
      return next(Object.assign(new Error('Invalid or expired proofToken. Please request a new upload signature.'), { statusCode: 401, isOperational: true }));
    }

    // 🛡️ TAMPER DEFENSE: Assert boundary match between token payload and route parameters
    if (decodedToken.ledgerId !== ledgerId || Number(decodedToken.milestoneIndex) !== idx) {
      return next(Object.assign(new Error('Token boundary violation: proofToken does not match target ledger or milestone.'), { statusCode: 403, isOperational: true }));
    }

    const verifiedFileKey = decodedToken.fileKey;

    // 🛡️ PHYSICAL RECONCILIATION GUARD: Assert the file object physically exists in S3 before committing transaction
    const fileExistsInCloud = await verifyObjectExists(verifiedFileKey);
    if (!fileExistsInCloud) {
      console.error(`🚨 PHYSICAL RECONCILIATION EXCEPTION: Phantom upload blocked for key: ${verifiedFileKey}`);
      return next(
        Object.assign(
          new Error('Upload physical verification failed. File object not found in cloud storage. Please complete the cloud upload before confirming.'),
          { statusCode: 400, isOperational: true }
        )
      );
    }

    await runTransaction(async (session) => {
      const ledger = await EscrowLedger.findById(ledgerId).session(session);
      if (!ledger) {
        throw Object.assign(new Error('Target escrow ledger not found.'), { statusCode: 404, isOperational: true });
      }

      if (ledger.contractorId.toString() !== req.user.userId) {
        throw Object.assign(new Error('Authorization Breach: You are not the assigned contractor for this escrow.'), { statusCode: 403, isOperational: true });
      }

      if (idx < 0 || idx >= ledger.milestones.length) {
        throw Object.assign(new Error('Milestone index out of bounds.'), { statusCode: 400, isOperational: true });
      }

      const targetMilestone = ledger.milestones[idx];
      if (targetMilestone.status !== 'IN_PROGRESS') {
        throw Object.assign(new Error(`Proof confirmation rejected. Milestone status must be IN_PROGRESS. Current status: ${targetMilestone.status}`), { statusCode: 400, isOperational: true });
      }

      if (ledger.ledgerStatus !== 'FUNDED' && ledger.ledgerStatus !== 'PARTIALLY_DISBURSED') {
        throw Object.assign(new Error('Transaction Rejected: Escrow ledger must be funded by the client before construction proof of work can be submitted.'), { statusCode: 403, isOperational: true });
      }

      ledger.milestones[idx].status = 'PROOF_SUBMITTED';
      ledger.milestones[idx].proofOfWorkUrl = verifiedFileKey;
      ledger.markModified('milestones');

      await ledger.save({ session });

      await emitAudit({
        session,
        entityId: ledger._id,
        entityType: 'ESCROW_LEDGER',
        action: 'PROOF_SUBMITTED',
        actorId: req.user.userId,
        actorRole: req.user.role,
        metadata: {
          milestoneIndex: idx,
          fileKey: verifiedFileKey
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });
    });

    res.status(200).json({
      status: 'success',
      message: 'Milestone proof successfully committed to the governance engine.',
      data: {
        fileKey: verifiedFileKey,
        status: 'PROOF_SUBMITTED'
      }
    });
  })
);

// ==========================================
// @route   POST /api/governance/dispute/:ledgerId/milestone/:milestoneIndex
// @desc    Client or Contractor triggers a dispute, freezing the ledger into IN_ARBITRATION state.
//          Contractors can escalate when client review has stalled for 7+ days (anti-withholding guard).
// @access  Private (Assigned CLIENT or CONTRACTOR)
// ==========================================
router.post(
  '/dispute/:ledgerId/milestone/:milestoneIndex',
  verifyToken,
  requireRole(['CLIENT', 'CONTRACTOR']),
  enforceIdempotency, // 🛡️ Phase-3 P1 fix: prevent double-fire on retry.
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;
    const { reason } = req.body;
    const idx = parseInt(milestoneIndex, 10);
    const userRole = req.user.role;
    const userId = req.user.userId;

    if (typeof reason !== 'string' || reason.trim().length < 10) {
      const err = new Error('A detailed dispute reason (minimum 10 characters) is required.');
      err.statusCode = 400;
      err.isOperational = true;
      return next(err);
    }

    // Pre-flight check for contractor dispute eligibility
    if (userRole === 'CONTRACTOR') {
      const preLedger = await EscrowLedger.findById(ledgerId).select('contractorId milestones').lean();
      if (!preLedger || String(preLedger.contractorId) !== String(userId)) {
        return next(Object.assign(
          new Error('Authorization Breach: You are not the assigned contractor for this contract.'),
          { statusCode: 403, isOperational: true }
        ));
      }
      const targetM = preLedger.milestones && preLedger.milestones[idx];
      if (!targetM || targetM.status !== 'PROOF_SUBMITTED') {
        return next(Object.assign(
          new Error(`Milestone must be in PROOF_SUBMITTED status to dispute. Current: ${targetM ? targetM.status : 'missing'}`),
          { statusCode: 400, isOperational: true }
        ));
      }
      const STALL_MS = Number(process.env.MILESTONE_STALL_DAYS || 7) * 24 * 60 * 60 * 1000;
      const proofDate = targetM.proofSubmittedAt || (targetM.evidenceLog?.length ? targetM.evidenceLog[targetM.evidenceLog.length - 1].submittedAt : null);
      const isStalled = targetM.escalatedAt || (proofDate && (Date.now() - new Date(proofDate).getTime() >= STALL_MS));
      if (!isStalled) {
        return next(Object.assign(
          new Error('A contractor may only open a dispute on a milestone that has been pending client review for 7+ days.'),
          { statusCode: 403, isOperational: true }
        ));
      }
    }

    const query = {
      _id: ledgerId,
      ...(userRole === 'CONTRACTOR' ? { contractorId: userId } : { clientId: userId }),
      ledgerStatus: { $in: ['FUNDED', 'PARTIALLY_DISBURSED'] },
      [`milestones.${idx}.status`]: 'PROOF_SUBMITTED'
    };

    const updatePayload = {
      $set: {
        [`milestones.${idx}.status`]: 'DISPUTED',
        [`milestones.${idx}.disputeReason`]: reason.trim(),
        [`milestones.${idx}.disputedBy`]: userRole,
        ledgerStatus: 'IN_ARBITRATION'
      }
    };

    // Freeze + moderator ticket + audit commit together. They used to be three
    // separate writes: a failure after the freeze left the escrow
    // IN_ARBITRATION with no ticket — invisible to moderators — and the
    // client's retry then hit the lockout below. Stuck for good.
    const { createDisputeTicket } = require('../services/disputeTicketService');
    const { ledgerStatus, ticketId, clientId, contractorId } = await runTransaction(async (session) => {
      const frozenLedger = await EscrowLedger.findOneAndUpdate(query, updatePayload, { session, returnDocument: 'after' });

      if (!frozenLedger) {
        throw Object.assign(
          new Error('Dispute Lockout: Milestone state is invalid, or you do not have authorization to freeze this ledger.'),
          { statusCode: 409, isOperational: true }
        );
      }

      // 🛡️ Phase-5 blocker fix: produce a DisputeTicket so the moderator queue
      // and /moderation/dispute/:ticketId/resolve are reachable in production.
      const { ticket } = await createDisputeTicket({
        ledger: frozenLedger,
        milestoneIndex: idx,
        reason: reason.trim(),
        disputedBy: userRole,
        session
      });

      await emitAudit({
        session,
        entityId: frozenLedger._id,
        entityType: 'ESCROW_LEDGER',
        action: 'MILESTONE_DISPUTED',
        actorId: req.user.userId,
        actorRole: req.user.role,
        metadata: {
          milestoneIndex: idx,
          reason: reason.trim(),
          disputeTicketId: ticket ? ticket._id.toString() : null
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      return {
        ledgerStatus: frozenLedger.ledgerStatus,
        ticketId: ticket ? ticket._id : null,
        clientId: frozenLedger.clientId,
        contractorId: frozenLedger.contractorId
      };
    });

    const targetRecipient = userRole === 'CONTRACTOR' ? clientId : contractorId;
    if (targetRecipient) {
      notifyDisputeCreated({
        recipientId: targetRecipient,
        ticketId,
        reason: reason.trim(),
        io: req.app ? req.app.get('io') : null
      }).catch(() => {});
    }

    res.status(200).json({
      status: 'success',
      message: `Milestone ${idx} locked. Escrow frozen and escalated to Platform Arbitration.`,
      currentLedgerStatus: ledgerStatus,
      disputeTicketId: ticketId
    });
  })
);

// ==========================================
// @route   POST /api/governance/arbitrate/:ledgerId/milestone/:milestoneIndex
// @desc    Admin executes a verdict, atomically disbursing or refunding fixed-point funds
// @deprecated Use POST /api/moderation/dispute/:ticketId/resolve instead (ticketed dispute mediation).
// @access  Private (Strictly ADMIN only)
// ==========================================
router.post(
  '/arbitrate/:ledgerId/milestone/:milestoneIndex',
  verifyToken,
  requireRole(['ADMIN']),
  enforceIdempotency, // 🛡️ Phase-3 P1 fix: admin verdicts move money — retry-safe.
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;
    const { decision, arbitrationNotes } = req.body;
    const idx = parseInt(milestoneIndex, 10);

    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</api/moderation/dispute/:ticketId/resolve>; rel="successor-version"');
    res.setHeader('Warning', '299 - "POST /api/governance/arbitrate is deprecated: Dispute resolution occurs via DisputeTicket at POST /api/moderation/dispute/:ticketId/resolve"');
    console.warn(`⚠️ [DeprecationNotice] POST /api/governance/arbitrate/${ledgerId}/milestone/${milestoneIndex} called. Use POST /api/moderation/dispute/:ticketId/resolve.`);

    if (decision !== 'FAVOR_CLIENT' && decision !== 'FAVOR_CONTRACTOR') {
      const err = new Error("Invalid verdict. Decision must be exactly 'FAVOR_CLIENT' or 'FAVOR_CONTRACTOR'.");
      err.statusCode = 400;
      err.isOperational = true;
      return next(err);
    }

    // Binding-arbitration policy (models/DisputeTicket.js): a verdict that
    // moves money needs a written justification of at least 20 characters.
    const justification = typeof arbitrationNotes === 'string' ? arbitrationNotes.trim() : '';
    if (justification.length < 20) {
      const err = new Error('arbitrationNotes must be a written justification of at least 20 characters.');
      err.statusCode = 400;
      err.isOperational = true;
      return next(err);
    }

    const ledgerStatus = await runTransaction(async (session) => {
      const ledger = await EscrowLedger.findById(ledgerId).session(session);
      if (!ledger) throw Object.assign(new Error('Target escrow ledger not found.'), { statusCode: 404, isOperational: true });
      if (ledger.ledgerStatus !== 'IN_ARBITRATION') throw Object.assign(new Error(`Ledger is not in arbitration. Current state: ${ledger.ledgerStatus}`), { statusCode: 409, isOperational: true });
      if (idx < 0 || idx >= ledger.milestones.length) throw Object.assign(new Error('Milestone Index Out of Bounds.'), { statusCode: 400, isOperational: true });

      const targetMilestone = ledger.milestones[idx];
      if (targetMilestone.status !== 'DISPUTED') throw Object.assign(new Error('Target milestone is not actively disputed.'), { statusCode: 409, isOperational: true });

      if (decision === 'FAVOR_CONTRACTOR') {
        // creditPendingClearance throws if either the contractor or the
        // treasury row is missing (the contractor update was unchecked before).
        await creditPendingClearance(session, { contractorId: ledger.contractorId, amount: targetMilestone.amount });

        ledger.milestones[idx].status = 'COMPLETED';
        ledger.milestones[idx].approvedAt = new Date();
        ledger.milestones[idx].settlementStatus = 'PENDING_CLEARANCE';
        ledger.milestones[idx].clearsAt = clearanceDate();
      } else if (decision === 'FAVOR_CLIENT') {
        await incWallet(session, { _id: ledger.clientId },
          { 'wallet.availableToWithdraw': targetMilestone.amount }, 'Client (refund)');

        ledger.milestones[idx].status = 'REFUNDED';
        ledger.milestones[idx].settlementStatus = 'REFUNDED';
      }

      ledger.milestones[idx].arbitrationNotes = justification;
      unlockNextMilestone(ledger.milestones);
      ledger.markModified('milestones');

      await emitAudit({
        session,
        entityId: ledger._id,
        entityType: 'PLATFORM_ARBITRATION',
        action: decision === 'FAVOR_CLIENT' ? 'ARBITRATION_VERDICT_CLIENT' : 'ARBITRATION_VERDICT_CONTRACTOR',
        actorId: req.user.userId,
        actorRole: req.user.role,
        metadata: {
          milestoneIndex: idx,
          decision,
          arbitrationNotes: justification
        },
        ipAddress: req.ip || 'SYSTEM_INTERNAL'
      });

      const previousLedgerStatus = ledger.ledgerStatus;
      ledger.ledgerStatus = settledLedgerStatus(ledger.milestones);

      await ledger.save({ session });
      await onLedgerSettled(session, ledger, previousLedgerStatus);

      await DisputeTicket.findOneAndUpdate(
        {
          ledgerId: ledger._id,
          milestoneIndex: idx,
          status: { $in: ['OPEN_FOR_REVIEW', 'MEDIATION_IN_PROGRESS'] }
        },
        {
          $set: {
            status: decision === 'FAVOR_CONTRACTOR' ? 'RESOLVED_FORCE_APPROVED' : 'RESOLVED_CANCELLED',
            'resolution.moderatorId': req.user.userId,
            'resolution.verdict': decision === 'FAVOR_CONTRACTOR' ? 'FORCE_APPROVE' : 'CANCEL_AND_RESTART',
            'resolution.justification': justification,
            'resolution.resolvedAt': new Date()
          }
        },
        { session }
      );

      return ledger.ledgerStatus;
    });

    res.status(200).json({
      status: 'success',
      message: `Arbitration verdict executed: ${decision}. Funds routed with ACID integrity.`,
      currentLedgerStatus: ledgerStatus
    });
  })
);

// ═══════════════════════════════════════════════════════════════════════════
// 🛡️ PHASE 21 v2 — PROOF-OF-WORK EVIDENCE LEDGER (Zero-RAM Architecture)
// ═══════════════════════════════════════════════════════════════════════════
//
// multer has been completely eradicated. The Node.js process NEVER touches
// image bytes. The complete upload flow is:
//
//  Step 1  GET  /proof/presigned-url
//          Backend issues an S3 Pre-Signed POST policy.
//          S3 enforces ContentType + content-length-range (max 10 MB) server-side.
//          The backend JWT-signs the s3Key as a binding token (CPT pattern).
//
//  Step 2  Client → S3 direct upload (FormData POST to presigned URL)
//          Image bytes flow:  Device → CDN/S3 edge.  Backend sees zero bytes.
//          Client computes SHA-256 of the image buffer locally (SubtleCrypto).
//          Client extracts EXIF GPS / calls navigator.geolocation for live path.
//
//  Step 3  POST /proof/evidence/:ledgerId/milestone/:idx       (EXIF path)
//          POST /proof/evidence/live/:ledgerId/milestone/:idx  (live-ping path)
//          Backend receives pure JSON: { s3ObjectKey, imageHash, gpsData }
//          Backend:
//            a) Verifies s3Key binding token (prevents phantom proof injection)
//            b) HeadObject — confirms the key physically exists in S3
//            c) Runs location math (Haversine + Dynamic Accuracy Thresholding)
//            d) Double-spend check (imageHash cross-ledger collision query)
//            e) ACID transaction: appends evidenceLog entry, advances state

const { verifyLivePing, VerificationTier, haversineDistanceMeters, GEOFENCE_HARD_CAP_METERS } = require('../services/evidenceService');
const { generateEvidenceUploadPolicy, isS3Mock } = require('../services/s3Service');
const jwt = require('jsonwebtoken');
const Project = require('../models/Project');



// ─────────────────────────────────────────────────────────────────────────────
// @route   GET /api/governance/proof/presigned-url
// @desc    Step 1 of the zero-RAM evidence upload flow.
//          Generates an AWS S3 Pre-Signed POST policy bound to a specific
//          ledger + milestone. The client uses this to upload the image
//          DIRECTLY to S3 — the Node.js process sees zero image bytes.
//
//          S3 POST policy Conditions (enforced at the AWS infrastructure level):
//            - content-length-range: [1, 10485760] — rejects files > 10 MB
//            - Content-Type: must match the declared contentType exactly
//            - x-amz-server-side-encryption: AES256 mandatory
//
//          Returns a JWT-signed s3KeyToken (CPT pattern) that binds the s3Key
//          to this exact ledgerId + milestoneIndex. The confirmation endpoint
//          verifies this token, preventing phantom proof injection attacks.
//
// @access  Private (Assigned CONTRACTOR only)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/proof/presigned-url',
  verifyToken,
  requireRole(['CONTRACTOR']),
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex, contentType } = req.query;

    if (!ledgerId || milestoneIndex === undefined || !contentType) {
      return next(Object.assign(
        new Error('Query params required: ledgerId, milestoneIndex, contentType (e.g. image/jpeg).'),
        { statusCode: 400, isOperational: true }
      ));
    }

    const idx = parseInt(milestoneIndex, 10);
    if (!Number.isInteger(idx) || idx < 0) {
      return next(Object.assign(new Error('milestoneIndex must be a non-negative integer.'), { statusCode: 400, isOperational: true }));
    }

    // ── Ledger ownership + state pre-flight ───────────────────────────────────
    const ledger = await EscrowLedger.findById(ledgerId).lean();
    if (!ledger) {
      return next(Object.assign(new Error('Escrow ledger not found.'), { statusCode: 404, isOperational: true }));
    }
    if (ledger.contractorId.toString() !== req.user.userId) {
      return next(Object.assign(new Error('Authorization Breach: You are not the assigned contractor for this escrow.'), { statusCode: 403, isOperational: true }));
    }
    if (idx >= ledger.milestones.length) {
      return next(Object.assign(new Error('Milestone index out of bounds.'), { statusCode: 400, isOperational: true }));
    }
    if (!['FUNDED', 'PARTIALLY_DISBURSED'].includes(ledger.ledgerStatus)) {
      return next(Object.assign(new Error('Escrow must be funded before evidence can be submitted.'), { statusCode: 403, isOperational: true }));
    }
    const milestone = ledger.milestones[idx];
    if (!['IN_PROGRESS', 'PROOF_SUBMITTED'].includes(milestone.status)) {
      return next(Object.assign(
        new Error(`Evidence uploads require milestone status IN_PROGRESS or PROOF_SUBMITTED. Current: ${milestone.status}`),
        { statusCode: 400, isOperational: true }
      ));
    }

    // ── Generate S3 Pre-Signed POST policy ────────────────────────────────────
    // generateEvidenceUploadPolicy throws 415 on unsupported contentType.
    // In mock mode returns a structurally identical response.
    const policy = await generateEvidenceUploadPolicy(ledgerId, idx, contentType);

    // ── JWT-sign the s3Key as a binding Cryptographic Proof Token ─────────────
    // Prevents a contractor from submitting an s3Key they did not obtain from here,
    // blocking phantom proof injection (fabricating a ledger entry for a key that
    // was never legitimately generated for this ledger/milestone pair).
    const s3KeyToken = jwt.sign(
      {
        s3Key:          policy.s3Key,
        ledgerId:       String(ledger._id),
        milestoneIndex: idx,
        contractorId:   req.user.userId
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m', algorithm: 'HS256' }
    );

    res.status(200).json({
      status: 'success',
      message: 'S3 Pre-Signed POST policy generated. Upload directly from client. Backend RAM untouched.',
      data: {
        uploadUrl:        policy.url,
        uploadFields:     policy.fields,
        uploadMethod:     policy.method,
        uploadHeaders:    policy.headers,
        maxBytes:         policy.maxBytes,
        s3Key:            policy.s3Key,
        s3KeyToken,
        expiresInSeconds: policy.expiresInSeconds
      }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/governance/proof/evidence/:ledgerId/milestone/:milestoneIndex
// @desc    Step 3 of the zero-RAM evidence upload flow — EXIF/GPS path.
//          Called AFTER the client has:
//            1. Obtained the pre-signed policy (Step 1)
//            2. Uploaded the image directly to S3 (Step 2)
//            3. Computed SHA-256 of the image buffer client-side (SubtleCrypto)
//            4. Extracted EXIF GPS coordinates from the image client-side
//
//          Body (application/json):
//            s3KeyToken  {string}  JWT from Step 1 (binds s3Key to this ledger)
//            imageHash   {string}  SHA-256 hex of the raw image bytes
//            gpsData     {object?} { lat, lng, accuracy?, photoTimestamp? }
//                                  Omit or null if EXIF GPS was unavailable —
//                                  triggers REQUIRES_CLIENT_AUDIT tier gracefully.
//
//          Server responsibilities:
//            - Verify JWT binding token (s3Key → ledgerId → milestoneIndex → contractorId)
//            - HeadObject: confirm file physically exists in S3
//            - Haversine: verify gpsData against project site coordinates
//            - Double-spend: cross-ledger imageHash collision query
//            - ACID commit: append evidenceLog, advance milestone state
//
// @access  Private (Assigned CONTRACTOR only)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/proof/evidence/:ledgerId/milestone/:milestoneIndex',
  verifyToken,
  requireRole(['CONTRACTOR']),
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;
    const idx = parseInt(milestoneIndex, 10);
    const { s3KeyToken, imageHash, gpsData, deviceCoordinates } = req.body;

    // ── Input validation ──────────────────────────────────────────────────────
    if (!s3KeyToken || typeof s3KeyToken !== 'string') {
      return next(Object.assign(new Error('s3KeyToken (JWT from presigned-url step) is required.'), { statusCode: 400, isOperational: true }));
    }
    if (!imageHash || typeof imageHash !== 'string' || !/^[a-f0-9]{64}$/i.test(imageHash)) {
      return next(Object.assign(new Error('imageHash must be a 64-character lowercase hex SHA-256 string.'), { statusCode: 400, isOperational: true }));
    }

    // ── Verify JWT binding token ──────────────────────────────────────────────
    // Confirms: this s3Key was legitimately generated for THIS ledger + milestone
    // + contractor. Prevents phantom proof injection.
    let tokenPayload;
    try {
      tokenPayload = jwt.verify(s3KeyToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (jwtErr) {
      return next(Object.assign(new Error('Invalid or expired s3KeyToken. Obtain a new pre-signed URL.'), { statusCode: 401, isOperational: true }));
    }

    if (
      tokenPayload.ledgerId       !== ledgerId ||
      tokenPayload.milestoneIndex !== idx      ||
      tokenPayload.contractorId   !== req.user.userId
    ) {
      return next(Object.assign(
        new Error('Token boundary violation: s3KeyToken does not match this ledger, milestone, or contractor.'),
        { statusCode: 403, isOperational: true }
      ));
    }

    const s3ObjectKey = tokenPayload.s3Key;

    // ── Ledger ownership + state guards ──────────────────────────────────────
    const ledger = await EscrowLedger.findById(ledgerId);
    if (!ledger) return next(Object.assign(new Error('Escrow ledger not found.'), { statusCode: 404, isOperational: true }));
    if (ledger.contractorId.toString() !== req.user.userId) {
      return next(Object.assign(new Error('Authorization Breach: You are not the assigned contractor.'), { statusCode: 403, isOperational: true }));
    }
    if (idx < 0 || idx >= ledger.milestones.length) {
      return next(Object.assign(new Error('Milestone index out of bounds.'), { statusCode: 400, isOperational: true }));
    }
    if (!['FUNDED', 'PARTIALLY_DISBURSED'].includes(ledger.ledgerStatus)) {
      return next(Object.assign(new Error('Escrow must be funded before evidence can be submitted.'), { statusCode: 403, isOperational: true }));
    }
    const targetMilestone = ledger.milestones[idx];
    if (!['IN_PROGRESS', 'PROOF_SUBMITTED'].includes(targetMilestone.status)) {
      return next(Object.assign(new Error(`Milestone must be IN_PROGRESS or PROOF_SUBMITTED. Current: ${targetMilestone.status}`), { statusCode: 400, isOperational: true }));
    }

    // ── HeadObject: physical S3 reconciliation & checksum integrity ──────────
    // Confirms the client actually uploaded the file and the storage bytes match imageHash before we commit the ledger.
    const uploadCheck = await validateUploadedObject(s3ObjectKey, { expectedHash: imageHash.toLowerCase() });
    if (!uploadCheck.ok) {
      return next(Object.assign(
        new Error(uploadCheck.reason || 'Physical reconciliation failed: File not found in S3. Complete the upload before confirming evidence.'),
        { statusCode: uploadCheck.statusCode || 400, isOperational: true }
      ));
    }

    // ── Location verification (Haversine on client-reported GPS) ──────────────
    const project = await Project.findById(ledger.projectId).select('siteCoordinates createdAt').lean();
    const projectLat = project?.siteCoordinates?.latitude  ?? null;
    const projectLng = project?.siteCoordinates?.longitude ?? null;

    let verificationTier = VerificationTier.REQUIRES_CLIENT_AUDIT;
    let distanceMeters   = null;
    const notes          = [];

    const gLat = gpsData?.lat ?? gpsData?.latitude;
    const gLng = gpsData?.lng ?? gpsData?.longitude;
    if (gpsData && Number.isFinite(gLat) && Number.isFinite(gLng)) {
      if (projectLat !== null && projectLng !== null) {
        distanceMeters = haversineDistanceMeters(projectLat, projectLng, gLat, gLng);

        if (distanceMeters > GEOFENCE_HARD_CAP_METERS) {
          // Discrepancy: GPS reports location more than 80m from site
          console.error(`🚨 [Evidence] GPS location discrepancy: contractor ${req.user.userId} is ${Math.round(distanceMeters)}m from site.`);
          return next(Object.assign(
            new Error(`Location discrepancy: Reported GPS location is ${Math.round(distanceMeters)}m from the project site (maximum allowed: ${GEOFENCE_HARD_CAP_METERS}m). Please take photos within the project boundary.`),
            { statusCode: 422, isOperational: true }
          ));
        }

        // Determine tier based on available GPS metadata
        const hasTimestamp = gpsData.photoTimestamp && !isNaN(new Date(gpsData.photoTimestamp).getTime());
        const photoAfterStart = hasTimestamp && new Date(gpsData.photoTimestamp) >= new Date(project.createdAt || 0);

        if (photoAfterStart) {
          verificationTier = VerificationTier.CRYPTOGRAPHIC_PROOF;
          notes.push(`GPS verified: ${Math.round(distanceMeters)}m from site. Timestamp verified: ${gpsData.photoTimestamp}.`);
        } else if (hasTimestamp && !photoAfterStart) {
          // Photo timestamp predates project start — reject
          return next(Object.assign(
            new Error(`Timestamp discrepancy: Photo timestamp ${gpsData.photoTimestamp} predates project start. Please submit photos taken during the project period.`),
            { statusCode: 422, isOperational: true }
          ));
        } else {
          verificationTier = VerificationTier.GPS_ONLY;
          notes.push(`GPS verified: ${Math.round(distanceMeters)}m from site. No timestamp provided.`);
        }

        // Dual-sensor cross-check (Threat Model §6): compare EXIF GPS with device GPS
        if (deviceCoordinates && Number.isFinite(deviceCoordinates.lat ?? deviceCoordinates.latitude) && Number.isFinite(deviceCoordinates.lng ?? deviceCoordinates.longitude)) {
          const driftMeters = haversineDistanceMeters(gLat, gLng, deviceCoordinates.lat ?? deviceCoordinates.latitude, deviceCoordinates.lng ?? deviceCoordinates.longitude);
          if (driftMeters > 500) {
            notes.push(`Dual-sensor GPS discrepancy: Photo EXIF and device location differ by ${Math.round(driftMeters)}m.`);
            verificationTier = VerificationTier.REQUIRES_CLIENT_AUDIT;
          } else {
            notes.push(`Dual-sensor verified: Photo EXIF and device GPS match within ${Math.round(driftMeters)}m.`);
          }
        }
      } else {
        notes.push('GPS coordinates supplied but project has no site coordinates — geofence check skipped.');
        verificationTier = VerificationTier.REQUIRES_CLIENT_AUDIT;
      }
    } else {
      notes.push('No GPS data provided or coordinates invalid. Requires client manual review.');
      verificationTier = VerificationTier.REQUIRES_CLIENT_AUDIT;
    }

    // ── Double-spend check ────────────────────────────────────────────────────
    // imageHash is computed client-side (SubtleCrypto) over the raw image buffer.
    // Cross-ledger query: if this hash was used on any previous milestone → reject.
    const hashCollision = await EscrowLedger.findOne({
      'milestones.evidenceLog.imageHash': imageHash.toLowerCase()
    }).lean();

    if (hashCollision) {
      console.error(`🚨 [Evidence] Duplicate evidence by contractor ${req.user.userId} — hash: ${imageHash}`);
      return next(Object.assign(
        new Error('Duplicate evidence: This image has already been submitted as evidence on another milestone. Each milestone requires unique photographic proof.'),
        { statusCode: 409, isOperational: true }
      ));
    }

    // ── ACID commit (re-checks every rule above inside the transaction) ──────
    const milestoneStatus = await commitEvidence({
      ledgerId,
      idx,
      contractorId: req.user.userId,
      entry: {
        imageHash:        imageHash.toLowerCase(),
        verificationTier,
        livePingVerified: false,
        distanceMeters,
        s3Key:            s3ObjectKey,
        notes
      },
      auditAction: 'EVIDENCE_SUBMITTED',
      auditMetadata: { verificationTier, imageHash, distanceMeters, s3Key: s3ObjectKey },
      req
    });

    notifyEvidenceSubmitted({
      clientId: ledger.clientId,
      projectId: ledger.projectId,
      milestoneTitle: targetMilestone.title || `Milestone ${idx + 1}`,
      tier: verificationTier,
      io: req.app ? req.app.get('io') : null
    }).catch(() => {});

    res.status(200).json({
      status: 'success',
      message: 'Evidence cryptographically committed to the immutable ledger. Backend RAM was never touched.',
      evidence: {
        verificationTier,
        imageHash,
        distanceMeters,
        notes,
        milestoneStatus
      }
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// @route   POST /api/governance/proof/evidence/live/:ledgerId/milestone/:milestoneIndex
// @desc    Step 3 — Live GPS ping path (highest trust tier).
//          The client calls navigator.geolocation.getCurrentPosition() IN-APP
//          immediately before taking the photo. Coordinates come from the live
//          GPS chip, not EXIF — completely immune to image EXIF spoofing tools.
//
//          Body (application/json):
//            s3KeyToken  {string}  JWT from Step 1
//            imageHash   {string}  SHA-256 hex computed client-side
//            lat         {number}  Live GPS latitude from navigator.geolocation
//            lng         {number}  Live GPS longitude
//            accuracy    {number}  coords.accuracy in metres (for Dynamic Thresholding)
//
//          Dynamic Accuracy Thresholding: min(80, max(40, accuracy))
//          Accommodates Walton/Symphony/degraded GPS (drift 20–40m in rebar sites)
//          while blocking the 100m+ spoofing window.
//
// @access  Private (Assigned CONTRACTOR only)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/proof/evidence/live/:ledgerId/milestone/:milestoneIndex',
  verifyToken,
  requireRole(['CONTRACTOR']),
  catchAsync(async (req, res, next) => {
    const { ledgerId, milestoneIndex } = req.params;
    const idx = parseInt(milestoneIndex, 10);
    const { s3KeyToken, imageHash, lat, lng, accuracy } = req.body;

    // ── Input validation ──────────────────────────────────────────────────────
    if (!s3KeyToken || typeof s3KeyToken !== 'string') {
      return next(Object.assign(new Error('s3KeyToken is required.'), { statusCode: 400, isOperational: true }));
    }
    if (!imageHash || typeof imageHash !== 'string' || !/^[a-f0-9]{64}$/i.test(imageHash)) {
      return next(Object.assign(new Error('imageHash must be a 64-character hex SHA-256 string.'), { statusCode: 400, isOperational: true }));
    }
    const pingLat        = parseFloat(lat);
    const pingLng        = parseFloat(lng);
    const deviceAccuracy = parseFloat(accuracy);

    if (!Number.isFinite(pingLat) || !Number.isFinite(pingLng)) {
      return next(Object.assign(new Error('lat and lng are required and must be finite numbers.'), { statusCode: 400, isOperational: true }));
    }

    // ── Verify JWT binding token ──────────────────────────────────────────────
    let tokenPayload;
    try {
      tokenPayload = jwt.verify(s3KeyToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (jwtErr) {
      return next(Object.assign(new Error('Invalid or expired s3KeyToken. Obtain a new pre-signed URL.'), { statusCode: 401, isOperational: true }));
    }

    if (
      tokenPayload.ledgerId       !== ledgerId ||
      tokenPayload.milestoneIndex !== idx      ||
      tokenPayload.contractorId   !== req.user.userId
    ) {
      return next(Object.assign(
        new Error('Token boundary violation: s3KeyToken does not match this ledger, milestone, or contractor.'),
        { statusCode: 403, isOperational: true }
      ));
    }

    const s3ObjectKey = tokenPayload.s3Key;

    // ── Ledger guards ─────────────────────────────────────────────────────────
    const ledger = await EscrowLedger.findById(ledgerId);
    if (!ledger) return next(Object.assign(new Error('Escrow ledger not found.'), { statusCode: 404, isOperational: true }));
    if (ledger.contractorId.toString() !== req.user.userId) {
      return next(Object.assign(new Error('Authorization Breach: You are not the assigned contractor.'), { statusCode: 403, isOperational: true }));
    }
    if (idx < 0 || idx >= ledger.milestones.length) {
      return next(Object.assign(new Error('Milestone index out of bounds.'), { statusCode: 400, isOperational: true }));
    }
    if (!['FUNDED', 'PARTIALLY_DISBURSED'].includes(ledger.ledgerStatus)) {
      return next(Object.assign(new Error('Escrow must be funded before evidence can be submitted.'), { statusCode: 403, isOperational: true }));
    }
    const targetMilestone = ledger.milestones[idx];
    if (!['IN_PROGRESS', 'PROOF_SUBMITTED'].includes(targetMilestone.status)) {
      return next(Object.assign(new Error(`Milestone must be IN_PROGRESS or PROOF_SUBMITTED. Current: ${targetMilestone.status}`), { statusCode: 400, isOperational: true }));
    }

    // ── HeadObject: physical reconciliation & checksum integrity ─────────────
    const uploadCheck = await validateUploadedObject(s3ObjectKey, { expectedHash: imageHash.toLowerCase() });
    if (!uploadCheck.ok) {
      return next(Object.assign(
        new Error(uploadCheck.reason || 'Physical reconciliation failed: File not found in S3. Complete the upload before confirming evidence.'),
        { statusCode: uploadCheck.statusCode || 400, isOperational: true }
      ));
    }

    // ── Fetch project GPS ─────────────────────────────────────────────────────
    const project = await Project.findById(ledger.projectId).select('siteCoordinates').lean();
    const projectLat = project?.siteCoordinates?.latitude  ?? null;
    const projectLng = project?.siteCoordinates?.longitude ?? null;

    if (projectLat === null || projectLng === null) {
      return next(Object.assign(
        new Error('Project has no site coordinates. Add GPS coordinates to the project or use the standard evidence path.'),
        { statusCode: 400, isOperational: true }
      ));
    }

    // ── Dynamic Accuracy Thresholding — verifyLivePing throws 422 on fail ─────
    // Runs entirely on the JSON coordinates — zero image bytes consumed.
    const livePingResult = verifyLivePing(projectLat, projectLng, pingLat, pingLng, deviceAccuracy);

    // ── Double-spend check ────────────────────────────────────────────────────
    const hashCollision = await EscrowLedger.findOne({
      'milestones.evidenceLog.imageHash': imageHash.toLowerCase()
    }).lean();

    if (hashCollision) {
      console.error(`🚨 [LiveEvidence] Duplicate evidence by contractor ${req.user.userId} — hash: ${imageHash}`);
      return next(Object.assign(
        new Error('Duplicate evidence: This image has already been submitted as evidence on another milestone.'),
        { statusCode: 409, isOperational: true }
      ));
    }

    // ── ACID commit (re-checks every rule above inside the transaction) ──────
    // Live-ping always auto-advances — it is the maximum trust tier.
    const accuracyLabel = Number.isFinite(deviceAccuracy) ? `${deviceAccuracy}m` : 'unknown';
    const milestoneStatus = await commitEvidence({
      ledgerId,
      idx,
      contractorId: req.user.userId,
      entry: {
        imageHash:        imageHash.toLowerCase(),
        verificationTier: VerificationTier.CRYPTOGRAPHIC_PROOF,
        livePingVerified: true,
        distanceMeters:   livePingResult.distanceMeters,
        s3Key:            s3ObjectKey,
        notes: [
          `Live GPS ping verified: ${Math.round(livePingResult.distanceMeters)}m from site ` +
          `(dynamic radius: ${Math.round(livePingResult.dynamicRadius)}m, device accuracy: ${accuracyLabel}). ` +
          `EXIF spoofing surface eliminated.`
        ]
      },
      auditAction: 'EVIDENCE_SUBMITTED_LIVE',
      auditMetadata: {
        verificationTier: VerificationTier.CRYPTOGRAPHIC_PROOF,
        livePingVerified: true,
        distanceMeters:   livePingResult.distanceMeters,
        dynamicRadius:    livePingResult.dynamicRadius,
        imageHash,
        s3Key:            s3ObjectKey
      },
      req
    });

    res.status(200).json({
      status: 'success',
      message: 'Live-capture evidence verified and committed. Backend RAM untouched. EXIF spoofing eliminated.',
      evidence: {
        verificationTier: VerificationTier.CRYPTOGRAPHIC_PROOF,
        livePingVerified: true,
        distanceMeters:   livePingResult.distanceMeters,
        dynamicRadius:    livePingResult.dynamicRadius,
        imageHash,
        milestoneStatus
      }
    });
  })
);

module.exports = router;

