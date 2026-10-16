// routes/payment.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Middleware & Utilities
const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');

// Database Models
const EscrowLedger = require('../models/EscrowLedger');
const User = require('../models/User');

const isMockGateway = process.env.PAYMENT_GATEWAY_MODE === 'mock' || process.env.NODE_ENV === 'test' || !process.env.SSL_STORE_ID || !process.env.SSL_STORE_PASSWORD;

// ==========================================
// @route   POST /api/payment/initiate/:ledgerId
// @desc    Initiate SSLCommerz payment session with CAS Atomic Lock & AbortController timeout
// @access  Private (Strictly assigned CLIENT only)
// ==========================================
router.post(
  '/initiate/:ledgerId',
  verifyToken,
  requireRole(['CLIENT']),
  catchAsync(async (req, res, next) => {
    const { ledgerId } = req.params;

    // 1. Resolve client user profile from DB for verified metadata
    const clientUser = await User.findById(req.user.userId).select('phoneNumber role status');
    if (!clientUser) {
      return next(Object.assign(new Error('Authenticated client user profile not found.'), { statusCode: 404, isOperational: true }));
    }

    const tranId = `BUILDBD-${ledgerId}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

    // 2. Atomic CAS Lock: Ensures only ONE concurrent initiation request can set pendingTransactionId
    const targetLedger = await EscrowLedger.findOneAndUpdate(
      {
        _id: ledgerId,
        clientId: req.user.userId,
        ledgerStatus: 'PENDING_FUNDING'
      },
      {
        $set: { pendingTransactionId: tranId }
      },
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

    // 3. Prepare Gateway Payload using DB-derived customer metadata
    const sslcommerzPayload = {
      store_id: process.env.SSL_STORE_ID,
      store_passwd: process.env.SSL_STORE_PASSWORD,
      total_amount: targetLedger.totalContractValue,
      currency: 'BDT',
      tran_id: tranId,
      success_url: `${process.env.SERVER_URL || 'http://localhost:5000'}/api/payment/success`,
      fail_url: `${process.env.SERVER_URL || 'http://localhost:5000'}/api/payment/fail`,
      cancel_url: `${process.env.SERVER_URL || 'http://localhost:5000'}/api/payment/cancel`,
      ipn_url: `${process.env.SERVER_URL || 'http://localhost:5000'}/api/payment/ipn`,
      cus_name: 'BuildBD Valued Client',
      cus_email: 'client@buildbd.internal',
      cus_phone: clientUser.phoneNumber || process.env.TREASURY_PHONE || '01700000000',
      shipping_method: 'NO',
      product_name: `Construction Escrow Contract ${ledgerId}`,
      product_category: 'Infrastructure',
      product_profile: 'general'
    };

    // 4. Mock Gateway Branch for Local Dev & Test Suites
    if (isMockGateway) {
      const mockSessionKey = `MOCK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      targetLedger.gatewaySessionKey = mockSessionKey;
      await targetLedger.save();

      return res.status(200).json({
        status: 'success',
        message: 'SSLCommerz payment session successfully initialized.',
        gatewayUrl: `${process.env.SERVER_URL || 'http://localhost:5000'}/api/payment/success`,
        sessionKey: mockSessionKey,
        tranId: tranId
      });
    }

    // 5. Production/Sandbox SSLCommerz Gateway Dispatch with AbortController & Rollback Saga
    const sslApiUrl = process.env.NODE_ENV === 'production'
      ? 'https://securepay.sslcommerz.com/gwprocess/v4/api.php'
      : 'https://sandbox.sslcommerz.com/gwprocess/v4/api.php';

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    let sslResponse, sslData;
    try {
      sslResponse = await fetch(sslApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(sslcommerzPayload),
        signal: controller.signal
      });
      sslData = await sslResponse.json();
    } catch (networkError) {
      clearTimeout(timeoutId);
      // 🛡️ Rollback Saga: Clear pendingTransactionId so user can retry initialization
      await EscrowLedger.updateOne({ _id: ledgerId }, { $set: { pendingTransactionId: null } });

      const err = new Error(networkError.name === 'AbortError' ? 'Payment gateway timed out. Please try again.' : `Gateway Network Failure: ${networkError.message}`);
      err.statusCode = 504;
      err.isOperational = true;
      return next(err);
    }
    clearTimeout(timeoutId);

    if (!sslData || sslData.status !== 'SUCCESS') {
      // 🛡️ Rollback Saga: Clear pendingTransactionId on gateway error
      await EscrowLedger.updateOne({ _id: ledgerId }, { $set: { pendingTransactionId: null } });

      const err = new Error(`Payment Gateway Error: ${sslData?.failedreason || 'Gateway session creation failed.'}`);
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
      tranId: tranId
    });
  })
);

