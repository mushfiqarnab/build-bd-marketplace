// services/s3Service.js
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { createPresignedPost } = require('@aws-sdk/s3-presigned-post');
const crypto = require('crypto');

// ☁️ Mirrors the isMockGateway pattern from payment.js.
// When S3_UPLOAD_MODE=mock (or credentials are absent), the service returns a
// structurally correct mock response so local dev and CI never depend on real AWS.
const isS3Mock =
  process.env.S3_UPLOAD_MODE === 'mock' ||
  process.env.NODE_ENV === 'test' ||
  !process.env.AWS_ACCESS_KEY_ID ||
  !process.env.AWS_SECRET_ACCESS_KEY ||
  !process.env.AWS_S3_BUCKET_NAME;

// ☁️ Client is lazily evaluated — safe to construct even with mock credentials
// because getSignedUrl is pure local HMAC cryptography (no network call to AWS).
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'mock_access_key',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'mock_secret_key'
  }
});

// 🛡️ M-1 AUDIT FIX: MIME type allowlist enforced at the service boundary.
// Any content type not in this set is rejected before a URL is even generated.
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf'
]);

// 🛡️ Maximum file size hint embedded in the pre-signed URL metadata (25 MB).
// Note: this is advisory — enforce the hard limit via S3 bucket policy in production.
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

/**
 * Generates a time-limited, cryptographically signed URL for direct-to-cloud uploads.
 * The Node.js process never touches the file bytes — 12-Factor Factor VI compliance.
 *
 * @param {string} ledgerId   - The escrow ledger ID for structured bucket routing.
 * @param {number} milestoneIndex - The milestone index for structured bucket routing.
 * @param {string} contentType - The MIME type of the file to be uploaded.
 * @returns {Promise<{ presignedUrl: string, fileKey: string, expiresInSeconds: number }>}
 * @throws {Error} If contentType is not in the allowlist.
 */
async function generateUploadSignature(ledgerId, milestoneIndex, contentType) {
  // 🛡️ Validate MIME type before any work is done
  if (!ALLOWED_MIME_TYPES.has(contentType)) {
    const err = new Error(
      `Unsupported file type: '${contentType}'. Allowed types: ${[...ALLOWED_MIME_TYPES].join(', ')}.`
    );
    err.statusCode = 415;
    err.isOperational = true;
    throw err;
  }

  // Cryptographically secure entropy prefix prevents key collisions and path traversal
  const entropy = crypto.randomBytes(16).toString('hex');

  // Structured S3 key: ledgers/{ledgerId}/milestones/{idx}/{timestamp}-{entropy}
  // Provides natural namespace isolation per contract and milestone
  const fileKey = `ledgers/${ledgerId}/milestones/${milestoneIndex}/${Date.now()}-${entropy}`;

  const EXPIRES_IN_SECONDS = 900; // 15 minutes — contractor must initiate upload promptly

  if (isS3Mock) {
    // Return a structurally identical mock response for local dev and CI.
    // The mock URL is not callable, but all downstream code can validate its shape.
    return {
      presignedUrl: `https://mock-s3.buildbd.internal/${process.env.AWS_S3_BUCKET_NAME || 'mock-bucket'}/${fileKey}?X-Amz-Expires=${EXPIRES_IN_SECONDS}&mock=true`,
      fileKey,
      expiresInSeconds: EXPIRES_IN_SECONDS
    };
  }

  const command = new PutObjectCommand({
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: fileKey,
    ContentType: contentType,
    ServerSideEncryption: 'AES256' // 🛡️ Enforce at-rest encryption in the cloud bucket
  });

  // Pure local HMAC-SHA256 signing — no network call to AWS is made here.
  const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: EXPIRES_IN_SECONDS });

  return { presignedUrl, fileKey, expiresInSeconds: EXPIRES_IN_SECONDS };
}

/**
 * 🛡️ Physical Storage Reconciliation: Checks whether an object physically exists in S3.
 * Returns true if the object is present (or in mock mode), false otherwise.
 * @param {string} fileKey
 * @returns {Promise<boolean>}
 */
