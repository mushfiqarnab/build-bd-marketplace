// Phase 21 EvidenceService Unit Test Runner
'use strict';

const {
  verifyLivePing,
  computeDynamicRadius,
  haversineDistanceMeters,
  GEOFENCE_BASE_METERS,
  GEOFENCE_HARD_CAP_METERS
} = require('../services/evidenceService');

let passed = 0;
let failed = 0;

function assert(label, cond) {
  if (cond) { console.log('  \u2705', label); passed++; }
  else       { console.error('  \u274C', label); failed++; }
}

console.log('\n\ud83e\uddec Phase 21 EvidenceService Unit Tests\n');

// 1. Dynamic Accuracy Thresholding
console.log('1. Dynamic Accuracy Thresholding:');
assert('Good phone (accuracy=15m) -> 40m base',   computeDynamicRadius(15)  === 40);
assert('Mid-range (accuracy=50m) -> 50m',          computeDynamicRadius(50)  === 50);
assert('Degraded GPS (accuracy=75m) -> 75m',       computeDynamicRadius(75)  === 75);
assert('Worst-case (accuracy=100m) -> 80m cap',    computeDynamicRadius(100) === 80);
assert('Spoofer claims accuracy=3m -> 40m base',   computeDynamicRadius(3)   === 40);
assert('Unknown accuracy (NaN) -> 40m base',       computeDynamicRadius(NaN) === 40);

// 2. Haversine Formula accuracy
console.log('\n2. Haversine Formula:');
const dSame = haversineDistanceMeters(23.7808, 90.4053, 23.7808, 90.4053);
assert('Identical coords = 0m', dSame < 0.001);
const dNorth = haversineDistanceMeters(23.7808, 90.4053, 23.7817, 90.4053);
assert('~100m north drift is 90-110m', dNorth > 90 && dNorth < 110);

// 3. Live Ping — within range
console.log('\n3. Live Ping Verification (valid cases):');
const r1 = verifyLivePing(23.7808, 90.4053, 23.7808, 90.4053, 30);
assert('Exact site location passes', r1.verified === true);
assert('Distance is ~0m', r1.distanceMeters < 1);
assert('Dynamic radius = 40m for good GPS', r1.dynamicRadius === 40);

// Degraded GPS hardware (Walton phone, accuracy=75m) within dynamic radius
const r2 = verifyLivePing(23.7808, 90.4053, 23.7808, 90.4060, 75);
assert('Walton phone (75m accuracy) passes when close', r2.verified === true);
assert('Dynamic radius expands to 75m for weak GPS', r2.dynamicRadius === 75);

// 4. Fraud detection — outside hard cap
console.log('\n4. Fraud Detection:');
try {
  verifyLivePing(23.7808, 90.4053, 23.7900, 90.4053, 30); // ~1020m away
  assert('Should have thrown for far-away location', false);
} catch (e) {
  assert('Throws 422 when outside geofence', e.statusCode === 422);
  assert('Error message mentions distance', e.message.includes('from the project site'));
}

// 5. Spoofer at ~100m claiming precision GPS
try {
  verifyLivePing(23.7808, 90.4053, 23.7817, 90.4053, 3); // ~100m north, claims 3m accuracy
  assert('Spoofer at 100m must be blocked', false);
} catch (e) {
  assert('Spoofer at ~100m blocked despite 3m accuracy claim', e.statusCode === 422);
}

// 6. Worst-case legitimate: contractor 79m away with 80m accuracy hardware
// dynamicRadius = min(80, max(40, 80)) = 80m; 79m < 80m => PASS
const r3 = verifyLivePing(23.7808, 90.4053, 23.7815, 90.4053, 80);
assert('Legitimate worst-case (79m distance, 80m accuracy) passes', r3.verified === true);

// 7. Invalid coordinates rejected
console.log('\n5. Input Validation:');
try {
  verifyLivePing('not', 90.4053, 23.7808, 90.4053, 30);
  assert('Invalid lat must throw', false);
} catch (e) {
  assert('Invalid lat string throws 400', e.statusCode === 400);
}

console.log('\n--- Results: ' + passed + ' passed, ' + failed + ' failed ---');
if (failed > 0) process.exit(1);
