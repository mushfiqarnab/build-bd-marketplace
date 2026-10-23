const crypto = require('crypto');
const ContractorProfile = require('../models/ContractorProfile');

/**
 * Stable fingerprint of the bid economic payload.
 * Used as an at-rest integrity seal — not a substitute for Mongo unique indexes.
 */
function computeBidFingerprint({ projectId, contractorId, bidAmount, estimatedDays, proposalText, itemizedBreakdown }) {
  const obj = {
    projectId: String(projectId),
    contractorId: String(contractorId),
    bidAmount: Number(bidAmount),
    estimatedDays: Number(estimatedDays),
    proposalText: String(proposalText || '').trim()
  };
  if (Array.isArray(itemizedBreakdown) && itemizedBreakdown.length > 0) {
    obj.itemizedBreakdown = itemizedBreakdown.map((item) => ({
      taskName: String(item.taskName || '').trim(),
      unit: String(item.unit || '').trim(),
      rateBDT: Number(item.rateBDT || 0),
      quantity: Number(item.quantity || 0),
      amountBDT: Number(item.amountBDT || 0)
    }));
  }
  const payload = JSON.stringify(obj);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Spec §8–9 eligibility gate before a contractor may place a bid.
 * Returns { ok: true, profile } or { ok: false, statusCode, message }.
 *
 * Note: `verification.probationStatus.canBidAbove` is a MAX CAP (poor historical name).
 * Probation contractors may bid only up to that amount inclusive.
 */
async function assertContractorBidEligibility({ userId, bidAmount }) {
  const profile = await ContractorProfile.findOne({ userId });

  if (!profile) {
    return {
      ok: false,
      statusCode: 403,
      message: 'Contractor profile required. Complete your trade profile before bidding.'
    };
  }

  if (profile.verification.status !== 'VERIFIED') {
    return {
      ok: false,
      statusCode: 403,
      message: `Access Denied: Contractor verification status is '${profile.verification.status}'. Only VERIFIED contractors may bid.`
    };
  }

  const probation = profile.verification.probationStatus || {};
  if (probation.isProbation) {
    // canBidAbove is a ceiling, not a floor.
    const maxAllowed = Number(probation.canBidAbove ?? 100000);
    if (Number(bidAmount) > maxAllowed) {
      return {
        ok: false,
        statusCode: 403,
        message: `Probation Violation: New contractors are capped at ${maxAllowed} BDT per project.`
      };
    }
  }

  const availability = profile.availability || {};
  const current = Number(availability.currentProjects || 0);
  const maxConcurrent = Number(availability.maxConcurrentProjects || 3);
  if (current >= maxConcurrent) {
    return {
      ok: false,
      statusCode: 403,
      message: 'Capacity Lockout: You have reached your maximum active concurrent projects limit.'
    };
  }

  return { ok: true, profile };
}

module.exports = {
  computeBidFingerprint,
  assertContractorBidEligibility
};
