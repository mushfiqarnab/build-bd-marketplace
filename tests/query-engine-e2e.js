// tests/query-engine-e2e.js
const dns = require('dns');
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
  console.log('🌐 Forced public DNS override active for query engine test.');
} catch (err) {
  console.warn('⚠️ DNS override failed:', err.message);
}

const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const auth = require('../middleware/auth');

async function runQueryEngineDiagnostics() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000
    });

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

    await AuditLog.create([{
      entityId: ledger._id,
      entityType: 'ESCROW_LEDGER',
      action: 'MILESTONE_DISPUTED',
      actorId: client._id,
      actorRole: 'CLIENT',
      metadata: { milestoneIndex: 0, reason: 'Quality issue' },
      ipAddress: '127.0.0.1'
    }, {
      entityId: ledger._id,
      entityType: 'ESCROW_LEDGER',
      action: 'ARBITRATION_VERDICT_CLIENT',
      actorId: contractor._id,
      actorRole: 'CONTRACTOR',
      metadata: { decision: 'FAVOR_CLIENT' },
      ipAddress: '127.0.0.1'
    }]);

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
      const escrowRes = await new Promise((resolve, reject) => {
        const req = require('http').request({
          port: server.address().port,
          path: `/api/governance/escrow/${ledger.projectId}`,
          method: 'GET',
          headers: {
            'x-role': 'CLIENT',
            'x-user-id': client._id.toString()
          }
        }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        });
        req.on('error', reject);
        req.end();
      });

      if (escrowRes.status !== 200) throw new Error(`Escrow query failed: ${escrowRes.status}`);
      if (!escrowRes.body.data || escrowRes.body.data._id !== ledger._id.toString()) throw new Error('Escrow query did not return the expected ledger');

      const auditRes = await new Promise((resolve, reject) => {
        const req = require('http').request({
          port: server.address().port,
          path: `/api/governance/audit-trail/${ledger._id}`,
          method: 'GET',
          headers: {
            'x-role': 'CLIENT',
            'x-user-id': client._id.toString()
          }
        }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        });
        req.on('error', reject);
        req.end();
      });

      if (auditRes.status !== 200) throw new Error(`Audit trail query failed: ${auditRes.status}`);
      if (!Array.isArray(auditRes.body.data) || auditRes.body.data.length < 2) throw new Error('Audit trail did not return the expected history');

      console.log('✅ Query engine access control and audit trail retrieval verified.');
      process.exit(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await EscrowLedger.findByIdAndDelete(ledger._id);
      await User.findByIdAndDelete(client._id);
      await User.findByIdAndDelete(contractor._id);
      await AuditLog.deleteMany({ entityId: ledger._id });
    }
  } catch (error) {
    console.error('💥 QUERY ENGINE DIAGNOSTIC FAILED:', error.message);
    process.exit(1);
  }
}

runQueryEngineDiagnostics();
