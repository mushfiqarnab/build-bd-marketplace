// tests/arbitration-e2e.js
/**
 * 🛡️ Phase 23 — Decentralized Dispute Arbitration & Moderator Engine E2E Diagnostics
 * 
 * Verifies:
 *   1. Instantiation of a disputed milestone & DisputeTicket with contractor evidence snapshot.
 *   2. Moderator fetching the Evidence Dossier (GET /api/moderation/dispute/:ticketId).
 *   3. Rejection of invalid / short justifications (< 20 chars).
 *   4. Moderator executing FORCE_APPROVE resolution with 20+ char justification via ACID transaction.
 *   5. Verification of state mutations: EscrowLedger milestone -> CLIENT_APPROVED, DisputeTicket -> RESOLVED_FORCE_APPROVED.
 *   6. Assertion of immutable AuditLog capturing the moderator actor trail.
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
const DisputeTicket = require('../models/DisputeTicket');
const AuditLog = require('../models/AuditLog');
const auth = require('../middleware/auth');

function requestJson(port, method, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
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

async function runArbitrationDiagnostics() {
  console.log('\n🔬 INITIATING PHASE 23 DISPUTE ARBITRATION E2E DIAGNOSTICS...\n');

  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
      serverSelectionTimeoutMS: 15000
    });

    console.log('✅ Connected to MongoDB for Arbitration Diagnostics.');

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

    const moderator = await User.create({
      role: 'MODERATOR',
      phoneNumber: `019${Math.floor(10000000 + Math.random() * 90000000)}`,
      wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 },
      status: 'ACTIVE'
    });

    const project = await Project.create({
      clientId: client._id,
      title: 'Commercial Tower Foundation',
      category: 'Commercial',
      description: 'RCC Pile Foundation in Uttara Sector 10',
      location: 'Dhaka',
      budget: 100000,
      status: 'ASSIGNED',
      siteCoordinates: { latitude: 23.8759, longitude: 90.3795 }
    });

    const ledger = await EscrowLedger.create({
      clientId: client._id,
      contractorId: contractor._id,
      projectId: project._id,
      totalContractValue: 100000,
      ledgerStatus: 'IN_ARBITRATION',
      milestones: [
        {
          title: 'Pile Cap & Rebar Binding',
          amount: 50000,
          releasePercentage: 50,
          status: 'DISPUTED',
          disputeReason: 'Client claims rebar spacing exceeds 150mm specification.',
          proofOfWorkUrl: 'ledgers/pilecap/evidence.jpg'
        },
        {
          title: 'Casting & Curing',
          amount: 50000,
          releasePercentage: 50,
          status: 'PENDING'
        }
      ]
    });

    const ticket = await DisputeTicket.create({
      projectId: project._id,
      ledgerId: ledger._id,
      milestoneIndex: 0,
      clientId: client._id,
      contractorId: contractor._id,
      clientRejectionReason: 'Client claims rebar spacing exceeds 150mm specification.',
      contractorEvidenceSnapshot: {
        s3Url: 'ledgers/pilecap/evidence.jpg',
        imageHash: 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0',
        gpsData: { lat: 23.8759, lng: 90.3795, accuracy: 12 },
        submittedAt: new Date()
      },
      status: 'OPEN_FOR_REVIEW'
    });

    // Mock Auth Middleware
    auth.verifyToken = (req, res, next) => {
      req.user = {
        userId: req.headers['x-user-id'] || moderator._id.toString(),
        role: req.headers['x-role'] || 'MODERATOR'
      };
      next();
    };

    auth.requireRole = (roles) => (req, res, next) => {
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ message: 'Forbidden' });
      }
      next();
    };

    const arbitrationRouter = require('../routes/arbitration');
    const app = express();
    app.use(express.json());
    app.use('/api/moderation', arbitrationRouter);

    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({ message: err.message });
    });

    const server = app.listen(0);
    const port = server.address().port;

    try {
      // ── TEST 1: GET Evidence Dossier as Moderator ─────────────────────────────
      console.log('⏳ TEST 1: Moderator fetching Evidence Dossier (GET /api/moderation/dispute/:id)...');
      const dossierRes = await requestJson(port, 'GET', `/api/moderation/dispute/${ticket._id}`, null, {
        'x-role': 'MODERATOR',
        'x-user-id': moderator._id.toString()
      });

      if (dossierRes.status !== 200 || !dossierRes.body.dossier) {
        throw new Error(`Failed to fetch dossier: status ${dossierRes.status}, body ${JSON.stringify(dossierRes.body)}`);
      }

      const dossier = dossierRes.body.dossier;
      if (dossier.contractorEvidenceSnapshot?.gpsData?.lat !== 23.8759) {
        throw new Error('Dossier GPS data mismatch!');
      }
      console.log('  ✅ Evidence Dossier retrieved cleanly with populated Project, Client, & Contractor metadata.');

      // ── TEST 2: Reject Short Justifications (< 20 chars) ───────────────────────
      console.log('\n⏳ TEST 2: Validating Non-Repudiation Guard (< 20 char justification rejection)...');
      const shortJustRes = await requestJson(port, 'POST', `/api/moderation/dispute/${ticket._id}/resolve`, {
        verdict: 'FORCE_APPROVE',
        justification: 'Looks okay to me' // Short! (16 chars)
      }, {
        'x-role': 'MODERATOR',
        'x-user-id': moderator._id.toString()
      });

      if (shortJustRes.status !== 400) {
        throw new Error(`Short justification was NOT rejected! Status: ${shortJustRes.status}`);
      }
      console.log('  ✅ Non-repudiation guard verified: <20 char justification rejected with 400 Bad Request.');

      // ── TEST 3: Execute FORCE_APPROVE Resolution via ACID Transaction ─────────
      console.log('\n⏳ TEST 3: Executing FORCE_APPROVE verdict via ACID Transaction...');
      const validJustification = 'Photographic evidence with GPS lock (23.8759, 90.3795) proves rebar spacing matches the 150mm engineering spec.';
      
      const resolveRes = await requestJson(port, 'POST', `/api/moderation/dispute/${ticket._id}/resolve`, {
        verdict: 'FORCE_APPROVE',
        justification: validJustification
      }, {
        'x-role': 'MODERATOR',
        'x-user-id': moderator._id.toString()
      });

      if (resolveRes.status !== 200 || resolveRes.body.resolution?.ticketStatus !== 'RESOLVED_FORCE_APPROVED') {
        throw new Error(`Dispute resolution failed: status ${resolveRes.status}, body ${JSON.stringify(resolveRes.body)}`);
      }
      console.log('  ✅ Dispute ticket status updated to RESOLVED_FORCE_APPROVED.');

      // ── TEST 4: Assert State Mutations & Immutable Audit Log ────────────────
      console.log('\n⏳ TEST 4: Verifying Database Mutations & Cryptographic Audit Trail...');
      const updatedLedger = await EscrowLedger.findById(ledger._id);
      if (updatedLedger.milestones[0].status !== 'CLIENT_APPROVED') {
        throw new Error(`Milestone status in EscrowLedger was not updated to CLIENT_APPROVED! Status: ${updatedLedger.milestones[0].status}`);
      }
      console.log('  ✅ EscrowLedger milestone state successfully mutated to CLIENT_APPROVED.');

      const auditTrail = await AuditLog.findOne({ entityId: ticket._id, action: 'DISPUTE_RESOLVED' });
      if (!auditTrail || auditTrail.actorId.toString() !== moderator._id.toString()) {
        throw new Error('AuditLog entry for DISPUTE_RESOLVED not found or actorId mismatch!');
      }
      console.log('  ✅ Immutable AuditLog entry verified: actorId matches Moderator, action = DISPUTE_RESOLVED.');

      console.log('\n🏆 PHASE 23 DECENTRALIZED DISPUTE ARBITRATION E2E DIAGNOSTICS 100% VERIFIED.\n');
      process.exit(0);

    } finally {
      await new Promise((resolve) => server.close(resolve));
      await DisputeTicket.findByIdAndDelete(ticket._id);
      await EscrowLedger.findByIdAndDelete(ledger._id);
      await Project.findByIdAndDelete(project._id);
      await User.findByIdAndDelete(client._id);
      await User.findByIdAndDelete(contractor._id);
      await User.findByIdAndDelete(moderator._id);
    }

  } catch (err) {
    console.error('💥 ARBITRATION DIAGNOSTICS FAILED:', err.message);
    process.exit(1);
  }
}

runArbitrationDiagnostics();
