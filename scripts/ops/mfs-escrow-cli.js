// scripts/ops/mfs-escrow-cli.js
// ═════════════════════════════════════════════════════════════════════════════
// Build-BD Marketplace v3 — CLI Operator Console for ৳0-Cost MFS Escrow
//
// Usage:
//   node scripts/ops/mfs-escrow-cli.js --list
//   node scripts/ops/mfs-escrow-cli.js --verify <ledgerId> <trxId> <amountBdt>
//   node scripts/ops/mfs-escrow-cli.js --payouts
//   node scripts/ops/mfs-escrow-cli.js --pay-payout <withdrawalId> <bankTrxId>
//
// Provides ACID double-entry verified escrow funding and payout reconciliation
// directly from the terminal without needing an SSLCommerz Merchant portal.
// ═════════════════════════════════════════════════════════════════════════════

'use strict';

require('dns').setServers(['8.8.8.8', '1.1.1.1']);
const path = require('path');
const mongoose = require('mongoose');

const ROOT = path.resolve(__dirname, '..', '..');

// Load env if not already loaded
if (!process.env.MONGODB_URI) {
  try {
    if (require('fs').existsSync(path.join(ROOT, '.env.beta'))) {
      require('dotenv').config({ path: path.join(ROOT, '.env.beta') });
    } else {
      require('dotenv').config({ path: path.join(ROOT, '.env') });
    }
  } catch (_) {}
}

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:54569/build-bd?replicaSet=rs0';

const EscrowLedger = require('../../models/EscrowLedger');
const WithdrawalLedger = require('../../models/WithdrawalLedger');
const User = require('../../models/User');
const { runTransaction } = require('../../utils/transaction');
const { emitAudit } = require('../../services/auditService');

const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

async function connectDb() {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(MONGODB_URI);
  }
}

async function listPendingMfs() {
  await connectDb();
  console.log(`\n${COLORS.bold}${COLORS.cyan}━━━ Pending Manual MFS Escrow Deposits ━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}\n`);

  const pending = await EscrowLedger.find({
    ledgerStatus: 'PENDING_FUNDING',
    pendingTransactionId: /^MFS-/
  })
    .populate('projectId', 'title category')
    .populate('clientId', 'name phoneNumber')
    .sort({ paymentInitiatedAt: -1 })
    .lean();

  if (pending.length === 0) {
    console.log(`${COLORS.green}✔ No pending MFS escrow submissions awaiting operator verification.${COLORS.reset}\n`);
    return;
  }

  console.log(`Found ${COLORS.bold}${pending.length}${COLORS.reset} deposit(s) awaiting verification:\n`);
  for (const item of pending) {
    const rawTrx = item.pendingTransactionId || '—';
    const cleanTrx = rawTrx.replace(/^MFS-[^-]+-/, '');
    const clientName = (item.clientId && item.clientId.name) || 'Client';
    const clientPhone = (item.clientId && item.clientId.phoneNumber) || '—';
    const projectTitle = (item.projectId && item.projectId.title) || 'Project';

    console.log(`  ${COLORS.yellow}• Ledger ID:${COLORS.reset}   ${item._id}`);
    console.log(`    Project:     ${projectTitle}`);
    console.log(`    Client:      ${clientName} (${clientPhone})`);
    console.log(`    Amount:      ${COLORS.bold}৳${item.totalContractValue.toLocaleString('en-IN')}${COLORS.reset}`);
    console.log(`    TrxID:       ${COLORS.cyan}${cleanTrx}${COLORS.reset} (${rawTrx})`);
    console.log(`    Submitted:   ${item.paymentInitiatedAt ? new Date(item.paymentInitiatedAt).toLocaleString('en-GB') : '—'}`);
    console.log(`    ${COLORS.gray}Verify via:  node scripts/ops/mfs-escrow-cli.js --verify ${item._id} ${cleanTrx} ${item.totalContractValue}${COLORS.reset}\n`);
  }
}

async function verifyMfs(ledgerId, trxId, amountBdt) {
  if (!ledgerId || !trxId || !amountBdt) {
    console.error(`${COLORS.red}Error: Missing arguments.${COLORS.reset}`);
    console.log(`Usage: node scripts/ops/mfs-escrow-cli.js --verify <ledgerId> <trxId> <amountBdt>`);
    process.exit(1);
  }

  await connectDb();
  const cleanTrx = String(trxId).trim().toUpperCase();
  const verifiedAmount = Number(amountBdt);

  console.log(`\nVerifying Escrow Ledger ${COLORS.bold}${ledgerId}${COLORS.reset}...`);
  console.log(`TrxID: ${cleanTrx} | Amount: ৳${verifiedAmount}\n`);

  try {
    const funded = await runTransaction(async (session) => {
      const ledger = await EscrowLedger.findById(ledgerId).session(session);
      if (!ledger) {
        throw new Error(`Escrow ledger ${ledgerId} not found.`);
      }
      if (ledger.ledgerStatus !== 'PENDING_FUNDING') {
        throw new Error(`Escrow ledger is already in state: ${ledger.ledgerStatus}`);
      }
      if (verifiedAmount !== ledger.totalContractValue) {
        throw new Error(`Verified amount (৳${verifiedAmount}) does not match contract value (৳${ledger.totalContractValue})!`);
      }

      const valId = `MFS-VAL-${cleanTrx}`;
      const resLedger = await EscrowLedger.findOneAndUpdate(
        { _id: ledgerId, ledgerStatus: 'PENDING_FUNDING' },
        {
          $set: {
            ledgerStatus: 'FUNDED',
            paidAt: new Date(),
            paidByValId: valId,
            fundedAmount: ledger.totalContractValue,
            paymentVerifiedBy: 'CLI_OPERATOR'
          }
        },
        { session, returnDocument: 'after' }
      );

      if (resLedger.milestones && resLedger.milestones.length > 0) {
        resLedger.milestones[0].status = 'IN_PROGRESS';
        await resLedger.save({ session });
      }

      await emitAudit(
        'MANUAL_MFS_ESCROW_FUNDED_VIA_CLI',
        {
          ledgerId: resLedger._id,
          projectId: resLedger.projectId,
          clientId: resLedger.clientId,
          contractorId: resLedger.contractorId,
          amountBdt: resLedger.totalContractValue,
          valId,
          verifiedTrxId: cleanTrx
        },
        session
      );

      return resLedger;
    });

    console.log(`${COLORS.green}${COLORS.bold}✔ ESCROW FUNDED SUCCESSFULLY!${COLORS.reset}`);
    console.log(`Ledger ${funded._id} is now ${COLORS.green}FUNDED${COLORS.reset}.`);
    console.log(`Milestone 0 unlocked (IN_PROGRESS). Contractor can now commence work.\n`);
  } catch (err) {
    console.error(`${COLORS.red}${COLORS.bold}✖ Verification Failed:${COLORS.reset} ${err.message}\n`);
    process.exit(1);
  }
}

