// tests/fraud-detection-unit.js
// 🧪 Automated test suite for Build-BD Anti-Fraud Document Scanner
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  calculateFileHash,
  validateBangladeshiNid,
  validateTradeLicense,
  inspectImageExif,
  scanDocument
} = require('../services/fraudDetectionService');

async function testFraudService() {
  console.log('🧪 Starting Anti-Fraud Document & Credential Unit Tests...');

  // 1. File Hash Calculation
  const sampleBuf = Buffer.from('Build-BD Test Credential Document 2026');
  const hash = calculateFileHash(sampleBuf);
  assert.strictEqual(hash.length, 64, 'SHA-256 hash must be 64 hex characters');
  console.log('  ✅ calculateFileHash produces deterministic 64-character SHA-256');

  // 2. NID Validation
  const validSmartNid = validateBangladeshiNid('1952345678');
  assert.strictEqual(validSmartNid.valid, true, 'Valid 10-digit Smart NID must pass');

  const valid17Nid = validateBangladeshiNid('19851234567890123');
  assert.strictEqual(valid17Nid.valid, true, 'Valid 17-digit NID with 1985 birth year must pass');

  const dummyNid = validateBangladeshiNid('1111111111');
  assert.strictEqual(dummyNid.valid, false, 'Repetitive NID must fail');

  const sequentialNid = validateBangladeshiNid('1234567890');
  assert.strictEqual(sequentialNid.valid, false, 'Sequential NID must fail');

  const impossibleBirthYearNid = validateBangladeshiNid('19101234567890123');
  assert.strictEqual(impossibleBirthYearNid.valid, false, 'Pre-1940 birth year NID must fail');

  console.log('  ✅ validateBangladeshiNid correctly enforces BD NID format & birth year bounds');

  // 3. Trade License Validation
  const validTrade = validateTradeLicense('TRAD/DNCC/012984/2024');
  assert.strictEqual(validTrade.valid, true, 'Valid City Corporation trade license must pass');

  const shortTrade = validateTradeLicense('123');
  assert.strictEqual(shortTrade.valid, false, 'Short trade license must fail');
  console.log('  ✅ validateTradeLicense enforces structural sanity');

  // 4. Mock Image with Manipulated Software Tag
  const mockImage = Buffer.concat([
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE1]), // JPEG SOI + APP1 marker
    Buffer.from('Some image metadata with Adobe Photoshop CC 2024')
  ]);
  const scanManipulated = await scanDocument({
    buffer: mockImage,
    fileName: 'tampered-proof.jpg',
    mimeType: 'image/jpeg',
    userId: '60c72b2f9b1d8b2bad000001',
    documentCategory: 'WORK_COMPLETION_PHOTO'
  });
  assert(scanManipulated.fraudFlags.some(f => f.includes('DIGITAL_MANIPULATION_DETECTED')), 'Must detect Photoshop tag');
  console.log('  ✅ scanDocument detects digital manipulation software signatures');

  // 5. Clean Document Scan Score
  const cleanDoc = Buffer.from('Original Unique Completion Certificate 99887766');
  const scanClean = await scanDocument({
    buffer: cleanDoc,
    fileName: 'clean-cert.pdf',
    mimeType: 'application/pdf',
    userId: '60c72b2f9b1d8b2bad000002',
    documentCategory: 'EXPERIENCE_CERTIFICATE'
  });
  assert.strictEqual(scanClean.fraudStatus, 'CLEARED', 'Clean document must be CLEARED');
  assert.strictEqual(scanClean.fraudRiskScore, 100, 'Clean document gets 100/100 score');
  console.log('  ✅ scanDocument awards 100/100 CLEARED score to authentic unique credentials');

  console.log('🎉 ALL ANTI-FRAUD DOCUMENT TESTS PASSED PERFECTLY!\n');
}

testFraudService().catch((err) => {
  console.error('❌ Anti-fraud test failed:', err);
  process.exit(1);
});