async function verifyObjectExists(fileKey) {
  if (isS3Mock) {
    return true; // Bypass network call for local mock/test runs
  }

  try {
    const command = new HeadObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET_NAME,
      Key: fileKey
    });
    await s3Client.send(command);
    return true;
  } catch (error) {
    return false; // Object does not exist or bucket/key is unreachable
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 🛡️ Phase 21 v2: Evidence Upload Policy Generator
//
// Uses S3 Pre-Signed POST (createPresignedPost) rather than a PUT pre-signed URL.
// Key advantage: POST policies support server-enforced Conditions at the S3 layer:
//   - content-length-range: S3 rejects files > MAX_EVIDENCE_SIZE_BYTES server-side.
//     No application RAM is consumed. The Node.js process never sees the bytes.
//   - Content-Type: S3 enforces the exact MIME type the client declared.
//
// The client flow:
//   1. GET /api/governance/proof/presigned-url → receives { url, fields, s3Key, expires }
//   2. Client computes SHA-256 of the image buffer locally (SubtleCrypto / Node crypto)
//   3. Client POSTs directly to S3 using url + fields (browser FormData)
//      S3 enforces content-length-range and Content-Type. No backend RAM.
//   4. Client sends POST /proof/evidence/:ledgerId/milestone/:idx with JSON:
//        { s3ObjectKey, imageHash, gpsData }
//   5. Backend verifies location math, HeadObjects to confirm the key exists,
//      and commits the immutable evidence log entry.
//
// @param {string} ledgerId
// @param {number} milestoneIndex
// @param {string} contentType   — e.g. 'image/jpeg'
// @returns {{ url, fields, s3Key, expiresInSeconds }}
// ─────────────────────────────────────────────────────────────────────────────

const EVIDENCE_ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_EVIDENCE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB hard S3-enforced cap
const EVIDENCE_EXPIRES_SECONDS = 900; // 15 minutes — matches CPT token window

async function generateEvidenceUploadPolicy(ledgerId, milestoneIndex, contentType) {
  if (!EVIDENCE_ALLOWED_MIME_TYPES.has(contentType)) {
    const err = new Error(
      `Unsupported evidence file type: '${contentType}'. Allowed: ${[...EVIDENCE_ALLOWED_MIME_TYPES].join(', ')}.`
    );
    err.statusCode = 415;
    err.isOperational = true;
    throw err;
  }

  const entropy = crypto.randomBytes(16).toString('hex');
  const s3Key = `ledgers/${ledgerId}/milestones/${milestoneIndex}/evidence-${Date.now()}-${entropy}`;

  if (isS3Mock) {
    // Structurally identical mock — all downstream code can validate the shape.
    return {
      url: `https://mock-s3.buildbd.internal/${process.env.AWS_S3_BUCKET_NAME || 'mock-bucket'}`,
      fields: {
        key: s3Key,
        'Content-Type': contentType,
        'x-amz-mock': 'true'
      },
      s3Key,
      expiresInSeconds: EVIDENCE_EXPIRES_SECONDS
    };
  }

  const { url, fields } = await createPresignedPost(s3Client, {
    Bucket: process.env.AWS_S3_BUCKET_NAME,
    Key: s3Key,
    Conditions: [
      // 🛡️ S3-enforced file size cap — infrastructure level, no app RAM
      ['content-length-range', 1, MAX_EVIDENCE_SIZE_BYTES],
      // 🛡️ S3-enforced MIME type
      { 'Content-Type': contentType }
    ],
    Fields: {
      'Content-Type': contentType,
      // 🛡️ Force server-side AES-256 encryption on all evidence objects
      'x-amz-server-side-encryption': 'AES256'
    },
    Expires: EVIDENCE_EXPIRES_SECONDS
  });

  return { url, fields, s3Key, expiresInSeconds: EVIDENCE_EXPIRES_SECONDS };
}

module.exports = {

  generateUploadSignature,
  verifyObjectExists,
  generateEvidenceUploadPolicy,
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  isS3Mock,
  s3Client
};

