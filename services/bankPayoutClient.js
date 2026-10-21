const axios = require('axios');
const crypto = require('crypto');

const MOCK_BANK_BASE = 'https://api.mock-bank.com/v1';
const PAYOUT_TIMEOUT_MS = Number(process.env.BANK_PAYOUT_TIMEOUT_MS || 5000);
const ORACLE_TIMEOUT_MS = Number(process.env.BANK_ORACLE_TIMEOUT_MS || 4000);

/** @type {null | { initiatePayout?: Function, queryPayoutStatus?: Function }} */
let testOverrides = null;

/**
 * Test-only hook so e2e suites never depend on live DNS to mock-bank.com.
 */
function setTestOverrides(overrides) {
  testOverrides = overrides;
}

function clearTestOverrides() {
  testOverrides = null;
}

/** The bank API base. Outside production an unset value falls back to the mock (dev/CI only). */
function bankBase() {
  const raw = (process.env.BANK_PAYOUT_API_BASE || '').trim().replace(/\/+$/, '');
  return raw || MOCK_BANK_BASE;
}

/**
 * Audit D2: in production a payout may only be sent to an explicitly configured https bank API that is
 * not a mock host. Otherwise contractor bank details would be POSTed to a public third-party domain.
 * Routes check this BEFORE debiting a wallet.
 */
function isPayoutConfigured() {
  if (testOverrides) return true;
  if (process.env.BANK_PAYOUT_MODE === 'mock' || process.env.PAYMENT_GATEWAY_MODE === 'mock') return true;
  if (process.env.NODE_ENV !== 'production') return true;
  const raw = (process.env.BANK_PAYOUT_API_BASE || '').trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !/mock/i.test(u.hostname);
  } catch (_) {
    return false;
  }
}

function normalizeOracleStatus(raw) {
  const status = String(raw || '').toUpperCase();
  if (status === 'SUCCESS' || status === 'COMPLETED' || status === 'PAID') return 'SUCCESS';
  if (status === 'FAILED' || status === 'REJECTED' || status === 'DECLINED' || status === 'NOT_FOUND') {
    return 'FAILED';
  }
  if (status === 'PENDING' || status === 'PROCESSING' || status === 'IN_FLIGHT') return 'PENDING';
  return 'UNKNOWN';
}

/**
 * Classifies initiate/payout transport outcomes.
 * Only DEFINITE_FAILURE is safe to refund synchronously.
 * Everything else must remain PROCESSING for the reconciliation oracle.
 */
function classifyPayoutError(error) {
  if (error?.isDefiniteFailure === true) {
    return { kind: 'DEFINITE_FAILURE', message: error.message || 'Bank rejected payout.' };
  }

  const status = error?.response?.status;
  const code = error?.code;

  // Explicit client-side rejections from the bank (validation / hard decline).
  // 409 is NOT one of them: a duplicate/idempotent-replay answer usually means the bank already holds
  // the payout, so refunding it would pay twice. It stays ambiguous for the reconciliation sweeper.
  if (status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429) {
    const bankMessage =
      error.response?.data?.message ||
      error.response?.data?.error ||
      error.message ||
      `Bank rejected payout (${status}).`;
    return { kind: 'DEFINITE_FAILURE', message: bankMessage };
  }

  // Timeouts, network partitions, 5xx, 408, 429 — outcome is unknowable.
  const message =
    code === 'ECONNABORTED' || code === 'ETIMEDOUT'
      ? `Bank payout timed out (${code}).`
      : error?.message || 'Bank payout outcome is ambiguous.';

  return { kind: 'AMBIGUOUS', message };
}

async function initiatePayout({ amount, bankDetails, clientReference }) {
  if (testOverrides?.initiatePayout) {
    return testOverrides.initiatePayout({ amount, bankDetails, clientReference });
  }

  if (process.env.BANK_PAYOUT_MODE === 'mock' || process.env.PAYMENT_GATEWAY_MODE === 'mock') {
    return {
      bankTransactionId: `MOCK_BNK_${crypto.randomBytes(6).toString('hex').toUpperCase()}`
    };
  }

  if (!isPayoutConfigured()) {
    throw Object.assign(new Error('Bank payouts are not configured on this server.'), { isDefiniteFailure: true });
  }
  const response = await axios.post(
    `${bankBase()}/payouts`,
    {
      amount,
      accountNumber: bankDetails.accountNumber,
      routingNumber: bankDetails.routingNumber,
      accountName: bankDetails.accountName,
      bankName: bankDetails.bankName,
      clientReference
    },
    {
      timeout: PAYOUT_TIMEOUT_MS,
      headers: { 'Idempotency-Key': clientReference }
    }
  );

  return {
    bankTransactionId: response.data?.transactionId || response.data?.bankTransactionId || null
  };
}

/**
 * External banking oracle used by the anti-entropy sweeper.
 * Returns: SUCCESS | FAILED | PENDING | UNKNOWN
 */
async function queryPayoutStatus({ clientReference, bankTransactionId, withdrawalId }) {
  if (testOverrides?.queryPayoutStatus) {
    return testOverrides.queryPayoutStatus({ clientReference, bankTransactionId, withdrawalId });
  }

  if (process.env.BANK_PAYOUT_MODE === 'mock' || process.env.PAYMENT_GATEWAY_MODE === 'mock') {
    return {
      status: 'SUCCESS',
      bankTransactionId: bankTransactionId || `MOCK_BNK_${crypto.randomBytes(6).toString('hex').toUpperCase()}`
    };
  }

  // Never ask (or leak ids to) an unconfigured bank, and never conclude anything from it.
  if (!isPayoutConfigured()) return { status: 'UNKNOWN', bankTransactionId: bankTransactionId || null };

  try {
    const lookupKey = bankTransactionId || clientReference || String(withdrawalId);
    const response = await axios.get(`${bankBase()}/payouts/status/${encodeURIComponent(lookupKey)}`, {
      timeout: ORACLE_TIMEOUT_MS,
      params: { clientReference, bankTransactionId, withdrawalId: String(withdrawalId) }
    });

    return {
      status: normalizeOracleStatus(response.data?.status),
      bankTransactionId: response.data?.transactionId || response.data?.bankTransactionId || bankTransactionId || null
    };
  } catch (error) {
    const httpStatus = error?.response?.status;
    // Hard 404 with explicit not-found semantics → bank never accepted the payout.
    if (httpStatus === 404) {
      return { status: 'FAILED', bankTransactionId: null };
    }
    // Unreachable oracle must never trigger an automatic refund.
    return { status: 'UNKNOWN', bankTransactionId: bankTransactionId || null };
  }
}

module.exports = {
  initiatePayout,
  queryPayoutStatus,
  classifyPayoutError,
  isPayoutConfigured,
  setTestOverrides,
  clearTestOverrides,
  normalizeOracleStatus
};
