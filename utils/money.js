// utils/money.js
// Single source of truth for escrow money math. All amounts are integer BDT
// (see the Phase-2 schema validators); every helper here returns integers so
// no fractional taka can ever reach a wallet or ledger.
'use strict';

const PLATFORM_FEE_RATE = 0.05;
const CLEARANCE_DELAY_MS = 2 * 24 * 60 * 60 * 1000;

// Milestone states after which no more money moves for that milestone.
const TERMINAL_MILESTONE_STATUSES = new Set(['COMPLETED', 'PAID_OFFLINE', 'REFUNDED']);

function operational(message, statusCode) {
  return Object.assign(new Error(message), { statusCode, isOperational: true });
}

/** Splits an integer-BDT milestone amount into contractor payout + platform fee. */
function splitMilestoneAmount(amount) {
  if (!Number.isInteger(amount) || amount < 0) {
    throw operational(`Milestone amount must be a non-negative integer BDT value (got ${amount}).`, 500);
  }
  const platform = Math.round(amount * PLATFORM_FEE_RATE);
  return { contractor: amount - platform, platform };
}

function allMilestonesTerminal(milestones) {
  return Array.isArray(milestones) && milestones.length > 0
    && milestones.every((m) => TERMINAL_MILESTONE_STATUSES.has(m.status));
}

/**
 * Sequential milestone gating: work unlocks one milestone at a time. The first
 * non-terminal milestone is the only one allowed to be active; if it is still
 * PENDING it moves to IN_PROGRESS. Any other state (IN_PROGRESS, PROOF_SUBMITTED,
 * CLIENT_APPROVED, DISPUTED, LOCKED) blocks everything after it.
 * Mutates `milestones` in place. Returns the unlocked index, or -1.
 */
function unlockNextMilestone(milestones) {
  if (!Array.isArray(milestones)) return -1;
  const idx = milestones.findIndex((m) => !TERMINAL_MILESTONE_STATUSES.has(m.status));
  if (idx === -1 || milestones[idx].status !== 'PENDING') return -1;
  milestones[idx].status = 'IN_PROGRESS';
  return idx;
}

/**
 * Ledger status after a milestone settles. A still-DISPUTED milestone keeps the
 * whole ledger frozen in IN_ARBITRATION — settling some other milestone must
 * never silently lift an open dispute.
 */
function settledLedgerStatus(milestones) {
  if (milestones.some((m) => m.status === 'DISPUTED')) return 'IN_ARBITRATION';
  return allMilestonesTerminal(milestones) ? 'FULLY_DISBURSED' : 'PARTIALLY_DISBURSED';
}

function clearanceDate(from = new Date()) {
  return new Date(from.getTime() + CLEARANCE_DELAY_MS);
}

/** Mongoose `validate` spec: integer BDT within the safe-integer range. */
function integerBDT(label) {
  return {
    validator: (v) => v === null || v === undefined || (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER),
    message: `${label} must be a whole number of taka (no fractional amounts).`
  };
}

module.exports = {
  integerBDT,
  PLATFORM_FEE_RATE,
  CLEARANCE_DELAY_MS,
  TERMINAL_MILESTONE_STATUSES,
  splitMilestoneAmount,
  allMilestonesTerminal,
  unlockNextMilestone,
  settledLedgerStatus,
  clearanceDate
};
