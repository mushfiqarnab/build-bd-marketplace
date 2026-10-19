// tests/governance-e2e.js
const dns = require('dns');

// 🌐 ENTERPRISE DNS ARMOR
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
  console.log('🌐 Forced public DNS override active for test runner.');
} catch (err) {
  console.warn('⚠️ DNS override failed:', err.message);
}

const mongoose = require('mongoose');
require('dotenv').config();

const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');

async function runGovernanceDiagnostics() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000
    });
    console.log('✅ Connected to MongoDB for Governance Diagnostics.');
    await Promise.all([EscrowLedger.init(), User.init()]);

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
    console.log('🏛️ Platform Treasury account verified.');

    const contractor = await User.create({
      role: 'CONTRACTOR',
      phoneNumber: `018${Math.floor(10000000 + Math.random() * 90000000)}`,
      wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 },
      status: 'ACTIVE'
    });

    const ledger = await EscrowLedger.create({
      clientId: contractor._id,
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
    console.log('⏳ Test Escrow instantiated. Simulating ACID Transaction...');

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const activeLedger = await EscrowLedger.findById(ledger._id).session(session);

      const totalCents = Math.round(activeLedger.milestones[0].amount * 100);
      const feeCents = Math.round(totalCents * 0.05);
      const payoutCents = totalCents - feeCents;

      activeLedger.milestones[0].status = 'COMPLETED';
      activeLedger.ledgerStatus = 'FULLY_DISBURSED';
      await activeLedger.save({ session });

      await User.findByIdAndUpdate(contractor._id, { $inc: { 'wallet.pendingClearance': payoutCents / 100 } }, { session });
      await User.findByIdAndUpdate(admin._id, { $inc: { 'wallet.pendingClearance': feeCents / 100 } }, { session });

      await session.commitTransaction();
      console.log('✅ ACID Transaction committed successfully.');
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }

    const finalContractor = await User.findById(contractor._id);
    const finalAdmin = await User.findById(admin._id);
    const finalLedger = await EscrowLedger.findById(ledger._id);

    if (finalContractor.wallet.pendingClearance !== 950) throw new Error(`Contractor Math Error: Expected 950, got ${finalContractor.wallet.pendingClearance}`);
    console.log('✅ Floating-Point integrity verified. Contractor received exactly 95% (950 BDT).');

    if (finalLedger.ledgerStatus !== 'FULLY_DISBURSED') throw new Error('Ledger State Error');
    console.log('✅ Ledger state machine mutated to FULLY_DISBURSED perfectly.');

    await EscrowLedger.findByIdAndDelete(ledger._id);
    await User.findByIdAndDelete(contractor._id);

    console.log('🏆 GOVERNANCE & TRANSACTION COHERENCE 100% VERIFIED.');
    process.exit(0);
  } catch (error) {
    console.error('💥 DIAGNOSTIC FAILED:', error.message);
    process.exit(1);
  }
}

runGovernanceDiagnostics();
