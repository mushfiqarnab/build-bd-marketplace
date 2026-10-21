#!/usr/bin/env node
// scripts/qa/bid-anomaly-detector.js — statistical bid-rigging and cartel anomaly detector
//
// Detects suspicious bidding patterns flagged in Bangladesh Market Threat Model §3:
//   BA-01: Price clustering — 3+ bids on one project within a tight <=2% price band
//   BA-02: Temporal clustering — 3+ bids on one project submitted within 60 seconds
//   BA-03: Co-bidding syndicate — identical contractor pairs co-bidding on multiple projects
//
// Pure function `detectBidAnomalies(bids)` is exported for unit testing.
// CLI usage:
//   node scripts/qa/bid-anomaly-detector.js --uri "<mongodb uri>"
'use strict';

const { createReport, runCli } = require('./lib');

/**
 * Pure function to inspect an array of Bid documents/objects.
 * @param {Array<Object>} bids
 * @returns {Array<{ rule: string, level: string, projectId: string, message: string, detail: any }>}
 */
function detectBidAnomalies(bids = []) {
  const anomalies = [];
  if (!Array.isArray(bids) || bids.length === 0) return anomalies;

  // Group bids by projectId
  const byProject = new Map();
  const contractorProjectMap = new Map(); // contractorId -> Set of projectIds

  for (const b of bids) {
    if (!b || typeof b !== 'object') continue;
    const pId = String(b.projectId || b.project || '');
    const cId = String(b.contractorId || b.contractor || '');
    if (!pId || !cId) continue;

    if (!byProject.has(pId)) byProject.set(pId, []);
    byProject.get(pId).push(b);

    if (!contractorProjectMap.has(cId)) contractorProjectMap.set(cId, new Set());
    contractorProjectMap.get(cId).add(pId);
  }

  // 1. Project-level checks (BA-01, BA-02)
  for (const [projectId, projectBids] of byProject.entries()) {
    if (projectBids.length < 3) continue;

    const validAmounts = projectBids
      .map((b) => Number(b.bidAmount))
      .filter((a) => Number.isFinite(a) && a > 0)
      .sort((a, b) => a - b);

    // BA-01: Price dispersion <= 2% across 3+ bids
    if (validAmounts.length >= 3) {
      const min = validAmounts[0];
      const max = validAmounts[validAmounts.length - 1];
      const spreadPct = min > 0 ? ((max - min) / min) * 100 : 0;
      if (spreadPct <= 2.0) {
        anomalies.push({
          rule: 'BA-01',
          level: 'WARN',
          projectId,
          message: `Tight bid price clustering detected (${spreadPct.toFixed(2)}% spread across ${validAmounts.length} bids). Potential cartel coordination.`,
          detail: { projectId, bidCount: validAmounts.length, min, max, spreadPct }
        });
      }
    }

    // BA-02: Temporal clustering (3+ bids within 60s)
    const sortedByTime = projectBids
      .filter((b) => b.createdAt)
      .map((b) => ({ id: b._id, contractorId: b.contractorId, t: new Date(b.createdAt).getTime() }))
      .sort((a, b) => a.t - b.t);

    for (let i = 0; i <= sortedByTime.length - 3; i++) {
      const spanMs = sortedByTime[i + 2].t - sortedByTime[i].t;
      if (spanMs <= 60 * 1000) {
        anomalies.push({
          rule: 'BA-02',
          level: 'WARN',
          projectId,
          message: `Temporal bid burst detected: 3 bids submitted within ${Math.round(spanMs / 1000)}s.`,
          detail: { projectId, spanSeconds: Math.round(spanMs / 1000), contractors: sortedByTime.slice(i, i + 3).map((x) => x.contractorId) }
        });
        break; // one burst alert per project is sufficient
      }
    }
  }

  // 2. Cross-project co-bidding syndicate check (BA-03)
  const contractors = Array.from(contractorProjectMap.keys());
  for (let i = 0; i < contractors.length; i++) {
    for (let j = i + 1; j < contractors.length; j++) {
      const c1 = contractors[i];
      const c2 = contractors[j];
      const p1 = contractorProjectMap.get(c1);
      const p2 = contractorProjectMap.get(c2);

      // Intersection of projects
      const commonProjects = [];
      for (const p of p1) {
        if (p2.has(p)) commonProjects.push(p);
      }

      if (commonProjects.length >= 3) {
        anomalies.push({
          rule: 'BA-03',
          level: 'INFO',
          projectId: commonProjects[0],
          message: `Frequent co-bidding pair detected: contractors ${c1.slice(-6)} and ${c2.slice(-6)} co-bid on ${commonProjects.length} distinct projects.`,
          detail: { contractor1: c1, contractor2: c2, projectCount: commonProjects.length, commonProjects }
        });
      }
    }
  }

  return anomalies;
}

async function auditDatabase(opts = {}) {
  const report = createReport('Bid Cartel Anomaly Detector');
  const uri = opts.uri || process.env.MONGODB_URI;

  if (!uri) {
    report.warn('BA-URI', 'No MongoDB URI supplied. Pass --uri or set MONGODB_URI.');
    return report;
  }

  if (uri.startsWith('mongodb+srv://')) {
    require('dns').setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
  }

  const mongoose = require('mongoose');
  let conn;

  try {
    conn = await mongoose.createConnection(uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 15000 }).asPromise();
    const db = conn.db;
    const bids = await db.collection('bids').find({ status: { $ne: 'WITHDRAWN' } }).toArray();

    if (!bids.length) {
      report.pass('BA-00', 'No active bids found in database to evaluate.');
      return report;
    }

    const anomalies = detectBidAnomalies(bids);
    if (!anomalies.length) {
      report.pass('BA-OK', `Evaluated ${bids.length} bids across all projects; 0 cartel or clustering anomalies found.`);
    } else {
      for (const a of anomalies) {
        if (a.level === 'WARN') report.warn(a.rule, a.message, a.detail);
        else if (a.level === 'FAIL') report.fail(a.rule, a.message, a.detail);
        else report.info(a.rule, a.message, a.detail);
      }
    }
  } catch (err) {
    report.warn('BA-CONN', `Database query failed: ${err.message}`);
  } finally {
    if (conn) await conn.close().catch(() => {});
  }

  return report;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const uriIdx = argv.indexOf('--uri');
  const uri = uriIdx !== -1 ? argv[uriIdx + 1] : undefined;
  runCli(auditDatabase, { uri });
}

module.exports = { detectBidAnomalies, auditDatabase };
