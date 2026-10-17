// tests/phase2-ssl-money-e2e.js
// Regression tests for the Phase-2 QA ship-blocker fixes:
//   P0-1   SSLCommerz IPN signature is cryptographically verified
//   P0-2   /submit-payment amountBDT must equal milestone.amount
//   P0-3   IPN validationData.tran_id must equal body.tran_id
//   P0-4   EscrowLedger.paidByValId unique sparse index enforced
//   P0-5   isMockGateway() refuses mock-mode fallback in NODE_ENV=production
//   P0-6   resolveServerUrl() throws when NODE_ENV=production and no SERVER_URL
//   P0-10  EscrowLedger money fields reject fractional BDT
//   P0-11  PaymentReceipt.status default is PENDING_VERIFICATION
//   P0-12  PaymentReceipt.amountBDT rejects fractional BDT
//   P0-13  WithdrawalLedger.amount rejects fractional BDT
'use strict';

const crypto = require('crypto');
const dns = require('dns');
const mongoose = require('mongoose');
require('dotenv').config();

try { dns.setServers(['8.8.8.8', '1.1.1.1']); } catch (_) {}

const User = require('../models/User');
const EscrowLedger = require('../models/EscrowLedger');
const PaymentReceipt = require('../models/PaymentReceipt');
const WithdrawalLedger = require('../models/WithdrawalLedger');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function stashEnv(keys) {
  const stash = {};
  for (const k of keys) stash[k] = process.env[k];
  return () => {
    for (const k of keys) {
      if (stash[k] === undefined) delete process.env[k];
      else process.env[k] = stash[k];
    }
  };
}

function freshRouter() {
  // Clear require cache so routes/payment.js re-reads env at module load.
  delete require.cache[require.resolve('../routes/payment')];
  return require('../routes/payment');
}

