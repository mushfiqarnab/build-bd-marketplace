#!/usr/bin/env node
// scripts/storage-live-check.js — prove the configured bucket really works with this code.
//
// Run AFTER putting your storage settings in .env (or the environment):
//     node scripts/storage-live-check.js
// It uses the SAME adapter the server uses (services/s3Service.js) and, inside a throwaway
// prefix (healthchecks/storage-live-check/), it:
//   1. uploads a small test image exactly the way a phone browser will,
//   2. checks the stored size and type,
//   3. proves the store REJECTS a wrong Content-Type, a wrong size, an expired URL and a
//      tampered URL,
//   4. proves an oversize upload is caught and deleted after upload,
//   5. deletes everything it created.
// Prints no secrets. Exit code 0 = storage is production-ready, 1 = something is wrong.
'use strict';

require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const { createStorage } = require('../services/s3Service');

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bytes that start like a JPEG; the store never inspects content, only headers and size.
function fakeJpeg(size) {
  const buf = crypto.randomBytes(size);
  buf[0] = 0xff; buf[1] = 0xd8; buf[2] = 0xff;
  return buf;
}

// Sends the upload exactly as a browser would for the returned policy.
// Returns the HTTP status, or 0 when the store could not be reached at all.
async function upload(policy, body, overrideHeaders) {
  try {
    return await sendUpload(policy, body, overrideHeaders);
  } catch (_) {
    return 0;
  }
}

async function sendUpload(policy, body, overrideHeaders) {
  if (policy.method === 'PUT') {
    const res = await fetch(policy.url, { method: 'PUT', headers: overrideHeaders || policy.headers, body });
    return res.status;
  }
  // POST: the store reads Content-Type from the form FIELD, so an override replaces that field.
  const fields = { ...policy.fields, ...(overrideHeaders || {}) };
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([body], { type: fields['Content-Type'] }));
  const res = await fetch(policy.url, { method: 'POST', body: form });
  return res.status;
}

const ok = (status) => status >= 200 && status < 300;
// 0 (unreachable) is NOT a rejection: a store we cannot reach proves nothing.
const rejected = (status) => status >= 400 && status < 500;

async function main() {
  let storage;
  try {
    storage = createStorage(process.env);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
  const c = storage.config;
  console.log(`🧪 storage live check: provider=${c.provider} bucket=${c.bucket} endpoint=${c.endpointHost || '(AWS default)'} uploads=${c.uploadMethod}`);
  if (storage.isMock) {
    console.error('❌ Storage is in mock mode. Set STORAGE_PROVIDER and the S3_* settings first.');
    process.exit(1);
  }

  const prefix = `healthchecks/storage-live-check/${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const types = new Set(['image/jpeg']);
  const created = [];
  const policyFor = (name, extra = {}) => {
    const key = `${prefix}/${name}`;
    created.push(key);
    return storage.createUploadPolicy({ key, contentType: 'image/jpeg', allowedTypes: types, maxBytes: 64 * 1024, ...extra });
  };

  // 0. Reachable and credentials accepted? HeadObject on a key that cannot exist must answer
  //    404 "not found". 403 means wrong keys or a token without access to this bucket.
  const probe = await storage.inspectObject(`${prefix}/does-not-exist`);
  check('storage reachable and credentials accepted', probe.reason === 'not found', probe.reason);
  if (probe.reason !== 'not found') {
    console.log('     Check: S3_ENDPOINT (account ID), S3_BUCKET (exact name), S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY,');
    console.log('     and that the API token has "Object Read & Write" on this bucket. Then run this again.');
    console.log('--- Results: 1 failed ---');
    process.exit(1);
  }

  try {
    // 1-2. A correct upload works and is stored with the right size and type.
    const good = fakeJpeg(4096);
    const goodPolicy = await policyFor('good.jpg', { contentLength: good.length });
    const goodStatus = await upload(goodPolicy, good);
    check(`correct upload accepted (${goodPolicy.method})`, ok(goodStatus), `HTTP ${goodStatus}`);
    const info = await storage.inspectObject(goodPolicy.key);
    check('stored object has the uploaded size and type', info.exists && info.size === good.length && info.contentType === 'image/jpeg', JSON.stringify(info));
    const valid = await storage.validateUploadedObject(goodPolicy.key, { maxBytes: 64 * 1024, allowedTypes: types });
    check('after-upload validation passes', valid.ok === true, JSON.stringify(valid));

    // 3. The store itself rejects tampering.
    const typePolicy = await policyFor('wrong-type.jpg', { contentLength: 1024 });
    const typeStatus = await upload(typePolicy, fakeJpeg(1024), { 'Content-Type': 'image/png' });
    check('wrong Content-Type is rejected by the store', rejected(typeStatus), `HTTP ${typeStatus}`);
    if (typePolicy.method === 'PUT') {
      const sizePolicy = await policyFor('wrong-size.jpg', { contentLength: 1024 });
      const sizeStatus = await upload(sizePolicy, fakeJpeg(1500));
      check('body longer than the declared size is rejected by the store', rejected(sizeStatus), `HTTP ${sizeStatus}`);
    } else {
      const bigPolicy = await policyFor('too-big.jpg', { maxBytes: 1000 });
      const bigStatus = await upload(bigPolicy, fakeJpeg(1500));
      check('body over the policy size range is rejected by the store', rejected(bigStatus), `HTTP ${bigStatus}`);
    }
    const expPolicy = await policyFor('expired.jpg', { contentLength: 512, expiresInSeconds: 1 });
    await sleep(2500);
    const expStatus = await upload(expPolicy, fakeJpeg(512));
    check('expired upload URL is rejected', rejected(expStatus), `HTTP ${expStatus}`);
    if (goodPolicy.method === 'PUT') {
      const tamperPolicy = await policyFor('tamper.jpg', { contentLength: 512 });
      const tampered = { ...tamperPolicy, url: tamperPolicy.url.replace('/tamper.jpg', '/someone-elses-file.jpg') };
      created.push(`${prefix}/someone-elses-file.jpg`);
      const tamperStatus = await upload(tampered, fakeJpeg(512));
      check('URL edited to another key is rejected', rejected(tamperStatus), `HTTP ${tamperStatus}`);
    }

    // 4. Oversize upload without a declared size is caught after upload and deleted.
    if (goodPolicy.method === 'PUT') {
      const loosePolicy = await policyFor('oversize.jpg', { maxBytes: 1000 });
      const looseStatus = await upload(loosePolicy, fakeJpeg(1500));
      check('undeclared-size upload reaches the store', ok(looseStatus), `HTTP ${looseStatus}`);
      const verdict = await storage.validateUploadedObject(loosePolicy.key, { maxBytes: 1000, allowedTypes: types });
      check('oversize object is rejected with 413', verdict.ok === false && verdict.statusCode === 413, JSON.stringify(verdict));
      check('oversize object was deleted', (await storage.inspectObject(loosePolicy.key)).exists === false);
    }

    // 5. Delete works.
    check('delete accepted', (await storage.deleteObject(goodPolicy.key)) === true);
    check('deleted object is gone', (await storage.inspectObject(goodPolicy.key)).exists === false);
  } finally {
    for (const key of created) await storage.deleteObject(key);
  }

  console.log(`--- Results: ${failed === 0 ? 'storage is ready' : `${failed} failed`} ---`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('💥 storage-live-check crashed:', err.message);
  process.exit(1);
});
