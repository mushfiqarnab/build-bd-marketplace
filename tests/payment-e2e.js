// tests/payment-e2e.js
const dns = require('dns');

// 🌐 ENTERPRISE DNS ARMOR FOR LOCAL ISP BYPASS
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
  console.log('🌐 Forced public DNS override active for test runner.');
} catch (err) {
  console.warn('⚠️ DNS override failed in test suite:', err.message);
}

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

// Self-booting on a free port: this suite used to expect a server already
// running on :5000, so it could not run unattended and was never registered.
process.env.PORT = '0';
const { server: appServer } = require('../server');

const User = require('../models/User');
const Project = require('../models/Project');
const EscrowLedger = require('../models/EscrowLedger');

let SERVER_URL = null;
async function resolveServerUrl() {
  if (!appServer.listening) await new Promise((r) => appServer.once('listening', r));
  SERVER_URL = `http://127.0.0.1:${appServer.address().port}/api`;
}
const JWT_SECRET = process.env.JWT_SECRET;

const genTestPhone = () => `018${Math.floor(10000000 + Math.random() * 90000000)}`;

let failed = false;
const extraLedgers = [];
const extraProjects = [];

async function runPaymentLifecycleTest() {
  await resolveServerUrl();
  console.log('🔬 INITIATING PAYMENT GATEWAY LIFECYCLE TEST...');

  let testClient;
  let testContractor;
  let testProject;
  let testLedger;

  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000
    });
    console.log('✅ Payment test connected to MongoDB.');

    await User.createCollection();
    await Project.createCollection();
    await EscrowLedger.createCollection();

    testClient = await User.create({ phoneNumber: genTestPhone(), role: 'CLIENT', status: 'ACTIVE' });
    testContractor = await User.create({ phoneNumber: genTestPhone(), role: 'CONTRACTOR', status: 'ACTIVE' });

    const clientToken = jwt.sign({ userId: testClient._id, role: 'CLIENT' }, JWT_SECRET, { expiresIn: '1h' });

    testProject = await Project.create({
      title: 'Payment Lifecycle Project',
      category: 'Infrastructure',
      description: 'Sandbox payment lifecycle test.',
      location: 'Dhaka',
      budget: 2000000,
      clientId: testClient._id,
      status: 'ASSIGNED'
    });

    testLedger = await EscrowLedger.create({
      projectId: testProject._id,
      clientId: testClient._id,
      contractorId: testContractor._id,
      totalContractValue: 2000000,
      ledgerStatus: 'PENDING_FUNDING',
      milestones: [
        { title: 'Milestone 1', releasePercentage: 100, amount: 2000000 }
      ]
    });

    const initRes = await fetch(`${SERVER_URL}/payment/initiate/${testLedger._id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientToken}` }
    });

    const initData = await initRes.json();
    if (initRes.status !== 200) {
      throw new Error(`Initiation failed: ${JSON.stringify(initData)}`);
    }

    if (!initData.tranId || !initData.sessionKey) {
      throw new Error(`Missing transaction data: ${JSON.stringify(initData)}`);
    }

    const updatedLedger = await EscrowLedger.findById(testLedger._id);
    if (!updatedLedger.pendingTransactionId || !updatedLedger.gatewaySessionKey) {
      throw new Error('Ledger was not updated with pending transaction data.');
    }

    const ipnRes = await fetch(`${SERVER_URL}/payment/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        tran_id: updatedLedger.pendingTransactionId,
        val_id: 'test-validation-id',
        status: 'VALIDATED',
        amount: '2000000',
        currency: 'BDT'
      })
    });

    const ipnData = await ipnRes.json();
    if (ipnRes.status !== 200) {
      throw new Error(`IPN failed: ${JSON.stringify(ipnData)}`);
    }

    const reconciledLedger = await EscrowLedger.findById(testLedger._id);
    if (reconciledLedger.ledgerStatus !== 'FUNDED') {
      throw new Error(`Ledger not funded after IPN: ${reconciledLedger.ledgerStatus}`);
    }

    console.log('✅ PAYMENT GATEWAY LIFECYCLE TEST PASSED.');

    // ── Orphan payments: the gateway captured money the ledger cannot take ──
    const AuditLog = require('../models/AuditLog');
    const { runAbandonmentSweep } = require('../services/abandonmentService');
    const newLedger = async (label, extra = {}) => {
      const project = await Project.create({
        title: `Payment ${label}`, category: 'Infrastructure', description: 'Orphan payment test.',
        location: 'Dhaka', budget: 500000, clientId: testClient._id, status: 'ASSIGNED'
      });
      extraProjects.push(project._id);
      const ledger = await EscrowLedger.create({
        projectId: project._id, clientId: testClient._id, contractorId: testContractor._id,
        totalContractValue: 500000, ledgerStatus: 'PENDING_FUNDING',
        milestones: [{ title: 'Milestone 1', releasePercentage: 100, amount: 500000 }], ...extra
      });
      extraLedgers.push(ledger._id);
      return ledger;
    };
    const initiate = async (ledgerId) => {
      const r = await fetch(`${SERVER_URL}/payment/initiate/${ledgerId}`, { method: 'POST', headers: { Authorization: `Bearer ${clientToken}` } });
      return { status: r.status, body: await r.json() };
    };
    const ipn = async (tranId, valId, status = 'VALIDATED') => {
      const r = await fetch(`${SERVER_URL}/payment/ipn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ tran_id: tranId, val_id: valId, status, amount: '500000', currency: 'BDT' })
      });
      return { status: r.status, body: await r.json() };
    };

    // 1. Client paid twice (two checkouts, both completed).
    const twice = await newLedger('paid twice');
    const tranA = (await initiate(twice._id)).body.tranId;
    const tranB = (await initiate(twice._id)).body.tranId;
    if ((await ipn(tranA, 'VAL-TWICE-A')).status !== 200) throw new Error('first IPN failed');
    const secondPay = await ipn(tranB, 'VAL-TWICE-B');
    await ipn(tranB, 'VAL-TWICE-B'); // gateway retry of the same notification
    const twiceAfter = await EscrowLedger.findById(twice._id).lean();
    if (secondPay.status !== 200 || twiceAfter.paidByValId !== 'VAL-TWICE-A') throw new Error('second payment disturbed the funded ledger');
    if (twiceAfter.orphanPayments.length !== 1 || twiceAfter.orphanPayments[0].reason !== 'ALREADY_FUNDED' || twiceAfter.orphanPayments[0].amount !== 500000) {
      throw new Error(`double payment not recorded exactly once: ${JSON.stringify(twiceAfter.orphanPayments)}`);
    }
    const audits = await AuditLog.countDocuments({ entityId: twice._id, action: 'ORPHAN_PAYMENT_REFUND_REQUIRED' });
    if (audits !== 1) throw new Error(`expected 1 refund-required audit entry, got ${audits}`);
    console.log('✅ Double payment recorded once as ALREADY_FUNDED (refund owed), gateway retry idempotent.');

    // 2. Late payment on a ledger the sweeper already cancelled.
    const late = await newLedger('late');
    const tranLate = (await initiate(late._id)).body.tranId;
    await EscrowLedger.updateOne({ _id: late._id }, { $set: { ledgerStatus: 'CANCELLED' } });
    await ipn(tranLate, 'VAL-LATE');
    const lateAfter = await EscrowLedger.findById(late._id).lean();
    if (lateAfter.ledgerStatus !== 'CANCELLED' || lateAfter.orphanPayments[0]?.reason !== 'LEDGER_CANCELLED') {
      throw new Error(`late payment on cancelled ledger not recorded: ${JSON.stringify(lateAfter.orphanPayments)}`);
    }
    console.log('✅ Late payment on a cancelled ledger recorded as LEDGER_CANCELLED (refund owed).');

    // 3. A failed attempt keeps the ledger payable (used to dead-end as PAYMENT_FAILED).
    const failedTry = await newLedger('failed try');
    const tranFail = (await initiate(failedTry._id)).body.tranId;
    await ipn(tranFail, 'VAL-FAIL', 'FAILED');
    const failAfter = await EscrowLedger.findById(failedTry._id).lean();
    if (failAfter.ledgerStatus !== 'PENDING_FUNDING') throw new Error(`failed IPN moved ledger to ${failAfter.ledgerStatus}`);
    const retry = await initiate(failedTry._id);
    if (retry.status !== 200) throw new Error(`client could not retry after a failed payment: ${JSON.stringify(retry.body)}`);
    console.log('✅ Failed payment keeps the ledger payable; the client can retry.');

    // 4. The abandonment sweeper spares a ledger with a recent checkout.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const checkingOut = await newLedger('checking out', { paymentInitiatedAt: new Date() });
    const abandoned = await newLedger('abandoned');
    await EscrowLedger.collection.updateMany({ _id: { $in: [checkingOut._id, abandoned._id] } }, { $set: { createdAt: old } });
    await runAbandonmentSweep();
    const [co, ab] = await Promise.all([EscrowLedger.findById(checkingOut._id).lean(), EscrowLedger.findById(abandoned._id).lean()]);
    if (co.ledgerStatus !== 'PENDING_FUNDING') throw new Error(`sweeper cancelled a ledger mid-checkout (${co.ledgerStatus})`);
    if (ab.ledgerStatus !== 'CANCELLED') throw new Error(`sweeper did not cancel an abandoned ledger (${ab.ledgerStatus})`);
    console.log('✅ Abandonment sweeper spares a recent checkout and still cancels a truly abandoned ledger.');
  } catch (err) {
    failed = true;
    console.error('💥 PAYMENT GATEWAY TEST FAILED:', err.message);
  } finally {
    if (testClient) await User.deleteMany({ _id: { $in: [testClient._id, testContractor._id] } });
    if (testProject) await Project.findByIdAndDelete(testProject._id);
    if (testLedger) await EscrowLedger.findByIdAndDelete(testLedger._id);
    await EscrowLedger.deleteMany({ _id: { $in: extraLedgers } });
    await Project.deleteMany({ _id: { $in: extraProjects } });
    // Orderly teardown of everything the embedded server opened. Calling
    // process.exit while Socket.io/Redis/HTTP handles are still closing trips
    // a libuv assertion on Windows (intermittent exit 3221226505).
    const { app } = require('../server');
    const io = app.get('io');
    if (io) await new Promise((r) => io.close(() => r()));
    await require('../services/redisClient').closeRedis().catch(() => {});
    if (appServer.listening) await new Promise((r) => appServer.close(() => r()));
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    // Previously exit(0) unconditionally, so a broken payment flow still "passed".
    process.exitCode = failed ? 1 : 0;
    setTimeout(() => process.exit(), 250).unref();
  }
}

runPaymentLifecycleTest();
