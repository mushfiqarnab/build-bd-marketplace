// services/exifFacts.js
// The only EXIF facts evidence verification needs, extracted from ExifReader's
// expanded tags. Shared by the worker thread (services/exifWorker.js) and the
// in-process fallback in services/evidenceService.js, so both paths agree and
// an image is parsed exactly once.
'use strict';

/**
 * ExifReader rational DMS ([{ numerator, denominator } x3]) → signed decimal
 * degrees, or null when malformed. 'S' / 'W' references are negative.
 */
function exifGpsToDecimal(degreeTag, refTag) {
  if (!degreeTag || !Array.isArray(degreeTag.value) || degreeTag.value.length < 3) return null;
  const [deg, min, sec] = degreeTag.value.map(
    (component) => component.numerator / (component.denominator || 1)
  );
  if (![deg, min, sec].every(Number.isFinite)) return null;
  const decimal = deg + min / 60 + sec / 3600;
  const ref = refTag?.value?.[0] ?? refTag?.description ?? '';
  return ref === 'S' || ref === 'W' ? -decimal : decimal;
}

/**
 * @param {object|null} tags  ExifReader.load(buffer, { expanded: true }) output
 * @returns {{ hasGps: boolean, lat: number|null, lng: number|null, dateTimeOriginal: string|null }}
 */
function extractExifFacts(tags) {
  if (!tags) return { hasGps: false, lat: null, lng: null, dateTimeOriginal: null };

  const gps = tags.gps ?? tags.GPS ?? null;
  let lat = null;
  let lng = null;
  if (gps && typeof gps.Latitude === 'number' && typeof gps.Longitude === 'number') {
    // ExifReader already decoded to signed decimal degrees.
    lat = gps.Latitude;
    lng = gps.Longitude;
  } else {
    lat = exifGpsToDecimal(tags['GPS GPSLatitude'] ?? tags.GPSLatitude, tags['GPS GPSLatitudeRef'] ?? tags.GPSLatitudeRef);
    lng = exifGpsToDecimal(tags['GPS GPSLongitude'] ?? tags.GPSLongitude, tags['GPS GPSLongitudeRef'] ?? tags.GPSLongitudeRef);
  }

  const exifIFD = tags.exif ?? tags['Exif IFD'] ?? null;
  const dtTag = exifIFD?.DateTimeOriginal ?? tags.DateTimeOriginal ?? null;
  const rawDt = dtTag?.description ?? dtTag?.value ?? null;

  return {
    hasGps: Boolean(gps) || lat !== null || lng !== null,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    dateTimeOriginal: rawDt === null ? null : String(rawDt)
  };
}

module.exports = { extractExifFacts, exifGpsToDecimal };
