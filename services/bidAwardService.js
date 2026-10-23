// services/bidAwardService.js
// 🛡️ Phase-0 / §2 Roadmap fix: Single source of truth for bid award & contract formation.
//
// Unifies the bid acceptance state transition across BOTH entry points:
//   1. Canonical direct award: PUT /api/bids/:bidId/accept (routes/bid.js)
//   2. Chat-negotiated award: POST /api/chat/:bidId/accept-offer (routes/chat.js)
//
// Invariants enforced atomically within the caller's transaction session:
//   - CAS project state: OPEN/UNDER_BIDDING -> ASSIGNED, recording awardedContractorId
//   - Idempotent: safe if project was already assigned to this exact contractor
//   - Reject all sibling PENDING bids on the same project
//   - Create EscrowLedger with PENDING_FUNDING (or update unapproved milestones if already exists)
//   - Increment ContractorProfile availability.currentProjects
//   - Emit immutable FUNDS_LOCKED AuditLog entry bound to session
'use strict';

const Project = require('../models/Project');
const Bid = require('../models/Bid');
const EscrowLedger = require('../models/EscrowLedger');
const ContractorProfile = require('../models/ContractorProfile');
const { emitAudit } = require('./auditService');

function operational(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.isOperational = true;
  return err;
}

/**
 * Builds compliant milestones array for EscrowLedger from itemizedBreakdown.
 * Guarantees integer BDT amounts summing exactly to totalContractValue and
 * release percentages summing to 100.
 */
function buildMilestones(itemizedBreakdown, totalContractValue) {
  const totalInt = Math.round(totalContractValue);

  if (!Array.isArray(itemizedBreakdown) || itemizedBreakdown.length === 0) {
    const tranche1 = Math.round(totalInt * 0.30);
    const tranche2 = Math.round(totalInt * 0.40);
    const tranche3 = totalInt - (tranche1 + tranche2);
    return [
      { title: 'Project Mobilization (Advance)', releasePercentage: 30, amount: tranche1 },
      { title: 'Midpoint Completion',             releasePercentage: 40, amount: tranche2 },
      { title: 'Final Handover & Sign-off',       releasePercentage: 30, amount: tranche3 }
    ];
  }

  const rawSum = itemizedBreakdown.reduce((sum, item) => sum + Math.max(0, Math.round(Number(item.amount) || 0)), 0);
  const needsScaling = rawSum !== totalInt;

  let accumulatedAmount = 0;
  let accumulatedPercentage = 0;

  return itemizedBreakdown.map((item, index) => {
    const isLast = index === itemizedBreakdown.length - 1;

    if (isLast) {
      const residualAmount = Math.max(0, totalInt - accumulatedAmount);
      const residualPercentage = Number(Math.max(0, 100 - accumulatedPercentage).toFixed(4));
      return {
        title:             String(item.title || `Milestone ${index + 1}`).trim(),
        releasePercentage: residualPercentage,
        amount:            residualAmount
      };
    }

    const rawItemAmount = Math.max(0, Math.round(Number(item.amount) || 0));
    const itemAmount = needsScaling
      ? Math.min(
          Math.max(0, totalInt - accumulatedAmount),
          rawSum > 0 ? Math.round((rawItemAmount / rawSum) * totalInt) : Math.floor(totalInt / itemizedBreakdown.length)
        )
      : rawItemAmount;
    const itemPercentage = totalInt > 0
      ? Number(((itemAmount / totalInt) * 100).toFixed(4))
      : 0;

    accumulatedAmount += itemAmount;
    accumulatedPercentage += itemPercentage;

    return {
      title:             String(item.title || `Milestone ${index + 1}`).trim(),
      releasePercentage: itemPercentage,
      amount:            itemAmount
    };
  });
}

/**
 * Atomically transitions project, bids, escrow ledger, contractor capacity, and audit log.
 * Must be executed within an active MongoDB session.
 */