async function listPayouts() {
  await connectDb();
  console.log(`\n${COLORS.bold}${COLORS.cyan}━━━ Pending Contractor & Supplier Payouts ━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}\n`);

  const pending = await WithdrawalLedger.find({
    status: { $in: ['PROCESSING', 'MANUAL_REVIEW'] }
  })
    .populate('userId', 'name phoneNumber role')
    .sort({ createdAt: 1 })
    .lean();

  if (pending.length === 0) {
    console.log(`${COLORS.green}✔ No pending withdrawal payouts in queue.${COLORS.reset}\n`);
    return;
  }

  console.log(`Found ${COLORS.bold}${pending.length}${COLORS.reset} pending payout request(s):\n`);
  for (const item of pending) {
    const user = item.userId || {};
    const bank = item.destinationBankDetails || {};
    console.log(`  ${COLORS.yellow}• Withdrawal ID:${COLORS.reset} ${item._id}`);
    console.log(`    Recipient:      ${user.name || 'Vendor'} (${user.phoneNumber || '—'}) [${user.role || 'VENDOR'}]`);
    console.log(`    Amount:         ${COLORS.bold}৳${item.amount.toLocaleString('en-IN')}${COLORS.reset}`);
    console.log(`    Bank Name:      ${bank.bankName || '—'}`);
    console.log(`    Account Name:   ${bank.accountName || '—'}`);
    console.log(`    Account Number: ${bank.accountNumber || '—'}`);
    console.log(`    Routing Number: ${bank.routingNumber || '—'}`);
    console.log(`    Status:         ${item.status}`);
    console.log(`    ${COLORS.gray}Complete via:   node scripts/ops/mfs-escrow-cli.js --pay-payout ${item._id} <BankRef/TrxID>${COLORS.reset}\n`);
  }
}

async function completePayout(withdrawalId, bankTrxId) {
  if (!withdrawalId || !bankTrxId) {
    console.error(`${COLORS.red}Error: Missing arguments.${COLORS.reset}`);
    console.log(`Usage: node scripts/ops/mfs-escrow-cli.js --pay-payout <withdrawalId> <bankTrxId>`);
    process.exit(1);
  }

  await connectDb();
  console.log(`\nMarking payout ${COLORS.bold}${withdrawalId}${COLORS.reset} as COMPLETED...`);

  try {
    const updated = await WithdrawalLedger.findOneAndUpdate(
      { _id: withdrawalId, status: { $in: ['PROCESSING', 'MANUAL_REVIEW'] } },
      {
        $set: {
          status: 'COMPLETED',
          bankTransactionId: String(bankTrxId).trim(),
          completedAt: new Date()
        }
      },
      { returnDocument: 'after' }
    );

    if (!updated) {
      throw new Error(`Withdrawal ${withdrawalId} not found or not in PROCESSING/MANUAL_REVIEW state.`);
    }

    console.log(`${COLORS.green}${COLORS.bold}✔ PAYOUT COMPLETED!${COLORS.reset}`);
    console.log(`Withdrawal ${updated._id} marked COMPLETED with reference: ${bankTrxId}\n`);
  } catch (err) {
    console.error(`${COLORS.red}${COLORS.bold}✖ Failed to update payout:${COLORS.reset} ${err.message}\n`);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  try {
    if (cmd === '--list') {
      await listPendingMfs();
    } else if (cmd === '--verify') {
      await verifyMfs(args[1], args[2], args[3]);
    } else if (cmd === '--payouts') {
      await listPayouts();
    } else if (cmd === '--pay-payout') {
      await completePayout(args[1], args[2]);
    } else {
      console.log(`\n${COLORS.bold}${COLORS.yellow}🇧🇩 Build-BD MFS Escrow & Treasury Operations Console${COLORS.reset}`);
      console.log(`\nCommands:`);
      console.log(`  --list                                  List all pending manual bKash/Nagad escrows`);
      console.log(`  --verify <ledgerId> <trxId> <amountBdt> Verify SMS TrxID and unlock Milestone 0`);
      console.log(`  --payouts                               List pending contractor/supplier bank withdrawals`);
      console.log(`  --pay-payout <id> <bankTrxId>           Mark a bank/MFS payout as completed\n`);
    }
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
}

main().catch((err) => {
  console.error('Fatal CLI error:', err);
  process.exit(1);
});
