// utils/dto.js — what each audience may see. Responses are built from these, never from raw documents.
'use strict';

/**
 * A ledger as shown to its two parties. Gateway/session identifiers and orphan-payment (refund) records
 * are internal: they never reach the client or contractor. `fundedOnline` replaces `paidByValId`.
 */
function toLedgerDto(ledger) {
  if (!ledger) return ledger;
  const plain = typeof ledger.toObject === 'function' ? ledger.toObject() : ledger;
  const pendingMfsVerification = typeof plain.pendingTransactionId === 'string' && plain.pendingTransactionId.startsWith('MFS-');
  const {
    gatewaySessionKey, pendingTransactionId, pendingTransactionIds, paidByValId, orphanPayments, __v, // eslint-disable-line no-unused-vars
    ...rest
  } = plain;
  return { ...rest, fundedOnline: Boolean(paidByValId), pendingMfsVerification };
}

/** 01712345678 -> 017••••••78 : enough to tell bidders apart, not enough to deal outside the platform. */
function maskPhone(phone) {
  return typeof phone === 'string' && /^01\d{9}$/.test(phone) ? `${phone.slice(0, 3)}${'•'.repeat(6)}${phone.slice(-2)}` : null;
}

module.exports = { toLedgerDto, maskPhone };
