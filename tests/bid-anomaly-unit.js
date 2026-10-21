// tests/bid-anomaly-unit.js
// Unit tests for Threat Model §3: Bid Cartel & Rigging Statistical Anomaly Detector
'use strict';

const { detectBidAnomalies } = require('../scripts/qa/bid-anomaly-detector');

let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function run() {
  console.log('🧪 Bid Anomaly Detector Unit Tests');

  // Test 1: Empty or malformed input
  const empty = detectBidAnomalies([]);
  check('Empty bids array returns zero anomalies', empty.length === 0);

  const malformed = detectBidAnomalies([{ random: 'data' }, null, undefined]);
  check('Malformed items ignored gracefully', malformed.length === 0);

  // Test 2: Normal, competitive bidding (healthy market)
  const healthyBids = [
    { projectId: 'p1', contractorId: 'c1', bidAmount: 100000, createdAt: new Date('2026-10-21T01:00:00Z') },
    { projectId: 'p1', contractorId: 'c2', bidAmount: 115000, createdAt: new Date('2026-10-21T02:00:00Z') },
    { projectId: 'p1', contractorId: 'c3', bidAmount: 130000, createdAt: new Date('2026-10-21T03:00:00Z') }
  ];
  const healthyAnomalies = detectBidAnomalies(healthyBids);
  check('Healthy competitive bids trigger no anomalies', healthyAnomalies.length === 0);

  // Test 3: BA-01 Tight price clustering (e.g. 100,000, 100,500, 101,000 — 1% spread)
  const clusteredBids = [
    { projectId: 'p2', contractorId: 'c1', bidAmount: 100000, createdAt: new Date('2026-10-21T01:00:00Z') },
    { projectId: 'p2', contractorId: 'c2', bidAmount: 100500, createdAt: new Date('2026-10-21T02:00:00Z') },
    { projectId: 'p2', contractorId: 'c3', bidAmount: 101000, createdAt: new Date('2026-10-21T03:00:00Z') }
  ];
  const clusteredAnomalies = detectBidAnomalies(clusteredBids);
  check('BA-01 flags price clustering <= 2%', clusteredAnomalies.some((a) => a.rule === 'BA-01'));

  // Test 4: BA-02 Temporal clustering (3 bids within 20 seconds)
  const burstBids = [
    { projectId: 'p3', contractorId: 'c1', bidAmount: 100000, createdAt: new Date('2026-10-21T01:00:00Z') },
    { projectId: 'p3', contractorId: 'c2', bidAmount: 120000, createdAt: new Date('2026-10-21T01:00:10Z') },
    { projectId: 'p3', contractorId: 'c3', bidAmount: 140000, createdAt: new Date('2026-10-21T01:00:20Z') }
  ];
  const burstAnomalies = detectBidAnomalies(burstBids);
  check('BA-02 flags temporal bid burst within 60s', burstAnomalies.some((a) => a.rule === 'BA-02'));

  // Test 5: BA-03 Co-bidding syndicate (contractors c1 and c2 co-bidding on 3 distinct projects)
  const syndicateBids = [
    { projectId: 'p4', contractorId: 'c1', bidAmount: 100000 },
    { projectId: 'p4', contractorId: 'c2', bidAmount: 120000 },
    { projectId: 'p5', contractorId: 'c1', bidAmount: 200000 },
    { projectId: 'p5', contractorId: 'c2', bidAmount: 220000 },
    { projectId: 'p6', contractorId: 'c1', bidAmount: 300000 },
    { projectId: 'p6', contractorId: 'c2', bidAmount: 330000 }
  ];
  const syndicateAnomalies = detectBidAnomalies(syndicateBids);
  check('BA-03 flags frequent co-bidding contractor pair', syndicateAnomalies.some((a) => a.rule === 'BA-03'));

  if (failed > 0) {
    console.error(`💥 ${failed} test(s) failed.`);
    process.exit(1);
  }
  console.log('✅ All bid anomaly unit tests passed cleanly.');
  process.exit(0);
}

run();
