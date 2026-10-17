// scripts/qa/schema-policy.js — inspects the REAL Mongoose schemas.
// Validators are exercised with real values (does 1.5 get rejected?), so a
// validator that exists but doesn't work still fails.
'use strict';

const fs = require('fs');
const path = require('path');
const { createReport, runCli } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');

function loadModels() {
  const mongoose = require('mongoose');
  for (const f of fs.readdirSync(path.join(ROOT, 'models')).filter((x) => x.endsWith('.js'))) {
    require(path.join(ROOT, 'models', f));
  }
  return mongoose;
}

function schemaPath(model, dotted) {
  const parts = dotted.split('.');
  let schema = model.schema;
  for (let i = 0; i < parts.length; i += 1) {
    const rest = parts.slice(i).join('.');
    const direct = schema.path(rest);
    if (direct) return direct;
    const sub = schema.path(parts[i]);
    if (sub && sub.schema) { schema = sub.schema; continue; }
    return null;
  }
  return null;
}

/** true when the path rejects a fractional value and accepts an integer. */
function enforcesInteger(p) {
  const fns = (p.validators || []).map((v) => v.validator).filter((v) => typeof v === 'function');
  if (!fns.length) return false;
  // Probe with realistic amounts so min/max rules (e.g. budget ≥ 1,000) don't
  // mask the integer rule: 250000.5 must fail, 250000 must pass.
  const rejectsFraction = fns.some((fn) => { try { return fn.call({}, 250000.5) === false; } catch (_) { return true; } });
  const acceptsInteger = fns.every((fn) => { try { return fn.call({}, 250000) !== false; } catch (_) { return false; } });
  return rejectsFraction && acceptsInteger;
}

function hasUniqueIndex(model, fields, { partial } = {}) {
  const want = JSON.stringify(fields);
  const idx = model.schema.indexes().some(([keys, opts]) => JSON.stringify(keys) === want && opts && opts.unique
    && (!partial || !!opts.partialFilterExpression));
  if (idx) return true;
  const single = Object.keys(fields);
  if (single.length === 1 && !partial) {
    const p = schemaPath(model, single[0]);
    return !!(p && p.options && p.options.unique);
  }
  return false;
}

const MONEY_REQUIRED = [
  ['EscrowLedger', 'totalContractValue'],
  ['EscrowLedger', 'milestones.amount'],
  ['PaymentReceipt', 'amountBDT'],
  ['WithdrawalLedger', 'amount'],
  ['Bid', 'bidAmount'],
  ['Project', 'budget'],
  ['User', 'wallet.lockedEscrow'],
  ['User', 'wallet.pendingClearance'],
  ['User', 'wallet.availableToWithdraw'],
  ['Bid', 'itemizedBreakdown.amount'],
  ['Message', 'payload.revisedAmount'],
  ['Message', 'payload.acceptedAmount']
];
// Any other Number path whose name looks like money must be in the list above.
const MONEY_NAME = /(amount|budget|price|fee|payout|refund|balance|escrow|clearance|withdraw|value)$/i;
const MONEY_EXEMPT = new Set(['EscrowLedger.milestones.releasePercentage', 'ContractorProfile.trustScore']);
const IMMUTABLE = [
  ['User', 'role'], ['User', 'phoneNumber'],
  ['Project', 'clientId'],
  ['Bid', 'projectId'], ['Bid', 'contractorId'],
  ['EscrowLedger', 'projectId'], ['EscrowLedger', 'clientId'], ['EscrowLedger', 'contractorId']
];
const HIDDEN = [
  ['User', 'otp.hash'], ['User', 'otp.expiresAt'], ['User', 'otp.attempts'],
  ['User', 'webAuthnChallenge'], ['User', 'otpVerifiedAt']
];
const UNIQUE = [
  ['User', { phoneNumber: 1 }, {}, 'one account per phone'],
  ['PaymentReceipt', { paymentMethod: 1, trxId: 1 }, {}, 'bKash/Nagad trxId double-spend'],
  ['WithdrawalLedger', { idempotencyKey: 1 }, {}, 'duplicate withdrawals'],
  ['Bid', { projectId: 1, contractorId: 1 }, {}, 'one bid per contractor per project'],
  ['IdempotencyKey', { key: 1, userId: 1 }, {}, 'idempotency replay scope'],
  ['EscrowLedger', { paidByValId: 1 }, { partial: true }, 'one SSLCommerz val_id per ledger'],
  ['PasskeyCredential', { credentialID: 1 }, {}, 'one owner per authenticator credential']
];