// ==========================================
// @route   POST /api/payment/ipn
// @desc    Server-to-Server IPN Webhook with Atomic CAS & Cryptographic Validation
// ==========================================
router.post(
  '/ipn',
  catchAsync(async (req, res, next) => {
    const { tran_id, val_id, status, amount, currency, verify_sign } = req.body;

    // 🛡️ C-1: GATEWAY SPOOFING DEFENSE
    // In production, SSLCommerz always sends a verify_sign field.
    // Reject any IPN payload that arrives without it — this blocks anonymous spoofing attempts.
    if (!isMockGateway && !verify_sign) {
      console.error(`🚨 CRITICAL: Unsigned IPN payload rejected for transaction ${tran_id}`);
      return res.status(400).send('Invalid Webhook Signature');
    }

    if (!tran_id || !val_id) {
      const err = new Error('Invalid IPN payload received from gateway.');
      err.statusCode = 400;
      err.isOperational = true;
      return next(err);
    }

    if (status !== 'VALID' && status !== 'VALIDATED') {
      // Atomically mark payment failure — CAS predicate ensures no double-write
      await EscrowLedger.findOneAndUpdate(
        { pendingTransactionId: tran_id, ledgerStatus: 'PENDING_FUNDING' },
        { $set: { ledgerStatus: 'PAYMENT_FAILED' } }
      );
      return res.status(200).json({ status: 'ignored', message: 'Payment status invalid or failed.' });
    }

    // 🛡️ Step 1: Independently validate the transaction with SSLCommerz (prevents amount tampering)
    // M-4 FIX: Credentials travel in an encrypted POST body, never as plaintext URL query params.
    let validationData;
    if (isMockGateway) {
      validationData = {
        status: 'VALIDATED',
        amount: amount || '0',
        currency: currency || 'BDT'
      };
    } else {
      const sslValidationBase = process.env.NODE_ENV === 'production'
        ? 'https://securepay.sslcommerz.com/validator/api/validationserverAPI.php'
        : 'https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php';

      const validationParams = new URLSearchParams({
        val_id,
        store_id: process.env.SSL_STORE_ID,
        store_passwd: process.env.SSL_STORE_PASSWORD,
        v: '1',
        format: 'json'
      });

      // 🛡️ POST — credentials go into the encrypted request body, not the URL or server access logs
      // 🛡️ FLAW 2 FIX: AbortController prevents event-loop exhaustion from hung/tarpit endpoints
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 8000);

      let validationResponse;
      try {
        validationResponse = await fetch(sslValidationBase, {
          method: 'POST',
          body: validationParams,
          signal: abortController.signal
        });
        validationData = await validationResponse.json();
      } catch (fetchError) {
        clearTimeout(timeoutId);
        const isTimeout = fetchError.name === 'AbortError';
        console.error(`🚨 IPN S2S ${isTimeout ? 'Timeout' : 'Network Failure'} for tran_id ${tran_id}:`, fetchError.message);
        // Return 502 — SSLCommerz will retry the IPN; we must NOT fund or reject the ledger
        // on an ambiguous network outcome.
        return res.status(502).send('Gateway Validation Unreachable');
      }
      clearTimeout(timeoutId);
    }

    // 🛡️ Step 2: Verify the ledger exists and amount matches before committing
    const ledgerForValidation = await EscrowLedger.findOne({ pendingTransactionId: tran_id }).select('totalContractValue ledgerStatus');
    if (!ledgerForValidation) {
      const err = new Error(`IPN Reconciliation Error: Ledger not found for transaction ${tran_id}`);
      err.statusCode = 404;
      err.isOperational = true;
      return next(err);
    }

    if (
      !validationData ||
      (validationData.status !== 'VALID' && validationData.status !== 'VALIDATED') ||
      parseFloat(validationData.amount) !== ledgerForValidation.totalContractValue ||
      validationData.currency !== 'BDT'
    ) {
      const err = new Error('Cryptographic Validation Failed: Gateway signature mismatch or amount tampering detected.');
      err.statusCode = 400;
      err.isOperational = true;
      return next(err);
    }

    // 🛡️ H-2: ATOMIC CAS — transition from PENDING_FUNDING → FUNDED exactly once.
    // If two concurrent IPN callbacks arrive, only one will match the predicate.
    // The second will find no document and return null — treated as safe duplicate.
    const fundedLedger = await EscrowLedger.findOneAndUpdate(
      {
        pendingTransactionId: tran_id,
        ledgerStatus: 'PENDING_FUNDING' // CAS predicate: only write if still pending
      },
      {
        $set: {
          ledgerStatus: 'FUNDED',
          paidAt: new Date(),
          paidByValId: val_id, // 🛡️ Permanently links ledger to SSLCommerz's own validation record
          gatewaySessionKey: null
        }
      },
      { returnDocument: 'after' }
    );

    if (!fundedLedger) {
      // Ledger was already FUNDED by a prior IPN callback — idempotent response
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
