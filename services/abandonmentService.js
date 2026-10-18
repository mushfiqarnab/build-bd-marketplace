// services/abandonmentService.js
// Phase 28 — Ghost Contract Abandonment Reconciliation
//
// Problem it solves:
//   When a client forms a contract (EscrowLedger created, Project → ASSIGNED)
//   but abandons the payment gateway before funding, the system enters a
//   "ghost contract" state:
//     - EscrowLedger sits at PENDING_FUNDING forever
//     - Project is permanently locked as ASSIGNED
//     - Contractor believes they have work but no funds ever arrive
//     - Neither party can re-engage the marketplace
//
// This service is the autonomous anti-deadlock engine for that state.
//
// Design decisions (chosen over the plan's suggestions — with reasons):
//
//   [1] setInterval over node-cron
//       Your entire codebase (server.js lines 195-230) uses setInterval().unref()
//       for background workers. Adding a new scheduler library for identical
//       semantics is architectural inconsistency. setInterval is lighter,
//       zero-dependency, and already tested in your production boot sequence.
//
//   [2] Bid.status → 'WITHDRAWN' (not 'REJECTED')
//       'REJECTED' implies the client evaluated and declined the bid.
//       The client *accepted* the bid; they simply didn't pay.
//       'WITHDRAWN' correctly signals that the offer has lapsed — the
//       contractor is not penalised, and can bid on the same project again
//       after it re-opens. Both values already exist in the Bid enum.
//
//   [3] One session per ledger (not a batched single session)
//       Mirrors the pattern in reconciliationService.js. If one ledger's
//       rollback fails (e.g., a concurrent IPN arrived and funded it),
//       the other ledgers continue unaffected. A single batched transaction
//       would roll back ALL ledgers on any single failure.
//
//   [4] CAS (Compare-And-Swap) predicate on the EscrowLedger update
//       The atomic update only applies if ledgerStatus is still PENDING_FUNDING.
//       If a concurrent IPN funded it between our query and our write,
//       findOneAndUpdate returns null → we skip cleanly. No double-processing.
//
//   [5] ContractorProfile.availability.currentProjects decremented
//       Phase 27 incremented this on contract formation. Rollback must mirror it.
//       We clamp to min 0 using $max to prevent going negative on any edge case.
//
//   [6] emitAudit is NOT used here (AuditLog.create directly instead)
//       emitAudit() from auditService.js throws if session is null — it was
//       designed for inline route handlers. In a background worker the session
//       lifecycle is managed per-ledger, making direct create([...], { session })
//       the correct pattern. This mirrors how reconciliationService.js handles it.

const { runTransaction } = require('../utils/transaction');
const EscrowLedger      = require('../models/EscrowLedger');
const Project           = require('../models/Project');
const Bid               = require('../models/Bid');
const ContractorProfile = require('../models/ContractorProfile');
const AuditLog          = require('../models/AuditLog');

// ─────────────────────────────────────────────
// Configuration — all values overrideable via env
// ─────────────────────────────────────────────
const EXPIRY_WINDOW_MS = Number(process.env.CONTRACT_ABANDONMENT_EXPIRY_MS || 60 * 60 * 1000); // 60 min
const BATCH_LIMIT      = Number(process.env.CONTRACT_ABANDONMENT_BATCH    || 50);
// A checkout opened within this window may still complete at the gateway
// (bKash/Nagad/bank approvals can lag). Cancelling under it would let a late
// but valid IPN land on a CANCELLED ledger — money captured, no escrow.
const CHECKOUT_GRACE_MS = Number(process.env.CONTRACT_CHECKOUT_GRACE_MS || 3 * 60 * 60 * 1000); // 3 h

/** Filter: no gateway checkout started within the grace window. */
function noRecentCheckout(now) {
  return { $or: [{ paymentInitiatedAt: null }, { paymentInitiatedAt: { $lt: new Date(now.getTime() - CHECKOUT_GRACE_MS) } }] };
}

