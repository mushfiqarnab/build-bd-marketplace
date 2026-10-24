// services/fraudDetectionService.js
// 🛡️ Multi-Vector Anti-Fraud Document & Credential Scanner for Build-BD
'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const ExifReader = require('exifreader');
const DocumentScan = require('../models/DocumentScan');

// Bangladesh bounding box with slight geographical buffer
const BD_BOUNDS = { minLat: 20.3, maxLat: 26.8, minLng: 87.9, maxLng: 92.8 };

// Editing software signatures that indicate manipulated evidence photos
const TAMPER_SOFTWARE_SIGNATURES = [
  'photoshop', 'canva', 'gimp', 'photopea', 'picsart', 'lightroom', 'coreldraw', 'illustrator', 'pixelmator'
];

/**
 * Computes deterministic SHA-256 hex hash of file buffer.
 */
function calculateFileHash(buffer) {
  if (!Buffer.isBuffer(buffer)) return '';
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Validates Bangladeshi National ID syntax and plausible birth year ranges.
 */
function validateBangladeshiNid(rawNid) {
  const nid = String(rawNid || '').trim();
  const errors = [];

  if (!nid) return { valid: false, errors: ['NID number is missing.'] };

  // Format: 10 digits (Smart NID), 13 digits (Old NID), or 17 digits (13-digit + 4-digit birth year prefix)
  const is10 = /^\d{10}$/.test(nid);
  const is13 = /^\d{13}$/.test(nid);
  const is17 = /^\d{17}$/.test(nid);

  if (!is10 && !is13 && !is17) {
    errors.push('NID must be 10, 13, or 17 numeric digits.');
    return { valid: false, errors };
  }

  // Reject uniform or simple sequences
  if (/^(\d)\1+$/.test(nid)) {
    errors.push('Synthetic or dummy NID pattern detected.');
    return { valid: false, errors };
  }
  if (nid === '1234567890' || nid === '0123456789') {
    errors.push('Sequential test NID pattern detected.');
    return { valid: false, errors };
  }

  // Birth year bounds for 17-digit NID
  if (is17) {
    const birthYear = parseInt(nid.slice(0, 4), 10);
    const currentYear = new Date().getFullYear();
    if (birthYear < 1940 || birthYear > (currentYear - 18)) {
      errors.push(`Invalid NID birth year prefix (${birthYear}). Must be between 1940 and ${currentYear - 18}.`);
      return { valid: false, errors };
    }
  }

  return { valid: true, errors: [] };
}

/**
 * Validates trade license number format.
 */
function validateTradeLicense(rawLicense) {
  const license = String(rawLicense || '').trim();
  if (!license || license.length < 5 || license.length > 35) {
    return { valid: false, errors: ['Trade license must be between 5 and 35 characters.'] };
  }
  if (/^(\w)\1+$/.test(license)) {
    return { valid: false, errors: ['Synthetic or dummy trade license pattern detected.'] };
  }
  return { valid: true, errors: [] };
}

/**
 * Extracts and inspects EXIF metadata from raw image buffer.
 */
function inspectImageExif(buffer) {
  const facts = {
    hasGps: false,
    lat: null,
    lng: null,
    capturedAt: null,
    cameraMake: null,
    cameraModel: null,
    software: null,
    isSoftwareManipulated: false,
    isGpsOutsideBangladesh: false,
    isFutureDated: false
  };

  try {
    const tags = ExifReader.load(buffer, { expanded: true });

    // 1. Software / Digital Manipulation Check
    const softwareTag = (tags.image && tags.image.Software && tags.image.Software.description) ||
                        (tags.xmp && tags.xmp.CreatorTool && tags.xmp.CreatorTool.description) || '';
    if (softwareTag) {
      facts.software = String(softwareTag).trim();
      const lower = facts.software.toLowerCase();
      if (TAMPER_SOFTWARE_SIGNATURES.some((sig) => lower.includes(sig))) {
        facts.isSoftwareManipulated = true;
      }
    }

    // 2. Camera hardware profile
    if (tags.image && tags.image.Make) facts.cameraMake = String(tags.image.Make.description || '').trim();
    if (tags.image && tags.image.Model) facts.cameraModel = String(tags.image.Model.description || '').trim();

    // 3. Date verification
    const dateStr = (tags.exif && tags.exif.DateTimeOriginal && tags.exif.DateTimeOriginal.description) ||
                    (tags.image && tags.image.DateTime && tags.image.DateTime.description);
    if (dateStr) {
      // Format "YYYY:MM:DD HH:MM:SS"
      const parts = String(dateStr).split(/[: ]/);
      if (parts.length >= 6) {
        const [y, m, d, h, min, s] = parts.map(Number);
        if (![y, m, d, h, min, s].some(isNaN)) {
          const parsed = new Date(y, m - 1, d, h, min, s);
          if (parsed.getTime() > (Date.now() + 60000)) {
            facts.isFutureDated = true;
          }
          facts.capturedAt = parsed;
        }
      }
    }

    // 4. GPS Geolocation bounds check
    if (tags.gps && tags.gps.Latitude && tags.gps.Longitude) {
      const lat = Number(tags.gps.Latitude);
      const lng = Number(tags.gps.Longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        facts.hasGps = true;
        facts.lat = lat;
        facts.lng = lng;
        if (lat < BD_BOUNDS.minLat || lat > BD_BOUNDS.maxLat || lng < BD_BOUNDS.minLng || lng > BD_BOUNDS.maxLng) {
          facts.isGpsOutsideBangladesh = true;
        }
      }
    }
  } catch (_) {
    // Non-JPEG or stripped metadata (common when photos pass through messaging apps)
  }

  // Binary string search fallback for digital editing signatures (header & trailer inspection)
  if (!facts.isSoftwareManipulated && Buffer.isBuffer(buffer)) {
    const headSearch = buffer.toString('utf8', 0, Math.min(buffer.length, 65536)).toLowerCase();
    const tailStart = Math.max(0, buffer.length - 16384);
    const tailSearch = buffer.toString('utf8', tailStart, buffer.length).toLowerCase();
    const rawString = headSearch + ' ' + tailSearch;
    for (const sig of TAMPER_SOFTWARE_SIGNATURES) {
      if (rawString.includes(sig)) {
        facts.software = sig;
        facts.isSoftwareManipulated = true;
        break;
      }
    }
  }

  return facts;
}

/**
 * Scans an uploaded credential/completion document across multiple fraud vectors.
 *
 * @param {Object} options
 * @param {Buffer} options.buffer Raw file buffer
 * @param {string} [options.fileName] Name of the file
 * @param {string} [options.mimeType] MIME content type
 * @param {string} options.userId Authenticated uploader ObjectId string
 * @param {string} options.documentCategory 'NID' | 'TRADE_LICENSE' | 'EXPERIENCE_CERTIFICATE' | 'WORK_COMPLETION_PHOTO'
 * @param {string} [options.declaredNumber] NID or Trade License number if applicable
 * @returns {Promise<{ fraudStatus, fraudRiskScore, fraudFlags, fileHash, exifData }>}
 */
async function scanDocument({
  buffer,
  fileName,
  mimeType,
  userId,
  documentCategory = 'OTHER',
  declaredNumber
}) {
  const fileHash = calculateFileHash(buffer);
  const fraudFlags = [];
  let fraudRiskScore = 100;

  // ── 1. Cross-Account File Collision (Stolen Document Check) ───────────────
  if (fileHash && userId && mongoose.connection?.readyState === 1) {
    const existingOther = await DocumentScan.findOne({
      fileHash,
      userId: { $ne: userId }
    }).select('userId fileName createdAt').lean();

    if (existingOther) {
      fraudFlags.push('DUPLICATE_DOCUMENT_REUSE_CROSS_ACCOUNT');
      fraudRiskScore = 0; // Immediate disqualification
    }
  }

  // ── 2. Category-Specific Syntax & Pattern Check ───────────────────────────
  if (documentCategory === 'NID' && declaredNumber) {
    const nidResult = validateBangladeshiNid(declaredNumber);
    if (!nidResult.valid) {
      fraudFlags.push(...nidResult.errors);
      fraudRiskScore = Math.min(fraudRiskScore, 20);
    }
  } else if (documentCategory === 'TRADE_LICENSE' && declaredNumber) {
    const licenseResult = validateTradeLicense(declaredNumber);
    if (!licenseResult.valid) {
      fraudFlags.push(...licenseResult.errors);
      fraudRiskScore = Math.min(fraudRiskScore, 30);
    }
  }

  // ── 3. Forensic EXIF & Geolocation Analysis (for image uploads) ───────────
  let exifFacts = { hasGps: false, lat: null, lng: null, capturedAt: null, cameraMake: null, cameraModel: null, software: null };

  if (buffer && (!mimeType || mimeType.startsWith('image/'))) {
    const inspected = inspectImageExif(buffer);
    exifFacts = inspected;

    if (inspected.isSoftwareManipulated) {
      fraudFlags.push(`DIGITAL_MANIPULATION_DETECTED: Created or edited using ${inspected.software}`);
      fraudRiskScore -= 40;
    }
    if (inspected.isGpsOutsideBangladesh) {
      fraudFlags.push(`GEOLOCATION_FRAUD: GPS coordinates (${inspected.lat.toFixed(4)}, ${inspected.lng.toFixed(4)}) reside outside Bangladesh.`);
      fraudRiskScore = 0; // Immediate disqualification
    }
    if (inspected.isFutureDated) {
      fraudFlags.push('TEMPORAL_ANOMALY: Photo timestamp postdates current server time (future-dated).');
      fraudRiskScore = 0; // Immediate disqualification
    }
  }

  // ── 4. Final Status Evaluation ─────────────────────────────────────────────
  fraudRiskScore = Math.max(0, Math.min(100, fraudRiskScore));

  let fraudStatus = 'CLEARED';
  if (fraudRiskScore < 50) {
    fraudStatus = 'REJECTED';
  } else if (fraudRiskScore < 80) {
    fraudStatus = 'SUSPICIOUS';
  }

  // ── 5. Record to Anti-Fraud Audit Ledger ───────────────────────────────────
  if (fileHash && userId && mongoose.connection?.readyState === 1) {
    await DocumentScan.create({
      userId,
      fileHash,
      fileName: fileName ? String(fileName).slice(0, 120) : undefined,
      mimeType: mimeType ? String(mimeType).slice(0, 50) : undefined,
      documentCategory,
      declaredNumber: declaredNumber ? String(declaredNumber).slice(0, 50) : undefined,
      fraudStatus,
      fraudRiskScore,
      fraudFlags,
      exifData: {
        hasGps: exifFacts.hasGps,
        lat: exifFacts.lat,
        lng: exifFacts.lng,
        capturedAt: exifFacts.capturedAt,
        cameraMake: exifFacts.cameraMake,
        cameraModel: exifFacts.cameraModel,
        software: exifFacts.software
      }
    }).catch((err) => console.warn('DocumentScan audit log warning:', err.message));
  }

  return {
    fileHash,
    fraudStatus,
    fraudRiskScore,
    fraudFlags,
    exifData: exifFacts
  };
}

module.exports = {
  calculateFileHash,
  validateBangladeshiNid,
  validateTradeLicense,
  inspectImageExif,
  scanDocument
};
