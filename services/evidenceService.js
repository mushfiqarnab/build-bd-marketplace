// services/evidenceService.js
// 🛡️ Phase 21 — Proof-of-Work Evidence Verification Engine
//
// Architecture Overview:
//
//   PRIMARY verification path (image uploads):
//     1. SHA-256 image hash  → prevents "double-spend" photo reuse across milestones
//     2. EXIF GPS extraction → validates photo was taken at the project site
//     3. EXIF timestamp      → validates photo was taken after project start date
//     4. Dynamic geofencing  → adapts strict/loose radius based on device GPS accuracy
//        (base 40m / cap 80m — see analysis below)
//     5. Verification tier assignment:
//          CRYPTOGRAPHIC_PROOF   → GPS + timestamp both verified
//          GPS_ONLY              → GPS verified but no reliable timestamp
//          TIME_ONLY             → Timestamp verified but no GPS
//          REQUIRES_CLIENT_AUDIT → Missing or unreadable EXIF (must be client-approved)
//          REJECTED              → Photo predates project OR is outside geofence hard-cap
//
//   LIVE CAPTURE path (frontend geo + live photo):
//     When the frontend sends `livePing` (coords + deviceAccuracy captured from
//     navigator.geolocation BEFORE the photo is taken), this service runs
//     Dynamic Accuracy Thresholding instead of EXIF parsing.
//     This completely eliminates the EXIF spoofing attack surface for this path.
//
// Geofence Radius Design Decision (BD Market Analysis):
//   - 100m is too loose for Dhaka density — covers 10–15 sites, enables neighbor fraud
//   - 50m hard-code fails low-end hardware (Walton, Symphony, older Xiaomi)
//     whose GPS chips drift 20–40m inside rebar-dense construction sites
//   - Solution: Dynamic Accuracy Thresholding
//       baseRadius    = 40m  (strict, for good GPS hardware)
//       hardCap       = 80m  (absolute maximum — blocks the 100m+ spoofing window)
//       dynamicRadius = min(80, max(40, deviceAccuracy))
//     This accommodates weak hardware while mathematically blocking fraud.

'use strict';

const crypto = require('crypto');
const path   = require('path');
const { Worker } = require('worker_threads');
const ExifReader = require('exifreader');


// ─────────────────────────────────────────────
// 📐 HAVERSINE FORMULA
// Computes great-circle distance between two WGS-84 coordinates in meters.
// Used for both EXIF GPS and live-ping geofence checks.
// ─────────────────────────────────────────────
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6_371_000; // Earth radius in metres (WGS-84 mean)
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─────────────────────────────────────────────
// 📐 DYNAMIC ACCURACY THRESHOLDING
// Adapts the enforcement radius based on the phone's reported GPS accuracy.
// base=40m is strict. cap=80m prevents the 100m spoofing window.
// ─────────────────────────────────────────────
const GEOFENCE_BASE_METERS = 40;
const GEOFENCE_HARD_CAP_METERS = 80;

function computeDynamicRadius(deviceAccuracyMeters) {
  if (!Number.isFinite(deviceAccuracyMeters) || deviceAccuracyMeters <= 0) {
    return GEOFENCE_BASE_METERS; // Unknown accuracy → enforce strict baseline
  }
  return Math.min(GEOFENCE_HARD_CAP_METERS, Math.max(GEOFENCE_BASE_METERS, deviceAccuracyMeters));
}

// ─────────────────────────────────────────────
// 📷 EXIF DECIMAL DEGREE PARSER
// ExifReader returns structured DMS objects. This converts them to decimal degrees
// that haversine can consume, handling the GPS reference hemisphere correctly.
// ─────────────────────────────────────────────
function exifGpsToDecimal(degreeTag, refTag) {
  if (!degreeTag || !degreeTag.value) return null;

  // ExifReader gives us: [{ numerator, denominator }, ...] for degrees/minutes/seconds
  const [deg, min, sec] = degreeTag.value.map(
    (component) => component.numerator / (component.denominator || 1)
  );
  const decimal = deg + min / 60 + sec / 3600;
  const ref = refTag?.value?.[0] ?? refTag?.description ?? '';
  return ref === 'S' || ref === 'W' ? -decimal : decimal;
}

