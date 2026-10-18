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

// 8. Image EXIF verification (photo path) — a real JPEG with GPS + timestamp
// EXIF, built byte-by-byte (little-endian TIFF inside an APP1 "Exif" segment).
function jpegWithExif({ latDms, lngDms, dateTime }) {
  const tiff = Buffer.alloc(178);
  const entry = (at, tag, type, count, value) => {
    tiff.writeUInt16LE(tag, at); tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4); tiff.writeUInt32LE(value, at + 8);
  };
  const rationals = (at, [d, m, s]) => {
    [[d, 1], [m, 1], [Math.round(s * 100), 100]].forEach(([n, den], i) => {
      tiff.writeUInt32LE(n, at + i * 8); tiff.writeUInt32LE(den, at + i * 8 + 4);
    });
  };
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);                    // IFD0: 2 entries
  entry(10, 0x8769, 4, 1, 38);                 //   ExifIFD pointer
  entry(22, 0x8825, 4, 1, 76);                 //   GPS IFD pointer
  tiff.writeUInt16LE(1, 38);                   // Exif IFD: DateTimeOriginal
  entry(40, 0x9003, 2, 20, 56);
  tiff.write(`${dateTime}\0`, 56, 'latin1');
  tiff.writeUInt16LE(4, 76);                   // GPS IFD
  entry(78, 0x0001, 2, 2, 0); tiff.write('N\0', 86, 'latin1');
  entry(90, 0x0002, 5, 3, 130);
  entry(102, 0x0003, 2, 2, 0); tiff.write('E\0', 110, 'latin1');
  entry(114, 0x0004, 5, 3, 154);
  rationals(130, latDms); rationals(154, lngDms);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1Len = Buffer.alloc(2); app1Len.writeUInt16BE(exif.length + 2);
  return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE1]), app1Len, exif, Buffer.from([0xFF, 0xD9])]);
}

(async () => {
  const ExifReader = require('exifreader');
  const { extractExifFacts } = require('../services/exifFacts');

  // Count main-thread parses: load a fresh evidenceService against a counting
  // proxy of exifreader (its exports are getter-only, so they can't be patched
  // in place). The worker thread has its own module cache and is unaffected.
  let mainThreadParses = 0;
  const exifPath = require.resolve('exifreader');
  const servicePath = require.resolve('../services/evidenceService');
  const realExif = require.cache[exifPath].exports;
  require.cache[exifPath].exports = { ...realExif, load: (...a) => { mainThreadParses += 1; return realExif.load(...a); } };
  delete require.cache[servicePath];
  const { verifyImageEvidence, VerificationTier } = require('../services/evidenceService');
  require.cache[exifPath].exports = realExif;

  console.log('\n6. Image EXIF verification:');
  // 23.7808 N, 90.4053 E (Dhaka), taken 15 Oct 2026.
  const photo = jpegWithExif({ latDms: [23, 46, 50.88], lngDms: [90, 24, 19.08], dateTime: '2026:10:15 10:30:00' });
  const facts = extractExifFacts(ExifReader.load(photo, { expanded: true }));
  assert('EXIF facts: GPS decoded to ~23.7808 N, 90.4053 E',
    facts.hasGps && Math.abs(facts.lat - 23.7808) < 1e-4 && Math.abs(facts.lng - 90.4053) < 1e-4);
  assert('EXIF facts: DateTimeOriginal read', facts.dateTimeOriginal === '2026:10:15 10:30:00');

  // The photo is parsed in the worker only: the main thread must not call
  // ExifReader.load when the worker succeeds (it used to parse twice).
  const ok = await verifyImageEvidence(photo, 23.7808, 90.4053, '2026-10-01');
  assert('On-site photo taken after start -> CRYPTOGRAPHIC_PROOF', ok.verificationTier === VerificationTier.CRYPTOGRAPHIC_PROOF);
  assert('EXIF parsed once, off the main thread', mainThreadParses === 0);

  try {
    await verifyImageEvidence(photo, 23.9000, 90.4053, '2026-10-01');
    assert('Photo ~13 km from site must be rejected', false);
  } catch (e) {
    assert('Photo ~13 km from site rejected (422)', e.statusCode === 422);
  }
  try {
    await verifyImageEvidence(photo, 23.7808, 90.4053, '2026-10-20');
    assert('Photo predating the project must be rejected', false);
  } catch (e) {
    assert('Photo taken before project start rejected (422)', e.statusCode === 422);
  }
  const bare = await verifyImageEvidence(Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]), 23.7808, 90.4053, '2026-10-01');
  assert('Photo without EXIF -> REQUIRES_CLIENT_AUDIT (not rejected)', bare.verificationTier === VerificationTier.REQUIRES_CLIENT_AUDIT);

  console.log('\n--- Results: ' + passed + ' passed, ' + failed + ' failed ---');
  if (failed > 0) process.exit(1);
})().catch((err) => {
  console.error('💥 evidence unit tests crashed:', err);
  process.exit(1);
});
