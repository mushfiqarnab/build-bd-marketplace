const dns = require('dns');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
require('dotenv').config();

try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
  console.log('🌐 Forced public DNS override active for finance test.');
} catch (err) {
  console.warn('⚠️ DNS override failed:', err.message);
}

const User = require('../models/User');
const WithdrawalLedger = require('../models/WithdrawalLedger');
const auth = require('../middleware/auth');
const bankPayoutClient = require('../services/bankPayoutClient');

function postJson(serverPort, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      port: serverPort,
      path: pathName,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
        } catch (error) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function runFinanceDiagnostics() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000
    });

    await WithdrawalLedger.deleteMany({});

    const contractor = await User.create({
      role: 'CONTRACTOR',
      phoneNumber: `018${Math.floor(10000000 + Math.random() * 90000000)}`,
      wallet: { lockedEscrow: 0, pendingClearance: 0, availableToWithdraw: 1000 },
      status: 'ACTIVE'
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

    // Deterministic definite bank rejection (no live DNS dependency).
    bankPayoutClient.setTestOverrides({
      initiatePayout: async () => {
        const err = new Error('Mock bank hard-declined payout.');
        err.isDefiniteFailure = true;
        err.response = { status: 422, data: { message: 'Mock bank hard-declined payout.' } };
        throw err;
      }
    });

    // Ensure route binds the stubbed auth exports (avoid stale module cache).
    delete require.cache[require.resolve('../routes/finance')];
    const financeRouter = require('../routes/finance');
    const app = express();
    app.use(express.json());
    app.use('/api/finance', financeRouter);

    const server = app.listen(0);

    try {
      const response = await postJson(server.address().port, '/api/finance/withdraw', {
        amount: 500,
        bankDetails: {
          accountName: 'Test User',
          accountNumber: '12345678',
          routingNumber: '999',
          bankName: 'Test Bank'
        }
      }, {
        'x-idempotency-key': `finance-key-${Date.now()}`,
        'x-role': 'CONTRACTOR',
        'x-user-id': contractor._id.toString()
      });

      if (response.status !== 502) {
        throw new Error(`Expected bank failure response 502, got ${response.status}`);
      }

      const refreshedUser = await User.findById(contractor._id);
      if (refreshedUser.wallet.availableToWithdraw !== 1000) {
        throw new Error(`Refund failed: expected 1000, got ${refreshedUser.wallet.availableToWithdraw}`);
      }

      const ledgerRecords = await WithdrawalLedger.find({ userId: contractor._id });
      if (ledgerRecords.length !== 1) {
        throw new Error(`Expected one ledger record, found ${ledgerRecords.length}`);
      }
      if (ledgerRecords[0].status !== 'FAILED') {
        throw new Error(`Ledger should be FAILED, got ${ledgerRecords[0].status}`);
      }

      console.log('✅ Saga withdrawal lock and compensating refund verified.');
      process.exit(0);
    } finally {
      bankPayoutClient.clearTestOverrides();
      await new Promise((resolve) => server.close(resolve));
      await User.findByIdAndDelete(contractor._id);
      await WithdrawalLedger.deleteMany({ userId: contractor._id });
    }
  } catch (error) {
    bankPayoutClient.clearTestOverrides();
    console.error('💥 FINANCE DIAGNOSTIC FAILED:', error.message);
    process.exit(1);
  }
}

runFinanceDiagnostics();
