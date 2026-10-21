// tests/chat-accept-offer-award-e2e.js
// 🛡️ Phase-0 / §2 Roadmap Acceptance Test: Chat-Negotiated Offer Acceptance Contract Award
//
// Acceptance criteria specified in §2 of BUILD-BD-MASTER-ROADMAP.md:
//   Submit a bid, open a chat thread, submit a REVISED_OFFER, accept it via
//   POST /api/chat/:bidId/accept-offer, then assert in the same test, without
//   calling PUT /api/bids/:bidId/accept at all:
//     (a) Project.status === 'ASSIGNED' and awardedContractorId === bid.contractorId
//     (b) EscrowLedger exists with ledgerStatus: 'PENDING_FUNDING' and totalContractValue === negotiated amount
//     (c) Sibling PENDING bids on the same project are now REJECTED
//     (d) GET /api/contracts/by-project/:projectId returns 200 (not 404)
//     (e) Contractor availability.currentProjects incremented and FUNDS_LOCKED AuditLog emitted
'use strict';

const dotenv = require('dotenv');
dotenv.config();
process.env.PORT = '0';

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');

const User = require('../models/User');
const Project = require('../models/Project');
const Bid = require('../models/Bid');
const EscrowLedger = require('../models/EscrowLedger');
const ContractorProfile = require('../models/ContractorProfile');
const AuditLog = require('../models/AuditLog');
const { computeBidFingerprint } = require('../services/bidEligibilityService');