async function finalizeBidAward({ session, project, bid, actorId, actorRole, req }) {
  if (!session) {
    throw operational('finalizeBidAward requires an active ACID transaction session.', 500);
  }

  // 1. CAS project: OPEN / UNDER_BIDDING -> ASSIGNED
  const projectQuery = { _id: project._id, status: { $in: ['OPEN', 'UNDER_BIDDING'] } };
  if (project.clientId) {
    projectQuery.clientId = project.clientId;
  }

  let assignedProject = await Project.findOneAndUpdate(
    projectQuery,
    { $set: { status: 'ASSIGNED', awardedContractorId: bid.contractorId } },
    { session, returnDocument: 'after' }
  );

  if (!assignedProject) {
    // Idempotent retry check: already ASSIGNED to this contractor
    const alreadyAssignedQuery = {
      _id: project._id,
      status: 'ASSIGNED',
      awardedContractorId: bid.contractorId
    };
    if (project.clientId) {
      alreadyAssignedQuery.clientId = project.clientId;
    }
    assignedProject = await Project.findOne(alreadyAssignedQuery).session(session);

    if (!assignedProject) {
      throw operational('Concurrency Lock Triggered: This project is no longer OPEN, or you lack authorization.', 409);
    }
  }

  // 2. Reject sibling PENDING bids on this project
  await Bid.updateMany(
    { projectId: assignedProject._id, _id: { $ne: bid._id }, status: 'PENDING' },
    { $set: { status: 'REJECTED' } },
    { session }
  );

  // 3. Create or update EscrowLedger
  let newlyCreatedLedger = false;
  let ledger = await EscrowLedger.findOne(
    { projectId: assignedProject._id, contractorId: bid.contractorId, ledgerStatus: { $ne: 'CANCELLED' } },
    null,
    { session }
  );

  if (!ledger) {
    newlyCreatedLedger = true;
    const totalValue = Math.round(bid.bidAmount);
    const milestones = buildMilestones(bid.itemizedBreakdown, totalValue);
    [ledger] = await EscrowLedger.create([{
      projectId:          assignedProject._id,
      clientId:           assignedProject.clientId,
      contractorId:       bid.contractorId,
      totalContractValue: totalValue,
      ledgerStatus:       'PENDING_FUNDING',
      milestones
    }], { session });
  } else if (ledger.ledgerStatus === 'PENDING_FUNDING') {
    ledger.totalContractValue = Math.round(bid.bidAmount);
    if (Array.isArray(ledger.milestones) && ledger.milestones.length > 0) {
      const unapproved = ledger.milestones.filter(m => !['CLIENT_APPROVED', 'RELEASED', 'PAID_OFFLINE', 'COMPLETED', 'SETTLED'].includes(m.status));
      if (unapproved.length > 0) {
        const approvedSum = ledger.milestones
          .filter(m => ['CLIENT_APPROVED', 'RELEASED', 'PAID_OFFLINE', 'COMPLETED', 'SETTLED'].includes(m.status))
          .reduce((sum, m) => sum + (m.amount || 0), 0);
        const remainingAmount = Math.max(0, ledger.totalContractValue - approvedSum);
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

  // 4. Capacity accounting for the awarded contractor (on new contract formation only)
  if (newlyCreatedLedger) {
    await ContractorProfile.findOneAndUpdate(
      { userId: bid.contractorId },
      { $inc: { 'availability.currentProjects': 1 } },
      { session }
    );

    // 5. Emit FUNDS_LOCKED audit log
    await emitAudit({
      session,
      entityId:   ledger._id,
      entityType: 'ESCROW_LEDGER',
      action:     'FUNDS_LOCKED',
      actorId,
      actorRole,
      metadata: {
        bidId:              bid._id.toString(),
        projectId:          assignedProject._id.toString(),
        contractorId:       bid.contractorId.toString(),
        totalContractValue: ledger.totalContractValue,
        milestoneCount:     Array.isArray(ledger.milestones) ? ledger.milestones.length : 0,
        ledgerStatus:       ledger.ledgerStatus
      },
      ipAddress: req?.ip || 'SYSTEM_INTERNAL'
    });
  }

  return { project: assignedProject, ledger };
}

module.exports = {
  finalizeBidAward,
  buildMilestones
};
