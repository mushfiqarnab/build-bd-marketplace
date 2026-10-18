// services/s3Service.js
// ☁️ Object storage adapter: AWS S3, Cloudflare R2, any S3-compatible store, a local-disk
//    backend for the beta tier, or a mock for development / CI.
//
// For cloud providers the Node.js process never touches file bytes: it only signs
// short-lived upload URLs and checks the uploaded object afterwards (HeadObject).
// The `local` provider stores files on this server's own disk under STORAGE_LOCAL_DIR;
// the signed URL points back at this server's /__storage/upload/<token> endpoint.
// One code path serves every provider:
//
//   provider        upload method              size limit enforced by
//   aws             presigned POST (form)      S3 policy content-length-range
//   r2              presigned PUT              signed Content-Length (when the client
//                                              declares it) + HeadObject check after upload
//   s3-compatible   presigned PUT (or POST     same as r2 (or as aws with POST)
//                   with S3_UPLOAD_METHOD)
//   local           PUT to this server         byte counter in writeStreamToDisk aborts
//                                              above maxBytes and deletes the partial file
//   mock            fake URLs, no network      nothing (local development and CI only)
//
// Why not presigned POST everywhere: Cloudflare R2 does not support POST form uploads, and
// it rejects the x-amz-server-side-encryption header (R2 always encrypts at rest; AWS has
// encrypted every new object by default since January 2023).
//
// Every PUT URL signs Content-Type (and Content-Length when declared), so the upload must
// send exactly the headers returned in `headers`, or the store answers 403.
//
// Environment (new names first, the old AWS_* names still work):
//   STORAGE_PROVIDER      aws | r2 | s3-compatible | local | mock   (optional; derived when absent)
//   S3_BUCKET             or AWS_S3_BUCKET_NAME
//   S3_ACCESS_KEY_ID      or AWS_ACCESS_KEY_ID
//   S3_SECRET_ACCESS_KEY  or AWS_SECRET_ACCESS_KEY
//   S3_REGION             or AWS_REGION (default ap-south-1; R2 always uses 'auto')
//   S3_ENDPOINT           required for r2 and s3-compatible,
//                         e.g. https://<ACCOUNT_ID>.r2.cloudflarestorage.com
//   S3_FORCE_PATH_STYLE   true to use https://endpoint/bucket/key (default true for s3-compatible)
//   S3_UPLOAD_METHOD      post | put (optional override; r2 must be put)
//   S3_UPLOAD_MODE=mock   legacy switch, same as STORAGE_PROVIDER=mock
//   ALLOW_MOCK_STORAGE    true to allow the mock in production (never do this for real users)
//   STORAGE_LOCAL_DIR         local provider: root directory (default ./.storage)
//   STORAGE_LOCAL_PUBLIC_URL  local provider: public origin that reaches this server
//   STORAGE_LOCAL_SECRET      local provider: HMAC key (falls back to JWT_SECRET)
//
// Fail-closed rule: in production (NODE_ENV=production) the mock is refused. Upload URLs are
// answered with 503 and every uploaded-file check says "not found". Without this, the mock's
// "file exists" answer would let anyone submit proof photos or payment receipts that were
// never uploaded.
'use strict';

const { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
const crypto = require('crypto');
const localAdapter = require('./localStorageAdapter');

const PROVIDERS = new Set(['aws', 'r2', 's3-compatible', 'local', 'mock']);
const UPLOAD_METHODS = new Set(['post', 'put']);

// 🛡️ M-1 AUDIT FIX: MIME allowlists enforced at the service boundary.
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // legacy proof upload (PUT) limit, 25 MB
const EVIDENCE_ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_EVIDENCE_SIZE_BYTES = 10 * 1024 * 1024; // evidence and receipt photos, 10 MB
const UPLOAD_EXPIRES_SECONDS = 900; // 15 minutes, matches the s3KeyToken / proofToken lifetime

function operationalError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode, isOperational: true });
}