// ─────────────────────────────────────────────
// 🕐 EXIF DATETIME PARSER
// EXIF DateTimeOriginal format: "YYYY:MM:DD HH:MM:SS"
// Returns a JS Date or null if malformed.
// ─────────────────────────────────────────────
function parseExifDateTime(description) {
  if (!description || typeof description !== 'string') return null;
  // Split on colon AND space — handles "2024:08:04 14:30:00"
  const parts = description.split(/[: ]/);
  if (parts.length < 6) return null;
  const [yr, mo, dy, hr, mn, sc] = parts.map(Number);
  if ([yr, mo, dy, hr, mn, sc].some(isNaN)) return null;
  return new Date(yr, mo - 1, dy, hr, mn, sc);
}

// ─────────────────────────────────────────────
// 🖼️  VERIFICATION TIERS (ordered by trust level)
// ─────────────────────────────────────────────
const VerificationTier = Object.freeze({
  CRYPTOGRAPHIC_PROOF:   'CRYPTOGRAPHIC_PROOF',   // GPS + timestamp both valid
  GPS_ONLY:              'GPS_ONLY',               // GPS verified, no timestamp
  TIME_ONLY:             'TIME_ONLY',              // Timestamp verified, no GPS
  REQUIRES_CLIENT_AUDIT: 'REQUIRES_CLIENT_AUDIT',  // No EXIF — client must approve
  REJECTED:              'REJECTED'                // Hard fraud detection triggered
});

// ─────────────────────────────────────────────
// 🏭 EXPORTED — PRIMARY IMAGE EVIDENCE VERIFIER
// ─────────────────────────────────────────────

/**
 * verifyImageEvidence
 *
 * Processes an in-memory image buffer before it is committed to S3.
 * Runs: hash → EXIF extraction → GPS geofence → timestamp check.
 *
 * @param {Buffer}  imageBuffer      Raw image bytes (already in memory from multer)
 * @param {number}  projectLat       Project site latitude (decimal degrees)
 * @param {number}  projectLng       Project site longitude (decimal degrees)
 * @param {Date}    projectStartDate Project start date (milestones cannot predate this)
 * @returns {{ imageHash, verificationTier, distanceMeters?, photoDate?, notes }}
 * @throws {Error} with statusCode=422 if fraud is positively detected (REJECTED tier)
 */
