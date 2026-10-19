// tests/storage-adapter-unit.js
// DB-free, network-free test of services/s3Service.js (the storage adapter).
// Signing is local HMAC, so every provider can be checked with fake credentials.
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { createStorage, resolveStorageConfig } = require('../services/s3Service');
const { verifyUploadToken, resolveLocalConfig, writeStreamToDisk } = require('../services/localStorageAdapter');
const { Readable } = require('stream');

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function rejectsWith(promiseFactory, statusCode) {
  try {
    await promiseFactory();
    return 'did not throw';
  } catch (err) {
    return err.statusCode === statusCode ? true : `threw ${err.statusCode}: ${err.message}`;
  }
}

function throwsSync(fn) {
  try { fn(); return false; } catch (_) { return true; }
}

const R2_ENV = {
  S3_BUCKET: 'buildbd-evidence',
  S3_ACCESS_KEY_ID: 'R2TESTKEY',
  S3_SECRET_ACCESS_KEY: 'r2-test-secret-do-not-log',
  S3_ENDPOINT: 'https://0123456789abcdef.r2.cloudflarestorage.com'
};
const AWS_ENV = {
  AWS_S3_BUCKET_NAME: 'buildbd-proofs',
  AWS_ACCESS_KEY_ID: 'AWSTESTKEY',
  AWS_SECRET_ACCESS_KEY: 'aws-test-secret-do-not-log'
};

