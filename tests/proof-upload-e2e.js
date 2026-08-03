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
      const filePath = path.join(__dirname, 'fixtures', 'proof-sample.txt');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'proof payload for escrow milestone testing');

      const formDataBoundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
      const payload = [
        `--${formDataBoundary}`,
        'Content-Disposition: form-data; name="proof"; filename="proof-sample.txt"',
        'Content-Type: text/plain',
        '',
        fs.readFileSync(filePath, 'utf8'),
        `--${formDataBoundary}--`,
        ''
      ].join('\r\n');

      const uploadRes = await new Promise((resolve, reject) => {
        const req = require('http').request({
          port: server.address().port,
          path: `/api/governance/proof/${ledger._id}/milestone/0`,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${formDataBoundary}`,
            'x-role': 'CONTRACTOR',
            'x-user-id': contractor._id.toString()
          }
        }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });

      if (uploadRes.status !== 200) throw new Error(`Upload failed: ${uploadRes.status}`);

      const refreshedLedger = await EscrowLedger.findById(ledger._id);
      if (refreshedLedger.milestones[0].status !== 'PROOF_SUBMITTED') throw new Error('Ledger milestone did not advance to PROOF_SUBMITTED');
      if (!refreshedLedger.milestones[0].proofOfWorkHash) throw new Error('Proof hash was not stored');

      console.log('✅ Streaming proof upload and ledger sealing verified.');
      process.exit(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await EscrowLedger.findByIdAndDelete(ledger._id);
      await User.findByIdAndDelete(client._id);
      await User.findByIdAndDelete(contractor._id);
      fs.unlinkSync(path.join(__dirname, 'fixtures', 'proof-sample.txt'));
    }
  } catch (error) {
    console.error('💥 PROOF UPLOAD DIAGNOSTIC FAILED:', error.message);
    process.exit(1);
  }
}

runProofUploadDiagnostics();
