// routes/localStorage.js
// Upload endpoint for STORAGE_PROVIDER=local. Mounted at /__storage, invoked only when
// the local adapter is active. The token in the URL is a short-lived HMAC-signed claim
// (key, contentType, maxBytes, expiry) produced by services/s3Service.js at policy time.
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  resolveLocalConfig,
  verifyUploadToken,
  writeStreamToDisk
} = require('../services/localStorageAdapter');

const router = express.Router();

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === 'test' || req.ip === '127.0.0.1' || req.ip === '::1',
  message: { status: 'error', message: 'Upload rate limit exceeded. Maximum 60 uploads per minute.' }
});

router.put('/upload/:token', uploadLimiter, (req, res) => {
  const config = resolveLocalConfig(process.env);
  if (config.errors.length) {
    return res.status(500).json({ status: 'error', message: 'Local storage is not configured on this server.' });
  }

  let claim;
  try { claim = verifyUploadToken(config, req.params.token); }
  catch (err) { return res.status(err.statusCode || 400).json({ status: 'error', message: err.message }); }

  const headerCt = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (headerCt !== claim.contentType.toLowerCase()) {
    return res.status(415).json({
      status: 'error',
      message: `Content-Type must be '${claim.contentType}', got '${headerCt || '(none)'}'.`
    });
  }

  writeStreamToDisk(config, claim, req).then((result) => {
    if (result.ok) {
      res.status(200).json({ status: 'success', data: { key: claim.key, size: result.size } });
    } else if (!res.headersSent) {
      res.status(result.statusCode || 500).json({ status: 'error', message: result.reason || 'Upload failed.' });
    }
  }).catch(() => {
    if (!res.headersSent) res.status(500).json({ status: 'error', message: 'Upload failed.' });
  });
});

// GET /__storage/view/{*key} — serves stored local files with strict path-traversal protection
router.get('/view/{*key}', (req, res) => {
  try {
    const rawParam = req.params.key;
    const rawKey = decodeURIComponent(Array.isArray(rawParam) ? rawParam.join('/') : (rawParam || ''));
    if (!rawKey || rawKey.includes('..') || rawKey.startsWith('/')) {
      return res.status(400).json({ error: 'Invalid storage key.' });
    }
    const baseDir = path.resolve(process.env.STORAGE_LOCAL_DIR || '.storage');
    const fullPath = path.resolve(baseDir, rawKey);
    if (!fullPath.startsWith(baseDir + path.sep)) {
      return res.status(403).json({ error: 'Forbidden path traversal.' });
    }
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Stored object not found.' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.sendFile(fullPath);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read stored object.' });
  }
});

module.exports = router;
