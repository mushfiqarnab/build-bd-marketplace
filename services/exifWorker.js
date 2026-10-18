// services/exifWorker.js
// Phase 26 — Worker-thread EXIF forensics offloader
//
// Accepts image bytes via workerData.buffer, runs ExifReader.load() inside
// the worker thread so the main event loop is never blocked by TIFF/JPEG
// binary traversal, and posts back the facts verification needs (GPS and
// DateTimeOriginal — see services/exifFacts.js). The main thread does not
// parse the image again.

'use strict';

const { parentPort, workerData } = require('worker_threads');
const ExifReader = require('exifreader');
const { extractExifFacts } = require('./exifFacts');

try {
  // Reconstruct Buffer from the ArrayBuffer transferred by the parent.
  const buf = Buffer.from(workerData.buffer);

  let tags;
  try {
    tags = ExifReader.load(buf, { expanded: true });
  } catch {
    tags = null; // malformed EXIF or non-JPEG — not a hard failure
  }

  parentPort.postMessage({ ok: true, ...extractExifFacts(tags) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