function hostOf(endpoint) {
  try { return new URL(endpoint).hostname.toLowerCase(); } catch (_) { return ''; }
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * Pure function: reads an environment object and returns the storage configuration.
 * Never throws; problems are listed in `errors` (createStorage throws on them).
 */
function resolveStorageConfig(env = process.env) {
  const bucket = (env.S3_BUCKET || env.AWS_S3_BUCKET_NAME || '').trim();
  const accessKeyId = (env.S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (env.S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || '').trim();
  const endpoint = (env.S3_ENDPOINT || '').trim().replace(/\/+$/, '');
  const hasCredentials = Boolean(bucket && accessKeyId && secretAccessKey);
  const isProduction = env.NODE_ENV === 'production';
  const errors = [];

  let provider = (env.STORAGE_PROVIDER || '').trim().toLowerCase();
  if (provider && !PROVIDERS.has(provider)) {
    errors.push(`STORAGE_PROVIDER '${provider}' is not one of: ${[...PROVIDERS].join(', ')}.`);
    provider = 'mock';
  }
  if (!provider) {
    // Legacy derivation, unchanged from earlier phases: mock unless real credentials exist.
    if (env.S3_UPLOAD_MODE === 'mock' || env.NODE_ENV === 'test' || !hasCredentials) provider = 'mock';
    else if (hostOf(endpoint).endsWith('.r2.cloudflarestorage.com')) provider = 'r2';
    else if (endpoint) provider = 's3-compatible';
    else provider = 'aws';
  }

  if (provider !== 'mock' && provider !== 'local') {
    if (!hasCredentials) errors.push(`Storage provider '${provider}' needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.`);
    if ((provider === 'r2' || provider === 's3-compatible') && !endpoint) errors.push(`Storage provider '${provider}' needs S3_ENDPOINT.`);
    if (endpoint) {
      let parsed = null;
      try { parsed = new URL(endpoint); } catch (_) { errors.push('S3_ENDPOINT is not a valid URL.'); }
      if (parsed && parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))) {
        errors.push('S3_ENDPOINT must use https:// (plain http is allowed only for localhost).');
      }
    }
  }

  const localConfig = provider === 'local' ? localAdapter.resolveLocalConfig(env) : null;
  if (localConfig) {
    for (const e of localConfig.errors) errors.push(e);
    if (isProduction) {
      try {
        const u = new URL(localConfig.publicUrl);
        if (u.protocol !== 'https:' && !isLoopbackHost(u.hostname)) {
          errors.push('In production STORAGE_LOCAL_PUBLIC_URL must use https:// (loopback is allowed for testing).');
        }
      } catch (_) { /* already reported */ }
    }
  }

  const defaultMethod = provider === 'aws' || provider === 'mock' ? 'post' : 'put';
  let uploadMethod = (env.S3_UPLOAD_METHOD || '').trim().toLowerCase() || defaultMethod;
  if (!UPLOAD_METHODS.has(uploadMethod)) {
    errors.push(`S3_UPLOAD_METHOD '${uploadMethod}' must be post or put.`);
    uploadMethod = defaultMethod;
  }
  if (provider === 'r2' && uploadMethod === 'post') errors.push('Cloudflare R2 does not support POST uploads; use S3_UPLOAD_METHOD=put or leave it unset.');
  if (provider === 'local' && uploadMethod === 'post') errors.push('Local storage does not support POST uploads; use S3_UPLOAD_METHOD=put or leave it unset.');

  const forcePathStyle = env.S3_FORCE_PATH_STYLE !== undefined && env.S3_FORCE_PATH_STYLE !== ''
    ? env.S3_FORCE_PATH_STYLE === 'true'
    : provider === 's3-compatible';

  return {
    provider,
    bucket,
    region: provider === 'r2' ? 'auto' : (env.S3_REGION || env.AWS_REGION || 'ap-south-1').trim(),
    endpoint: endpoint || undefined,
    forcePathStyle,
    uploadMethod,
    serverSideEncryption: provider === 'aws', // SSE form field on AWS POST uploads only (R2 rejects the header)
    failClosed: provider === 'mock' && isProduction && env.ALLOW_MOCK_STORAGE !== 'true',
    credentials: { accessKeyId, secretAccessKey },
    local: localConfig,
    errors
  };
}

