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

const User = require('../models/User');
const Project = require('../models/Project');
const EscrowLedger = require('../models/EscrowLedger');

const SERVER_URL = 'http://localhost:5000/api';
const JWT_SECRET = process.env.JWT_SECRET;

const genTestPhone = () => `018${Math.floor(10000000 + Math.random() * 90000000)}`;

async function runPaymentLifecycleTest() {
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
  } catch (err) {
    console.error('💥 PAYMENT GATEWAY TEST FAILED:', err.message);
  } finally {
    if (testClient) await User.deleteMany({ _id: { $in: [testClient._id, testContractor._id] } });
    if (testProject) await Project.findByIdAndDelete(testProject._id);
    if (testLedger) await EscrowLedger.findByIdAndDelete(testLedger._id);
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    process.exit(0);
  }
}

runPaymentLifecycleTest();
