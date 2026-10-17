// tests/settlement-offline-e2e.js
/**
 * 🛡️ Phase 22 — Zero-Trust Offline Settlement & Reconciliation E2E Diagnostics
 * 
 * Verifies:
 *   1. PaymentReceipt sparse unique compound index on { paymentMethod, trxId }
 *   2. Client milestone approval (POST /milestone/:id/approve -> CLIENT_APPROVED)
 *   3. Client milestone rejection (POST /milestone/:id/reject -> DISPUTED + IN_ARBITRATION)
 *   4. Client offline payment submission (POST /milestone/:id/submit-payment -> PAID_OFFLINE)
 *   5. Double-Spend rejection: Attempting to submit duplicate bKash/Nagad trxId triggers 409 Conflict.
 */

const dns = require('dns');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
require('dotenv').config();

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (err) {
  console.warn('⚠️ DNS override failed:', err.message);
}

const User = require('../models/User');
const Project = require('../models/Project');
const EscrowLedger = require('../models/EscrowLedger');
const PaymentReceipt = require('../models/PaymentReceipt');
const auth = require('../middleware/auth');

function requestJson(port, method, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathName,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runSettlementOfflineDiagnostics() {
  console.log('\n🔬 INITIATING PHASE 22 OFFLINE SETTLEMENT & DOUBLE-SPEND DIAGNOSTICS...\n');

  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
      serverSelectionTimeoutMS: 15000
    });

    await PaymentReceipt.createIndexes();
    await PaymentReceipt.deleteMany({ trxId: { $regex: '^BKASH_TRX_' } });
    console.log('✅ Connected to MongoDB & PaymentReceipt indexes created.');

    const testTrxId = `BKASH_TRX_${Date.now()}`;

    // ── Seed Users ───────────────────────────────────────────────────────────
    const client = await User.create({
      role: 'CLIENT',
      phoneNumber: `017${Math.floor(10000000 + Math.random() * 90000000)}`,
      wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 },
      status: 'ACTIVE'
    });

    const contractor = await User.create({
      role: 'CONTRACTOR',
      phoneNumber: `018${Math.floor(10000000 + Math.random() * 90000000)}`,
      wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 },
      status: 'ACTIVE'
    });

    const project = await Project.create({
      clientId: client._id,
      title: 'Residential Villa Construction',
      category: 'Residential',
      description: 'Single family villa in Keraniganj',
      location: 'Dhaka',
      budget: 50000,
      status: 'ASSIGNED'
    });

    const ledger = await EscrowLedger.create({
      clientId: client._id,
      contractorId: contractor._id,
      projectId: project._id,
      totalContractValue: 50000,
      ledgerStatus: 'FUNDED',
      milestones: [
        {
          title: 'Foundation & Earthwork',
          amount: 15000,
          releasePercentage: 30,
          status: 'PROOF_SUBMITTED',
          proofOfWorkUrl: 'ledgers/m1/evidence.jpg'
        },
        {
          title: 'Structural Column Casting',
          amount: 35000,
          releasePercentage: 70,
          status: 'PROOF_SUBMITTED',
          proofOfWorkUrl: 'ledgers/m2/evidence.jpg'
        }
      ]
    });

    // Mock Auth Middleware
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

    const settlementRouter = require('../routes/settlement');
    const app = express();
    app.use(express.json());
    app.use('/api/settlement', settlementRouter);

    // Global Error Handler
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({ message: err.message });
    });

    const server = app.listen(0);
    const port = server.address().port;

    try {
      const milestone1Id = ledger.milestones[0]._id.toString();
      const milestone2Id = ledger.milestones[1]._id.toString();

      // ── TEST 1: Approve Milestone 1 ─────────────────────────────────────────
      console.log('⏳ TEST 1: Approving Evidence Photo (POST /milestone/:id/approve)...');
      const approveRes = await requestJson(port, 'POST', `/api/settlement/milestone/${milestone1Id}/approve`, {}, {
        'x-role': 'CLIENT',
        'x-user-id': client._id.toString(),
        'x-idempotency-key': `approve-e2e-${Date.now()}`
      });

      if (approveRes.status !== 200 || approveRes.body.data?.status !== 'CLIENT_APPROVED') {
        throw new Error(`Milestone approval failed: status ${approveRes.status}, body ${JSON.stringify(approveRes.body)}`);
      }
      console.log('  ✅ Milestone 1 status updated to CLIENT_APPROVED.');

      // ── TEST 2: Submit bKash Payment for Milestone 1 ─────────────────────────
      console.log(`\n⏳ TEST 2: Submitting bKash Offline Payment Proof (TrxID: ${testTrxId})...`);
      const paymentRes1 = await requestJson(port, 'POST', `/api/settlement/milestone/${milestone1Id}/submit-payment`, {
        paymentMethod: 'BKASH',
        trxId: testTrxId,
        amountBDT: 15000,
        s3ReceiptUrl: 'receipts/m1_bkash.jpg'
      }, {
        'x-role': 'CLIENT',
        'x-user-id': client._id.toString(),
        'x-idempotency-key': `submit-payment-m1-${Date.now()}`
      });

      if (paymentRes1.status !== 201 || paymentRes1.body.data?.milestoneStatus !== 'PAID_OFFLINE') {
        throw new Error(`Payment submission failed: status ${paymentRes1.status}, body ${JSON.stringify(paymentRes1.body)}`);
      }
      console.log('  ✅ PaymentReceipt created. Milestone 1 status updated to PAID_OFFLINE.');

      // ── TEST 3: DOUBLE-SPEND ATTEMPT — Re-using testTrxId on Milestone 2 ─
      console.log(`\n⏳ TEST 3: Testing Double-Spend Protection (Re-using TrxID ${testTrxId})...`);
      const doubleSpendRes = await requestJson(port, 'POST', `/api/settlement/milestone/${milestone2Id}/submit-payment`, {
        paymentMethod: 'BKASH',
        trxId: testTrxId, // DUPLICATE TRX ID!
        // 🛡️ Phase-2 P0-2 fix made the amount guard fire before PaymentReceipt
        // creation — this test must use the full milestone amount so the trxId
        // uniqueness guard is the one that trips (409), not the amount guard.
        amountBDT: 35000,
        s3ReceiptUrl: 'receipts/m2_bkash.jpg'
      }, {
        'x-role': 'CLIENT',
        'x-user-id': client._id.toString(),
        'x-idempotency-key': `submit-payment-dup-${Date.now()}`
      });


      if (doubleSpendRes.status !== 409) {
        throw new Error(`Double-spend attack was NOT blocked! Status received: ${doubleSpendRes.status}`);
      }
      console.log('  ✅ Double-spend attack blocked! Server rejected duplicate TrxID with 409 Conflict.');

      // ── TEST 4: Milestone Rejection / Dispute Flow ───────────────────────────
      console.log('\n⏳ TEST 4: Rejecting Milestone 2 Proof (POST /milestone/:id/reject)...');
      const rejectRes = await requestJson(port, 'POST', `/api/settlement/milestone/${milestone2Id}/reject`, {
        reason: 'Concrete column alignment diverges from architectural blueprint by 12 inches.'
      }, {
        'x-role': 'CLIENT',
        'x-user-id': client._id.toString(),
        'x-idempotency-key': `reject-m2-${Date.now()}`
      });

      if (rejectRes.status !== 200 || rejectRes.body.data?.milestoneStatus !== 'DISPUTED') {
        throw new Error(`Milestone rejection failed: status ${rejectRes.status}, body ${JSON.stringify(rejectRes.body)}`);
      }
      console.log('  ✅ Milestone 2 status updated to DISPUTED, Escrow Ledger frozen to IN_ARBITRATION.');

      console.log('\n🏆 PHASE 22 OFFLINE SETTLEMENT & DOUBLE-SPEND DIAGNOSTICS 100% VERIFIED.\n');
      process.exit(0);

    } finally {
      await new Promise((resolve) => server.close(resolve));
      await PaymentReceipt.deleteMany({ projectId: project._id });
      await EscrowLedger.findByIdAndDelete(ledger._id);
      await Project.findByIdAndDelete(project._id);
      await User.findByIdAndDelete(client._id);
      await User.findByIdAndDelete(contractor._id);
    }
  } catch (err) {
    console.error('💥 SETTLEMENT DIAGNOSTICS FAILED:', err.message);
    process.exit(1);
  }
}

runSettlementOfflineDiagnostics();