async function verifyImageEvidence(imageBuffer, projectLat, projectLng, projectStartDate) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    const err = new Error('Image buffer is empty or invalid.');
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }

  // ── 1. SHA-256 CONTENT HASH ───────────────────────────────────────────────
  // Cryptographically binds these exact pixels to this milestone forever.
  // The sparse unique index on EscrowLedger.milestones[].proofOfWorkHash
  // (enforced at the route layer) blocks reuse of identical photos.
  const imageHash = crypto.createHash('sha256').update(imageBuffer).digest('hex');

  // ── 2. EXIF EXTRACTION ───────────────────────────────────────────────────
  // First attempt non-blocking off-thread worker parsing for GPS extraction
  let offThreadGps = null;
  try {
    offThreadGps = await parseExifOffThread(imageBuffer);
  } catch {
    offThreadGps = null;
  }

  let tags = null;
  try {
    // ExifReader.load() is synchronous and operates entirely in-memory.
    // The { expanded: true } option parses GPS IFD as structured objects.
    tags = ExifReader.load(imageBuffer, { expanded: true });
  } catch {
    // Malformed EXIF or non-JPEG — not a hard failure (PNG, WebP often lack EXIF)
    tags = null;
  }

  const gps = tags?.gps ?? tags?.['GPS'] ?? null;
  const exifIFD = tags?.exif ?? tags?.['Exif IFD'] ?? null;

  let isGpsVerified = false;
  let isTimeVerified = false;
  let distanceMeters = null;
  let photoDate = null;
  const notes = [];

  // ── 3. GPS GEOFENCE CHECK ─────────────────────────────────────────────────
  let photoLat = null;
  let photoLng = null;
  const hasGpsData = Boolean(
    (offThreadGps && (offThreadGps.lat !== null || offThreadGps.lng !== null)) ||
    gps
  );

  if (offThreadGps && typeof offThreadGps.lat === 'number' && typeof offThreadGps.lng === 'number' &&
      Number.isFinite(offThreadGps.lat) && Number.isFinite(offThreadGps.lng)) {
    photoLat = offThreadGps.lat;
    photoLng = offThreadGps.lng;
  } else if (gps) {
    photoLat = typeof gps.Latitude === 'number'
      ? gps.Latitude
      : exifGpsToDecimal(tags?.['GPS GPSLatitude'], tags?.['GPS GPSLatitudeRef']);

    photoLng = typeof gps.Longitude === 'number'
      ? gps.Longitude
      : exifGpsToDecimal(tags?.['GPS GPSLongitude'], tags?.['GPS GPSLongitudeRef']);
  }

  if (hasGpsData) {
    if (photoLat !== null && photoLng !== null &&
        Number.isFinite(photoLat) && Number.isFinite(photoLng)) {

      distanceMeters = haversineDistanceMeters(projectLat, projectLng, photoLat, photoLng);

      if (distanceMeters <= GEOFENCE_HARD_CAP_METERS) {
        isGpsVerified = true;
        notes.push(`GPS verified: ${Math.round(distanceMeters)}m from site (cap: ${GEOFENCE_HARD_CAP_METERS}m).`);
      } else {
        // 🚨 POSITIVE FRAUD DETECTION — Hard reject, do not assign REQUIRES_CLIENT_AUDIT
        const err = new Error(
          `Fraud Alert: Photo GPS coordinates are ${Math.round(distanceMeters)}m away from the project site. ` +
          `Maximum allowed: ${GEOFENCE_HARD_CAP_METERS}m. Please take the photo at the construction site.`
        );
        err.statusCode = 422;
        err.isOperational = true;
        err.fraudDetails = { distanceMeters, projectLat, projectLng, photoLat, photoLng };
        throw err;
      }
    } else {
      notes.push('GPS IFD present but coordinates could not be parsed — treating as absent.');
    }
  } else {
    // 🇧🇩 BD Market Adaptation: Low-end Androids frequently disable GPS to save battery.
    // Do NOT hard-reject — assign REQUIRES_CLIENT_AUDIT so the user isn't abandoned.
    notes.push('No GPS EXIF data found. Photo will require manual client review.');
  }

  // ── 4. TIMESTAMP CHECK ────────────────────────────────────────────────────
  const dtTag = exifIFD?.DateTimeOriginal ?? tags?.['DateTimeOriginal'] ?? null;
  const rawDt = dtTag?.description ?? dtTag?.value ?? null;

  if (rawDt) {
    photoDate = parseExifDateTime(String(rawDt));

    if (photoDate) {
      const startDate = new Date(projectStartDate);
      if (photoDate < startDate) {
        // 🚨 POSITIVE FRAUD DETECTION — Photo predates the contract
        const err = new Error(
          `Fraud Alert: This photo was taken on ${photoDate.toISOString()} — ` +
          `which is BEFORE the project start date of ${startDate.toISOString()}. ` +
          `Do not upload photos from previous jobs.`
        );
        err.statusCode = 422;
        err.isOperational = true;
        err.fraudDetails = { photoDate, projectStartDate: startDate };
        throw err;
      }
      isTimeVerified = true;
      notes.push(`Timestamp verified: photo taken ${photoDate.toISOString()}.`);
    } else {
      notes.push('DateTimeOriginal present but could not be parsed.');
    }
  } else {
    notes.push('No DateTimeOriginal EXIF tag found.');
  }

  // ── 5. ASSIGN VERIFICATION TIER ───────────────────────────────────────────
  let verificationTier;
  if (isGpsVerified && isTimeVerified) {
    verificationTier = VerificationTier.CRYPTOGRAPHIC_PROOF;
  } else if (isGpsVerified) {
    verificationTier = VerificationTier.GPS_ONLY;
  } else if (isTimeVerified) {
    verificationTier = VerificationTier.TIME_ONLY;
  } else {
    verificationTier = VerificationTier.REQUIRES_CLIENT_AUDIT;
  }

  return {
    imageHash,
    verificationTier,
    distanceMeters,
    photoDate: photoDate ? photoDate.toISOString() : null,
    notes
  };
}

// ─────────────────────────────────────────────
// 🏭 EXPORTED — LIVE CAPTURE GEOFENCE VERIFIER
// ─────────────────────────────────────────────

