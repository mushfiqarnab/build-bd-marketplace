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

// Boot the real application server on a free port (0) so the suite never
// collides with a running beta on :5000; the URL is resolved once listening.
process.env.PORT = '0';
const { server: appServer } = require('../server');

const User = require('../models/User');
const Project = require('../models/Project');
const EscrowLedger = require('../models/EscrowLedger');
const Bid = require('../models/Bid');
const ContractorProfile = require('../models/ContractorProfile');

let SERVER_URL = null;
async function resolveServerUrl() {
  if (!appServer.listening) await new Promise((r) => appServer.once('listening', r));
  SERVER_URL = `http://127.0.0.1:${appServer.address().port}/api`;
}
const JWT_SECRET = process.env.JWT_SECRET;

const genTestPhone = () => `018${Math.floor(10000000 + Math.random() * 90000000)}`;

async function runEscrowCoherenceDiagnostics() {
  await resolveServerUrl();
  console.log('🔬 INITIATING CRYPTOGRAPHIC PROOF UPLOAD DIAGNOSTICS...\n');

  let testClient, testContractor, testProject1, testProject2, unfundedLedger, fundedLedger;

  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    console.log('✅ Diagnostic Robot connected to MongoDB Atlas.');

    testClient = await User.create({ phoneNumber: genTestPhone(), role: 'CLIENT', status: 'ACTIVE' });
    testContractor = await User.create({ phoneNumber: genTestPhone(), role: 'CONTRACTOR', status: 'ACTIVE' });
    await ContractorProfile.create({
      userId: testContractor._id,
      businessType: 'INDIVIDUAL',
      fullName: 'Test Contractor',
      verification: {
        status: 'VERIFIED',
        probationStatus: { isProbation: false, projectsCompleted: 3, projectsRequired: 3, canBidAbove: 10000000 }
      }
    });

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
    if (!data3a.data.uploadMethod || typeof data3a.data.uploadHeaders !== 'object' || typeof data3a.data.maxBytes !== 'number') {
      throw new Error(`Test 3a Failed: Presigned URL response missing uploadMethod/uploadHeaders/maxBytes: ${JSON.stringify(data3a.data)}`);
    }
    console.log('✅ TEST 3a PASSED: Pre-Signed URL, S3 Key, uploadMethod/Headers, and Cryptographic Proof Token (CPT) generated successfully.');

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

    // ==========================================
    // 🛡️ REGRESSION TEST 5: RE-BIDDING AFTER WITHDRAWAL (QA-07)
    // ==========================================
    console.log('\n⏳ TEST 5: Testing re-bidding after withdrawing a bid (QA-07)...');
    const rebidProject = await Project.create({
      title: 'Re-bid Project',
      category: 'Residential',
      description: 'Project to test re-bidding after withdrawal.',
      location: 'Dhaka',
      budget: 100000,
      clientId: testClient._id,
      status: 'OPEN'
    });

    const bidRes1 = await fetch(`${SERVER_URL}/bids/${rebidProject._id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${contractorToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        bidAmount: 50000,
        estimatedDays: 15,
        proposalText: 'First proposal for this residential project.'
      })
    });
    const bidData1 = await bidRes1.json();
    if (bidRes1.status !== 201) throw new Error(`Initial bid submission failed: ${JSON.stringify(bidData1)}`);
    const initialBidId = bidData1.bid._id;

    const withdrawRes = await fetch(`${SERVER_URL}/bids/${initialBidId}/withdraw`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${contractorToken}` }
    });
    if (withdrawRes.status !== 200) throw new Error(`Withdraw bid failed: ${withdrawRes.status}`);

    const withdrawnDoc = await Bid.findById(initialBidId);
    if (withdrawnDoc.status !== 'WITHDRAWN') throw new Error(`Bid status is not WITHDRAWN: ${withdrawnDoc.status}`);

    const rebidRes = await fetch(`${SERVER_URL}/bids/${rebidProject._id}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${contractorToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        bidAmount: 48000,
        estimatedDays: 14,
        proposalText: 'Revised and improved proposal after withdrawal.'
      })
    });
    const rebidData = await rebidRes.json();
    if (rebidRes.status !== 201) throw new Error(`Re-bid submission failed: ${JSON.stringify(rebidData)}`);
    if (!rebidData.message || !rebidData.message.includes('re-submitted')) {
      throw new Error(`Expected re-submitted message, got: ${rebidData.message}`);
    }

    const revivedDoc = await Bid.findById(initialBidId);
    if (revivedDoc.status !== 'PENDING' || revivedDoc.bidAmount !== 48000) {
      throw new Error(`Revived bid verification failed: ${JSON.stringify(revivedDoc)}`);
    }
    console.log('✅ TEST 5 PASSED: Re-bidding after withdrawal revived bid cleanly with status PENDING.');

    // ==========================================
    // 🛡️ REGRESSION TEST 6: IN_PROGRESS MILESTONE ACTIVATION AFTER IPN (QA-09)
    // ==========================================
    console.log('\n⏳ TEST 6: Testing IN_PROGRESS milestone activation after /api/payment/ipn (QA-09)...');
    const ipnProject = await Project.create({
      title: 'IPN Activation Project',
      category: 'Commercial',
      description: 'Testing milestone activation on payment IPN.',
      location: 'Dhaka',
      budget: 2000000,
      clientId: testClient._id,
      status: 'ASSIGNED'
    });

    const ipnLedger = await EscrowLedger.create({
      projectId: ipnProject._id,
      clientId: testClient._id,
      contractorId: testContractor._id,
      totalContractValue: 2000000,
      ledgerStatus: 'PENDING_FUNDING',
      milestones: [
        { title: 'Foundation', releasePercentage: 50, amount: 1000000, status: 'PENDING' },
        { title: 'Superstructure', releasePercentage: 50, amount: 1000000, status: 'PENDING' }
      ]
    });

    const ipnInitRes = await fetch(`${SERVER_URL}/payment/initiate/${ipnLedger._id}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${clientToken}` }
    });
    const ipnInitData = await ipnInitRes.json();
    if (ipnInitRes.status !== 200) throw new Error(`IPN ledger initiation failed: ${JSON.stringify(ipnInitData)}`);

    const updatedIpnLedger = await EscrowLedger.findById(ipnLedger._id);
    if (!updatedIpnLedger.pendingTransactionIds || !updatedIpnLedger.pendingTransactionIds.includes(ipnInitData.tranId)) {
      throw new Error('pendingTransactionIds array does not contain tranId');
    }

    const ipnSimRes = await fetch(`${SERVER_URL}/payment/ipn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        tran_id: ipnInitData.tranId,
        val_id: 'val-' + crypto.randomBytes(4).toString('hex'),
        status: 'VALIDATED',
        amount: '2000000',
        currency: 'BDT'
      })
    });
    const ipnSimData = await ipnSimRes.json();
    if (ipnSimRes.status !== 200) throw new Error(`IPN sim failed: ${JSON.stringify(ipnSimData)}`);

    const fundedIpnDoc = await EscrowLedger.findById(ipnLedger._id);
    if (fundedIpnDoc.ledgerStatus !== 'FUNDED') throw new Error(`Expected FUNDED, got ${fundedIpnDoc.ledgerStatus}`);
    if (fundedIpnDoc.milestones[0].status !== 'IN_PROGRESS') {
      throw new Error(`Expected milestone 0 IN_PROGRESS, got ${fundedIpnDoc.milestones[0].status}`);
    }
    if (fundedIpnDoc.milestones[1].status !== 'IN_PROGRESS') {
      throw new Error(`Expected milestone 1 IN_PROGRESS, got ${fundedIpnDoc.milestones[1].status}`);
    }
    console.log('✅ TEST 6 PASSED: Milestones successfully activated to IN_PROGRESS after IPN funding.');

    // ==========================================
    // 🛡️ REGRESSION TEST 7: CONTRACTOR OFFLINE PAYMENT RECEIPT CONFIRMATION
    // ==========================================
    console.log('\n⏳ TEST 7: Testing contractor confirmation of offline payment (/api/settlement/milestone/:id/confirm-receipt)...');
    const confirmProject = await Project.create({
      title: 'Offline Payment Confirmation Project',
      category: 'Residential',
      description: 'Testing contractor confirmation flow.',
      location: 'Dhaka',
      budget: 100000,
      clientId: testClient._id,
      awardedContractorId: testContractor._id,
      status: 'ASSIGNED'
    });

    const confirmLedger = await EscrowLedger.create({
      projectId: confirmProject._id,
      clientId: testClient._id,
      contractorId: testContractor._id,
      totalContractValue: 100000,
      ledgerStatus: 'PARTIALLY_DISBURSED',
      milestones: [
        { title: 'Milestone 1', releasePercentage: 100, amount: 100000, status: 'PAID_OFFLINE' }
      ]
    });

    const targetMilestoneId = confirmLedger.milestones[0]._id;

    // 1. Client attempting to call confirm-receipt -> 403 Forbidden
    const clientConfirmRes = await fetch(`${SERVER_URL}/settlement/milestone/${targetMilestoneId}/confirm-receipt`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${clientToken}`,
        'x-idempotency-key': `confirm-client-${Date.now()}`
      }
    });
    if (clientConfirmRes.status !== 403) {
      throw new Error(`Expected 403 when client calls confirm-receipt, got ${clientConfirmRes.status}`);
    }

    // 2. Contractor calls confirm-receipt -> 200 OK, status -> COMPLETED
    const contractorConfirmRes = await fetch(`${SERVER_URL}/settlement/milestone/${targetMilestoneId}/confirm-receipt`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${contractorToken}`,
        'x-idempotency-key': `confirm-contractor-${Date.now()}`
      }
    });
    const contractorConfirmData = await contractorConfirmRes.json();
    if (contractorConfirmRes.status !== 200) {
      throw new Error(`Contractor confirm-receipt failed: ${JSON.stringify(contractorConfirmData)}`);
    }

    const verifiedLedger = await EscrowLedger.findById(confirmLedger._id);
    if (verifiedLedger.milestones[0].status !== 'COMPLETED') {
      throw new Error(`Expected milestone status COMPLETED, got ${verifiedLedger.milestones[0].status}`);
    }
    if (verifiedLedger.milestones[0].settlementStatus !== 'SETTLED') {
      throw new Error(`Expected settlementStatus SETTLED, got ${verifiedLedger.milestones[0].settlementStatus}`);
    }
    console.log('✅ TEST 7 PASSED: Contractor successfully confirmed offline receipt; milestone advanced to COMPLETED.');

    console.log('\n🏆 ALL GOVERNANCE CRYPTOGRAPHIC E2E DIAGNOSTICS PASSED.');

  } catch (err) {
    console.error('\n💥 COHERENCE DIAGNOSTIC FAILURE:', err.message);
    process.exit(1);
  } finally {
    console.log('\n🧹 Initiating automated test data cleanup...');
    if (testClient) await User.deleteMany({ _id: { $in: [testClient._id, testContractor._id] } });
    await ContractorProfile.deleteMany({});
    await Project.deleteMany({});
    await EscrowLedger.deleteMany({});
    await Bid.deleteMany({});
    if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
    console.log('✨ Cleanup complete. Testing framework shutting down.');
    process.exit(0);
  }
}

runEscrowCoherenceDiagnostics();