async function run() {
  const report = createReport('Schema policy');
  const mongoose = loadModels();
  const model = (n) => mongoose.models[n];

  for (const [m, p] of MONEY_REQUIRED) {
    const sp = model(m) && schemaPath(model(m), p);
    if (!sp) report.fail(`money:${m}.${p}`, 'Money field not found (renamed?) — update the policy');
    else if (!enforcesInteger(sp)) report.fail(`money:${m}.${p}`, 'Money field accepts fractional taka');
    else report.pass(`money:${m}.${p}`, 'rejects fractional taka');
  }
  // Discovery: a NEW money-looking Number field not covered by the policy.
  const known = new Set(MONEY_REQUIRED.map(([m, p]) => `${m}.${p}`));
  const undiscovered = [];
  for (const name of mongoose.modelNames()) {
    const walk = (schema, prefix) => schema.eachPath((p, sp) => {
      const full = `${name}.${prefix}${p}`;
      if (sp.schema) return walk(sp.schema, `${prefix}${p}.`);
      if (sp.instance === 'Number' && MONEY_NAME.test(p.split('.').pop()) && !known.has(full) && !MONEY_EXEMPT.has(full) && !enforcesInteger(sp)) undiscovered.push(full);
      return undefined;
    });
    walk(mongoose.models[name].schema, '');
  }
  if (undiscovered.length) report.warn('money-discovery', 'Number fields that look like money but have no integer validator — add a validator or exempt them', undiscovered);
  else report.pass('money-discovery', 'No unvalidated money-looking Number fields');

  for (const [m, p] of IMMUTABLE) {
    const sp = model(m) && schemaPath(model(m), p);
    if (!sp) report.fail(`immutable:${m}.${p}`, 'Identity field not found — update the policy');
    else if (!(sp.options && sp.options.immutable === true)) report.fail(`immutable:${m}.${p}`, 'Identity reference can be reassigned via update');
    else report.pass(`immutable:${m}.${p}`, 'immutable');
  }

  for (const [m, p] of HIDDEN) {
    const sp = model(m) && schemaPath(model(m), p);
    if (!sp) report.fail(`hidden:${m}.${p}`, 'Sensitive field not found — update the policy');
    else if (!(sp.options && sp.options.select === false)) report.fail(`hidden:${m}.${p}`, 'Sensitive field is returned by default queries');
    else report.pass(`hidden:${m}.${p}`, 'select:false');
  }
  // toJSON scrub must also hold for documents loaded with +select.
  const User = model('User');
  const doc = new User({ phoneNumber: '01700000000', role: 'CLIENT', webAuthnChallenge: 'x', otpVerifiedAt: new Date(), otp: { hash: 'h' } });
  const json = JSON.parse(JSON.stringify(doc));
  if ('otp' in json || 'webAuthnChallenge' in json || 'otpVerifiedAt' in json) report.fail('toJSON-scrub', 'User JSON leaks OTP/challenge fields', Object.keys(json));
  else report.pass('toJSON-scrub', 'User JSON never carries OTP/challenge fields');

  for (const [m, fields, opts, why] of UNIQUE) {
    if (!model(m)) { report.fail(`unique:${m}`, 'Model not found'); continue; }
    const key = `${m}(${Object.keys(fields).join(',')})`;
    if (hasUniqueIndex(model(m), fields, opts)) report.pass(`unique:${key}`, why);
    else report.fail(`unique:${key}`, `Missing unique index — ${why}`);
  }

  // TTL on idempotency keys (otherwise the collection grows forever).
  const idemTtl = model('IdempotencyKey') && schemaPath(model('IdempotencyKey'), 'createdAt');
  if (idemTtl && idemTtl.options && idemTtl.options.expires) report.pass('ttl:IdempotencyKey', `expires after ${idemTtl.options.expires}s`);
  else report.fail('ttl:IdempotencyKey', 'IdempotencyKey has no TTL');

  return report;
}

module.exports = { run };
if (require.main === module) runCli(run);