/** Configuration without secrets, safe to log or return from a health endpoint. */
function describeConfig(config) {
  return {
    provider: config.provider,
    bucket: config.provider === 'mock' || config.provider === 'local' ? null : config.bucket,
    region: config.region,
    endpointHost: config.endpoint && config.provider !== 'mock' && config.provider !== 'local' ? hostOf(config.endpoint) : null,
    uploadMethod: config.uploadMethod.toUpperCase(),
    failClosed: config.failClosed,
    localPublicUrl: config.provider === 'local' && config.local ? config.local.publicUrl : null
  };
}

/**
 * Builds a storage adapter from an environment object. Throws when a real provider is
 * misconfigured, so a bad deploy fails at boot instead of on the first upload.
 */
function createStorage(env = process.env) {
  const config = resolveStorageConfig(env);
  if (config.errors.length) {
    throw new Error(`Storage configuration error: ${config.errors.join(' ')}`);
  }
  const isMock = config.provider === 'mock';
  const isLocal = config.provider === 'local';

  // Constructing the client makes no network call. Checksum calculation is limited to
  // WHEN_REQUIRED: with the SDK default, every presigned PUT URL carries the CRC32 checksum
  // of an EMPTY body, so the store rejects every real upload.
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.credentials.accessKeyId || 'mock_access_key',
      secretAccessKey: config.credentials.secretAccessKey || 'mock_secret_key'
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  });

  function assertWritable() {
    if (config.failClosed) {
      throw operationalError('File storage is not configured on this server. Uploads are disabled until it is.', 503);
    }
  }

  function assertContentType(contentType, allowedTypes) {
    if (typeof contentType !== 'string' || !allowedTypes.has(contentType)) {
      throw operationalError(`Unsupported file type: '${contentType}'. Allowed types: ${[...allowedTypes].join(', ')}.`, 415);
    }
  }

  // Optional declared size. When given it must be a whole number from 1 to maxBytes, and
  // PUT uploads sign it, so the store rejects a body of any other length.
  function normaliseContentLength(contentLength, maxBytes) {
    if (contentLength === undefined || contentLength === null || contentLength === '') return null;
    const n = Number(contentLength);
    if (!Number.isInteger(n) || n < 1) throw operationalError('contentLength must be a whole number of bytes, at least 1.', 400);
    if (n > maxBytes) throw operationalError(`File is too large: ${n} bytes. Maximum is ${maxBytes} bytes.`, 413);
    return n;
  }

  /**
   * Signs one direct-to-storage upload.
   * @returns {{ method: 'POST'|'PUT', url: string, fields: object, headers: object,
   *             key: string, expiresInSeconds: number, maxBytes: number }}
   */
  async function createUploadPolicy({ key, contentType, allowedTypes, maxBytes, contentLength, expiresInSeconds = UPLOAD_EXPIRES_SECONDS }) {
    assertWritable();
    assertContentType(contentType, allowedTypes);
    const declaredLength = normaliseContentLength(contentLength, maxBytes);

    if (isMock) {
      return {
        method: 'POST',
        url: `https://mock-s3.buildbd.internal/${config.bucket || 'mock-bucket'}`,
        fields: { key, 'Content-Type': contentType, 'x-amz-mock': 'true' },
        headers: {},
        key,
        expiresInSeconds,
        maxBytes
      };
    }

    if (isLocal) {
      const token = localAdapter.signUploadToken(config.local, { key, contentType, maxBytes, expiresInSeconds });
      return {
        method: 'PUT',
        url: localAdapter.uploadUrl(config.local, token),
        fields: {},
        headers: { 'Content-Type': contentType },
        key,
        expiresInSeconds,
        maxBytes
      };
    }

    if (config.uploadMethod === 'post') {
      const fields = { 'Content-Type': contentType };
      if (config.serverSideEncryption) fields['x-amz-server-side-encryption'] = 'AES256';
      const { url, fields: signedFields } = await createPresignedPost(client, {
        Bucket: config.bucket,
        Key: key,
        Conditions: [
          ['content-length-range', 1, maxBytes], // 🛡️ enforced by the store, no app RAM
          { 'Content-Type': contentType }
        ],
        Fields: fields,
        Expires: expiresInSeconds
      });
      return { method: 'POST', url, fields: signedFields, headers: {}, key, expiresInSeconds, maxBytes };
    }

    const input = { Bucket: config.bucket, Key: key, ContentType: contentType };
    const signableHeaders = new Set(['content-type']);
    if (declaredLength !== null) {
      input.ContentLength = declaredLength;
      signableHeaders.add('content-length');
    }
    // No SSE header on PUT: the SDK signs it as a header the browser would then have to send,
    // R2 rejects it, and AWS has encrypted every new object (SSE-S3) by default since Jan 2023.
    // Pure local HMAC-SHA256 signing, no network call.
    const url = await getSignedUrl(client, new PutObjectCommand(input), { expiresIn: expiresInSeconds, signableHeaders });
    return { method: 'PUT', url, fields: {}, headers: { 'Content-Type': contentType }, key, expiresInSeconds, maxBytes };
  }

  function newKey(ledgerId, milestoneIndex, prefix) {
    // Random entropy prevents key collisions and guessing; the path isolates each contract.
    const entropy = crypto.randomBytes(16).toString('hex');
    return `ledgers/${ledgerId}/milestones/${milestoneIndex}/${prefix}${Date.now()}-${entropy}`;
  }

  /**
   * Legacy proof upload (Phase 18.9 apiClient): always a presigned PUT URL.
   * @returns {Promise<{ presignedUrl: string, fileKey: string, expiresInSeconds: number }>}
   */
  async function generateUploadSignature(ledgerId, milestoneIndex, contentType) {
    assertWritable();
    assertContentType(contentType, ALLOWED_MIME_TYPES);
    const fileKey = newKey(ledgerId, milestoneIndex, '');
    if (isMock) {
      return {
        presignedUrl: `https://mock-s3.buildbd.internal/${config.bucket || 'mock-bucket'}/${fileKey}?X-Amz-Expires=${UPLOAD_EXPIRES_SECONDS}&mock=true`,
        fileKey,
        expiresInSeconds: UPLOAD_EXPIRES_SECONDS
      };
    }
    if (isLocal) {
      const token = localAdapter.signUploadToken(config.local, {
        key: fileKey,
        contentType,
        maxBytes: MAX_FILE_SIZE_BYTES,
        expiresInSeconds: UPLOAD_EXPIRES_SECONDS
      });
      return {
        presignedUrl: localAdapter.uploadUrl(config.local, token),
        fileKey,
        expiresInSeconds: UPLOAD_EXPIRES_SECONDS
      };
    }
    const input = { Bucket: config.bucket, Key: fileKey, ContentType: contentType }; // no SSE header: see createUploadPolicy
    const presignedUrl = await getSignedUrl(client, new PutObjectCommand(input), {
      expiresIn: UPLOAD_EXPIRES_SECONDS,
      signableHeaders: new Set(['content-type'])
    });
    return { presignedUrl, fileKey, expiresInSeconds: UPLOAD_EXPIRES_SECONDS };
  }

  /**
   * Evidence photo / payment receipt upload policy (10 MB, images only).
   * Returns the legacy fields (url, fields, s3Key, expiresInSeconds) plus method, headers
   * and maxBytes, so a client knows whether to send a form POST or a raw PUT.
   */
  async function generateEvidenceUploadPolicy(ledgerId, milestoneIndex, contentType, options = {}) {
    assertWritable();
    assertContentType(contentType, EVIDENCE_ALLOWED_MIME_TYPES);
    const policy = await createUploadPolicy({
      key: newKey(ledgerId, milestoneIndex, 'evidence-'),
      contentType,
      allowedTypes: EVIDENCE_ALLOWED_MIME_TYPES,
      maxBytes: MAX_EVIDENCE_SIZE_BYTES,
      contentLength: options.contentLength
    });
    return {
      url: policy.url,
      fields: policy.fields,
      s3Key: policy.key,
      expiresInSeconds: policy.expiresInSeconds,
      method: policy.method,
      headers: policy.headers,
      maxBytes: policy.maxBytes
    };
  }

  /**
   * HeadObject. Returns { exists, size, contentType }. Never throws: a missing object, a
   * network error and fail-closed mode all answer exists:false (safe default).
   */
  async function inspectObject(key) {
    if (typeof key !== 'string' || key.length === 0) return { exists: false, size: null, contentType: null, reason: 'no key' };
    if (isMock) {
      if (config.failClosed) return { exists: false, size: null, contentType: null, reason: 'storage not configured' };
      return { exists: true, size: null, contentType: null, mock: true };
    }
    if (isLocal) {
      return localAdapter.statObject(config.local, key);
    }
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
      return { exists: true, size: Number(head.ContentLength), contentType: head.ContentType || null };
    } catch (err) {
      const status = err && err.$metadata ? err.$metadata.httpStatusCode : undefined;
      const why = status ? `HTTP ${status}` : ((err && (err.code || err.name)) || 'error');
      return { exists: false, size: null, contentType: null, reason: status === 404 ? 'not found' : `head failed (${why})` };
    }
  }

  /** 🛡️ Physical storage reconciliation: true only when the object exists. */
  async function verifyObjectExists(key) {
    return (await inspectObject(key)).exists;
  }

  /** Deletes an object. Never throws; returns true when the store accepted the delete. */
  async function deleteObject(key) {
    if (isMock) return !config.failClosed;
    if (isLocal) return localAdapter.deleteObject(config.local, key);
    try {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * After-upload check for PUT uploads (where the store cannot enforce a size range):
   * the object must exist, be 1..maxBytes long and have an allowed Content-Type.
   * A violating object is deleted so it cannot be reused.
   * @returns {Promise<{ ok: boolean, statusCode?: number, reason?: string, size?: number|null, contentType?: string|null }>}
   */
  async function validateUploadedObject(key, { maxBytes = MAX_EVIDENCE_SIZE_BYTES, allowedTypes = EVIDENCE_ALLOWED_MIME_TYPES } = {}) {
    const info = await inspectObject(key);
    if (!info.exists) return { ok: false, statusCode: 400, reason: 'File not found in storage. Complete the upload first.' };
    if (info.mock) return { ok: true, size: null, contentType: null };
    if (!Number.isFinite(info.size) || info.size < 1 || info.size > maxBytes) {
      await deleteObject(key);
      return { ok: false, statusCode: 413, reason: `Uploaded file size ${info.size} bytes is outside the allowed range 1-${maxBytes}. The file was removed.`, size: info.size, contentType: info.contentType };
    }
    if (!allowedTypes.has(info.contentType)) {
      await deleteObject(key);
      return { ok: false, statusCode: 415, reason: `Uploaded file type '${info.contentType}' is not allowed. The file was removed.`, size: info.size, contentType: info.contentType };
    }
    return { ok: true, size: info.size, contentType: info.contentType };
  }

  return {
    config: describeConfig(config),
    isMock,
    client,
    createUploadPolicy,
    generateUploadSignature,
    generateEvidenceUploadPolicy,
    inspectObject,
    verifyObjectExists,
    deleteObject,
    validateUploadedObject
  };
}

// ── Default instance from process.env (what the routes use) ─────────────────────────────
const storage = createStorage(process.env);
if (storage.config.failClosed) {
  console.error('🚫 [Storage] NODE_ENV=production but no storage is configured (mock refused). Uploads answer 503 until S3/R2 settings are set.');
} else if (process.env.NODE_ENV !== 'test') {
  const c = storage.config;
  console.log(`☁️ [Storage] provider=${c.provider}${c.bucket ? ` bucket=${c.bucket}` : ''}${c.endpointHost ? ` endpoint=${c.endpointHost}` : ''} uploads=${c.uploadMethod}`);
}

module.exports = {
  // Used by the routes (names unchanged from earlier phases)
  generateUploadSignature: storage.generateUploadSignature,
  verifyObjectExists: storage.verifyObjectExists,
  generateEvidenceUploadPolicy: storage.generateEvidenceUploadPolicy,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  isS3Mock: storage.isMock,
  s3Client: storage.client,
  // New in step 31.12
  inspectObject: storage.inspectObject,
  deleteObject: storage.deleteObject,
  validateUploadedObject: storage.validateUploadedObject,
  createUploadPolicy: storage.createUploadPolicy,
  storageConfig: storage.config,
  EVIDENCE_ALLOWED_MIME_TYPES,
  MAX_EVIDENCE_SIZE_BYTES,
  createStorage,
  resolveStorageConfig
};
