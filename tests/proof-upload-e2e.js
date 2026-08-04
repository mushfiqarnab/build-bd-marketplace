// tests/proof-upload-e2e.js
const dns = require('dns');
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
  console.log('🌐 Forced public DNS override active for proof upload test.');
} catch (err) {
  console.warn('⚠️ DNS override failed:', err.message);
}

const http = require('http');

function postJson(serverPort, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      port: serverPort,
      path: pathName,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
        } catch (parseError) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');
const auth = require('../middleware/auth');

async function runProofUploadDiagnostics() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000
    });

    const contractor = await User.create({
      role: 'CONTRACTOR',
      phoneNumber: `018${Math.floor(10000000 + Math.random() * 90000000)}`,
      wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 },
      status: 'ACTIVE'
    });

    const client = await User.create({
      role: 'CLIENT',
      phoneNumber: `016${Math.floor(10000000 + Math.random() * 90000000)}`,
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
        status: 'IN_PROGRESS'
      }]
    });

    auth.verifyToken = (req, res, next) => {
      req.user = {
        userId: req.headers['x-user-id'] || contractor._id.toString(),
        role: req.headers['x-role'] || 'CONTRACTOR'
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
      const sigRes = await postJson(server.address().port, `/api/governance/proof/signature/${ledger._id}/milestone/0`, {
        contentType: 'application/pdf'
      }, {
        'x-role': 'CONTRACTOR',
        'x-user-id': contractor._id.toString()
      });

      if (sigRes.status !== 200 || !sigRes.body.data || !sigRes.body.data.proofToken || !sigRes.body.data.fileKey) {
        throw new Error(`Signature generation failed: status ${sigRes.status}, body ${JSON.stringify(sigRes.body)}`);
      }

      const confirmRes = await postJson(server.address().port, `/api/governance/proof/confirm/${ledger._id}/milestone/0`, {
        proofToken: sigRes.body.data.proofToken
      }, {
        'x-role': 'CONTRACTOR',
        'x-user-id': contractor._id.toString()
      });

      if (confirmRes.status !== 200) throw new Error(`Confirmation failed: ${confirmRes.status}`);

      const refreshedLedger = await EscrowLedger.findById(ledger._id);
      if (refreshedLedger.milestones[0].status !== 'PROOF_SUBMITTED') throw new Error('Ledger milestone did not advance to PROOF_SUBMITTED');
      if (refreshedLedger.milestones[0].proofOfWorkUrl !== sigRes.body.data.fileKey) throw new Error('Proof S3 key was not stored correctly');

      console.log('✅ Stateless CPT proof upload and physical reconciliation verified.');
      process.exit(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await EscrowLedger.findByIdAndDelete(ledger._id);
      await User.findByIdAndDelete(client._id);
      await User.findByIdAndDelete(contractor._id);
    }
  } catch (error) {
    console.error('💥 PROOF UPLOAD DIAGNOSTIC FAILED:', error.message);
    process.exit(1);
  }
}

runProofUploadDiagnostics();
