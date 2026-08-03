// tests/escrow-e2e.js
const dns = require('dns');

// 🌐 ENTERPRISE DNS ARMOR FOR LOCAL ISP BYPASS
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
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

async function runEscrowCoherenceDiagnostics() {
  console.log('🔬 INITIATING ESCROW & UPLOAD COHERENCE DIAGNOSTICS...\n');

  let testClient, testContractor, testProject1, testProject2, unfundedLedger, fundedLedger;

  try {
    // 🗄️ SETUP: Connect to DB and pre-allocate namespaces
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('✅ Diagnostic Robot connected to MongoDB Atlas.');

    await User.createCollection();
    await Project.createCollection();
    await EscrowLedger.createCollection();

    testClient = await User.create({ phoneNumber: genTestPhone(), role: 'CLIENT', status: 'ACTIVE' });
    testContractor = await User.create({ phoneNumber: genTestPhone(), role: 'CONTRACTOR', status: 'ACTIVE' });

    const clientToken = jwt.sign({ userId: testClient._id, role: 'CLIENT' }, JWT_SECRET, { expiresIn: '1h' });
    const contractorToken = jwt.sign({ userId: testContractor._id, role: 'CONTRACTOR' }, JWT_SECRET, { expiresIn: '1h' });

    // Create separate projects for separate escrow ledgers
    testProject1 = await Project.create({
      title: 'Keraniganj Foundation Phase 1',
      category: 'Infrastructure',
      description: 'Unfunded project test.',
      location: 'Keraniganj, Dhaka',
      budget: 5000000,
      clientId: testClient._id,
      status: 'ASSIGNED'
    });

    testProject2 = await Project.create({
      title: 'Keraniganj Foundation Phase 2',
      category: 'Infrastructure',
      description: 'Funded project test.',
      location: 'Keraniganj, Dhaka',
      budget: 10000000,
      clientId: testClient._id,
      status: 'ASSIGNED'
    });

    // Create an UNFUNDED ledger for Project 1
    unfundedLedger = await EscrowLedger.create({
      projectId: testProject1._id,
      clientId: testClient._id,
      contractorId: testContractor._id,
      totalContractValue: 5000000,
      ledgerStatus: 'PENDING_FUNDING',
      milestones: [
        { title: 'Mobilization', releasePercentage: 30, amount: 1500000 },
        { title: 'Handover', releasePercentage: 70, amount: 3500000 }
      ]
    });

    // Create a FUNDED ledger for Project 2
    fundedLedger = await EscrowLedger.create({
      projectId: testProject2._id,
      clientId: testClient._id,
      contractorId: testContractor._id,
      totalContractValue: 10000000,
      ledgerStatus: 'FUNDED',
      milestones: [
        { title: 'Mobilization', releasePercentage: 30, amount: 3000000 },
        { title: 'Handover', releasePercentage: 70, amount: 7000000 }
      ]
    });

    // ==========================================
    // TEST 1: FINANCIAL GUARD CHECK (Unfunded Escrow)
    // ==========================================
    console.log('⏳ TEST 1: Testing Financial Guard on PENDING_FUNDING escrow...');
    const formUnfunded = new FormData();
    formUnfunded.append('proofFile', new Blob(['test-image'], { type: 'image/jpeg' }), 'proof.jpg');

    const res1 = await fetch(`${SERVER_URL}/escrow/${unfundedLedger._id}/milestone/0/proof`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${contractorToken}` },
      body: formUnfunded
    });
    const data1 = await res1.json();

    if (res1.status === 403 && data1.message.toLowerCase().includes('escrow ledger must be funded')) {
      console.log('✅ TEST 1 PASSED: Financial guard successfully intercepted proof upload on unfunded escrow.');
    } else {
      throw new Error(`Test 1 Failed: Expected status 403, got status ${res1.status}. Response: ${JSON.stringify(data1)}`);
    }

    // ==========================================
    // TEST 2: AUTHORIZATION CHECK (Client Role trying to upload proof)
    // ==========================================
    console.log('\n⏳ TEST 2: Testing Role Authorization (Client token on Contractor route)...');
    const formClient = new FormData();
    formClient.append('proofFile', new Blob(['test-image'], { type: 'image/jpeg' }), 'proof.jpg');

    const res2 = await fetch(`${SERVER_URL}/escrow/${fundedLedger._id}/milestone/0/proof`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${clientToken}` },
      body: formClient
    });
    const data2 = await res2.json();

    if (res2.status === 403) {
      console.log('✅ TEST 2 PASSED: Role authorization correctly blocked client from uploading contractor proof.');
    } else {
      throw new Error(`Test 2 Failed: Client successfully uploaded proof! Response: ${JSON.stringify(data2)}`);
    }

    // ==========================================
    // TEST 3: SUCCESSFUL PROOF UPLOAD & COHERENT DB ANCHORING
    // ==========================================
    console.log('\n⏳ TEST 3: Uploading valid proof of work on funded escrow...');
    const formSuccess = new FormData();
    formSuccess.append('proofFile', new Blob(['valid-jpeg-bytes'], { type: 'image/jpeg' }), 'foundation-pour.jpg');

    const res3 = await fetch(`${SERVER_URL}/escrow/${fundedLedger._id}/milestone/0/proof`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${contractorToken}` },
      body: formSuccess
    });
    const data3 = await res3.json();

    if (
      res3.status === 200 && 
      data3.milestone.status === 'IN_PROGRESS' && 
      data3.milestone.proofOfWorkUrl.includes('storage.buildbd.internal/proofs')
    ) {
      console.log('✅ TEST 3 PASSED: Proof successfully buffered, processed, and anchored to milestone in database.');
    } else {
      throw new Error(`Test 3 Failed: Coherence anomaly! Response: ${JSON.stringify(data3)}`);
    }

    console.log('\n🏆 ALL ESCROW & UPLOAD COHERENCE DIAGNOSTICS PASSED.');

  } catch (err) {
    console.error('\n💥 COHERENCE DIAGNOSTIC FAILURE:', err.message);
  } finally {
    // 🧹 TEARDOWN
    console.log('\n🧹 Initiating automated test data cleanup...');
    if (testClient) await User.deleteMany({ _id: { $in: [testClient._id, testContractor._id] } });
    if (testProject1) await Project.findByIdAndDelete(testProject1._id);
    if (testProject2) await Project.findByIdAndDelete(testProject2._id);
    if (unfundedLedger) await EscrowLedger.findByIdAndDelete(unfundedLedger._id);
    if (fundedLedger) await EscrowLedger.findByIdAndDelete(fundedLedger._id);

    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
    }
    console.log('✨ Cleanup complete. Testing framework shutting down.');
    process.exit(0);
  }
}

runEscrowCoherenceDiagnostics();