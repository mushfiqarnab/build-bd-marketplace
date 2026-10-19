// services/localStorageAdapter.js
// 💾 Local-disk storage backend — serves Build-BD's beta on the user's own machine
// (behind ngrok or a reverse proxy) with no cloud account required.
//
// The "signed URL" is an HMAC-SHA256 token: { k:key, c:contentType, m:maxBytes, e:expiry }.
// Routes/localStorage.js verifies the token on PUT and streams the body to disk with a
// hard byte cap. A sidecar <key>.meta.json records the Content-Type so inspectObject can
// answer the same shape as the S3 adapter.
//
// Environment:
//   STORAGE_LOCAL_DIR          directory root (default ./.storage, created on first write)
//   STORAGE_LOCAL_PUBLIC_URL   public origin that resolves to this server
//                              (default http://localhost:${PORT||5000})
//   STORAGE_LOCAL_SECRET       HMAC signing key (falls back to JWT_SECRET)
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const SAFE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9/_.\-]{0,255}$/;

function operationalError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode, isOperational: true });
}

/** Blocks traversal (../), absolute paths, and empty keys. */
function assertSafeKey(key) {
  if (typeof key !== 'string' || !SAFE_KEY_RE.test(key) || key.includes('..') || key.includes('//')) {
    throw operationalError('Invalid storage key.', 400);
  }
}

/** Pure: reads env and returns { dir, publicUrl, secret, errors }. Never throws. */
function resolveLocalConfig(env = process.env) {
  const dir = path.resolve(process.cwd(), (env.STORAGE_LOCAL_DIR || '.storage').trim());
  const rawPublic = (env.STORAGE_LOCAL_PUBLIC_URL || `http://localhost:${env.PORT || 5000}`).trim().replace(/\/+$/, '');
  const secret = (env.STORAGE_LOCAL_SECRET || env.JWT_SECRET || '').trim();
  const errors = [];
  if (!secret) errors.push('Local storage needs STORAGE_LOCAL_SECRET (or JWT_SECRET) to sign upload tokens.');
  try { new URL(rawPublic); } catch (_) { errors.push('STORAGE_LOCAL_PUBLIC_URL is not a valid URL.'); }
  return { dir, publicUrl: rawPublic, secret, errors };
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str) {
  const pad = str.length % 4 === 2 ? '==' : str.length % 4 === 3 ? '=' : '';
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** Signs an upload intent. Encodes key, contentType, maxBytes, expiry (unix seconds). */
function signUploadToken(config, { key, contentType, maxBytes, expiresInSeconds }) {
  assertSafeKey(key);
  if (typeof contentType !== 'string' || !contentType.length) throw operationalError('contentType is required.', 400);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw operationalError('maxBytes must be a positive integer.', 400);
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1) throw operationalError('expiresInSeconds must be a positive integer.', 400);
  const payload = { k: key, c: contentType, m: maxBytes, e: Math.floor(Date.now() / 1000) + expiresInSeconds };
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = base64url(crypto.createHmac('sha256', config.secret).update(body).digest());
  return `${body}.${sig}`;
}

/** Verifies an upload token. Throws with isOperational on tamper, expiry, or malformed input. */
function verifyUploadToken(config, token) {
  if (typeof token !== 'string' || !token.includes('.')) throw operationalError('Invalid upload token.', 400);
  const [body, sig] = token.split('.');
  const expected = base64url(crypto.createHmac('sha256', config.secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw operationalError('Upload token signature mismatch.', 401);
  let payload;
  try { payload = JSON.parse(fromBase64url(body).toString('utf8')); } catch (_) { throw operationalError('Upload token payload corrupt.', 400); }
  if (!payload || typeof payload !== 'object') throw operationalError('Upload token payload corrupt.', 400);
  if (!Number.isInteger(payload.e) || payload.e < Math.floor(Date.now() / 1000)) throw operationalError('Upload token expired. Request a new upload URL.', 410);
  assertSafeKey(payload.k);
  if (typeof payload.c !== 'string' || !payload.c.length) throw operationalError('Upload token contentType missing.', 400);
  if (!Number.isInteger(payload.m) || payload.m < 1) throw operationalError('Upload token maxBytes invalid.', 400);
  return { key: payload.k, contentType: payload.c, maxBytes: payload.m, expiresAt: payload.e };
}

/** Returns { exists, size, contentType, checksumSha256 } for an object on disk. Never throws. */
async function statObject(config, key) {
  try {
    assertSafeKey(key);
  } catch (_) {
    return { exists: false, size: null, contentType: null, checksumSha256: null, reason: 'invalid key' };
  }
  try {
    const st = await fsp.stat(path.join(config.dir, key));
    if (!st.isFile()) return { exists: false, size: null, contentType: null, checksumSha256: null, reason: 'not a file' };
    let contentType = null;
    let checksumSha256 = null;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(config.dir, key + '.meta.json'), 'utf8'));
      if (meta && typeof meta.contentType === 'string') contentType = meta.contentType;
      if (meta && typeof meta.checksumSha256 === 'string') checksumSha256 = meta.checksumSha256;
    } catch (_) { /* sidecar missing: fall through with contentType=null, checksumSha256=null */ }
    return { exists: true, size: st.size, contentType, checksumSha256 };
  } catch (_) {
    return { exists: false, size: null, contentType: null, checksumSha256: null, reason: 'not found' };
  }
}

