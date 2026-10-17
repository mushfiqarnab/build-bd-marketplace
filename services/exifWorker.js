// services/exifWorker.js
// Phase 26 — Worker-thread EXIF forensics offloader
//
// Accepts an image Buffer via workerData.buffer (SharedArrayBuffer or Uint8Array),
// runs ExifReader.load() synchronously inside the worker thread so the main
// Node.js event loop is never blocked by TIFF/JPEG binary traversal, then
// posts the extracted GPS decimal-degree coordinates back via parentPort.
//
// Rational DMS → Decimal Degrees conversion:
//   Each component is a rational [numerator, denominator].
//   decimal = D + M/60 + S/3600
//   Hemisphere sign: -1 for 'S' or 'W', +1 for 'N' or 'E'.

'use strict';

const { parentPort, workerData } = require('worker_threads');
const ExifReader = require('exifreader');

/**
 * Convert a rational DMS array from ExifReader into a signed decimal degree.
 * @param {Array<{numerator:number, denominator:number}>} dmsArray
 * @param {string} ref  - Hemisphere reference char: 'N'|'S'|'E'|'W'
 * @returns {number|null}
 */
function rationalDmsToDecimal(dmsArray, ref) {
  if (!Array.isArray(dmsArray) || dmsArray.length < 3) return null;
  const [D, M, S] = dmsArray.map((r) => {
    const den = r.denominator || 1;
    return r.numerator / den;
  });
  if ([D, M, S].some((v) => !Number.isFinite(v))) return null;
  const decimal = D + M / 60 + S / 3600;
  const sign = (ref === 'S' || ref === 'W') ? -1 : 1;
  return sign * decimal;
}

try {
  // Reconstruct Buffer from the Uint8Array/SharedArrayBuffer transferred by the parent
  const buf = Buffer.from(workerData.buffer);

  let tags;
  try {
    tags = ExifReader.load(buf, { expanded: true });
  } catch {
    tags = null;
  }

  if (!tags) {
    parentPort.postMessage({ ok: true, lat: null, lng: null, reason: 'no_exif' });
    process.exit(0);
  }

  // Prefer the structured GPS IFD block first (ExifReader >= 4.x)
  const gps = tags.gps ?? tags['GPS'] ?? null;
  const rawTags = tags; // also check flat tag namespace for fallback

  let lat = null;
  let lng = null;

  if (gps && typeof gps.Latitude === 'number' && typeof gps.Longitude === 'number') {
    // ExifReader already decoded to decimal — fastest path
    lat = gps.Latitude;
    lng = gps.Longitude;
    // Apply hemisphere sign if needed (ExifReader usually already applies it)
    if (typeof gps.LatitudeRef === 'string' && gps.LatitudeRef === 'S' && lat > 0) lat = -lat;
    if (typeof gps.LongitudeRef === 'string' && gps.LongitudeRef === 'W' && lng > 0) lng = -lng;
  } else {
    // Fallback: parse rational DMS from flat tag namespace
    const latTag = rawTags['GPS GPSLatitude']  ?? rawTags.GPSLatitude  ?? null;
    const latRef = rawTags['GPS GPSLatitudeRef']  ?? rawTags.GPSLatitudeRef  ?? null;
    const lngTag = rawTags['GPS GPSLongitude'] ?? rawTags.GPSLongitude ?? null;
    const lngRef = rawTags['GPS GPSLongitudeRef'] ?? rawTags.GPSLongitudeRef ?? null;

    const latRefChar = latRef?.value?.[0] ?? latRef?.description ?? 'N';
    const lngRefChar = lngRef?.value?.[0] ?? lngRef?.description ?? 'E';

    if (latTag?.value) lat = rationalDmsToDecimal(latTag.value, latRefChar);
    if (lngTag?.value) lng = rationalDmsToDecimal(lngTag.value, lngRefChar);
  }

  parentPort.postMessage({ ok: true, lat, lng });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
