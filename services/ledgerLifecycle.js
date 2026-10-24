// services/ledgerLifecycle.js — what must happen when a contract (EscrowLedger) reaches its end.
//
// Audit G5/K1: a contractor's `availability.currentProjects` was +1 on award but only ever released by the
// abandonment sweeper, so after `maxConcurrentProjects` (default 3) finished jobs the contractor was locked
// out of bidding forever, and no code ever moved a Project to COMPLETED.
'use strict';

const ContractorProfile = require('../models/ContractorProfile');
const Project = require('../models/Project');
const EscrowLedger = require('../models/EscrowLedger');

/** Ledger states that still occupy one of the contractor's concurrent-project slots. */
const FINISHED_LEDGER_STATUSES = ['FULLY_DISBURSED', 'CANCELLED'];

/**
 * Call inside the transaction that has just set `ledger.ledgerStatus`.
 * Runs once per contract: only on the transition INTO FULLY_DISBURSED.
 */
async function onLedgerSettled(session, ledger, previousStatus) {
  if (!ledger || ledger.ledgerStatus !== 'FULLY_DISBURSED' || previousStatus === 'FULLY_DISBURSED') return false;

  const profileQuery = ContractorProfile.findOne({ userId: ledger.contractorId });
  if (session) profileQuery.session(session);
  const profile = await profileQuery;

  if (profile) {
    const curSlots = Math.max(0, (profile.availability?.currentProjects || 1) - 1);
    if (!profile.availability) profile.availability = {};
    profile.availability.currentProjects = curSlots;

    if (!profile.statistics) profile.statistics = {};
    profile.statistics.totalProjectsCompleted = (profile.statistics.totalProjectsCompleted || 0) + 1;

    if (profile.verification?.probationStatus?.isProbation) {
      const probation = profile.verification.probationStatus;
      probation.projectsCompleted = (probation.projectsCompleted || 0) + 1;
      const required = probation.projectsRequired || 3;
      if (probation.projectsCompleted >= required) {
        probation.isProbation = false;
      }
    }

    const saveOptions = session ? { session } : {};
    await profile.save(saveOptions);
  }

  // The job is done: the project leaves ASSIGNED.
  const projectUpdateOptions = session ? { session } : {};
  await Project.updateOne({ _id: ledger.projectId, status: 'ASSIGNED' }, { $set: { status: 'COMPLETED' } }, projectUpdateOptions);
  return true;
}

/**
 * Self-healing: recompute every contractor's slot count from the ledgers that are really still open.
 * Fixes counters that drifted before this module existed and any future miss. Idempotent and cheap.
 */
async function reconcileCapacity() {
  const live = await EscrowLedger.aggregate([
    { $match: { ledgerStatus: { $nin: FINISHED_LEDGER_STATUSES } } },
    { $group: { _id: '$contractorId', n: { $sum: 1 } } }
  ]);
  const liveByContractor = new Map(live.map((r) => [String(r._id), r.n]));

  const profiles = await ContractorProfile.find({}).select('userId availability.currentProjects').lean();
  const ops = [];
  for (const p of profiles) {
    const want = liveByContractor.get(String(p.userId)) || 0;
    const have = (p.availability && p.availability.currentProjects) || 0;
    if (want !== have) ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: { 'availability.currentProjects': want } } } });
  }
  if (ops.length) await ContractorProfile.bulkWrite(ops, { ordered: false });
  return { profiles: profiles.length, corrected: ops.length };
}

module.exports = { onLedgerSettled, reconcileCapacity, FINISHED_LEDGER_STATUSES };
