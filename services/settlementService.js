const mongoose = require('mongoose');
const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');
const { splitMilestoneAmount, allMilestonesTerminal, unlockNextMilestone, clearanceDate } = require('../utils/money');

const CLEARANCE_DELAY_DAYS = 2;

function treasuryFilter() {
  return { role: 'ADMIN', phoneNumber: process.env.TREASURY_PHONE || '01700000000' };
}

/**
 * $inc on one user's wallet inside the caller's session. Throws when the user
 * doesn't exist, so the transaction aborts instead of silently losing money
 * (the old code ignored a null treasury result and the 5% fee vanished).
 */
async function incWallet(session, filter, inc, label) {
  const doc = await User.findOneAndUpdate(filter, { $inc: inc }, { session, returnDocument: 'after' });
  if (!doc) {
    throw Object.assign(
      new Error(`Critical Integrity Failure: ${label} account not found. Transaction aborted.`),
      { statusCode: 500, isOperational: true }
    );
  }
  return doc;
}

/** Credits a milestone's split into pendingClearance (contractor + treasury). */
async function creditPendingClearance(session, { contractorId, amount }) {
  const { contractor, platform } = splitMilestoneAmount(amount);
  await incWallet(session, { _id: contractorId }, { 'wallet.pendingClearance': contractor }, 'Contractor');
  await incWallet(session, treasuryFilter(), { 'wallet.pendingClearance': platform }, 'Platform treasury');
  return { contractor, platform };
}

async function approveMilestoneForSettlement({ ledgerId, milestoneIndex, actorId }) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const ledger = await EscrowLedger.findById(ledgerId).session(session);
      if (!ledger) throw Object.assign(new Error('Escrow ledger not found.'), { statusCode: 404, isOperational: true });

      if (ledger.clientId.toString() !== actorId.toString()) {
        throw Object.assign(new Error('Authorization Breach: client mismatch.'), { statusCode: 403, isOperational: true });
      }

      const idx = Number(milestoneIndex);
      const targetMilestone = ledger.milestones[idx];
      if (!targetMilestone) throw Object.assign(new Error('Milestone index out of bounds.'), { statusCode: 400, isOperational: true });
      if (targetMilestone.status !== 'PROOF_SUBMITTED') {
        throw Object.assign(new Error(`Milestone state must be PROOF_SUBMITTED. Current state: ${targetMilestone.status}`), { statusCode: 400, isOperational: true });
      }

      const { contractor, platform } = await creditPendingClearance(session, {
        contractorId: ledger.contractorId,
        amount: targetMilestone.amount
      });

      const clearsAt = clearanceDate();
      targetMilestone.status = 'COMPLETED';
      targetMilestone.approvedAt = new Date();
      targetMilestone.settlementStatus = 'PENDING_CLEARANCE';
      targetMilestone.clearsAt = clearsAt;
      unlockNextMilestone(ledger.milestones);

      ledger.ledgerStatus = allMilestonesTerminal(ledger.milestones) ? 'FULLY_DISBURSED' : 'PARTIALLY_DISBURSED';
      ledger.markModified('milestones');
      await ledger.save({ session });

      result = { success: true, contractorPending: contractor, platformPending: platform, clearsAt };
    });
    return result;
  } finally {
    session.endSession();
  }
}

/**
 * Moves cleared tranches from pendingClearance → availableToWithdraw.
 *
 * Each ledger settles in its OWN transaction: one corrupt ledger (or a missing
 * contractor) no longer aborts the whole sweep for every contractor. Running
 * two app instances concurrently is safe — a second instance hits a write
 * conflict on the same ledger/user docs, withTransaction retries, re-reads
 * the ledger, sees SETTLED, and credits nothing.
 */
async function settlePendingTranches({ now = new Date() } = {}) {
  const candidates = await EscrowLedger.find({
    milestones: { $elemMatch: { settlementStatus: 'PENDING_CLEARANCE', clearsAt: { $lte: now } } }
  }).select('_id').lean();

  let settledTranches = 0;
  const failures = [];

  for (const { _id } of candidates) {
    const session = await mongoose.startSession();
    try {
      let count = 0;
      await session.withTransaction(async () => {
        count = 0; // reset on retry
        const ledger = await EscrowLedger.findById(_id).session(session);
        if (!ledger) return;

        for (const milestone of ledger.milestones) {
          if (milestone.settlementStatus !== 'PENDING_CLEARANCE' || !milestone.clearsAt || milestone.clearsAt > now) {
            continue;
          }
          const { contractor, platform } = splitMilestoneAmount(milestone.amount);
          await incWallet(session, { _id: ledger.contractorId },
            { 'wallet.pendingClearance': -contractor, 'wallet.availableToWithdraw': contractor }, 'Contractor');
          await incWallet(session, treasuryFilter(),
            { 'wallet.pendingClearance': -platform, 'wallet.availableToWithdraw': platform }, 'Platform treasury');
          milestone.settlementStatus = 'SETTLED';
          milestone.clearsAt = null;
          count += 1;
        }

        if (count > 0) {
          ledger.markModified('milestones');
          await ledger.save({ session });
        }
      });
      settledTranches += count;
    } catch (err) {
      failures.push({ ledgerId: String(_id), reason: err.message });
      console.error(`🚨 [Settlement] Ledger ${_id} failed to settle and was skipped: ${err.message}`);
    } finally {
      session.endSession();
    }
  }

  return { success: failures.length === 0, settledTranches, failures };
}

module.exports = {
  approveMilestoneForSettlement,
  settlePendingTranches,
  creditPendingClearance,
  incWallet,
  treasuryFilter,
  CLEARANCE_DELAY_DAYS
};
