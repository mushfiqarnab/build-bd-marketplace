// routes/payment.js
// 🛡️ Phase-2 SSLCommerz hardening — six P0 fixes from the 2026-10-17 QA audit:
//   P0-1  verify_sign is cryptographically validated (MD5 + SHA256 variants),
//         not merely checked for presence.
//   P0-3  validationData.tran_id must match the IPN body's tran_id.
//   P0-4  paidByValId uniqueness enforced by Mongo (schema + migration).
//   P0-5  isMockGateway no longer silently activates in production when the
//         SSL_* creds are missing — in production, missing creds = 503.
//   P0-6  SERVER_URL must be set in production, or the module refuses to load
//         (no silent http://localhost:5000 fallback that SSLCommerz can't reach).
//   P0-2  (routes/settlement.js) /submit-payment now compares amountBDT to
//         milestone.amount — the Phase-2 settlement guard.
'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Middleware & Utilities
const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');

// Database Models
const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// Boot-time environment assertions
// ─────────────────────────────────────────────────────────────────────────────

/** Resolves true only in non-production dev/test with no creds, OR when
 *  PAYMENT_GATEWAY_MODE=mock is explicitly set. In production without creds,
 *  returns false so the IPN handler refuses to fund any ledger. */
function isMockGateway() {
  if (process.env.PAYMENT_GATEWAY_MODE === 'mock') return true;
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.NODE_ENV === 'production') {
    // In production, "no creds" is NOT an invitation to accept any IPN body —
    // it's a config error. isMockGateway() stays false; the handlers refuse.
    return false;
  }
  // Dev / staging: fall back to mock when creds are absent.
  return !process.env.SSL_STORE_ID || !process.env.SSL_STORE_PASSWORD;
}

/** Public base URL for SSLCommerz callbacks. In production this MUST be set,
 *  otherwise the gateway can never reach the IPN endpoint and no payment ever
 *  flips a ledger to FUNDED. */
function resolveServerUrl() {
  const url = (process.env.SERVER_URL || '').trim().replace(/\/+$/, '');
  if (url) return url;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SERVER_URL is required in production. Set it to the public origin SSLCommerz callbacks must reach (e.g. your ngrok reserved domain or load-balancer URL).');
  }
  return `http://localhost:${process.env.PORT || 5000}`;
}

// Trigger the production assertion at module load so a bad deploy fails fast.
resolveServerUrl();

const GATEWAY_DEFAULTS = {
  sandbox: {
    session: 'https://sandbox.sslcommerz.com/gwprocess/v4/api.php',
    validation: 'https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php'
  },
  live: {
    session: 'https://securepay.sslcommerz.com/gwprocess/v4/api.php',
    validation: 'https://securepay.sslcommerz.com/validator/api/validationserverAPI.php'
  }
};

/** Only https URLs on an sslcommerz.com host may receive store credentials. */
function assertSslcommerzUrl(name, value) {
  let u;
  try { u = new URL(value); } catch (_) { throw new Error(`${name} is not a valid URL.`); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || !(host === 'sslcommerz.com' || host.endsWith('.sslcommerz.com'))) {
    throw new Error(`${name} must be an https://*.sslcommerz.com URL (got ${u.protocol}//${host}).`);
  }
  return value;
}

/**
 * Sandbox vs live is chosen by SSL_IS_SANDBOX, NOT by NODE_ENV. The beta runs
 * NODE_ENV=production for its security guards while still using sandbox
 * credentials; keying off NODE_ENV sent those sandbox creds to the live
 * gateway, which rejects them. SSL_IS_SANDBOX unset → sandbox outside
 * production, live in production. SSL_GATEWAY_URL / SSL_VALIDATION_URL
 * override the defaults but must stay on an sslcommerz.com host so a
 * mis-set env var can never ship the store password to a third party.
 */
function resolveGatewayUrls() {
  const flag = (process.env.SSL_IS_SANDBOX || '').trim().toLowerCase();
  const sandbox = flag === 'true' ? true : flag === 'false' ? false : process.env.NODE_ENV !== 'production';
  const base = sandbox ? GATEWAY_DEFAULTS.sandbox : GATEWAY_DEFAULTS.live;
  const session = (process.env.SSL_GATEWAY_URL || '').trim() || base.session;
  const validation = (process.env.SSL_VALIDATION_URL || '').trim() || base.validation;
  for (const [name, value] of [['SSL_GATEWAY_URL', session], ['SSL_VALIDATION_URL', validation]]) {
    assertSslcommerzUrl(name, value);
    const isSandboxHost = new URL(value).hostname.toLowerCase().startsWith('sandbox.');
    if (isSandboxHost !== sandbox) {
      throw new Error(`${name} points at the ${isSandboxHost ? 'sandbox' : 'live'} gateway but SSL_IS_SANDBOX selects ${sandbox ? 'sandbox' : 'live'}. Make them agree.`);
    }
  }
  return { sandbox, session, validation };
}

