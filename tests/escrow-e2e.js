// tests/escrow-e2e.js
const dns = require('dns');

// 🌐 ENTERPRISE DNS ARMOR FOR LOCAL ISP BYPASS
try {
  dns.setServers(['8.8.4.4', '1.1.1.1', '8.8.8.8']);
} catch (err) {
  console.warn('⚠️ DNS override failed in test suite:', err.message);
}

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const crypto = require('crypto');
const dotenv = require('dotenv');
dotenv.config();

// Boot the real application server on port 5000 for E2E fetch target
process.env.PORT = 5000;
require('../server');

const User = require('../models/User');
const Project = require('../models/Project');
const EscrowLedger = require('../models/EscrowLedger');

const SERVER_URL = 'http://localhost:5000/api';
const JWT_SECRET = process.env.JWT_SECRET;

const genTestPhone = () => `018${Math.floor(10000000 + Math.random() * 90000000)}`;

async function runEscrowCoherenceDiagnostics() {
  console.log('🔬 INITIATING CRYPTOGRAPHIC PROOF UPLOAD DIAGNOSTICS...\n');

  let testClient, testContractor, testProject1, testProject2, unfundedLedger, fundedLedger;

  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('✅ Diagnostic Robot connected to MongoDB Atlas.');

    testClient = await User.create({ phoneNumber: genTestPhone(), role: 'CLIENT', status: 'ACTIVE' });
    testContractor = await User.create({ phoneNumber: genTestPhone(), role: 'CONTRACTOR', status: 'ACTIVE' });

    const clientToken = jwt.sign({ userId: testClient._id, role: 'CLIENT' }, JWT_SECRET, { expiresIn: '1h' });
    const contractorToken = jwt.sign({ userId: testContractor._id, role: 'CONTRACTOR' }, JWT_SECRET, { expiresIn: '1h' });

    testProject1 = await Project.create({
      title: 'Unfunded Phase', category: 'Infrastructure', description: 'Unfunded project test.', location: 'Dhaka', budget: 5000000, clientId: testClient._id, status: 'ASSIGNED'
    });

    testProject2 = await Project.create({
      title: 'Funded Phase',
      category: 'Infrastructure',
      description: 'Funded project test.',
      location: 'Dhaka',
      budget: 10000000,
      clientId: testClient._id,
      status: 'ASSIGNED',
      siteCoordinates: { latitude: 23.8103, longitude: 90.4125 }
    });


    unfundedLedger = await EscrowLedger.create({
      projectId: testProject1._id, clientId: testClient._id, contractorId: testContractor._id, totalContractValue: 5000000, ledgerStatus: 'PENDING_FUNDING',
      milestones: [{ title: 'Mobilization', releasePercentage: 100, amount: 5000000, status: 'PENDING' }]
    });

    fundedLedger = await EscrowLedger.create({
      projectId: testProject2._id, clientId: testClient._id, contractorId: testContractor._id, totalContractValue: 10000000, ledgerStatus: 'FUNDED',
      // 🛡️ STATE MACHINE FIX: Milestone must be IN_PROGRESS to accept proofs via Governance logic
      milestones: [{ title: 'Mobilization', releasePercentage: 100, amount: 10000000, status: 'IN_PROGRESS' }]
    });

    // ==========================================
    // TEST 1: STATE MACHINE GUARD (Pending Milestone / Unfunded Ledger)
    // ==========================================
    console.log('⏳ TEST 1: Testing State Machine Guard on PENDING milestone...');
    const res1 = await fetch(`${SERVER_URL}/governance/proof/presigned-url?ledgerId=${unfundedLedger._id}&milestoneIndex=0&contentType=image/jpeg`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${contractorToken}`
      }
    });
    const data1 = await res1.json();

    if (res1.status === 403 && data1.message.includes('funded')) {
      console.log('✅ TEST 1 PASSED: Strict state machine successfully blocked upload on unfunded ledger.');
    } else {
      throw new Error(`Test 1 Failed: Expected status 403 (Escrow must be funded), got ${res1.status}. Response: ${JSON.stringify(data1)}`);
    }

    // ==========================================
    // TEST 2: RBAC AUTHORIZATION CHECK
    // ==========================================
    console.log('\n⏳ TEST 2: Testing Role Authorization (Client token trying to request contractor signature)...');
    const res2 = await fetch(`${SERVER_URL}/governance/proof/presigned-url?ledgerId=${fundedLedger._id}&milestoneIndex=0&contentType=image/jpeg`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${clientToken}`
      }
    });
    
    if (res2.status === 403) {
      console.log('✅ TEST 2 PASSED: Role authorization correctly blocked client.');
    } else {
      throw new Error(`Test 2 Failed: Expected 403! Response: ${res2.status}`);
    }

    // ==========================================
    // TEST 3: SUCCESSFUL STATELESS CLOUD PROOF UPLOAD (CPT PIPELINE)
    // ==========================================
    console.log('\n⏳ TEST 3: Step 1 - Requesting S3 Pre-Signed URL signature & CPT from cloud engine...');
    const res3a = await fetch(`${SERVER_URL}/governance/proof/presigned-url?ledgerId=${fundedLedger._id}&milestoneIndex=0&contentType=image/jpeg`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${contractorToken}`
      }
    });
    const data3a = await res3a.json();

    if (res3a.status !== 200 || !data3a.data || !data3a.data.uploadUrl || !data3a.data.s3Key || !data3a.data.s3KeyToken) {
      throw new Error(`Test 3a Failed: Failed to generate pre-signed URL policy. Response: ${JSON.stringify(data3a)}`);
    }
    console.log('✅ TEST 3a PASSED: Pre-Signed URL, S3 Key, and Cryptographic Proof Token (CPT) generated successfully.');

    // ==========================================
    // 🛡️ TEST 4: SPOOFING TAMPER DEFENSE (Invalid or missing CPT token)
    // ==========================================
    console.log('\n⏳ TEST 4: Testing CPT Tamper Defense (Attempting confirmation without valid CPT)...');
    const testImageHash = crypto.randomBytes(32).toString('hex');

    const resSpoof = await fetch(`${SERVER_URL}/governance/proof/evidence/${fundedLedger._id}/milestone/0`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${contractorToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        s3KeyToken: 'invalid.forged.jwt.token',
        imageHash: testImageHash,
        gpsData: null
      })
    });
    if (resSpoof.status === 401) {
      console.log('✅ TEST 4 PASSED: Forged CPT token correctly rejected by cryptographic verification.');
    } else {
      throw new Error(`Test 4 Failed: Expected 401 for forged token, got ${resSpoof.status}`);
    }

    console.log('\n⏳ TEST 3: Step 2 - Confirming cloud upload with valid CPT and mutating state...');
    const res3b = await fetch(`${SERVER_URL}/governance/proof/evidence/${fundedLedger._id}/milestone/0`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${contractorToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        s3KeyToken: data3a.data.s3KeyToken,
        imageHash: testImageHash,
        gpsData: {
          lat: 23.8103,
          lng: 90.4125,
          accuracy: 15,
          photoTimestamp: new Date().toISOString()
        }
      })
    });

    const data3b = await res3b.json();

    if (res3b.status === 200 && data3b.status === 'success') {
      console.log('✅ TEST 3b PASSED: Cloud upload confirmed via CPT and state mutated.');
      
      // 🛡️ DB VERIFICATION: Ensure the state machine mutated perfectly
      const verifyLedger = await EscrowLedger.findById(fundedLedger._id);
      if (verifyLedger.milestones[0].status === 'PROOF_SUBMITTED' && verifyLedger.milestones[0].evidenceLog[0].s3Key === data3a.data.s3Key) {
         console.log('✅ DB VERIFICATION PASSED: Milestone state advanced to PROOF_SUBMITTED with cryptographically verified S3 key recorded.');
      } else {
         throw new Error(`State machine failed to advance. Current state: ${verifyLedger.milestones[0].status}`);
      }
    } else {
      throw new Error(`Test 3b Failed: Confirmation error! Response: ${JSON.stringify(data3b)}`);
    }

    console.log('\n🏆 ALL GOVERNANCE CRYPTOGRAPHIC E2E DIAGNOSTICS PASSED.');

  } catch (err) {
    console.error('\n💥 COHERENCE DIAGNOSTIC FAILURE:', err.message);
    process.exit(1);
  } finally {
    console.log('\n🧹 Initiating automated test data cleanup...');
    if (testClient) await User.deleteMany({ _id: { $in: [testClient._id, testContractor._id] } });
    if (testProject1) await Project.deleteMany({ _id: { $in: [testProject1._id, testProject2._id] } });
    if (unfundedLedger) await EscrowLedger.deleteMany({ _id: { $in: [unfundedLedger._id, fundedLedger._id] } });
    if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
    console.log('✨ Cleanup complete. Testing framework shutting down.');
    process.exit(0);
  }
}

runEscrowCoherenceDiagnostics();