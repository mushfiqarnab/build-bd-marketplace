// routes/localStorage.js
// Upload endpoint for STORAGE_PROVIDER=local. Mounted at /__storage, invoked only when
// the local adapter is active. The token in the URL is a short-lived HMAC-signed claim
// (key, contentType, maxBytes, expiry) produced by services/s3Service.js at policy time.
'use strict';

const express = require('express');
const {
  resolveLocalConfig,
  verifyUploadToken,
  writeStreamToDisk
} = require('../services/localStorageAdapter');

const router = express.Router();

router.put('/upload/:token', (req, res) => {
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

module.exports = router;
