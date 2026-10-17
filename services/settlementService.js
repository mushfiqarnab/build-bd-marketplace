const mongoose = require('mongoose');
const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');

const CLEARANCE_DELAY_DAYS = 2;

async function approveMilestoneForSettlement({ ledgerId, milestoneIndex, actorId, actorRole }) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
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

    const milestoneValue = targetMilestone.amount;
    const totalMilestoneCents = Math.round(milestoneValue * 100);
    const platformFeeCents = Math.round(totalMilestoneCents * 0.05);
    const contractorPayoutCents = totalMilestoneCents - platformFeeCents;

    const contractorPending = Number((contractorPayoutCents / 100).toFixed(2));
    const platformPending = Number((platformFeeCents / 100).toFixed(2));

    const clearsAtDate = new Date();
    clearsAtDate.setDate(clearsAtDate.getDate() + CLEARANCE_DELAY_DAYS);

    await User.findByIdAndUpdate(
      ledger.contractorId,
      { $inc: { 'wallet.pendingClearance': contractorPending } },
      { session, returnDocument: 'after' }
    );

    await User.findOneAndUpdate(
      { role: 'ADMIN', phoneNumber: process.env.TREASURY_PHONE || '01700000000' }, // 🛡️ Dynamic mapping
      { $inc: { 'wallet.pendingClearance': platformPending } },
      { session, returnDocument: 'after' }
    );

    targetMilestone.status = 'COMPLETED';
    targetMilestone.approvedAt = new Date();
    targetMilestone.settlementStatus = 'PENDING_CLEARANCE';
    targetMilestone.clearsAt = clearsAtDate;

    ledger.ledgerStatus = ledger.milestones.some((m) => m.status !== 'COMPLETED') ? 'PARTIALLY_DISBURSED' : 'FULLY_DISBURSED';
    ledger.markModified('milestones');
    await ledger.save({ session });

    await session.commitTransaction();
    session.endSession();

    return {
      success: true,
      contractorPending,
      platformPending,
      clearsAt: clearsAtDate
    };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
}

async function settlePendingTranches({ now = new Date() } = {}) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const ledgers = await EscrowLedger.find({
      'milestones.settlementStatus': 'PENDING_CLEARANCE',
      'milestones.clearsAt': { $lte: now }
    }).session(session);

    let settledTranches = 0;

    for (const ledger of ledgers) {
      for (const milestone of ledger.milestones) {
        if (milestone.settlementStatus !== 'PENDING_CLEARANCE' || !milestone.clearsAt || milestone.clearsAt > now) {
          continue;
        }

        // 🛡️ TIER-1 FINANCIAL MATH: Cents-integer arithmetic to block IEEE 754 drift
        // Mirrors the exact same path used in governance.js approve route.
        const milestoneAmountCents = Math.round(milestone.amount * 100);
        const platformFeeCents = Math.round(milestoneAmountCents * 0.05);
        const contractorPayoutCents = milestoneAmountCents - platformFeeCents;

        const contractorPayoutFinal = contractorPayoutCents / 100;
        const platformFeeFinal = platformFeeCents / 100;

        await User.findByIdAndUpdate(
          ledger.contractorId,
          { $inc: { 'wallet.pendingClearance': -contractorPayoutFinal, 'wallet.availableToWithdraw': contractorPayoutFinal } },
          { session, returnDocument: 'after' }
        );

        await User.findOneAndUpdate(
          { role: 'ADMIN', phoneNumber: process.env.TREASURY_PHONE || '01700000000' }, // 🛡️ Dynamic mapping
          { $inc: { 'wallet.pendingClearance': -platformFeeFinal, 'wallet.availableToWithdraw': platformFeeFinal } },
          { session, returnDocument: 'after' }
        );

        milestone.settlementStatus = 'SETTLED';
        milestone.clearsAt = null;
        settledTranches += 1;
      }
    }

    if (settledTranches > 0) {
      await Promise.all(ledgers.map((ledger) => {
        ledger.markModified('milestones');
        return ledger.save({ session });
      }));
    }


    await session.commitTransaction();
    session.endSession();

    return { success: true, settledTranches };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
}

module.exports = {
  approveMilestoneForSettlement,
  settlePendingTranches,
  CLEARANCE_DELAY_DAYS
};
