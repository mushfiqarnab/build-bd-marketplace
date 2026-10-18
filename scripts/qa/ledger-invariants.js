#!/usr/bin/env node
// scripts/qa/ledger-invariants.js — escrow money-state invariants.
//
// Two uses:
//   1. checkLedger(ledger) — pure function, used by the state-machine fuzzer
//      (tests/money-state-machine-fuzz-e2e.js) after every action.
//   2. CLI — audits every EscrowLedger in a database, READ-ONLY:
//        node scripts/qa/ledger-invariants.js --uri "<mongodb uri>"
//      (falls back to MONGODB_URI). It reads the raw collection with no
//      Mongoose model, so connecting never builds indexes or writes anything.
//
// Every rule here is a money rule the routes must keep; a violation means
// money can be paid twice, stranded, or released during a dispute.
'use strict';

const { TERMINAL_MILESTONE_STATUSES } = require('../../utils/money');
const { createReport, runCli } = require('./lib');

const FUNDED_STATUSES = new Set(['FUNDED', 'PARTIALLY_DISBURSED', 'IN_ARBITRATION', 'FULLY_DISBURSED']);
const UNFUNDED_STATUSES = new Set(['PENDING_FUNDING', 'CANCELLED']);
const OFFLINE_ONLY_STATUSES = new Set(['PAID_OFFLINE', 'CLIENT_APPROVED']);

const RULES = {
  'LI-01': 'Milestone amounts are whole taka >= 0 and sum to totalContractValue',
  'LI-02': 'Milestone release percentages sum to 100',
  'LI-03': 'An unfunded ledger has only PENDING milestones and no payment id',
  'LI-04': 'A funded ledger carries its SSLCommerz paidByValId',
  'LI-05': 'Milestones run in order: everything after the first open milestone is PENDING',
  'LI-06': 'An online-funded escrow never takes an offline settlement state',
  'LI-07': 'IN_ARBITRATION exactly when some milestone is DISPUTED',
  'LI-08': 'FULLY_DISBURSED exactly when every milestone is terminal',
  'LI-09': 'Escrow-released milestones carry a matching settlementStatus'
};

/** Returns [{ rule, message }] for every invariant this ledger breaks. */
function checkLedger(ledger) {
  const v = [];
  const add = (rule, message) => v.push({ rule, message });
  const ms = Array.isArray(ledger.milestones) ? ledger.milestones : [];
  const status = ledger.ledgerStatus;
  const online = Boolean(ledger.paidByValId);

  if (!ms.length) add('LI-01', 'ledger has no milestones');
  const badAmount = ms.findIndex((m) => !Number.isInteger(m.amount) || m.amount < 0);
  if (badAmount !== -1) add('LI-01', `milestone ${badAmount} amount ${ms[badAmount].amount} is not whole non-negative taka`);
  const sum = ms.reduce((t, m) => t + (Number(m.amount) || 0), 0);
  if (ms.length && sum !== ledger.totalContractValue) add('LI-01', `milestones sum to ${sum}, contract is ${ledger.totalContractValue}`);

  const pct = ms.reduce((t, m) => t + (Number(m.releasePercentage) || 0), 0);
  if (ms.length && Math.abs(pct - 100) > 0.05) add('LI-02', `release percentages sum to ${pct}`);

  if (UNFUNDED_STATUSES.has(status)) {
    const open = ms.findIndex((m) => m.status !== 'PENDING');
    if (open !== -1) add('LI-03', `${status} ledger has milestone ${open} in ${ms[open].status}`);
    if (online) add('LI-03', `${status} ledger already has paidByValId`);
  }

  if (FUNDED_STATUSES.has(status) && !online) add('LI-04', `${status} ledger has no paidByValId`);

  const firstOpen = ms.findIndex((m) => !TERMINAL_MILESTONE_STATUSES.has(m.status));
  if (firstOpen !== -1) {
    const early = ms.findIndex((m, i) => i > firstOpen && m.status !== 'PENDING');
    if (early !== -1) add('LI-05', `milestone ${early} is ${ms[early].status} while milestone ${firstOpen} is still ${ms[firstOpen].status}`);
  }

  if (online) {
    const off = ms.findIndex((m) => OFFLINE_ONLY_STATUSES.has(m.status));
    if (off !== -1) add('LI-06', `online escrow milestone ${off} is ${ms[off].status}`);
  }

  if (FUNDED_STATUSES.has(status)) {
    const disputed = ms.some((m) => m.status === 'DISPUTED');
    if (disputed !== (status === 'IN_ARBITRATION')) {
      add('LI-07', disputed ? `milestone DISPUTED but ledger is ${status}` : 'ledger IN_ARBITRATION with no DISPUTED milestone');
    }
    const allTerminal = ms.length > 0 && ms.every((m) => TERMINAL_MILESTONE_STATUSES.has(m.status));
    if (allTerminal !== (status === 'FULLY_DISBURSED')) {
      add('LI-08', allTerminal ? `every milestone terminal but ledger is ${status}` : 'FULLY_DISBURSED with an open milestone');
    }
  }

  if (online) {
    ms.forEach((m, i) => {
      if (m.status === 'COMPLETED' && !['PENDING_CLEARANCE', 'SETTLED'].includes(m.settlementStatus)) {
        add('LI-09', `milestone ${i} COMPLETED with settlementStatus ${m.settlementStatus}`);
      }
      if (m.status === 'REFUNDED' && m.settlementStatus !== 'REFUNDED') {
        add('LI-09', `milestone ${i} REFUNDED with settlementStatus ${m.settlementStatus}`);
      }
    });
  }

  return v;
}

