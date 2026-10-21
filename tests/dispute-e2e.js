// tests/dispute-e2e.js
const dns = require('dns');
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
  console.log('🌐 Forced public DNS override active for dispute test runner.');
} catch (err) {
  console.warn('⚠️ DNS override failed:', err.message);
}

const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');
const auth = require('../middleware/auth');

async function runDisputeDiagnostics() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000
    });
    console.log('✅ Connected to MongoDB for Dispute Diagnostics.');

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

    const client = await User.create({
      role: 'CLIENT',
      phoneNumber: `016${Math.floor(10000000 + Math.random() * 90000000)}`,
      wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 },
      status: 'ACTIVE'
    });

    const contractor = await User.create({
      role: 'CONTRACTOR',
      phoneNumber: `018${Math.floor(10000000 + Math.random() * 90000000)}`,
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

    auth.verifyToken = (req, res, next) => {
      req.user = {
        userId: req.headers['x-user-id'] || client._id.toString(),
        role: req.headers['x-role'] || 'CLIENT'
      };
      next();
    };

    auth.requireRole = (roles) => (req, res, next) => {
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
      next();
    };

    const governanceRouter = require('../routes/governance');
    const app = express();
    app.use(express.json());
    app.use('/api/governance', governanceRouter);

    const server = app.listen(0);

    try {
      const disputeRes = await new Promise((resolve, reject) => {
        const req = require('http').request(
          {
            port: server.address().port,
            path: `/api/governance/dispute/${ledger._id}/milestone/0`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-role': 'CLIENT',
              'x-user-id': client._id.toString(),
              // Phase-3: /dispute is now guarded by enforceIdempotency.
              'x-idempotency-key': `dispute-e2e-${Date.now()}`
            }
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
              const contentType = res.headers['content-type'] || '';
              const parsedBody = contentType.includes('application/json') ? JSON.parse(body) : { message: body };
              resolve({ status: res.statusCode, body: parsedBody });
            });
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ reason: 'The milestone delivered poor quality and needs a formal review.' }));
        req.end();
      });

      if (disputeRes.status !== 200) throw new Error(`Dispute start failed: ${disputeRes.status}`);
      if (disputeRes.body.currentLedgerStatus !== 'IN_ARBITRATION') throw new Error('Ledger did not freeze into IN_ARBITRATION');

      const arbitrate = (arbitrationNotes, keySuffix) => new Promise((resolve, reject) => {
        const req = require('http').request(
          {
            port: server.address().port,
            path: `/api/governance/arbitrate/${ledger._id}/milestone/0`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-role': 'ADMIN',
              'x-user-id': admin._id.toString(),
              // Phase-3: /arbitrate is now guarded by enforceIdempotency.
              'x-idempotency-key': `arbitrate-e2e-${keySuffix}-${Date.now()}`
            }
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
              const contentType = res.headers['content-type'] || '';
              const parsedBody = contentType.includes('application/json') ? JSON.parse(body) : { message: body };
              resolve({ status: res.statusCode, body: parsedBody });
            });
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ decision: 'FAVOR_CLIENT', arbitrationNotes }));
        req.end();
      });

      // Binding-arbitration policy: a verdict needs >= 20 characters of real
      // justification. Short or whitespace-padded notes must be refused.
      const shortRes = await arbitrate('Refund approved', 'short');
      if (shortRes.status !== 400) throw new Error(`Short justification should be 400, got ${shortRes.status}`);
      const paddedRes = await arbitrate('ok                         ', 'padded');
      if (paddedRes.status !== 400) throw new Error(`Padded justification should be 400, got ${paddedRes.status}`);
      console.log('✅ Arbitration refuses justifications under 20 characters.');

      const arbitrateRes = await arbitrate('Refund approved: site photos show the slab was never poured.', 'valid');
      if (arbitrateRes.status !== 200) throw new Error(`Arbitration failed: ${arbitrateRes.status}`);

      const DisputeTicket = require('../models/DisputeTicket');
      const ticket = await DisputeTicket.findOne({ ledgerId: ledger._id, milestoneIndex: 0 });
      if (ticket && ticket.status !== 'RESOLVED_CANCELLED') throw new Error(`Ticket status should be RESOLVED_CANCELLED, got ${ticket.status}`);

      const refreshedLedger = await EscrowLedger.findById(ledger._id);
      const refreshedClient = await User.findById(client._id);
      const refreshedContractor = await User.findById(contractor._id);

      if (refreshedLedger.milestones[0].status !== 'REFUNDED') throw new Error('Milestone was not marked REFUNDED');
      if (refreshedLedger.ledgerStatus !== 'FULLY_DISBURSED') throw new Error('Ledger did not finalize to FULLY_DISBURSED');
      if (refreshedClient.wallet.availableToWithdraw !== 1000) throw new Error(`Client refund math drift: expected 1000, got ${refreshedClient.wallet.availableToWithdraw}`);
      if (refreshedContractor.wallet.availableToWithdraw !== 0) throw new Error(`Contractor balance changed unexpectedly: ${refreshedContractor.wallet.availableToWithdraw}`);

      console.log('✅ Dispute freeze and refund routing verified.');

      // ── CONTRACTOR ESCALATION & STALLING DIAGNOSTICS (Threat Model §4) ─────────
      console.log('⏳ Testing Contractor Stalled-Milestone Escalation & Anti-Withholding Protection...');
      const stalledLedger = await EscrowLedger.create({
        clientId: client._id,
        contractorId: contractor._id,
        projectId: contractor._id,
        totalContractValue: 2000,
        ledgerStatus: 'FUNDED',
        milestones: [{
          title: 'Roof Slab Casting',
          amount: 2000,
          releasePercentage: 100,
          status: 'PROOF_SUBMITTED',
          proofSubmittedAt: new Date() // Fresh!
        }]
      });

      // Contractor attempts dispute on a freshly-submitted proof (< 7 days) -> Expect 403
      const prematureContractorRes = await new Promise((resolve, reject) => {
        const req = require('http').request(
          {
            port: server.address().port,
            path: `/api/governance/dispute/${stalledLedger._id}/milestone/0`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-role': 'CONTRACTOR',
              'x-user-id': contractor._id.toString(),
              'x-idempotency-key': `premature-dispute-${Date.now()}`
            }
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
              const contentType = res.headers['content-type'] || '';
              const parsedBody = contentType.includes('application/json') ? JSON.parse(body) : { message: body };
              resolve({ status: res.statusCode, body: parsedBody });
            });
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ reason: 'Client has not approved my proof yet.' }));
        req.end();
      });

      if (prematureContractorRes.status !== 403) {
        throw new Error(`Premature contractor dispute should be 403, got ${prematureContractorRes.status}`);
      }
      console.log('  ✅ Premature contractor dispute (<7 days) refused with 403.');

      // Simulate stalling: age the submission to 8 days ago
      await EscrowLedger.updateOne(
        { _id: stalledLedger._id },
        { $set: { 'milestones.0.proofSubmittedAt': new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } }
      );

      // Run background escalation worker
      const { escalateStalledMilestones } = require('../services/milestoneEscalationService');
      const escResult = await escalateStalledMilestones({ stallDays: 7 });
      if (escResult.escalated < 1) {
        throw new Error(`Milestone escalation worker failed to escalate stalled milestone: ${JSON.stringify(escResult)}`);
      }
      console.log('  ✅ Milestone escalation worker detected and flagged stalled milestone.');

      // Contractor disputes the stalled milestone -> Expect 200
      const contractorDisputeRes = await new Promise((resolve, reject) => {
        const req = require('http').request(
          {
            port: server.address().port,
            path: `/api/governance/dispute/${stalledLedger._id}/milestone/0`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-role': 'CONTRACTOR',
              'x-user-id': contractor._id.toString(),
              'x-idempotency-key': `contractor-stalled-dispute-${Date.now()}`
            }
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
              const contentType = res.headers['content-type'] || '';
              const parsedBody = contentType.includes('application/json') ? JSON.parse(body) : { message: body };
              resolve({ status: res.statusCode, body: parsedBody });
            });
          }
        );
        req.on('error', reject);
        req.write(JSON.stringify({ reason: 'Client has been completely unresponsive for 8 days after valid proof submission.' }));
        req.end();
      });

      if (contractorDisputeRes.status !== 200) {
        throw new Error(`Contractor dispute on stalled milestone failed: ${contractorDisputeRes.status} -> ${JSON.stringify(contractorDisputeRes.body)}`);
      }

      const finalStalledLedger = await EscrowLedger.findById(stalledLedger._id);
      if (finalStalledLedger.ledgerStatus !== 'IN_ARBITRATION') throw new Error('Ledger did not freeze into IN_ARBITRATION');
      if (finalStalledLedger.milestones[0].disputedBy !== 'CONTRACTOR') throw new Error('disputedBy was not set to CONTRACTOR');

      const contractorTicket = await DisputeTicket.findOne({ ledgerId: stalledLedger._id, milestoneIndex: 0 });
      if (!contractorTicket || contractorTicket.disputedBy !== 'CONTRACTOR') {
        throw new Error('DisputeTicket was not created or disputedBy mismatch');
      }
      console.log('  ✅ Contractor successfully escalated stalled milestone into IN_ARBITRATION with DisputeTicket created.');

      await EscrowLedger.findByIdAndDelete(stalledLedger._id);
      await DisputeTicket.findByIdAndDelete(contractorTicket._id);

      console.log('🏆 DISPUTE ARBITRATION FLOW VERIFIED.');
      process.exit(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await EscrowLedger.findByIdAndDelete(ledger._id);
      await User.findByIdAndDelete(client._id);
      await User.findByIdAndDelete(contractor._id);
      await User.findByIdAndDelete(admin._id);
    }
  } catch (error) {
    console.error('💥 DISPUTE DIAGNOSTIC FAILED:', error.message);
    process.exit(1);
  }
}

runDisputeDiagnostics();