async function main() {
  console.log('🧪 phase-2 SSLCommerz + money hardening');

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/buildbd_test', {
    serverSelectionTimeoutMS: 15000
  });
  await EscrowLedger.deleteMany({});
  await PaymentReceipt.deleteMany({});
  await WithdrawalLedger.deleteMany({});
  await User.deleteMany({ phoneNumber: { $regex: /^0199/ } });
  await EscrowLedger.syncIndexes();
  await PaymentReceipt.syncIndexes();
  await WithdrawalLedger.syncIndexes();

  // ── P0-1: SSLCommerz signature verifier ────────────────────────────────────
  const restore = stashEnv(['PAYMENT_GATEWAY_MODE', 'SSL_STORE_ID', 'SSL_STORE_PASSWORD', 'SERVER_URL', 'NODE_ENV']);
  // Load with non-prod, mock creds present so module boot doesn't throw.
  process.env.PAYMENT_GATEWAY_MODE = 'mock';
  process.env.SSL_STORE_ID = 'test_store';
  process.env.SSL_STORE_PASSWORD = 'test_passwd_for_phase2';
  process.env.SERVER_URL = 'https://test.example.test';
  process.env.NODE_ENV = 'test';
  const payment = freshRouter();
  const { verifySslcommerzSignature, isMockGateway, resolveServerUrl } = payment;

  // Build a correctly-signed body manually.
  function buildSignedBody(storePasswd, overrides = {}) {
    const fields = {
      tran_id: 'TXN-TEST-001',
      val_id: 'VAL-001',
      amount: '5000',
      currency: 'BDT',
      status: 'VALID',
      ...overrides
    };
    const keys = Object.keys(fields).sort();
    const parts = keys.map((k) => `${k}=${fields[k]}`);
    parts.push(`store_passwd=${crypto.createHash('md5').update(storePasswd).digest('hex')}`);
    const base = parts.join('&');
    fields.verify_key = keys.join(',');
    fields.verify_sign = crypto.createHash('md5').update(base).digest('hex');
    fields.verify_sign_sha2 = crypto.createHash('sha256').update(base).digest('hex');
    return fields;
  }

  const goodBody = buildSignedBody('test_passwd_for_phase2');
  check('signature verifier accepts a correctly-signed MD5 body',
    verifySslcommerzSignature({ ...goodBody, verify_sign_sha2: '' }, 'test_passwd_for_phase2') === true);
  check('signature verifier accepts a correctly-signed SHA256 body',
    verifySslcommerzSignature({ ...goodBody, verify_sign: '' }, 'test_passwd_for_phase2') === true);
  check('signature verifier rejects a tampered amount',
    verifySslcommerzSignature({ ...goodBody, amount: '999999' }, 'test_passwd_for_phase2') === false);
  check('signature verifier rejects wrong store_passwd',
    verifySslcommerzSignature(goodBody, 'wrong_password') === false);
  check('signature verifier rejects a body with no verify_key',
    verifySslcommerzSignature({ ...goodBody, verify_key: '' }, 'test_passwd_for_phase2') === false);
  check('signature verifier rejects a body with no signatures',
    verifySslcommerzSignature({ ...goodBody, verify_sign: '', verify_sign_sha2: '' }, 'test_passwd_for_phase2') === false);

  // ── P0-5: isMockGateway() behavior ─────────────────────────────────────────
  process.env.NODE_ENV = 'production';
  process.env.PAYMENT_GATEWAY_MODE = '';
  delete process.env.SSL_STORE_ID;
  delete process.env.SSL_STORE_PASSWORD;
  check('production + no creds -> isMockGateway returns FALSE (no silent fallback)',
    isMockGateway() === false);
  process.env.PAYMENT_GATEWAY_MODE = 'mock';
  check('production + PAYMENT_GATEWAY_MODE=mock -> isMockGateway still returns TRUE',
    isMockGateway() === true);
  process.env.NODE_ENV = 'test';
  process.env.PAYMENT_GATEWAY_MODE = '';
  check('NODE_ENV=test -> isMockGateway returns TRUE regardless of creds',
    isMockGateway() === true);

  // ── P0-6: resolveServerUrl() behavior ──────────────────────────────────────
  process.env.NODE_ENV = 'production';
  delete process.env.SERVER_URL;
  let threw = false;
  try { resolveServerUrl(); } catch (_) { threw = true; }
  check('production + no SERVER_URL -> resolveServerUrl throws', threw);
  process.env.SERVER_URL = 'https://prod.example.test';
  check('production + SERVER_URL set -> resolveServerUrl returns it (trimmed)',
    resolveServerUrl() === 'https://prod.example.test');
  process.env.NODE_ENV = 'development';
  delete process.env.SERVER_URL;
  check('development without SERVER_URL -> resolveServerUrl falls back to localhost',
    resolveServerUrl().startsWith('http://localhost:'));

  // ── Gateway routing follows SSL_IS_SANDBOX, not NODE_ENV ──────────────────
  const { resolveGatewayUrls } = payment;
  const restoreGw = stashEnv(['SSL_IS_SANDBOX', 'SSL_GATEWAY_URL', 'SSL_VALIDATION_URL']);
  delete process.env.SSL_GATEWAY_URL; delete process.env.SSL_VALIDATION_URL;
  process.env.NODE_ENV = 'production';
  process.env.SSL_IS_SANDBOX = 'true';
  let gw = resolveGatewayUrls();
  check('production + SSL_IS_SANDBOX=true -> sandbox gateway (beta case)',
    gw.sandbox === true && gw.session.startsWith('https://sandbox.sslcommerz.com/') && gw.validation.startsWith('https://sandbox.sslcommerz.com/'),
    JSON.stringify(gw));
  process.env.SSL_IS_SANDBOX = 'false';
  gw = resolveGatewayUrls();
  check('SSL_IS_SANDBOX=false -> live securepay gateway',
    gw.sandbox === false && gw.session.startsWith('https://securepay.sslcommerz.com/'));
  delete process.env.SSL_IS_SANDBOX;
  check('unset flag -> live in production, sandbox elsewhere',
    resolveGatewayUrls().sandbox === false && ((process.env.NODE_ENV = 'development'), resolveGatewayUrls().sandbox === true));
  process.env.SSL_GATEWAY_URL = 'https://attacker.example.com/collect';
  let badHostThrew = false;
  try { resolveGatewayUrls(); } catch (_) { badHostThrew = true; }
  check('gateway override to a non-sslcommerz host is refused (store password never leaves)', badHostThrew);
  process.env.SSL_GATEWAY_URL = 'http://sandbox.sslcommerz.com/gwprocess/v4/api.php';
  let httpThrew = false;
  try { resolveGatewayUrls(); } catch (_) { httpThrew = true; }
  check('plain-http gateway override is refused', httpThrew);
  process.env.SSL_IS_SANDBOX = 'true';
  process.env.SSL_GATEWAY_URL = 'https://securepay.sslcommerz.com/gwprocess/v4/api.php';
  let mismatchThrew = false;
  try { resolveGatewayUrls(); } catch (_) { mismatchThrew = true; }
  check('sandbox flag with a live gateway override is refused (mismatch)', mismatchThrew);
  restoreGw();

  restore();

  // ── P0-10, P0-12, P0-13: integer-BDT validators ────────────────────────────
  const clientUser = await User.create({ role: 'CLIENT', phoneNumber: '01991120001', status: 'ACTIVE' });
  const contractorUser = await User.create({ role: 'CONTRACTOR', phoneNumber: '01991120002', status: 'ACTIVE' });
  const projectId = new mongoose.Types.ObjectId();

  let fracRejected = false;
  try {
    await EscrowLedger.create({
      projectId, clientId: clientUser._id, contractorId: contractorUser._id,
      totalContractValue: 1000.5,
      milestones: [{ title: 'A', releasePercentage: 100, amount: 1000.5 }]
    });
  } catch (err) {
    fracRejected = /integer BDT/.test(err.message);
  }
  check('EscrowLedger rejects fractional totalContractValue', fracRejected);

  let milestoneFracRejected = false;
  try {
    await EscrowLedger.create({
      projectId, clientId: clientUser._id, contractorId: contractorUser._id,
      totalContractValue: 1000,
      milestones: [{ title: 'A', releasePercentage: 100, amount: 999.9 }]
    });
  } catch (err) {
    milestoneFracRejected = /integer BDT/.test(err.message);
  }
  check('EscrowLedger rejects fractional milestone.amount', milestoneFracRejected);

  const okLedger = await EscrowLedger.create({
    projectId, clientId: clientUser._id, contractorId: contractorUser._id,
    totalContractValue: 50000,
    milestones: [
      { title: 'M1', releasePercentage: 30, amount: 15000 },
      { title: 'M2', releasePercentage: 70, amount: 35000 }
    ]
  });
  check('EscrowLedger accepts integer money fields', !!okLedger._id);

  let receiptFracRejected = false;
  try {
    await PaymentReceipt.create({
      projectId, ledgerId: okLedger._id, milestoneId: okLedger.milestones[0]._id, milestoneIndex: 0,
      clientId: clientUser._id, contractorId: contractorUser._id,
      amountBDT: 15000.75, paymentMethod: 'BKASH', trxId: 'TX-INT-1', s3ReceiptUrl: 'k'
    });
  } catch (err) {
    receiptFracRejected = /integer BDT/.test(err.message);
  }
  check('PaymentReceipt rejects fractional amountBDT', receiptFracRejected);

  let withdrawalFracRejected = false;
  try {
    await WithdrawalLedger.create({
      userId: contractorUser._id,
      amount: 500.5,
      destinationBankDetails: { accountName: 'X', accountNumber: '1', routingNumber: '2', bankName: 'B' },
      idempotencyKey: 'wd-key-fractional-' + Date.now()
    });
  } catch (err) {
    withdrawalFracRejected = /integer BDT/.test(err.message);
  }
  check('WithdrawalLedger rejects fractional amount', withdrawalFracRejected);

  // ── P0-11: PaymentReceipt default status is PENDING_VERIFICATION ──────────
  const defaultReceipt = await PaymentReceipt.create({
    projectId, ledgerId: okLedger._id, milestoneId: okLedger.milestones[0]._id, milestoneIndex: 0,
    clientId: clientUser._id, contractorId: contractorUser._id,
    amountBDT: 15000, paymentMethod: 'CASH', s3ReceiptUrl: 'cash-key'
    // status omitted — should default to PENDING_VERIFICATION
  });
  check('PaymentReceipt default status is PENDING_VERIFICATION, not VERIFIED',
    defaultReceipt.status === 'PENDING_VERIFICATION',
    `got status=${defaultReceipt.status}`);

  // ── P0-4: paidByValId unique sparse index ─────────────────────────────────
  const ledgerA = await EscrowLedger.create({
    projectId, clientId: clientUser._id, contractorId: contractorUser._id,
    totalContractValue: 2000, paidByValId: 'VAL-SHARED-123',
    milestones: [{ title: 'A', releasePercentage: 100, amount: 2000 }]
  });
  let dupRejected = false;
  try {
    await EscrowLedger.create({
      projectId, clientId: clientUser._id, contractorId: contractorUser._id,
      totalContractValue: 3000, paidByValId: 'VAL-SHARED-123',
      milestones: [{ title: 'B', releasePercentage: 100, amount: 3000 }]
    });
  } catch (err) {
    dupRejected = err && err.code === 11000;
  }
  check('EscrowLedger rejects a second row with the same paidByValId', dupRejected);

  // Many nulls must coexist (partial filter only indexes string-typed values).
  // Without the partial filter, a plain {sparse:true} would still conflict on
  // null because sparse skips undefined, not null — the common post-save state.
  const nullA = await EscrowLedger.create({
    projectId, clientId: clientUser._id, contractorId: contractorUser._id,
    totalContractValue: 100, paidByValId: null,
    milestones: [{ title: 'C', releasePercentage: 100, amount: 100 }]
  });
  const nullB = await EscrowLedger.create({
    projectId, clientId: clientUser._id, contractorId: contractorUser._id,
    totalContractValue: 200, paidByValId: null,
    milestones: [{ title: 'D', releasePercentage: 100, amount: 200 }]
  });
  check('Many EscrowLedgers with paidByValId=null coexist (partial filter)',
    !!nullA._id && !!nullB._id);

  await mongoose.disconnect();
  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('💥 phase2-ssl-money crashed:', err);
  process.exit(1);
});
