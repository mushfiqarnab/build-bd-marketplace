// utils/transaction.js
// One way to run a MongoDB multi-document transaction.
//
// session.withTransaction() re-runs `work` when the server labels an error
// TransientTransactionError (a write conflict, or "catalog changes" while a
// collection/index is being created) and retries the commit on
// UnknownTransactionCommitResult. A hand-rolled startTransaction() turned
// every one of those into a 500.
//
// Because `work` may run more than once, it must:
//   - read everything it decides on INSIDE the session (never trust a
//     document loaded before the transaction);
//   - keep side effects inside the session — no HTTP response, no bank or
//     gateway call, no external write;
//   - reset any outer variable it assigns at the start of each attempt
//     (or simply return its result).
// Throw an operational error (statusCode + isOperational) to abort cleanly.
'use strict';

const mongoose = require('mongoose');

/**
 * Throw from inside `work` to roll the transaction back and answer with an
 * exact HTTP status + JSON body (for handlers whose refusals have their own
 * response shape). Catch it after runTransaction: `err.send(res)`.
 */
class TxResponse extends Error {
  constructor(httpStatus, body) {
    super(body && (body.message || body.error) ? String(body.message || body.error) : `HTTP ${httpStatus}`);
    this.httpStatus = httpStatus;
    this.body = body;
  }

  send(res) {
    return res.status(this.httpStatus).json(this.body);
  }
}

function isTransientTransactionError(err) {
  return Boolean(err && (
    err.code === 112 ||
    (typeof err.hasErrorLabel === 'function' && err.hasErrorLabel('TransientTransactionError'))
  ));
}

/**
 * Runs work(session) in a retried transaction and returns its result.
 * If the conflict persists past the driver's retry window it becomes a 409
 * the client can retry, instead of a 500.
 */
async function runTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (err) {
    if (isTransientTransactionError(err)) {
      throw Object.assign(
        new Error('Another request changed this record at the same moment. Please retry.'),
        { statusCode: 409, isOperational: true }
      );
    }
    throw err;
  } finally {
    session.endSession();
  }
}

module.exports = { runTransaction, isTransientTransactionError, TxResponse };
