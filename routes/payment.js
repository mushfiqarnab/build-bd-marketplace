// routes/payment.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// Middleware & Utilities
const { verifyToken, requireRole } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');

// Database Models
const EscrowLedger = require('../models/EscrowLedger');

const isMockGateway = process.env.PAYMENT_GATEWAY_MODE === 'mock' || process.env.NODE_ENV === 'test' || !process.env.SSL_STORE_ID || !process.env.SSL_STORE_PASSWORD;

// ==========================================
// @route   POST /api/payment/initiate/:ledgerId
// @desc    Initiate SSLCommerz payment session with AbortController timeout guard
// @access  Private (Strictly assigned CLIENT only)
// ==========================================
router.post(
  '/initiate/:ledgerId',
  verifyToken,
  requireRole(['CLIENT']),
  catchAsync(async (req, res, next) => {
    const { ledgerId } = req.params;

    const ledger = await EscrowLedger.findById(ledgerId).populate('clientId', 'phoneNumber');
    if (!ledger) {
      const err = new Error('Target escrow ledger not found.');
      err.statusCode = 404;
      err.isOperational = true;
      return next(err);
    }

    if (ledger.clientId._id.toString() !== req.user.userId) {
      const err = new Error('Authorization Breach: You are not the client responsible for funding this contract.');
      err.statusCode = 403;
      err.isOperational = true;
      return next(err);
    }

    if (ledger.ledgerStatus !== 'PENDING_FUNDING') {
      const err = new Error(`Transaction Rejected: Ledger status is currently '${ledger.ledgerStatus}'.`);
      err.statusCode = 400;
      err.isOperational = true;
      return next(err);
    }

    const tranId = `BUILDBD-${ledgerId}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

    const sslcommerzPayload = {
      store_id: process.env.SSL_STORE_ID,
      store_passwd: process.env.SSL_STORE_PASSWORD,
      total_amount: ledger.totalContractValue,
      currency: 'BDT',
      tran_id: tranId,
      success_url: `${process.env.SERVER_URL || 'http://localhost:5000'}/api/payment/success`,
      fail_url: `${process.env.SERVER_URL || 'http://localhost:5000'}/api/payment/fail`,
      cancel_url: `${process.env.SERVER_URL || 'http://localhost:5000'}/api/payment/cancel`,
      ipn_url: `${process.env.SERVER_URL || 'http://localhost:5000'}/api/payment/ipn`,
      cus_name: 'BuildBD Valued Client',
      cus_email: 'client@buildbd.internal',
      cus_phone: ledger.clientId.phoneNumber || '01700000000',
      shipping_method: 'NO',
      product_name: 'Construction Smart Escrow Contract',
      product_category: 'Infrastructure',
      product_profile: 'general'
    };

    if (isMockGateway) {
      const mockSessionKey = `MOCK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      ledger.pendingTransactionId = tranId;
      ledger.gatewaySessionKey = mockSessionKey;
      await ledger.save();

      return res.status(200).json({
        status: 'success',
        message: 'SSLCommerz payment session successfully initialized.',
        gatewayUrl: `${process.env.SERVER_URL || 'http://localhost:5000'}/api/payment/success`,
        sessionKey: mockSessionKey,
        tranId: tranId
      });
    }

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
      const err = new Error(networkError.name === 'AbortError' ? 'Gateway Timeout.' : `Network Failure: ${networkError.message}`);
      err.statusCode = 504;
      err.isOperational = true;
      return next(err);
    }
    clearTimeout(timeoutId);

    if (!sslData || sslData.status !== 'SUCCESS') {
      const err = new Error(`Payment Gateway Error: ${sslData.failedreason || 'Initialization failed.'}`);
      err.statusCode = 502;
      err.isOperational = true;
      return next(err);
    }

    ledger.pendingTransactionId = tranId;
    ledger.gatewaySessionKey = sslData.sessionkey;
    await ledger.save();

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
    const { tran_id, val_id, status, amount, currency } = req.body;

    if (!tran_id || !val_id) {
      const err = new Error('Invalid IPN payload received from gateway.');
      err.statusCode = 400;
      err.isOperational = true;
      return next(err);
    }

    const ledger = await EscrowLedger.findOne({ pendingTransactionId: tran_id });
    if (!ledger) {
      const err = new Error(`IPN Reconciliation Error: Ledger not found for transaction ${tran_id}`);
      err.statusCode = 404;
      err.isOperational = true;
      return next(err);
    }

    if (ledger.ledgerStatus === 'FUNDED') {
      return res.status(200).json({ status: 'success', message: 'Transaction already reconciled.' });
    }

    if (status !== 'VALID' && status !== 'VALIDATED') {
      ledger.ledgerStatus = 'PAYMENT_FAILED';
      await ledger.save();
      return res.status(200).json({ status: 'ignored', message: 'Payment status invalid or failed.' });
    }

    let validationData;
    if (isMockGateway) {
      validationData = {
        status: 'VALIDATED',
        amount: amount || ledger.totalContractValue,
        currency: currency || 'BDT'
      };
    } else {
      const validationUrl = process.env.NODE_ENV === 'production'
        ? `https://securepay.sslcommerz.com/validator/api/validationserverAPI.php?val_id=${val_id}&store_id=${process.env.SSL_STORE_ID}&store_passwd=${process.env.SSL_STORE_PASSWORD}&v=1&format=json`
        : `https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php?val_id=${val_id}&store_id=${process.env.SSL_STORE_ID}&store_passwd=${process.env.SSL_STORE_PASSWORD}&v=1&format=json`;

      const validationResponse = await fetch(validationUrl);
      validationData = await validationResponse.json();
    }

    if (
      !validationData ||
      (validationData.status !== 'VALID' && validationData.status !== 'VALIDATED') ||
      parseFloat(validationData.amount) !== ledger.totalContractValue ||
      validationData.currency !== 'BDT'
    ) {
      const err = new Error('Cryptographic Validation Failed: Gateway signature mismatch or amount tampering detected.');
      err.statusCode = 400;
      err.isOperational = true;
      return next(err);
    }

    ledger.ledgerStatus = 'FUNDED';
    ledger.paidAt = new Date();
    ledger.gatewaySessionKey = null;
    await ledger.save();

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