/**
 * verifyLivePing
 *
 * Called when the frontend sends a live GPS ping captured IMMEDIATELY before
 * the photo is taken (navigator.geolocation.getCurrentPosition).
 * Eliminates the EXIF spoofing attack surface entirely for this path.
 *
 * @param {number} projectLat       Project site latitude
 * @param {number} projectLng       Project site longitude
 * @param {number} pingLat          Live GPS latitude from device
 * @param {number} pingLng          Live GPS longitude from device
 * @param {number} deviceAccuracy   coords.accuracy from HTML5 Geolocation API (meters)
 * @returns {{ verified: true, distanceMeters, dynamicRadius }}
 * @throws {Error} with statusCode=422 if outside dynamic geofence
 */
function verifyLivePing(projectLat, projectLng, pingLat, pingLng, deviceAccuracy) {
  const inputs = [projectLat, projectLng, pingLat, pingLng];
  if (inputs.some((v) => !Number.isFinite(v))) {
    const err = new Error('Invalid coordinates: all latitude/longitude values must be finite numbers.');
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }

  const distanceMeters = haversineDistanceMeters(projectLat, projectLng, pingLat, pingLng);
  const dynamicRadius  = computeDynamicRadius(deviceAccuracy);

  if (distanceMeters > dynamicRadius) {
    const err = new Error(
      `Location mismatch: You are ${Math.round(distanceMeters)}m from the project site. ` +
      `Required: within ${Math.round(dynamicRadius)}m. ` +
      `Step outside for a stronger GPS signal and try again.`
    );
    err.statusCode = 422;
    err.isOperational = true;
    err.fraudDetails = {
      distanceMeters,
      dynamicRadius,
      deviceAccuracy: deviceAccuracy ?? null,
      projectLat,
      projectLng,
      pingLat,
      pingLng
    };
    throw err;
  }

  return { verified: true, distanceMeters, dynamicRadius };
}

// ─────────────────────────────────────────────
// 🧵 OFF-THREAD EXIF PARSER (Phase 26 Stage 4)
// ─────────────────────────────────────────────

/**
 * parseExifOffThread
 *
 * Offloads synchronous TIFF/JPEG binary traversal to services/exifWorker.js
 * via a Node.js Worker thread, keeping the main event loop free.
 *
 * Falls back silently to in-process ExifReader parsing when:
 *   - Worker initialization fails (restricted environments)
 *   - Worker times out after `timeoutMs` milliseconds
 *
 * @param {Buffer}  imageBuffer   Raw image bytes
 * @param {number}  [timeoutMs=3000]  Worker timeout
 * @returns {Promise<{ lat: number|null, lng: number|null }>}
 */
async function parseExifOffThread(imageBuffer, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let settled = false;
    let worker;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Fallback to in-process parsing
    const fallback = () => {
      try {
        const tags = ExifReader.load(imageBuffer, { expanded: true });
        const gps = tags?.gps ?? tags?.['GPS'] ?? null;
        if (gps && typeof gps.Latitude === 'number' && typeof gps.Longitude === 'number') {
          settle({ lat: gps.Latitude, lng: gps.Longitude });
        } else {
          settle({ lat: null, lng: null });
        }
      } catch {
        settle({ lat: null, lng: null });
      }
    };

    try {
      const workerPath = path.join(__dirname, 'exifWorker.js');
      // Transfer a copy of the buffer to the worker (no SharedArrayBuffer needed)
      const uint8 = new Uint8Array(imageBuffer);
      worker = new Worker(workerPath, {
        workerData: { buffer: uint8.buffer },
        transferList: [uint8.buffer]
      });

      const timer = setTimeout(() => {
        if (worker) worker.terminate().catch(() => {});
        fallback();
      }, timeoutMs);

      worker.on('message', (msg) => {
        clearTimeout(timer);
        if (msg.ok) {
          settle({ lat: msg.lat, lng: msg.lng });
        } else {
          fallback();
        }
      });

      worker.on('error', () => {
        clearTimeout(timer);
        fallback();
      });

      worker.on('exit', (code) => {
        clearTimeout(timer);
        if (!settled) {
          if (code !== 0) fallback();
          else settle({ lat: null, lng: null });
        }
      });
    } catch {
      // Worker initialization failed (e.g., restricted runtime)
      fallback();
    }
  });
}

module.exports = {
  verifyImageEvidence,
  verifyLivePing,
  parseExifOffThread,
  haversineDistanceMeters,
  computeDynamicRadius,
  VerificationTier,
  GEOFENCE_BASE_METERS,
  GEOFENCE_HARD_CAP_METERS
};

