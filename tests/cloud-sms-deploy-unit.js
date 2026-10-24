// tests/cloud-sms-deploy-unit.js
// DB-free unit suite verifying 24/7 Cloud Hosting (Render Blueprint + Dockerfile)
// and Pluggable Bangladeshi SMS Gateway + ৳0 Cloud Operator Fallback.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const TMP_LOG = path.join(os.tmpdir(), `buildbd-cloud-otp-unit-${process.pid}.log`);
process.env.OTP_RELAY_LOG = TMP_LOG;

const {
  resolveOtpDelivery,
  resolveSmsConfig,
  hasValidSmsConfig,
  deliverOtp,
  readActiveOperatorOtps
} = require('../services/otpDelivery');
const { resolveLocalConfig } = require('../services/localStorageAdapter');

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function startMockSmsGateway() {
  const requests = [];
  let nextBehavior = { status: 200, body: JSON.stringify({ response_code: 202, success_message: 'SMS Submitted Successfully' }) };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      res.writeHead(nextBehavior.status, { 'Content-Type': 'application/json' });
      res.end(nextBehavior.body);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/sms`,
        requests,
        setBehavior(b) { nextBehavior = b; },
        close() { return new Promise((r) => server.close(r)); }
      });
    });
  });
}

async function main() {
  console.log('\n🧪 24/7 Cloud Hosting & Bangladeshi SMS Gateway Unit Suite\n');

  // ── 1. Backwards-compatible OTP mode resolution invariants ─────────────────
  check('production + unset OTP_DELIVERY -> null (fail closed)', resolveOtpDelivery({ NODE_ENV: 'production' }) === null);
  check('production + console -> null (refused in production)', resolveOtpDelivery({ NODE_ENV: 'production', OTP_DELIVERY: 'console' }) === null);
  check('production + operator -> operator', resolveOtpDelivery({ NODE_ENV: 'production', OTP_DELIVERY: 'operator' }) === 'operator');
  check('production + sms without token -> null (fail closed)', resolveOtpDelivery({ NODE_ENV: 'production', OTP_DELIVERY: 'sms', SMS_PROVIDER: 'bulksmsbd' }) === null);
  check('placeholder SMS token is rejected', !hasValidSmsConfig({ SMS_PROVIDER: 'greenweb', SMS_API_TOKEN: 'your_greenweb_or_onnorokom_token' }));
  check('sms_or_operator without SMS token auto-resolves to ৳0 operator mode',
    resolveOtpDelivery({ NODE_ENV: 'production', OTP_DELIVERY: 'sms_or_operator', SMS_PROVIDER: 'bulksmsbd' }) === 'operator');
  check('sms_or_operator with valid SMS token resolves to sms_or_operator',
    resolveOtpDelivery({ NODE_ENV: 'production', OTP_DELIVERY: 'sms_or_operator', SMS_PROVIDER: 'bulksmsbd', SMS_API_TOKEN: 'bd_live_tok_99' }) === 'sms_or_operator');
  check('sslwireless requires SMS_SENDER_ID (SID)',
    !resolveSmsConfig({ SMS_PROVIDER: 'sslwireless', SMS_API_TOKEN: 'ssl_tok_99' }).valid
    && resolveSmsConfig({ SMS_PROVIDER: 'sslwireless', SMS_API_TOKEN: 'ssl_tok_99', SMS_SENDER_ID: 'BUILDBD' }).valid);
  check('production rejects non-HTTPS non-loopback SMS_GATEWAY_URL',
    !resolveSmsConfig({ NODE_ENV: 'production', SMS_PROVIDER: 'bulksmsbd', SMS_API_TOKEN: 'bd_tok_99', SMS_GATEWAY_URL: 'http://example.com/sms' }).valid);

  // ── 2. Live HTTP dispatch tests across Bangladeshi SMS providers ───────────
  const mockGw = await startMockSmsGateway();

  // 2a. BulkSMSBD (form-encoded 8801XXXXXXXXX + response_code 202 check)
  mockGw.setBehavior({ status: 200, body: JSON.stringify({ response_code: 202 }) });
  const bulkRes = await deliverOtp(
    'sms',
    '01712345678',
    '482910',
    new Date(Date.now() + 300000),
    TMP_LOG,
    { NODE_ENV: 'production', OTP_DELIVERY: 'sms', SMS_PROVIDER: 'bulksmsbd', SMS_API_TOKEN: 'bulk_key_123', SMS_SENDER_ID: 'BUILDBD', SMS_GATEWAY_URL: mockGw.url }
  );
  const lastBulk = mockGw.requests[mockGw.requests.length - 1];
  check('BulkSMSBD dispatches form-encoded 8801XXXXXXXXX payload and returns channel=sms',
    bulkRes.channel === 'sms'
    && bulkRes.provider === 'bulksmsbd'
    && lastBulk.body.includes('number=8801712345678')
    && lastBulk.body.includes('482910'));

  // 2b. Greenweb (form-encoded token + to + message)
  mockGw.setBehavior({ status: 200, body: JSON.stringify([{ status: 'SENT', statusmsg: 'SMS Sent' }]) });
  const gwRes = await deliverOtp(
    'sms',
    '01812345678',
    '591024',
    new Date(Date.now() + 300000),
    TMP_LOG,
    { NODE_ENV: 'production', OTP_DELIVERY: 'sms', SMS_PROVIDER: 'greenweb', SMS_API_TOKEN: 'gw_key_123', SMS_GATEWAY_URL: mockGw.url }
  );
  const lastGw = mockGw.requests[mockGw.requests.length - 1];
  check('Greenweb dispatches token + 01XXXXXXXXX payload and returns channel=sms',
    gwRes.channel === 'sms'
    && gwRes.provider === 'greenweb'
    && lastGw.body.includes('to=01812345678')
    && lastGw.body.includes('591024'));

  // 2c. SSL Wireless (JSON api_token + sid + msisdn + csms_id)
  mockGw.setBehavior({ status: 200, body: JSON.stringify({ status: 'SUCCESS', status_code: 200 }) });
  const sslRes = await deliverOtp(
    'sms',
    '01912345678',
    '739182',
    new Date(Date.now() + 300000),
    TMP_LOG,
    { NODE_ENV: 'production', OTP_DELIVERY: 'sms', SMS_PROVIDER: 'sslwireless', SMS_API_TOKEN: 'ssl_key_123', SMS_SENDER_ID: 'BUILDBDSID', SMS_GATEWAY_URL: mockGw.url }
  );
  const lastSsl = JSON.parse(mockGw.requests[mockGw.requests.length - 1].body);
  check('SSL Wireless dispatches JSON payload with sid + 88-prefixed msisdn + csms_id',
    sslRes.channel === 'sms'
    && sslRes.provider === 'sslwireless'
    && lastSsl.msisdn === '8801912345678'
    && lastSsl.sid === 'BUILDBDSID'
    && typeof lastSsl.csms_id === 'string' && lastSsl.csms_id.length === 16);

  // 2d. Strict `sms` mode fails with operational 502 when carrier rejects balance/auth
  mockGw.setBehavior({ status: 200, body: JSON.stringify({ response_code: 1007, error_message: 'Insufficient Balance' }) });
  let strictErr = null;
  try {
    await deliverOtp(
      'sms',
      '01799998888',
      '112233',
      new Date(Date.now() + 300000),
      TMP_LOG,
      { NODE_ENV: 'production', OTP_DELIVERY: 'sms', SMS_PROVIDER: 'bulksmsbd', SMS_API_TOKEN: 'bulk_key_123', SMS_GATEWAY_URL: mockGw.url }
    );
  } catch (err) {
    strictErr = err;
  }
  check('strict OTP_DELIVERY=sms throws operational 502 when carrier reports error code',
    Boolean(strictErr) && strictErr.statusCode === 502 && strictErr.isOperational === true);

  // 2e. Hybrid `sms_or_operator` gracefully falls back to ৳0 operator relay when carrier fails!
  try { fs.unlinkSync(TMP_LOG); } catch (_) {}
  const fallbackRes = await deliverOtp(
    'sms_or_operator',
    '01611223344',
    '847261',
    new Date(Date.now() + 300000),
    TMP_LOG,
    { NODE_ENV: 'production', OTP_DELIVERY: 'sms_or_operator', SMS_PROVIDER: 'bulksmsbd', SMS_API_TOKEN: 'bulk_key_123', SMS_GATEWAY_URL: mockGw.url }
  );
  const activeEntries = readActiveOperatorOtps(TMP_LOG);
  check('sms_or_operator automatically falls back to ৳0 operator relay on carrier outage',
    fallbackRes.channel === 'operator'
    && fallbackRes.fallbackUsed === true
    && activeEntries.length === 1
    && activeEntries[0].phone === '01611223344'
    && activeEntries[0].code === '847261');

  await mockGw.close();
  try { fs.unlinkSync(TMP_LOG); } catch (_) {}

  // ── 3. Cloud Infrastructure & Render Blueprint Invariants ──────────────────
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  check('Dockerfile copies ./config into production runner image (bdWorkTaxonomy.js)',
    dockerfile.includes('COPY --chown=appuser:appgroup --from=builder /app/config ./config')
    && dockerfile.includes('/app/logs')
    && dockerfile.includes('/app/.storage'));

  const renderYaml = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  check('render.yaml configures free Singapore Node web service with /health/liveness and sms_or_operator',
    renderYaml.includes('plan: free')
    && renderYaml.includes('region: singapore')
    && renderYaml.includes('healthCheckPath: /health/liveness')
    && renderYaml.includes('value: sms_or_operator')
    && renderYaml.includes('value: manual_mfs'));

  const renderLocal = resolveLocalConfig({
    RENDER_EXTERNAL_URL: 'https://build-bd-marketplace.onrender.com',
    JWT_SECRET: 'unit_test_secret_123456'
  });
  check('localStorageAdapter falls back to RENDER_EXTERNAL_URL when STORAGE_LOCAL_PUBLIC_URL is unset',
    renderLocal.publicUrl === 'https://build-bd-marketplace.onrender.com' && renderLocal.errors.length === 0);

  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  check('server.js derives CORS_ORIGIN from RENDER_EXTERNAL_URL without allowing wildcard "*"',
    serverSrc.includes('process.env.CORS_ORIGIN || process.env.RENDER_EXTERNAL_URL')
    && serverSrc.includes("resolvedCorsOrigin === '*'"));

  const adminSrc = fs.readFileSync(path.join(ROOT, 'routes', 'admin.js'), 'utf8');
  check('routes/admin.js exposes GET /otp-relay strictly locked to ADMIN role and blocks delegates',
    adminSrc.includes("router.get('/otp-relay', verifyToken, requireRole(['ADMIN'])")
    && adminSrc.includes('req.user.isDelegate'));

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
