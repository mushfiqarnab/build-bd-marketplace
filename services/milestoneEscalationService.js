// services/milestoneEscalationService.js
// Autonomous Milestone Stalling Escalator (Anti-Withholding Protection for Contractors)
//
// Identifies milestones where the contractor has submitted proof of work
// (PROOF_SUBMITTED), but the client has taken no action (neither approve nor dispute)
// for ≥ 7 days. Flags the milestone as `escalatedAt` and unlocks the contractor's right
// to initiate dispute arbitration.
'use strict';

const EscrowLedger = require('../models/EscrowLedger');
const AuditLog = require('../models/AuditLog');
const { runTransaction } = require('../utils/transaction');

const DEFAULT_STALL_DAYS = 7;

/**
 * Sweeps for stalled milestones across all funded/partially-disbursed escrows.
 * Uses atomic per-ledger updates to safely interleave with concurrent user actions.
 *
 * @param {object} [options]
 * @param {number} [options.stallDays] Days milestone must sit in PROOF_SUBMITTED before escalating
 * @returns {Promise<{ scanned: number, escalated: number }>}
 */
async function escalateStalledMilestones({ stallDays } = {}) {
  const thresholdDays = Number(stallDays || process.env.MILESTONE_STALL_DAYS || DEFAULT_STALL_DAYS);
  const cutoff = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);

  // Find candidate ledgers where a milestone is in PROOF_SUBMITTED and not yet escalated
  const candidates = await EscrowLedger.find({
    ledgerStatus: { $in: ['FUNDED', 'PARTIALLY_DISBURSED'] },
    milestones: {
      $elemMatch: {
        status: 'PROOF_SUBMITTED',
        escalatedAt: null,
        $or: [
          { proofSubmittedAt: { $lte: cutoff } },
          { 'evidenceLog.submittedAt': { $lte: cutoff } }
        ]
      }
    }
  }).select('_id projectId clientId contractorId milestones ledgerStatus');

  let escalatedCount = 0;

  for (const ledger of candidates) {
    for (let idx = 0; idx < ledger.milestones.length; idx++) {
      const m = ledger.milestones[idx];
      if (m.status !== 'PROOF_SUBMITTED' || m.escalatedAt) continue;

      const submittedAt = m.proofSubmittedAt || (m.evidenceLog?.length ? m.evidenceLog[m.evidenceLog.length - 1].submittedAt : null);
      if (!submittedAt || new Date(submittedAt) > cutoff) continue;

      // Atomic compare-and-swap update on this specific milestone
      try {
        await runTransaction(async (session) => {
          const updated = await EscrowLedger.findOneAndUpdate(
            {
              _id: ledger._id,
              ledgerStatus: { $in: ['FUNDED', 'PARTIALLY_DISBURSED'] },
              [`milestones.${idx}.status`]: 'PROOF_SUBMITTED',
              [`milestones.${idx}.escalatedAt`]: null
            },
            {
              $set: {
                [`milestones.${idx}.escalatedAt`]: new Date()
              }
            },
            { session, returnDocument: 'after' }
          );

          if (!updated) return; // Ledger or milestone state changed concurrently

          await AuditLog.create([{
            entityId: ledger._id,
            entityType: 'ESCROW_LEDGER',
            action: 'MILESTONE_STALL_ESCALATED',
            actorId: ledger.contractorId,
            actorRole: 'SYSTEM',
            metadata: {
              milestoneIndex: idx,
              proofSubmittedAt: submittedAt,
              stallThresholdDays: thresholdDays
            },
            ipAddress: 'SYSTEM_INTERNAL'
          }], { session });

          escalatedCount += 1;
        });
      } catch (err) {
        console.error(`⚠️ [MilestoneEscalation] Failed to escalate milestone ${idx} on ledger ${ledger._id}:`, err.message);
      }
    }
  }

  return { scanned: candidates.length, escalated: escalatedCount };
}

module.exports = {
  escalateStalledMilestones,
  DEFAULT_STALL_DAYS
};
