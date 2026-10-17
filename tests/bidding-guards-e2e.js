/**
 * Self-contained bidding eligibility diagnostics (no live server required).
 * Covers: missing profile, unverified, probation cap, fingerprint, accept transaction.
 */
const dns = require('dns');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
require('dotenv').config();

try {
  if (process.env.MONGODB_URI && process.env.MONGODB_URI.includes('+srv')) {
    dns.setServers(['8.8.8.8', '1.1.1.1']);
  }
} catch (err) {
  console.warn('⚠️ DNS override failed:', err.message);
}

const User = require('../models/User');
const Project = require('../models/Project');
const Bid = require('../models/Bid');
const EscrowLedger = require('../models/EscrowLedger');
const ContractorProfile = require('../models/ContractorProfile');
const auth = require('../middleware/auth');

const genPhone = () => `018${Math.floor(10000000 + Math.random() * 90000000)}`;

function requestJson(port, method, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
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

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
    serverSelectionTimeoutMS: 15000
  });

  const client = await User.create({ phoneNumber: genPhone(), role: 'CLIENT', status: 'ACTIVE' });
  const verified = await User.create({ phoneNumber: genPhone(), role: 'CONTRACTOR', status: 'ACTIVE' });
  const unverified = await User.create({ phoneNumber: genPhone(), role: 'CONTRACTOR', status: 'ACTIVE' });
  const probation = await User.create({ phoneNumber: genPhone(), role: 'CONTRACTOR', status: 'ACTIVE' });
  const noProfile = await User.create({ phoneNumber: genPhone(), role: 'CONTRACTOR', status: 'ACTIVE' });

  await ContractorProfile.create({
    userId: verified._id,
    businessType: 'INDIVIDUAL',
    fullName: 'Verified Pro',
    verification: {
      status: 'VERIFIED',
      probationStatus: { isProbation: false, projectsCompleted: 3, projectsRequired: 3, canBidAbove: 100000 }
    }
  });

  await ContractorProfile.create({
    userId: unverified._id,
    businessType: 'INDIVIDUAL',
    fullName: 'Unverified Pro',
    verification: {
      status: 'PENDING',
      probationStatus: { isProbation: true, projectsCompleted: 0, projectsRequired: 3, canBidAbove: 100000 }
    }
  });

  await ContractorProfile.create({
    userId: probation._id,
    businessType: 'INDIVIDUAL',
    fullName: 'Probation Pro',
    verification: {
      status: 'VERIFIED',
      probationStatus: { isProbation: true, projectsCompleted: 0, projectsRequired: 3, canBidAbove: 100000 }
    }
  });

  const project = await Project.create({
    clientId: client._id,
    title: 'Uttara bathroom renovation package',
    category: 'Renovation',
    description: 'Full bathroom renovation including tiling, plumbing, and fixtures.',
    location: 'Uttara, Dhaka',
    budget: 250000,
    status: 'OPEN'
  });

  auth.verifyToken = (req, res, next) => {
    req.user = {
      userId: req.headers['x-user-id'],
      role: req.headers['x-role']
    };
    next();
  };
  auth.requireRole = (roles) => (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ status: 'error', message: 'Forbidden' });
    }
    next();
  };

  delete require.cache[require.resolve('../routes/bid')];
  delete require.cache[require.resolve('../routes/contractorProfile')];
  const bidRouter = require('../routes/bid');
  const profileRouter = require('../routes/contractorProfile');

  const app = express();
  app.use(express.json());
  app.use('/api/bids', bidRouter);
  app.use('/api/contractor-profile', profileRouter);
  app.use((err, req, res, next) => {
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  try {
    const missing = await requestJson(port, 'POST', `/api/bids/${project._id}`, {
      bidAmount: 50000,
      estimatedDays: 7,
      proposalText: 'Should fail without profile.'
    }, { 'x-user-id': noProfile._id.toString(), 'x-role': 'CONTRACTOR' });
    if (missing.status !== 403) throw new Error(`missing profile expected 403, got ${missing.status}`);

    const pending = await requestJson(port, 'POST', `/api/bids/${project._id}`, {
      bidAmount: 50000,
      estimatedDays: 7,
      proposalText: 'Should fail while PENDING verification.'
    }, { 'x-user-id': unverified._id.toString(), 'x-role': 'CONTRACTOR' });
    if (pending.status !== 403) throw new Error(`unverified expected 403, got ${pending.status}`);

    const overCap = await requestJson(port, 'POST', `/api/bids/${project._id}`, {
      bidAmount: 250000,
      estimatedDays: 20,
      proposalText: 'Probation over-cap attempt should fail.'
    }, { 'x-user-id': probation._id.toString(), 'x-role': 'CONTRACTOR' });
    if (overCap.status !== 403) throw new Error(`probation over-cap expected 403, got ${overCap.status}`);

    const withinCap = await requestJson(port, 'POST', `/api/bids/${project._id}`, {
      bidAmount: 90000,
      estimatedDays: 14,
      proposalText: 'Probation within-cap bid should succeed.'
    }, { 'x-user-id': probation._id.toString(), 'x-role': 'CONTRACTOR' });
    if (withinCap.status !== 201 || !withinCap.body.bid?.bidFingerprint) {
      throw new Error(`within-cap bid failed: ${JSON.stringify(withinCap)}`);
    }

    const winning = await requestJson(port, 'POST', `/api/bids/${project._id}`, {
      bidAmount: 210000,
      estimatedDays: 18,
      proposalText: 'Verified cleared contractor competitive bid.'
    }, { 'x-user-id': verified._id.toString(), 'x-role': 'CONTRACTOR' });
    if (winning.status !== 201) throw new Error(`verified bid failed: ${JSON.stringify(winning)}`);

    const accept = await requestJson(
      port,
      'PUT',
      `/api/bids/${winning.body.bid._id}/accept`,
      null,
      { 'x-user-id': client._id.toString(), 'x-role': 'CLIENT' }
    );
    if (accept.status !== 200 || !accept.body.escrowLedger) {
      throw new Error(`accept failed: ${JSON.stringify(accept)}`);
    }

    const refreshedProject = await Project.findById(project._id);
    if (refreshedProject.status !== 'ASSIGNED') {
      throw new Error(`project should be ASSIGNED, got ${refreshedProject.status}`);
    }

    const capacity = await ContractorProfile.findOne({ userId: verified._id });
    if (capacity.availability.currentProjects !== 1) {
      throw new Error(`capacity should increment to 1, got ${capacity.availability.currentProjects}`);
    }

    console.log('✅ Bidding guards verified: profile / verification / probation / fingerprint / transactional accept.');
    process.exit(0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await Bid.deleteMany({ projectId: project._id });
    await EscrowLedger.deleteMany({ projectId: project._id });
    await Project.findByIdAndDelete(project._id);
    await ContractorProfile.deleteMany({
      userId: { $in: [verified._id, unverified._id, probation._id, noProfile._id] }
    });
    await User.deleteMany({
      _id: { $in: [client._id, verified._id, unverified._id, probation._id, noProfile._id] }
    });
    await mongoose.disconnect();
  }
}

run().catch((error) => {
  console.error('💥 BIDDING GUARDS DIAGNOSTIC FAILED:', error.message);
  process.exit(1);
});