// ─────────────────────────────────────────────
// rollbackAbandonedLedger
//
// Performs a single isolated ACID rollback for one expired ledger.
// Returns { rolled: true } on success, { rolled: false, reason } if the ledger
// was already resolved by a concurrent process.
//
// Transaction sequence:
//   1. CAS claim on EscrowLedger (PENDING_FUNDING → CANCELLED)
//   2. Project revert (ASSIGNED → OPEN, clear awardedContractorId)
//   3. Bid revert (ACCEPTED → WITHDRAWN)
//   4. ContractorProfile decrement (currentProjects -= 1, floor 0)
//   5. AuditLog immutable record
// ─────────────────────────────────────────────
async function rollbackAbandonedLedger(ledger, { now = new Date() } = {}) {
  // Retried transaction (utils/transaction.js). Safe to re-run: every decision
  // is the in-session CAS below; `ledger` only supplies immutable ids.
  return runTransaction(async (session) => {

    // ── Step 1: CAS claim — only proceed if still PENDING_FUNDING ──────────
    // If a concurrent IPN arrived and funded this ledger between our batch
    // query and now — or the client opened a checkout meanwhile — this
    // update returns null and we abort cleanly.
    const claimed = await EscrowLedger.findOneAndUpdate(
      { _id: ledger._id, ledgerStatus: 'PENDING_FUNDING', ...noRecentCheckout(now) },
      { $set: { ledgerStatus: 'CANCELLED' } },
      { session, returnDocument: 'after' }
    );

    if (!claimed) {
      // Another process (IPN webhook, concurrent worker) already resolved this.
      return { rolled: false, reason: 'already_resolved' };
    }

    // ── Step 2: Revert Project → OPEN, clear awardedContractorId ───────────
    await Project.findByIdAndUpdate(
      ledger.projectId,
      {
        $set:   { status: 'OPEN' },
        $unset: { awardedContractorId: '' }
      },
      { session }
    );

    // ── Step 3: Revert Bid → WITHDRAWN (lapsed offer, contractor not penalised) ──
    // Find by projectId + contractorId since EscrowLedger has no bidId field.
    await Bid.findOneAndUpdate(
      { projectId: ledger.projectId, contractorId: ledger.contractorId, status: 'ACCEPTED' },
      { $set: { status: 'WITHDRAWN' } },
      { session }
    );

    // ── Step 4: Decrement contractor's active project count ─────────────────
    // $max: 0 clamps the floor — prevents going negative on any schema-level edge case.
    const profile = await ContractorProfile.findOneAndUpdate(
      { userId: ledger.contractorId },
      { $inc: { 'availability.currentProjects': -1 } },
      { session, returnDocument: 'after' }
    );

    // Floor clamp: if decrement pushed below 0, correct it in the same session
    if (profile && profile.availability.currentProjects < 0) {
      await ContractorProfile.findByIdAndUpdate(
        profile._id,
        { $set: { 'availability.currentProjects': 0 } },
        { session }
      );
    }

    // ── Step 5: Immutable AuditLog entry ────────────────────────────────────
    // We use AuditLog.create directly (not emitAudit()) because emitAudit()
    // requires a session parameter but was designed for route handlers where
    // the session is already in scope. In a background worker the pattern
    // used by reconciliationService.js is direct model create with { session }.
    await AuditLog.create(
      [{
        entityId:   ledger._id,
        entityType: 'ESCROW_LEDGER',
        action:     'CONTRACT_EXPIRED_UNPAID',
        actorId:    ledger.clientId,       // client who abandoned the payment
        actorRole:  'CLIENT',
        metadata: {
          projectId:          ledger.projectId.toString(),
          contractorId:       ledger.contractorId.toString(),
          totalContractValue: ledger.totalContractValue,
          ageMinutes:         Math.round((Date.now() - ledger.createdAt.getTime()) / 60000),
          expiryWindowMinutes: Math.round(EXPIRY_WINDOW_MS / 60000)
        },
        ipAddress: 'SYSTEM_WORKER'
      }],
      { session }
    );

    return { rolled: true };
  });
}

// ─────────────────────────────────────────────
// runAbandonmentSweep
//
// The main sweep function called by the server's background worker interval.
// Queries for expired PENDING_FUNDING ledgers in batches and rolls each back
// in an isolated transaction. One failure never blocks the rest.
//
// Returns a summary object for server.js logging.
// ─────────────────────────────────────────────
async function runAbandonmentSweep({ now = new Date() } = {}) {
  const expiryThreshold = new Date(now.getTime() - EXPIRY_WINDOW_MS);

  const summary = {
    scanned:  0,
    rolledBack: 0,
    skipped:  0,   // already resolved by concurrent process (e.g., late IPN)
    errors:   0
  };

  // Fetch only IDs first — lean batch scan against the compound index
  // { ledgerStatus: 1, createdAt: 1 } added to EscrowLedger in this phase.
  const candidates = await EscrowLedger
    .find(
      {
        ledgerStatus: 'PENDING_FUNDING',
        createdAt:    { $lt: expiryThreshold },
        ...noRecentCheckout(now)
      },
      { _id: 1, projectId: 1, contractorId: 1, clientId: 1, totalContractValue: 1, createdAt: 1 }
    )
    .sort({ createdAt: 1 })   // oldest first — most urgent to resolve
    .limit(BATCH_LIMIT)
    .lean();

  summary.scanned = candidates.length;
  if (candidates.length === 0) return summary;

  console.log(
    `👻 [Abandonment] Found ${candidates.length} ghost contract(s) older than ` +
    `${Math.round(EXPIRY_WINDOW_MS / 60000)} min. Starting rollback sweep...`
  );

  for (const ledger of candidates) {
    try {
      const result = await rollbackAbandonedLedger(ledger, { now });

      if (result.rolled) {
        summary.rolledBack += 1;
        console.log(
          `✅ [Abandonment] Rolled back ghost contract. ` +
          `ledger=${ledger._id} project=${ledger.projectId} ` +
          `age=${Math.round((now - ledger.createdAt) / 60000)}min`
        );
      } else {
        summary.skipped += 1;
        console.log(
          `⏭️  [Abandonment] Skipped ledger ${ledger._id} (reason: ${result.reason})`
        );
      }
    } catch (err) {
      summary.errors += 1;
      // Isolated failure: log but never throw — remaining ledgers must still process
      console.error(
        `❌ [Abandonment] Rollback failed for ledger ${ledger._id}:`,
        err.message
      );
    }
  }

  return summary;
}

module.exports = {
  runAbandonmentSweep,
  rollbackAbandonedLedger, // exported for unit testing
  EXPIRY_WINDOW_MS,
  BATCH_LIMIT
};