const phone = () => '018' + Math.floor(10000000 + Math.random() * 89999999);
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function main() {
  if (!appServer.listening) await new Promise((r) => appServer.once('listening', r));
  const base = `http://127.0.0.1:${appServer.address().port}/api`;
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('🧪 §2 Chat-accepted bid contract formation & award e2e');

  // 1. Seed Client and two Contractors (Contractor A + Sibling Contractor B)
  const client = await User.create({ role: 'CLIENT', phoneNumber: phone(), status: 'ACTIVE' });
  const contractorA = await User.create({ role: 'CONTRACTOR', phoneNumber: phone(), status: 'ACTIVE' });
  const contractorB = await User.create({ role: 'CONTRACTOR', phoneNumber: phone(), status: 'ACTIVE' });

  await Promise.all([
    ContractorProfile.create({
      userId: contractorA._id,
      businessType: 'COMPANY',
      fullName: 'Contractor A Build Ltd',
      verification: {
        status: 'VERIFIED',
        verificationLevel: 'BASIC',
        probationStatus: { isProbation: false }
      },
      availability: { currentProjects: 0, maxConcurrentProjects: 3 }
    }),
    ContractorProfile.create({
      userId: contractorB._id,
      businessType: 'INDIVIDUAL',
      fullName: 'Contractor B Competing',
      verification: {
        status: 'VERIFIED',
        verificationLevel: 'BASIC',
        probationStatus: { isProbation: false }
      },
      availability: { currentProjects: 0, maxConcurrentProjects: 3 }
    })
  ]);

  const clientTok = jwt.sign({ userId: String(client._id), role: 'CLIENT' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const contractorATok = jwt.sign({ userId: String(contractorA._id), role: 'CONTRACTOR' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  // 2. Seed Project with status: OPEN
  const project = await Project.create({
    title: 'Chat Negotiation Award Test Project',
    category: 'Residential',
    description: 'Verifying that chat accept-offer creates escrow ledger and awards project.',
    location: 'Dhaka',
    budget: 150000,
    clientId: client._id,
    status: 'OPEN'
  });

  // 3. Seed Bid A (Contractor A) and Sibling Bid B (Contractor B)
  const fpA = computeBidFingerprint({
    projectId: String(project._id),
    contractorId: String(contractorA._id),
    bidAmount: 120000,
    estimatedDays: 45,
    proposalText: 'Contractor A initial proposal.'
  });
  const fpB = computeBidFingerprint({
    projectId: String(project._id),
    contractorId: String(contractorB._id),
    bidAmount: 130000,
    estimatedDays: 50,
    proposalText: 'Contractor B sibling proposal.'
  });

  const [bidA, bidB] = await Promise.all([
    Bid.create({
      projectId: project._id,
      contractorId: contractorA._id,
      bidAmount: 120000,
      estimatedDays: 45,
      proposalText: 'Contractor A initial proposal.',
      bidFingerprint: fpA,
      status: 'PENDING',
      itemizedBreakdown: [
        { title: 'Substructure', amount: 48000, estimatedDays: 15 },
        { title: 'Superstructure', amount: 72000, estimatedDays: 30 }
      ]
    }),
    Bid.create({
      projectId: project._id,
      contractorId: contractorB._id,
      bidAmount: 130000,
      estimatedDays: 50,
      proposalText: 'Contractor B sibling proposal.',
      bidFingerprint: fpB,
      status: 'PENDING',
      itemizedBreakdown: [
        { title: 'All Work', amount: 130000, estimatedDays: 50 }
      ]
    })
  ]);

  try {
    // 4. Contractor A posts a REVISED_OFFER in negotiation chat
    const revisedAmount = 100000;
    const revisedDays = 35;
    const postOfferRes = await fetch(`${base}/chat/${bidA._id}/message`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${contractorATok}`,
        'Content-Type': 'application/json',
        'x-requested-with': 'fetch'
      },
      body: JSON.stringify({
        messageType: 'REVISED_OFFER',
        text: 'I can do this complete project for 100,000 BDT in 35 days.',
        revisedAmount,
        revisedDays
      })
    });
    const postOfferBody = await postOfferRes.json();
    check('contractor posts REVISED_OFFER (201)', postOfferRes.status === 201, JSON.stringify(postOfferBody));

    // 5. Client accepts the offer via POST /api/chat/:bidId/accept-offer
    // NOTE: We do NOT call PUT /api/bids/:bidId/accept at all.
    const acceptRes = await fetch(`${base}/chat/${bidA._id}/accept-offer`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${clientTok}`,
        'Content-Type': 'application/json',
        'x-requested-with': 'fetch',
        'x-idempotency-key': `chat-accept-e2e-${Date.now()}`
      },
      body: JSON.stringify({})
    });
    const acceptBody = await acceptRes.json();
    check('client accepts offer via /chat/:bidId/accept-offer (200)', acceptRes.status === 200, JSON.stringify(acceptBody));

    // 6. Assertions on Database State:
    // (a) Project.status === 'ASSIGNED' and awardedContractorId === bidA.contractorId
    const updatedProject = await Project.findById(project._id).lean();
    check('Project.status transitioned to ASSIGNED', updatedProject.status === 'ASSIGNED', `current status: ${updatedProject?.status}`);
    check(
      'Project.awardedContractorId matches Contractor A',
      String(updatedProject.awardedContractorId) === String(contractorA._id),
      `awarded: ${updatedProject?.awardedContractorId}`
    );

    // (b) EscrowLedger exists with ledgerStatus: 'PENDING_FUNDING' and totalContractValue === revisedAmount
    const ledger = await EscrowLedger.findOne({ projectId: project._id, contractorId: contractorA._id }).lean();
    check('EscrowLedger was created for the awarded project & contractor', Boolean(ledger));
    check('EscrowLedger.ledgerStatus === PENDING_FUNDING', ledger?.ledgerStatus === 'PENDING_FUNDING', `status: ${ledger?.ledgerStatus}`);
    check(
      'EscrowLedger.totalContractValue matches negotiated amount (100,000 BDT)',
      ledger?.totalContractValue === revisedAmount,
      `totalContractValue: ${ledger?.totalContractValue}`
    );
    check(
      'EscrowLedger milestones sum to totalContractValue',
      Array.isArray(ledger?.milestones) && ledger.milestones.reduce((s, m) => s + m.amount, 0) === revisedAmount
    );

    // (c) Sibling PENDING bids on the same project are now REJECTED
    const updatedBidA = await Bid.findById(bidA._id).lean();
    const updatedBidB = await Bid.findById(bidB._id).lean();
    check('Awarded Bid A status is ACCEPTED', updatedBidA?.status === 'ACCEPTED', `bidA status: ${updatedBidA?.status}`);
    check(
      'Awarded Bid A bidAmount matches negotiated amount (100,000 BDT)',
      updatedBidA?.bidAmount === revisedAmount,
      `bidA amount: ${updatedBidA?.bidAmount}`
    );
    check('Sibling Bid B status is REJECTED', updatedBidB?.status === 'REJECTED', `bidB status: ${updatedBidB?.status}`);

    // (d) GET /api/contracts/by-project/:projectId returns 200 (not 404) with contract details
    const contractRes = await fetch(`${base}/contracts/by-project/${project._id}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${clientTok}`,
        'x-requested-with': 'fetch'
      }
    });
    const contractBody = await contractRes.json();
    check('GET /api/contracts/by-project/:projectId returns 200', contractRes.status === 200, JSON.stringify(contractBody));
    check('Contract response contains ledger data', contractBody?.data?.ledger?._id || contractBody?.ledger?._id || contractBody?._id);

    // (e) Contractor capacity accounting and AuditLog
    const updatedProfileA = await ContractorProfile.findOne({ userId: contractorA._id }).lean();
    check(
      'Contractor A availability.currentProjects incremented to 1',
      updatedProfileA?.availability?.currentProjects === 1,
      `currentProjects: ${updatedProfileA?.availability?.currentProjects}`
    );

    const auditEntry = await AuditLog.findOne({
      entityId: ledger?._id,
      entityType: 'ESCROW_LEDGER',
      action: 'FUNDS_LOCKED'
    }).lean();
    check('FUNDS_LOCKED AuditLog entry emitted for EscrowLedger', Boolean(auditEntry));

  } finally {
    // Clean up test data
    await Promise.all([
      User.deleteMany({ _id: { $in: [client._id, contractorA._id, contractorB._id] } }),
      ContractorProfile.deleteMany({ userId: { $in: [contractorA._id, contractorB._id] } }),
      Project.deleteOne({ _id: project._id }),
      Bid.deleteMany({ projectId: project._id }),
      EscrowLedger.deleteMany({ projectId: project._id })
    ]);
  }

  console.log(`\n======================================================`);
  if (failed === 0) {
    console.log(`🏆 ALL §2 CHAT-ACCEPT-OFFER AWARD TESTS PASSED (0 FAILURES)`);
    process.exit(0);
  } else {
    console.log(`💥 ${failed} TEST(S) FAILED`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test execution crash:', err);
  process.exit(1);
});
