// tests/sybil-audit-unit.js
// Unit tests for Threat Model §1: Contractor Sybil & Shell Account Detector
'use strict';

const { auditContractorSybils } = require('../scripts/qa/contractor-sybil-audit');

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
  console.log('🧪 Contractor Sybil Audit Unit Tests');

  // Test 1: Empty or malformed input
  const empty = auditContractorSybils([]);
  check('Empty profiles array returns zero anomalies', empty.length === 0);

  const malformed = auditContractorSybils([null, undefined, { invalid: true }]);
  check('Malformed profile entries handled gracefully', malformed.length === 0);

  // Test 2: Healthy, distinct contractors
  const healthyProfiles = [
    { _id: 'cp1', userId: 'u1', tradeLicense: 'TL-DHAKA-1001', nidHash: 'hash_a_1234567890' },
    { _id: 'cp2', userId: 'u2', tradeLicense: 'TL-CHITTAGONG-2002', nidHash: 'hash_b_1234567890' },
    { _id: 'cp3', userId: 'u3', tradeLicense: 'TL-SYLHET-3003', nidHash: 'hash_c_1234567890' }
  ];
  const healthy = auditContractorSybils(healthyProfiles);
  check('Healthy distinct contractors trigger no sybil flags', healthy.length === 0);

  // Test 3: SYBIL-01 Duplicate trade license shared across profiles
  const duplicateLicenseProfiles = [
    { _id: 'cp1', userId: 'u1', tradeLicense: 'TL-SHARED-9999', nidHash: 'hash_1' },
    { _id: 'cp2', userId: 'u2', tradeLicense: 'TL-SHARED-9999', nidHash: 'hash_2' }
  ];
  const dupLicenseAnomalies = auditContractorSybils(duplicateLicenseProfiles);
  check('SYBIL-01 flags duplicate trade license', dupLicenseAnomalies.some((a) => a.rule === 'SYBIL-01'));

  // Test 4: SYBIL-02 Duplicate NID hash (attempted identity reuse with different phones)
  const duplicateNidProfiles = [
    { _id: 'cp1', userId: 'u1', tradeLicense: 'TL-101', nidHash: 'identical_nid_hash_999' },
    { _id: 'cp2', userId: 'u2', tradeLicense: 'TL-102', nidHash: 'identical_nid_hash_999' }
  ];
  const dupNidAnomalies = auditContractorSybils(duplicateNidProfiles);
  check('SYBIL-02 flags duplicate NID hash identity collision', dupNidAnomalies.some((a) => a.rule === 'SYBIL-02'));

  // Test 5: SYBIL-03 Placeholder / dummy trade license
  const placeholderProfiles = [
    { _id: 'cp1', userId: 'u1', tradeLicense: '123456' },
    { _id: 'cp2', userId: 'u2', tradeLicense: 'N/A' },
    { _id: 'cp3', userId: 'u3', tradeLicense: 'TEST' }
  ];
  const placeholderAnomalies = auditContractorSybils(placeholderProfiles);
  check('SYBIL-03 flags placeholder dummy trade licenses', placeholderAnomalies.filter((a) => a.rule === 'SYBIL-03').length === 3);

  // Test 6: SYBIL-04 Rapid registration burst
  const burstUsers = [
    { _id: 'u1', role: 'CONTRACTOR', createdAt: new Date('2026-10-21T02:00:00Z') },
    { _id: 'u2', role: 'CONTRACTOR', createdAt: new Date('2026-10-21T02:00:15Z') },
    { _id: 'u3', role: 'CONTRACTOR', createdAt: new Date('2026-10-21T02:00:30Z') }
  ];
  const burstAnomalies = auditContractorSybils(healthyProfiles, burstUsers);
  check('SYBIL-04 flags rapid contractor user creation bursts', burstAnomalies.some((a) => a.rule === 'SYBIL-04'));

  if (failed > 0) {
    console.error(`💥 ${failed} test(s) failed.`);
    process.exit(1);
  }
  console.log('✅ All contractor sybil audit unit tests passed cleanly.');
  process.exit(0);
}

run();