async function auditDatabase({ uri } = {}) {
  const report = createReport('Ledger invariants');
  if (!uri) {
    report.fail('LI-URI', 'No database: pass --uri or set MONGODB_URI');
    return report;
  }
  // Same as server.js: some Bangladeshi ISP resolvers fail Atlas SRV lookups
  // (querySrv ECONNREFUSED), so use public DNS for mongodb+srv:// only.
  if (uri.startsWith('mongodb+srv://')) {
    require('dns').setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
  }
  const mongoose = require('mongoose');
  const conn = await mongoose.createConnection(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 }).asPromise();
  try {
    const byRule = new Map(Object.keys(RULES).map((r) => [r, []]));
    const refunds = [];
    let scanned = 0;
    const cursor = conn.db.collection('escrowledgers').find({}, {
      projection: { ledgerStatus: 1, totalContractValue: 1, paidByValId: 1, milestones: 1, orphanPayments: 1 }
    });
    for await (const ledger of cursor) {
      scanned += 1;
      for (const { rule, message } of checkLedger(ledger)) byRule.get(rule).push(`${ledger._id}: ${message}`);
      for (const p of ledger.orphanPayments || []) {
        if (p.refundedAt) continue;
        refunds.push(`${ledger._id}: ${p.amount} BDT, tran ${p.tranId}, val ${p.valId}, ${p.reason}, ${new Date(p.receivedAt).toISOString()}`);
      }
    }
    report.info('LI-SCAN', `Scanned ${scanned} escrow ledgers (read-only)`);
    // Not a code bug — money SSLCommerz captured that an operator must refund.
    if (refunds.length) report.warn('LI-REFUND', `${refunds.length} gateway payment(s) need a manual refund`, refunds.slice(0, 50));
    else report.pass('LI-REFUND', 'No orphan gateway payments awaiting refund');
    for (const [rule, title] of Object.entries(RULES)) {
      const hits = byRule.get(rule);
      if (hits.length) report.fail(rule, `${title} — ${hits.length} ledger(s) violate`, hits.slice(0, 20));
      else report.pass(rule, title);
    }
  } finally {
    await conn.close();
  }
  return report;
}

module.exports = { checkLedger, RULES };

if (require.main === module) {
  require('dotenv').config();
  const i = process.argv.indexOf('--uri');
  runCli(auditDatabase, { uri: i !== -1 ? process.argv[i + 1] : process.env.MONGODB_URI });
}
