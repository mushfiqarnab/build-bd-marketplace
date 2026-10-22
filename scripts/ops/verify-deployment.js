// scripts/ops/verify-deployment.js
// Production Deployment Readiness & Smoke Verification Engine
'use strict';

const dns = require('dns');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../../models/User');
require('dotenv').config({ path: '.env.beta' });

try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (_) {}

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5000';

async function verifyStep(name, fn) {
  process.stdout.write(`  ▶ ${name}... `);
  try {
    const result = await fn();
    console.log(`✅ [PASS] ${result || 'OK'}`);
    return true;
  } catch (err) {
    console.log(`❌ [FAIL] ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('🚀 Build-BD Production Deployment & Smoke Verifier');
  console.log(`🌐 Base URL: ${BASE_URL}\n`);

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI);
  }

  let passed = 0;
  let total = 0;

  async function check(name, fn) {
    total += 1;
    const ok = await verifyStep(name, fn);
    if (ok) passed += 1;
  }

  // Obtain a token for a verified active client
  let clientUser = await User.findOne({ role: 'CLIENT', status: 'ACTIVE' }).lean();
  if (!clientUser) {
    clientUser = await User.create({
      phoneNumber: '01711998877',
      role: 'CLIENT',
      status: 'ACTIVE',
      sessionVersion: 1
    });
  }

  const validClientToken = jwt.sign(
    { userId: String(clientUser._id), role: clientUser.role, sv: clientUser.sessionVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  // 1. Health Readiness Probe
  await check('GET /health/readiness (Liveness & Readiness probe)', async () => {
    const res = await fetch(`${BASE_URL}/health/readiness`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== 'ready') throw new Error(`Status is ${json.status}`);
    return `MongoDB: ${json.checks.mongodb}, Redis: ${json.checks.redis}, Indexes: ${json.checks.indexes || 'ok'}`;
  });

  // 2. Security Headers & Strict CSP
  await check('Security Headers & Content Security Policy (CSP)', async () => {
    const res = await fetch(`${BASE_URL}/index.html`);
    const csp = res.headers.get('content-security-policy');
    const xcto = res.headers.get('x-content-type-options');
    const xfo = res.headers.get('x-frame-options');
    if (!csp || !csp.includes("default-src 'self'")) throw new Error('CSP header missing or weak');
    if (xcto !== 'nosniff') throw new Error('X-Content-Type-Options: nosniff missing');
    if (xfo !== 'DENY' && xfo !== 'SAMEORIGIN') throw new Error('X-Frame-Options missing');
    return 'CSP, nosniff, and frame-guard active';
  });

  // 3. Nirman-AI Public Conversational Ingress
  await check('Nirman-AI Public Ingress (Bangla & English NLU)', async () => {
    const res = await fetch(`${BASE_URL}/api/ai/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ utterance: 'ধানমন্ডি এলাকায় ২ ঘণ্টার জন্য ছুটা বুয়া দরকার' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.data?.vertical !== 'DOMESTIC_LABOUR') throw new Error(`Wrong vertical: ${json.data?.vertical}`);
    if (json.data?.extractedSlots?.thana !== 'Dhanmondi') throw new Error(`Wrong thana: ${json.data?.extractedSlots?.thana}`);
    return `Resolved DOMESTIC_LABOUR · Dhanmondi · ৳${json.data?.pricingEstimate?.agreedMonthlyOrDailyBdt}/mo`;
  });

  // 4. Public Domestic Worker Directory Search & PII Redaction
  await check('Public Domestic Directory Search & PII Redaction', async () => {
    const res = await fetch(`${BASE_URL}/api/v2/labour/directory/search?thana=Dhanmondi`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json.data)) throw new Error('data array missing');
    const unredacted = json.data.some((w) => w.phoneNumber && !w.phoneNumber.includes('****'));
    if (unredacted) throw new Error('PII breach: unmasked phone number found in public directory');
    return `${json.data.length} profiles returned with PII masked`;
  });

  // 5. Materials Catalog & Public SKUs
  await check('Public Materials Catalog & Products Search', async () => {
    const res = await fetch(`${BASE_URL}/api/materials/catalog?category=ROD`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const products = json.data?.products;
    if (!Array.isArray(products)) throw new Error('products array missing');
    return `${products.length} products listed under category ROD`;
  });

  // 6. Static Portal Assets & Domestic Labour Page Access
  await check('Static Portal Assets (/app/domestic-labour.html & /app/login.html)', async () => {
    const res = await fetch(`${BASE_URL}/app/domestic-labour.html`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const res2 = await fetch(`${BASE_URL}/app/login.html`);
    if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
    return 'Domestic Labour & Login portals accessible';
  });

  // 7. Micro Parametric BOQ Calculation
  await check('Tier 2 Split-BOQ Renovation & Shifting Engine', async () => {
    const res = await fetch(`${BASE_URL}/api/v2/projects/mid/estimate-boq`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${validClientToken}`
      },
      body: JSON.stringify({ categoryCode: 'MID_PAINTING', areaSqft: 1800, thana: 'Mirpur' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.data?.pricingEstimate?.totalEstimatedBdt !== 100800) {
      throw new Error(`Calculation error: expected 100800, got ${json.data?.pricingEstimate?.totalEstimatedBdt}`);
    }
    return `1,800 sq ft = ৳100,800 (Advance: ৳${json.data?.pricingEstimate?.advance20PctEscrowBdt})`;
  });

  // 8. 2G Telecom Feature Phone Webhook
  await check('2G Telecom Inbound Feature Phone Webhook', async () => {
    const res = await fetch(`${BASE_URL}/api/v2/labour/webhooks/sms-ivr-inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromPhone: '01711223344', digitsOrText: '1', callType: 'IVR_DTMF' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.data?.action !== 'ACCEPT_SHIFT_OR_CONFIRM_ATTENDANCE') {
      throw new Error(`Unexpected action: ${json.data?.action}`);
    }
    return 'DTMF 1 correctly mapped to ACCEPT_SHIFT_OR_CONFIRM_ATTENDANCE';
  });

  console.log(`\n======================================================`);
  console.log(`🏆 Deployment Verification: ${passed}/${total} checks passed (${Math.round((passed / total) * 100)}%)`);
  console.log(`======================================================`);

  await mongoose.disconnect();
  if (passed !== total) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal Deployment Check Error:', err);
    process.exit(1);
  });
}
