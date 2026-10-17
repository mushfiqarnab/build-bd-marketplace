const dns = require('dns');

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
  console.log('🌐 Forced public DNS override active for settlement test.');
} catch (err) {
  console.warn('⚠️ DNS override failed:', err.message);
}

const mongoose = require('mongoose');
require('dotenv').config();

const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');
const { approveMilestoneForSettlement, settlePendingTranches } = require('../services/settlementService');

async function runSettlementDiagnostics() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000
    });
    console.log('✅ Connected to MongoDB for settlement diagnostics.');

    const admin = await User.findOneAndUpdate(
      { role: 'ADMIN', phoneNumber: process.env.TREASURY_PHONE || '01700000000' },
      {
        $set: {
          wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 },
          status: 'ACTIVE'
        },
        $setOnInsert: {
          role: 'ADMIN',
          phoneNumber: process.env.TREASURY_PHONE || '01700000000'
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    const contractor = await User.create({
      role: 'CONTRACTOR',
      phoneNumber: `018${Math.floor(10000000 + Math.random() * 90000000)}`,
      wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 },
      status: 'ACTIVE'
    });

    const client = await User.create({
      role: 'CLIENT',
      phoneNumber: `019${Math.floor(10000000 + Math.random() * 90000000)}`,
      wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 },
      status: 'ACTIVE'
    });

    const ledger = await EscrowLedger.create({
      clientId: client._id,
      contractorId: contractor._id,
      projectId: contractor._id,
      totalContractValue: 1000,
      ledgerStatus: 'FUNDED',
      milestones: [{
        title: 'Foundation',
        amount: 1000,
        releasePercentage: 100,
        status: 'PROOF_SUBMITTED'
      }]
    });

    const approval = await approveMilestoneForSettlement({ ledgerId: ledger._id, milestoneIndex: 0, actorId: client._id, actorRole: 'CLIENT' });

    if (approval.contractorPending !== 950) throw new Error(`Contractor pending clearance mismatch: expected 950, got ${approval.contractorPending}`);
    if (approval.platformPending !== 50) throw new Error(`Admin pending clearance mismatch: expected 50, got ${approval.platformPending}`);

    // Isolation: earlier suites leave their own due tranches in the shared
    // test database, and the sweep would credit their fees to the same
    // treasury account. Remove them so the wallet assertions are exact.
    await EscrowLedger.deleteMany({ _id: { $ne: ledger._id }, 'milestones.settlementStatus': 'PENDING_CLEARANCE' });

    const cleared = await settlePendingTranches({ now: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) });
    // The sweep settles EVERY due tranche in the shared test database (other
    // suites leave some), so assert on this ledger, not on the global count.
    if (!cleared || cleared.settledTranches < 1) throw new Error('Settlement worker did not process any pending tranche.');
    if ((cleared.failures || []).some((f) => f.ledgerId === String(ledger._id))) throw new Error('Settlement worker failed on this ledger.');

    const refreshedContractor = await User.findById(contractor._id);
    const refreshedAdmin = await User.findById(admin._id);
    const refreshedLedger = await EscrowLedger.findById(ledger._id);

    if (refreshedContractor.wallet.availableToWithdraw !== 950) throw new Error(`Contractor available balance mismatch: expected 950, got ${refreshedContractor.wallet.availableToWithdraw}`);
    if (refreshedContractor.wallet.pendingClearance !== 0) throw new Error(`Contractor pending balance should be zero after settlement.`);
    if (refreshedAdmin.wallet.availableToWithdraw !== 50) throw new Error(`Admin available balance mismatch: expected 50, got ${refreshedAdmin.wallet.availableToWithdraw}`);
    if (refreshedLedger.milestones[0].settlementStatus !== 'SETTLED') throw new Error('Milestone settlement status was not updated to SETTLED.');

    await EscrowLedger.findByIdAndDelete(ledger._id);
    await User.findByIdAndDelete(contractor._id);
    await User.findByIdAndDelete(client._id);

    console.log('✅ Tri-state wallet and tranche settlement verified.');
    process.exit(0);
  } catch (error) {
    console.error('💥 Settlement diagnostic failed:', error.message);
    process.exit(1);
  }
}

runSettlementDiagnostics();
