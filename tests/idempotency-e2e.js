const dns = require('dns');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
require('dotenv').config();

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
  console.log('🌐 Forced public DNS override active for idempotency test.');
} catch (err) {
  console.warn('⚠️ DNS override failed:', err.message);
}

const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');
const IdempotencyKey = require('../models/IdempotencyKey');
const auth = require('../middleware/auth');

function postJson(serverPort, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
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

async function runIdempotencyDiagnostics() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000
    });

    await IdempotencyKey.deleteMany({});

    const admin = await User.findOneAndUpdate(
      { role: 'ADMIN', phoneNumber: process.env.TREASURY_PHONE || '01700000000' },
      {
        $set: {
          wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 0 },
          status: 'ACTIVE'
        },
        $setOnInsert: {
          role: 'ADMIN',
          phoneNumber: process.env.TREASURY_PHONE || '01700000000'
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

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
      const firstResponse = await postJson(server.address().port, `/api/governance/approve/${ledger._id}/milestone/0`, { amount: 1000 }, {
        'x-idempotency-key': 'idempotency-key-1',
        'x-role': 'CLIENT',
        'x-user-id': client._id.toString()
      });

      if (firstResponse.status !== 200) throw new Error(`First approval failed: ${firstResponse.status} ${JSON.stringify(firstResponse.body)}`);

      const secondResponse = await postJson(server.address().port, `/api/governance/approve/${ledger._id}/milestone/0`, { amount: 1000 }, {
        'x-idempotency-key': 'idempotency-key-1',
        'x-role': 'CLIENT',
        'x-user-id': client._id.toString()
      });

      if (secondResponse.status !== 200) throw new Error(`Replay should succeed with cached response, got ${secondResponse.status}`);

      const mismatchResponse = await postJson(server.address().port, `/api/governance/approve/${ledger._id}/milestone/0`, { amount: 999999 }, {
        'x-idempotency-key': 'idempotency-key-1',
        'x-role': 'CLIENT',
        'x-user-id': client._id.toString()
      });

      if (mismatchResponse.status !== 409) throw new Error(`Payload mismatch should be rejected, got ${mismatchResponse.status}`);

      const refreshedContractor = await User.findById(contractor._id);
      if (refreshedContractor.wallet.pendingClearance !== 950) throw new Error(`Contractor pending clearance mismatch: expected 950, got ${refreshedContractor.wallet.pendingClearance}`);

      console.log('✅ Idempotency replay and payload-hijack rejection verified.');
      process.exit(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await EscrowLedger.findByIdAndDelete(ledger._id);
      await User.findByIdAndDelete(client._id);
      await User.findByIdAndDelete(contractor._id);
      await User.findByIdAndDelete(admin._id);
    }
  } catch (error) {
    console.error('💥 IDEMPOTENCY DIAGNOSTIC FAILED:', error.message);
    process.exit(1);
  }
}

runIdempotencyDiagnostics();