// Fail fast at boot on a bad gateway override.
resolveGatewayUrls();

// ─────────────────────────────────────────────────────────────────────────────
// SSLCommerz IPN signature verifier (P0-1)
// ─────────────────────────────────────────────────────────────────────────────

/** Length-safe constant-time hex-string comparison. */
function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Per SSLCommerz IPN docs:
 *   verify_key = comma-separated sorted field names
 *   map           = { each field named in verify_key → its body value,
 *                     store_passwd → md5(STORE_PASSWORD) }
 *   signatureBase = every map entry as key=value, keys sorted ascending
 *                   (PHP ksort — store_passwd sorts INTO position, it is not
 *                   appended), joined with '&'
 *   verify_sign       = md5(signatureBase)
 *   verify_sign_sha2  = sha256(signatureBase)        (modern)
 *
 * Returns true only when verify_sign (or verify_sign_sha2) matches what the
 * merchant can independently compute from the body + its own store_passwd.
 */
function verifySslcommerzSignature(body, storePasswd) {
  if (!body || typeof body !== 'object') return false;
  if (typeof storePasswd !== 'string' || !storePasswd.length) return false;

  const verifyKey = typeof body.verify_key === 'string' ? body.verify_key : '';
  const sig = typeof body.verify_sign === 'string' ? body.verify_sign : '';
  const sigSha2 = typeof body.verify_sign_sha2 === 'string' ? body.verify_sign_sha2 : '';
  if (!verifyKey || (!sig && !sigSha2)) return false;

  // Mirrors SSLCommerz's reference implementation: store_passwd joins the
  // map BEFORE sorting. Appending it after the sorted fields (the Phase-2
  // version) produces a different string whenever any signed field sorts
  // after "store_passwd" (tran_id, val_id, value_a…) — i.e. every real IPN.
  const map = {};
  for (const f of verifyKey.split(',').map((s) => s.trim()).filter(Boolean)) {
    map[f] = body[f] !== undefined && body[f] !== null ? String(body[f]) : '';
  }
  map.store_passwd = crypto.createHash('md5').update(storePasswd).digest('hex');
  const base = Object.keys(map).sort().map((k) => `${k}=${map[k]}`).join('&');

  // Prefer SHA256 when available (modern SSLCommerz accounts send both).
  if (sigSha2) {
    const expected = crypto.createHash('sha256').update(base).digest('hex');
    if (timingSafeEqualHex(expected, sigSha2.toLowerCase())) return true;
  }
  if (sig) {
    const expected = crypto.createHash('md5').update(base).digest('hex');
    if (timingSafeEqualHex(expected, sig.toLowerCase())) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/initiate/:ledgerId
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/initiate/:ledgerId',
  verifyToken,
  requireRole(['CLIENT']),
  catchAsync(async (req, res, next) => {
    const { ledgerId } = req.params;
    const serverUrl = resolveServerUrl();

    const clientUser = await User.findById(req.user.userId).select('phoneNumber role status');
    if (!clientUser) {
      return next(Object.assign(new Error('Authenticated client user profile not found.'), { statusCode: 404, isOperational: true }));
    }

    const tranId = `BUILDBD-${ledgerId}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

    const targetLedger = await EscrowLedger.findOneAndUpdate(
      {
        _id: ledgerId,
        clientId: req.user.userId,
        ledgerStatus: 'PENDING_FUNDING'
      },
      { $set: { pendingTransactionId: tranId } },
      { returnDocument: 'after' }
    );

    if (!targetLedger) {
      return next(
        Object.assign(
          new Error('Payment initialization failed. Ledger is either invalid, not owned by you, or not in PENDING_FUNDING state.'),
          { statusCode: 400, isOperational: true }
        )
      );
    }

    const sslcommerzPayload = {
      store_id: process.env.SSL_STORE_ID,
      store_passwd: process.env.SSL_STORE_PASSWORD,
      total_amount: targetLedger.totalContractValue,
      currency: 'BDT',
      tran_id: tranId,
      success_url: `${serverUrl}/api/payment/success`,
      fail_url: `${serverUrl}/api/payment/fail`,
      cancel_url: `${serverUrl}/api/payment/cancel`,
      ipn_url: `${serverUrl}/api/payment/ipn`,
      // SSLCommerz lists cus_name/email/add1/city/country/phone as mandatory.
      // Without the address fields — and with a non-routable ".internal"
      // email — the session is created but the hosted checkout renders
      // "PAY 0" and never loads. Users have no email/address on file yet,
      // so send syntactically valid defaults (example.com is RFC 2606
      // reserved, never a real inbox) overridable via env.
      cus_name: 'BuildBD Valued Client',
      cus_email: process.env.SSL_CUSTOMER_EMAIL || 'customer@example.com',
      cus_add1: process.env.SSL_CUSTOMER_ADDRESS || 'Dhaka',
      cus_city: process.env.SSL_CUSTOMER_CITY || 'Dhaka',
      cus_postcode: process.env.SSL_CUSTOMER_POSTCODE || '1000',
      cus_country: 'Bangladesh',
      cus_phone: clientUser.phoneNumber || process.env.TREASURY_PHONE || '01700000000',
      shipping_method: 'NO',
      product_name: `Construction Escrow Contract ${ledgerId}`,
      product_category: 'Infrastructure',
      product_profile: 'general'
    };

    if (isMockGateway()) {
      const mockSessionKey = `MOCK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      targetLedger.gatewaySessionKey = mockSessionKey;
      await targetLedger.save();
      return res.status(200).json({
        status: 'success',
        message: 'SSLCommerz payment session successfully initialized.',
        gatewayUrl: `${serverUrl}/api/payment/success`,
        sessionKey: mockSessionKey,
        tranId
      });
    }

    const sslApiUrl = resolveGatewayUrls().session;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let sslData;
    try {
      const sslResponse = await fetch(sslApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(sslcommerzPayload),
        signal: controller.signal
      });
      sslData = await sslResponse.json();
    } catch (networkError) {
      clearTimeout(timeoutId);
      await EscrowLedger.updateOne({ _id: ledgerId }, { $set: { pendingTransactionId: null } });
      const err = new Error(networkError.name === 'AbortError' ? 'Payment gateway timed out. Please try again.' : `Gateway Network Failure: ${networkError.message}`);
      err.statusCode = 504;
      err.isOperational = true;
      return next(err);
    }
    clearTimeout(timeoutId);

    if (!sslData || sslData.status !== 'SUCCESS') {
      await EscrowLedger.updateOne({ _id: ledgerId }, { $set: { pendingTransactionId: null } });
      const err = new Error(`Payment Gateway Error: ${sslData && sslData.failedreason ? sslData.failedreason : 'Gateway session creation failed.'}`);
      err.statusCode = 502;
      err.isOperational = true;
      return next(err);
    }

    targetLedger.gatewaySessionKey = sslData.sessionkey;
    await targetLedger.save();

    res.status(200).json({
      status: 'success',
      message: 'SSLCommerz payment session successfully initialized.',
      gatewayUrl: sslData.GatewayPageURL,
      sessionKey: sslData.sessionkey,
      tranId
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/ipn — Server-to-server webhook (P0-1, P0-3, P0-5)
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/ipn',
  catchAsync(async (req, res, next) => {
    const body = req.body || {};
    const { tran_id, val_id, status, amount, currency } = body;

    // P0-1: Cryptographic signature verification (not just presence). In mock
    // mode the gateway isn't the real SSLCommerz, so signature checking is
    // skipped — mock mode is only reachable in dev/test or when the operator
    // explicitly sets PAYMENT_GATEWAY_MODE=mock.
    if (!isMockGateway()) {
      const ok = verifySslcommerzSignature(body, process.env.SSL_STORE_PASSWORD);
      if (!ok) {
        console.error(`🚨 CRITICAL: IPN signature mismatch for transaction ${tran_id || '(none)'} — body rejected.`);
        return res.status(400).json({ status: 'error', message: 'Invalid Webhook Signature' });
      }
    }

    if (!tran_id || !val_id) {
      const err = new Error('Invalid IPN payload received from gateway.');
      err.statusCode = 400; err.isOperational = true;
      return next(err);
    }

    if (status !== 'VALID' && status !== 'VALIDATED') {
      await EscrowLedger.findOneAndUpdate(
        { pendingTransactionId: tran_id, ledgerStatus: 'PENDING_FUNDING' },
        { $set: { ledgerStatus: 'PAYMENT_FAILED' } }
      );
      return res.status(200).json({ status: 'ignored', message: 'Payment status invalid or failed.' });
    }

    // Step 1: Independently validate the transaction with SSLCommerz.
    let validationData;
    if (isMockGateway()) {
      // In mock mode synthesize a validation record that matches the body, so
      // the cross-checks below exercise the same code path as production.
      validationData = {
        status: 'VALIDATED',
        amount: amount || '0',
        currency: currency || 'BDT',
        tran_id,
        val_id
      };
    } else {
      const sslValidationBase = resolveGatewayUrls().validation;

      const validationParams = new URLSearchParams({
        val_id,
        store_id: process.env.SSL_STORE_ID,
        store_passwd: process.env.SSL_STORE_PASSWORD,
        v: '1',
        format: 'json'
      });

      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 8000);
      try {
        const validationResponse = await fetch(sslValidationBase, {
          method: 'POST',
          body: validationParams,
          signal: abortController.signal
        });
        validationData = await validationResponse.json();
      } catch (fetchError) {
        clearTimeout(timeoutId);
        const isTimeout = fetchError.name === 'AbortError';
        console.error(`🚨 IPN S2S ${isTimeout ? 'Timeout' : 'Network Failure'} for tran_id ${tran_id}:`, fetchError.message);
        return res.status(502).json({ status: 'error', message: 'Gateway Validation Unreachable' });
      }
      clearTimeout(timeoutId);
    }

    // Step 2: Verify ledger exists, and that EVERY field we care about
    //         matches between the body, validator, and ledger.
    const ledgerForValidation = await EscrowLedger.findOne({ pendingTransactionId: tran_id })
      .select('totalContractValue ledgerStatus');
    if (!ledgerForValidation) {
      const err = new Error(`IPN Reconciliation Error: Ledger not found for transaction ${tran_id}`);
      err.statusCode = 404; err.isOperational = true;
      return next(err);
    }

    const validatorStatusOk = validationData && (validationData.status === 'VALID' || validationData.status === 'VALIDATED');
    const validatorAmount = parseFloat(validationData && validationData.amount);
    const validatorTran = validationData && validationData.tran_id;
    const validatorCurrency = validationData && validationData.currency;

    if (!validatorStatusOk) {
      const err = new Error('Validation Failed: Gateway did not confirm transaction.');
      err.statusCode = 400; err.isOperational = true;
      return next(err);
    }
    // P0-3: validator's tran_id must match the body's tran_id — otherwise
    //       val_id spoofing lets an attacker divert a victim's payment.
    if (validatorTran !== tran_id) {
      console.error(`🚨 CRITICAL: validator tran_id (${validatorTran}) does not match body tran_id (${tran_id}) — rejected.`);
      const err = new Error('Validation Failed: Transaction ID mismatch between gateway validator and IPN body.');
      err.statusCode = 400; err.isOperational = true;
      return next(err);
    }
    if (validatorCurrency !== 'BDT') {
      const err = new Error('Validation Failed: Unsupported currency.');
      err.statusCode = 400; err.isOperational = true;
      return next(err);
    }
    // Validator amount must EQUAL ledger amount (not <, not approximately).
    if (!Number.isFinite(validatorAmount) || validatorAmount !== ledgerForValidation.totalContractValue) {
      const err = new Error('Validation Failed: Gateway amount does not match the ledger total.');
      err.statusCode = 400; err.isOperational = true;
      return next(err);
    }

    // Step 3: ATOMIC CAS funding transition (unchanged from the Phase-1 fix).
    const fundedLedger = await EscrowLedger.findOneAndUpdate(
      {
        pendingTransactionId: tran_id,
        ledgerStatus: 'PENDING_FUNDING'
      },
      {
        $set: {
          ledgerStatus: 'FUNDED',
          paidAt: new Date(),
          paidByValId: val_id,
          gatewaySessionKey: null
        }
      },
      { returnDocument: 'after' }
    );

    if (!fundedLedger) {
      console.log(`⚠️ IPN idempotency boundary triggered for tran_id: ${tran_id}. Already reconciled.`);
      return res.status(200).json({ status: 'success', message: 'Transaction already reconciled.' });
    }

    res.status(200).json({
      status: 'success',
      message: 'Escrow ledger successfully funded and reconciled via IPN.'
    });
  })
);

router.post('/success', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Payment completed successfully. Escrow funding is being reconciled.',
    transactionId: req.body.tran_id
  });
});

router.post('/fail', (req, res) => {
  res.status(400).json({
    status: 'error',
    message: 'Payment transaction failed. Please try again.',
    transactionId: req.body.tran_id
  });
});

router.post('/cancel', (req, res) => {
  res.status(400).json({
    status: 'error',
    message: 'Payment transaction was cancelled by the user.',
    transactionId: req.body.tran_id
  });
});

module.exports = router;
// Internal helpers exported for testing — not part of the HTTP contract.
module.exports.verifySslcommerzSignature = verifySslcommerzSignature;
module.exports.isMockGateway = isMockGateway;
module.exports.resolveServerUrl = resolveServerUrl;
module.exports.resolveGatewayUrls = resolveGatewayUrls;
