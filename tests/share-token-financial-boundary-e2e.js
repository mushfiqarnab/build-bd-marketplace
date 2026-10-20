// tests/share-token-financial-boundary-e2e.js
// Regression test for §1.2: Centralized Financial-Path Authorization Boundary
// Asserts that a valid delegated project share token hitting ANY money route
// is strictly rejected with HTTP 403 Forbidden.
'use strict';

require('dotenv').config();
process.env.PORT = '0';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-32chars-minimum-safe';

const http = require('http');
const mongoose = require('mongoose');
const { server: appServer } = require('../server');
const { MONEY_ROUTES } = require('../scripts/qa/route-policy');
const ProjectShareToken = require('../models/ProjectShareToken');
const Project = require('../models/Project');
const User = require('../models/User');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function run() {
  console.log('🧪 share-token financial boundary e2e verification');

  if (!appServer.listening) {
    await new Promise((resolve) => appServer.on('listening', resolve));
  }
  const port = appServer.address().port;

  // Create test delegation token
  const client = await User.create({
    phoneNumber: `017${Math.floor(10000000 + Math.random() * 90000000)}`,
    role: 'CLIENT',
    status: 'ACTIVE'
  });

  const project = await Project.create({
    clientId: client._id,
    title: 'Financial Boundary Guard Test Project',
    category: 'Residential',
    description: 'Project used exclusively to test share token financial boundary isolation.',
    location: 'Dhaka',
    budget: 500000,
    status: 'OPEN'
  });

  const crypto = require('crypto');
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  await ProjectShareToken.create({
    projectId: project._id,
    clientUserId: client._id,
    delegateName: 'Site Supervisor Test',
    scopedRole: 'SITE_WATCHER',
    tokenHash,
    hideFinancials: true,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  });

  function requestWithShareToken(method, pathName) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: pathName,
        method,
        headers: {
          'x-project-share-token': rawToken,
          'Content-Type': 'application/json'
        }
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch (_) {}
          resolve({ status: res.statusCode, body: json || body });
        });
      });
      req.on('error', reject);
      req.end(JSON.stringify({}));
    });
  }

  // Iterate over every route in MONEY_ROUTES
  for (const routeKey of MONEY_ROUTES) {
    const [method, routeTemplate] = routeKey.split(' ');
    // Replace param placeholders with dummy ObjectIds / numbers
    const dummyId = new mongoose.Types.ObjectId().toString();
    const concretePath = routeTemplate
      .replace(':ledgerId', dummyId)
      .replace(':milestoneIndex', '0')
      .replace(':id', dummyId)
      .replace(':ticketId', dummyId)
      .replace(':bidId', dummyId)
      .replace(':valId', dummyId);

    const res = await requestWithShareToken(method, concretePath);
    check(
      `Share token hitting ${routeKey} returns 403 Forbidden`,
      res.status === 403,
      `got status ${res.status}: ${JSON.stringify(res.body)}`
    );
  }

  // Cleanup
  await ProjectShareToken.deleteMany({ projectId: project._id });
  await Project.deleteOne({ _id: project._id });
  await User.deleteOne({ _id: client._id });

  if (failed > 0) {
    console.error(`💥 ${failed} checks failed.`);
    process.exit(1);
  } else {
    console.log('--- Results: all passed ---');
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('💥 Test crashed:', err);
  process.exit(1);
});