async function main() {
  console.log('🧪 storage adapter (services/s3Service.js)');

  // ── 1. Configuration resolution ─────────────────────────────────────────────
  const empty = resolveStorageConfig({});
  check('no settings -> mock, POST, not fail-closed', empty.provider === 'mock' && empty.uploadMethod === 'post' && !empty.failClosed && empty.errors.length === 0, JSON.stringify(empty));
  const prodMock = resolveStorageConfig({ NODE_ENV: 'production' });
  check('production without storage -> mock is fail-closed', prodMock.provider === 'mock' && prodMock.failClosed === true);
  check('ALLOW_MOCK_STORAGE=true lifts fail-closed', resolveStorageConfig({ NODE_ENV: 'production', ALLOW_MOCK_STORAGE: 'true' }).failClosed === false);
  check('S3_UPLOAD_MODE=mock wins over real credentials', resolveStorageConfig({ ...AWS_ENV, S3_UPLOAD_MODE: 'mock' }).provider === 'mock');
  const aws = resolveStorageConfig(AWS_ENV);
  check('legacy AWS_* names -> aws, ap-south-1, POST, SSE field', aws.provider === 'aws' && aws.region === 'ap-south-1' && aws.uploadMethod === 'post' && aws.serverSideEncryption === true && aws.errors.length === 0, JSON.stringify({ ...aws, credentials: '…' }));
  const r2 = resolveStorageConfig(R2_ENV);
  check('R2 endpoint -> r2, region auto, PUT, no SSE, virtual-hosted', r2.provider === 'r2' && r2.region === 'auto' && r2.uploadMethod === 'put' && r2.serverSideEncryption === false && r2.forcePathStyle === false && r2.errors.length === 0, JSON.stringify({ ...r2, credentials: '…' }));
  const compat = resolveStorageConfig({ ...R2_ENV, S3_ENDPOINT: 'http://127.0.0.1:8333' });
  check('local endpoint -> s3-compatible, PUT, path-style', compat.provider === 's3-compatible' && compat.uploadMethod === 'put' && compat.forcePathStyle === true && compat.errors.length === 0, JSON.stringify(compat.errors));
  check('explicit r2 without S3_ENDPOINT is an error', resolveStorageConfig({ ...R2_ENV, STORAGE_PROVIDER: 'r2', S3_ENDPOINT: '' }).errors.length > 0);
  check('r2 with S3_UPLOAD_METHOD=post is an error', resolveStorageConfig({ ...R2_ENV, S3_UPLOAD_METHOD: 'post' }).errors.length > 0);
  check('plain http endpoint (not localhost) is an error', resolveStorageConfig({ ...R2_ENV, S3_ENDPOINT: 'http://storage.example.com' }).errors.length > 0);
  check('unknown STORAGE_PROVIDER is an error', resolveStorageConfig({ STORAGE_PROVIDER: 'dropbox' }).errors.length > 0);
  check('createStorage throws on a misconfigured real provider (fail fast at boot)', throwsSync(() => createStorage({ STORAGE_PROVIDER: 'aws' })));

  // ── 2. Cloudflare R2: presigned PUT ─────────────────────────────────────────
  const r2s = createStorage(R2_ENV);
  check('public config never contains the secret key', !JSON.stringify(r2s.config).includes(R2_ENV.S3_SECRET_ACCESS_KEY) && r2s.config.provider === 'r2', JSON.stringify(r2s.config));
  const put = await r2s.generateEvidenceUploadPolicy('LEDGER1', 2, 'image/jpeg', { contentLength: 2048 });
  const putUrl = new URL(put.url);
  const signed = (putUrl.searchParams.get('X-Amz-SignedHeaders') || '').split(';');
  check('R2 evidence policy is a PUT with Content-Type header', put.method === 'PUT' && put.headers['Content-Type'] === 'image/jpeg' && Object.keys(put.fields).length === 0, JSON.stringify({ method: put.method, headers: put.headers }));
  check('R2 URL goes to the bucket on the R2 endpoint', putUrl.hostname === 'buildbd-evidence.0123456789abcdef.r2.cloudflarestorage.com' && putUrl.pathname === `/${put.s3Key}`, putUrl.host + putUrl.pathname);
  check('R2 URL is signed for region auto', (putUrl.searchParams.get('X-Amz-Credential') || '').includes('/auto/s3/aws4_request'));
  check('R2 URL signs content-type and content-length', signed.includes('content-type') && signed.includes('content-length') && signed.includes('host'), signed.join(';'));
  check('R2 URL carries no empty-body CRC32 checksum', !putUrl.searchParams.has('x-amz-checksum-crc32') && !putUrl.searchParams.has('x-amz-sdk-checksum-algorithm'), [...putUrl.searchParams.keys()].join(','));
  check('R2 URL has no server-side-encryption header', !signed.includes('x-amz-server-side-encryption') && !put.headers['x-amz-server-side-encryption']);
  check('R2 URL expires in 900 s', putUrl.searchParams.get('X-Amz-Expires') === '900' && put.expiresInSeconds === 900);
  check('evidence key is namespaced per ledger and milestone', /^ledgers\/LEDGER1\/milestones\/2\/evidence-\d+-[a-f0-9]{32}$/.test(put.s3Key), put.s3Key);
  check('policy reports the 10 MB limit', put.maxBytes === 10 * 1024 * 1024);
  const putNoLen = new URL((await r2s.generateEvidenceUploadPolicy('LEDGER1', 2, 'image/png')).url);
  check('without contentLength only content-type is signed (size checked after upload)', putNoLen.searchParams.get('X-Amz-SignedHeaders') === 'content-type;host', putNoLen.searchParams.get('X-Amz-SignedHeaders'));
  check('contentLength above 10 MB -> 413', await rejectsWith(() => r2s.generateEvidenceUploadPolicy('L', 0, 'image/jpeg', { contentLength: 10 * 1024 * 1024 + 1 }), 413));
  check('contentLength 0 -> 400', await rejectsWith(() => r2s.generateEvidenceUploadPolicy('L', 0, 'image/jpeg', { contentLength: 0 }), 400));
  check('contentLength 1.5 -> 400', await rejectsWith(() => r2s.generateEvidenceUploadPolicy('L', 0, 'image/jpeg', { contentLength: 1.5 }), 400));
  check('contentLength "abc" -> 400', await rejectsWith(() => r2s.generateEvidenceUploadPolicy('L', 0, 'image/jpeg', { contentLength: 'abc' }), 400));
  check('image/gif evidence -> 415', await rejectsWith(() => r2s.generateEvidenceUploadPolicy('L', 0, 'image/gif'), 415));
  check('PDF is not allowed as evidence -> 415', await rejectsWith(() => r2s.generateEvidenceUploadPolicy('L', 0, 'application/pdf'), 415));
  const legacy = await r2s.generateUploadSignature('LEDGER1', 0, 'application/pdf');
  const legacyUrl = new URL(legacy.presignedUrl);
  check('legacy PUT signature: no checksum, no SSE, content-type signed', !legacyUrl.searchParams.has('x-amz-checksum-crc32') && legacyUrl.searchParams.get('X-Amz-SignedHeaders') === 'content-type;host' && /^ledgers\/LEDGER1\/milestones\/0\/\d+-[a-f0-9]{32}$/.test(legacy.fileKey), legacyUrl.searchParams.get('X-Amz-SignedHeaders'));
  check('legacy signature rejects text/html -> 415', await rejectsWith(() => r2s.generateUploadSignature('L', 0, 'text/html'), 415));

  // ── 3. AWS S3: presigned POST with store-enforced conditions ─────────────────
  const awss = createStorage(AWS_ENV);
  const post = await awss.generateEvidenceUploadPolicy('LEDGER9', 1, 'image/webp');
  let conditions = [];
  try { conditions = JSON.parse(Buffer.from(post.fields.Policy, 'base64').toString('utf8')).conditions; } catch (_) { /* checked below */ }
  const cond = JSON.stringify(conditions);
  check('AWS evidence policy is a form POST to the bucket', post.method === 'POST' && post.url === 'https://buildbd-proofs.s3.ap-south-1.amazonaws.com/' && post.fields.key === post.s3Key, `${post.method} ${post.url}`);
  check('AWS policy enforces 1..10 MB at the store', cond.includes('["content-length-range",1,10485760]'), cond);
  check('AWS policy enforces the exact Content-Type', cond.includes('{"Content-Type":"image/webp"}'), cond);
  check('AWS policy requires AES256 encryption', cond.includes('{"x-amz-server-side-encryption":"AES256"}') && post.fields['x-amz-server-side-encryption'] === 'AES256', cond);
  const awsLegacy = new URL((await awss.generateUploadSignature('LEDGER9', 1, 'image/png')).presignedUrl);
  check('AWS legacy PUT: no checksum, no SSE header to send', !awsLegacy.searchParams.has('x-amz-checksum-crc32') && awsLegacy.searchParams.get('X-Amz-SignedHeaders') === 'content-type;host', awsLegacy.searchParams.get('X-Amz-SignedHeaders'));

  // ── 4. Mock (development / CI) ──────────────────────────────────────────────
  const mock = createStorage({});
  const mp = await mock.generateEvidenceUploadPolicy('LEDGERM', 0, 'image/jpeg');
  check('mock policy keeps the earlier shape', mp.method === 'POST' && mp.url === 'https://mock-s3.buildbd.internal/mock-bucket' && mp.fields.key === mp.s3Key && mp.fields['x-amz-mock'] === 'true', JSON.stringify(mp));
  check('mock object check says exists', (await mock.verifyObjectExists('anything')) === true && (await mock.validateUploadedObject('anything', { maxBytes: 10, allowedTypes: new Set(['image/jpeg']) })).ok === true);
  check('mock validateUploadedObject accepts valid expectedHash', (await mock.validateUploadedObject('anything', { expectedHash: 'a'.repeat(64) })).ok === true);
  check('mock validateUploadedObject rejects malformed expectedHash with 400', (await mock.validateUploadedObject('anything', { expectedHash: 'invalid-hash' })).statusCode === 400);
  check('empty key never exists', (await mock.inspectObject('')).exists === false);

  // ── 5. Fail-closed in production ────────────────────────────────────────────
  const closed = createStorage({ NODE_ENV: 'production' });
  check('fail-closed: evidence policy -> 503', await rejectsWith(() => closed.generateEvidenceUploadPolicy('L', 0, 'image/jpeg'), 503));
  check('fail-closed: legacy signature -> 503', await rejectsWith(() => closed.generateUploadSignature('L', 0, 'image/jpeg'), 503));
  check('fail-closed: no object ever "exists"', (await closed.verifyObjectExists('ledgers/x')) === false);
  const closedValidate = await closed.validateUploadedObject('ledgers/x', { maxBytes: 10, allowedTypes: new Set(['image/jpeg']) });
  check('fail-closed: validateUploadedObject rejects with 400', closedValidate.ok === false && closedValidate.statusCode === 400, JSON.stringify(closedValidate));

  // ── 6. Local disk provider ──────────────────────────────────────────────────
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'buildbd-local-'));
  const LOCAL_ENV = {
    STORAGE_PROVIDER: 'local',
    STORAGE_LOCAL_DIR: tmpDir,
    STORAGE_LOCAL_PUBLIC_URL: 'https://beta.example.test',
    STORAGE_LOCAL_SECRET: 'local-test-secret-not-production-abcdefghij'
  };
  const localCfg = resolveStorageConfig(LOCAL_ENV);
  check('local provider resolves cleanly', localCfg.provider === 'local' && localCfg.uploadMethod === 'put' && localCfg.errors.length === 0 && localCfg.failClosed === false, JSON.stringify(localCfg.errors));
  check('local provider rejects S3_UPLOAD_METHOD=post', resolveStorageConfig({ ...LOCAL_ENV, S3_UPLOAD_METHOD: 'post' }).errors.length > 0);
  check('local provider in production requires https public URL',
    resolveStorageConfig({ ...LOCAL_ENV, STORAGE_LOCAL_PUBLIC_URL: 'http://example.com', NODE_ENV: 'production' }).errors.length > 0
    && resolveStorageConfig({ ...LOCAL_ENV, NODE_ENV: 'production' }).errors.length === 0
    && resolveStorageConfig({ ...LOCAL_ENV, STORAGE_LOCAL_PUBLIC_URL: 'http://localhost:5000', NODE_ENV: 'production' }).errors.length === 0);
  check('local provider in production without secret is an error',
    resolveStorageConfig({ STORAGE_PROVIDER: 'local', STORAGE_LOCAL_PUBLIC_URL: 'https://beta.example.test', NODE_ENV: 'production' }).errors.length > 0);

  const localStore = createStorage(LOCAL_ENV);
  const localPolicy = await localStore.generateEvidenceUploadPolicy('LEDGERL', 3, 'image/jpeg', { contentLength: 1024 });
  check('local evidence policy is a PUT with the right headers',
    localPolicy.method === 'PUT' && localPolicy.headers['Content-Type'] === 'image/jpeg' && Object.keys(localPolicy.fields).length === 0,
    JSON.stringify({ method: localPolicy.method, headers: localPolicy.headers, fields: localPolicy.fields }));
  const localUrl = new URL(localPolicy.url);
  check('local policy URL points at the configured public origin + /__storage/upload/<token>',
    localUrl.origin === 'https://beta.example.test' && /^\/__storage\/upload\/[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(localUrl.pathname),
    localUrl.href);
  const localToken = localUrl.pathname.replace(/^\/__storage\/upload\//, '');
  const claim = verifyUploadToken(resolveLocalConfig(LOCAL_ENV), localToken);
  check('local upload token encodes exactly key, contentType, maxBytes, expiry',
    claim.key === localPolicy.s3Key && claim.contentType === 'image/jpeg' && claim.maxBytes === 10 * 1024 * 1024 && claim.expiresAt > Math.floor(Date.now() / 1000),
    JSON.stringify(claim));
  const legacyLocal = await localStore.generateUploadSignature('LEDGERL', 3, 'application/pdf');
  const legacyLocalUrl = new URL(legacyLocal.presignedUrl);
  check('local legacy signature is a PUT URL on this server, maxBytes=25MB',
    legacyLocalUrl.origin === 'https://beta.example.test' && legacyLocalUrl.pathname.startsWith('/__storage/upload/')
    && verifyUploadToken(resolveLocalConfig(LOCAL_ENV), legacyLocalUrl.pathname.split('/').pop()).maxBytes === 25 * 1024 * 1024,
    legacyLocalUrl.href);
  check('tampered token is rejected',
    throwsSync(() => verifyUploadToken(resolveLocalConfig(LOCAL_ENV), localToken.slice(0, -2) + 'XX')));
  const expiredPayload = Buffer.from(JSON.stringify({ k: 'ledgers/x/milestones/0/evidence-1', c: 'image/jpeg', m: 1024, e: Math.floor(Date.now() / 1000) - 10 }), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const crypto = require('crypto');
  const expiredSig = crypto.createHmac('sha256', LOCAL_ENV.STORAGE_LOCAL_SECRET).update(expiredPayload).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  check('expired token is rejected with 410',
    (() => { try { verifyUploadToken(resolveLocalConfig(LOCAL_ENV), `${expiredPayload}.${expiredSig}`); return false; } catch (err) { return err.statusCode === 410; } })());
  check('wrong-secret token is rejected',
    (() => { try { verifyUploadToken(resolveLocalConfig({ ...LOCAL_ENV, STORAGE_LOCAL_SECRET: 'different-secret' }), localToken); return false; } catch (err) { return err.statusCode === 401; } })());

  // Simulate the upload endpoint writing the file (streaming path with size cap).
  const payload = Buffer.from('hello buildbd beta');
  const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');
  const okResult = await writeStreamToDisk(resolveLocalConfig(LOCAL_ENV), claim, Readable.from([payload]));
  check('writeStreamToDisk persists under the configured dir and computes checksum',
    okResult.ok === true && okResult.size === payload.length && okResult.checksumSha256 === expectedHash,
    JSON.stringify(okResult));
  const inspectedLocal = await localStore.inspectObject(claim.key);
  check('local inspectObject surfaces the signed Content-Type and checksumSha256 via sidecar',
    inspectedLocal.exists === true
    && inspectedLocal.contentType === 'image/jpeg'
    && inspectedLocal.size === payload.length
    && inspectedLocal.checksumSha256 === expectedHash);
  const validated = await localStore.validateUploadedObject(claim.key, { maxBytes: 10 * 1024 * 1024, allowedTypes: new Set(['image/jpeg']) });
  check('validateUploadedObject accepts a well-formed local object', validated.ok === true, JSON.stringify(validated));
  const validatedWithHash = await localStore.validateUploadedObject(claim.key, {
    maxBytes: 10 * 1024 * 1024,
    allowedTypes: new Set(['image/jpeg']),
    expectedHash
  });
  check('validateUploadedObject accepts matching expectedHash', validatedWithHash.ok === true, JSON.stringify(validatedWithHash));
  const invalidFormat = await localStore.validateUploadedObject(claim.key, {
    maxBytes: 10 * 1024 * 1024,
    allowedTypes: new Set(['image/jpeg']),
    expectedHash: 'not-a-valid-sha256'
  });
  check('validateUploadedObject rejects invalid expectedHash format with 400',
    invalidFormat.ok === false && invalidFormat.statusCode === 400,
    JSON.stringify(invalidFormat));
  const mismatchPolicy = await localStore.generateEvidenceUploadPolicy('LEDGERL', 9, 'image/jpeg');
  const mismatchClaim = verifyUploadToken(resolveLocalConfig(LOCAL_ENV), new URL(mismatchPolicy.url).pathname.split('/').pop());
  await writeStreamToDisk(resolveLocalConfig(LOCAL_ENV), mismatchClaim, Readable.from([Buffer.from('mismatch content')]));
  const mismatchResult = await localStore.validateUploadedObject(mismatchClaim.key, {
    maxBytes: 10 * 1024 * 1024,
    allowedTypes: new Set(['image/jpeg']),
    expectedHash: '0000000000000000000000000000000000000000000000000000000000000000'
  });
  check('validateUploadedObject rejects checksum mismatch with 422 and removes file',
    mismatchResult.ok === false
    && mismatchResult.statusCode === 422
    && !fs.existsSync(path.join(tmpDir, mismatchClaim.key))
    && !fs.existsSync(path.join(tmpDir, mismatchClaim.key + '.meta.json')),
    JSON.stringify(mismatchResult));
  const tooBigPolicy = await localStore.generateEvidenceUploadPolicy('LEDGERL', 4, 'image/png');
  const tooBigClaim = verifyUploadToken(resolveLocalConfig(LOCAL_ENV), new URL(tooBigPolicy.url).pathname.split('/').pop());
  const over = Buffer.alloc(10 * 1024 * 1024 + 32);
  const overResult = await writeStreamToDisk(resolveLocalConfig(LOCAL_ENV), tooBigClaim, Readable.from([over]));
  check('writeStreamToDisk aborts with 413 above the signed maxBytes', overResult.ok === false && overResult.statusCode === 413, JSON.stringify(overResult));
  check('aborted upload leaves no file on disk', !fs.existsSync(path.join(tmpDir, tooBigClaim.key)) && !fs.existsSync(path.join(tmpDir, tooBigClaim.key + '.part')));
  const deleted = await localStore.deleteObject(claim.key);
  check('deleteObject removes both the file and the sidecar',
    deleted === true
    && !fs.existsSync(path.join(tmpDir, claim.key))
    && !fs.existsSync(path.join(tmpDir, claim.key + '.meta.json')));
  check('local path traversal attempts fail safely in inspectObject',
    (await localStore.inspectObject('../../etc/passwd')).exists === false
    && (await localStore.inspectObject('/absolute/path')).exists === false);
  await fsp.rm(tmpDir, { recursive: true, force: true });

  // ── 7. Unreachable store answers "not found", never throws ──────────────────
  const dead = createStorage({ ...R2_ENV, S3_ENDPOINT: 'http://127.0.0.1:9' });
  const started = Date.now();
  const deadInfo = await dead.inspectObject('ledgers/x');
  check('unreachable store -> exists:false (no throw)', deadInfo.exists === false && typeof deadInfo.reason === 'string', JSON.stringify(deadInfo));
  check('unreachable store answers within 15 s', Date.now() - started < 15000, `${Date.now() - started} ms`);
  check('delete on unreachable store returns false (no throw)', (await dead.deleteObject('ledgers/x')) === false);

  console.log(`--- Results: ${failed === 0 ? 'all passed' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('💥 storage-adapter-unit crashed:', err);
  process.exit(1);
});
