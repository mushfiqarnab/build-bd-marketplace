// services/disputeTicketService.js
// Single place for creating a DisputeTicket. Called from the two production
// dispute paths (/governance/dispute, /settlement/milestone/:id/reject) so
// /moderation/dispute/:ticketId/resolve becomes reachable in production.
//
// Was a Phase-5 known blocker before this PR: governance.js /dispute and
// settlement.js /reject both transitioned a milestone to DISPUTED but never
// produced a DisputeTicket, so the moderator queue was always empty and the
// /resolve endpoint had no documents to work on.
'use strict';

const DisputeTicket = require('../models/DisputeTicket');

/**
 * Returns a snapshot of the most-recent evidence item on a milestone, suitable
 * for ContractorEvidenceSnapshot. All sub-fields default to null if evidence
 * is missing (dispute may fire before any evidence was submitted — unlikely
 * because the status gate is PROOF_SUBMITTED, but defensive).
 */
function snapshotLatestEvidence(milestone) {
  const log = Array.isArray(milestone && milestone.evidenceLog) ? milestone.evidenceLog : [];
  const last = log.length ? log[log.length - 1] : null;
  if (!last) return { s3Url: null, imageHash: null, gpsData: { lat: null, lng: null, accuracy: null } };
  return {
    s3Url: last.s3Key || null,
    imageHash: last.imageHash || null,
    gpsData: {
      lat: typeof last.lat === 'number' ? last.lat : null,
      lng: typeof last.lng === 'number' ? last.lng : null,
      accuracy: typeof last.distanceMeters === 'number' ? last.distanceMeters : null
    },
    submittedAt: last.submittedAt || null
  };
}

/**
 * Create (or ignore-on-duplicate) a DisputeTicket for a disputed milestone.
 * The underlying model has a unique compound index on (ledgerId, milestoneIndex),
 * so a second call with the same pair surfaces as E11000 — swallowed here as
 * a benign idempotent repeat.
 *
 * @param {object} args
 * @param {object} args.ledger          — the EscrowLedger doc (with milestones)
 * @param {number} args.milestoneIndex  — which milestone transitioned to DISPUTED
 * @param {string} args.reason          — client rejection reason (≥10 chars)
 * @param {object} [args.session]       — optional Mongo session for in-txn create
 * @returns {Promise<{ ticket: object|null, duplicate: boolean }>}
 */
async function createDisputeTicket({ ledger, milestoneIndex, reason, session } = {}) {
  if (!ledger || typeof milestoneIndex !== 'number' || !reason) {
    throw new Error('createDisputeTicket requires { ledger, milestoneIndex, reason }.');
  }
  await DisputeTicket.init().catch(() => {});
  const milestone = ledger.milestones && ledger.milestones[milestoneIndex];
  const doc = {
    projectId: ledger.projectId,
    ledgerId: ledger._id,
    milestoneIndex,
    clientId: ledger.clientId,
    contractorId: ledger.contractorId,
    clientRejectionReason: String(reason).trim(),
    contractorEvidenceSnapshot: snapshotLatestEvidence(milestone)
  };
  if (session) {
    // Inside a transaction a duplicate-key error aborts the whole transaction,
    // so the catch-and-reread below cannot work there: look first instead. A
    // concurrent creator surfaces as a write conflict, which the caller's
    // withTransaction retries — and the retry then finds the ticket here.
    const existing = await DisputeTicket.findOne({ ledgerId: ledger._id, milestoneIndex }).session(session);
    if (existing) return { ticket: existing, duplicate: true };
    const [created] = await DisputeTicket.create([doc], { session });
    return { ticket: created, duplicate: false };
  }
  try {
    const created = await DisputeTicket.create(doc);
    return { ticket: created, duplicate: false };
  } catch (err) {
    if (err && err.code === 11000) {
      // Another retry already produced the ticket for this (ledgerId, milestoneIndex).
      // Treat as idempotent success; return the existing ticket.
      const existing = await DisputeTicket.findOne({ ledgerId: ledger._id, milestoneIndex });
      return { ticket: existing, duplicate: true };
    }
    throw err;
  }
}

module.exports = { createDisputeTicket, snapshotLatestEvidence };