/** Removes an object (and its sidecar). Returns true if the file is gone afterwards. */
async function deleteObject(config, key) {
  try { assertSafeKey(key); } catch (_) { return false; }
  const file = path.join(config.dir, key);
  const meta = path.join(config.dir, key + '.meta.json');
  let ok = true;
  try { await fsp.unlink(file); }
  catch (err) { if (err.code !== 'ENOENT') ok = false; }
  try { await fsp.unlink(meta); } catch (_) { /* sidecar optional */ }
  return ok;
}

/**
 * Streams an incoming request body to disk under <config.dir>/<claim.key>, enforcing
 * claim.maxBytes. Calculates SHA-256 checksum in-flight (O(1) RAM). Writes a sidecar
 * with the signed Content-Type and checksumSha256. Caller handles the HTTP response.
 * Resolves with { ok, size, checksumSha256 } or { ok:false, statusCode, reason }.
 */
function writeStreamToDisk(config, claim, readable) {
  return new Promise((resolve) => {
    const target = path.join(config.dir, claim.key);
    const temp = target + '.part';
    let aborted = false;
    let written = 0;
    let idleTimer = null;
    let out = null;
    const hasher = crypto.createHash('sha256');

    const abort = (statusCode, reason) => {
      if (aborted) return;
      aborted = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (out) { try { out.destroy(); } catch (_) {} }
      try { readable.destroy(); } catch (_) {}
      fsp.unlink(temp).catch(() => {});
      resolve({ ok: false, statusCode, reason });
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abort(408, 'Upload timed out: stream idle for 20 seconds.');
      }, 20000);
    };

    fsp.mkdir(path.dirname(target), { recursive: true })
      .then(() => {
        out = fs.createWriteStream(temp);
        resetIdleTimer();

        readable.on('data', (chunk) => {
          if (aborted) return;
          resetIdleTimer();
          written += chunk.length;
          if (written > claim.maxBytes) abort(413, `Upload exceeds the ${claim.maxBytes}-byte limit.`);
          else hasher.update(chunk);
        });
        readable.on('error', () => abort(500, 'Upload stream error.'));
        readable.pipe(out);
        out.on('error', () => abort(500, 'Disk write error.'));
        out.on('finish', async () => {
          if (aborted) return;
          if (idleTimer) clearTimeout(idleTimer);
          if (written < 1) {
            await fsp.unlink(temp).catch(() => {});
            return resolve({ ok: false, statusCode: 400, reason: 'Empty upload.' });
          }
          try {
            const checksumSha256 = hasher.digest('hex');
            await fsp.rename(temp, target);
            await fsp.writeFile(target + '.meta.json', JSON.stringify({
              contentType: claim.contentType,
              size: written,
              checksumSha256,
              uploadedAt: new Date().toISOString()
            }));
            resolve({ ok: true, size: written, checksumSha256 });
          } catch (_) {
            await fsp.unlink(temp).catch(() => {});
            resolve({ ok: false, statusCode: 500, reason: 'Failed to finalize upload.' });
          }
        });
      })
      .catch(() => resolve({ ok: false, statusCode: 500, reason: 'Failed to prepare storage directory.' }));
  });
}

function uploadUrl(config, token) {
  return `${config.publicUrl}/__storage/upload/${token}`;
}

module.exports = {
  resolveLocalConfig,
  signUploadToken,
  verifyUploadToken,
  statObject,
  deleteObject,
  writeStreamToDisk,
  uploadUrl,
  assertSafeKey
};
